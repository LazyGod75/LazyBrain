// examples/brain-ui/components/timeline-view.js
// Chronological timeline of all notes.

import { escapeHtml } from './shared.js';

/**
 * Render the timeline view into container.
 * @param {Element} container
 * @param {{ notes: Array }} data
 */
export function renderTimeline(container, { notes }) {
  const sorted = [...notes].sort((a, b) => {
    return new Date(b.created || '2000-01-01') - new Date(a.created || '2000-01-01');
  });

  const byDate = groupByDate(sorted);

  let html = `<h1>Timeline View</h1>
    <p style="color: #666; margin-bottom: 24px;">Notes organized chronologically</p>
    <div class="timeline-container">`;

  for (const [date, dateNotes] of Object.entries(byDate).sort().reverse()) {
    html += `<div style="margin-bottom: 24px;">
      <h3 style="font-size: 16px; margin-bottom: 12px; color: #666;">${escapeHtml(date)}</h3>`;

    for (const note of dateNotes) {
      html += renderTimelineItem(note, date);
    }

    html += `</div>`;
  }

  html += `</div>`;
  container.innerHTML = html;
}

function groupByDate(notes) {
  const byDate = {};
  for (const note of notes) {
    const date = note.created ? note.created.slice(0, 10) : 'unknown';
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push(note);
  }
  return byDate;
}

function renderTimelineItem(note, date) {
  const typeClass = (note.type || 'other').toLowerCase();
  const validityBar = buildValidityBar(note);

  return `<div class="timeline-item ${typeClass}">
    <div class="timeline-marker">${escapeHtml(date.slice(5))}</div>
    <div class="timeline-content">
      <div class="timeline-title" onclick="location.hash='#/note/${escapeHtml(note.id)}'" style="cursor:pointer">
        ${escapeHtml(note.title || note.id)}
      </div>
      <div class="timeline-date">
        <span class="type-badge ${typeClass}">${(note.type || '?').slice(0, 3).toUpperCase()}</span>
        ${note.topic ? `<span style="color: #666; font-size: 12px;">${escapeHtml(note.topic)}</span>` : ''}
      </div>
      ${validityBar}
    </div>
  </div>`;
}

function buildValidityBar(note) {
  const validFrom = note.validFrom ? new Date(note.validFrom) : null;
  const validUntil = note.validUntil ? new Date(note.validUntil) : null;

  if (!validFrom || !validUntil) return '';

  const now = new Date();
  const total = validUntil.getTime() - validFrom.getTime();
  const elapsed = now.getTime() - validFrom.getTime();
  const percentage = Math.max(0, Math.min(100, (elapsed / total) * 100));

  return `<div class="timeline-bar">
    <div class="timeline-validity" style="width: ${percentage}%"></div>
  </div>`;
}
