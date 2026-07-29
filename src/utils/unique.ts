import { randomUUID } from 'node:crypto';

/**
 * Prefix on every artefact this suite creates. `scripts/cleanup.ts` uses it to
 * find and remove orphans, so it must never change without updating that script.
 */
export const QA_PREFIX = 'qa-auto';

/**
 * One id per process. Workers get distinct ids, which makes it possible to trace
 * an orphaned gist back to the run and worker that leaked it.
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