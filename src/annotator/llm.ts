import { callClaudeCliJsonArray, isClaudeCliAvailable } from '../util/claude-cli.js';
import { getLogger } from '../util/logger.js';
import { type AnnotateOutput, type SessionInput, annotateSession } from './heuristic.js';
import { emitWikipediaNote } from './template.js';

/**
 * LLM-augmented annotation.
 *
 * Wraps the heuristic annotator: if the output is thin (< 3 facts), tries to
 * enrich via Claude. Two paths in priority order:
 *   1. `ANTHROPIC_API_KEY` set → direct API call (legacy, supports custom quota)
 *   2. Active Claude Code session via the `claude` CLI (default — no extra
 *      key needed)
 *
 * Both paths are best-effort. Any failure (missing CLI, timeout, parse error)
 * silently falls back to the heuristic output. Annotation never blocks capture.
 */
export async function annotateWithLlm(input: SessionInput): Promise<AnnotateOutput> {
  const heuristic = annotateSession(input);
  const log = getLogger();
  const lowConfidence = heuristic.factCount < 3;
  if (!lowConfidence) return heuristic;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  try {
    if (apiKey) {
      const upgraded = await callClaude(input, heuristic, apiKey);
      if (upgraded) return upgraded;
    } else if (await isClaudeCliAvailable()) {
      const upgraded = await callClaudeCliEnrich(input, heuristic);
      if (upgraded) return upgraded;
    }
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'LLM annotator failed, falling back to heuristic');
  }
  return heuristic;
}

interface LlmFact {
  text: string;
  confidence: number;
  kind: 'decision' | 'fact' | 'error' | 'learning';
}

const SYSTEM_PROMPT = `You extract atomic facts from a software engineering session transcript.

Output ONLY a compact JSON array. No prose. No code fence. Each item:
{"text": "fact in 5-25 words ending with a period",
 "confidence": 0.0-1.0,
 "kind": "decision" | "fact" | "error" | "learning"}

Rules:
- Maximum 8 facts.
- Each fact MUST stand alone (no "this", "it", or anaphora).
- "decision" = an explicit choice or course of action.
- "error" = a problem encountered or root cause.
- "learning" = a generalisable insight.
- "fact" = a stable claim about the system.
- Skip greetings, status updates, code listings.
- If session is empty / trivial, output [].`;

async function callClaude(
  input: SessionInput,
  heuristic: AnnotateOutput,
  apiKey: string,
): Promise<AnnotateOutput | null> {
  const body = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        // Q2: 1-hour TTL keeps the annotation system prompt hot across the
        // whole session, not just the 5-minute default. Reduces $ on
        // multi-batch sessions where Haiku runs every ~10 captures.
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: input.text.slice(0, 8000),
      },
    ],
  };

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      // Q2: extended cache TTL requires the beta header.
      'anthropic-beta': 'extended-cache-ttl-2025-04-11',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    throw new Error(`Claude API ${resp.status}: ${await resp.text()}`);
  }
  const data = (await resp.json()) as { content?: Array<{ type: string; text: string }> };
  const raw = data.content?.find((b) => b.type === 'text')?.text;
  if (!raw) return null;

  let facts: LlmFact[];
  try {
    const json = raw
      .trim()
      .replace(/^```(?:json)?\n?/, '')
      .replace(/\n?```$/, '');
    facts = JSON.parse(json);
    if (!Array.isArray(facts)) return null;
  } catch {
    return null;
  }

  // Rebuild HTML with LLM facts merged into heuristic structure
  return rebuildHtmlWithFacts(input, heuristic, facts);
}

/**
 * CLI variant of the enrichment path. Uses the user's active Claude Code
 * session (no separate API key) and falls back gracefully on any failure.
 */
async function callClaudeCliEnrich(
  input: SessionInput,
  heuristic: AnnotateOutput,
): Promise<AnnotateOutput | null> {
  const facts = await callClaudeCliJsonArray<LlmFact>(input.text.slice(0, 8000), {
    system: SYSTEM_PROMPT,
    model: 'haiku',
    timeoutMs: 20_000,
  });
  if (!facts || facts.length === 0) return null;
  return rebuildHtmlWithFacts(input, heuristic, facts);
}

function rebuildHtmlWithFacts(
  input: SessionInput,
  base: AnnotateOutput,
  facts: LlmFact[],
): AnnotateOutput {
  const ts = input.timestamp ?? new Date().toISOString();
  const validFacts = facts.filter((f) => f.text && f.text.length > 4).slice(0, 8);
  const inferredType = validFacts.some((f) => f.kind === 'decision') ? 'decision' : base.type;
  const title = validFacts[0]?.text.slice(0, 80) ?? base.id;

  const templateFacts = validFacts.map((f) => ({
    text: f.text,
    confidence: Math.max(0, Math.min(1, f.confidence)),
    kind: f.kind,
    extractor: 'llm:claude-haiku-4-5',
  }));

  const html = emitWikipediaNote({
    id: base.id,
    title,
    type: inferredType,
    created: ts,
    source: `session:${input.sessionId}`,
    tier: 'working',
    importance: 0.7,
    tags: base.tags,
    facts: templateFacts,
  });

  return { ...base, html, factCount: validFacts.length };
}
