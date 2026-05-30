/**
 * Shared helpers for reconstructing a CodeNode from a stored file-neuron HTML article.
 *
 * These were extracted from commands/enrich.ts (Task 6.1) so that the injection
 * pipeline can reuse the same parsing logic without duplication.
 *
 * All functions are pure / deterministic — no I/O.
 */

import type { CodeNode } from './code-scanner.js';
import type { NoteFile } from '../store/reader.js';

// ---------------------------------------------------------------------------
// Section parsers
// ---------------------------------------------------------------------------

/**
 * Parse imports from the architecture section of a file-neuron HTML article.
 *
 * The architecture section renders each import as:
 *   <li><a href="#/file:IMPORT"><code>IMPORT</code></a></li>   (internal)
 *   <li><code>IMPORT</code></li>                               (external)
 *
 * We extract the text content of every <code> inside the architecture section's
 * Imports subsection (between <h4>Imports</h4> and <h4>Exports</h4>).
 */
export function parseImportsFromHtml(html: string): string[] {
  const archMatch = html.match(/<section\s+data-section="architecture">([\s\S]*?)<\/section>/i);
  if (!archMatch) return [];
  const archHtml = archMatch[1];

  const importsMatch = archHtml.match(/<h4>Imports<\/h4>([\s\S]*?)(?:<h4>Exports<\/h4>|$)/i);
  if (!importsMatch) return [];
  const importsHtml = importsMatch[1];

  const imports: string[] = [];
  const codeRe = /<code>([^<]+)<\/code>/g;
  let m: RegExpExecArray | null;
  while ((m = codeRe.exec(importsHtml)) !== null) {
    const val = m[1].trim();
    if (val && val !== 'none') imports.push(val);
  }
  return imports;
}

/**
 * Parse exports from the architecture section of a file-neuron HTML article.
 *
 * The architecture section renders each export as:
 *   <li><code>EXPORT_NAME</code></li>
 * after the <h4>Exports</h4> heading.
 */
export function parseExportsFromHtml(html: string): string[] {
  const archMatch = html.match(/<section\s+data-section="architecture">([\s\S]*?)<\/section>/i);
  if (!archMatch) return [];
  const archHtml = archMatch[1];

  const exportsMatch = archHtml.match(/<h4>Exports<\/h4>([\s\S]*)$/i);
  if (!exportsMatch) return [];
  const exportsHtml = exportsMatch[1];

  const exports: string[] = [];
  const codeRe = /<code>([^<]+)<\/code>/g;
  let m: RegExpExecArray | null;
  while ((m = codeRe.exec(exportsHtml)) !== null) {
    const val = m[1].trim();
    if (val && val !== 'none detected') exports.push(val);
  }
  return exports;
}

/**
 * Parse AST functions from the children section of a file-neuron HTML article.
 *
 * The children section renders each function as:
 *   <h3 id="fn-NAME">...<code>NAME(params)</code></h3>
 *
 * We reconstruct minimal astFunctions entries (name, isExported from export-badge,
 * params parsed from the code text, startLine/endLine set to 0 since not stored).
 */
export function parseAstFunctionsFromHtml(
  html: string,
): NonNullable<CodeNode['astFunctions']> {
  const childrenMatch = html.match(/<section\s+data-section="children">([\s\S]*?)<\/section>/i);
  if (!childrenMatch) return [];
  const childrenHtml = childrenMatch[1];

  const fns: NonNullable<CodeNode['astFunctions']> = [];
  const fnRe = /<h3\s+id="fn-([^"]+)">([\s\S]*?)<\/h3>/gi;
  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(childrenHtml)) !== null) {
    const headingContent = m[2];
    const isExported = headingContent.includes('class="export-badge"');
    const codeMatch = headingContent.match(/<code>([^(]+)\(([^)]*)\)<\/code>/);
    if (!codeMatch) continue;
    const name = codeMatch[1].trim();
    const rawParams = codeMatch[2].trim();
    const params = rawParams ? rawParams.split(',').map((p) => p.trim()).filter(Boolean) : [];
    fns.push({ name, startLine: 0, endLine: 0, params, isExported });
  }
  return fns;
}

/**
 * Parse AST classes from the children section of a file-neuron HTML article.
 *
 * The children section renders each class as:
 *   <h3 id="cls-NAME">...<code>NAME[extends BASE]</code></h3>
 *   <ul class="method-list"><li><code>METHOD()</code></li>...</ul>
 */
export function parseAstClassesFromHtml(
  html: string,
): NonNullable<CodeNode['astClasses']> {
  const childrenMatch = html.match(/<section\s+data-section="children">([\s\S]*?)<\/section>/i);
  if (!childrenMatch) return [];
  const childrenHtml = childrenMatch[1];

  const classes: NonNullable<CodeNode['astClasses']> = [];
  const clsRe = /<h3\s+id="cls-([^"]+)">([\s\S]*?)<\/h3>(?:\s*<ul\s+class="method-list">([\s\S]*?)<\/ul>)?/gi;
  let m: RegExpExecArray | null;
  while ((m = clsRe.exec(childrenHtml)) !== null) {
    const headingContent = m[2];
    const methodsHtml = m[3] ?? '';
    const isExported = headingContent.includes('class="export-badge"');

    const codeMatch = headingContent.match(/<code>([^<]+)<\/code>/);
    if (!codeMatch) continue;
    const codeText = codeMatch[1].trim();
    const extendsMatch = codeText.match(/^(\S+)\s+extends\s+(\S+)$/);
    const name = extendsMatch ? extendsMatch[1] : codeText;
    const extendsVal = extendsMatch ? extendsMatch[2] : undefined;

    const methods: string[] = [];
    const methodRe = /<code>([^(]+)\(\)<\/code>/g;
    let mm: RegExpExecArray | null;
    while ((mm = methodRe.exec(methodsHtml)) !== null) {
      methods.push(mm[1].trim());
    }

    classes.push({ name, methods, isExported, ...(extendsVal ? { extends: extendsVal } : {}) });
  }
  return classes;
}

// ---------------------------------------------------------------------------
// High-level stub extractor
// ---------------------------------------------------------------------------

/**
 * Extract file-neuron CodeNode stubs from stored file-neuron HTML notes.
 *
 * Reads data-code-file, data-code-language, data-code-lines, data-cerveau-source
 * from the article element's attributes, then parses the existing architecture and
 * children sections to recover imports, exports, astFunctions and astClasses.
 *
 * This ensures that when enrich re-renders a touched file-neuron via composeFileNeuron,
 * the architecture (imports/exports) and children (function/class anchors) sections
 * are preserved — not erased.
 */
export function extractFileNeuronStubsFromHtml(notes: NoteFile[]): CodeNode[] {
  const stubs: CodeNode[] = [];
  for (const note of notes) {
    if (!note.html.includes('data-cerveau-type="file-neuron"')) continue;
    const fileMatch = note.html.match(/data-code-file\s*=\s*["']([^"']+)["']/i);
    const langMatch = note.html.match(/data-code-language\s*=\s*["']([^"']+)["']/i);
    const linesMatch = note.html.match(/data-code-lines\s*=\s*["']([^"']+)["']/i);
    const srcMatch = note.html.match(/data-cerveau-source\s*=\s*["']code-scanner:([^"']+)["']/i);
    if (!fileMatch || !srcMatch) continue;
    const filePath = fileMatch[1];
    const projectRoot = srcMatch[1];
    const language = langMatch?.[1] ?? 'unknown';
    const lineCount = parseInt(linesMatch?.[1] ?? '0', 10) || 0;

    const imports = parseImportsFromHtml(note.html);
    const exports = parseExportsFromHtml(note.html);
    const astFunctions = parseAstFunctionsFromHtml(note.html);
    const astClasses = parseAstClassesFromHtml(note.html);

    stubs.push({
      id: `file:${filePath}`,
      title: filePath,
      type: 'file',
      filePath,
      projectRoot,
      language,
      lineCount,
      imports,
      exports,
      ...(astFunctions.length > 0 ? { astFunctions } : {}),
      ...(astClasses.length > 0 ? { astClasses } : {}),
    });
  }
  return stubs;
}

/**
 * Parse a single file-neuron HTML note into a CodeNode, or return null if not
 * a valid file-neuron. Used by inject-context to parse on-the-fly without
 * loading the full note list.
 */
export function parseFileNeuronHtml(html: string): CodeNode | null {
  if (!html.includes('data-cerveau-type="file-neuron"')) return null;
  const fileMatch = html.match(/data-code-file\s*=\s*["']([^"']+)["']/i);
  const srcMatch = html.match(/data-cerveau-source\s*=\s*["']code-scanner:([^"']+)["']/i);
  if (!fileMatch || !srcMatch) return null;

  const filePath = fileMatch[1];
  const projectRoot = srcMatch[1];
  const langMatch = html.match(/data-code-language\s*=\s*["']([^"']+)["']/i);
  const linesMatch = html.match(/data-code-lines\s*=\s*["']([^"']+)["']/i);
  const language = langMatch?.[1] ?? 'unknown';
  const lineCount = parseInt(linesMatch?.[1] ?? '0', 10) || 0;

  const imports = parseImportsFromHtml(html);
  const exports = parseExportsFromHtml(html);
  const astFunctions = parseAstFunctionsFromHtml(html);
  const astClasses = parseAstClassesFromHtml(html);

  return {
    id: `file:${filePath}`,
    title: filePath,
    type: 'file',
    filePath,
    projectRoot,
    language,
    lineCount,
    imports,
    exports,
    ...(astFunctions.length > 0 ? { astFunctions } : {}),
    ...(astClasses.length > 0 ? { astClasses } : {}),
  };
}
