/**
 * Token-efficient compression of file-neuron CodeNodes.
 *
 * Produces a compact, deterministic text representation of a file's structure
 * without any function bodies — analogous to Repomix signature-only mode and
 * the Aider repo-map approach (signatures + line references, PageRank-ranked).
 *
 * Two compression levels:
 *   - default: header + imports + exports + function signatures (name, params, startLine)
 *              + class skeletons (name, extends, method names)
 *   - skeletonOnly: header + exports + names only (no params), maximally compact
 *
 * Typical output sizes:
 *   - default:      ~40–120 tokens per file
 *   - skeletonOnly: ~15–40  tokens per file
 */

import type { CodeNode } from '../graph/code-scanner.js';

export interface CompressOptions {
  /** When true, emit only header + exports + names (no params/lines). */
  skeletonOnly?: boolean;
}

/**
 * Produce a compact text representation of a CodeNode suitable for injection
 * into an LLM context window.
 *
 * Design principles:
 *   - No function bodies — only signatures
 *   - Deterministic (same input → same output)
 *   - One line per function/class where possible
 *   - `skeletonOnly` is strictly shorter than default
 */
export function compressFileNeuron(node: CodeNode, opts: CompressOptions = {}): string {
  const { skeletonOnly = false } = opts;
  const lines: string[] = [];

  // Header: path (Nlines, lang)
  const lineInfo = node.lineCount > 0 ? `${node.lineCount}L` : '?L';
  lines.push(`${node.filePath} (${lineInfo}, ${node.language})`);

  if (skeletonOnly) {
    // Skeleton-only: exports + function/class names only
    if (node.exports.length > 0) {
      lines.push(`exports: ${node.exports.join(', ')}`);
    }
    const fnNames = (node.astFunctions ?? []).map((f) => f.name);
    if (fnNames.length > 0) {
      lines.push(`fns: ${fnNames.join(', ')}`);
    }
    const clsNames = (node.astClasses ?? []).map((c) => c.name);
    if (clsNames.length > 0) {
      lines.push(`cls: ${clsNames.join(', ')}`);
    }
    // Fallback: exports as names when no AST
    if (fnNames.length === 0 && clsNames.length === 0 && node.exports.length === 0) {
      // Still emit header only — that's the minimum
    }
    return lines.join('\n');
  }

  // Default: full signatures
  if (node.imports.length > 0) {
    lines.push(`imports: ${node.imports.join(', ')}`);
  }
  if (node.exports.length > 0) {
    lines.push(`exports: ${node.exports.join(', ')}`);
  }

  // Functions: name(params) :startLine
  const fns = node.astFunctions ?? [];
  if (fns.length > 0) {
    lines.push('functions:');
    for (const fn of fns) {
      const params = fn.params.length > 0 ? fn.params.join(', ') : '';
      const lineRef = fn.startLine > 0 ? ` :${fn.startLine}` : '';
      lines.push(`  ${fn.name}(${params})${lineRef}`);
    }
  }

  // Classes: Name [extends X] { methodA, methodB }
  const classes = node.astClasses ?? [];
  if (classes.length > 0) {
    lines.push('classes:');
    for (const cls of classes) {
      const base = cls.extends ? ` extends ${cls.extends}` : '';
      const methods = cls.methods.length > 0 ? ` { ${cls.methods.join(', ')} }` : '';
      lines.push(`  ${cls.name}${base}${methods}`);
    }
  }

  return lines.join('\n');
}
