import type { InAntipatterns } from './types.js';
import { esc, enrichFactWithSemantics, detectDpubRoleForFact } from './helpers.js';

/**
 * Render anti-pattern section for "don't redo" warnings.
 * Detects all anti-pattern keywords and wraps with DPub roles.
 * Returns empty string when no anti-patterns are detected.
 */
export function renderAntipatterns(input: InAntipatterns): string {
  const antiPatterns = input.facts.filter(
    (f) =>
      f.kind === 'error' ||
      /\b(?:don'?t|never|do not|abandoned|reverted|tried using|broke|avoid|skip|rollback|backed out|workaround|mistake|shouldn'?t|was wrong)\b/i.test(
        f.text,
      ),
  );
  if (antiPatterns.length === 0) return '';
  const items = antiPatterns.slice(0, 3).map((a) => {
    const role = detectDpubRoleForFact(a.text) ?? 'doc-warning';
    return `    <p role="${role}">${enrichFactWithSemantics(esc(a.text))}</p>`;
  });
  return [
    `  <aside role="doc-warning" data-section="antipatterns">`,
    `    <strong>Anti-patterns (don't redo):</strong>`,
    ...items,
    '  </aside>',
  ].join('\n');
}
