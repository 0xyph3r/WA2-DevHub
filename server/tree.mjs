// Scans a repository into a plain tree { name, path, type, size, children }.
// Zero dependencies: Node's fs only.
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep, basename } from 'node:path';

const IGNORED = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'coverage',
  'target', '.cache', '.turbo', '.vite', '__pycache__', '.venv', 'venv', '.idea', '.vscode',
  '.DS_Store', 'Thumbs.db',
]);

export const MAX_FILES = 4000;

// editor / tool temp files: foo.js.tmp.1234.abcd, foo~, .foo.swp, 4913
const TEMP_RE = /\.tmp\.[\w.-]+$|~$|^\.#|\.swp$|\.swx$|^\d+$|^sed[A-Za-z0-9]{6}$/;

export function isIgnored(name) {
  return IGNORED.has(name) || TEMP_RE.test(name);
}

/** Repo-relative path with forward slashes, or null when outside the repo. */
export function toRepoPath(root, absolute) {
  const rel = relative(root, absolute);
  if (!rel || rel.startsWith('..') || rel.includes(':')) return rel === '' ? '' : null;
  return rel.split(sep).join('/');
}

// Breadth-first: past `max` files a big repository loses its deepest files, never
// whole top-level folders. Skipped files are counted so the client can say so.
export function scanTree(root, max = MAX_FILES) {
  let count = 0, skipped = 0;
  const tree = { name: basename(root) || 'repo', path: '', type: 'dir', children: [] };
  const queue = [[tree, root]];
  for (let i = 0; i < queue.length; i++) {
    const [node, dir] = queue[i];
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (isIgnored(entry.name)) continue;
      const childPath = node.path ? `${node.path}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        const child = { name: entry.name, path: childPath, type: 'dir', children: [] };
        node.children.push(child);
        queue.push([child, join(dir, entry.name)]);
      } else if (entry.isFile()) {
        if (count >= max) { skipped++; continue; }
        let size = 0;
        try { size = statSync(join(dir, entry.name)).size; } catch {}
        node.children.push({ name: entry.name, path: childPath, type: 'file', size });
        count++;
      }
    }
  }
  tree.truncated = skipped > 0;
  tree.skipped = skipped;
  return tree;
}
