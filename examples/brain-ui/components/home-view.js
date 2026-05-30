// examples/brain-ui/components/home-view.js
// Home page: Wikipedia-style main page with welcome box, project cards, recent activity, key decisions.

import { escapeHtml, formatDate, sanitizeHtml, convertInternalLinks, enrichHtmlContent, attachWikiLinkHandlers, activateStickyToc } from './shared.js';
import { fetchBrainIndex } from '../lib/api-client.js';

const SYNTH_TYPES = ['topic-overview', 'project-summary', 'brain-index'];

/**
 * Render the home page into container — Wikipedia-style main page.
 * Attempts to load the brain-index synthesis article as primary content.
 * Falls back to project cards + activity if no synthesis exists.
 * @param {Element} container
 * @param {{ notes: Array, tree: object }} data
 */
export async function renderHome(container, { notes, tree }) {
  const allNotes = getAllNotes(tree);
  container.innerHTML = '<div class="loading">Loading...</div>';

  // Attempt to load brain-index synthesis article
  let synthHtml = null;
  try {
    synthHtml = await fetchBrainIndex();
  } catch (_err) {
    // Non-fatal: fall back to original layout
  }

  if (synthHtml) {
    const clean = convertInternalLinks(sanitizeHtml(synthHtml));
    const wrapper = document.createElement('div');
    wrapper.className = 'wiki-article synthesis-content';
    wrapper.innerHTML = clean;
    enrichHtmlContent(wrapper);

    container.innerHTML = '';
    container.appendChild(wrapper);
    attachWikiLinkHandlers(wrapper);
    activateStickyToc(wrapper);

    // Append utility links at the bottom
    const footer = document.createElement('div');
    footer.innerHTML = buildBrowseAllLink();
    container.appendChild(footer);
    return;
  }

  // Fallback: original dashboard layout
  const recentHtml = buildRecentActivity(allNotes);
  const decisionsHtml = buildKeyDecisions(allNotes);
  const bottomRow = (recentHtml || decisionsHtml)
    ? `<div class="wiki-two-col">${recentHtml}${decisionsHtml}</div>`
    : '';

  const sections = [
    buildWelcomeBox(allNotes, tree),
    buildProjectsSection(allNotes, tree),
    bottomRow,
    buildBrowseAllLink(),
  ].join('');

  container.innerHTML = `<div class="wiki-main-page">${sections}</div>`;
}

// --- Welcome box ----------------------------------------------------------

function buildWelcomeBox(allNotes, tree) {
  const projectCount = [...tree.children.keys()].filter(k => !k.startsWith('_')).length;
  const decisionCount = allNotes.filter(n => n.type === 'decision').length;

  const topicNames = [...tree.children.keys()]
    .filter(k => !k.startsWith('_'))
    .join(', ');

  return `<div class="wiki-welcome">
    <h1 class="wiki-welcome-title">Welcome to LazyBrain</h1>
    <p class="wiki-welcome-lead">
      This brain contains <strong>${allNotes.length} notes</strong> across
      <strong>${projectCount} projects</strong> and
      <strong>${decisionCount} decisions</strong>.
    </p>
    <p class="wiki-welcome-topics">Covers: ${escapeHtml(topicNames)}</p>
  </div>`;
}

// --- Projects section (code-first: aggregate neurons + file neurons) ------

/**
 * Build the projects section, foregrounding code-first neurons.
 * For each project with aggregate-neurons, shows a code module card grid.
 * Falls back to topic-based cards for projects without aggregates.
 * @param {Array} allNotes
 * @param {object} tree
 * @returns {string}
 */
function buildProjectsSection(allNotes, tree) {
  const aggregates = allNotes.filter(n => n.type === 'aggregate-neuron');
  const fileNeurons = allNotes.filter(n => n.type === 'file-neuron');

  // Group aggregates by project (first segment of topic)
  const aggByProject = new Map();
  for (const n of aggregates) {
    const project = (n.topic || '').split('/')[0] || '_unknown';
    if (!aggByProject.has(project)) aggByProject.set(project, []);
    aggByProject.get(project).push(n);
  }

  // Group file neurons by project
  const filesByProject = new Map();
  for (const n of fileNeurons) {
    const project = (n.topic || '').split('/')[0] || '_unknown';
    if (!filesByProject.has(project)) filesByProject.set(project, []);
    filesByProject.get(project).push(n);
  }

  // Collect all project names
  const topicProjects = [...tree.children.keys()].filter(k => !k.startsWith('_'));
  const allProjects = new Set([...topicProjects, ...aggByProject.keys()]);

  if (allProjects.size === 0) return '';

  const sortedProjects = [...allProjects].sort((a, b) => {
    const aAggs = (aggByProject.get(a) || []).length;
    const bAggs = (aggByProject.get(b) || []).length;
    if (aAggs !== bAggs) return bAggs - aAggs; // projects with code neurons first
    return a.localeCompare(b);
  });

  const cards = sortedProjects.map(name => {
    const projectAggs = aggByProject.get(name) || [];
    const projectFiles = filesByProject.get(name) || [];
    const treeNode = tree.children.get(name);
    const topicNoteCount = treeNode ? getAllNotesUnder(treeNode).length : 0;

    const hasCodeNeurons = projectAggs.length > 0 || projectFiles.length > 0;

    // Build subtitle
    const subtitleParts = [];
    if (projectAggs.length > 0) subtitleParts.push(`${projectAggs.length} module${projectAggs.length !== 1 ? 's' : ''}`);
    if (projectFiles.length > 0) subtitleParts.push(`${projectFiles.length} file${projectFiles.length !== 1 ? 's' : ''}`);
    if (topicNoteCount > 0 && !hasCodeNeurons) subtitleParts.push(`${topicNoteCount} note${topicNoteCount !== 1 ? 's' : ''}`);
    const subtitle = subtitleParts.join(' · ');

    // Top-level aggregate for this project (shortest topic path)
    const rootAgg = projectAggs
      .slice()
      .sort((a, b) => (a.topic || '').split('/').length - (b.topic || '').split('/').length)[0];

    const href = rootAgg
      ? `#/wiki/${encodeURIComponent(rootAgg.id)}`
      : `#/${escapeHtml(name)}`;
    const onclick = rootAgg
      ? `event.preventDefault(); location.hash='#/wiki/${encodeURIComponent(rootAgg.id)}'`
      : `event.preventDefault(); location.hash='#/${escapeHtml(name)}'`;

    const codeBadge = hasCodeNeurons
      ? `<span class="project-code-badge">code</span>`
      : '';

    return `<article class="project-card${hasCodeNeurons ? ' project-card--code' : ''}">
      <a href="${href}" onclick="${onclick}">
        <header class="project-card-header">
          <h3 class="project-card-title">${escapeHtml(name)}</h3>
          ${codeBadge}
        </header>
        <div class="project-card-count">${subtitle}</div>
      </a>
    </article>`;
  }).join('');

  return `<section class="wiki-section">
    <h2 class="wiki-section-title">Projects</h2>
    <div class="projects-grid">${cards}</div>
  </section>`;
}

function getTypeSummary(noteList) {
  const dist = {};
  for (const n of noteList) {
    const t = n.type || 'other';
    dist[t] = (dist[t] || 0) + 1;
  }

  return Object.entries(dist)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([t, count]) => `<span class="type-badge ${t}">${count} ${t}</span>`)
    .join('');
}

// --- Recent activity ------------------------------------------------------

function buildRecentActivity(allNotes) {
  const recent = [...allNotes]
    .filter(n => n.created)
    .sort((a, b) => (b.created || '').localeCompare(a.created || ''))
    .slice(0, 10);

  if (recent.length === 0) return '';

  const items = recent.map(note => {
    const cls = (note.type || '').toLowerCase();
    const topic = note.topic ? `<span class="activity-topic">${escapeHtml(note.topic)}</span>` : '';
    return `<li class="activity-item" onclick="location.hash='#/note/${escapeHtml(note.id)}'">
      <span class="activity-date">${formatDate(note.created)}</span>
      <span class="type-badge ${cls}">${(note.type || '?').slice(0, 3).toUpperCase()}</span>
      <span class="activity-title">${escapeHtml(note.title || note.id)}</span>
      ${topic}
    </li>`;
  }).join('');

  return `<section class="wiki-section wiki-section-half">
    <h2 class="wiki-section-title">Recent Activity</h2>
    <ul class="activity-list">${items}</ul>
  </section>`;
}

// --- Key decisions --------------------------------------------------------

function buildKeyDecisions(allNotes) {
  const decisions = allNotes
    .filter(n => n.type === 'decision')
    .sort((a, b) => {
      const ia = parseFloat(a.importance || '0');
      const ib = parseFloat(b.importance || '0');
      if (ia !== ib) return ib - ia;
      return (b.created || '').localeCompare(a.created || '');
    })
    .slice(0, 5);

  if (decisions.length === 0) return '';

  const items = decisions.map(note => {
    const topic = note.topic ? `<span class="activity-topic">${escapeHtml(note.topic)}</span>` : '';
    return `<li class="activity-item" onclick="location.hash='#/note/${escapeHtml(note.id)}'">
      <span class="type-badge decision">DEC</span>
      <span class="activity-title">${escapeHtml(note.title || note.id)}</span>
      ${topic}
    </li>`;
  }).join('');

  return `<section class="wiki-section wiki-section-half">
    <h2 class="wiki-section-title">Key Decisions</h2>
    <ul class="activity-list">${items}</ul>
  </section>`;
}

// --- Browse all link ------------------------------------------------------

function buildBrowseAllLink() {
  return `<div class="browse-all-bar">
    <a href="#/browse" onclick="event.preventDefault(); location.hash='#/browse'" class="browse-all-link">
      Browse all notes A–Z
    </a>
    <span class="browse-all-sep">|</span>
    <a href="#/stats" onclick="event.preventDefault(); location.hash='#/stats'" class="browse-all-link">
      Stats &amp; analytics
    </a>
    <span class="browse-all-sep">|</span>
    <a href="#/timeline" onclick="event.preventDefault(); location.hash='#/timeline'" class="browse-all-link">
      Timeline
    </a>
  </div>`;
}

// --- Shared tree helpers (exported for topic-view) ------------------------

export function getAllNotes(tree) {
  const result = [...tree.notes];
  for (const child of tree.children.values()) {
    result.push(...getAllNotesUnder(child));
  }
  return result;
}

function getAllNotesUnder(node) {
  const result = [...node.notes];
  for (const child of node.children.values()) {
    result.push(...getAllNotesUnder(child));
  }
  return result;
}

export function getNotesUnder(tree, pathParts) {
  let node = tree;
  for (const part of pathParts) {
    if (!node.children.has(part)) return [];
    node = node.children.get(part);
  }
  return getAllNotesUnder(node);
}

export function buildSubtopicGrid(pathParts, node, tree) {
  if (node.children.size === 0) return '';

  const sorted = [...node.children.entries()]
    .filter(([name]) => !name.startsWith('_'))
    .sort((a, b) => {
      const aCount = getNotesUnder(tree, [...pathParts, a[0]]).length;
      const bCount = getNotesUnder(tree, [...pathParts, b[0]]).length;
      return bCount - aCount;
    });

  const cards = sorted.map(([name]) => {
    const childNotes = getNotesUnder(tree, [...pathParts, name]);
    const path = [...pathParts, name].join('/');
    const typeDist = buildTypeDistribution(childNotes);

    return `<article class="topic-card">
      <a href="#/${path}" onclick="event.preventDefault(); location.hash='#/${path}'">
        <header><h2 class="card-title">${escapeHtml(name)}</h2></header>
        <div class="card-count">${childNotes.length} notes</div>
        ${typeDist}
      </a>
    </article>`;
  }).join('');

  return `<h2>Sub-topics</h2><div class="grid">${cards}</div>`;
}

function buildTypeDistribution(childNotes) {
  const dist = {};
  for (const n of childNotes) {
    const t = n.type || 'other';
    dist[t] = (dist[t] || 0) + 1;
  }
  return Object.entries(dist).map(([t, count]) =>
    `<div style="font-size: 12px; color: #666; margin-top: 4px;"><span class="type-badge ${t}">${count} ${t}${count !== 1 ? 's' : ''}</span></div>`
  ).join('');
}

export function buildNotesByType(notesToShow, isLeaf, allNotes) {
  const source = isLeaf ? allNotes : notesToShow;
  if (source.length === 0) return '';

  const byType = { decision: [], reference: [], episodic: [], concept: [], other: [] };
  for (const n of source) {
    const bucket = byType[n.type] || byType.other;
    bucket.push(n);
  }

  const typeLabels = {
    decision: 'Decisions',
    reference: 'References',
    episodic: 'History',
    concept: 'Concepts',
    procedural: 'Procedures',
    integration: 'Integrations',
    other: 'Notes'
  };

  return Object.entries(byType)
    .filter(([, typeNotes]) => typeNotes.length > 0)
    .map(([type, typeNotes]) => {
      const label = typeLabels[type] || 'Notes';
      const sorted = [...typeNotes].sort((a, b) => {
        const ia = parseFloat(a.importance || '0');
        const ib = parseFloat(b.importance || '0');
        if (ia !== ib) return ib - ia;
        return (b.created || '').localeCompare(a.created || '');
      });

      const items = sorted.map(note => {
        const cls = (note.type || '').toLowerCase();
        return `<li onclick="location.hash='#/note/${escapeHtml(note.id)}'">
          <span class="type-badge ${cls}">${(note.type || '?').slice(0, 3).toUpperCase()}</span>
          ${escapeHtml(note.title || note.id)}
          <span class="note-date">${formatDate(note.created)}</span>
        </li>`;
      }).join('');

      return `<h2>${label} (${typeNotes.length})</h2><ul class="note-list">${items}</ul>`;
    }).join('');
}
