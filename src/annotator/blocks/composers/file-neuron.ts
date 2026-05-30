/**
 * file-neuron composer: renders a single code file as a wiki-style HTML article.
 *
 * One file-neuron per code file, with in-page anchors for each function/class
 * so the wiki can deep-link to #fn-NAME and #cls-NAME.
 *
 * Reuses existing block renderers: renderInfobox, renderToc, renderSeeAlso.
 */

import type { CodeNode } from '../../../graph/code-scanner.js';
import { canonicalProjectSegment } from '../../../util/cwd-normalizer.js';
import { esc } from '../helpers.js';
import { renderInfobox } from '../infobox.js';
import { renderSeeAlso } from '../see-also.js';
import { renderToc } from '../toc.js';

// ---------------------------------------------------------------------------
// Enrichment types (Task 5)
// ---------------------------------------------------------------------------

/**
 * A single knowledge item attached to a file-neuron section.
 * Produced by the conversation enrichment pipeline.
 */
export interface EnrichmentItem {
  /** Plain-text knowledge item extracted from a conversation. */
  text: string;
  /** Confidence in [0, 1]. */
  confidence: number;
  /** ISO date (YYYY-MM-DD) of the source conversation. */
  date: string;
  /** Link to the source conversation note (e.g. "#conv-abc"). */
  sourceConvLink: string;
  /**
   * When true, this item was superseded by a newer claim of the same kind.
   * Written as data-cerveau-superseded="true" on the <li>.
   */
  superseded?: boolean;
  /**
   * ISO date when this item became invalid (the newer item's date).
   * Written as data-cerveau-valid-until="DATE" on the <li>.
   */
  validUntil?: string;
}

/**
 * Enrichment payload attached to a file-neuron by the conv enrichment pipeline.
 * All fields are optional — only non-empty arrays render HTML sections.
 *
 * `activities` is an honest fallback for keyword-less conversations:
 * conversations that touched the file but produced no classifiable items
 * (no decision/bug/idea/rule/qa) are recorded here rather than mislabeled.
 */
export interface FileNeuronEnrichment {
  decisions?: EnrichmentItem[];
  bugs?: EnrichmentItem[];
  ideas?: EnrichmentItem[];
  rules?: EnrichmentItem[];
  qa?: EnrichmentItem[];
  /** Conversations that touched this file but produced no classifiable knowledge items. */
  activities?: EnrichmentItem[];
}

// ---------------------------------------------------------------------------
// Anchor ID sanitizer
// ---------------------------------------------------------------------------

/**
 * Convert a symbol name to a valid HTML id: lowercase, non-alphanumeric → hyphen.
 * Multiple consecutive hyphens are collapsed.
 */
function toAnchorId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ---------------------------------------------------------------------------
// Section renderers (private to this composer)
// ---------------------------------------------------------------------------

function renderBreadcrumb(projectName: string, filePath: string): string {
  const segments = [projectName, ...filePath.replace(/\\/g, '/').split('/')];
  const links = segments.slice(0, -1).map((seg, i) => {
    const href = segments.slice(0, i + 1).join('/');
    return `<a href="#/${esc(href)}">${esc(seg)}</a>`;
  });
  const last = `<span aria-current="page">${esc(segments[segments.length - 1])}</span>`;
  const crumbs = [...links, last].join(' / ');
  return `<nav class="breadcrumb" aria-label="breadcrumb">${crumbs}</nav>`;
}

function renderTldr(node: CodeNode): string {
  const fnCount = node.astFunctions?.length ?? 0;
  const clsCount = node.astClasses?.length ?? 0;
  let text: string;
  if (fnCount > 0 || clsCount > 0) {
    const parts: string[] = [];
    if (fnCount > 0) parts.push(`${fnCount} function${fnCount !== 1 ? 's' : ''}`);
    if (clsCount > 0) parts.push(`${clsCount} class${clsCount !== 1 ? 'es' : ''}`);
    text = `${esc(node.language)} file with ${parts.join(', ')} (${node.lineCount} lines)`;
  } else {
    text = `${esc(node.language)} file — ${node.lineCount} lines, ${node.exports.length} export${node.exports.length !== 1 ? 's' : ''}`;
  }
  return `<section data-section="tldr">\n  <p>${text}</p>\n</section>`;
}

function renderArchitectureSection(node: CodeNode): string {
  const importItems =
    node.imports.length > 0
      ? node.imports
          .map((imp) => {
            // Imports that look like internal file references get a link
            const isInternal = imp.startsWith('.') || imp.startsWith('/');
            const id = isInternal ? `file:${imp}` : imp;
            return isInternal
              ? `<li><a href="#/${esc(id)}"><code>${esc(imp)}</code></a></li>`
              : `<li><code>${esc(imp)}</code></li>`;
          })
          .join('\n      ')
      : '<li><em>none</em></li>';

  const exportItems =
    node.exports.length > 0
      ? node.exports.map((e) => `<li><code>${esc(e)}</code></li>`).join('\n      ')
      : '<li><em>none detected</em></li>';

  return [
    '<section data-section="architecture">',
    '  <h3>Imports &amp; Exports</h3>',
    '  <h4>Imports</h4>',
    '  <ul>',
    `      ${importItems}`,
    '  </ul>',
    '  <h4>Exports</h4>',
    '  <ul>',
    `      ${exportItems}`,
    '  </ul>',
    '</section>',
  ].join('\n');
}

function renderFunctionAnchor(fn: NonNullable<CodeNode['astFunctions']>[number]): string {
  const anchorId = `fn-${toAnchorId(fn.name)}`;
  const params = fn.params.map(esc).join(', ');
  const exportBadge = fn.isExported
    ? '<span class="export-badge" aria-label="exported">export</span> '
    : '';
  return `<h3 id="${anchorId}">${exportBadge}<code>${esc(fn.name)}(${params})</code></h3>`;
}

function renderClassAnchor(cls: NonNullable<CodeNode['astClasses']>[number]): string {
  const anchorId = `cls-${toAnchorId(cls.name)}`;
  const extendsPart = cls.extends ? ` extends ${esc(cls.extends)}` : '';
  const exportBadge = cls.isExported
    ? '<span class="export-badge" aria-label="exported">export</span> '
    : '';
  const methodList =
    cls.methods.length > 0
      ? `<ul class="method-list">${cls.methods.map((m) => `<li><code>${esc(m)}()</code></li>`).join('')}</ul>`
      : '';
  return [
    `<h3 id="${anchorId}">${exportBadge}<code>${esc(cls.name)}${extendsPart}</code></h3>`,
    methodList,
  ]
    .filter(Boolean)
    .join('\n  ');
}

function renderChildrenSection(node: CodeNode): string {
  const fnAnchors = (node.astFunctions ?? []).map(renderFunctionAnchor);
  const clsAnchors = (node.astClasses ?? []).map(renderClassAnchor);
  const all = [...clsAnchors, ...fnAnchors];
  if (all.length === 0) return '';

  return [
    '<section data-section="children">',
    '  <h3>Symbols</h3>',
    ...all.map((a) => `  ${a}`),
    '</section>',
  ].join('\n');
}

function buildTocEntries(
  node: CodeNode,
  enrichment?: FileNeuronEnrichment,
  hasSeeAlso?: boolean,
): Array<{ level: number; id: string; text: string }> {
  const entries: Array<{ level: number; id: string; text: string }> = [
    { level: 1, id: 'architecture', text: 'Imports & Exports' },
  ];

  const hasSymbols = (node.astFunctions?.length ?? 0) > 0 || (node.astClasses?.length ?? 0) > 0;
  if (hasSymbols) {
    entries.push({ level: 1, id: 'children', text: 'Symbols' });
    for (const cls of node.astClasses ?? []) {
      entries.push({ level: 2, id: `cls-${toAnchorId(cls.name)}`, text: cls.name });
    }
    for (const fn of node.astFunctions ?? []) {
      entries.push({ level: 2, id: `fn-${toAnchorId(fn.name)}`, text: fn.name });
    }
  }

  // Enrichment sections — only add TOC entry when the array is non-empty
  if (enrichment) {
    if ((enrichment.decisions?.length ?? 0) > 0)
      entries.push({ level: 1, id: 'decisions', text: 'Decisions' });
    if ((enrichment.bugs?.length ?? 0) > 0)
      entries.push({ level: 1, id: 'bugs', text: 'Bugs' });
    if ((enrichment.ideas?.length ?? 0) > 0)
      entries.push({ level: 1, id: 'ideas', text: 'Ideas' });
    if ((enrichment.rules?.length ?? 0) > 0)
      entries.push({ level: 1, id: 'rules', text: 'Rules' });
    if ((enrichment.qa?.length ?? 0) > 0)
      entries.push({ level: 1, id: 'qa', text: 'Q & A' });
    if ((enrichment.activities?.length ?? 0) > 0)
      entries.push({ level: 1, id: 'activity', text: 'Referenced in Conversations' });
  }

  // Only add see-also TOC entry when there are real links to show
  if (hasSeeAlso) {
    entries.push({ level: 1, id: 'see-also', text: 'See also' });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Enrichment section renderer (Task 5)
// ---------------------------------------------------------------------------

/**
 * Render a single enrichment item as an <li> element.
 * Superseded items carry data-cerveau-valid-until and data-cerveau-superseded.
 */
function renderEnrichmentItem(item: EnrichmentItem): string {
  const supersededAttrs = item.superseded
    ? ` data-cerveau-superseded="true" data-cerveau-valid-until="${esc(item.validUntil ?? '')}"`
    : '';
  const link = item.sourceConvLink
    ? ` <a href="${esc(item.sourceConvLink)}" class="conv-source">[source]</a>`
    : '';
  return `<li${supersededAttrs} data-cerveau-confidence="${item.confidence}" data-cerveau-date="${esc(item.date)}">${esc(item.text)}${link}</li>`;
}

/**
 * Render a single conditional enrichment section (decisions, bugs, ideas…).
 * Returns empty string when the items array is empty.
 */
function renderEnrichmentSection(
  sectionId: string,
  heading: string,
  items: EnrichmentItem[] | undefined,
): string {
  if (!items || items.length === 0) return '';
  const listItems = items.map(renderEnrichmentItem).join('\n    ');
  return [
    `<section data-section="${sectionId}">`,
    `  <h3>${heading}</h3>`,
    '  <ul>',
    `    ${listItems}`,
    '  </ul>',
    '</section>',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Safe article id
// ---------------------------------------------------------------------------

function buildArticleId(projectName: string, filePath: string): string {
  const sanitized = `${projectName}-${filePath}`
    .replace(/[^a-z0-9]/gi, '-')
    .replace(/-+/g, '-')
    .toLowerCase()
    .slice(0, 80);
  return `file-${sanitized}`;
}

// ---------------------------------------------------------------------------
// Main composer
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Importance formula for file-neurons
// ---------------------------------------------------------------------------

/**
 * Derive an importance score for a file-neuron from its structural signals.
 *
 * Formula:
 *   importance = clamp(BASE + INBOUND_BONUS * min(inbound, INBOUND_CAP) / INBOUND_CAP
 *                      + EXPORT_BONUS * min(exports, EXPORT_CAP) / EXPORT_CAP, 0, 1)
 *
 *   BASE        = 0.55  — slightly above the FTS default of 0.5 so file-neurons
 *                         are not systematically under-ranked vs un-annotated notes.
 *   INBOUND_BONUS = 0.35 — a hub file imported by many peers is highly relevant;
 *                          reward up to +0.35 for high fan-in.
 *   INBOUND_CAP  = 20   — normalisation ceiling: 20+ inbound edges → full bonus.
 *   EXPORT_BONUS = 0.10 — large public API surface is a secondary hub signal.
 *   EXPORT_CAP   = 10   — normalisation ceiling for exports.
 *
 * Result is in [0.55, 1.0] for any file and monotonically increases with inbound count.
 */
const IMPORTANCE_BASE = 0.55;
const INBOUND_BONUS = 0.35;
const INBOUND_CAP = 20;
const EXPORT_BONUS = 0.10;
const EXPORT_CAP = 10;

function computeFileNeuronImportance(inbound: number, exportCount: number): number {
  const inboundFraction = Math.min(inbound, INBOUND_CAP) / INBOUND_CAP;
  const exportFraction = Math.min(exportCount, EXPORT_CAP) / EXPORT_CAP;
  const raw = IMPORTANCE_BASE + INBOUND_BONUS * inboundFraction + EXPORT_BONUS * exportFraction;
  return Math.min(1, Math.max(0, raw));
}

/**
 * A single see-also link for a file-neuron.
 * Derived from real graph edges (imports / imported-by) or shared topic prefix.
 */
export interface FileNeuronSeeAlsoLink {
  /** Note id of the related neuron. */
  id: string;
  /** Display title of the related neuron. */
  title: string;
}

/**
 * Compose a complete <article data-cerveau-type="file-neuron"> HTML string.
 *
 * Always included:
 * - breadcrumb (project / dir / file)
 * - infobox (language, line count, inbound, exports)
 * - tldr (from AST counts or fallback text)
 * - architecture (imports + exports, linked where internal)
 * - children (function/class anchors for deep-linking)
 * - toc (links to sections and symbol anchors)
 *
 * Conditional conversation sections (decisions/bugs/ideas/rules/qa) are
 * rendered from the optional `enrichment` argument — only when non-empty.
 * They are placed after the code/structure sections.
 *
 * See-also links are derived from real graph edges (imports/imported-by) and
 * shared topic-path prefix siblings, NOT from cluster membership. Pass them
 * via the `seeAlso` argument. When empty (the default), the see-also section
 * is omitted from the rendered page.
 *
 * @param node       The CodeNode representing the file.
 * @param inbound    Number of files that import this file (default 0).
 * @param enrichment Optional enrichment payload from the conv pipeline.
 * @param seeAlso    Optional see-also links from real graph edges / topic siblings.
 */
export function composeFileNeuron(
  node: CodeNode,
  inbound = 0,
  enrichment?: FileNeuronEnrichment,
  seeAlso?: FileNeuronSeeAlsoLink[],
): string {
  const now = new Date().toISOString().slice(0, 10);
  // Preserve the original directory name for human-readable display (breadcrumb, title).
  const projectName =
    node.projectRoot.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? 'project';
  // Canonical topic key: always lowercase so code notes and conversation notes
  // share the same first topic segment regardless of on-disk casing.
  const canonicalProject = canonicalProjectSegment(projectName);

  const articleId = buildArticleId(projectName, node.filePath);

  // Importance derived from fan-in (inbound) and export count so that hub
  // files rank competitively against conversation notes (which carry 0.7-0.9).
  const importance = computeFileNeuronImportance(inbound, node.exports.length);

  const infobox = renderInfobox({
    rows: [
      { label: 'Language', value: node.language },
      { label: 'Lines', value: String(node.lineCount) },
      { label: 'Inbound', value: String(inbound) },
      { label: 'Exports', value: String(node.exports.length) },
    ],
  });

  // See-also: use real links passed by the caller (derived from graph edges /
  // topic siblings). Fall back to empty — better to omit than to cross-link
  // unrelated projects via a degenerate cluster bucket.
  const seeAlsoLinks = seeAlso ?? [];
  const seeAlsoSection = renderSeeAlso({
    links: seeAlsoLinks.map((l) => ({ id: l.id, title: l.title })),
  });

  const toc = renderToc({ entries: buildTocEntries(node, enrichment, seeAlsoLinks.length > 0) });

  // Callers linked by inbound edges — if inbound > 0 but no caller list is
  // available on the node itself, render a minimal "used by N files" note.
  // Full caller resolution is left to the enrichment task.
  const usedBy =
    inbound > 0
      ? `<section data-section="used-by">\n  <h3>Used by</h3>\n  <p>Imported by ${inbound} file${inbound !== 1 ? 's' : ''}.</p>\n</section>`
      : '';

  // Conditional enrichment sections — only rendered when non-empty
  const decisionsSection = renderEnrichmentSection('decisions', 'Decisions', enrichment?.decisions);
  const bugsSection = renderEnrichmentSection('bugs', 'Bugs', enrichment?.bugs);
  const ideasSection = renderEnrichmentSection('ideas', 'Ideas', enrichment?.ideas);
  const rulesSection = renderEnrichmentSection('rules', 'Rules', enrichment?.rules);
  const qaSection = renderEnrichmentSection('qa', 'Q & A', enrichment?.qa);
  // Activity section: honest fallback for keyword-less conversations.
  // Rendered with a low-key heading so it is visually distinct from decisions/bugs.
  const activitySection = renderEnrichmentSection(
    'activity',
    'Touched in Conversations',
    enrichment?.activities,
  );

  const parts: string[] = [
    '<article',
    `  id="${esc(articleId)}"`,
    `  data-cerveau-version="0.2.0"`,
    `  data-cerveau-type="file-neuron"`,
    `  data-cerveau-created="${now}T00:00:00Z"`,
    `  data-cerveau-source="code-scanner:${esc(node.projectRoot)}"`,
    `  data-cerveau-tags="code ${esc(node.language)} ${esc(projectName)} file-neuron"`,
    `  data-cerveau-topic="${esc(canonicalProject)}/code/${esc(node.language)}"`,
    `  data-cerveau-importance="${importance.toFixed(4)}"`,
    `  data-code-file="${esc(node.filePath)}"`,
    `  data-code-project="code-${esc(projectName)}"`,
    `  data-code-language="${esc(node.language)}"`,
    `  data-code-lines="${node.lineCount}"`,
    `  data-code-inbound="${inbound}"`,
    `  data-code-exports="${node.exports.length}"`,
    '>',
    renderBreadcrumb(projectName, node.filePath),
    `<h1>${esc(node.filePath)}</h1>`,
    infobox,
    renderTldr(node),
    toc,
    renderArchitectureSection(node),
    renderChildrenSection(node),
    usedBy,
    // Enrichment sections placed after code/structure, before see-also
    decisionsSection,
    bugsSection,
    ideasSection,
    rulesSection,
    qaSection,
    // Activity section is last among enrichment: least important, most honest
    activitySection,
    seeAlsoSection,
    '</article>',
  ];

  return parts.filter((p) => p.trim().length > 0).join('\n');
}
