import { describe, it, expect } from 'vitest';
import { composeTopicOverview } from '../topic-overview.js';
import { composeProjectSummary } from '../project-summary.js';
import { composeBrainIndex } from '../brain-index.js';
import { composeConceptNeuron } from '../concept-neuron.js';
import { composeAggregateNeuron } from '../aggregate-neuron.js';
import { buildAggregateNeurons } from '../../../../graph/code-scanner.js';

describe('composeTopicOverview', () => {
  it('generates a Wikipedia-style topic overview article with prose sections', () => {
    const html = composeTopicOverview({
      id: 'topic-quantflow-overview',
      title: 'Quantflow',
      created: '2026-05-26T00:00:00Z',
      leadText: 'Quantflow encompasses algorithmic strategies, backtesting, and live execution.',
      sections: '<section><h2 id="aegis">Aegis</h2>\n<p>Aegis is a live quantflow bot for MT5.</p></section>',
      stats: { noteCount: 44, typeBreakdown: { decision: 5, semantic: 20, architecture: 10, procedural: 9 }, dateRange: ['2025-01-01', '2026-05-26'], avgImportance: 0.78 },
      relatedTopics: [{ id: 'topic-acme-overview', title: 'Acme' }],
      tags: ['quantflow', 'ml', 'mt5'],
    });
    expect(html).toContain('<article id="topic-quantflow-overview"');
    expect(html).toContain('data-cerveau-type="topic-overview"');
    expect(html).toContain('data-cerveau-generated="dream-synthesize"');
    expect(html).toContain('data-cerveau-tags="quantflow,ml,mt5"');
    expect(html).toContain('data-section="lead"');
    expect(html).toContain('<b>Quantflow</b>');
    expect(html).toContain('<h2 id="aegis">Aegis</h2>');
    expect(html).toContain('Aegis is a live quantflow bot');
    expect(html).toContain('data-section="see-also"');
    expect(html).toContain('Acme');
    expect(html).toContain('class="categories"');
    expect(html).toContain('application/ld+json');
    expect(html).toContain('</article>');
    // Should NOT contain a data table of notes
    expect(html).not.toContain('<table class="wikitable sortable">');
  });
});

describe('composeProjectSummary', () => {
  it('generates a project summary with stack info', () => {
    const html = composeProjectSummary({
      id: 'project-aegis-summary',
      title: 'Aegis Bot',
      created: '2026-05-26T00:00:00Z',
      leadText: 'Aegis is a live quantflow bot for MetaTrader 5.',
      stack: 'TypeScript, MT5, MQL5',
      status: 'Active',
      stats: { noteCount: 6, typeBreakdown: { architecture: 2, decision: 2, semantic: 2 }, dateRange: ['2025-06-01', '2026-05-20'], avgImportance: 0.82 },
      notes: [{ title: 'Aegis Architecture', date: '2026-05-01', type: 'architecture', importance: '0.90' }],
      relatedTopics: [{ id: 'project-argos-summary', title: 'ARGOS' }],
      tags: ['quantflow', 'aegis', 'live'],
    });
    expect(html).toContain('data-cerveau-type="project-summary"');
    expect(html).toContain('data-cerveau-tags="quantflow,aegis,live"');
    expect(html).toContain('TypeScript, MT5, MQL5');
    expect(html).toContain('Active');
  });
});

describe('composeBrainIndex', () => {
  it('generates a Wikipedia-style brain index page with prose topic descriptions', () => {
    const html = composeBrainIndex({
      id: 'brain-index',
      title: 'LazyBrain Index',
      created: '2026-05-26T00:00:00Z',
      leadText: 'This brain covers 2 main topics: Quantflow, Acme. It contains 94 notes.',
      stats: { totalNotes: 94, totalTopics: 2, dateRange: ['2025-01-01', '2026-05-26'] },
      topics: [
        { name: 'Quantflow', id: 'topic-overview-quantflow', noteCount: 44, lastActivity: '2026-05-26', description: 'Algorithmic quantflow strategies and live execution.' },
        { name: 'Acme', id: 'topic-overview-acme', noteCount: 50, lastActivity: '2026-05-20', description: 'Sports and fitness mobile application.' },
      ],
      tags: ['brain', 'index'],
    });
    expect(html).toContain('data-cerveau-type="brain-index"');
    expect(html).toContain('data-cerveau-tags="brain,index"');
    expect(html).toContain('Quantflow');
    expect(html).toContain('44');
    expect(html).toContain('Algorithmic quantflow strategies');
    // Should NOT contain a data table
    expect(html).not.toContain('<table class="wikitable');
  });
});

// ---------------------------------------------------------------------------
// Task 2: confidence display rounded to 2 decimals in concept-neuron infobox
// ---------------------------------------------------------------------------

describe('composeConceptNeuron — confidence display', () => {
  it('shows confidence rounded to 2 decimals in the infobox', () => {
    const html = composeConceptNeuron({
      id: 'concept:use-idempotency-keys',
      title: 'Use idempotency keys for Stripe',
      kind: 'rule',
      body: 'Always pass an idempotency key when creating charges.',
      confidence: 0.2777777777777778,
      date: '2026-05-29',
      related: [],
    });
    // Rendered infobox dd must show exactly "0.28" — not the raw float
    expect(html).toContain('<dd>0.28</dd>');
    // The raw precision must be preserved in the data attribute for computation
    expect(html).toContain('data-cerveau-confidence="0.2777777777777778"');
  });

  it('shows confidence 1.0 as "1.00"', () => {
    const html = composeConceptNeuron({
      id: 'concept:always-valid',
      title: 'Always valid rule',
      kind: 'rule',
      body: 'This rule is always valid.',
      confidence: 1,
      date: '2026-05-29',
      related: [],
    });
    expect(html).toContain('<dd>1.00</dd>');
  });

  it('shows confidence 0.5 as "0.50"', () => {
    const html = composeConceptNeuron({
      id: 'concept:medium-confidence',
      title: 'Medium confidence concept',
      kind: 'idea',
      body: 'Some idea with medium confidence.',
      confidence: 0.5,
      date: '2026-05-29',
      related: [],
    });
    expect(html).toContain('<dd>0.50</dd>');
    expect(html).not.toContain('<dd>0.5</dd>');
  });

  it('confidence with many decimals does not appear raw in the infobox dd', () => {
    const raw = 5 / 18; // 0.2777... repeating
    const html = composeConceptNeuron({
      id: 'concept:low-confidence',
      title: 'Low confidence',
      kind: 'fact',
      body: 'Uncertain fact.',
      confidence: raw,
      date: '2026-05-29',
      related: [],
    });
    // Raw float string must NOT appear inside a <dd> element
    expect(html).not.toContain(`<dd>${raw}</dd>`);
    // Must contain the rounded 2-decimal version
    expect(html).toContain(`<dd>${raw.toFixed(2)}</dd>`);
  });
});

// ---------------------------------------------------------------------------
// Wave 4: concept-neuron topic canonicalization
// ---------------------------------------------------------------------------

describe('composeConceptNeuron — canonical topic segment', () => {
  it('produces a lowercase first segment in data-cerveau-topic when projectName has mixed case', () => {
    const html = composeConceptNeuron({
      id: 'concept:canonical-topic-test',
      title: 'Canonical topic test',
      projectName: 'Acme',
      kind: 'fact',
      body: 'Topic canonicalization check.',
      confidence: 0.9,
      date: '2026-05-29',
      related: [],
    });
    // The grouping topic must use the canonical (lowercase) first segment
    expect(html).toContain('data-cerveau-topic="acme/concepts"');
    // The human-readable display label is still visible in the breadcrumb
    expect(html).toContain('>Acme<');
  });

  it('produces "concepts" as topic when no projectName is given', () => {
    const html = composeConceptNeuron({
      id: 'concept:no-project',
      title: 'No project concept',
      kind: 'idea',
      body: 'No project.',
      confidence: 0.5,
      date: '2026-05-29',
      related: [],
    });
    expect(html).toContain('data-cerveau-topic="concepts"');
  });
});

// ---------------------------------------------------------------------------
// Task 3: aggregate-neuron see-also from real module relationships
// ---------------------------------------------------------------------------

describe('composeAggregateNeuron — see-also section', () => {
  it('renders see-also when seeAlso is provided', () => {
    const html = composeAggregateNeuron({
      id: 'module:src/auth',
      kind: 'module',
      title: 'src/auth',
      path: 'src/auth',
      projectName: 'myproject',
      children: [],
      stats: { fileCount: 3, totalLines: 300, languages: ['typescript'] },
      seeAlso: [
        { id: 'module:src/payments', title: 'payments' },
        { id: 'module:src/users', title: 'users' },
      ],
    });
    expect(html).toContain('data-section="see-also"');
    expect(html).toContain('module:src/payments');
    expect(html).toContain('payments');
  });

  it('omits see-also section when seeAlso is absent', () => {
    const html = composeAggregateNeuron({
      id: 'module:src/utils',
      kind: 'module',
      title: 'src/utils',
      path: 'src/utils',
      projectName: 'myproject',
      children: [],
      stats: { fileCount: 1, totalLines: 50, languages: ['typescript'] },
    });
    expect(html).not.toContain('data-section="see-also"');
  });
});

describe('buildAggregateNeurons — see-also from real relationships', () => {
  it('assigns sibling-module see-also when modules share a parent directory', () => {
    // Fake CodeScanResult with two sibling directories: src/auth and src/payments
    const mockResult = {
      projectRoot: '/fake/project',
      projectName: 'myproject',
      nodes: [
        {
          id: 'file:src/auth/index.ts',
          title: 'src/auth/index.ts',
          type: 'file' as const,
          filePath: 'src/auth/index.ts',
          projectRoot: '/fake/project',
          language: 'typescript',
          lineCount: 100,
          imports: [],
          exports: ['authenticate'],
        },
        {
          id: 'file:src/payments/index.ts',
          title: 'src/payments/index.ts',
          type: 'file' as const,
          filePath: 'src/payments/index.ts',
          projectRoot: '/fake/project',
          language: 'typescript',
          lineCount: 80,
          imports: [],
          exports: ['charge'],
        },
        {
          id: 'file:src/users/index.ts',
          title: 'src/users/index.ts',
          type: 'file' as const,
          filePath: 'src/users/index.ts',
          projectRoot: '/fake/project',
          language: 'typescript',
          lineCount: 60,
          imports: [],
          exports: ['getUser'],
        },
      ],
      edges: [],
      stats: { files: 3, modules: 3, languages: { typescript: 3 } },
    };

    const aggregates = buildAggregateNeurons(mockResult);

    // Find the src/auth module descriptor
    const authModule = aggregates.find((d) => d.path === 'src/auth');
    expect(authModule).toBeDefined();

    // src/auth should have see-also pointing at its siblings (src/payments, src/users)
    const seeAlsoIds = (authModule?.seeAlso ?? []).map((s) => s.id);
    expect(seeAlsoIds.length).toBeGreaterThan(0);
    // At least one sibling module should be present
    const hasSibling =
      seeAlsoIds.includes('module:src/payments') || seeAlsoIds.includes('module:src/users');
    expect(hasSibling).toBe(true);
  });

  it('assigns cross-module import connections to see-also', () => {
    // src/auth imports from src/utils — the two modules should link to each other
    const mockResult = {
      projectRoot: '/fake/project',
      projectName: 'myproject',
      nodes: [
        {
          id: 'file:src/auth/index.ts',
          title: 'src/auth/index.ts',
          type: 'file' as const,
          filePath: 'src/auth/index.ts',
          projectRoot: '/fake/project',
          language: 'typescript',
          lineCount: 100,
          imports: ['../utils/helpers.ts'],
          exports: ['authenticate'],
        },
        {
          id: 'file:src/utils/helpers.ts',
          title: 'src/utils/helpers.ts',
          type: 'file' as const,
          filePath: 'src/utils/helpers.ts',
          projectRoot: '/fake/project',
          language: 'typescript',
          lineCount: 40,
          imports: [],
          exports: ['formatDate'],
        },
      ],
      edges: [
        {
          source: 'file:src/auth/index.ts',
          target: 'file:src/utils/helpers.ts',
          type: 'imports' as const,
          confidence: 'extracted' as const,
          confidenceScore: 1.0 as 1.0,
        },
      ],
      stats: { files: 2, modules: 2, languages: { typescript: 2 } },
    };

    const aggregates = buildAggregateNeurons(mockResult);

    // src/auth should link to src/utils via the import edge
    const authModule = aggregates.find((d) => d.path === 'src/auth');
    expect(authModule).toBeDefined();
    const seeAlsoIds = (authModule?.seeAlso ?? []).map((s) => s.id);
    expect(seeAlsoIds).toContain('module:src/utils');

    // src/utils should link back to src/auth (imported by)
    const utilsModule = aggregates.find((d) => d.path === 'src/utils');
    expect(utilsModule).toBeDefined();
    const utilsSeeAlsoIds = (utilsModule?.seeAlso ?? []).map((s) => s.id);
    expect(utilsSeeAlsoIds).toContain('module:src/auth');
  });

  it('project root aggregate has no see-also (its sub-modules are children)', () => {
    const mockResult = {
      projectRoot: '/fake/project',
      projectName: 'myproject',
      nodes: [
        {
          id: 'file:src/auth/index.ts',
          title: 'src/auth/index.ts',
          type: 'file' as const,
          filePath: 'src/auth/index.ts',
          projectRoot: '/fake/project',
          language: 'typescript',
          lineCount: 50,
          imports: [],
          exports: [],
        },
      ],
      edges: [],
      stats: { files: 1, modules: 1, languages: { typescript: 1 } },
    };

    const aggregates = buildAggregateNeurons(mockResult);
    const rootAggregate = aggregates.find((d) => d.kind === 'project');
    expect(rootAggregate).toBeDefined();
    // Root should have no see-also
    expect(rootAggregate?.seeAlso ?? []).toHaveLength(0);
  });

  it('see-also is capped at 5 entries per module', () => {
    // Create 7 sibling directories — each module's see-also should be capped at 5
    const nodes = Array.from({ length: 7 }, (_, i) => ({
      id: `file:src/mod${i}/index.ts`,
      title: `src/mod${i}/index.ts`,
      type: 'file' as const,
      filePath: `src/mod${i}/index.ts`,
      projectRoot: '/fake/project',
      language: 'typescript',
      lineCount: 20,
      imports: [],
      exports: [],
    }));

    const mockResult = {
      projectRoot: '/fake/project',
      projectName: 'myproject',
      nodes,
      edges: [],
      stats: { files: 7, modules: 7, languages: { typescript: 7 } },
    };

    const aggregates = buildAggregateNeurons(mockResult);
    for (const agg of aggregates) {
      if (agg.kind === 'module') {
        expect((agg.seeAlso ?? []).length).toBeLessThanOrEqual(5);
      }
    }
  });
});
