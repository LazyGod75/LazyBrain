import { renderInfobox } from '../infobox.js';
import { renderSeeAlso } from '../see-also.js';
import { renderCategories } from '../categories.js';
import { renderJsonLd } from '../json-ld.js';
import { esc } from '../helpers.js';

// ---------------------------------------------------------------------------
// Input interface
// ---------------------------------------------------------------------------

export interface KnowledgeNodeInput {
  id: string;
  title: string;
  topicPath: string;
  created: string;
  updated?: string;
  importance: number;
  confidence: number;
  status: string;
  tags: string[];

  nodeType: string;
  stack?: string[];
  codePath?: string;
  inbound: number;
  outbound: number;

  tldr?: string;
  architecture?: string;
  specs?: Array<{ key: string; value: string }>;
  keyFiles?: Array<{ path: string; description: string }>;

  decisions?: Array<{
    outcome: string;
    reasoning?: string;
    date?: string;
    confidence?: number;
  }>;

  bugs?: Array<{
    symptom: string;
    fix?: string;
    status: 'open' | 'fixed' | 'wontfix';
    date?: string;
  }>;

  ideas?: Array<{
    text: string;
    confidence?: number;
  }>;

  rules?: Array<{
    text: string;
    type: 'warning' | 'tip';
  }>;

  entities?: Array<{
    name: string;
    entityType: string;
    description?: string;
  }>;

  patterns?: Array<{
    name: string;
    description: string;
    example?: string;
  }>;

  dependencies?: Array<{
    id: string;
    title: string;
    linkType: string;
    confidence: string;
  }>;

  children?: Array<{
    id: string;
    title: string;
    tldr?: string;
  }>;

  graphEdges?: Array<{
    targetId: string;
    targetTitle: string;
    direction: 'outgoing' | 'incoming';
    edgeType: string;
    confidence: string;
  }>;

  traces?: Array<{
    date: string;
    summary: string;
    sessionId?: string;
  }>;

  qa?: Array<{
    question: string;
    answer: string;
  }>;

  seeAlso?: Array<{ id: string; title: string; confidence?: string }>;
}

// ---------------------------------------------------------------------------
// Private section renderers — each returns '' when there is nothing to render
// ---------------------------------------------------------------------------

function renderBreadcrumb(topicPath: string): string {
  const segments = topicPath.split('/');
  if (segments.length === 0) return '';

  const links = segments.slice(0, -1).map((seg, i) => {
    const href = segments.slice(0, i + 1).join('/');
    return `<a href="#/${esc(href)}">${esc(seg)}</a>`;
  });
  const last = `<span aria-current="page">${esc(segments[segments.length - 1])}</span>`;
  const crumbs = [...links, last].join(' / ');

  return `<nav class="breadcrumb" aria-label="breadcrumb">${crumbs}</nav>`;
}

function renderTldr(tldr: string | undefined): string {
  if (!tldr) return '';
  // tldr may contain safe HTML — do not double-escape
  return `<section data-section="tldr">\n  <p>${tldr}</p>\n</section>`;
}

function renderArchitecture(
  prose: string | undefined,
  specs: Array<{ key: string; value: string }> | undefined,
  keyFiles: Array<{ path: string; description: string }> | undefined,
): string {
  const hasContent = prose || (specs && specs.length > 0) || (keyFiles && keyFiles.length > 0);
  if (!hasContent) return '';

  const parts: string[] = ['<section data-section="architecture">', '  <h3>Architecture</h3>'];

  if (prose) {
    // prose may contain safe HTML
    parts.push(`  <div class="architecture-prose">${prose}</div>`);
  }

  if (specs && specs.length > 0) {
    const rows = specs.map((s) => `    <dt>${esc(s.key)}</dt><dd>${esc(s.value)}</dd>`);
    parts.push('  <dl class="specs">', ...rows, '  </dl>');
  }

  if (keyFiles && keyFiles.length > 0) {
    const items = keyFiles.map(
      (f) => `      <li><code>${esc(f.path)}</code> — ${esc(f.description)}</li>`,
    );
    parts.push(
      '  <details>',
      '    <summary>Key files</summary>',
      '    <ul>',
      ...items,
      '    </ul>',
      '  </details>',
    );
  }

  parts.push('</section>');
  return parts.join('\n');
}

function renderDecisions(
  decisions: KnowledgeNodeInput['decisions'],
): string {
  if (!decisions || decisions.length === 0) return '';

  const boxes = decisions.map((d) => {
    const lines: string[] = ['  <aside role="doc-note" class="decision-box">'];
    if (d.date) {
      lines.push(`    <time datetime="${esc(d.date)}">${esc(d.date)}</time>`);
    }
    lines.push(`    <p><strong>${esc(d.outcome)}</strong></p>`);
    if (d.reasoning) {
      lines.push(`    <p class="reasoning">${esc(d.reasoning)}</p>`);
    }
    if (d.confidence !== undefined) {
      const pct = Math.round(d.confidence * 100);
      lines.push(
        `    <meter min="0" max="1" value="${d.confidence}" title="Confidence ${pct}%">${pct}%</meter>`,
      );
    }
    lines.push('  </aside>');
    return lines.join('\n');
  });

  return ['<section data-section="decisions">', '  <h3>Decisions</h3>', ...boxes, '</section>'].join('\n');
}

function renderBugs(bugs: KnowledgeNodeInput['bugs']): string {
  if (!bugs || bugs.length === 0) return '';

  const asides = bugs.map((b) => {
    const lines: string[] = ['  <aside role="doc-errata" class="bug-box">'];
    lines.push(`    <mark data-cerveau-status="${esc(b.status)}">${esc(b.status)}</mark>`);
    if (b.date) {
      lines.push(`    <time datetime="${esc(b.date)}">${esc(b.date)}</time>`);
    }
    lines.push(`    <p class="symptom">${esc(b.symptom)}</p>`);
    if (b.fix) {
      lines.push(`    <p class="fix"><strong>Fix:</strong> ${esc(b.fix)}</p>`);
    }
    lines.push('  </aside>');
    return lines.join('\n');
  });

  return ['<section data-section="bugs">', '  <h3>Known Issues</h3>', ...asides, '</section>'].join('\n');
}

function renderIdeas(ideas: KnowledgeNodeInput['ideas']): string {
  if (!ideas || ideas.length === 0) return '';

  const items = ideas.map((idea) => {
    const conf =
      idea.confidence !== undefined
        ? ` data-cerveau-confidence="${idea.confidence}"`
        : '';
    return `    <li data-cerveau-fact data-cerveau-kind="idea"${conf}>${esc(idea.text)}</li>`;
  });

  return ['<section data-section="ideas">', '  <h3>Ideas</h3>', '  <ul>', ...items, '  </ul>', '</section>'].join('\n');
}

function renderRules(rules: KnowledgeNodeInput['rules']): string {
  if (!rules || rules.length === 0) return '';

  const asides = rules.map((r) => {
    const role = r.type === 'warning' ? 'doc-warning' : 'doc-tip';
    return `  <aside role="${role}" class="rule-box rule-${esc(r.type)}">\n    <p>${esc(r.text)}</p>\n  </aside>`;
  });

  return ['<section data-section="rules">', '  <h3>Rules</h3>', ...asides, '</section>'].join('\n');
}

function renderEntities(entities: KnowledgeNodeInput['entities']): string {
  if (!entities || entities.length === 0) return '';

  const rows = entities.map((e) => {
    const desc = e.description ? esc(e.description) : '';
    return [
      '    <tr>',
      `      <td><data value="${esc(e.entityType)}:${esc(e.name)}">${esc(e.name)}</data></td>`,
      `      <td>${esc(e.entityType)}</td>`,
      `      <td>${desc}</td>`,
      '    </tr>',
    ].join('\n');
  });

  return [
    '<section data-section="entities">',
    '  <h3>Entities</h3>',
    '  <table class="wikitable compact">',
    '    <thead><tr><th>Name</th><th>Type</th><th>Description</th></tr></thead>',
    '    <tbody>',
    ...rows,
    '    </tbody>',
    '  </table>',
    '</section>',
  ].join('\n');
}

function renderPatterns(patterns: KnowledgeNodeInput['patterns']): string {
  if (!patterns || patterns.length === 0) return '';

  const details = patterns.map((p) => {
    const lines = [
      '  <details>',
      `    <summary>${esc(p.name)}</summary>`,
      `    <p>${esc(p.description)}</p>`,
    ];
    if (p.example) {
      lines.push(`    <kbd>${esc(p.example)}</kbd>`);
    }
    lines.push('  </details>');
    return lines.join('\n');
  });

  return ['<section data-section="patterns">', '  <h3>Patterns</h3>', ...details, '</section>'].join('\n');
}

function renderDependencies(dependencies: KnowledgeNodeInput['dependencies']): string {
  if (!dependencies || dependencies.length === 0) return '';

  const items = dependencies.map(
    (d) =>
      `    <li><a href="#/${esc(d.id)}" data-cerveau-link-type="${esc(d.linkType)}" data-cerveau-link-confidence="${esc(d.confidence)}">${esc(d.title)}</a> <span class="link-type">${esc(d.linkType)}</span></li>`,
  );

  return ['<section data-section="dependencies">', '  <h3>Dependencies</h3>', '  <ul>', ...items, '  </ul>', '</section>'].join('\n');
}

function renderChildren(children: KnowledgeNodeInput['children']): string {
  if (!children || children.length === 0) return '';

  const items = children.map((c) => {
    const tldr = c.tldr ? ` — ${esc(c.tldr)}` : '';
    return `    <li><a href="#/${esc(c.id)}">${esc(c.title)}</a>${tldr}</li>`;
  });

  return ['<section data-section="children">', '  <h3>Components</h3>', '  <ul>', ...items, '  </ul>', '</section>'].join('\n');
}

function renderGraph(id: string, graphEdges: KnowledgeNodeInput['graphEdges']): string {
  if (!graphEdges || graphEdges.length === 0) return '';

  const items = graphEdges.map((e) => {
    const arrow = e.direction === 'outgoing' ? '→' : '←';
    return [
      `    <li data-cerveau-edge-direction="${esc(e.direction)}" data-cerveau-edge-type="${esc(e.edgeType)}" data-cerveau-edge-confidence="${esc(e.confidence)}">`,
      `      <span class="edge-arrow" aria-label="${e.direction === 'outgoing' ? 'to' : 'from'}">${arrow}</span>`,
      `      <a href="#/${esc(e.targetId)}">${esc(e.targetTitle)}</a>`,
      `      <span class="edge-meta">${esc(e.edgeType)} · ${esc(e.confidence)}</span>`,
      '    </li>',
    ].join('\n');
  });

  return [
    `<section data-section="graph" data-graph-scope="node" data-graph-node="${esc(id)}">`,
    '  <h3>Connections</h3>',
    '  <ul>',
    ...items,
    '  </ul>',
    '</section>',
  ].join('\n');
}

function renderTraces(traces: KnowledgeNodeInput['traces']): string {
  if (!traces || traces.length === 0) return '';

  const items = traces.map((t) => {
    const session = t.sessionId
      ? ` <data value="session:${esc(t.sessionId)}" class="session-id">${esc(t.sessionId)}</data>`
      : '';
    return `      <li><time datetime="${esc(t.date)}">${esc(t.date)}</time>${session} ${esc(t.summary)}</li>`;
  });

  return [
    '<section data-section="traces">',
    '  <h3>History</h3>',
    '  <details>',
    `    <summary>${traces.length} conversation${traces.length !== 1 ? 's' : ''}</summary>`,
    '    <ul>',
    ...items,
    '    </ul>',
    '  </details>',
    '</section>',
  ].join('\n');
}

function renderQa(qa: KnowledgeNodeInput['qa']): string {
  if (!qa || qa.length === 0) return '';

  const details = qa.map(
    (pair) =>
      `  <details>\n    <summary>${esc(pair.question)}</summary>\n    <p>${esc(pair.answer)}</p>\n  </details>`,
  );

  return ['<section data-section="qa">', '  <h3>Q&amp;A</h3>', ...details, '</section>'].join('\n');
}

// ---------------------------------------------------------------------------
// Main composer
// ---------------------------------------------------------------------------

/**
 * Compose a complete knowledge-node article from structured input.
 * Each section is independently queryable via CSS data-section selectors,
 * enabling token-efficient LLM injection (read only the needed section).
 *
 * Returns a full <article> element as an HTML string.
 */
export function composeKnowledgeNode(input: KnowledgeNodeInput): string {
  const entitiesCsv = input.entities
    ? input.entities.map((e) => `${e.entityType}:${e.name}`).join(',')
    : '';

  const updatedAttr = input.updated ? ` data-cerveau-updated="${esc(input.updated)}"` : '';

  const articleAttrs = [
    `id="${esc(input.id)}"`,
    `data-cerveau-type="knowledge-node"`,
    `data-cerveau-version="0.2.0"`,
    `data-cerveau-created="${esc(input.created)}"`,
    updatedAttr.trim() ? updatedAttr.trim() : null,
    `data-cerveau-topic="${esc(input.topicPath)}"`,
    `data-cerveau-source="understand"`,
    `data-cerveau-tier="working"`,
    `data-cerveau-importance="${input.importance}"`,
    `data-cerveau-confidence="${input.confidence}"`,
    `data-cerveau-tags="${esc(input.tags.join(','))}"`,
    entitiesCsv ? `data-cerveau-entities="${esc(entitiesCsv)}"` : null,
    `data-cerveau-status="${esc(input.status)}"`,
    `data-cerveau-generated="knowledge-node"`,
  ]
    .filter(Boolean)
    .join('\n  ');

  const jsonLd = renderJsonLd({
    title: input.title,
    type: 'knowledge-node',
    dateCreated: input.created,
    tags: input.tags,
    description: input.tldr ? input.tldr.replace(/<[^>]+>/g, '') : undefined,
  });

  const infoboxRows = [
    { label: 'Type', value: input.nodeType },
    { label: 'Status', value: input.status },
    ...(input.stack && input.stack.length > 0
      ? [{ label: 'Stack', value: input.stack.join(', ') }]
      : []),
    ...(input.codePath ? [{ label: 'Path', value: input.codePath }] : []),
    {
      label: 'Connections',
      value: `${input.inbound} in · ${input.outbound} out`,
    },
  ];

  const seeAlsoLinks = (input.seeAlso ?? []).map(({ id, title }) => ({ id, title }));

  const parts: string[] = [
    `<article\n  ${articleAttrs}>`,
    renderBreadcrumb(input.topicPath),
    `<h2>${esc(input.title)}</h2>`,
    jsonLd,
    renderInfobox({ rows: infoboxRows }),
    renderTldr(input.tldr),
    renderArchitecture(input.architecture, input.specs, input.keyFiles),
    renderDecisions(input.decisions),
    renderBugs(input.bugs),
    renderIdeas(input.ideas),
    renderRules(input.rules),
    renderEntities(input.entities),
    renderPatterns(input.patterns),
    renderDependencies(input.dependencies),
    renderChildren(input.children),
    renderGraph(input.id, input.graphEdges),
    renderTraces(input.traces),
    renderQa(input.qa),
    renderSeeAlso({ links: seeAlsoLinks }),
    renderCategories({ tags: input.tags }),
    `</article>`,
  ];

  return parts.filter((p) => p.trim().length > 0).join('\n');
}
