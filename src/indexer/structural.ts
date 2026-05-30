import { parseHTML } from 'linkedom';
import { stripTags } from '../retrieval/strip.js';
import { readAllNotes } from '../store/reader.js';

export interface StructuralHit {
  noteId: string;
  notePath: string;
  fragment: string; // HTML of the matched element
  text: string; // stripped text of the matched element
  attribute?: string; // when extracting a specific attribute
}

export interface StructuralQueryOptions {
  attribute?: string;
  limit?: number;
}

/**
 * Run a CSS selector across the entire brain.
 * L1 query: deterministic, < 5ms for ~1000 notes.
 *
 * The selector is applied per-note (each note is its own document).
 * Cross-note selectors are not supported (use href for cross-references).
 */
export function structuralQuery(
  selector: string,
  opts: StructuralQueryOptions = {},
): StructuralHit[] {
  const out: StructuralHit[] = [];
  const limit = opts.limit ?? 100;
  const notes = readAllNotes();

  for (const note of notes) {
    if (out.length >= limit) break;
    let document: ReturnType<typeof parseHTML>['document'];
    try {
      ({ document } = parseHTML(`<!doctype html><body>${note.html}</body>`));
    } catch {
      continue; // skip malformed notes silently
    }

    let matches: Element[];
    try {
      matches = Array.from(document.querySelectorAll(selector));
    } catch {
      continue;
    }

    for (const el of matches) {
      if (out.length >= limit) break;
      const fragment = el.outerHTML;
      const text = stripTags(fragment);
      const attribute = opts.attribute ? (el.getAttribute(opts.attribute) ?? '') : undefined;
      out.push({
        noteId: note.id,
        notePath: note.path,
        fragment,
        text,
        attribute,
      });
    }
  }
  return out;
}
