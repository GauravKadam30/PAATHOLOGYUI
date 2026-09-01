/**
 * queries.ts — all server state, as TanStack Query hooks.
 * ---------------------------------------------------------------------------
 * Everything the dashboard reads from or writes to the backend goes through
 * here. Previously each of these was hand-rolled inside the component: a
 * useEffect to fetch, a setInterval to poll, useState to hold the result, and
 * manual merging on every update. That worked, but the caching, de-duplication
 * and refetch-on-focus logic had to be maintained by hand.
 *
 * TWO THINGS WORTH KNOWING ABOUT THIS FILE
 *
 * 1. Reads are bulk, writes are per-case. `useNotes` fetches every note in one
 *    request, but `useSaveNote` writes exactly one. That asymmetry is
 *    deliberate — an earlier design wrote all notes back as a single blob, so
 *    two people saving different patients at the same moment silently
 *    destroyed one of the two saves.
 *
 * 2. The case list polls INCREMENTALLY. Rather than re-fetching every case
 *    every four seconds, it sends the newest `updatedAt` it has already seen
 *    and the server returns only what changed since. An idle worklist
 *    therefore transfers an empty array. `useCases` keeps that behaviour by
 *    merging each delta into the cached list itself.
 */
import {
  useQuery, useMutation, useQueryClient,
  type UseQueryResult, type QueryClient,
} from '@tanstack/react-query';
import {
  getCases, getAllNotes, getAllAnnotations, apiGet,
  saveNote, saveAnnotations, setCaseArchived, getCaseImage, signCaseReport,
} from './api';
import type {
  Case, NotesByCase, AnnotationsByCase, AnnotationData, NoteKind,
} from './types';

/** Query keys in one place, so cache invalidation can't go out of step. */
export const keys = {
  cases: ['cases'] as const,
  notes: ['notes'] as const,
  annotations: ['annotations'] as const,
  legacyImages: ['legacy-annotated-images'] as const,
};

/** How often the worklist checks for new patients. */
const POLL_MS = 4000;

/**
 * Newest `updatedAt` already seen by the worklist query.
 *
 * This lives at module scope rather than in a component ref because there is
 * exactly ONE cache entry for `['cases']` shared by every caller. A ref per
 * component would mean several watermarks feeding one cache, so whichever
 * instance happened to refetch would ask from its own position and could skip
 * changes another had already advanced past. Route loaders make that concrete:
 * the loader and the component must agree on where the list is up to.
 *
 * It is reset on sign-out, since the next account starts from nothing.
 */
let casesSince: string | null = null;

/** Forget the incremental-poll position. Call when clearing the query cache. */
export function resetCasesWatermark(): void {
  casesSince = null;
}

/**
 * Fold a batch of changed cases into the list already held.
 *
 * Existing entries are updated in place rather than replaced, so a
 * lazily-fetched `image` (which the list endpoint doesn't return) survives.
 * Newly-archived cases drop out; genuinely new ones are appended.
 */
function mergeCases(prev: Case[], changed: Case[]): Case[] {
  const changedById = new Map(changed.map((c) => [c.id, c]));

  const merged = prev
    .map((old) => {
      const fresh = changedById.get(old.id);
      if (!fresh) return old;
      // Keep `image` — the delta never carries it, and dropping it would
      // force a re-download of a slide the user already has open.
      return { ...old, ...fresh, image: old.image ?? fresh.image };
    })
    .filter((c) => !c.archived);

  const known = new Set(prev.map((c) => c.id));
  const additions = changed.filter((c) => !known.has(c.id) && !c.archived);

  return additions.length ? [...merged, ...additions] : merged;
}

/**
 * The patient worklist, kept live.
 *
 * The `since` watermark lives in a ref rather than component state on purpose:
 * changing it must not trigger a re-render, and it has to survive between
 * polls without becoming a dependency of anything.
 */
export function casesQueryOptions(qc: QueryClient) {
  return {
    queryKey: keys.cases,
    queryFn: async (): Promise<Case[]> => {
      const isFirstLoad = casesSince === null;

      const batch = await getCases(isFirstLoad ? undefined : casesSince);

      // Advance the watermark past the newest change in this batch.
      for (const c of batch) {
        if (c.updatedAt && (!casesSince || c.updatedAt > casesSince)) {
          casesSince = c.updatedAt;
        }
      }

      if (isFirstLoad) return batch.filter((c) => !c.archived);

      // Read the cache HERE, after the request, not before it. Anything that
      // wrote to the list while this poll was in flight — most importantly a
      // case photo arriving from loadCaseImage — would otherwise be merged
      // over with a snapshot taken before it landed, and silently lost. That
      // is a real race: opening a case starts both requests at once, and the
      // photo would vanish whenever it finished first.
      const previous = qc.getQueryData<Case[]>(keys.cases) ?? [];

      // Returning the SAME array reference when nothing changed means React
      // skips re-rendering the worklist entirely on an idle poll.
      if (!batch.length) return previous;
      return mergeCases(previous, batch);
    },
    refetchInterval: POLL_MS,
    // The list is the app's live view of shared work — always refetch on
    // mount rather than serving a stale cache.
    staleTime: 0,
  };
}

export const notesQueryOptions = { queryKey: keys.notes, queryFn: getAllNotes };

export const annotationsQueryOptions = { queryKey: keys.annotations, queryFn: getAllAnnotations };

export function useCases(): UseQueryResult<Case[], Error> {
  return useQuery(casesQueryOptions(useQueryClient()));
}

/** Every case's notes, in one request. */
export function useNotes(): UseQueryResult<NotesByCase, Error> {
  return useQuery(notesQueryOptions);
}

/** Every case's vector annotations, in one request. */
export function useAnnotations(): UseQueryResult<AnnotationsByCase, Error> {
  return useQuery(annotationsQueryOptions);
}

/**
 * Annotations saved under the OLD flattened-image scheme.
 *
 * Read-only and never written to; kept so work saved before the vector
 * rewrite still displays instead of silently disappearing. Failing to load it
 * is not an error worth surfacing, hence the empty-object fallback.
 */
export const legacyImagesQueryOptions = {
  queryKey: keys.legacyImages,
  queryFn: () => apiGet<Record<string, string>>('pv_annotatedImages').catch(() => ({})),
  staleTime: Infinity,   // historical data; it never changes
};

export function useLegacyAnnotatedImages(): UseQueryResult<Record<string, string>, Error> {
  return useQuery(legacyImagesQueryOptions);
}

/**
 * Save one note on one case.
 *
 * Updates the cache immediately so the textarea doesn't flicker back to its
 * previous value while the request is in flight, then reconciles with the
 * server on settle.
 */
export function useSaveNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ caseId, kind, body }: { caseId: number; kind: NoteKind; body: string }) =>
      saveNote(caseId, kind, body),
    onSuccess: (_data, { caseId, kind, body }) => {
      qc.setQueryData<NotesByCase>(keys.notes, (prev) => ({
        ...(prev ?? {}),
        [caseId]: { ...(prev?.[String(caseId)] ?? {}), [kind]: body },
      }));
    },
  });
}

/** Save the vector annotations for one case. */
export function useSaveAnnotations() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ caseId, data }: { caseId: number; data: AnnotationData | null }) =>
      saveAnnotations(caseId, data),
    onSuccess: (_res, { caseId, data }) => {
      qc.setQueryData<AnnotationsByCase>(keys.annotations, (prev) => ({
        ...(prev ?? {}),
        [caseId]: data ?? {},
      }));
    },
  });
}

/**
 * Sign off a report.
 *
 * The server returns the updated case, so it is written straight into the
 * cached list. That makes the row move from Pending to Reported immediately
 * rather than on the next four-second poll — pressing the most consequential
 * button in the app should not appear to do nothing for a few seconds.
 */
export function useSignReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ caseId }: { caseId: number }) => signCaseReport(caseId),
    onSuccess: (updated) => {
      qc.setQueryData<Case[]>(keys.cases, (prev) =>
        (prev ?? []).map((c) => (c.id === updated.id ? { ...c, ...updated } : c)),
      );
    },
  });
}

/**
 * Archive (soft-delete) a case.
 *
 * Removes it from the cached list straight away so the row disappears the
 * moment the action is confirmed, rather than on the next poll.
 */
export function useArchiveCase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ caseId, archived = true }: { caseId: number; archived?: boolean }) =>
      setCaseArchived(caseId, archived),
    onSuccess: (_res, { caseId, archived = true }) => {
      if (!archived) {
        // Restoring can't be done from the cache alone — the case isn't in it.
        void qc.invalidateQueries({ queryKey: keys.cases });
        return;
      }
      qc.setQueryData<Case[]>(keys.cases, (prev) => (prev ?? []).filter((c) => c.id !== caseId));
    },
  });
}

/**
 * Fetch a case's inline photo on demand and fold it into the cached list.
 *
 * Photos are deliberately excluded from the worklist response (they would make
 * it enormous), so this runs when a case is actually opened. Whole-slide cases
 * have no inline image at all — they stream tiles instead — so they skip it.
 */
export async function loadCaseImage(qc: QueryClient, caseId: number): Promise<void> {
  const cases = qc.getQueryData<Case[]>(keys.cases) ?? [];
  const target = cases.find((c) => c.id === caseId);
  if (!target || !target.hasImage || target.image || target.dziUrl) return;

  try {
    const image = await getCaseImage(caseId);
    if (!image) return;
    qc.setQueryData<Case[]>(keys.cases, (prev) =>
      (prev ?? []).map((c) => (c.id === caseId ? { ...c, image } : c)),
    );
  } catch {
    /* the viewer shows its own "couldn't load" state */
  }
}
