import type { APIRequestContext, APIResponse } from '@playwright/test';
import { BaseClient } from './base.client';
import type { CreateGistPayload, ListParams, UpdateGistPayload } from '../models/gist.types';

/**
 * One method per endpoint of the Gists API. No assertions, no test data, no
 * knowledge of which persona is calling — that lives in the fixtures.
 */
export class GistsClient extends BaseClient {
  constructor(request: APIRequestContext) {
    super(request);
  }

  // --- Core CRUD -----------------------------------------------------------

  create(payload: CreateGistPayload | unknown): Promise<APIResponse> {
    return this.send('post', '/gists', { data: payload });
  }

  /** For malformed-body cases (CRE-15) where `data` would be serialised for us. */
  createRaw(body: string, contentType = 'application/json'): Promise<APIResponse> {
    return this.send('post', '/gists', {
      headers: { 'Content-Type': contentType },
      data: body,
    });
  }

  getById(gistId: string): Promise<APIResponse> {
    return this.send('get', `/gists/${gistId}`);
  }

  getByIdWithEtag(gistId: string, etag: string): Promise<APIResponse> {
    return this.send('get', `/gists/${gistId}`, { headers: { 'If-None-Match': etag } });
  }

  update(gistId: string, payload: UpdateGistPayload | unknown): Promise<APIResponse> {
    return this.send('patch', `/gists/${gistId}`, { data: payload });
  }

  delete(gistId: string): Promise<APIResponse> {
    return this.send('delete', `/gists/${gistId}`);
  }

  // --- Lists ---------------------------------------------------------------

  /** Authenticated: the caller's gists (incl. secret). Anonymous: all public gists. */
  list(params?: ListParams): Promise<APIResponse> {
    return this.send('get', '/gists', { params: params as Record<string, string | number> });
  }

  listPublic(params?: ListParams): Promise<APIResponse> {
    return this.send('get', '/gists/public', { params: params as Record<string, string | number> });
  }

  listStarred(params?: ListParams): Promise<APIResponse> {
    return this.send('get', '/gists/starred', { params: params as Record<string, string | number> });
  }

  /** Public gists only — even when the caller owns the account. */
  listForUser(username: string, params?: ListParams): Promise<APIResponse> {
    return this.send('get', `/users/${username}/gists`, {
      params: params as Record<string, string | number>,
    });
  }

  // --- Star ----------------------------------------------------------------

  /** 204 = starred, 404 = not starred. The 404 is overloaded; see docs/findings.md. */
  isStarred(gistId: string): Promise<APIResponse> {
    return this.send('get', `/gists/${gistId}/star`);
  }

  star(gistId: string): Promise<APIResponse> {
    return this.send('put', `/gists/${gistId}/star`, { headers: { 'Content-Length': '0' } });
  }

  unstar(gistId: string): Promise<APIResponse> {
    return this.send('delete', `/gists/${gistId}/star`);
  }

  // --- Forks, revisions ----------------------------------------------------

  fork(gistId: string): Promise<APIResponse> {
    return this.send('post', `/gists/${gistId}/forks`);
  }

  listForks(gistId: string, params?: ListParams): Promise<APIResponse> {
    return this.send('get', `/gists/${gistId}/forks`, {
      params: params as Record<string, string | number>,
    });
  }

  listCommits(gistId: string, params?: ListParams): Promise<APIResponse> {
    return this.send('get', `/gists/${gistId}/commits`, {
      params: params as Record<string, string | number>,
    });
  }

  getRevision(gistId: string, sha: string): Promise<APIResponse> {
    return this.send('get', `/gists/${gistId}/${sha}`);
  }
}