import { parseHTML } from 'linkedom';
import { stripTags } from '../retrieval/strip.js';

export interface Entity {
  id: string; // matches a note id
  surface: string; // exact text mention
  start: number; // character offset in note text
  end: number;
}

/**
 * Extract mentions of known entities (= existing note IDs / titles)
 * in a piece of text. Pure heuristic, no NLP library required.
 *
 * - Matches exact note IDs (slug form: lowercase-kebab) in the text.
 * - Matches Title Case phrases against a normalized index of titles.
 * - Skips tiny matches (< 4 chars) and stop-words.
 * - Skips common technical terms that create noise when auto-linked.
 */
const STOP_WORDS = new Set([
  'the',
  'and',
  'with',
  'from',
  'into',
  'about',
  'note',
  'this',
  'that',
  'when',
  'what',
  'where',
  'which',
  'their',
  'there',
  'these',
  'those',
  'pour',
  'avec',
  'dans',
  'sans',
  'sous',
  'cette',
  'cela',
  'mais',
  // Common technical terms that are too generic for auto-linking
  'status',
  'categories',
  'data',
  'config',
  'type',
  'source',
  'project',
  'session',
  'working',
  'active',
  'error',
  'output',
  'input',
  'value',
  'state',
  'action',
  'event',
  'result',
  'field',
  'object',
  'string',
  'number',
  'array',
  'props',
  'params',
  'args',
]);

export interface EntityIndex {
  byId: Map<string, { id: string; title: string; aliases: string[] }>;
  bySurface: Map<string, string>; // surface (lowercased) → id
}

export function buildEntityIndex(
  notes: Array<{ id: string; title: string; tags: string }>,
): EntityIndex {
  const byId = new Map<string, { id: string; title: string; aliases: string[] }>();
  const bySurface = new Map<string, string>();

  for (const n of notes) {
    const aliases: string[] = [];
    // Title is a strong alias
    if (n.title && n.title.length >= 4) aliases.push(n.title);
    // Tags as soft aliases
    for (const t of (n.tags ?? '').split(/\s+/).filter(Boolean)) {
      if (t.length >= 4 && !STOP_WORDS.has(t.toLowerCase())) aliases.push(t);
    }
    // Slug expanded back to words
    const slugWords = n.id.replace(/-/g, ' ');
    if (slugWords.length >= 6) aliases.push(slugWords);

    byId.set(n.id, { id: n.id, title: n.title, aliases });
    for (const alias of aliases) {
      const key = alias.toLowerCase().trim();
      if (!bySurface.has(key)) bySurface.set(key, n.id);
    }
  }

  return { byId, bySurface };
}

export function detectMentions(text: string, index: EntityIndex, selfId?: string): Entity[] {
  const out: Entity[] = [];
  // Sort surfaces by length descending so longer aliases match first
  const surfaces = [...index.bySurface.keys()].sort((a, b) => b.length - a.length);
  const claimed: Array<[number, number]> = [];

  for (const surface of surfaces) {
    // Minimum surface length increased to 4 chars to avoid single-word noise
    if (surface.length < 4) continue;

    // Skip if surface is a pure stop word (case-insensitive)
    if (STOP_WORDS.has(surface.toLowerCase())) continue;

    const id = index.bySurface.get(surface);
    if (!id || id === selfId) continue;

    const lowerText = text.toLowerCase();
    let from = 0;
    while (from < lowerText.length) {
      const found = lowerText.indexOf(surface, from);
      if (found === -1) break;
      const end = found + surface.length;
      // Word boundary check
      const before = found === 0 ? ' ' : text[found - 1];
      const after = end >= text.length ? ' ' : text[end];
      const isBoundary = /[^a-zA-Z0-9_-]/.test(before) && /[^a-zA-Z0-9_-]/.test(after);
      const overlap = claimed.some(([s, e]) => !(end <= s || found >= e));
      if (isBoundary && !overlap) {
        out.push({ id, surface: text.slice(found, end), start: found, end });
        claimed.push([found, end]);
      }
      from = end;
    }
  }
  // Sort by position so callers can splice in order
  out.sort((a, b) => a.start - b.start);
  return out;
}

export type EdgeConfidence = 'extracted' | 'inferred';

export interface EdgeTypeResult {
  type: string;
  confidence: EdgeConfidence;
}

const EDGE_TYPE_PATTERNS: Array<{
  pattern: RegExp;
  type: string;
  confidence: EdgeConfidence;
}> = [
  // Dependency relationships
  { pattern: /(?:depends?\s+on|requires?|needs?|uses?)\s+/i, type: 'depends-on', confidence: 'inferred' },
  { pattern: /(?:import(?:s|ed)?|from)\s+/i, type: 'imports', confidence: 'extracted' },

  // Replacement/evolution
  { pattern: /(?:replac(?:e[ds]?|ing)|migrat(?:e[ds]?|ing)\s+(?:from|to))\s+/i, type: 'replaces', confidence: 'inferred' },
  { pattern: /(?:upgrad(?:e[ds]?|ing)|updat(?:e[ds]?|ing))\s+/i, type: 'refines', confidence: 'inferred' },

  // Issues
  { pattern: /(?:fix(?:e[ds]?|ing)?|bug\s+in|issue\s+(?:with|in)|broke[n]?|crash(?:e[ds]?|ing)?)\s+/i, type: 'fixes', confidence: 'inferred' },
  { pattern: /(?:conflict|contradict|inconsisten)/i, type: 'contradicts', confidence: 'inferred' },

  // Testing
  { pattern: /(?:test(?:s|ed|ing)?|spec\s+for|coverage)\s+/i, type: 'tested-by', confidence: 'inferred' },

  // Configuration
  { pattern: /(?:config(?:ur)?(?:e[ds]?|ing)?|set(?:ting|up))\s+/i, type: 'configures', confidence: 'inferred' },

  // Documentation
  { pattern: /(?:document(?:s|ed|ing)?|describes?|explains?)\s+/i, type: 'documents', confidence: 'inferred' },
];

/**
 * Analyze the surrounding text around a mention to determine the most
 * appropriate edge type and confidence level.
 *
 * Extracts ±100 chars around the mention position, tests each pattern in
 * order, and returns the first match. Falls back to 'mentions'/'inferred'.
 */
export function detectEdgeType(text: string, start: number, end: number): EdgeTypeResult {
  const contextStart = Math.max(0, start - 100);
  const contextEnd = Math.min(text.length, end + 100);
  const context = text.slice(contextStart, contextEnd);

  for (const { pattern, type, confidence } of EDGE_TYPE_PATTERNS) {
    if (pattern.test(context)) {
      return { type, confidence };
    }
  }

  return { type: 'mentions', confidence: 'inferred' };
}

/**
 * Apply mentions to an HTML note: wrap each mention in an <a> tag with
 * context-aware data-cerveau-link-type and data-cerveau-link-confidence
 * pointing to the entity's note.
 * Returns updated HTML, count of links added.
 *
 * Limits to max 10 links per note to prevent graph noise.
 */
export function applyAutoLinks(
  html: string,
  noteId: string,
  index: EntityIndex,
): { html: string; linksAdded: number } {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const root = (document.body || document.documentElement) as Element | null;
  if (!root) return { html, linksAdded: 0 };

  // Operate on text nodes only — never re-link inside existing anchors or scripts.
  const skipTags = new Set(['a', 'script', 'style', 'code', 'pre']);
  let linksAdded = 0;
  const MAX_AUTO_LINKS = 10; // Limit to prevent graph noise

  const walker = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (!child) continue;
      if (linksAdded >= MAX_AUTO_LINKS) break;
      if (child.nodeType === 3) {
        // text
        const original = child.textContent ?? '';
        if (!original || original.length < 6) continue;
        const mentions = detectMentions(original, index, noteId);
        if (mentions.length === 0) continue;
        // Build replacement fragment
        const frag = document.createDocumentFragment();
        let cursor = 0;
        for (const m of mentions) {
          if (linksAdded >= MAX_AUTO_LINKS) break;
          if (m.start > cursor) {
            frag.appendChild(document.createTextNode(original.slice(cursor, m.start)));
          }
          const { type: edgeType, confidence } = detectEdgeType(original, m.start, m.end);
          const a = document.createElement('a');
          a.setAttribute('href', `#${m.id}`);
          a.setAttribute('data-cerveau-link-type', edgeType);
          a.setAttribute('data-cerveau-link-confidence', confidence);
          a.setAttribute('data-cerveau-link-auto', '1');
          a.textContent = m.surface;
          frag.appendChild(a);
          cursor = m.end;
          linksAdded += 1;
        }
        if (cursor < original.length) {
          frag.appendChild(document.createTextNode(original.slice(cursor)));
        }
        child.parentNode?.replaceChild(frag, child);
      } else if (child.nodeType === 1) {
        const el = child as Element;
        if (!skipTags.has(el.tagName.toLowerCase())) walker(el);
      }
    }
  };

  walker(root);
  return { html: root.innerHTML, linksAdded };
}

export function extractTextFromHtml(html: string): string {
  return stripTags(html);
}
