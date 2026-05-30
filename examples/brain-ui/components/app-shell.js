// examples/brain-ui/components/app-shell.js
// Main SPA orchestrator: loads data, routes, handles search, manages sidebar.

import { parseRoute, onRouteChange, isCodeNeuronType } from '../lib/router.js';
import { fetchNotes, fetchTree } from '../lib/api-client.js';
import { renderHome, getAllNotes } from './home-view.js';
import { renderTopic } from './topic-view.js';
import { renderNote } from './note-view.js';
import { renderWiki } from './wiki-view.js';
import { renderSearch } from './search-view.js';
import { renderStats } from './stats-view.js';
import { renderTimeline } from './timeline-view.js';
import { escapeHtml, formatDate } from './shared.js';

/** @type {Array} */
let notes = [];

/** @type {object|null} */
let tree = null;

/**
 * Build a recursive tree from a flat notes array.
 * Each node: { children: Map<string, node>, notes: [] }
 * @param {Array} noteList
 * @returns {object}
 */
function buildTree(noteList) {
  const root = { children: new Map(), notes: [] };

  for (const note of noteList) {
    const parts = (note.topic || '_uncategorized').split('/').filter(Boolean);
    let node = root;

    for (const part of parts) {
      if (!node.children.has(part)) {
        node.children.set(part, { children: new Map(), notes: [] });
      }
      node = node.children.get(part);
    }

    node.notes.push(note);
  }

  return root;
}

/**
 * Count all notes under a tree node (recursive).
 * @param {object} node
 * @returns {number}
 */
function countNotes(node) {
  let count = node.notes.length;
  for (const child of node.children.values()) {
    count += countNotes(child);
  }
  return count;
}

/**
 * Persistent folder-tree data from /_api/tree.
 * @type {{ projects: Array }|null}
 */
let sidebarTreeData = null;

/**
 * Fetch and cache the sidebar tree data from /_api/tree.
 * @returns {Promise<{ projects: Array }>}
 */
async function loadSidebarTree() {
  if (sidebarTreeData) return sidebarTreeData;
  try {
    const data = await fetchTree();
    sidebarTreeData = data;
    return data;
  } catch {
    return { projects: [] };
  }
}

/**
 * Render the unified collapsible folder-tree sidebar.
 * Structure: project (aggregate root) → modules/sub-aggregates → files (file-neurons).
 * Each node is a link; folders expand/collapse. Current page is highlighted.
 * @param {string} activeNoteId — the currently viewed note ID (for highlight)
 */
function renderSidebar(activeNoteId) {
  const container = document.getElementById('project-tree');
  if (!container) return;

  if (!sidebarTreeData || sidebarTreeData.projects.length === 0) {
    container.innerHTML = '<p class="sidebar-loading">Loading tree…</p>';
    // Attempt load then re-render
    loadSidebarTree().then(() => renderSidebar(activeNoteId));
    return;
  }

  container.innerHTML = '';

  const { projects } = sidebarTreeData;

  if (projects.length === 0) {
    container.innerHTML = '<p class="sidebar-loading">No projects found.</p>';
    return;
  }

  for (const project of projects) {
    container.appendChild(buildFolderNode(project, activeNoteId, 0));
  }
}

/**
 * Recursively build a collapsible folder/file tree node.
 * @param {{ id: string, label: string, noteId: string|null, type: string, children?: Array }} node
 * @param {string} activeNoteId
 * @param {number} depth
 * @returns {HTMLElement}
 */
function buildFolderNode(node, activeNoteId, depth) {
  const hasChildren = Array.isArray(node.children) && node.children.length > 0;
  const isFile = node.type === 'file-neuron';
  const isActive = activeNoteId && node.noteId && node.noteId === activeNoteId;

  // Determine if any descendant is active (to auto-expand)
  const descendantActive = hasChildren && nodeContainsActive(node, activeNoteId);
  const shouldExpand = depth === 0 || isActive || descendantActive;

  const wrapper = document.createElement('div');
  wrapper.className = 'tree-node' + (isFile ? ' tree-file' : ' tree-folder');
  wrapper.style.paddingLeft = depth > 0 ? `${depth * 14}px` : '0';

  if (hasChildren) {
    // Folder node: clickable toggle + optional link if it has a noteId
    const rowEl = document.createElement('div');
    rowEl.className = 'tree-node-label tree-folder-label' + (isActive ? ' active' : '');
    rowEl.setAttribute('role', 'button');
    rowEl.setAttribute('tabindex', '0');
    rowEl.setAttribute('aria-expanded', String(shouldExpand));

    const toggle = document.createElement('span');
    toggle.className = 'tree-toggle' + (shouldExpand ? ' open' : '');
    toggle.textContent = '▶';
    toggle.setAttribute('aria-hidden', 'true');
    rowEl.appendChild(toggle);

    if (node.noteId) {
      // Folder is also a navigable link
      const nameLink = document.createElement('a');
      nameLink.className = 'tree-node-name tree-folder-link';
      nameLink.href = `#/wiki/${encodeURIComponent(node.noteId)}`;
      nameLink.textContent = node.label;
      nameLink.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        location.hash = `#/wiki/${encodeURIComponent(node.noteId)}`;
      });
      rowEl.appendChild(nameLink);
    } else {
      const nameSpan = document.createElement('span');
      nameSpan.className = 'tree-node-name';
      nameSpan.textContent = node.label;
      rowEl.appendChild(nameSpan);
    }

    const countSpan = document.createElement('span');
    countSpan.className = 'tree-node-count';
    countSpan.textContent = node.children.length;
    rowEl.appendChild(countSpan);

    wrapper.appendChild(rowEl);

    const childrenEl = document.createElement('div');
    childrenEl.className = 'tree-children' + (shouldExpand ? '' : ' collapsed');
    childrenEl.setAttribute('role', 'group');

    for (const child of node.children) {
      childrenEl.appendChild(buildFolderNode(child, activeNoteId, depth + 1));
    }

    wrapper.appendChild(childrenEl);

    // Toggle collapse/expand on row click (but not on the name link)
    rowEl.addEventListener('click', (e) => {
      if (e.target && e.target.tagName === 'A') return;
      const isCollapsed = childrenEl.classList.contains('collapsed');
      childrenEl.classList.toggle('collapsed', !isCollapsed);
      toggle.classList.toggle('open', isCollapsed);
      rowEl.setAttribute('aria-expanded', String(isCollapsed));
    });

    rowEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        rowEl.click();
      }
    });
  } else {
    // Leaf node (file or module without children)
    const linkEl = document.createElement('a');
    linkEl.className = 'tree-node-label tree-file-label' + (isActive ? ' active' : '');
    linkEl.setAttribute('role', 'treeitem');

    if (node.noteId) {
      linkEl.href = `#/wiki/${encodeURIComponent(node.noteId)}`;
      linkEl.addEventListener('click', (e) => {
        e.preventDefault();
        location.hash = `#/wiki/${encodeURIComponent(node.noteId)}`;
      });
    } else {
      linkEl.href = '#';
      linkEl.setAttribute('aria-disabled', 'true');
    }

    const spacer = document.createElement('span');
    spacer.className = 'tree-toggle';
    spacer.setAttribute('aria-hidden', 'true');
    linkEl.appendChild(spacer);

    const nameSpan = document.createElement('span');
    nameSpan.className = 'tree-node-name';
    nameSpan.textContent = node.label;
    nameSpan.setAttribute('title', node.label);
    linkEl.appendChild(nameSpan);

    wrapper.appendChild(linkEl);
  }

  return wrapper;
}

/**
 * Check if any descendant of a tree node matches the active note ID.
 * @param {{ children?: Array, noteId?: string }} node
 * @param {string} activeNoteId
 * @returns {boolean}
 */
function nodeContainsActive(node, activeNoteId) {
  if (!activeNoteId) return false;
  if (!node.children) return false;
  for (const child of node.children) {
    if (child.noteId === activeNoteId) return true;
    if (nodeContainsActive(child, activeNoteId)) return true;
  }
  return false;
}

/**
 * Extract the active note ID from a route object, for sidebar highlighting.
 * @param {object} route
 * @returns {string}
 */
function getActiveNoteId(route) {
  switch (route.view) {
    case 'note':
    case 'wiki':
      return route.params.id || '';
    default:
      return '';
  }
}

/**
 * Inject TOC and infobox from article into the right #meta sidebar.
 * Attaches scroll-based navigation to TOC links in the clone.
 * @param {Element} contentEl
 */
function syncMetaSidebar(contentEl) {
  const meta = document.getElementById('meta');
  if (!meta) return;

  meta.innerHTML = '';

  // Extract TOC from article — generateTOC now produces <nav class="toc">
  const toc = contentEl.querySelector('nav.toc');
  if (toc) {
    const tocClone = toc.cloneNode(true);
    tocClone.style.cssText = '';
    // Wire click handlers: smooth scroll to section in main content
    const cloneLinks = tocClone.querySelectorAll('a[href^="#"]');
    for (const link of cloneLinks) {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const targetId = link.getAttribute('href')?.slice(1);
        if (!targetId) return;
        const target = document.getElementById(targetId);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    }
    meta.appendChild(tocClone);
  }

  // Extract infobox from article
  const infobox = contentEl.querySelector('.infobox');
  if (infobox) {
    const clone = infobox.cloneNode(true);
    clone.style.cssText = '';
    meta.appendChild(clone);
  }
}

/**
 * Update footer stats count.
 * @param {Array} noteList
 */
function updateFooterStats(noteList) {
  const el = document.getElementById('footer-stats');
  if (el) el.textContent = `${noteList.length} notes`;
}

/**
 * Route to the appropriate view component based on current hash.
 * @param {object} route — result of parseRoute()
 * @param {Element} main — main content container
 * @returns {Promise<void>}
 */
async function dispatch(route, main) {
  // Update active link in top nav
  const navLinks = document.querySelectorAll('.top-nav a');
  for (const link of navLinks) {
    link.classList.remove('active');
  }
  if (route.view === 'home') {
    document.getElementById('nav-home')?.classList.add('active');
  } else if (route.view === 'stats') {
    document.getElementById('nav-stats')?.classList.add('active');
  } else if (route.view === 'timeline') {
    document.getElementById('nav-timeline')?.classList.add('active');
  }

  // Update sidebar active state
  const activeNoteId = getActiveNoteId(route);
  renderSidebar(activeNoteId);

  // Clear right meta sidebar
  const meta = document.getElementById('meta');
  if (meta) meta.innerHTML = '';

  switch (route.view) {
    case 'home':
      await renderHome(main, { notes, tree });
      break;

    case 'topic':
      await renderTopic(main, { pathParts: route.params.path, tree });
      break;

    case 'note': {
      // Redirect #/note/<id> to #/wiki/<id> — unified route, never produces dead links.
      // The wiki renderer handles ALL neuron types via /_api/note/:id.
      const noteId = route.params.id;
      if (noteId) {
        location.replace(`#/wiki/${encodeURIComponent(noteId)}`);
        return;
      }
      main.innerHTML = '<div class="empty-state"><h2>Note not found</h2></div>';
      break;
    }

    case 'wiki': {
      // #/wiki/<id> — works for any neuron type
      const wikiNote = notes.find(n => n.id === route.params.id);
      await renderWiki(main, { note: wikiNote, notes });
      break;
    }

    case 'search':
      await renderSearch(main, { query: route.params.query, notes });
      break;

    case 'stats':
      renderStats(main, { notes });
      break;

    case 'timeline':
      renderTimeline(main, { notes });
      break;

    case 'browse':
      renderBrowseAll(main, notes);
      break;

    default:
      main.innerHTML = '<div class="empty-state"><h2>Not found</h2></div>';
  }

  // After content renders, extract TOC + infobox into meta sidebar
  syncMetaSidebar(main);

  // Scroll content area to top on navigation
  main.scrollTop = 0;
  window.scrollTo(0, 0);
}

/**
 * Render all notes alphabetically.
 * @param {Element} main
 * @param {Array} noteList
 */
function renderBrowseAll(main, noteList) {
  const sorted = [...noteList].sort((a, b) =>
    (a.title || a.id).toLowerCase().localeCompare((b.title || b.id).toLowerCase())
  );

  const items = sorted.map(note => {
    const cls = (note.type || '').toLowerCase();
    return `<li onclick="location.hash='#/wiki/${encodeURIComponent(note.id)}'" style="break-inside: avoid;">
      <span class="type-badge ${cls}">${(note.type || '?').slice(0, 3).toUpperCase()}</span>
      ${escapeHtml(note.title || note.id)}
      <span class="note-date">${formatDate(note.created)}</span>
    </li>`;
  }).join('');

  main.innerHTML = `<div>
    <nav aria-label="breadcrumb" style="margin-bottom:16px; font-size:13px;">
      <ol class="breadcrumb">
        <li><a href="#/" onclick="event.preventDefault(); location.hash='#/'">LazyBrain</a></li>
        <li><strong>All articles</strong></li>
      </ol>
    </nav>
    <h1>All articles (${noteList.length})</h1>
    <ul class="note-list" style="columns: 2; column-gap: 32px;">${items}</ul>
  </div>`;
}

/**
 * Attach the search input and button handlers.
 * @param {Element} main
 */
function attachSearch(main) {
  const input = document.getElementById('search-input');
  const btn = document.getElementById('search-btn');
  if (!input) return;

  let debounceTimer = null;

  const doSearch = (q) => {
    if (!q || q.trim().length === 0) {
      dispatch(parseRoute(), main);
      return;
    }
    renderSearch(main, { query: q.trim(), notes });
  };

  input.addEventListener('input', (e) => {
    clearTimeout(debounceTimer);
    const q = e.target.value.trim();
    if (q.length === 0) {
      dispatch(parseRoute(), main);
      return;
    }
    debounceTimer = setTimeout(() => doSearch(q), 220);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(debounceTimer);
      doSearch(input.value.trim());
    }
  });

  btn?.addEventListener('click', () => {
    clearTimeout(debounceTimer);
    doSearch(input.value.trim());
  });
}

/**
 * Attach sidebar toggle for mobile.
 */
function attachSidebarToggle() {
  const toggle = document.getElementById('sidebar-toggle');
  const sidebar = document.getElementById('sidebar');
  if (!toggle || !sidebar) return;

  toggle.addEventListener('click', () => {
    const isOpen = sidebar.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(isOpen));
  });

  // Close sidebar when clicking outside on mobile
  document.addEventListener('click', (e) => {
    if (
      sidebar.classList.contains('open') &&
      !sidebar.contains(e.target) &&
      e.target !== toggle
    ) {
      sidebar.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
    }
  });
}

/**
 * Initialize the SPA: fetch notes, build tree, start routing.
 * @returns {Promise<void>}
 */
export async function initApp() {
  const main = document.getElementById('content');

  if (!main) {
    console.error('[app-shell] No #content element found');
    return;
  }

  attachSidebarToggle();

  try {
    const [allNotes] = await Promise.all([
      fetchNotes(),
      loadSidebarTree(),
    ]);
    const SYNTH_TYPES = ['topic-overview', 'project-summary', 'brain-index'];
    notes = allNotes.filter(n => !SYNTH_TYPES.includes(n.type));
    tree = buildTree(notes);
    updateFooterStats(notes);
    renderSidebar('');
  } catch (err) {
    main.innerHTML = `<div class="empty-state">
      <h2>Failed to load notes</h2>
      <p>${err.message}</p>
    </div>`;
    return;
  }

  attachSearch(main);
  onRouteChange((route) => dispatch(route, main));
}
