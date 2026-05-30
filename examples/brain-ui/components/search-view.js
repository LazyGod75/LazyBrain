// examples/brain-ui/components/search-view.js
// Search results list component — handles both inline search and #/search/<query> routing.

import { escapeHtml, formatDate } from './shared.js';
import { searchNotes } from '../lib/api-client.js';

/**
 * Render search results into container.
 * Performs API search (with local fallback) for the given query.
 * @param {Element} container
 * @param {{ query: string, notes: Array }} data
 * @returns {Promise<void>}
 */
export async function renderSearch(container, { query, notes }) {
  if (!query || query.trim() === '') {
    container.innerHTML = `<div class="empty-state">
      <h2>Search</h2>
      <p>Enter a term to search across all notes.</p>
    </div>`;
    return;
  }

  container.innerHTML = '<div class="loading">Searching...</div>';

  const results = await resolveSearch(query, notes);

  const breadcrumb = `<nav aria-label="breadcrumb">
    <ol class="breadcrumb">
      <li><a href="#/" onclick="event.preventDefault(); location.hash='#/'">LazyBrain</a></li>
      <li><strong>Search: ${escapeHtml(query)}</strong></li>
    </ol>
  </nav>`;

  const header = `<div style="margin-bottom: 24px;">
    <h1 style="font-size: 1.8em; font-weight: 600; margin-bottom: 8px;">
      Search results for <em style="color: var(--accent-color, #2196F3);">${escapeHtml(query)}</em>
    </h1>
    <p style="color: #666; font-size: 0.9em;">${results.length} result${results.length !== 1 ? 's' : ''} found</p>
  </div>`;

  if (results.length === 0) {
    container.innerHTML = breadcrumb + header + `
      <div class="empty-state">
        <p>No notes found matching <strong>${escapeHtml(query)}</strong>.</p>
        <p style="margin-top: 8px; font-size: 0.9em; color: #888;">
          Try a different search term or
          <a href="#/" onclick="event.preventDefault(); location.hash='#/'" style="color: var(--link-color, #1a73e8);">browse all topics</a>.
        </p>
      </div>`;
    return;
  }

  const items = results.map(note => renderResultItem(note, query)).join('');

  container.innerHTML = breadcrumb + header + `<ul class="note-list search-results">${items}</ul>`;
}

async function resolveSearch(query, allNotes) {
  try {
    const data = await searchNotes(query, 20);
    const results = data.results || [];
    if (Array.isArray(results) && results.length > 0) {
      return results.map(r => {
        const full = allNotes.find(n => n.id === r.id);
        return {
          id: r.id,
          title: full?.title || r.id,
          type: full?.type,
          topic: full?.topic,
          created: full?.created,
          routing_level: data.levelUsed,
          score: r.score
        };
      });
    }
  } catch (_) {
    // fall through to local search
  }

  // Local fallback: search across title, tags, type, topic
  const q = query.toLowerCase();
  return allNotes
    .filter(n => {
      const text = `${n.title || ''} ${n.tags || ''} ${n.type || ''} ${n.topic || ''}`.toLowerCase();
      return text.includes(q);
    })
    .sort((a, b) => {
      // Boost notes where title matches
      const aTitle = (a.title || '').toLowerCase().includes(q) ? 1 : 0;
      const bTitle = (b.title || '').toLowerCase().includes(q) ? 1 : 0;
      return bTitle - aTitle;
    })
    .slice(0, 20);
}

/**
 * Highlight query terms within a text string.
 * @param {string} text
 * @param {string} query
 * @returns {string}
 */
function highlightQuery(text, query) {
  if (!text || !query) return escapeHtml(text || '');
  const safeText = escapeHtml(text);
  const safeQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safeText.replace(new RegExp(`(${safeQuery})`, 'gi'), '<mark>$1</mark>');
}

function renderResultItem(note, query) {
  const typeClass = (note.type || '').toLowerCase();
  const routingLevel = note.routing_level
    ? `<span class="routing-level">L${note.routing_level}</span>`
    : '';
  const score = note.score
    ? `<span class="search-score">score: ${note.score.toFixed(2)}</span>`
    : '';

  const topicPill = note.topic
    ? `<span class="activity-topic">${escapeHtml(note.topic)}</span>`
    : '';

  const titleHtml = highlightQuery(note.title || note.id, query);

  return `<li class="search-result-item" onclick="location.hash='#/note/${escapeHtml(note.id)}'">
    <div class="search-result-header">
      <span class="type-badge ${typeClass}">${(note.type || '?').slice(0, 3).toUpperCase()}</span>
      <span class="search-result-title">${titleHtml}</span>
      ${routingLevel}
      ${score}
    </div>
    <div class="search-result-meta">
      ${topicPill}
      <span class="note-date">${formatDate(note.created)}</span>
    </div>
  </li>`;
}
