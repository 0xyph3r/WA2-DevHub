#!/usr/bin/env node
// WA2 server: zero-dependency Node HTTP server.
//   - serves the web interface from ../client
//   - watches the repository and streams file changes (SSE at /events)
//   - receives agent/tool/task events from the Claude Code hooks module (POST /api/event)
//   - exposes the tree, git state, dependencies, files, symbols, references and config as JSON
//
// Usage: node server/index.mjs --repo <path> [--port 4242] [--app http://localhost:3000] [--open]
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, watch, writeFileSync, realpathSync } from 'node:fs';
import { join, extname, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { parseMergeTree, parseWorktrees, branchHealth } from './health.mjs';
import os from 'node:os';
import { scanTree, toRepoPath, isIgnored } from './tree.mjs';
import { normalizeEvent, classifyCommand } from './events.mjs';
import { scanDeps, SOURCE, flatten } from './deps.mjs';
import { symbolsOf } from './symbols.mjs';
import { createControl, GATES } from './control.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(here, '..', 'client');

// ---------- CLI ----------
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const REPO = resolve(opt('repo', process.cwd()));
const PORT = Number(opt('port', process.env.WA2_PORT || 4242));
const OPEN = args.includes('--open');
const CONFIG_FILE = join(REPO, '.wa2.json');

const config = loadConfig();
/** The app URL ends up in an iframe/link in the client: accept http(s) only. */
const safeHttpUrl = v => { try { const u = new URL(String(v || '')); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch { return ''; } };
config.app = safeHttpUrl(config.app);
if (!GATES.includes(config.gate)) config.gate = 'off';
if (opt('app')) config.app = safeHttpUrl(opt('app'));
function loadConfig() {
  try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); } catch { return { app: '', name: '' }; }
}
function saveConfig() {
  try { writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n'); } catch {}
}
function readVersion() {
  try { return JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version || ''; } catch { return ''; }
}

// ---------- state ----------
let tree = scanTree(REPO);
const history = [];            // last events, replayed to new clients
const HISTORY = 300;
const clients = new Set();     // SSE responses
const agents = new Map();      // `${session}:${agent}` -> agent record
const tasks = new Map();       // id -> { id, subject, status, session, agent, at }
const metrics = { build: null, test: null, coverage: null };
const control = createControl();
const agentsSnapshot = () => [...agents.values()].map(a => ({ ...a, stopped: control.isStopped(a.session, a.agent) }));

function hello() {
  return { type: 'hello', repo: REPO, name: config.name || tree.name, app: config.app || '', gate: config.gate, version: readVersion(), at: Date.now() };
}
function readCoverage() {
  for (const p of ['coverage/coverage-summary.json', 'coverage/lcov-report/coverage-summary.json']) {
    try {
      const total = JSON.parse(readFileSync(join(REPO, p), 'utf8')).total;
      const pct = total?.lines?.pct ?? total?.statements?.pct;
      if (typeof pct === 'number') return { pct, at: statSync(join(REPO, p)).mtimeMs };
    } catch {}
  }
  return null;
}
metrics.coverage = readCoverage();

function broadcast(event) {
  const e = normalizeEvent(event);
  if (!e) return;
  if (['tool', 'agent', 'fs', 'task'].includes(e.type)) { history.push(e); if (history.length > HISTORY) history.shift(); }
  const line = `data: ${JSON.stringify(e)}\n\n`;
  for (const res of clients) res.write(line);
}

function agentOf(e) {
  const key = `${e.session}:${e.agent}`;
  let a = agents.get(key);
  if (!a) {
    a = { key, agent: e.agent, session: e.session, calls: 0, description: e.agent === 'main' ? 'Main session' : '', agentType: e.agent === 'main' ? 'main' : '', status: 'active', lastAt: e.at, firstAt: e.at };
    agents.set(key, a);
  }
  return a;
}
function trackAgent(e) {
  if (e.type === 'agent') {
    const a = agentOf(e);
    if (e.provider) a.provider = e.provider;
    if (e.description) a.description = e.description;
    if (e.agentType) a.agentType = e.agentType;
    if (e.root) { a.root = e.root; refreshBranch(a); }
    a.lastAt = e.at; a.status = e.phase === 'done' ? 'idle' : 'active';
  } else if (e.type === 'tool') {
    const a = agentOf(e);
    if (e.provider) a.provider = e.provider;
    if (e.root) { a.root = e.root; refreshBranch(a); }
    if (e.phase === 'start') a.calls++;
    a.lastAt = e.at; a.status = 'active'; a.tool = e.tool; a.phase = e.phase; if (e.file) a.file = e.file; if (e.detail) a.detail = e.detail;
    if (e.phase === 'end' && e.tool === 'Bash') {
      const kind = classifyCommand(e.detail);
      if (kind) { metrics[kind] = { ok: !e.isError, durationMs: e.durationMs ?? null, at: e.at, command: e.detail }; broadcast({ type: 'metric', metrics }); }
    }
  }
}
// ---------- per-session branch ----------
// `git rev-parse --abbrev-ref HEAD` in the session's working directory, cached
// 10 s per root. Runs off the event path; a change rebroadcasts the agents snapshot.
const BRANCH_TTL = 10000;
const branchCache = new Map();  // root -> { branch, at, pending: Promise|null }
function branchOf(root) {
  let c = branchCache.get(root);
  if (c && c.pending) return c.pending;
  if (c && Date.now() - c.at < BRANCH_TTL) return Promise.resolve(c.branch);
  if (!c) { c = { branch: '', at: 0, pending: null }; branchCache.set(root, c); }
  c.pending = new Promise(res => {
    execFile('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5000, windowsHide: true }, (err, out) => {
      c.branch = err ? '' : String(out).trim();
      c.at = Date.now(); c.pending = null;
      res(c.branch);
    });
  });
  return c.pending;
}
function refreshBranch(a) {
  const root = a.root;
  branchOf(root).then(branch => {
    if (a.root !== root || branch === a.branch) return;
    a.branch = branch;
    broadcast({ type: 'agents', agents: agentsSnapshot() });
  }).catch(() => {});
}

function trackTask(e) {
  if (e.kind === 'todos' && Array.isArray(e.todos)) {
    for (const [k, t] of tasks) if (t.session === e.session && t.source === 'todos') tasks.delete(k);
    e.todos.forEach((t, i) => tasks.set(`${e.session}:todo:${i}`, { id: `${e.session}:todo:${i}`, subject: t.content || t.activeForm || '', status: t.status || 'pending', session: e.session, agent: e.agent, source: 'todos', at: e.at }));
  } else if (e.kind === 'create' && e.subject) {
    const id = e.id || `${e.session}:${e.at}`;
    tasks.set(id, { id, subject: e.subject, status: e.status || 'pending', session: e.session, agent: e.agent, source: 'task', at: e.at });
  } else if (e.kind === 'update' && e.id) {
    const t = tasks.get(e.id) || tasks.get(`${e.session}:${e.id}`);
    if (t) { if (e.status) t.status = e.status; if (e.subject) t.subject = e.subject; t.at = e.at; }
    else tasks.set(e.id, { id: e.id, subject: e.subject || `Task ${e.id}`, status: e.status || 'pending', session: e.session, agent: e.agent, source: 'task', at: e.at });
  }
  broadcast({ type: 'tasks', tasks: [...tasks.values()] });
}

// ---------- watcher ----------
let rescan = null;
try {
  watch(REPO, { recursive: true }, (kind, filename) => {
    if (!filename) return;
    const rel = String(filename).split('\\').join('/');
    if (rel.split('/').some(isIgnored)) return;
    const abs = join(REPO, rel);
    let size = null, exists = true, isDir = false;
    try { const st = statSync(abs); size = st.size; isDir = st.isDirectory(); } catch { exists = false; }
    // a directory "change" only mirrors a change to one of its entries, which gets its own event
    if (!isDir) broadcast({ type: 'fs', kind: !exists ? 'remove' : kind, path: rel, size });
    if (rel.startsWith('coverage/')) { metrics.coverage = readCoverage(); broadcast({ type: 'metric', metrics }); }
    if (rel === '.wa2.json') { Object.assign(config, loadConfig()); broadcast(hello()); }
    clearTimeout(rescan);
    rescan = setTimeout(() => { tree = scanTree(REPO); depsCache = null; broadcast({ type: 'tree', tree }); }, 600);
  });
} catch (err) {
  console.error('[wa2] fs.watch unavailable:', err.message);
}

// ---------- git ----------
/** Like git() but keeps the exit code (merge-tree signals conflicts with exit 1). */
function gitRaw(argv) {
  return new Promise(res => execFile('git', ['-c', 'core.quotePath=false', ...argv], { cwd: REPO, maxBuffer: 8e6, windowsHide: true }, (err, out) => res({ code: err ? (typeof err.code === 'number' ? err.code : 128) : 0, out: String(out || '') })));
}
function git(argv) {
  return new Promise(res => execFile('git', ['-c', 'core.quotePath=false', ...argv], { cwd: REPO, maxBuffer: 8e6 }, (err, out) => res(err ? '' : out)));
}
async function gitState() {
  const inside = (await git(['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  if (!inside) return { repo: false, branches: [], changes: [], head: '', commits: {}, conflicts: [], merged: [], worktrees: [] };
  const [status, numstat, branchOut, current, head, worktreeOut, topOut] = await Promise.all([
    git(['status', '--porcelain']),
    git(['diff', '--numstat', 'HEAD']),
    git(['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)%09%(upstream:track)%09%(committerdate:unix)%09%(upstream:short)', 'refs/heads']),
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
    git(['rev-parse', '--short', 'HEAD']),
    git(['worktree', 'list', '--porcelain']),
    git(['rev-parse', '--show-toplevel']),
  ]);
  // Worktrees: every checkout of this repository. An agent whose session root sits
  // in one of them works on that worktree's branch (the client matches the paths).
  const top = topOut.trim().split('\\').join('/').toLowerCase();
  const worktrees = parseWorktrees(worktreeOut).filter(w => !w.bare).map(w => ({ ...w, main: w.path.toLowerCase() === top }));
  const stats = {};
  for (const line of numstat.split('\n')) {
    const [add, del, file] = line.split('\t');
    if (file) stats[file] = { add: Number(add) || 0, del: Number(del) || 0 };
  }
  const CONFLICT = new Set(['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD']);
  const conflicts = [];
  const changes = status.split('\n').filter(Boolean).map(line => {
    const raw = line.slice(0, 2);
    const code = raw.trim() || 'M';
    const file = line.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, '');
    if (CONFLICT.has(raw)) conflicts.push(file);
    return { file, status: code[0] === '?' ? 'A' : code[0], ...(stats[file] || { add: 0, del: 0 }) };
  });
  const branches = branchOut.split('\n').filter(Boolean).map(line => {
    const [name, track = '', date, upstream = ''] = line.split('\t');
    const ahead = Number((track.match(/ahead (\d+)/) || [])[1] || 0);
    const behind = Number((track.match(/behind (\d+)/) || [])[1] || 0);
    const wt = worktrees.find(w => w.branch === name && !w.main);
    return { name, ahead, behind, date: Number(date) * 1000, current: name === current.trim(), upstream: upstream.trim(), ...(wt ? { worktree: wt.path } : {}) };
  });
  const cur = current.trim();
  const names = new Set(branches.map(b => b.name));
  const base = names.has('main') ? 'main' : names.has('master') ? 'master' : names.has('develop') ? 'develop' : cur;
  // current branch and base first, then most recent: the detailed reads below are capped
  branches.sort((a, b) => (b.current - a.current) || ((b.name === base) - (a.name === base)) || (b.date - a.date));
  const commits = {};
  await Promise.all(branches.slice(0, 10).map(async b => {
    const log = await git(['log', '--format=%H%x09%h%x09%s%x09%an%x09%ct', '-n', '12', b.name, '--']);
    commits[b.name] = log.split('\n').filter(Boolean).map(line => {
      const [hash, short, subject, author, ct] = line.split('\t');
      return { hash, short, subject, author, at: Number(ct) * 1000 };
    });
  }));
  // Merged = every commit of the branch is in the base branch. Not "in HEAD": the
  // base is not "merged into" the feature branch checked out on top of it.
  const mergedBase = (await git(['branch', '--merged', base, '--format=%(refname:short)'])).split('\n').map(x => x.trim()).filter(Boolean);
  const merged = mergedBase.filter(x => x !== base);
  for (const b of branches) b.merged = merged.includes(b.name);
  // Health check per branch (git facts only): conflicts against the base branch via
  // `merge-tree` (no worktree touched), distance to base, upstream, age, worktree state.
  await Promise.all(branches.slice(0, 10).map(async b => {
    let conflictFiles, behindBase = null, aheadBase = null;
    const mergedIntoBase = b.merged;
    if (b.name !== base) {
      const [lr, mt] = await Promise.all([
        git(['rev-list', '--left-right', '--count', `${base}...${b.name}`]),
        mergedIntoBase ? Promise.resolve({ code: 0, out: '' }) : gitRaw(['merge-tree', '--write-tree', '--name-only', base, b.name]),
      ]);
      const [bb, ab] = lr.trim().split(/\s+/).map(Number);
      if (Number.isFinite(bb)) { behindBase = bb; aheadBase = ab; b.behindBase = bb; b.aheadBase = ab; }
      conflictFiles = parseMergeTree(mt.code, mt.out);
    }
    b.health = branchHealth({
      name: b.name, base, current: b.current, conflictFiles, behindBase, aheadBase, merged: mergedIntoBase, mergedInto: base,
      hasUpstream: !!b.upstream, ahead: b.ahead, behind: b.behind, date: b.date,
      changes: b.current ? changes.length : 0, worktreeConflicts: b.current ? conflicts : [],
      test: b.current ? metrics.test : null, build: b.current ? metrics.build : null,
    });
  }));
  return { repo: true, current: cur, base, branches, changes, head: head.trim(), commits, conflicts, merged, worktrees };
}

// ---------- deps ----------
let depsCache = null;
function deps() {
  if (!depsCache) depsCache = scanDeps(REPO, tree);
  return depsCache;
}

// ---------- refs ----------
const REF_EXT = new Set([...SOURCE, '.html', '.css', '.json', '.md']);
const REF_MAX_FILES = 2500;
const REF_MAX_SIZE = 250000;
/** Whole-word occurrences of `q` across the current tree's source files. */
function findRefs(q, limit) {
  const re = new RegExp(`(?<![\\w$])${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`);
  const refs = [];
  let truncated = false;
  const files = flatten(tree).filter(f => REF_EXT.has(extname(f.path).toLowerCase()) && f.size <= REF_MAX_SIZE).slice(0, REF_MAX_FILES);
  outer: for (const f of files) {
    let text;
    try { text = readFileSync(join(REPO, f.path), 'utf8'); } catch { continue; }
    if (!text.includes(q)) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      if (refs.length >= limit) { truncated = true; break outer; }
      refs.push({ file: f.path, line: i + 1, text: lines[i].trim().slice(0, 160) });
    }
  }
  return { q, refs, truncated };
}

// ---------- sys ----------
let lastCpu = os.cpus().map(c => c.times);
function sysSample() {
  const now = os.cpus().map(c => c.times);
  let idle = 0, total = 0;
  now.forEach((t, i) => {
    const p = lastCpu[i] || t;
    const di = t.idle - p.idle;
    const dt = Object.keys(t).reduce((s, k) => s + (t[k] - p[k]), 0);
    idle += di; total += dt;
  });
  lastCpu = now;
  const cpu = total > 0 ? Math.round((1 - idle / total) * 100) : 0;
  const ram = Math.round((1 - os.freemem() / os.totalmem()) * 100);
  return { type: 'sys', cpu, ram, at: Date.now() };
}
setInterval(() => { if (clients.size) broadcast(sysSample()); }, 4000).unref();

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

function json(res, body, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Same-origin only: no CORS, Host must be ours (blocks DNS rebinding), and a
// browser-originated request must come from our own origin.
const OWN_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
function allowed(req) {
  if (!OWN_HOSTS.has(req.headers.host || '')) return false;
  const origin = req.headers.origin;
  if (origin && !OWN_HOSTS.has(origin.replace(/^https?:\/\//, ''))) return false;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  return true;
}

/** Resolves `rel` inside `root` (both real paths), or null when it escapes or is missing. */
function inside(root, rel) {
  let real;
  try { real = realpathSync(resolve(root, rel)); } catch { return null; }
  const realRoot = realpathSync(root);
  return real === realRoot || real.startsWith(realRoot + sep) ? real : null;
}
function readBody(req) {
  return new Promise(res => {
    const chunks = []; let size = 0;
    req.on('data', c => { chunks.push(c); size += c.length; if (size > 2e6) req.destroy(); });
    req.on('end', () => res(Buffer.concat(chunks).toString('utf8')));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;

  if (!allowed(req)) { res.writeHead(403, { 'content-type': 'text/plain' }); return res.end('forbidden: WA2 answers its own origin only'); }

  if (path === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = e => res.write(`data: ${JSON.stringify(e)}\n\n`);
    send(hello());
    send({ type: 'tree', tree });
    send({ type: 'agents', agents: agentsSnapshot() });
    send({ type: 'approvals', approvals: control.pendingApprovals() });
    send({ type: 'collisions', collisions: control.listCollisions() });
    send({ type: 'tasks', tasks: [...tasks.values()] });
    send({ type: 'metric', metrics });
    send(sysSample());
    for (const e of history) send(e);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clients.delete(res); clearInterval(ping); });
    return;
  }

  if (path === '/api/health') return json(res, { ok: true, repo: REPO, port: PORT, clients: clients.size });
  if (path === '/api/tree') return json(res, tree);
  if (path === '/api/git') return json(res, await gitState());
  if (path === '/api/deps') return json(res, deps());
  if (path === '/api/agents') return json(res, agentsSnapshot());
  if (path === '/api/tasks') return json(res, [...tasks.values()]);
  if (path === '/api/file') {
    const rel = url.searchParams.get('path') || '';
    const abs = inside(REPO, rel);
    if (!abs || statSync(abs).isDirectory()) return json(res, { error: 'not found' }, 404);
    const st = statSync(abs);
    if (st.size > 400000) return json(res, { path: rel, size: st.size, lines: [], truncated: true });
    const text = readFileSync(abs, 'utf8');
    const lines = text.split('\n');
    return json(res, { path: rel, size: st.size, total: lines.length, lines: lines.slice(0, Number(url.searchParams.get('limit') || 400)), truncated: lines.length > 400 });
  }
  if (path === '/api/symbols') {
    const rel = url.searchParams.get('path') || '';
    const abs = inside(REPO, rel);
    if (!abs || statSync(abs).isDirectory()) return json(res, { error: 'not found' }, 404);
    const st = statSync(abs);
    if (st.size > 400000) return json(res, { path: rel, symbols: [], truncated: true });
    return json(res, { path: rel, symbols: symbolsOf(readFileSync(abs, 'utf8'), extname(abs).toLowerCase()) });
  }
  if (path === '/api/refs') {
    const q = url.searchParams.get('q') || '';
    if (q.length < 2 || q.length > 80) return json(res, { error: 'q must be 2..80 chars' }, 400);
    const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get('limit')) || 200));
    return json(res, findRefs(q, limit));
  }
  if (path === '/api/config') {
    if (req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        if ('app' in body) { const u = safeHttpUrl(body.app); if (body.app && !u) return json(res, { error: 'app must be an http(s) URL' }, 400); body.app = u; }
        if ('name' in body) body.name = String(body.name ?? '').slice(0, 120);
        if ('gate' in body && !GATES.includes(body.gate)) return json(res, { error: `gate must be one of ${GATES.join(', ')}` }, 400);
        const gateChanged = 'gate' in body && body.gate !== config.gate;
        Object.assign(config, body); saveConfig();
        if (gateChanged) flushAllControl();
      } catch { return json(res, { error: 'bad json' }, 400); }
      broadcast({ type: 'app', url: config.app || '', name: config.name || '', gate: config.gate });
    }
    return json(res, config);
  }
  if (path === '/api/event' && req.method === 'POST') {
    let raw;
    try { raw = JSON.parse(await readBody(req)); } catch { return json(res, { error: 'bad json' }, 400); }
    const list = Array.isArray(raw) ? raw : [raw];
    let stopChanged = false;
    for (const item of list) {
      const e = normalizeEvent(item);
      if (!e) continue;
      if (e.file) { const rel = toRepoPath(REPO, e.file); e.file = rel === null ? e.file.split('\\').join('/') : rel; }
      if (e.type === 'task') { trackTask(e); continue; }
      if (e.type === 'agent' && e.phase === 'spawn' && control.clearStop(e.session, e.agent)) stopChanged = true;
      if (e.type === 'tool' && e.phase === 'start' && e.agent === 'main' && !e.blocked && control.clearStop(e.session, e.agent)) stopChanged = true;
      trackAgent(e);
      broadcast(e);
      if (e.type === 'tool') {
        const r = control.trackTool(e);
        for (const c of r.fresh) broadcast({ type: 'collision', collision: c });
        if (r.changed) broadcast({ type: 'collisions', collisions: control.listCollisions() });
      }
      if (e.type === 'agent' || (e.type === 'tool' && e.phase === 'start' && agents.get(`${e.session}:${e.agent}`)?.calls === 1)) broadcast({ type: 'agents', agents: agentsSnapshot() });
    }
    if (stopChanged) broadcast({ type: 'agents', agents: agentsSnapshot() });
    return json(res, { ok: true });
  }

  // ---------- agent control ----------
  // Browser -> agent: POST /api/control queues a command; the session's hooks
  // module collects it with GET /api/control/wait (long poll).
  if (path === '/api/control' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, { error: 'bad json' }, 400); }
    const r = control.command(body || {});
    if (r.error) return json(res, r, 400);
    const c = r.command;
    if (c.kind === 'stop') for (const a of control.denyAllFor(c.session, c.agent)) settleApproval(a);
    broadcast({ type: 'control', command: c });
    broadcast({ type: 'agents', agents: agentsSnapshot() });
    flushControl(c.session);
    return json(res, r);
  }
  if (path === '/api/control/wait') {
    const session = url.searchParams.get('session') || '';
    if (!session) return json(res, { error: 'session required' }, 400);
    const timeout = Math.max(0, Math.min(25000, Number(url.searchParams.get('timeout')) || 0));
    if (control.pendingFor(session) || !timeout) return json(res, controlReply(session));
    return wait(controlWaiters, session, res, timeout, () => controlReply(session));
  }
  // Agent -> browser: the hooks module asks before a tool call (gate), then waits.
  if (path === '/api/approval' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, { error: 'bad json' }, 400); }
    if (!clients.size || config.gate === 'off') return json(res, { approval: null });
    const file = typeof body.file === 'string' && body.file ? (toRepoPath(REPO, body.file) ?? body.file.split('\\').join('/')) : undefined;
    const r = control.request({ session: body.session, agent: body.agent, tool: body.tool, file, detail: body.detail, gate: config.gate });
    if (r.error) return json(res, r, 400);
    if (r.approval) { broadcast({ type: 'approval', approval: r.approval }); broadcast({ type: 'approvals', approvals: control.pendingApprovals() }); }
    return json(res, r);
  }
  if (path === '/api/approval/wait') {
    const id = url.searchParams.get('id') || '';
    const a = control.getApproval(id);
    if (!a) return json(res, { error: 'unknown approval' }, 404);
    const timeout = Math.max(0, Math.min(25000, Number(url.searchParams.get('timeout')) || 0));
    if (a.status !== 'pending' || !timeout) return json(res, { approval: a });
    return wait(approvalWaiters, id, res, timeout, () => ({ approval: control.getApproval(id) }));
  }
  if (path === '/api/approval/decide' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, { error: 'bad json' }, 400); }
    const r = control.decide(body.id, body.decision);
    if (r.error) return json(res, r, 400);
    settleApproval(r.approval);
    return json(res, r);
  }
  if (path === '/api/collisions') {
    if (req.method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(res, { error: 'bad json' }, 400); }
      if (body.dismiss) control.dismiss(String(body.dismiss));
      broadcast({ type: 'collisions', collisions: control.listCollisions() });
    }
    return json(res, control.listCollisions());
  }

  // static
  let file = path === '/' ? 'index.html' : decodeURIComponent(path).replace(/^\/+/, '');
  const abs = inside(CLIENT, file);
  if (!abs || statSync(abs).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[extname(abs)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  res.end(readFileSync(abs));
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') { console.log(`[wa2] port ${PORT} already in use: another WA2 server is probably running.`); process.exit(2); }
  throw err;
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`[wa2] watching ${REPO}`);
  console.log(`[wa2] ui at ${url}`);
  if (OPEN) openBrowser(url);
});

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref(); } catch {}
}

// ---------- long polls ----------
const controlWaiters = new Map();   // session -> Set<waiter>
const approvalWaiters = new Map();  // approval id -> Set<waiter>
function wait(map, key, res, timeout, reply) {
  let set = map.get(key);
  if (!set) { set = new Set(); map.set(key, set); }
  const w = { res, reply, timer: null, done: null };
  w.done = () => { clearTimeout(w.timer); set.delete(w); if (!set.size && map.get(key) === set) map.delete(key); };
  w.timer = setTimeout(() => { w.done(); json(res, reply()); }, timeout);
  res.on('close', w.done);
  set.add(w);
}
function flush(map, key) {
  for (const w of [...(map.get(key) || [])]) { w.done(); json(w.res, w.reply()); }
}
function controlReply(session) {
  return { commands: control.take(session), gate: config.gate, viewers: clients.size };
}
const flushControl = session => flush(controlWaiters, session);
function flushAllControl() { for (const session of [...controlWaiters.keys()]) flushControl(session); }
function settleApproval(a) {
  broadcast({ type: 'approval', approval: a });
  broadcast({ type: 'approvals', approvals: control.pendingApprovals() });
  flush(approvalWaiters, a.id);
}
setInterval(() => { for (const a of control.expire()) settleApproval(a); }, 2000).unref();

// stale agents go idle after 90 s of silence
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const a of agents.values()) if (a.status === 'active' && now - a.lastAt > 90000) { a.status = 'idle'; changed = true; }
  if (changed) broadcast({ type: 'agents', agents: agentsSnapshot() });
}, 15000).unref();
