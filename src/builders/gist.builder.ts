import type { CreateGistPayload, GistFileInput } from '../models/gist.types';
import { uniqueContent, uniqueDescription } from '../utils/unique';

/**
 * Produces payloads that are valid by default, so a spec only states the one
 * thing it is actually testing. Builders never call the API — that is the
 * client's job.
 */
export class GistBuilder {
  private description: string = uniqueDescription();
  private visibility: boolean | string | number = false;
  private readonly files: Record<string, GistFileInput> = {};

  static aGist(): GistBuilder {
    return new GistBuilder();
  }

  /** Single-file secret gist — the cheapest valid payload. */
  static minimal(): CreateGistPayload {
    return GistBuilder.aGist().withFile('notes.txt', 'initial content').build();
  }

  /** Multi-file gist, used wherever a test needs to prove files are independent. */
  static multiFile(count = 3): CreateGistPayload {
    const builder = GistBuilder.aGist();
    for (let i = 0; i < count; i += 1) {
      builder.withFile(`file-${i}.txt`, uniqueContent(`content ${i}`));
    }
    return builder.build();
  }

  withDescription(description: string): this {
    this.description = description;
    return this;
  }

  /** Accepts non-booleans on purpose: type coercion on `public` is under test. */
  withPublic(value: boolean | string | number = true): this {
    this.visibility = value;
    return this;
  }

  secret(): this {
    this.visibility = false;
    return this;
  }

  withFile(filename: string, content: string = uniqueContent()): this {
    this.files[filename] = { content };
    return this;
  }

  /** Escape hatch for invalid-input cases, e.g. a file object with no `content`. */
  withRawFile(filename: string, file: GistFileInput): this {
    this.files[filename] = file;
    return this;
  }

  build(): CreateGistPayload {
    const files = Object.keys(this.files).length > 0
      ? this.files
      : { 'notes.txt': { content: uniqueContent() } };

    return {
      description: this.description,
      public: this.visibility,
      files,
    };
  }

  /** Builds without defaulting `files`, for the empty/missing-files cases. */
  buildRaw(): CreateGistPayload {
    return {
      description: this.description,
      public: this.visibility,
      files: this.files,
    };
  }
}