// Import graph between top-level directories (plus resolved file-level edges),
// from a cheap regex scan of source files. Zero dependencies.
import { readFileSync, statSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';

export const SOURCE = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte', '.py', '.rs']);
const RESOLVE_EXT = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts', '.json', '.vue', '.svelte'];
const MAX_FILE_EDGES = 5000;
const JS_RE = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/g;
const PY_RE = /^\s*(?:from\s+([.\w]+)\s+import|import\s+([\w.]+))/gm;
const RS_RE = /^\s*(?:pub\s+)?use\s+(crate|super|self|[A-Za-z_]\w*)/gm;
const MAX_FILES = 2500;
const MAX_SIZE = 250000;

export function flatten(tree, out = []) {
  for (const c of tree.children || []) {
    if (c.type === 'file') out.push(c);
    else flatten(c, out);
  }
  return out;
}

export function topOf(repoPath) {
  const i = repoPath.indexOf('/');
  return i < 0 ? '(racine)' : repoPath.slice(0, i);
}

/** Extracts raw import specifiers from a source text. Exported for tests. */
export function specifiers(text, ext) {
  const out = [];
  if (ext === '.py') {
    for (const m of text.matchAll(PY_RE)) out.push(m[1] || m[2]);
  } else if (ext === '.rs') {
    for (const m of text.matchAll(RS_RE)) out.push(m[1]);
  } else {
    for (const m of text.matchAll(JS_RE)) out.push(m[1] || m[2] || m[3]);
  }
  return out.filter(Boolean);
}

/**
 * Resolves a JS/TS import specifier to a repo path present in `fileSet`
 * (a Set of repo-relative paths), or null. Only relative specifiers and the
 * '@/' / '~/' / 'src/' aliases are resolved; packages are not.
 */
export function resolveImport(fromPath, spec, fileSet) {
  let base;
  if (spec.startsWith('.')) base = posix.normalize(posix.join(posix.dirname(fromPath), spec));
  else if (spec.startsWith('@/') || spec.startsWith('~/')) base = 'src/' + spec.slice(2);
  else if (spec.startsWith('src/')) base = spec;
  else return null;
  if (base.startsWith('..') || base === '.') return null;
  base = base.replace(/\/+$/, '');
  if (fileSet.has(base)) return base;
  // TS sources import siblings with a .js suffix that only exists after compilation
  const ts = base.replace(/\.(m|c)?jsx?$/, (m, pre) => `.${pre || ''}ts${m.endsWith('x') ? 'x' : ''}`);
  if (ts !== base && fileSet.has(ts)) return ts;
  for (const ext of RESOLVE_EXT) if (fileSet.has(base + ext)) return base + ext;
  for (const ext of RESOLVE_EXT) if (fileSet.has(`${base}/index${ext}`)) return `${base}/index${ext}`;
  return null;
}

export function scanDeps(root, tree) {
  const files = flatten(tree).filter(f => SOURCE.has(posix.extname(f.path)) && f.size <= MAX_SIZE).slice(0, MAX_FILES);
  const nodes = new Map();      // top dir -> { id, files, imports }
  const edges = new Map();      // "a>b" -> count
  const externals = new Map();  // package -> count
  const node = id => { if (!nodes.has(id)) nodes.set(id, { id, files: 0, imports: 0 }); return nodes.get(id); };
  const fileSet = new Set(flatten(tree).map(f => f.path));
  const fileEdges = new Set();  // "from>to" resolved file-level edges
  for (const c of tree.children || []) if (c.type === 'dir') node(c.name);
  for (const f of files) {
    const from = topOf(f.path);
    node(from).files++;
    let text = '';
    try { text = readFileSync(join(root, f.path), 'utf8'); } catch { continue; }
    const ext = posix.extname(f.path);
    for (const spec of specifiers(text, ext)) {
      node(from).imports++;
      if (ext === '.py' || ext === '.rs') {
        if (spec.startsWith('.') || spec === 'crate' || spec === 'super' || spec === 'self') continue;
        externals.set(spec.split('.')[0], (externals.get(spec.split('.')[0]) || 0) + 1);
        continue;
      }
      if (ext !== '.py' && ext !== '.rs' && fileEdges.size < MAX_FILE_EDGES) {
        const to = resolveImport(f.path, spec, fileSet);
        if (to && to !== f.path) fileEdges.add(`${f.path}>${to}`);
      }
      if (spec.startsWith('.')) {
        const target = posix.normalize(posix.join(dirname(f.path).split('\\').join('/'), spec));
        const to = target.startsWith('..') ? '(hors repo)' : topOf(target);
        if (to !== from) edges.set(`${from}>${to}`, (edges.get(`${from}>${to}`) || 0) + 1);
      } else if (spec.startsWith('@/') || spec.startsWith('~/') || spec.startsWith('src/')) {
        const to = topOf(spec.replace(/^[@~]\//, 'src/'));
        if (to !== from) edges.set(`${from}>${to}`, (edges.get(`${from}>${to}`) || 0) + 1);
      } else {
        const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        if (!pkg.startsWith('node:')) externals.set(pkg, (externals.get(pkg) || 0) + 1);
      }
    }
  }
  return {
    nodes: [...nodes.values()],
    edges: [...edges].map(([k, count]) => { const [from, to] = k.split('>'); return { from, to, count }; }),
    externals: [...externals].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([name, count]) => ({ name, count })),
    scanned: files.length,
    files: [...fileEdges].map(k => { const [from, to] = k.split('>'); return { from, to }; }),
  };
}
