// Infinite workspace: the application as a living graph on a pan/zoom canvas.
// Nodes are DOM cards placed in world coordinates inside a transformed layer;
// edges and pulses are SVG in the same layer. Everything shown is real: the
// scanned tree, resolved imports, git branches, and the agents' own events.
//
// Interaction: drag background = pan, wheel = zoom, drag node = move (selection
// moves together), shift+drag background = marquee, shift+click = toggle select,
// click dir = expand/collapse, click file = symbols, click symbol = references,
// drag the port on a node's edge to another node = manual link, G = group,
// Delete = remove group/link, F = fit, M = minimap, R = auto layout.
import { icon, iconForName, roleForName } from '../icons.js';
import { roleOf } from '../roles.js';

const PROVIDERS = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', cursor: 'Cursor', copilot: 'Copilot', aider: 'Aider', opencode: 'OpenCode' };
const providerName = p => PROVIDERS[p] || (p ? p[0].toUpperCase() + p.slice(1) : 'Claude Code');
const cssVar = (name, fallback) => (getComputedStyle(document.documentElement).getPropertyValue(name) || '').trim() || fallback;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fileCounts = new WeakMap();
const countFiles = node => {
  if (node.type === 'file') return 1;
  let n = fileCounts.get(node);
  if (n == null) { n = (node.children || []).reduce((s, c) => s + countFiles(c), 0); fileCounts.set(node, n); }
  return n;
};
const fmtSize = n => !n ? '0 B' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const ago = at => { const s = Math.max(0, Math.round((Date.now() - at) / 1000)); return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
const parentPath = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
const under = (path, dir) => dir === '' || path === dir || path.startsWith(dir + '/');
const VERB = { Edit: 'edits', MultiEdit: 'edits', Write: 'writes', NotebookEdit: 'edits', Read: 'reads', Grep: 'searches', Glob: 'searches', Bash: 'runs', PowerShell: 'runs', Agent: 'delegates to an agent', TodoWrite: 'plans', TaskCreate: 'creates a task', TaskUpdate: 'updates a task', WebFetch: 'fetches the web', WebSearch: 'searches the web' };
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS']);
const ACTIVE_MS = 120000, HOT_MS = 600000, PULSE_MS = 900, CAPTION_MS = 3200, FLASH_MS = 1600;
const MAX_FILES_SHOWN = 24, MAX_DIRS_SHOWN = 30, MAX_SYMBOLS = 40;

export function findNode(tree, path) {
  if (!tree || path === '' || path === tree.path) return tree;
  for (const c of tree.children || []) {
    if (c.path === path) return c;
    if (c.type === 'dir' && path.startsWith(c.path + '/')) return findNode(c, path);
  }
  return null;
}

export function createCanvas(container, { onSelect, onViewChange, insets } = {}) {
  container.innerHTML = `<div class="ws" tabindex="0">
    <div class="ws-tilt">
    <div class="ws-world">
      <svg class="ws-edges"><defs>
        <filter id="wsg" filterUnits="userSpaceOnUse" x="-100000" y="-100000" width="200000" height="200000"><feGaussianBlur stdDeviation="2.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      </defs><g class="groups"></g><g class="edges"></g><g class="pulses"></g><g class="temp"></g></svg>
      <div class="ws-nodes"></div>
      <div class="ws-caps"></div>
    </div>
    </div>
    <div class="ws-marquee hidden"></div>
    <div class="ws-hud">
      <button data-act="group" class="hidden" title="Group selection (G)">${icon('modules')}<span>Group</span></button>
      <button data-act="layout" title="Auto layout (R)">${icon('architecture')}</button>
      <button data-act="fit" title="Fit to view (F)">${icon('fullscreen')}</button>
      <button data-act="minimap" title="Minimap (M)">${icon('grid')}</button>
      <button data-act="relief" title="Relief 2.5D: tilted view plane, raised cards (T)">${icon('layers')}</button>
      <span class="sep"></span>
      <button data-act="zoom-" title="Zoom out">${icon('minus')}</button>
      <b class="zoom" data-act="zoom1" title="Zoom 100 %">100 %</b>
      <button data-act="zoom+" title="Zoom in">${icon('plus')}</button>
    </div>
    <canvas class="ws-minimap hidden" width="220" height="140"></canvas>
    <div class="ws-empty hidden"></div>
  </div>`;
  const ws = container.querySelector('.ws'), world = container.querySelector('.ws-world'), tilt = container.querySelector('.ws-tilt');
  const svg = container.querySelector('.ws-edges'), gEdges = svg.querySelector('.edges'), gPulses = svg.querySelector('.pulses'), gTemp = svg.querySelector('.temp'), gGroups = svg.querySelector('.groups');
  const nodesEl = container.querySelector('.ws-nodes'), capsEl = container.querySelector('.ws-caps');
  const marquee = container.querySelector('.ws-marquee'), hud = container.querySelector('.ws-hud'), minimap = container.querySelector('.ws-minimap'), emptyEl = container.querySelector('.ws-empty');

  let state = null, visible = false, raf = 0;
  const view = { x: 0, y: 0, k: 1 };
  const vis = new Map();              // id -> node record { id, kind, path?, x, y, w, h, el, parent, data }
  const pos = new Map();              // id -> { x, y, user }
  let expanded = new Set(['']);       // dir paths whose children are shown
  let showAll = new Set();            // dir paths showing every folder and file
  const pinned = new Set();           // agent / branch ids kept visible past the caps (focused from a list)
  const chainOf = new Map();          // folder path inside a collapsed chain -> id of the card standing for it
  const symbols = new Map();          // file path -> [{ name, kind, line }]
  const refs = new Map();             // "path#symbol" -> [{ file, line }]
  let openSymbols = new Set();        // file paths whose symbols are shown
  let openRefs = new Set();           // symbol ids whose references are shown
  let groups = [];                    // { id, name, members: [id] }
  let links = [];                     // { id, from, to }
  let selection = new Set();
  let selectedEdge = null;            // { kind: 'link'|'import', id, from, to }
  let search = '';
  let pulses = [], captions = new Map();
  let edgesDirty = true, animating = false, minimapOn = false;
  let storeKey = 'wa2.ws', saveTimer = 0, savedView = false, autoFitUntil = 0;

  // ---------- persistence ----------
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(storeKey) || 'null');
      if (!s) return;
      for (const [id, p] of Object.entries(s.pos || {})) pos.set(id, { x: p.x, y: p.y, user: true });
      expanded = new Set(s.expanded || ['']); expanded.add('');
      showAll = new Set(s.showAll || []);
      groups = s.groups || []; links = s.links || [];
      if (s.view) { Object.assign(view, s.view); savedView = true; }
    } catch {}
  }
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const p = {}; for (const [id, v] of pos) if (v.user) p[id] = { x: Math.round(v.x), y: Math.round(v.y) };
      try { localStorage.setItem(storeKey, JSON.stringify({ pos: p, expanded: [...expanded], showAll: [...showAll], groups, links, view })); } catch {}
    }, 300);
  }

  // ---------- model ----------
  const topOf = p => p.includes('/') ? p.slice(0, p.indexOf('/')) : p;
  const isActive = a => a.status === 'active' && Date.now() - (a.lastAt || 0) < ACTIVE_MS;
  function hotOf(path) { let best = 0; for (const [p, at] of state.hot) if (under(p, path) && at > best) best = at; return best; }
  function changesUnder(path) { return state.git.changes.filter(c => under(c.file, path)); }
  function agentsIn(path) { return [...state.agents.values()].filter(a => a.file && under(a.file, path) && isActive(a)); }
  function branchOfAgent(a) { return a.branch || state.git.current || null; }

  /** Which nodes exist right now, from state + expansion. */
  function collect() {
    const want = new Map();
    const add = (id, kind, data, parent) => { want.set(id, { id, kind, data, parent }); return id; };
    if (!state?.tree) return want;
    const root = state.tree;
    add('d:', 'dir', root, null);
    chainOf.clear();
    const walk = dir => {
      if (!expanded.has(dir.path)) return;
      const kids = dir.children || [];
      const { dirs, all: allDirs } = dirKids(dir);
      const files = kids.filter(c => c.type === 'file');
      // a folder made of modules keeps its loose files behind "+ N files", except the ones in use
      const quietFiles = !showAll.has(dir.path) && dirs.length >= 3 && files.length > 4;
      const shownFiles = showAll.has(dir.path) ? files : quietFiles ? files.filter(f => busy(f.path)).slice(0, MAX_FILES_SHOWN) : files.slice(0, MAX_FILES_SHOWN);
      for (const d of dirs) {
        // src/main/java/com: one card for a run of folders that each hold a single folder
        let t = d;
        for (;;) { const k = t.children || []; if (k.length === 1 && k[0].type === 'dir') t = k[0]; else break; }
        const id = 'd:' + t.path;
        for (let p = d.path; p !== t.path;) { chainOf.set(p, id); const e = t.path.indexOf('/', p.length + 1); p = e < 0 ? t.path : t.path.slice(0, e); }
        add(id, 'dir', t === d ? d : { ...t, label: t.path.slice(dir.path ? dir.path.length + 1 : 0), from: d.path }, 'd:' + dir.path);
        walk(t);
      }
      for (const f of shownFiles) {
        add('f:' + f.path, 'file', f, 'd:' + dir.path);
        if (openSymbols.has(f.path)) for (const s of (symbols.get(f.path) || []).slice(0, MAX_SYMBOLS)) add(`s:${f.path}#${s.name}`, 'symbol', { ...s, file: f.path }, 'f:' + f.path);
      }
      if (files.length > shownFiles.length || allDirs.length > dirs.length) add('m:' + dir.path, 'more', { path: dir.path, count: files.length - shownFiles.length, dirs: allDirs.length - dirs.length }, 'd:' + dir.path);
    };
    walk(root);
    // files revealed by references
    for (const sid of openRefs) for (const r of refs.get(sid) || []) {
      if (!want.has('f:' + r.file)) { const n = findNode(root, r.file); if (n) add('f:' + r.file, 'file', n, null); }
    }
    if (state.hello.app) add('app', 'app', { url: state.hello.app }, 'd:');
    const agents = [...state.agents.values()].filter(a => isActive(a) || Date.now() - (a.lastAt || 0) < 1800000).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0)).slice(0, 12);
    for (const a of agents) add('a:' + a.key, 'agent', a, null);
    // the server lists the current branch and the base first
    for (const b of state.git.branches.slice(0, 8)) add('b:' + b.name, 'branch', b, null);
    // past the caps, an agent or branch opened from a list stays on the canvas
    for (const id of pinned) {
      if (want.has(id)) continue;
      if (id.startsWith('a:')) { const a = state.agents.get(id.slice(2)); if (a) add(id, 'agent', a, null); }
      else if (id.startsWith('b:')) { const b = state.git.branches.find(x => x.name === id.slice(2)); if (b) add(id, 'branch', b, null); }
    }
    return want;
  }

  /** Deepest visible node standing for a repo path. */
  function repOf(path) {
    if (path == null) return null;
    if (vis.has('f:' + path)) return vis.get('f:' + path);
    for (let p = path; ; p = parentPath(p)) { if (vis.has('d:' + p)) return vis.get('d:' + p); if (chainOf.has(p) && vis.has(chainOf.get(p))) return vis.get(chainOf.get(p)); if (p === '') return null; }
  }

  // ---------- rendering of nodes ----------
  function nodeHtml(n) {
    const d = n.data;
    if (n.kind === 'dir') {
      const isRoot = d.path === '';
      const files = countFiles(d), chg = changesUnder(d.path).length, hot = hotOf(d.path), ag = agentsIn(d.path);
      const subs = (d.children || []).filter(c => c.type === 'dir').sort((a, b) => countFiles(b) - countFiles(a)).slice(0, 4);
      const status = ag.length ? 'in progress' : hot && Date.now() - hot < HOT_MS ? `modified ${ago(hot)}` : chg ? `${chg} uncommitted file${chg > 1 ? 's' : ''}` : 'stable';
      const total = countFiles(state.tree) || 1;
      const width = isRoot ? 250 : Math.round(Math.min(400, 210 + 190 * Math.sqrt(files / total)));
      const heat = ag.length ? 1 : hot && Date.now() - hot < HOT_MS ? 0.75 * (1 - (Date.now() - hot) / HOT_MS) + 0.25 : chg ? 0.2 : 0;
      const name = isRoot ? (state.hello.name || d.name) : (d.label || d.name);
      return `<div class="nc dirc ${isRoot ? 'root' : ''} ${ag.length ? 'busy' : ''} ${chg ? 'haschg' : ''}" style="width:${width}px;--heat:${heat.toFixed(2)}">
        <span class="nc-far"><b>${esc(name)}</b><small>${files} file${files > 1 ? 's' : ''}${ag.length ? ` · ${ag.length} agent${ag.length > 1 ? 's' : ''}` : chg ? ` · ${chg} changed` : ''}</small></span>
        <div class="nc-head"><span class="nc-ic">${icon(isRoot ? 'cube' : iconForName(d.name))}</span>
          <div class="nc-t"><b title="${esc(d.path)}">${esc(name)}</b><small${isRoot && d.truncated ? ` class="warn" title="Large repository: WA2 reads ${files} files, the deepest ones are left out"` : ''}>${esc(isRoot ? (d.truncated ? `Application · ${d.skipped} files not loaded` : 'Application') : roleForName(d.name))}</small></div>
          <span class="nc-exp">${icon(expanded.has(d.path) ? 'chevron-down' : 'chevron-right')}</span></div>
        <div class="nc-foot"><span class="nc-status ${ag.length ? 'on' : chg ? 'chg' : ''}"><i></i>${esc(status)}</span>
          <span class="nc-right">${ag.length ? `<span class="nc-agents">${ag.slice(0, 4).map(a => `<i class="av" title="${esc(roleOf(a).name)} · ${esc(a.description || '')}">${icon(roleOf(a).icon)}</i>`).join('')}</span>` : `<small>${files} file${files > 1 ? 's' : ''}</small>`}</span></div>
        ${subs.length && !expanded.has(d.path) ? `<div class="nc-subs">${subs.map(s => `<span>${esc(s.name)}</span>`).join('')}${(d.children || []).filter(c => c.type === 'dir').length > 4 ? '<span>…</span>' : ''}</div>` : ''}
        <span class="ws-port" title="Drag to another node to create a link"></span></div>`;
    }
    if (n.kind === 'file') {
      const chg = state.git.changes.find(c => c.file === d.path), hot = state.hot.get(d.path) || 0, ag = agentsIn(d.path);
      return `<div class="nc file ${ag.length ? 'busy' : ''}"><span class="nc-ic">${icon('file')}</span>
        <div class="nc-t"><b>${esc(d.name)}</b><small>${fmtSize(d.size)}${chg ? ` · <em class="g-${chg.status}">${chg.status === 'A' ? 'new' : chg.status === 'D' ? 'deleted' : 'modified'}${chg.add || chg.del ? ` +${chg.add} −${chg.del}` : ''}</em>` : ''}${hot && Date.now() - hot < HOT_MS ? ` · ${ago(hot)}` : ''}</small></div>
        <span class="nc-agents">${ag.slice(0, 3).map(a => `<i class="av">${icon(roleOf(a).icon)}</i>`).join('')}</span><span class="ws-port"></span></div>`;
    }
    if (n.kind === 'symbol') return `<div class="nc sym k-${d.kind}"><span class="nc-ic">${icon(d.kind === 'class' ? 'box' : d.kind === 'type' ? 'puzzle' : 'code')}</span><b>${esc(d.name)}</b><small>${d.exported ? 'export' : d.kind}</small></div>`;
    if (n.kind === 'more') return `<div class="nc more" title="${d.dirs ? 'Small folders with no activity are grouped here; any agent or git change brings one back out' : ''}"><b>+ ${[d.dirs ? `${d.dirs} small folder${d.dirs > 1 ? 's' : ''}` : '', d.count ? `${d.count} file${d.count > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ')}</b><small>show</small></div>`;
    if (n.kind === 'app') return `<div class="nc app"><span class="nc-ic">${icon('play')}</span><div class="nc-t"><b>Live app</b><small>${esc(d.url)}</small></div><span class="ws-port"></span></div>`;
    if (n.kind === 'agent') {
      const a = d, r = roleOf(a), active = isActive(a);
      // progress = the session's own task list; no list, no bar (no invented percentage)
      const tasks = a.agent === 'main' ? state.tasks.filter(t => t.session === a.session) : [];
      const done = tasks.filter(t => t.status === 'completed').length;
      const pct = tasks.length ? Math.round(done / tasks.length * 100) : null;
      const mod = a.file ? topOf(a.file) : null;
      const act = a.tool ? `${esc(VERB[a.tool] || a.tool)} ${a.file ? esc(a.file.split('/').pop()) : (a.tool === 'Bash' || a.tool === 'PowerShell') ? esc((a.detail || '').slice(0, 30)) : ''}` : 'waiting';
      const waits = (state.approvals || []).some(p => p.session === a.session && p.agent === a.agent);
      const flag = waits ? '<span class="nc-flag wait">needs you</span>' : a.stopped ? '<span class="nc-flag stop">stopped</span>' : '';
      return `<div class="nc agent ${active ? 'on' : 'idle'} ${waits ? 'wait' : ''} ${a.stopped ? 'stopped' : ''}">
        <div class="nc-head"><span class="nc-av">${icon(r.icon)}</span><div class="nc-t"><b>${esc(r.name)} <em class="prov" title="AI tool">${esc(providerName(a.provider))}</em></b><small title="${esc(a.description || '')}">${esc(a.description || a.agentType || 'Agent')}</small></div>${flag}<span class="nc-dot" title="${active ? 'active' : 'idle'}"></span></div>
        <div class="nc-row"><span>${mod ? `module <b>${esc(mod)}</b>` : 'no module'}</span><span>${active ? 'active' : a.lastAt ? ago(a.lastAt) : '-'}</span></div>
        <div class="nc-act">${icon(a.tool && READ_TOOLS.has(a.tool) ? 'eye' : 'edit')}<span>${act}</span></div>
        ${pct == null ? '' : `<div class="progress" title="${done}/${tasks.length} tasks done"><div class="progress-fill" style="width:${pct}%"></div></div>`}
        <span class="ws-port"></span></div>`;
    }
    if (n.kind === 'branch') {
      const b = d, g = state.git;
      const chg = b.current ? g.changes.length : 0, conf = b.current ? (g.conflicts || []).length : 0;
      const ag = [...state.agents.values()].filter(a => branchOfAgent(a) === b.name && isActive(a));
      const merged = !!b.merged, isBase = b.name === g.base;
      const role = [b.current ? 'current branch' : '', isBase ? 'base branch' : '', merged ? 'merged into ' + esc(g.base) : ''].filter(Boolean).join(' · ') || 'branch';
      const vsBase = b.aheadBase != null && !merged ? `${b.aheadBase} commit${b.aheadBase === 1 ? '' : 's'} not in ${esc(g.base)}` : b.date ? `last commit ${ago(b.date)}` : '';
      return `<div class="nc branch ${b.current ? 'cur' : ''} ${conf ? 'conflict' : ''} ${merged && !b.current ? 'merged' : ''}"><div class="nc-head"><span class="nc-ic">${icon('git')}</span>
        <div class="nc-t"><b>${esc(b.name)}</b><small>${role}${b.ahead || b.behind ? ` · ↑${b.ahead} ↓${b.behind}` : ''}${b.worktree ? ` · <span class="nc-wt" title="${esc(b.worktree)}">${icon('fork')}worktree ${esc(b.worktree.split('/').pop())}</span>` : ''}</small></div>
        ${b.health ? `<span class="nc-health ${b.health.level}" title="${esc(b.health.checks.map(c => `${c.label}: ${c.detail}`).join('\n'))}"><i></i>${esc(b.health.summary)}</span>` : ''}</div>
        <div class="nc-row"><span>${vsBase}</span><span>${chg ? `${chg} modified` : ''}${conf ? ` · <em class="bad">${conf} conflict${conf > 1 ? 's' : ''}</em>` : ''}</span></div>
        ${ag.length ? `<div class="nc-foot"><span class="nc-agents">${ag.slice(0, 5).map(a => `<i class="av">${icon(roleOf(a).icon)}</i>`).join('')}</span><small>${ag.length} agent${ag.length > 1 ? 's' : ''}</small></div>` : ''}
        <span class="ws-port"></span></div>`;
    }
    return '';
  }

  function sync() {
    if (!state) return;
    const want = collect();
    if (!want.size) { emptyEl.classList.remove('hidden'); emptyEl.textContent = 'No files in this repository.'; return; }
    emptyEl.classList.add('hidden');
    for (const [id, n] of vis) if (!want.has(id)) { n.el.remove(); vis.delete(id); selection.delete(id); }
    const fresh = [];
    for (const [id, w] of want) {
      let n = vis.get(id);
      if (!n) {
        const el = document.createElement('div');
        el.className = `ws-node ${w.kind}`; el.dataset.id = id;
        nodesEl.appendChild(el);
        n = { id, kind: w.kind, data: w.data, parent: w.parent, el, x: 0, y: 0, tx: 0, ty: 0, w: 200, h: 60 };
        vis.set(id, n); fresh.push(n);
      } else { n.data = w.data; n.parent = w.parent; }
      n.el.innerHTML = nodeHtml(n);
      n.el.classList.toggle('sel', selection.has(id));
    }
    markCollisions();
    for (const n of vis.values()) { n.w = n.el.offsetWidth || n.w; n.h = n.el.offsetHeight || n.h; }
    place(fresh);
    applySearch();
    edgesDirty = true; kick();
    if (fresh.length && Date.now() < autoFitUntil) setTimeout(() => fit(), 60);
  }

  /** Red ring on the deepest visible node standing for a collision's file or folder. */
  function markCollisions() {
    const flags = new Map();
    for (const c of state.collisions || []) {
      const rep = repOf(c.file ?? c.dir); if (!rep) continue;
      const prev = flags.get(rep.id);
      if (!prev || (c.level === 'bad' && prev.level !== 'bad')) flags.set(rep.id, { level: c.level, n: Math.max(c.agents.length, prev?.n || 0) });
    }
    for (const n of vis.values()) {
      const f = flags.get(n.id);
      n.el.classList.toggle('collide', f?.level === 'bad');
      n.el.classList.toggle('overlap', f?.level === 'warn');
      if (f) n.el.dataset.col = `${f.n} agents`; else delete n.el.dataset.col;
    }
  }

  /** Something is happening under this folder: never grouped away. */
  function busy(path) {
    const hot = hotOf(path);
    return (hot && Date.now() - hot < HOT_MS) || changesUnder(path).length > 0 || agentsIn(path).length > 0
      || (state.collisions || []).some(c => under(c.file ?? c.dir ?? '', path));
  }
  /** Sub-folders shown for a folder: biggest first; with many siblings the small quiet ones wait behind "+ N". */
  function dirKids(dir) {
    const all = (dir.children || []).filter(c => c.type === 'dir' && countFiles(c) > 0).sort((a, b) => countFiles(b) - countFiles(a) || a.name.localeCompare(b.name));
    if (showAll.has(dir.path)) return { dirs: all, all };
    const total = countFiles(dir), small = c => countFiles(c) < Math.max(3, total * 0.02);
    const kept = all.length <= 8 ? all : all.filter(c => !small(c) || busy(c.path));
    return { dirs: kept.slice(0, MAX_DIRS_SHOWN), all };
  }

  // ---------- layout ----------
  function place(fresh) {
    const placed = new Set();
    // known positions first
    for (const n of fresh) { const p = pos.get(n.id); if (p) { n.x = n.tx = p.x; n.y = n.ty = p.y; placed.add(n.id); } }
    const byParent = new Map();
    for (const n of fresh) if (!placed.has(n.id)) { const k = n.parent || (n.kind === 'agent' ? '@agents' : n.kind === 'branch' ? '@branches' : n.kind === 'file' ? '@refs' : '@root'); if (!byParent.has(k)) byParent.set(k, []); byParent.get(k).push(n); }
    for (const [k, kids] of byParent) {
      if (k === '@root') { for (const n of kids) { n.x = n.tx = 0; n.y = n.ty = 0; } continue; }
      if (k === '@branches') { placeBranches(kids); continue; }
      if (k === '@agents') { for (const n of kids) anchorAgent(n, true); continue; }
      if (k === '@refs') { fan(vis.get('d:') || { x: 0, y: 0 }, null, kids, 520); continue; }
      const parent = vis.get(k); if (!parent) continue;
      fan(parent, parent.parent ? vis.get(parent.parent) : null, kids);
    }
    for (const n of fresh) if (!pos.has(n.id)) { n.x = n.tx; n.y = n.ty; if (n.parent && vis.get(n.parent)) { const p = vis.get(n.parent); n.x = p.x; n.y = p.y; } }
    relax(fresh.filter(n => !pos.get(n.id)?.user));
    for (const n of fresh) if (!pos.has(n.id)) pos.set(n.id, { x: n.tx, y: n.ty, user: false });
    animating = true;
  }
  function fan(parent, grand, kids, minR) {
    const n = kids.length; if (!n) return;
    const full = !grand && parent.kind === 'dir' && parent.data.path === '';
    const center = grand ? Math.atan2(parent.y - grand.y, parent.x - grand.x) : -Math.PI / 2;
    const span = full ? Math.PI * 2 : Math.PI * 0.9;
    const maxW = Math.max(...kids.map(k => k.w)) + 30;
    // arc length a card needs: wide cards need more room, tall ones a little
    const need = k => k.w * 0.72 + k.h * 0.45 + 34;
    let r = Math.max(minR || (full ? 330 : parent.kind === 'file' ? 170 : 270), parent.w / 2 + maxW / 2 + 40);
    // rings filled in order (the list comes biggest first), each card spaced by its own size
    for (let i = 0; i < n;) {
      const room = span * r * (full ? 0.89 : 1);
      let used = 0, j = i;
      while (j < n && (j === i || used + need(kids[j]) <= room)) used += need(kids[j++]);
      const ring = kids.slice(i, j), sp = full ? span : Math.min(span, used / r);
      let acc = 0;
      for (const k of ring) {
        const s = need(k), t = (acc + s / 2) / used; acc += s;
        const a = full ? center + t * span : ring.length === 1 ? center : center - sp / 2 + t * sp;
        k.tx = parent.x + Math.cos(a) * r; k.ty = parent.y + Math.sin(a) * r * (full ? 0.78 : 1);
      }
      i = j; r += Math.max(...ring.map(k => k.h)) + 70;
    }
  }
  function placeBranches(kids) {
    const root = vis.get('d:'); const bx = (root?.x || 0) - 760, total = kids.reduce((s, k) => s + k.h + 24, 0);
    // a branch added later (opened from the list) goes under the column, not on top of it
    const fresh = new Set(kids), column = [...vis.values()].filter(n => n.kind === 'branch' && !fresh.has(n));
    let y = column.length ? Math.max(...column.map(n => n.y + n.h / 2)) + 24 : (root?.y || 0) - total / 2;
    for (const k of kids) { k.tx = bx; k.ty = y + k.h / 2; y += k.h + 24; }
  }
  function anchorAgent(n, initial) {
    const a = n.data, rep = a.file ? repOf(a.file) : null, root = vis.get('d:');
    if (rep && rep !== root) {
      const from = rep.parent ? vis.get(rep.parent) : root;
      const ang = from ? Math.atan2(rep.y - from.y, rep.x - from.x) : -Math.PI / 2;
      n.tx = rep.x + Math.cos(ang) * (rep.w / 2 + n.w / 2 + 70); n.ty = rep.y + Math.sin(ang) * (rep.h / 2 + n.h / 2 + 70);
    } else {
      const list = [...vis.values()].filter(x => x.kind === 'agent'); const i = list.indexOf(n);
      n.tx = (root?.x || 0) - 520 + (i % 2) * 260; n.ty = (root?.y || 0) + 520 + Math.floor(i / 2) * (n.h + 24);
    }
    if (initial) { n.x = n.tx; n.y = n.ty; }
    pos.set(n.id, { x: n.tx, y: n.ty, user: pos.get(n.id)?.user || false });
  }
  /** Push overlapping cards apart. New nodes and auto-placed nodes move; user-placed nodes, the root and branches stay. */
  function relax(fresh) {
    if (!fresh.length) return;
    const all = [...vis.values()];
    const movable = new Set(fresh.map(n => n.id));
    for (const n of all) if (!movable.has(n.id) && !pos.get(n.id)?.user && n.kind !== 'branch' && n.id !== 'd:') movable.add(n.id);
    for (const n of all) { if (n.tx == null) n.tx = n.x; if (n.ty == null) n.ty = n.y; }
    const list = all.filter(n => movable.has(n.id));
    for (let it = 0; it < 90; it++) {
      let moved = false;
      for (const a of list) for (const b of all) {
        if (a === b) continue;
        const dx = a.tx - b.tx, dy = a.ty - b.ty;
        const ox = (a.w + b.w) / 2 + 28 - Math.abs(dx), oy = (a.h + b.h) / 2 + 22 - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue;
        moved = true;
        const both = movable.has(b.id), wa = both ? 0.5 : 1, wb = both ? 0.5 : 0;
        const sx = dx >= 0 || (dx === 0 && a.id > b.id) ? 1 : -1, sy = dy >= 0 ? 1 : -1;
        if (ox < oy) { a.tx += sx * ox * 0.55 * wa; b.tx -= sx * ox * 0.55 * wb; } else { a.ty += sy * oy * 0.55 * wa; b.ty -= sy * oy * 0.55 * wb; }
      }
      if (!moved) break;
    }
    for (const n of list) if (!fresh.includes(n)) pos.set(n.id, { x: n.tx, y: n.ty, user: false });
  }
  function autoLayout() {
    for (const [id, p] of pos) if (!id.startsWith('g:')) pos.delete(id);
    const order = [...vis.values()];
    const root = order.find(n => n.id === 'd:'); if (root) { root.tx = 0; root.ty = 0; root.x = root.y = 0; pos.set('d:', { x: 0, y: 0, user: false }); }
    const layer = ids => ids.forEach(n => { n.x = n.tx; n.y = n.ty; });
    // breadth first from root so parents are settled before children
    const queue = ['d:']; const done = new Set(['d:']);
    while (queue.length) {
      const pid = queue.shift(); const parent = vis.get(pid); if (!parent) continue;
      const kids = order.filter(n => n.parent === pid && !done.has(n.id));
      if (kids.length) { fan(parent, parent.parent ? vis.get(parent.parent) : null, kids); relax(kids); layer(kids); kids.forEach(k => { done.add(k.id); pos.set(k.id, { x: k.tx, y: k.ty, user: false }); queue.push(k.id); }); }
    }
    placeBranches(order.filter(n => n.kind === 'branch')); order.filter(n => n.kind === 'branch').forEach(n => pos.set(n.id, { x: n.tx, y: n.ty, user: false }));
    order.filter(n => n.kind === 'agent').forEach(n => anchorAgent(n, false));
    const rest = order.filter(n => !done.has(n.id) && n.kind !== 'branch' && n.kind !== 'agent');
    if (rest.length) { fan(root || { x: 0, y: 0, w: 200, kind: 'dir', data: { path: '' } }, null, rest, 560); relax(rest); rest.forEach(n => pos.set(n.id, { x: n.tx, y: n.ty, user: false })); }
    animating = true; save(); kick();
    setTimeout(fit, 420);
  }

  // ---------- edges ----------
  function anchor(a, b) {
    // point on a's rectangle border toward b's centre
    const dx = b.x - a.x, dy = b.y - a.y;
    if (!dx && !dy) return { x: a.x, y: a.y };
    const sx = (a.w / 2) / Math.abs(dx || 1e-6), sy = (a.h / 2) / Math.abs(dy || 1e-6);
    const s = Math.min(sx, sy);
    return { x: a.x + dx * s, y: a.y + dy * s };
  }
  function pathBetween(a, b, curve = 0.35) {
    const p = anchor(a, b), q = anchor(b, a);
    const dx = q.x - p.x, dy = q.y - p.y;
    const horizontal = Math.abs(dx) > Math.abs(dy);
    const c1 = horizontal ? { x: p.x + dx * curve, y: p.y } : { x: p.x, y: p.y + dy * curve };
    const c2 = horizontal ? { x: q.x - dx * curve, y: q.y } : { x: q.x, y: q.y - dy * curve };
    return { d: `M${p.x.toFixed(1)},${p.y.toFixed(1)} C${c1.x.toFixed(1)},${c1.y.toFixed(1)} ${c2.x.toFixed(1)},${c2.y.toFixed(1)} ${q.x.toFixed(1)},${q.y.toFixed(1)}`, p, q };
  }
  const edgeIndex = new Map();   // "from|to|kind" -> path element
  function buildEdges() {
    const list = [];
    for (const n of vis.values()) if (n.parent && vis.has(n.parent)) list.push({ kind: n.kind === 'symbol' ? 'sym' : 'tree', from: vis.get(n.parent), to: n });
    // imports aggregated onto the deepest visible nodes
    const agg = new Map();
    for (const e of state.deps?.files || []) {
      const a = repOf(e.from), b = repOf(e.to);
      if (!a || !b || a === b || a.id === 'd:' || b.id === 'd:') continue;
      const k = `${a.id}>${b.id}`;
      if (!agg.has(k)) agg.set(k, { kind: 'import', from: a, to: b, count: 0, files: [] });
      const g = agg.get(k); g.count++; if (g.files.length < 12) g.files.push(e);
    }
    for (const g of agg.values()) list.push(g);
    for (const n of vis.values()) {
      if (n.kind === 'agent') {
        const a = n.data; const rep = a.file ? repOf(a.file) : null;
        if (rep && rep !== n) list.push({ kind: 'agent', from: n, to: rep, active: isActive(a), read: READ_TOOLS.has(a.tool) });
        const b = branchOfAgent(a); if (b && vis.has('b:' + b)) list.push({ kind: 'branch', from: vis.get('b:' + b), to: n });
      }
      if (n.kind === 'branch' && vis.has('d:')) list.push({ kind: 'branch', from: n, to: vis.get('d:'), faint: true });
    }
    for (const sid of openRefs) {
      const s = vis.get(sid); if (!s) continue;
      const seen = new Set();
      for (const r of refs.get(sid) || []) { const rep = repOf(r.file); if (rep && rep !== s && rep.id !== s.parent && !seen.has(rep.id)) { seen.add(rep.id); list.push({ kind: 'ref', from: s, to: rep }); } }
    }
    for (const l of links) { const a = vis.get(l.from), b = vis.get(l.to); if (a && b) list.push({ kind: 'link', from: a, to: b, id: l.id }); }
    return list;
  }
  let edges = [];
  function drawEdges() {
    edges = buildEdges();
    let html = '';
    for (const e of edges) {
      const { d, q } = pathBetween(e.from, e.to, e.kind === 'tree' ? 0.45 : 0.3);
      const cls = `e e-${e.kind} ${e.active ? 'on' : ''} ${e.read ? 'read' : ''} ${e.faint ? 'faint' : ''} ${selectedEdge && selectedEdge.kind === e.kind && selectedEdge.from === e.from.id && selectedEdge.to === e.to.id ? 'sel' : ''}`;
      html += `<path class="${cls}" d="${d}" data-k="${e.kind}" data-from="${esc(e.from.id)}" data-to="${esc(e.to.id)}"/>`;
      if (e.kind === 'import' || e.kind === 'link' || e.kind === 'ref') html += `<path class="e-hit" d="${d}" data-k="${e.kind}" data-from="${esc(e.from.id)}" data-to="${esc(e.to.id)}"/>`;
      if (e.kind === 'import') { html += `<circle class="e-end" cx="${q.x.toFixed(1)}" cy="${q.y.toFixed(1)}" r="3.5"/>`; if (e.count > 1 && view.k > 0.5) { const m = mid(e); html += `<text class="e-lbl" x="${m.x}" y="${m.y}">${e.count}</text>`; } }
    }
    gEdges.innerHTML = html;
    drawGroups();
    edgesDirty = false;
  }
  const mid = e => ({ x: ((e.from.x + e.to.x) / 2).toFixed(1), y: ((e.from.y + e.to.y) / 2 - 6).toFixed(1) });
  function groupRect(g) {
    const ms = g.members.map(id => vis.get(id)).filter(Boolean); if (!ms.length) return null;
    const x0 = Math.min(...ms.map(n => n.x - n.w / 2)) - 28, y0 = Math.min(...ms.map(n => n.y - n.h / 2)) - 48;
    const x1 = Math.max(...ms.map(n => n.x + n.w / 2)) + 28, y1 = Math.max(...ms.map(n => n.y + n.h / 2)) + 28;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  function drawGroups() {
    gGroups.innerHTML = groups.map(g => { const r = groupRect(g); if (!r) return ''; return `<g class="grp ${selection.has(g.id) ? 'sel' : ''}" data-id="${esc(g.id)}"><rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="18"/><text x="${r.x + 16}" y="${r.y + 26}">${esc(g.name)}</text></g>`; }).join('');
  }

  // ---------- pulses & captions ----------
  function fire(fromNode, toNode, { color = cssVar('--lime', '#c8ff00'), caption, reverse = false, weak = false } = {}) {
    if (!toNode) return;
    if (fromNode && fromNode !== toNode) {
      const { d } = pathBetween(fromNode, toNode, 0.3);
      const tmp = document.createElementNS('http://www.w3.org/2000/svg', 'path'); tmp.setAttribute('d', d);
      pulses.push({ d, len: tmp.getTotalLength(), path: tmp, at: performance.now(), color, node: toNode, reverse });
    } else flash(toNode);
    if (caption) showCaption(toNode, caption, { weak });
    kick();
  }
  function flash(n) { n.el.classList.add('flash'); setTimeout(() => n.el.classList.remove('flash'), FLASH_MS); }
  function showCaption(n, text, { weak = false } = {}) {
    let c = captions.get(n.id);
    if (c && weak && !c.weak) return;
    if (!c) { const el = document.createElement('div'); el.className = 'ws-cap'; capsEl.appendChild(el); c = { el, t1: 0, t2: 0 }; captions.set(n.id, c); }
    clearTimeout(c.t1); clearTimeout(c.t2);
    c.el.classList.remove('out'); c.el.textContent = text; c.weak = weak; c.node = n;
    c.el.style.transform = `translate(${n.x}px, ${n.y - n.h / 2 - 22}px) translate(-50%, -100%)${billboard()}`;
    c.t1 = setTimeout(() => c.el.classList.add('out'), CAPTION_MS - 400);
    c.t2 = setTimeout(() => { c.el.remove(); captions.delete(n.id); }, CAPTION_MS);
  }

  // ---------- little characters: one per agent, they walk to the module being worked on ----------
  // Driven only by real tool events (botGo); nothing moves on its own.
  const BOT_SPEED = 260;          // world px / s
  const WORK_MS = 2600;
  const bots = new Map();         // agent key -> bot
  let botsEl = null, lastBotT = 0;
  function botsLayer() { if (!botsEl) { botsEl = document.createElement('div'); botsEl.className = 'ws-bots'; world.appendChild(botsEl); } return botsEl; }
  function botHtml(a) {
    const r = roleOf(a);
    return `<div class="bot-fig"><svg viewBox="0 0 24 34" width="24" height="34">
        <circle class="b-head" cx="12" cy="7" r="5.5"/><rect class="b-body" x="7" y="13" width="10" height="11" rx="3"/>
        <line class="b-arm b-arm-l" x1="7" y1="16" x2="2" y2="22"/><line class="b-arm b-arm-r" x1="17" y1="16" x2="22" y2="22"/>
        <line class="b-leg b-leg-l" x1="9.5" y1="24" x2="8" y2="33"/><line class="b-leg b-leg-r" x1="14.5" y1="24" x2="16" y2="33"/>
        <circle class="b-eye" cx="10" cy="6.5" r="1"/><circle class="b-eye" cx="14" cy="6.5" r="1"/></svg>
        <span class="bot-tool">${icon('edit')}</span><span class="bot-spark"></span></div>
      <span class="bot-name">${esc(r.name)}</span>`;
  }
  function botFor(a) {
    let b = bots.get(a.key);
    if (b && a.provider && b.el.dataset.provider !== a.provider) { b.el.dataset.provider = a.provider; b.el.title = `${roleOf(a).name} · ${providerName(a.provider)}`; }
    if (!b) {
      const el = document.createElement('div'); el.className = 'ws-bot'; el.dataset.key = a.key; el.innerHTML = botHtml(a);
      el.dataset.provider = a.provider || 'claude';
      el.title = `${roleOf(a).name} · ${providerName(a.provider)}`;
      el.addEventListener('click', ev => { ev.stopPropagation(); const n = vis.get('a:' + a.key); if (n) click(n, false); });
      botsLayer().appendChild(el);
      const home = vis.get('a:' + a.key);
      b = { key: a.key, el, x: home ? home.x : 0, y: home ? home.y + home.h / 2 + 18 : 0, tx: 0, ty: 0, mode: 'idle', until: 0, target: null, dir: 1, placed: !!home };
      bots.set(a.key, b);
    }
    return b;
  }
  /** Agent `a` touches node `rep`: its character walks there and works. mode: 'work' | 'read'. */
  function botGo(a, rep, mode = 'work') {
    if (!a?.key || !rep) return;
    const b = botFor(a);
    b.target = rep.id; b.mode = 'walk'; b.next = mode; b.until = 0;
    b.el.querySelector('.bot-tool').innerHTML = icon(mode === 'read' ? 'eye' : 'edit');
    animating = true; kick();
  }
  const BOT_GAP_X = 34, BOT_GAP_Y = 40;
  /** Destination of every character this frame: a row of slots under its target node, then a
   *  global separation pass so two characters never stand on the same spot, whatever their target. */
  function botSpots() {
    const spots = new Map(), byTarget = new Map();
    for (const b of bots.values()) {
      const t = b.target && vis.get(b.target);
      if (t) { if (!byTarget.has(t.id)) byTarget.set(t.id, []); byTarget.get(t.id).push(b); continue; }
      const home = vis.get('a:' + b.key);
      if (home) spots.set(b.key, { x: home.x, y: home.y + home.h / 2 + 18 });
    }
    for (const [id, list] of byTarget) {
      const t = vis.get(id), perRow = Math.max(1, Math.floor((t.w + 20) / BOT_GAP_X));
      list.sort((a, b) => a.key < b.key ? -1 : 1).forEach((b, i) => {
        const row = Math.floor(i / perRow), col = i % perRow, n = Math.min(perRow, list.length - row * perRow);
        spots.set(b.key, { x: t.x + (col - (n - 1) / 2) * BOT_GAP_X, y: t.y + t.h / 2 + 20 + row * BOT_GAP_Y });
      });
    }
    const arr = [...spots.values()];
    for (let it = 0; it < 6; it++) for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
      const a = arr[i], c = arr[j], dx = c.x - a.x, dy = c.y - a.y;
      if (Math.abs(dx) < BOT_GAP_X - 2 && Math.abs(dy) < BOT_GAP_Y - 4) { const push = (BOT_GAP_X - Math.abs(dx)) / 2, dir = dx >= 0 ? 1 : -1; a.x -= push * dir; c.x += push * dir; }
    }
    return spots;
  }
  function botSpot(b) { return botSpots().get(b.key) || null; }
  function syncBots() {
    if (!state) return;
    const keys = new Set();
    for (const n of vis.values()) if (n.kind === 'agent') { keys.add(n.data.key); const b = botFor(n.data); if (!b.placed) { const sp = botSpot(b); if (sp) { b.x = sp.x; b.y = sp.y; b.placed = true; } } }
    for (const [k, b] of bots) if (!keys.has(k) && !(state.agents.get(k) && isActive(state.agents.get(k)))) { b.el.remove(); bots.delete(k); }
    for (const b of bots.values()) { const a = state.agents.get(b.key); if (a && b.target && !isActive(a) && b.mode !== 'walk') { b.target = null; b.mode = 'walk'; b.next = 'idle'; } }
    if (bots.size) { animating = true; kick(); }
  }
  /** Advances every character; returns true while something still moves. */
  function stepBots(now) {
    const dt = Math.min(0.05, (now - (lastBotT || now)) / 1000); lastBotT = now;
    let moving = false;
    const spots = botSpots();
    for (const b of bots.values()) {
      const sp = spots.get(b.key); if (!sp) continue;
      b.tx = sp.x; b.ty = sp.y;
      const dx = b.tx - b.x, dy = b.ty - b.y, dist = Math.hypot(dx, dy);
      if (dist > 2) {
        const step = Math.min(dist, BOT_SPEED * dt);
        b.x += dx / dist * step; b.y += dy / dist * step; b.dir = dx < 0 ? -1 : 1; b.mode = 'walk'; moving = true;
      } else if (b.mode === 'walk') {
        b.x = b.tx; b.y = b.ty; b.mode = b.next || 'idle'; b.until = b.mode === 'idle' ? 0 : now + WORK_MS; moving = true;
      } else if (b.mode !== 'idle' && now > b.until) { b.mode = 'idle'; moving = true; }
      else if (b.mode !== 'idle') moving = true;
      b.el.className = `ws-bot ${b.mode}`;
      b.el.style.transform = `translate(${(b.x - 12).toFixed(1)}px, ${(b.y - 34).toFixed(1)}px)${billboard()}`;
      b.el.querySelector('.bot-fig').style.transform = `scaleX(${b.dir})`;
    }
    return moving;
  }

  // ---------- follow mode: the canvas does what you would do by hand when an agent writes ----------
  let followOn = (() => { try { return localStorage.getItem('wa2.follow') !== '0'; } catch { return true; } })();
  let lastUserAt = 0, lastFollowAt = 0;
  const FOLLOW_GAP = 1400, USER_QUIET = 6000;
  ws.addEventListener('pointerdown', () => { lastUserAt = Date.now(); }, true);
  ws.addEventListener('wheel', () => { lastUserAt = Date.now(); }, { capture: true, passive: true });
  function followTo(e, a, rep) {
    const now = Date.now();
    if (now - lastUserAt < USER_QUIET || now - lastFollowAt < FOLLOW_GAP) return;
    lastFollowAt = now;
    const agentNode = vis.get('a:' + a.key);
    if (READ_TOOLS.has(e.tool)) { ensureVisible([rep, agentNode].filter(Boolean)); return; }
    const n = revealPath(e.file) || rep;
    if (!n) return;
    selectedEdge = null; setSelection([n.id]);
    setTimeout(() => { ensureVisible([n, agentNode].filter(Boolean)); if (view.k < 0.7) centerOn(n, 0.9); }, 60);
    onSelect?.({ kind: n.kind, id: n.id, node: n, data: n.data, auto: true });
  }

  // ---------- frame ----------
  function kick() { if (!raf && visible) raf = requestAnimationFrame(frame); }
  function frame() {
    raf = 0;
    if (!visible) return;
    const now = performance.now();
    let moving = false;
    if (viewAnim) {
      const t = Math.min(1, (now - viewAnim.at) / viewAnim.ms), e = 1 - Math.pow(1 - t, 3);
      view.k = viewAnim.from.k + (viewAnim.to.k - viewAnim.from.k) * e; view.x = viewAnim.from.x + (viewAnim.to.x - viewAnim.from.x) * e; view.y = viewAnim.from.y + (viewAnim.to.y - viewAnim.from.y) * e;
      applyView(); if (t >= 1) viewAnim = null; else moving = true;
    }
    if (animating) {
      for (const n of vis.values()) {
        const dx = n.tx - n.x, dy = n.ty - n.y;
        if (Math.abs(dx) > 0.4 || Math.abs(dy) > 0.4) { n.x += dx * 0.2; n.y += dy * 0.2; moving = true; }
        else if (dx || dy) { n.x = n.tx; n.y = n.ty; }
        n.el.style.transform = `translate(${(n.x - n.w / 2).toFixed(1)}px, ${(n.y - n.h / 2).toFixed(1)}px)`;
      }
      if (bots.size && stepBots(now)) moving = true;
      if (!moving) animating = false;
      edgesDirty = true;
      for (const c of captions.values()) if (c.node) c.el.style.transform = `translate(${c.node.x}px, ${c.node.y - c.node.h / 2 - 22}px) translate(-50%, -100%)${billboard()}`;
    }
    if (edgesDirty) drawEdges();
    if (pulses.length) {
      let html = '';
      pulses = pulses.filter(p => now - p.at < PULSE_MS + 100);
      for (const p of pulses) {
        const t = Math.min(1, (now - p.at) / PULSE_MS), e = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t, posn = p.reverse ? 1 - e : e;
        const pt = p.path.getPointAtLength(posn * p.len);
        html += `<path d="${p.d}" fill="none" stroke="${p.color}" stroke-width="3" stroke-opacity="${(0.8 * (1 - t * 0.6)).toFixed(2)}" stroke-dasharray="60 ${p.len + 60}" stroke-dashoffset="${(-(posn * p.len - 60)).toFixed(1)}" filter="url(#wsg)"/>`;
        html += `<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="${(4 + Math.sin(t * Math.PI) * 3).toFixed(1)}" fill="${p.color}" filter="url(#wsg)"/><circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="2" fill="#fff"/>`;
        if (t >= 1 && !p.done) { p.done = true; flash(p.node); }
      }
      gPulses.innerHTML = html;
    } else if (gPulses.innerHTML) gPulses.innerHTML = '';
    if (minimapOn) drawMinimap();
    if (moving || pulses.length) kick();
  }

  // ---------- relief (2.5D): the plane the world sits on is tilted with CSS perspective ----------
  // Screen <-> plane conversions below keep pan, zoom, drag and marquee exact under the tilt.
  let relief = (() => { try { return localStorage.getItem('wa2.relief') === '1'; } catch { return false; } })();
  const TILT = 36 * Math.PI / 180, PERSP = 1500;
  const billboard = () => relief ? ` rotateX(${-TILT}rad)` : '';
  function applyRelief() {
    ws.classList.toggle('relief', relief);
    tilt.style.transform = relief ? `perspective(${PERSP}px) rotateX(${TILT}rad)` : '';
    hud.querySelector('[data-act="relief"]').classList.toggle('active', relief);
    for (const n of vis.values()) n.el.style.transform = `translate(${(n.x - n.w / 2).toFixed(1)}px, ${(n.y - n.h / 2).toFixed(1)}px)`;
    applyView(); edgesDirty = true; animating = true; kick();
  }
  /** Client coords -> coords on the (untilted) plane that holds the world. */
  function toLayer(cx, cy) {
    const r = ws.getBoundingClientRect(), X = cx - r.left - r.width / 2, Y = cy - r.top - r.height / 2;
    if (!relief) return { u: cx - r.left, v: cy - r.top };
    const sn = Math.sin(TILT), cs = Math.cos(TILT);
    const y = Y * PERSP / (PERSP * cs + Y * sn), sc = PERSP / (PERSP - y * sn);
    return { u: X / sc + r.width / 2, v: y + r.height / 2 };
  }

  // ---------- viewport ----------
  function applyView() {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
    tilt.style.backgroundPosition = `${view.x}px ${view.y}px`;
    tilt.style.backgroundSize = `${40 * view.k}px ${40 * view.k}px`;
    hud.querySelector('.zoom').textContent = `${Math.round(view.k * 100)} %`;
    ws.classList.toggle('far', view.k < 0.45);
    ws.style.setProperty('--k', view.k.toFixed(3));
    if (minimapOn) drawMinimap();
    onViewChange?.();
    save();
  }
  function zoomAt(k, cx, cy) {
    k = Math.max(0.12, Math.min(3, k));
    const wx = (cx - view.x) / view.k, wy = (cy - view.y) / view.k;
    view.k = k; view.x = cx - wx * k; view.y = cy - wy * k;
    applyView(); edgesDirty = true; kick();
  }
  function bounds(list = [...vis.values()]) {
    if (!list.length) return { x0: -200, y0: -200, x1: 200, y1: 200 };
    return { x0: Math.min(...list.map(n => n.tx - n.w / 2)), y0: Math.min(...list.map(n => n.ty - n.h / 2)), x1: Math.max(...list.map(n => n.tx + n.w / 2)), y1: Math.max(...list.map(n => n.ty + n.h / 2)) };
  }
  const PAD0 = { top: 90, right: 60, bottom: 70, left: 60 };
  const pad = () => ({ ...PAD0, ...(insets?.() || {}) });
  function fitView(list) {
    const PAD = pad(), b = bounds(list), W = ws.clientWidth, H = ws.clientHeight;
    const k = Math.max(0.12, Math.min(1.4, Math.min((W - PAD.left - PAD.right) / Math.max(1, b.x1 - b.x0), (H - PAD.top - PAD.bottom) / Math.max(1, b.y1 - b.y0))));
    return { k, x: PAD.left + (W - PAD.left - PAD.right) / 2 - (b.x0 + b.x1) / 2 * k, y: PAD.top + (H - PAD.top - PAD.bottom) / 2 - (b.y0 + b.y1) / 2 * k };
  }
  function fit(list) { Object.assign(view, fitView(list)); applyView(); }
  let viewAnim = null;
  function animateView(to, ms = 380) { viewAnim = { from: { ...view }, to, at: performance.now(), ms }; kick(); }
  /** Bring these nodes on screen (smoothly) if any of them is outside the viewport. */
  function ensureVisible(list) {
    if (!list.length) return;
    const PAD = pad(), b = bounds(list), W = ws.clientWidth, H = ws.clientHeight;
    const sx0 = view.x + b.x0 * view.k, sy0 = view.y + b.y0 * view.k, sx1 = view.x + b.x1 * view.k, sy1 = view.y + b.y1 * view.k;
    if (sx0 >= PAD.left && sy0 >= PAD.top && sx1 <= W - PAD.right && sy1 <= H - PAD.bottom) return;
    const target = fitView(list); target.k = Math.min(target.k, Math.max(view.k, 0.6));
    target.x = PAD.left + (W - PAD.left - PAD.right) / 2 - (b.x0 + b.x1) / 2 * target.k; target.y = PAD.top + (H - PAD.top - PAD.bottom) / 2 - (b.y0 + b.y1) / 2 * target.k;
    animateView(target);
  }
  const childrenOf = id => [...vis.values()].filter(n => n.parent === id);
  function centerOn(n, k = Math.max(view.k, 0.9)) {
    view.k = k; view.x = ws.clientWidth / 2 - n.tx * k; view.y = ws.clientHeight / 2 - n.ty * k; applyView();
  }
  function screenRect(id) {
    const n = vis.get(id); if (!n) return null;
    const r = n.el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }
  /** Screen box of a node together with its visible children (so an inspector can avoid covering them). */
  function clusterRect(id) {
    const n = vis.get(id); if (!n) return null;
    const rects = [n, ...childrenOf(id)].map(m => m.el.getBoundingClientRect());
    const x0 = Math.min(...rects.map(q => q.left)), y0 = Math.min(...rects.map(q => q.top)), x1 = Math.max(...rects.map(q => q.right)), y1 = Math.max(...rects.map(q => q.bottom));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  function drawMinimap() {
    const ctx = minimap.getContext('2d'), W = minimap.width, H = minimap.height;
    ctx.clearRect(0, 0, W, H);
    const b = bounds(); const pad = 20;
    const vx0 = -view.x / view.k, vy0 = -view.y / view.k, vx1 = (ws.clientWidth - view.x) / view.k, vy1 = (ws.clientHeight - view.y) / view.k;
    const X0 = Math.min(b.x0, vx0), Y0 = Math.min(b.y0, vy0), X1 = Math.max(b.x1, vx1), Y1 = Math.max(b.y1, vy1);
    const s = Math.min((W - pad * 2) / (X1 - X0 || 1), (H - pad * 2) / (Y1 - Y0 || 1));
    const ox = (W - (X1 - X0) * s) / 2, oy = (H - (Y1 - Y0) * s) / 2;
    minimap.dataset.map = JSON.stringify({ X0, Y0, s, ox, oy });
    for (const n of vis.values()) { ctx.fillStyle = n.kind === 'agent' ? 'rgba(125,211,252,.9)' : n.kind === 'branch' ? 'rgba(255,255,255,.45)' : 'rgba(200,255,0,.75)'; ctx.fillRect(ox + (n.x - n.w / 2 - X0) * s, oy + (n.y - n.h / 2 - Y0) * s, Math.max(2, n.w * s), Math.max(2, n.h * s)); }
    ctx.strokeStyle = 'rgba(200,255,0,.9)'; ctx.lineWidth = 1; ctx.strokeRect(ox + (vx0 - X0) * s, oy + (vy0 - Y0) * s, (vx1 - vx0) * s, (vy1 - vy0) * s);
  }
  minimap.addEventListener('pointerdown', ev => {
    const m = JSON.parse(minimap.dataset.map || 'null'); if (!m) return;
    const r = minimap.getBoundingClientRect();
    const wx = (ev.clientX - r.left - m.ox) / m.s + m.X0, wy = (ev.clientY - r.top - m.oy) / m.s + m.Y0;
    view.x = ws.clientWidth / 2 - wx * view.k; view.y = ws.clientHeight / 2 - wy * view.k; applyView();
  });

  // ---------- selection & search ----------
  function setSelection(ids, { additive = false } = {}) {
    if (!additive) selection = new Set();
    for (const id of ids) selection.has(id) && additive ? selection.delete(id) : selection.add(id);
    for (const n of vis.values()) n.el.classList.toggle('sel', selection.has(n.id));
    hud.querySelector('[data-act="group"]').classList.toggle('hidden', [...selection].filter(id => vis.has(id)).length < 2);
    drawGroups();
  }
  function applySearch() {
    const q = search.toLowerCase();
    for (const n of vis.values()) {
      const text = n.kind === 'agent' ? `${roleOf(n.data).name} ${n.data.description || ''} ${n.data.file || ''}` : n.kind === 'branch' ? n.data.name : n.data.path || n.data.name || '';
      n.el.classList.toggle('dim', !!q && !text.toLowerCase().includes(q));
    }
    ws.classList.toggle('searching', !!q);
  }
  function revealPath(path) {
    // open every ancestor, and lift the folder / file cap where the target sits past it
    for (let child = path, p = parentPath(path); ; child = p, p = parentPath(p)) {
      expanded.add(p);
      const parent = findNode(state.tree, p), node = parent && (parent.children || []).find(c => c.path === child);
      if (node) {
        if (node.type === 'file') { const files = (parent.children || []).filter(c => c.type === 'file'); if (files.indexOf(node) >= MAX_FILES_SHOWN || (dirKids(parent).dirs.length >= 3 && files.length > 4 && !busy(node.path))) showAll.add(p); }
        else if (!dirKids(parent).dirs.includes(node)) showAll.add(p);
      }
      if (p === '') break;
    }
    sync(); save();
    return vis.get('f:' + path) || vis.get('d:' + path) || (chainOf.has(path) ? vis.get(chainOf.get(path)) : null) || null;
  }

  // ---------- interactions ----------
  let drag = null;
  const capture = ev => { try { ws.setPointerCapture(ev.pointerId); } catch {} };
  const toWorld = (cx, cy) => { const l = toLayer(cx, cy); return { x: (l.u - view.x) / view.k, y: (l.v - view.y) / view.k }; };
  ws.addEventListener('pointerdown', ev => {
    if (ev.button !== 0 && ev.button !== 1) return;
    if (ev.target.closest('.ws-hud, .ws-minimap')) return;
    ws.focus();
    const portEl = ev.target.closest('.ws-port'), nodeEl = ev.target.closest('.ws-node');
    const grpEl = ev.target.closest('.grp');
    const w = toWorld(ev.clientX, ev.clientY);
    if (portEl && nodeEl) { drag = { kind: 'link', from: nodeEl.dataset.id, x: w.x, y: w.y }; capture(ev); ev.preventDefault(); return; }
    if (nodeEl && ev.button === 0) {
      const id = nodeEl.dataset.id;
      const ids = selection.has(id) ? [...selection].filter(i => vis.has(i)) : [id];
      drag = { kind: 'node', id, ids, sx: ev.clientX, sy: ev.clientY, start: ids.map(i => ({ id: i, x: vis.get(i).x, y: vis.get(i).y })), moved: false, shift: ev.shiftKey };
      capture(ev); return;
    }
    if (grpEl && ev.button === 0) {
      const g = groups.find(x => x.id === grpEl.dataset.id); if (!g) return;
      const ids = g.members.filter(i => vis.has(i));
      drag = { kind: 'node', id: g.id, group: g, ids, sx: ev.clientX, sy: ev.clientY, start: ids.map(i => ({ id: i, x: vis.get(i).x, y: vis.get(i).y })), moved: false, shift: ev.shiftKey };
      capture(ev); return;
    }
    if (ev.shiftKey && ev.button === 0) { drag = { kind: 'marquee', x: ev.clientX, y: ev.clientY }; marquee.classList.remove('hidden'); capture(ev); return; }
    drag = { kind: 'pan', x: ev.clientX, y: ev.clientY, l0: toLayer(ev.clientX, ev.clientY), vx: view.x, vy: view.y, moved: false, hit: ev.target.closest('.e-hit') };
    ws.classList.add('panning'); capture(ev);
  });
  ws.addEventListener('pointermove', ev => {
    if (!drag) return;
    if (drag.kind === 'pan') {
      const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      const l = toLayer(ev.clientX, ev.clientY);
      view.x = drag.vx + (l.u - drag.l0.u); view.y = drag.vy + (l.v - drag.l0.v); applyView();
    } else if (drag.kind === 'node') {
      const w0 = toWorld(drag.sx, drag.sy), w1 = toWorld(ev.clientX, ev.clientY), dx = w1.x - w0.x, dy = w1.y - w0.y;
      if (!drag.moved && Math.hypot(ev.clientX - drag.sx, ev.clientY - drag.sy) < 4) return;
      drag.moved = true; ws.classList.add('dragging');
      for (const s of drag.start) { const n = vis.get(s.id); if (!n) continue; n.x = n.tx = s.x + dx; n.y = n.ty = s.y + dy; n.el.style.transform = `translate(${n.x - n.w / 2}px, ${n.y - n.h / 2}px)`; }
      edgesDirty = true; kick(); onViewChange?.();
    } else if (drag.kind === 'marquee') {
      const r = ws.getBoundingClientRect();
      const x0 = Math.min(drag.x, ev.clientX) - r.left, y0 = Math.min(drag.y, ev.clientY) - r.top, x1 = Math.max(drag.x, ev.clientX) - r.left, y1 = Math.max(drag.y, ev.clientY) - r.top;
      Object.assign(marquee.style, { left: `${x0}px`, top: `${y0}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` });
      drag.rect = { x0, y0, x1, y1 };
    } else if (drag.kind === 'link') {
      const w = toWorld(ev.clientX, ev.clientY); const a = vis.get(drag.from);
      gTemp.innerHTML = `<path class="e e-link temp" d="M${a.x},${a.y} L${w.x},${w.y}"/>`;
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.ws-node');
      for (const n of vis.values()) n.el.classList.toggle('target', over === n.el && n.id !== drag.from);
    }
  });
  ws.addEventListener('pointerup', ev => {
    if (!drag) return;
    const d = drag; drag = null; ws.classList.remove('panning', 'dragging');
    if (d.kind === 'pan') {
      if (!d.moved) {
        if (d.hit) { selectedEdge = { kind: d.hit.dataset.k, from: d.hit.dataset.from, to: d.hit.dataset.to }; setSelection([]); edgesDirty = true; kick(); onSelect?.(edgeSelection()); }
        else { selectedEdge = null; setSelection([]); edgesDirty = true; kick(); onSelect?.(null); }
      }
    } else if (d.kind === 'node') {
      const n = vis.get(d.id);
      if (d.moved) { for (const s of d.start) { const m = vis.get(s.id); if (m) pos.set(s.id, { x: m.x, y: m.y, user: true }); } save(); }
      else if (d.group) { setSelection([d.group.id, ...d.group.members], { additive: d.shift }); onSelect?.({ kind: 'group', group: d.group }); }
      else if (n) click(n, d.shift);
    } else if (d.kind === 'marquee') {
      marquee.classList.add('hidden');
      if (d.rect) {
        const r = ws.getBoundingClientRect(); const ids = [];
        for (const n of vis.values()) { const s = screenRect(n.id); const x = s.x - r.left, y = s.y - r.top; if (x < d.rect.x1 && x + s.w > d.rect.x0 && y < d.rect.y1 && y + s.h > d.rect.y0) ids.push(n.id); }
        setSelection(ids, { additive: true });
      }
    } else if (d.kind === 'link') {
      gTemp.innerHTML = '';
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.ws-node');
      for (const n of vis.values()) n.el.classList.remove('target');
      if (over && over.dataset.id !== d.from && !links.some(l => (l.from === d.from && l.to === over.dataset.id) || (l.from === over.dataset.id && l.to === d.from))) {
        links.push({ id: 'l' + Date.now().toString(36), from: d.from, to: over.dataset.id }); save(); edgesDirty = true; kick();
      }
    }
  });
  ws.addEventListener('wheel', ev => {
    ev.preventDefault();
    const l = toLayer(ev.clientX, ev.clientY);
    if (ev.ctrlKey || !ev.shiftKey) zoomAt(view.k * Math.exp(-ev.deltaY * 0.0015), l.u, l.v);
    else { view.x -= ev.deltaY; applyView(); }
  }, { passive: false });
  ws.addEventListener('dblclick', ev => { const nodeEl = ev.target.closest('.ws-node'); if (nodeEl) { const n = vis.get(nodeEl.dataset.id); if (n) centerOn(n, 1.1); } });
  ws.addEventListener('keydown', ev => {
    if (ev.target !== ws) return;
    const k = ev.key.toLowerCase();
    if (k === 'f') fit();
    else if (k === 'm') toggleMinimap();
    else if (k === 't') setRelief(!relief);
    else if (k === 'r') autoLayout();
    else if (k === 'g') groupSelection();
    else if (k === '+' || k === '=') zoomAt(view.k * 1.2, ws.clientWidth / 2, ws.clientHeight / 2);
    else if (k === '-') zoomAt(view.k / 1.2, ws.clientWidth / 2, ws.clientHeight / 2);
    else if (k === 'delete' || k === 'backspace') removeSelected();
    else if (k === 'escape') { selectedEdge = null; setSelection([]); edgesDirty = true; kick(); onSelect?.(null); }
    else return;
    ev.preventDefault();
  });
  hud.addEventListener('click', ev => {
    const b = ev.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act, cx = ws.clientWidth / 2, cy = ws.clientHeight / 2;
    if (act === 'fit') fit(); else if (act === 'layout') autoLayout(); else if (act === 'minimap') toggleMinimap(); else if (act === 'relief') setRelief(!relief); else if (act === 'group') groupSelection();
    else if (act === 'zoom+') zoomAt(view.k * 1.25, cx, cy); else if (act === 'zoom-') zoomAt(view.k / 1.25, cx, cy); else if (act === 'zoom1') zoomAt(1, cx, cy);
  });
  function setRelief(on) { relief = !!on; try { localStorage.setItem('wa2.relief', relief ? '1' : '0'); } catch { /* ignore */ } applyRelief(); }
  function toggleMinimap() { minimapOn = !minimapOn; minimap.classList.toggle('hidden', !minimapOn); hud.querySelector('[data-act="minimap"]').classList.toggle('active', minimapOn); if (minimapOn) drawMinimap(); }
  function groupSelection() {
    const members = [...selection].filter(id => vis.has(id) && !id.startsWith('g:')); if (members.length < 2) return;
    const g = { id: 'g:' + Date.now().toString(36), name: `Group ${groups.length + 1}`, members };
    groups.push(g); save(); setSelection([g.id, ...members]); drawGroups(); onSelect?.({ kind: 'group', group: g });
  }
  function removeSelected() {
    const gs = [...selection].filter(id => id.startsWith('g:'));
    if (gs.length) { groups = groups.filter(g => !gs.includes(g.id)); setSelection([]); save(); drawGroups(); onSelect?.(null); return; }
    if (selectedEdge?.kind === 'link') { links = links.filter(l => !(l.from === selectedEdge.from && l.to === selectedEdge.to)); selectedEdge = null; save(); edgesDirty = true; kick(); onSelect?.(null); }
  }
  function edgeSelection() {
    if (!selectedEdge) return null;
    const e = edges.find(x => x.kind === selectedEdge.kind && x.from.id === selectedEdge.from && x.to.id === selectedEdge.to);
    return e ? { kind: 'edge', edge: e } : null;
  }
  function click(n, shift) {
    if (shift) { setSelection([n.id], { additive: true }); return; }
    selectedEdge = null;
    setSelection([n.id]);
    if (n.kind === 'dir') { const p = n.data.path; const open = !expanded.has(p); open ? expanded.add(p) : collapse(p); sync(); save(); if (open) setTimeout(() => ensureVisible([n, ...childrenOf(n.id)]), 40); }
    else if (n.kind === 'more') { showAll.add(n.data.path); sync(); save(); return; }
    else if (n.kind === 'file') { openSymbols.has(n.data.path) ? openSymbols.delete(n.data.path) : openSymbols.add(n.data.path); if (openSymbols.has(n.data.path) && !symbols.has(n.data.path)) loadSymbols(n.data.path); else sync(); }
    else if (n.kind === 'symbol') { openRefs.has(n.id) ? openRefs.delete(n.id) : openRefs.add(n.id); if (openRefs.has(n.id) && !refs.has(n.id)) loadRefs(n); else sync(); }
    onSelect?.({ kind: n.kind, id: n.id, node: n, data: n.data });
  }
  function collapse(p) {
    expanded.delete(p);
    for (const q of [...expanded]) if (q !== '' && under(q, p) && q !== p) expanded.delete(q);
    for (const q of [...openSymbols]) if (under(q, p)) openSymbols.delete(q);
  }
  async function loadSymbols(path) {
    try { const r = await fetch(`/api/symbols?path=${encodeURIComponent(path)}`); const j = await r.json(); symbols.set(path, j.symbols || []); } catch { symbols.set(path, []); }
    sync();
    const n = vis.get('f:' + path);
    if (n) { if (selection.has(n.id)) onSelect?.({ kind: 'file', id: n.id, node: n, data: n.data }); setTimeout(() => ensureVisible([n, ...childrenOf(n.id)]), 40); }
  }
  async function loadRefs(n) {
    try { const r = await fetch(`/api/refs?q=${encodeURIComponent(n.data.name)}&limit=200`); const j = await r.json(); refs.set(n.id, (j.refs || []).filter(x => x.file !== n.data.file)); } catch { refs.set(n.id, []); }
    sync(); onSelect?.({ kind: 'symbol', id: n.id, node: n, data: n.data });
    setTimeout(() => ensureVisible([n, ...(refs.get(n.id) || []).map(r => repOf(r.file)).filter(Boolean)]), 40);
  }

  const ro = new ResizeObserver(() => { if (visible) { applyView(); } });
  ro.observe(ws);

  // ---------- public API ----------
  return {
    update(s) {
      const first = !state;
      state = s;
      if (first && s.hello?.repo) { storeKey = `wa2.ws.${s.hello.repo}`; load(); }
      sync();
      if (!savedView && vis.size) { savedView = true; autoFitUntil = Date.now() + 4000; setTimeout(() => fit(), 30); }
    },
    show(s) { visible = true; if (s) { state = s; } if (state?.tree && !vis.size) sync(); applyRelief(); kick(); },
    hide() { visible = false; cancelAnimationFrame(raf); raf = 0; },
    resize() { applyView(); },
    /** Data changed (agents, git, tasks, hot): re-render cards, re-anchor idle-placed agents. */
    refresh(s) {
      if (s) state = s;
      if (!state?.tree) return;
      sync();
      for (const n of vis.values()) if (n.kind === 'agent' && !pos.get(n.id)?.user) anchorAgent(n, false);
      syncBots();
      animating = true; kick();
    },
    pulse(path, s) {
      if (s) state = s;
      const rep = repOf(path); if (!rep) return;
      const n = findNode(state.tree, path); if (n?.type === 'dir') return;
      fire(null, rep, { weak: true, caption: `file changed · ${path.split('/').pop()}` });
      this.refresh();
    },
    agentEvent(e, a, s) {
      if (s) state = s;
      const who = roleOf(a).name, agentNode = vis.get('a:' + a.key);
      if (e.file) {
        const rep = repOf(e.file); if (!rep) return;
        const read = READ_TOOLS.has(e.tool);
        fire(agentNode || null, rep, { color: e.isError ? cssVar('--red', '#ff4d5e') : read ? cssVar('--blue', '#7dd3fc') : cssVar('--lime', '#c8ff00'), reverse: false, caption: `${who} ${VERB[e.tool] || 'uses'} ${e.file.split('/').pop()}` });
        botGo(a, rep, read ? 'read' : 'work');
        if (followOn && e.phase === 'start') followTo(e, a, rep);
      } else if (e.phase === 'start' && agentNode) {
        if (e.tool === 'Bash' || e.tool === 'PowerShell') showCaption(agentNode, `${who} runs: ${(e.detail || '').slice(0, 40)}`);
        else if (e.tool === 'Agent') showCaption(agentNode, `${who} delegates: ${(e.detail || '').slice(0, 40)}`);
      }
      this.refresh();
    },
    search(q) { search = q || ''; applySearch(); },
    /** Enter in the search box: reveal and centre the first match. */
    searchGo(q) {
      if (!q || !state?.tree) return;
      const ql = q.toLowerCase(); let hit = null;
      const walk = n => { if (hit) return; if (n.path && n.path.toLowerCase().includes(ql)) { hit = n; return; } for (const c of n.children || []) walk(c); };
      walk(state.tree);
      if (!hit) return;
      const node = hit.type === 'file' ? revealPath(hit.path) : (expanded.add(parentPath(hit.path)), revealPath(hit.path + '/x'), vis.get('d:' + hit.path));
      if (node) { setSelection([node.id]); setTimeout(() => centerOn(node, Math.max(view.k, 0.9)), 50); onSelect?.({ kind: node.kind, id: node.id, node, data: node.data }); }
    },
    focus(pathOrId) {
      if (/^[ab]:/.test(pathOrId) && !vis.has(pathOrId)) { pinned.add(pathOrId); sync(); }
      const n = vis.get(pathOrId) || (/^[ab]:/.test(pathOrId) ? null : revealPath(pathOrId));
      if (n) { selectedEdge = null; setSelection([n.id]); centerOn(n); onSelect?.({ kind: n.kind, id: n.id, node: n, data: n.data }); }
    },
    screenRect, clusterRect, fit, autoLayout, ensureVisible,
    /** Follow mode: when an agent writes a file, reveal + select it as if you had clicked. */
    relief: () => relief, setRelief,
    follow: () => followOn,
    setFollow(on) { followOn = !!on; try { localStorage.setItem('wa2.follow', followOn ? '1' : '0'); } catch { /* ignore */ } },
    symbolsFor: path => symbols.get(path),
    refsFor: id => refs.get(id),
    edges: () => edges,
    groups: () => groups,
    renameGroup(id, name) { const g = groups.find(x => x.id === id); if (g) { g.name = name; save(); drawGroups(); } },
    removeLink(from, to) { links = links.filter(l => !(l.from === from && l.to === to)); save(); edgesDirty = true; kick(); },
    dispose() { ro.disconnect(); cancelAnimationFrame(raf); },
  };
}
