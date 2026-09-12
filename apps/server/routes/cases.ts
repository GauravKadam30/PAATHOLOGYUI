/**
 * routes/cases.ts — patients, their notes, annotations and sign-off.
 * ---------------------------------------------------------------------------
 * Mounted at /api. This is the clinical core: everything a case IS, apart from
 * its slide file, which lives in routes/slides.ts.
 *
 * Every route below requires a signed-in account. These were once open, which
 * meant `curl http://host/api/cases` returned the full patient list — names,
 * CHC ids, notes, annotations and images — to anyone who could reach the
 * server. Reading a patient record is as sensitive as writing one.
 */
import { Router } from 'express';
import * as db from '../db.ts';
import { NOTE_WRITERS, type Role } from '../types.ts';
import { authRequired } from '../auth.ts';
import { audit } from '../lib/audit.ts';
import { caseDiskUsage, discardUpload } from '../lib/chunked-upload.ts';

export const caseRoutes = Router();

// ===== Key/value store ======================================================
// Only still used for the legacy annotated-image fallback. Notes and
// annotations moved to their own per-case routes below, because writing them
// as one blob per key meant simultaneous saves overwrote each other.
caseRoutes.get('/store/:key', authRequired, async (req, res) => res.json(await db.getKV(String(req.params.key))));
caseRoutes.put('/store/:key', authRequired, async (req, res) => { await db.setKV(String(req.params.key), req.body); res.json({ ok: true }); });

// ===== Notes & annotations (per case) =======================================
// Reads stay bulk (cheap, and the dashboard wants everything at once); it is
// only the WRITES that had to become per-row to be safe under concurrency.
caseRoutes.get('/notes', authRequired, async (_req, res) => res.json(await db.getAllNotes()));
caseRoutes.get('/annotations', authRequired, async (_req, res) => res.json(await db.getAllAnnotations()));

// Save ONE note on ONE case. Touches a single row, so a colleague saving a
// different case at the same moment can't clobber it.
caseRoutes.put('/cases/:id/notes/:kind', authRequired, async (req, res) => {
  const id = String(req.params.id);
  const kind = String(req.params.kind);
  if (!db.NOTE_KINDS.includes(kind))
    return res.status(400).json({ error: `Unknown note type "${kind}".` });

  // A pathologist writes the microscopic findings; a physician writes the
  // prescription. Splitting them is the point of having both roles, so it is
  // enforced HERE and not only by disabling a textarea — the UI is a courtesy,
  // this is the actual rule.
  const allowed = NOTE_WRITERS[kind] ?? [];
  if (!allowed.includes(req.user!.role as Role)) {
    return res.status(403).json({
      error: `A ${req.user!.role.replace('_', ' ')} account cannot write the ${kind} note.`,
    });
  }

  if (!await db.getCaseMeta(id)) return res.status(404).json({ error: 'Case not found.' });
  const body = typeof req.body?.body === 'string' ? req.body.body : '';
  await db.setNote(id, kind, body, req.user!.id);
  audit(req, 'note.save', id, kind);
  res.json({ ok: true });
});

caseRoutes.put('/cases/:id/annotations', authRequired, async (req, res) => {
  const id = String(req.params.id);
  // Marking up the slide is the pathologist's examination. A physician reads
  // those marks to prescribe, but does not add their own.
  if (req.user!.role !== 'pathologist')
    return res.status(403).json({ error: 'Only a pathologist can annotate a slide.' });
  if (!await db.getCaseMeta(id)) return res.status(404).json({ error: 'Case not found.' });
  await db.setAnnotations(id, req.body ?? {}, req.user!.id);
  audit(req, 'annotation.save', id);
  res.json({ ok: true });
});

// List (metadata only — no images — so the queue loads fast).
// `?since=<iso>` returns only cases changed since then, so the worklist can
// poll for changes rather than re-downloading everything every few seconds.
// `?includeArchived=1` brings back soft-deleted cases.
caseRoutes.get('/cases', authRequired, async (req, res) => res.json(await db.listCases({
  since: typeof req.query.since === 'string' ? req.query.since : null,
  includeArchived: req.query.includeArchived === '1',
})));

// One full case, including its slide image (fetched when a slide is opened).
caseRoutes.get('/cases/:id', authRequired, async (req, res) => {
  const c = await db.getCase(String(req.params.id));
  if (!c) return res.status(404).json({ error: 'not found' });
  // Fetching ONE case is a person opening a patient's record — the read worth
  // recording. The worklist poll is not audited; see the note on `audit`.
  audit(req, 'case.view', c.id);
  res.json(c);
});

/**
 * The history of one case: who viewed, edited and signed it.
 *
 * Read-only, and there is no endpoint that edits or deletes audit rows — the
 * trail is append-only by design.
 */
caseRoutes.get('/cases/:id/audit', authRequired, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad case id.' });
  res.json(await db.readAudit({ caseId: id, limit: Number(req.query.limit) || 100 }));
});

// Submit a new case — SIGN-IN REQUIRED, and only a lab attendant account may
// do it (a pathologist has no CHC to stamp the case with). The attendant name
// and CHC are taken from the logged-in account (not trusted from the
// request), so every case is reliably stamped with who submitted it and from where.
caseRoutes.post('/cases', authRequired, async (req, res) => {
  if (req.user!.role !== 'lab_attendant')
    return res.status(403).json({ error: 'Only a CHC lab attendant account can submit a case.' });
  const body = req.body || {};
  if (!body.patient || !String(body.patient).trim())
    return res.status(400).json({ error: 'Patient name is required.' });

  // The CHC Patient ID is meant to identify exactly one patient, and the
  // worklist's search relies on that. A repeat almost always means a typo or a
  // duplicate submission, so it's rejected here with the clashing patient
  // named — far easier to fix now than after two records have diverged.
  if (body.chcId && String(body.chcId).trim()) {
    const clash = await db.findCaseByChcId(body.chcId, req.user!.chc_name);
    if (clash) {
      return res.status(409).json({
        error: `CHC Patient ID "${String(body.chcId).trim()}" is already used by "${clash.patient}" (case ${clash.id}). Please check the ID.`,
      });
    }
  }

  const id = await db.createCase(body, req.user!);
  res.json(await db.getCaseMeta(id));
});

// Archive / restore a case (soft delete). The record and any slide file stay
// on disk — clinical data is rarely safe to destroy — the case simply stops
// appearing in the worklist, and can be brought back.
// Sign off the report. This is the end of the clinical workflow: the physician
// has read the pathologist's findings, recorded a prescription, and is now
// putting their name to it. The case leaves the pending worklist.
//
// Restricted to physicians for the same reason the note kinds are split — the
// person who prescribes is the person who signs.
caseRoutes.post('/cases/:id/sign', authRequired, async (req, res) => {
  if (req.user!.role !== 'physician')
    return res.status(403).json({ error: 'Only a physician can sign and submit a report.' });

  const id = String(req.params.id);
  const existing = await db.getCaseMeta(id);
  if (!existing) return res.status(404).json({ error: 'Case not found.' });
  if (existing.reportedAt)
    return res.status(409).json({ error: 'This report has already been signed.' });

  audit(req, 'report.sign', id);
  res.json(await db.signCaseReport(id, req.user!.id));
});

/**
 * Withdraw a signature — for a physician who signed too early, or signed the
 * wrong patient's report.
 *
 * Only the physician who signed may withdraw it. That is checked by ACCOUNT,
 * not by name: two physicians can share a name, and matching on it would let
 * one quietly undo the other's sign-off. Signatures made before the account id
 * was recorded fall back to the name, since that is all there is.
 *
 * Both the original signing and this withdrawal stay in the audit trail, so a
 * report that was signed and then un-signed still shows that it happened. Note
 * that a withdrawn report is Pending again, which also makes it deletable — the
 * delete guard only protects reports that are currently signed.
 */
caseRoutes.delete('/cases/:id/sign', authRequired, async (req, res) => {
  if (req.user!.role !== 'physician')
    return res.status(403).json({ error: 'Only a physician can withdraw a signature.' });

  const id = String(req.params.id);
  const existing = await db.getCaseMeta(id);
  if (!existing) return res.status(404).json({ error: 'Case not found.' });
  if (!existing.reportedAt)
    return res.status(409).json({ error: 'This report has not been signed.' });

  const isSigner = existing.reportedById != null
    ? existing.reportedById === req.user!.id
    : existing.reportedBy === req.user!.full_name;
  // Deliberately does not name the signer. This refusal matters most when two
  // physicians share a name, and naming the signer then tells the refused
  // physician that only someone with THEIR OWN name may do it.
  if (!isSigner) {
    return res.status(403).json({
      error: 'Only the physician who signed this report can withdraw it.',
    });
  }

  audit(req, 'report.unsign', id, `withdrew signature made at ${existing.reportedAt}`);
  res.json(await db.withdrawCaseSignature(id));
});

/**
 * Permanently delete a case — the database row, its notes and annotations, and
 * the slide files on disk.
 *
 * Distinct from archiving, which only hides a case from the worklist. This one
 * cannot be undone, so it is fenced in three ways:
 *
 *   - a SIGNED case is refused. Once a physician has put their name to a
 *     report it is a completed clinical record, not something to tidy away;
 *     archiving remains available for those
 *   - physicians cannot delete. They are the ones who sign reports, and the
 *     account that completes a record should not also be able to erase it
 *   - the deletion itself is audited, with what it cost in notes, annotations
 *     and disk, so the act leaves a trace even though the case does not
 *
 * Disk is cleared BEFORE the row. Should the database call then fail, the case
 * survives with a missing slide — visible, and fixable by deleting again. The
 * other order would leave gigabytes on disk with no record pointing at them.
 */
caseRoutes.delete('/cases/:id', authRequired, async (req, res) => {
  const id = String(req.params.id);
  const existing = await db.getCaseMeta(id);
  if (!existing) return res.status(404).json({ error: 'Case not found.' });

  if (req.user!.role === 'physician') {
    return res.status(403).json({ error: 'A physician account cannot delete patient records.' });
  }
  if (existing.reportedAt) {
    return res.status(409).json({
      error: 'This case has been signed off and cannot be deleted. Archive it instead to take it off the worklist.',
    });
  }

  const freed = await caseDiskUsage(id);
  await discardUpload(id);
  const removed = await db.deleteCase(id);
  if (!removed) return res.status(404).json({ error: 'Case not found.' });

  const detail = `${removed.notes} note(s), ${removed.annotations} annotation(s), `
    + `${(freed / 1e6).toFixed(1)} MB of slide data`;
  audit(req, 'case.delete', id, detail);
  console.log(`[case] ${id} permanently deleted — ${detail}`);

  res.json({ ok: true, deleted: id, freedBytes: freed, ...removed });
});

caseRoutes.patch('/cases/:id/archived', authRequired, async (req, res) => {
  const existing = await db.getCaseMeta(String(req.params.id));
  if (!existing) return res.status(404).json({ error: 'Case not found.' });
  const archived = req.body?.archived !== false;
  audit(req, archived ? 'case.archive' : 'case.restore', String(req.params.id));
  res.json(await db.setCaseArchived(String(req.params.id), archived));
});

