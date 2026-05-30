import type { InLeadSection } from './types.js';
import { esc } from './helpers.js';

export function renderLeadSection(input: InLeadSection): string {
  if (!input.subject && !input.description) return '';
  return `<section data-section="lead">\n  <p><b>${esc(input.subject)}</b> ${esc(input.description)}</p>\n</section>`;
}
