import { parseHTML } from 'linkedom';

export interface ScrubResult {
  cleaned: string;
  removedAttrs: string[];
  blockedReason?: string;
  warnings: string[];
}

// Attributes considered safe for public publication.
// Anything else is stripped silently.
const PUBLIC_SAFE_ATTRS = new Set([
  'id',
  'class',
  'href',
  'src',
  'alt',
  'title',
  'lang',
  'dir',
  'datetime',
  'data-cerveau-version',
  'data-cerveau-created',
  'data-cerveau-updated',
  'data-cerveau-type',
  'data-cerveau-tier',
  'data-cerveau-tags',
  'data-cerveau-importance',
  'data-cerveau-source',
  'data-cerveau-valid-from',
  'data-cerveau-valid-until',
  'data-cerveau-fact',
  'data-cerveau-confidence',
  'data-cerveau-kind',
  'data-cerveau-link-type',
  'data-cerveau-link-strength',
  'data-cerveau-link-direction',
  'data-cerveau-link-auto',
  'data-cerveau-batch-size',
  'data-cerveau-batch-period',
  'data-cerveau-compression-ratio',
  // Relations and metadata
  'data-cerveau-entities',
  'data-cerveau-triples',
  'data-cerveau-causes',
  'data-cerveau-replaces',
  'data-cerveau-replaced-by',
  'data-cerveau-supersedes',
  // Extraction metadata
  'data-cerveau-extracted-by',
  'data-cerveau-saliency-kind',
  'data-cerveau-topic',
  'data-cerveau-tool',
  'data-cerveau-cwd',
  'data-cerveau-files-modified',
  'data-cerveau-files-read',
  // Access and validity tracking
  'data-cerveau-access-count',
  'data-cerveau-last-accessed',
  'data-cerveau-invalidated-by',
  // Attributes for links in infobox and semantic HTML
  'rel',
  'data-q',
  'data-error',
  'data-section',
  'data-primary',
  'aria-current',
  'aria-expanded',
  'value',
  'min',
  'max',
  'optimum',
  'role',
  'reversed',
]);

const FORBIDDEN_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'iframe',
  'object',
  'embed',
  'template',
  'form',
  'input',
  'textarea',
  'button',
]);

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9]{20,}/,
  /AIza[0-9A-Za-z\-_]{30,}/,
  /ghp_[A-Za-z0-9]{30,}/,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /[A-Za-z0-9_]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, // any email — conservative
];

const PRIVATE_PATH_PATTERN = /(?:[A-Z]:[\\/]|\/Users\/|\/home\/)/i;

export function scrubForPublic(html: string): ScrubResult {
  const removed: string[] = [];
  const warnings: string[] = [];

  // Detect secrets in raw text first
  for (const pattern of SECRET_PATTERNS) {
    const m = html.match(pattern);
    if (m) {
      return {
        cleaned: '',
        removedAttrs: removed,
        warnings,
        blockedReason: `Secret/PII pattern detected: ${pattern.source.slice(0, 40)}…`,
      };
    }
  }

  const { document } = parseHTML(`<!doctype html><body>${html}</body>`);

  for (const tag of Array.from(document.querySelectorAll([...FORBIDDEN_TAGS].join(',')))) {
    tag.remove();
    warnings.push(`Removed <${tag.tagName.toLowerCase()}>`);
  }

  for (const el of Array.from(document.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes) as Attr[]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
        removed.push(`${name} (event handler)`);
        continue;
      }
      if (!PUBLIC_SAFE_ATTRS.has(name)) {
        el.removeAttribute(attr.name);
        removed.push(name);
      } else if (name === 'data-cerveau-source' || name === 'href' || name === 'src') {
        const value = attr.value;
        if (PRIVATE_PATH_PATTERN.test(value)) {
          warnings.push(`Private path replaced in ${name}: ${value}`);
          el.setAttribute(attr.name, '[scrubbed]');
        }
      }
    }
  }

  const root = document.querySelector('article, section, memory-batch');
  return {
    cleaned: root?.outerHTML ?? document.body.innerHTML,
    removedAttrs: [...new Set(removed)],
    warnings,
  };
}
