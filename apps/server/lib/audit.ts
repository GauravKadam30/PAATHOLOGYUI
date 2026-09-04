/**
 * lib/audit.ts — one call site for writing the audit trail.
 * ---------------------------------------------------------------------------
 * Kept apart from the routes so the rule about WHAT gets logged lives in one
 * place rather than being re-decided at each endpoint.
 */
import type { Request } from 'express';
import * as db from '../db.ts';

/**
 * Record one action against the audit log.
 *
 * WHAT IS AND IS NOT LOGGED. Every write is recorded, plus OPENING a specific
 * case. The worklist poll is NOT: it runs every four seconds per signed-in
 * user, which would add roughly 900 rows an hour of pure noise and bury the
 * entries that matter. "Who opened this patient's record" is answerable from
 * case.view; "who listed the queue" is not worth the volume.
 *
 * Fire-and-forget by design — writeAudit swallows its own failures, so a
 * clinical save never fails because the log was unavailable.
 */
export function audit(req: Request, action: string, caseId?: number | string | null, detail?: string): void {
  void db.writeAudit({
    userId: req.user?.id ?? null,
    userName: req.user?.full_name ?? null,
    userRole: req.user?.role ?? null,
    action,
    caseId: caseId == null ? null : Number(caseId),
    detail: detail ?? null,
    // Behind a reverse proxy this is the proxy unless `trust proxy` is set.
    // Recorded as Express reports it rather than trusting a client header.
    ip: req.ip ?? null,
  });
}
