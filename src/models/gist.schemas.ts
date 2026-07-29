import { z } from 'zod';

/**
 * Runtime contract validation.
 *
 * Every object schema is `.passthrough()` by default: GitHub adds fields to this
 * API without notice, and failing the suite on an additive change would be noise,
 * not signal. Deliberate drift detection uses `strictGistSchema` instead, which
 * fails when a *new* field appears — run it as an informational contract check
 * rather than a merge gate (SCH-08).
 */

const isoDateTime = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: 'not a parseable ISO 8601 timestamp' })
  .refine((v) => /Z$|[+-]\d{2}:?\d{2}$/.test(v), { message: 'timestamp is not UTC/offset-qualified' });

const url = z.string().url();

export const userSchema = z
  .object({
    login: z.string().min(1),
    id: z.number().int(),
    node_id: z.string(),
    avatar_url: url,
    html_url: url,
    type: z.string(),
    site_admin: z.boolean(),
  })
  .passthrough();

export const gistFileSchema = z
  .object({
    filename: z.string().min(1),
    type: z.string(),
    language: z.string().nullable(),
    raw_url: url,
    size: z.number().int().nonnegative(),
    // Present on detail reads, absent on list reads — the difference is the point of RD-09.
    truncated: z.boolean().optional(),
    content: z.string().optional(),
    encoding: z.string().optional(),
  })
  .passthrough();

/** Fields shared by the list and detail representations. */
const gistBase = {
  id: z.string().min(1),
  node_id: z.string(),
  url: url,
  forks_url: url,
  commits_url: url,
  git_pull_url: url,
  git_push_url: url,
  html_url: url,
  comments_url: url,
  files: z.record(z.string(), gistFileSchema),
  public: z.boolean(),
  created_at: isoDateTime,
  updated_at: isoDateTime,
  description: z.string().nullable(),
  comments: z.number().int().nonnegative(),
  comments_enabled: z.boolean(),
  user: z.null().or(userSchema),
  truncated: z.boolean(),
};

/** A gist as returned by list endpoints — no `history`, no file `content`. */
export const gistListItemSchema = z
  .object({ ...gistBase, owner: userSchema.optional() })
  .passthrough();

export const gistListSchema = z.array(gistListItemSchema);

export const changeStatusSchema = z
  .object({
    total: z.number().int().nonnegative(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  })
  .passthrough();

export const gistHistoryEntrySchema = z
  .object({
    user: z.null().or(userSchema),
    version: z.string().regex(/^[0-9a-f]{40}$/, 'expected a 40-character git SHA'),
    committed_at: isoDateTime,
    change_status: changeStatusSchema,
    url: url,
  })
  .passthrough();

/**
 * A gist as returned by GET /gists/{id} — includes file `content`.
 *
 * `history` and `forks` are optional because API version 2026-03-10 **removed
 * them from the gist object**; 2022-11-28 still returns both. Revisions must now
 * be read from GET /gists/{id}/commits. The version difference is pinned by
 * SCH-10 rather than left implicit here. See docs/findings.md #12.
 */
export const gistSchema = z
  .object({
    ...gistBase,
    owner: userSchema,
    history: z.array(gistHistoryEntrySchema).optional(),
    forks: z.array(z.unknown()).optional(),
  })
  .passthrough();

/**
 * Drift detector. Any field GitHub adds to the gist object makes this fail,
 * which is the signal we want from a nightly contract run (SCH-08).
 */
export const strictGistSchema = gistSchema.strict();

export const commentSchema = z
  .object({
    id: z.number().int(),
    node_id: z.string(),
    url: url,
    body: z.string(),
    user: z.null().or(userSchema),
    created_at: isoDateTime,
    updated_at: isoDateTime,
    author_association: z.string(),
  })
  .passthrough();

export const commentListSchema = z.array(commentSchema);

export const errorSchema = z
  .object({
    message: z.string().min(1),
    documentation_url: url.optional(),
    status: z.string().optional(),
    errors: z.array(z.unknown()).optional(),
  })
  .passthrough();

export type Gist = z.infer<typeof gistSchema>;
export type GistListItem = z.infer<typeof gistListItemSchema>;
export type GistFile = z.infer<typeof gistFileSchema>;
export type GistHistoryEntry = z.infer<typeof gistHistoryEntrySchema>;
export type Comment = z.infer<typeof commentSchema>;
export type ApiError = z.infer<typeof errorSchema>;