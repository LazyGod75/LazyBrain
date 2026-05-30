// examples/brain-ui/components/wiki-view.js
// Renders any code-first neuron (file-neuron, aggregate-neuron, concept) or generic note
// by fetching its raw HTML from the brain and injecting it into the wiki layout.

import {
  sanitizeHtml,
  escapeHtml,
  convertInternalLinks,
  enrichHtmlContent,
  attachWikiLinkHandlers,
  activateStickyToc,
  generateTOC,
} from './shared.js';
import { fetchNote, fetchNoteByPath, resolveHref } from '../lib/api-client.js';

/**
 * Render a wiki article for any neuron type into the container.
 * Used for #/wiki/<id> routes.
 * @param {Element} container
 * @param {{ note: object|null, notes: Array }} data
 * @returns {Promise<void>}
 */
export async function renderWiki(container, { note, notes }) {
  if (!note) {
    container.innerHTML = `<div class="empty-state">
      <h2>Neuron not found</h2>
      <p>No neuron with this ID. Try searching or browsing the project tree.</p>
    </div>`;
    return;
  }

  container.innerHTML = '<div class="loading">Loading&hellip;</div>';

  try {
    // Prefer the canonical /_api/note/:id endpoint (resolves by ID across all stores).
    // Fall back to path-based fetch if the ID route fails (e.g. old knowledge-nodes).
    let rawHtml = null;
    try {
      rawHtml = await fetchNote(note.id);
    } catch {
      rawHtml = await fetchNoteByPath(note.path);
    }
    if (!rawHtml) {
      throw new Error(`Could not load note: ${note.id}`);
    }
    await renderWikiContent(container, note, rawHtml, notes);
  } catch (err) {
    container.innerHTML = `<div class="empty-state">
      <h2>Failed to load neuron</h2>
      <p>${escapeHtml(err.message)}</p>
    </div>`;
  }
}

/**
 * Parse and inject raw note HTML into the container, with breadcrumb and wiki layout.
 * Rewrites child/dependency links to use SPA routing.
 * @param {Element} container
 * @param {object} note
 * @param {string} rawHtml
 * @param {Array} allNotes
 * @returns {Promise<void>}
 */
async function renderWikiContent(container, note, rawHtml, allNotes) {
  const clean = sanitizeHtml(rawHtml);

  const parser = new DOMParser();
  const doc = parser.parseFromString(clean, 'text/html');
  const article = doc.querySelector('article') || doc.body;

  // Extract metadata from article attributes
  const noteType = article.getAttribute('data-cerveau-type') || note.type || '';
  const noteTitle = note.title || article.querySelector('h1')?.textContent?.trim() || note.id;
  const noteTopic = note.topic || article.getAttribute('data-cerveau-topic') || '';

  // Rewrite internal links to SPA routes before rendering
  rewriteLinks(article, allNotes);

  // Build breadcrumb from topic
  const breadcrumbHtml = buildBreadcrumb(noteTopic, noteTitle, note);

  // Build the type badge
  const typeCls = noteType.toLowerCase().replace(/[^a-z0-9]/g, '-');
  const typeBadge = `<span class="type-badge ${typeCls} neuron-type-badge">${escapeHtml(noteType.toUpperCase())}</span>`;

  // Prepare article content
  const contentEl = document.createElement('div');
  contentEl.className = 'wiki-article neuron-article';
  contentEl.setAttribute('data-neuron-type', noteType);

  // Build metadata bar
  const metaBar = buildMetaBar(article, note);

  contentEl.innerHTML = `
    <div class="neuron-header">
      ${typeBadge}
      ${note.created ? `<span class="neuron-created">${escapeHtml(formatCreated(note.created))}</span>` : ''}
    </div>
    ${article.innerHTML}
  `;

  enrichHtmlContent(contentEl);

  // Generate TOC from headings if the article has enough sections.
  // generateTOC returns a <nav class="toc"> string that syncMetaSidebar can pick up.
  const headings = contentEl.querySelectorAll('h2, h3');
  if (headings.length >= 2) {
    const tocHtml = generateTOC(contentEl);
    if (tocHtml) {
      const tocEl = document.createElement('div');
      tocEl.className = 'wiki-toc-wrap';
      tocEl.innerHTML = tocHtml;
      contentEl.prepend(tocEl);
    }
  }

  container.innerHTML = breadcrumbHtml;
  container.appendChild(contentEl);

  attachWikiLinkHandlers(container);
  activateStickyToc(container);

  // Wire remaining SPA navigation in any href="#/<path>" links
  wireSpaLinks(container, allNotes);
}

/**
 * Rewrite all internal links in the article to use the unified #/wiki/<id> SPA route.
 * Rules:
 *   #/wiki/<id>              → already correct, keep
 *   #/note/<id>              → rewrite to #/wiki/<id> (unified route, never dead)
 *   #/file:<path>            → resolve file path → #/wiki/<resolved-id>
 *   #<id> (contains colon)   → try note-id match → #/wiki/<id>
 *   #fn-* / #cls-*           → in-page anchors, keep
 * @param {Element} article
 * @param {Array} allNotes
 */
function rewriteLinks(article, allNotes) {
  const links = article.querySelectorAll('a[href]');
  for (const link of links) {
    const href = link.getAttribute('href');
    if (!href) continue;

    // Already the canonical route
    if (href.startsWith('#/wiki/')) continue;

    // In-page anchor for fn- / cls- (function/class section anchors within a file-neuron)
    if (href.startsWith('#fn-') || href.startsWith('#cls-')) continue;

    // Legacy #/note/<id> — rewrite to #/wiki/<id> so the unified endpoint resolves it
    if (href.startsWith('#/note/')) {
      const rawId = decodeURIComponent(href.slice('#/note/'.length));
      link.setAttribute('href', `#/wiki/${encodeURIComponent(rawId)}`);
      link.classList.add('wiki-link');
      continue;
    }

    // Children links: #/file:<relative-path> — resolve to #/wiki/<file-neuron-id>
    if (href.startsWith('#/file:')) {
      const filePath = href.slice('#/file:'.length);
      const resolvedId = resolveFilePathToId(filePath, allNotes);
      if (resolvedId) {
        link.setAttribute('href', `#/wiki/${encodeURIComponent(resolvedId)}`);
        link.classList.add('wiki-link');
      }
      continue;
    }

    // Generic href starting with # and containing a colon — might be a neuron reference
    if (href.startsWith('#') && href.includes(':')) {
      const rawId = href.slice(1);
      const note = allNotes.find((n) => n.id === rawId);
      if (note) {
        link.setAttribute('href', `#/wiki/${encodeURIComponent(rawId)}`);
        link.classList.add('wiki-link');
      }
    }
  }
}

/**
 * Resolve a relative code file path to a note ID using the notes list.
 * @param {string} filePath — e.g. "docs/archive/legacy-dashboard/charts.js"
 * @param {Array} allNotes
 * @returns {string|null}
 */
function resolveFilePathToId(filePath, allNotes) {
  // Build slug from file path components
  const parts = filePath.replace(/\\/g, '/').split('/');
  const sluggedParts = parts.map((p) => p.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, ''));

  // Find file-neuron whose ID contains all slug parts
  const candidates = allNotes.filter((n) => n.type === 'file-neuron');
  const match = candidates.find((n) => {
    return sluggedParts.every((part) => part.length > 1 && n.id.includes(part));
  });
  return match?.id ?? null;
}

/**
 * Wire any remaining href="#/..." links not yet handled by shared.js attachWikiLinkHandlers.
 * Also handles links that point to aggregate-neuron or concept IDs.
 * @param {Element} container
 * @param {Array} allNotes
 */
function wireSpaLinks(container, allNotes) {
  const links = container.querySelectorAll('a[href^="#/wiki/"], a[href^="#/note/"]');
  for (const link of links) {
    if (link.dataset.clickBound) continue;
    link.dataset.clickBound = '1';
    link.classList.add('wiki-link');
    link.addEventListener('click', (e) => {
      e.preventDefault();
      location.hash = link.getAttribute('href');
    });
  }
}

/**
 * Build a breadcrumb for a neuron based on its topic + title.
 * @param {string} topic
 * @param {string} title
 * @param {object} note
 * @returns {string}
 */
function buildBreadcrumb(topic, title, note) {
  let items = `<li><a href="#/">LazyBrain</a></li>`;

  if (topic) {
    const parts = topic.split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const path = parts.slice(0, i + 1).join('/');
      items += `<li><a href="#/${path}">${escapeHtml(parts[i])}</a></li>`;
    }
  }

  items += `<li><strong>${escapeHtml(title)}</strong></li>`;
  return `<nav aria-label="breadcrumb"><ol class="breadcrumb">${items}</ol></nav>`;
}

/**
 * Build a metadata bar showing extra code neuron attributes.
 * @param {Element} article
 * @param {object} note
 * @returns {string}
 */
function buildMetaBar(article, note) {
  const codeFile = article.getAttribute('data-code-file') || '';
  const language = article.getAttribute('data-code-language') || '';
  const lines = article.getAttribute('data-code-lines') || '';
  const exports = article.getAttribute('data-code-exports') || '';
  const importance = note.importance ? (note.importance * 100).toFixed(0) + '%' : '';

  const items = [];
  if (codeFile) items.push(`<span class="meta-item"><span class="meta-label">File:</span> <code>${escapeHtml(codeFile)}</code></span>`);
  if (language) items.push(`<span class="meta-item"><span class="meta-label">Language:</span> ${escapeHtml(language)}</span>`);
  if (lines) items.push(`<span class="meta-item"><span class="meta-label">Lines:</span> ${escapeHtml(lines)}</span>`);
  if (exports) items.push(`<span class="meta-item"><span class="meta-label">Exports:</span> ${escapeHtml(exports)}</span>`);
  if (importance) items.push(`<span class="meta-item"><span class="meta-label">Importance:</span> ${escapeHtml(importance)}</span>`);

  if (items.length === 0) return '';
  return `<div class="metadata-bar code-meta-bar">${items.join('')}</div>`;
}

/**
 * Format a created ISO string as a short date.
 * @param {string} iso
 * @returns {string}
 */
function formatCreated(iso) {
  if (!iso) return '';
  return iso.slice(0, 10);
}
