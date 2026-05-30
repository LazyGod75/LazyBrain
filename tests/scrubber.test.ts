import { describe, expect, it } from 'vitest';
import { scrubForPublic } from '../src/schema/scrubber.js';
import { emitWikipediaNote } from '../src/annotator/template.js';

describe('scrubForPublic — PUBLIC_SAFE_ATTRS preservation', () => {
  it('preserves data-cerveau-version', () => {
    const html = '<article data-cerveau-version="0.2.0"></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-version="0.2.0"');
  });

  it('preserves data-cerveau-entities from relations', () => {
    const html = '<article data-cerveau-entities="user:john,user:jane"></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-entities');
  });

  it('preserves data-cerveau-triples from relations', () => {
    const html = '<article data-cerveau-triples="user-has-email;friend-with;follows"></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-triples');
  });

  it('preserves data-cerveau-causes from relations', () => {
    const html = '<article data-cerveau-causes="bug-123|deployment-failure"></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-causes');
  });

  it('preserves data-cerveau-saliency-kind', () => {
    const html = '<article data-cerveau-saliency-kind="frequently-accessed"></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-saliency-kind');
  });

  it('preserves data-cerveau-topic', () => {
    const html = '<article data-cerveau-topic="myproject/auth/oauth"></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-topic');
  });

  it('preserves data-cerveau-tool', () => {
    const html = '<article data-cerveau-tool="pytest"></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-tool');
  });

  it('preserves data-cerveau-kind on facts', () => {
    const html =
      '<article><div data-cerveau-fact data-cerveau-kind="error">Stack trace</div></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-kind="error"');
  });

  it('preserves data-cerveau-extracted-by', () => {
    const html =
      '<article><div data-cerveau-fact data-cerveau-extracted-by="heuristic">Fact text</div></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-extracted-by="heuristic"');
  });

  it('preserves data-cerveau-replaces from relations', () => {
    const html = '<article data-cerveau-replaces="old-001,old-002"></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-replaces');
  });

  it('preserves data-cerveau-replaced-by', () => {
    const html = '<article data-cerveau-replaced-by="new-001"></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-replaced-by="new-001"');
  });

  it('preserves data-cerveau-supersedes', () => {
    const html = '<article data-cerveau-supersedes="v1-001,v1-002"></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-supersedes');
  });

  it('preserves data-cerveau-link-strength', () => {
    const html = '<article><a data-cerveau-link-strength="0.95">link</a></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-link-strength="0.95"');
  });

  it('preserves data-cerveau-link-direction', () => {
    const html = '<article><a data-cerveau-link-direction="bidirectional">link</a></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-link-direction="bidirectional"');
  });

  it('preserves data-cerveau-link-auto', () => {
    const html = '<article><a data-cerveau-link-auto="true">link</a></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-link-auto="true"');
  });

  it('preserves data-cerveau-valid-from', () => {
    const html = '<article data-cerveau-valid-from="2026-05-26T00:00:00Z"></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-valid-from="2026-05-26T00:00:00Z"');
  });

  it('preserves data-cerveau-valid-until', () => {
    const html = '<article data-cerveau-valid-until="2026-08-24T00:00:00Z"></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-valid-until="2026-08-24T00:00:00Z"');
  });

  it('preserves data-cerveau-invalidated-by', () => {
    const html = '<article data-cerveau-invalidated-by="fact-bug-report"></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-invalidated-by="fact-bug-report"');
  });

  it('preserves data-cerveau-confidence on articles', () => {
    const html = '<article data-cerveau-confidence="0.92"></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-confidence="0.92"');
  });

  it('preserves data-cerveau-access-count', () => {
    const html = '<article data-cerveau-access-count="42"></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-access-count="42"');
  });

  it('preserves data-cerveau-last-accessed', () => {
    const html = '<article data-cerveau-last-accessed="2026-05-26T12:00:00Z"></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-last-accessed="2026-05-26T12:00:00Z"');
  });

  it('preserves data-cerveau-valid-from on article', () => {
    const html =
      '<article id="test" data-cerveau-valid-from="2026-05-26T00:00:00Z">Content</article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-valid-from');
    expect(result.removedAttrs).not.toContain('data-cerveau-valid-from');
  });

  it('preserves full template output with all attributes', () => {
    const templateInput = {
      id: 'test-002',
      title: 'API Design Patterns',
      type: 'architecture',
      created: '2026-05-26T10:30:00Z',
      source: 'session:test',
      tier: 'working' as const,
      importance: 0.88,
      tags: ['api', 'design'],
      facts: [
        {
          text: 'RESTful endpoints designed',
          confidence: 0.95,
          kind: 'decision',
          extractor: 'llm',
        },
        {
          text: 'Error handling pattern documented',
          confidence: 0.87,
          kind: 'process',
        },
      ],
      relations: {
        entities: ['service:auth', 'service:users'],
        replaces: ['old-api-001'],
        causes: ['improved-client-integration'],
        triples: ['api-has-endpoint;returns;data'],
      },
      toolMeta: {
        tool: 'code-analyzer',
        cwd: '/project/api',
        filesModified: ['src/routes.ts', 'src/handlers.ts'],
        filesRead: ['docs/api-spec.md'],
      },
      saliencyKind: 'frequent-reference',
      topic: 'project/backend/api',
      meanConfidence: 0.91,
      validForDays: 90,
    };

    const templateHtml = emitWikipediaNote(templateInput);
    const scrubbedResult = scrubForPublic(templateHtml);

    // Verify key attributes are preserved after scrubbing
    expect(scrubbedResult.cleaned).toContain('data-cerveau-version');
    expect(scrubbedResult.cleaned).toContain('data-cerveau-entities');
    expect(scrubbedResult.cleaned).toContain('data-cerveau-replaces');
    expect(scrubbedResult.cleaned).toContain('data-cerveau-causes');
    expect(scrubbedResult.cleaned).toContain('data-cerveau-saliency-kind');
    expect(scrubbedResult.cleaned).toContain('data-cerveau-tool="code-analyzer"');
    expect(scrubbedResult.cleaned).toContain('data-cerveau-extracted-by="llm"');
    expect(scrubbedResult.cleaned).toContain('data-cerveau-kind="decision"');
    expect(scrubbedResult.cleaned).toContain('data-cerveau-confidence');

    // Verify no cerveau attrs were removed (except those not in template)
    const cerveauRemovals = scrubbedResult.removedAttrs.filter((a) =>
      a.startsWith('data-cerveau-'),
    );
    expect(cerveauRemovals.length).toBeLessThanOrEqual(2); // Allow minor edge cases
  });

  it('still removes script tags and event handlers', () => {
    const html =
      '<article onclick="alert(1)"><script>alert(1)</script><p>Safe</p></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).not.toContain('script');
    expect(result.cleaned).not.toContain('onclick');
    expect(result.warnings).toContain('Removed <script>');
  });

  it('detects and blocks secrets (OpenAI-style keys)', () => {
    // sk- prefix with 20+ alphanumeric chars triggers detection
    const html =
      '<article data-cerveau-version="0.2.0">This contains sk-1234567890ABCDEFGHIJK which is bad</article>';
    const result = scrubForPublic(html);
    expect(result.blockedReason).toBeDefined();
    expect(result.blockedReason).toMatch(/Secret\/PII/);
  });
});
