import { structuralQuery } from '../indexer/structural.js';

export interface QueryCliOptions {
  selector: string;
  attribute?: string;
  limit?: number;
  strip?: boolean;
  pretty?: boolean;
}

export function runQuery(opts: QueryCliOptions): string {
  const hits = structuralQuery(opts.selector, {
    attribute: opts.attribute,
    limit: opts.limit ?? 50,
  });

  if (opts.strip) {
    return hits.map((h) => h.text).join('\n\n');
  }
  if (opts.pretty) {
    return hits
      .map((h) => `${h.noteId}${h.attribute ? ` [${h.attribute}]` : ''}\n  ${h.text.slice(0, 240)}`)
      .join('\n\n');
  }
  return JSON.stringify({ count: hits.length, hits }, null, 2);
}
