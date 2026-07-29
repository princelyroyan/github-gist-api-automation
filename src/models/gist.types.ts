/**
 * Request payload types. Response types are inferred from the Zod schemas in
 * gist.schemas.ts so there is a single source of truth for the response contract.
 */

export type GistFileInput = {
  content?: string;
  filename?: string;
};

export type CreateGistPayload = {
  description?: string;
  /** Documented as "boolean or string" — the loose typing is itself under test (CRE-08/09). */
  public?: boolean | string | number;
  files: Record<string, GistFileInput>;
};

/**
 * PATCH is a merge, not a replace:
 *   { content }            -> update content
 *   { filename }           -> rename
 *   { content, filename }  -> rename and update
 *   {}                     -> delete the file
 *   null                   -> delete the file
 * Files absent from the payload are left untouched.
 */
export type UpdateGistPayload = {
  description?: string;
  files?: Record<string, GistFileInput | null>;
};

export type ListParams = {
  per_page?: number;
  page?: number;
  since?: string;
};

export type CreateCommentPayload = { body: string };
export type UpdateCommentPayload = { body: string };