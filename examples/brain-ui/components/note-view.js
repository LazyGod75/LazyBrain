// examples/brain-ui/components/note-view.js
// Full note article rendering — the most complex view component.

import {
  sanitizeHtml,
  escapeHtml,
  formatDate,
  convertInternalLinks,
  enrichHtmlContent,
  attachWikiLinkHandlers,
  generateTOC
} from './shared.js';
import { fetchBacklinks } from '../lib/api-client.js';

/**
 * Fetch and render a note article into container.
 * @param {Element} container
 * @param {{ note: object, notes: Array }} data
 * @returns {Promise<void>}
 */
export async function renderNote(container, { note, notes }) {
  if (!note) {
    container.innerHTML = `<div class="empty-state">
      <h2>Note not found</h2>
      <p>No note with this ID.</p>
    </div>`;
    return;
  }

  try {
    const resp = await fetch('/' + note.path);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const rawHtml = await resp.text();
    await renderNoteContent(container, note, rawHtml, notes);
  } catch (err) {
    container.innerHTML = `<div class="empty-state">
      <h2>Failed to load note</h2>
      <p>${escapeHtml(err.message)}</p>
    </div>`;
  }
}

/**
 * Parse, enrich and inject a note's HTML into the container.
 * @param {Element} container
 * @param {object} note
 * @param {string} rawHtml
 * @param {Array} notes — full notes list for backlink title resolution
 * @returns {Promise<void>}
 */
async function renderNoteContent(container, note, rawHtml, notes) {
  const clean = convertInternalLinks(sanitizeHtml(rawHtml));

  const parser = new DOMParser();
  const doc = parser.parseFromString(clean, 'text/html');
  const article = doc.querySelector('article') || doc.body;

  const meta = extractMeta(article, note);
  const sections = extractSections(article);

  let html = buildBreadcrumb(meta.topic, meta.title);
  html += `<article class="wiki-article type-${meta.type.toLowerCase()}">`;
  html += `<h1>${escapeHtml(meta.title)}</h1>`;
  html += buildMetadataBar(meta);
  html += buildEntityTags(meta.entities);
  html += buildValidityBar(meta);
  html += buildRelationships(meta);
  html += buildExpiryWarning(meta);
  html += buildTldrBox(sections.tldr);

  const mainDiv = buildMainContent(sections);
  const tocHtml = sections.summary ? generateTOC(mainDiv) : null;

  if (tocHtml) html += tocHtml;
  html += `<div class="article-content">${mainDiv.innerHTML}</div>`;
  html += buildFactsBox(sections.facts);
  html += '</article>';

  container.innerHTML = html;

  await loadAndRenderBacklinks(note.id, container, notes);
}

// --- Meta extraction ---------------------------------------------------------

function extractMeta(article, note) {
  return {
    type: article.getAttribute('data-cerveau-type') || note.type || '',
    tags: article.getAttribute('data-cerveau-tags') || note.tags || '',
    created: article.getAttribute('data-cerveau-created') || note.created || '',
    title: note.title || article.getAttribute('id') || 'Untitled',
    topic: note.topic || '',
    confidence: parseFloat(article.getAttribute('data-cerveau-confidence') || '0'),
    importance: parseFloat(article.getAttribute('data-cerveau-importance') || '0'),
    validUntil: article.getAttribute('data-cerveau-valid-until'),
    validFrom: article.getAttribute('data-cerveau-valid-from'),
    entities: article.getAttribute('data-cerveau-entities') || '',
    saliencyKind: article.getAttribute('data-cerveau-saliency-kind') || '',
    replaces: article.getAttribute('data-cerveau-replaces'),
    replacedBy: article.getAttribute('data-cerveau-replaced-by')
  };
}

function extractSections(article) {
  return {
    tldr: article.querySelector('[data-section="tldr"], section[data-section="tldr"]'),
    summary: article.querySelector('[data-section="summary"], section[data-section="summary"]'),
    facts: article.querySelector('[data-section="facts"], section[data-section="facts"]'),
    reasoning: article.querySelector('[data-section="reasoning"], section[data-section="reasoning"]')
  };
}

// --- HTML builders -----------------------------------------------------------

function buildBreadcrumb(topic, title) {
  let items = `<li><a href="#/">LazyBrain</a></li>`;

  if (topic) {
    const parts = topic.split('/');
    for (let i = 0; i < parts.length; i++) {
      const path = parts.slice(0, i + 1).join('/');
      items += `<li><a href="#/${path}" onclick="event.stopPropagation()">${escapeHtml(parts[i])}</a></li>`;
    }
  }

  items += `<li><strong>${escapeHtml(title)}</strong></li>`;

  return `<nav aria-label="breadcrumb"><ol class="breadcrumb">${items}</ol></nav>`;
}

function buildMetadataBar(meta) {
  let html = '<div class="metadata-bar">';

  if (meta.type) {
    html += `<span class="metadata-item"><span class="type-badge ${meta.type.toLowerCase()}">${escapeHtml(meta.type.toUpperCase())}</span></span>`;
  }
  if (meta.created) {
    html += `<span class="metadata-item"><span class="metadata-label">Updated:</span> <span class="metadata-value">${escapeHtml(formatDate(meta.created))}</span></span>`;
  }
  if (meta.importance > 0) {
    const label = meta.importance > 0.8 ? 'Critical' : meta.importance > 0.6 ? 'High' : 'Normal';
    html += `<span class="metadata-item"><span class="metadata-label">Importance:</span> <span class="metadata-value">${label}</span></span>`;
  }
  if (meta.confidence > 0) {
    const pct = (meta.confidence * 100).toFixed(0);
    html += `<span class="metadata-item">
      <span class="metadata-label">Confidence:</span>
      <span class="confidence-bar">
        <span class="confidence-bar-fill" style="width: ${pct}px;"></span>
        <span>${pct}%</span>
      </span>
    </span>`;
  }
  if (meta.saliencyKind) {
    const cls = meta.saliencyKind.toLowerCase().replace(/\s+/g, '-');
    html += `<span class="metadata-item"><span class="saliency-badge saliency-${cls}">${escapeHtml(meta.saliencyKind)}</span></span>`;
  }

  html += '</div>';
  return html;
}

function buildEntityTags(entities) {
  if (!entities) return '';
  const list = entities.split(',').map(e => e.trim()).filter(Boolean);
  if (list.length === 0) return '';

  const tags = list.map(e =>
    `<span class="entity-tag" onclick="document.getElementById('search').value='${escapeHtml(e)}'; document.getElementById('search').dispatchEvent(new Event('input'))">${escapeHtml(e)}</span>`
  ).join('');

  return `<div style="margin: 12px 0;"><span style="font-size: 12px; color: #666; margin-right: 8px;">Entities:</span>${tags}</div>`;
}

function buildValidityBar(meta) {
  if (!meta.validFrom && !meta.validUntil) return '';

  let html = '<div style="margin: 12px 0;"><span style="font-size: 12px; color: #666;">Valid:</span> ';

  if (meta.validFrom && meta.validUntil) {
    const start = new Date(meta.validFrom);
    const end = new Date(meta.validUntil);
    const now = new Date();
    const total = end.getTime() - start.getTime();
    const elapsed = now.getTime() - start.getTime();
    const pct = Math.max(0, Math.min(100, (elapsed / total) * 100));

    html += `<span class="validity-bar" title="${escapeHtml(meta.validFrom)} to ${escapeHtml(meta.validUntil)}">
      <div class="validity-bar-fill" style="width: ${pct}%"></div>
    </span>`;
  }

  html += `<span style="font-size: 11px; color: #999;">${meta.validFrom || 'N/A'} → ${meta.validUntil || 'N/A'}</span></div>`;
  return html;
}

function buildRelationships(meta) {
  if (!meta.replaces && !meta.replacedBy) return '';

  let html = '<div class="note-relationships">';
  if (meta.replaces) {
    html += `<div>Replaces: <a href="#/note/${escapeHtml(meta.replaces)}" class="wiki-link">${escapeHtml(meta.replaces)}</a></div>`;
  }
  if (meta.replacedBy) {
    html += `<div>Replaced by: <a href="#/note/${escapeHtml(meta.replacedBy)}" class="wiki-link">${escapeHtml(meta.replacedBy)}</a></div>`;
  }
  html += '</div>';
  return html;
}

function buildExpiryWarning(meta) {
  if (!meta.validUntil) return '';
  if (new Date() <= new Date(meta.validUntil)) return '';

  return `<aside role="doc-warning">
    ⚠ This note is outdated (expired on ${escapeHtml(meta.validUntil.slice(0, 10))})
  </aside>`;
}

function buildTldrBox(tldrSection) {
  if (!tldrSection) return '';
  return `<div class="tldr-box"><strong>Summary:</strong> ${tldrSection.innerHTML}</div>`;
}

function buildMainContent(sections) {
  const mainDiv = document.createElement('div');
  mainDiv.className = 'article-content';

  if (sections.summary) {
    mainDiv.innerHTML = sections.summary.innerHTML;
    enrichHtmlContent(mainDiv);
  }

  if (sections.reasoning) {
    const reasoningDiv = document.createElement('div');
    reasoningDiv.innerHTML = `<h2>Reasoning</h2>${sections.reasoning.innerHTML}`;
    enrichHtmlContent(reasoningDiv);
    mainDiv.appendChild(reasoningDiv);
  }

  return mainDiv;
}

function buildFactsBox(factsSection) {
  if (!factsSection) return '';

  const facts = factsSection.querySelectorAll('[data-cerveau-fact]');
  if (facts.length === 0) return '';

  const items = Array.from(facts).map(fact => {
    const conf = parseFloat(fact.getAttribute('data-cerveau-confidence') || '0.5');
    const text = fact.textContent?.trim() || '';
    const meterWidth = Math.round(conf * 100);

    return `<div class="fact-item">
      ${escapeHtml(text)}
      <span class="confidence-meter" title="${(conf * 100).toFixed(0)}% confidence">
        <div class="confidence-meter-fill" style="width: ${meterWidth}%"></div>
      </span>
    </div>`;
  }).join('');

  return `<div class="facts-box"><h3>Key Facts</h3>${items}</div>`;
}

// --- Backlinks ---------------------------------------------------------------

async function loadAndRenderBacklinks(noteId, container, notes) {
  try {
    const data = await fetchBacklinks(noteId);
    const backlinkItems = data.backlinks || data;
    if (!Array.isArray(backlinkItems) || backlinkItems.length === 0) {
      attachWikiLinkHandlers(container);
      return;
    }

    const unique = deduplicateBacklinks(backlinkItems, notes);

    const items = unique.map(bl =>
      `<li><a href="#/note/${escapeHtml(bl.id)}">${escapeHtml(bl.title)}</a></li>`
    ).join('');

    container.innerHTML += `<aside role="complementary" class="backlinks-panel">
      <h3>Pages qui renvoient ici (${unique.length})</h3>
      <ul class="backlinks-list">${items}</ul>
    </aside>`;
  } catch (_) {
    // silently ignore backlink errors
  }

  attachWikiLinkHandlers(container);
}

function deduplicateBacklinks(items, notes) {
  const seen = new Set();
  const unique = [];

  for (const bl of items) {
    const fromId = bl.from || bl.id;
    if (fromId && !seen.has(fromId)) {
      seen.add(fromId);
      const source = notes.find(n => n.id === fromId);
      unique.push({ id: fromId, title: source?.title || bl.surface || fromId });
    }
  }

  return unique;
}
