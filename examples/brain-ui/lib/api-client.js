// examples/brain-ui/lib/api-client.js

const BASE = '';

export async function fetchNotes() {
  const res = await fetch(`${BASE}/_api/notes`);
  if (!res.ok) throw new Error(`Failed to fetch notes: ${res.status}`);
  return res.json();
}

/**
 * Fetch any note's HTML by its ID, resolved server-side across all stores.
 * Uses /_api/note/:id which searches indexed notes + knowledge-nodes.
 * @param {string} id — note ID (e.g. "aggregate-acme-root", "file-src-app-ts")
 * @returns {Promise<string>}
 */
export async function fetchNote(id) {
  const res = await fetch(`${BASE}/_api/note/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`Failed to fetch note ${id}: ${res.status}`);
  return res.text();
}

/**
 * Fetch the code-first folder tree for the sidebar.
 * Returns { projects: [ { id, label, noteId, type, children: [...] } ] }
 * @returns {Promise<{projects: Array}>}
 */
export async function fetchTree() {
  const res = await fetch(`${BASE}/_api/tree`);
  if (!res.ok) throw new Error(`Failed to fetch tree: ${res.status}`);
  return res.json();
}

export async function fetchBacklinks(id) {
  const res = await fetch(`${BASE}/_api/notes/${id}/backlinks`);
  if (!res.ok) return [];
  return res.json();
}

export async function fetchNeighbors(id) {
  const res = await fetch(`${BASE}/_api/notes/${id}/neighbors`);
  if (!res.ok) return { inbound: [], outbound: [] };
  return res.json();
}

export async function searchNotes(query, top = 10) {
  const res = await fetch(`${BASE}/_api/search?q=${encodeURIComponent(query)}&top=${top}`);
  if (!res.ok) throw new Error(`Search failed: ${res.status}`);
  return res.json();
}

export async function fetchGraph() {
  const res = await fetch(`${BASE}/_api/graph`);
  if (!res.ok) throw new Error(`Graph failed: ${res.status}`);
  return res.json();
}

export async function fetchTopicStats(topicPath) {
  const res = await fetch(`${BASE}/_api/topics/${encodeURIComponent(topicPath)}`);
  if (!res.ok) return null;
  return res.json();
}

export async function fetchSynthesis(topic) {
  const res = await fetch(`${BASE}/_api/synthesis/${encodeURIComponent(topic)}`);
  if (!res.ok) return null;
  return res.text();
}

export async function fetchBrainIndex() {
  const res = await fetch(`${BASE}/_api/synthesis/index`);
  if (!res.ok) return null;
  return res.text();
}

/**
 * Fetch a note's raw HTML by its file path relative to brain root.
 * Used for file-neuron, aggregate-neuron, concept neurons.
 * @param {string} notePath — e.g. "notes/2026-05/file-xxx.html"
 * @returns {Promise<string|null>}
 */
export async function fetchNoteByPath(notePath) {
  const res = await fetch(`${BASE}/${notePath}`);
  if (!res.ok) return null;
  return res.text();
}

/**
 * Resolve a legacy href like "file:<relative-path>" to a note ID.
 * The server looks up the note by the data-code-file attribute match.
 * @param {string} href — e.g. "file:docs/archive/legacy-dashboard/charts.js"
 * @returns {Promise<{id: string, path: string}|null>}
 */
export async function resolveHref(href) {
  const res = await fetch(`${BASE}/_api/resolve?href=${encodeURIComponent(href)}`);
  if (!res.ok) return null;
  return res.json();
}
