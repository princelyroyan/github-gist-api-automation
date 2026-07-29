import type { APIRequestContext, APIResponse } from '@playwright/test';
import { BaseClient } from './base.client';
import type {
  CreateCommentPayload,
  ListParams,
  UpdateCommentPayload,
} from '../models/gist.types';

/** Gist comments live on a separate docs page and behave as an independent resource. */
export class CommentsClient extends BaseClient {
  constructor(request: APIRequestContext) {
    super(request);
  }

  create(gistId: string, payload: CreateCommentPayload | unknown): Promise<APIResponse> {
    return this.send('post', `/gists/${gistId}/comments`, { data: payload });
  }

  list(gistId: string, params?: ListParams): Promise<APIResponse> {
    return this.send('get', `/gists/${gistId}/comments`, {
      params: params as Record<string, string | number>,
    });
  }

  getById(gistId: string, commentId: number | string): Promise<APIResponse> {
    return this.send('get', `/gists/${gistId}/comments/${commentId}`);
  }

  update(
    gistId: string,
    commentId: number | string,
    payload: UpdateCommentPayload | unknown,
  ): Promise<APIResponse> {
    return this.send('patch', `/gists/${gistId}/comments/${commentId}`, { data: payload });
  }

  delete(gistId: string, commentId: number | string): Promise<APIResponse> {
    return this.send('delete', `/gists/${gistId}/comments/${commentId}`);
  }
}