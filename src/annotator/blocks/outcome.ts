import type { InOutcome } from './types.js';
import { esc } from './helpers.js';

/**
 * Render outcome section when note replaces others.
 * Returns empty string when no replaces are provided.
 */
export function renderOutcome(input: InOutcome): string {
  if (!input.replaces || input.replaces.length === 0) return '';
  return [
    `  <aside role="doc-note" data-section="outcome">`,
    `    <p>This note supersedes: ${esc(input.replaces.join(', '))}</p>`,
    '  </aside>',
  ].join('\n');
}
