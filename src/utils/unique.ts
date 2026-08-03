import { randomUUID } from 'node:crypto';

/**
 * Prefix on every artefact this suite creates. `scripts/cleanup.ts` uses it to
 * find and remove orphans, so it must never change without updating that script.
 */
export const QA_PREFIX = 'qa-auto';

/**
 * One id per process. Workers get distinct ids, which makes it possible to trace
 * an orphaned gist back to the run and worker that leaked it.
 *
 * The date is the **UTC** date, deliberately: it has to match what `created_at`
 * says when someone greps a leaked gist, and CI and a local machine must produce
 * comparable names. The cost is that a run started late at night west of UTC — or
 * early morning east of it — is stamped with the neighbouring day. That is the
 * right trade, but it surprises people, hence this note.
 */
export const runId = `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;

/** e.g. `qa-auto-2026-07-28-1a2b3c4d-9f8e7d6c` */
export function uniqueDescription(label = ''): string {
  const suffix = randomUUID().slice(0, 8);
  return [QA_PREFIX, runId, label, suffix].filter(Boolean).join('-');
}

export function uniqueFilename(extension = 'txt'): string {
  return `${QA_PREFIX}-${randomUUID().slice(0, 8)}.${extension}`;
}

export function uniqueContent(label = 'content'): string {
  return `${label} ${randomUUID()}`;
}