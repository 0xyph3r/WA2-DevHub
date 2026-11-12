// Left sliding panel: navigation, project card and the detail
// sections that used to live in the drawer (agents, activity, current file,
// tasks, git branches, metrics, project tree). Opened on demand, every
// section is a collapsible <details>; open/closed state is remembered.
import { icon, applyIcons } from './icons.js';
import { roleOf } from './roles.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtTime = at => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const ago = at => { const s = Math.max(0, Math.round((Date.now() - at) / 1000)); return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
const dur = ms => ms == null ? '-' : ms < 1000 ? `${ms} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)} min ${Math.round(ms % 60000 / 1000)} s`;

const KW = /\b(import|export|from|const|let|var|function|return|if|else|for|while|class|extends|new|await|async|try|catch|throw|default|switch|case|break|continue|typeof|instanceof|this|null|undefined|true|false|def|pub|fn|struct|impl|use|mod|match|enum|interface|type|public|private|static|void|int|string|bool)\b/g;
const TOKEN = new RegExp(`(\\/\\/.*$|#.*$)|(&quot;.*?&quot;|&#39;.*?&#39;|\`.*?\`)|(&lt;\\/?[A-Za-z][\\w.-]*)|${KW.source}|(?<![&#\\w])\\b(\\d+(?:\\.\\d+)?)\\b`, 'g');
const highlight = line => esc(String(line).replace(/\r$/, '')).replace(TOKEN, (m, c, s, tg, k, n) => c ? `<span class="c">${c}</span>` : s ? `<span class="s">${s}</span>` : tg ? `<span class="tg">${tg}</span>` : k ? `<span class="k">${k}</span>` : `<span class="n">${n}</span>`);

const VERBS = {
  Edit: ['edits', 'edit'], MultiEdit: ['edits', 'edit'], Write: ['writes', 'file'], NotebookEdit: ['edits', 'edit'],
  Read: ['reads', 'eye'], Bash: ['runs', 'terminal'], PowerShell: ['runs', 'terminal'], Grep: ['searches', 'search'], Glob: ['searches', 'search'],
  Agent: ['delegates to an agent', 'agents'], TodoWrite: ['plans', 'tasks'], TaskCreate: ['creates a task', 'tasks'], TaskUpdate: ['updates a task', 'tasks'],
  WebFetch: ['fetches the web', 'globe'], WebSearch: ['searches the web', 'globe'],
};

// Navigation entries. Only things backed by real data: no database / API /
// deployment / monitoring pages, since the server has nothing to show there.
const NAV = [
  { id: 'overview', icon: 'home', label: 'Overview' },
  { id: 'stack', icon: 'layers', label: '3D architecture' },
  { id: 'city', icon: 'modules', label: 'Exploded 3D' },
  { id: 'structure', icon: 'folder', label: 'Modules & files' },
  { id: 'agents', icon: 'agents', label: 'AI agents' },
  { id: 'tasks', icon: 'tasks', label: 'Tasks' },
  { id: 'git', icon: 'git', label: 'Branches (Git)' },
  { id: 'metrics', icon: 'tests', label: 'Tests & Quality' },
  { id: 'live', icon: 'play', label: 'Live app' },
  { id: 'settings', icon: 'settings', label: 'Settings' },
];
const SECTIONS = ['agents', 'activity', 'file', 'tasks', 'git', 'metrics', 'structure'];

export function createSidebar(el, { getState, canvas, showView, openSettings, openModal, closeModal, toast, onToggle }) {
  const $ = (sel, root = el) => root.querySelector(sel);
  const pref = (() => { try { return JSON.parse(localStorage.getItem('wa2.side') || '{}'); } catch { return {}; } })();
  const savePref = () => { try { localStorage.setItem('wa2.side', JSON.stringify(pref)); } catch { /* storage may be unavailable */ } };
  const open = new Set(pref.sections || ['agents', 'activity', 'structure']);
  let expanded = new Set(['']), selected = null, fileShown = null;

  el.innerHTML = `
    <div class="side-head">
      <span class="brand-logo" data-icon="cube"></span>
      <div class="side-title">WA2 <span class="brand-sub">DevHub</span></div>
      <button class="icon-btn sm" id="sideClose" title="Close the panel (Ctrl+B)"><span data-icon="close"></span></button>
    </div>
    <ul class="sidenav" id="sideNav">${NAV.map(n => `<li data-nav="${n.id}"><span data-icon="${n.icon}"></span>${esc(n.label)}</li>`).join('')}</ul>
    <div class="project-card">
      <div class="project-name" id="cardName">-</div>
      <div class="project-status"><span class="dot dot-lime"></span><span id="cardStatus">Waiting</span></div>
      <div class="progress-row"><div class="progress"><div class="progress-fill" id="cardProgress" style="width:0%"></div></div><span class="progress-pct" id="cardPct">0 %</span></div>
      <div class="project-meta"><span id="cardVersion"></span><span id="cardAgents">0 active agents</span></div>
      <div class="sys-tiles">
        <div class="sys-tile" title="This computer's CPU load"><div class="sys-label">CPU</div><div class="sys-value" id="sysCpu">-</div></div>
        <div class="sys-tile" title="This computer's memory in use"><div class="sys-label">RAM</div><div class="sys-value" id="sysRam">-</div></div>
      </div>
    </div>
    <div class="side-body">
      <details class="panel" data-sec="agents"><summary><h2>${icon('agents')}AI agents <span class="count" id="agentsCount">(0)</span></h2><span class="pill pill-live"><span class="dot dot-lime"></span>Live</span></summary><ul class="agent-list" id="agentList"></ul></details>
      <details class="panel" data-sec="activity"><summary><h2>${icon('activity')}Live activity</h2><span class="pill pill-red"><span class="dot dot-red"></span>Live</span></summary><ul class="activity" id="activity"></ul></details>
      <details class="panel" data-sec="file"><summary><h2>${icon('file')}Current file</h2><span class="pill pill-lime" id="fileBy">-</span></summary><div class="file-path" id="filePath">${icon('code')}<span>No file modified yet</span></div><pre class="code" id="fileCode"></pre></details>
      <details class="panel" data-sec="tasks"><summary><h2>${icon('tasks')}Tasks <span class="count" id="tasksCount">(0)</span></h2></summary><ul class="tasks" id="tasks"></ul></details>
      <details class="panel" data-sec="git"><summary><h2>${icon('git')}Git branches</h2></summary><ul class="branches" id="branches"></ul><button class="ghost-btn" id="btnNewBranch">${icon('plus')}New branch</button></details>
      <details class="panel" data-sec="metrics"><summary><h2>${icon('metrics')}Metrics &amp; Quality</h2></summary><div class="metrics" id="metrics"></div></details>
      <details class="panel" data-sec="structure"><summary><h2>${icon('folder')}Project tree</h2>
        <span class="head-actions"><button class="icon-btn sm" id="btnTreeExpand" title="Expand all">${icon('plus')}</button><button class="icon-btn sm" id="btnTreeCollapse" title="Collapse all">${icon('minus')}</button></span></summary><div class="tree" id="tree"></div></details>
    </div>`;
  applyIcons(el);
  for (const d of el.querySelectorAll('details')) {
    d.open = open.has(d.dataset.sec);
    d.addEventListener('toggle', () => { d.open ? open.add(d.dataset.sec) : open.delete(d.dataset.sec); pref.sections = [...open]; savePref(); });
  }
  // buttons inside <summary> must not toggle the section
  el.querySelectorAll('summary .head-actions').forEach(h => h.addEventListener('click', ev => ev.preventDefault()));

  // ---------- open / close ----------
  function isOpen() { return !el.classList.contains('hidden'); }
  function setOpen(on) {
    el.classList.toggle('hidden', !on);
    document.getElementById('app').classList.toggle('side-open', on);
    pref.open = on; savePref();
    onToggle?.(on);
    if (on) render();
  }
  $('#sideClose').onclick = () => setOpen(false);

  function showSection(id) {
    setOpen(true);
    const d = el.querySelector(`details[data-sec="${id}"]`); if (!d) return;
    d.open = true;
    setTimeout(() => d.scrollIntoView({ block: 'start', behavior: 'smooth' }), 30);
  }

  // ---------- nav ----------
  $('#sideNav').addEventListener('click', ev => {
    const li = ev.target.closest('li[data-nav]'); if (!li) return;
    const id = li.dataset.nav, s = getState();
    switch (id) {
      case 'overview': showView('canvas'); canvas.fit(); break;
      case 'stack': case 'city': showView(id); break;
      case 'structure': showView('canvas'); showSection('structure'); break;
      case 'agents': case 'tasks': case 'git': case 'metrics': showSection(id); break;
      case 'live': showView('canvas'); if (s.hello.app) canvas.focus('app'); else { toast('No application URL: set it in Settings or with /wa2 app <url>'); openSettings(); } break;
      case 'settings': openSettings(); break;
    }
    markNav(id);
  });
  function markNav(active) {
    const s = getState();
    const cur = active || (s.view === 'canvas' ? 'overview' : s.view);
    el.querySelectorAll('#sideNav li').forEach(li => li.classList.toggle('active', li.dataset.nav === cur));
  }

  // ---------- renderers ----------
  function renderCard() {
    const s = getState();
    const name = s.hello.name || 'Project';
    $('#cardName').textContent = name;
    $('#cardVersion').textContent = s.hello.version ? `v${s.hello.version} · ` : '';
    const active = [...s.agents.values()].filter(a => a.status === 'active' && Date.now() - (a.lastAt || 0) < 120000).length;
    $('#cardAgents').textContent = `${active} active agent${active === 1 ? '' : 's'}`;
    const done = s.tasks.filter(t => t.status === 'completed').length;
    const pct = s.tasks.length ? Math.round(done / s.tasks.length * 100) : 0;
    $('#cardProgress').style.width = `${pct}%`;
    $('#cardPct').textContent = s.tasks.length ? `${pct} %` : '-';
    $('#cardStatus').textContent = active ? 'In development' : s.git.changes?.length ? 'Local changes' : s.tree ? 'Stable' : 'Waiting';
    $('#sysCpu').textContent = s.sys.cpu == null ? '-' : `${s.sys.cpu} %`;
    $('#sysRam').textContent = s.sys.ram == null ? '-' : `${s.sys.ram} %`;
  }

  function renderAgents() {
    const s = getState();
    const list = [...s.agents.values()].sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
    const q = s.search.toLowerCase();
    const shown = list.filter(a => !q || `${a.description} ${a.agentType} ${roleOf(a).name}`.toLowerCase().includes(q));
    $('#agentsCount').textContent = `(${list.length})`;
    const total = list.reduce((t, a) => t + (a.calls || 0), 0) || 1;
    $('#agentList').innerHTML = shown.length ? shown.slice(0, 30).map(a => {
      const r = roleOf(a), on = a.status === 'active' && Date.now() - (a.lastAt || 0) < 120000;
      const pct = Math.round((a.calls || 0) / total * 100), calls = a.calls || 0;
      return `<li data-key="${esc(a.key)}" title="Show on the canvas">
        <div class="agent-avatar ${on ? '' : 'idle'}">${icon(r.icon)}</div>
        <div><div class="agent-name">${esc(r.name)}${a.branch ? ` <small class="agent-branch">${esc(a.branch)}</small>` : ''}</div><div class="agent-desc" title="${esc(a.description || a.agentType || '')}">${esc(a.description || a.agentType || (a.tool ? a.tool : '-'))}</div></div>
        <div class="agent-bar" title="${pct} % of all tool calls"><span class="agent-pct">${calls} call${calls === 1 ? '' : 's'}</span><div class="progress"><div class="progress-fill" style="width:${pct}%"></div></div></div>
      </li>`;
    }).join('') : `<li class="empty">No agents yet. Run <code>/wa2</code> in Claude Code, or plug in another tool through <code>adapters/</code>: every session and sub-agent shows up here.</li>`;
  }
  $('#agentList').addEventListener('click', ev => { const li = ev.target.closest('li[data-key]'); if (li) { showView('canvas'); canvas.focus('a:' + li.dataset.key); } });

  function describe(e) {
    const s = getState();
    if (e.type === 'fs') return { icon: e.kind === 'remove' ? 'close' : 'file', html: `<b>File</b> ${e.kind === 'remove' ? 'deleted' : 'changed'}: <code>${esc(e.path)}</code>` };
    if (e.type === 'agent') return { icon: 'agents', html: `<b>${esc(roleOf({ agent: e.agent, agentType: e.agentType, description: e.description }).name)}</b> ${e.phase === 'spawn' ? 'starts' : 'finishes'}: ${esc(e.description || e.agentType || '')}` };
    const a = s.agents.get(`${e.session}:${e.agent}`) || { agent: e.agent };
    const [verb, ic] = VERBS[e.tool] || ['uses ' + e.tool, 'zap'];
    const target = e.file ? `<code>${esc(e.file)}</code>` : e.detail ? `<code>${esc(String(e.detail).slice(0, 80))}</code>` : '';
    return { icon: ic, html: `<b>${esc(roleOf(a).name)}</b> ${e.isError ? 'fails: ' : esc(verb)} ${target}`.trim() };
  }
  function renderActivity() {
    const s = getState(), q = s.search.toLowerCase();
    const items = s.events.slice(-80).reverse().filter(e => !q || JSON.stringify(e).toLowerCase().includes(q)).slice(0, 40);
    $('#activity').innerHTML = items.length ? items.map(e => {
      const d = describe(e);
      return `<li class="${e.isError ? 'err' : ''}" ${e.file || e.path ? `data-path="${esc(e.file || e.path)}"` : ''}><span class="t">${fmtTime(e.at)}</span><span class="ic">${icon(d.icon)}</span><span class="m">${d.html}</span></li>`;
    }).join('') : `<li class="empty">Waiting for activity…</li>`;
  }
  $('#activity').addEventListener('click', ev => { const li = ev.target.closest('li[data-path]'); if (li) selectPath(li.dataset.path, true); });

  async function loadFile(path, by) {
    fileShown = path;
    try {
      const r = await fetch(`/api/file?path=${encodeURIComponent(path)}&limit=120`);
      if (!r.ok) throw new Error(r.status);
      const f = await r.json();
      if (fileShown !== path) return;
      $('#filePath').innerHTML = `${icon('code')}<span title="${esc(path)}">${esc(path)}</span>`;
      $('#fileBy').textContent = by ? `Modified by ${roleOf(by).name}` : 'Selection';
      $('#fileCode').innerHTML = f.lines.map((l, i) => `<div><span class="ln">${i + 1}</span>${highlight(l)}</div>`).join('') || '<span class="empty">Empty file</span>';
    } catch {
      $('#filePath').innerHTML = `${icon('code')}<span>${esc(path)}</span>`;
      $('#fileCode').innerHTML = `<span class="empty">Preview unavailable</span>`;
    }
  }

  function findNode(tree, path) {
    if (!tree) return null;
    if (path === '' || path === tree.path) return tree;
    for (const c of tree.children || []) {
      if (c.path === path) return c;
      if (c.type === 'dir' && path.startsWith(c.path + '/')) return findNode(c, path);
    }
    return null;
  }
  function renderTree() {
    const s = getState(), root = s.tree;
    if (!root) { $('#tree').innerHTML = `<div class="empty">Reading the project tree…</div>`; return; }
    const q = s.search.toLowerCase();
    const matches = node => q && node.path.toLowerCase().includes(q);
    const anyMatch = node => matches(node) || (node.children || []).some(anyMatch);
    const render = (node, depth) => {
      const isDir = node.type === 'dir';
      const isOpen = expanded.has(node.path) || (q && anyMatch(node));
      if (q && !anyMatch(node)) return '';
      const name = node.path === '' ? `${root.name}/` : isDir ? `${node.name}/` : node.name;
      const hot = (Date.now() - (s.hot.get(node.path) || 0)) < 15000;
      let html = `<div class="node ${isDir ? 'dir' : 'file'} ${hot ? 'hot' : ''} ${matches(node) ? 'match' : ''} ${selected === node.path ? 'sel' : ''}" data-path="${esc(node.path)}" style="padding-left:${6 + depth * 14}px">
        <span class="ar">${isDir ? icon(isOpen ? 'chevron-down' : 'chevron-right') : ''}</span>
        <span class="fi">${icon(isDir ? (isOpen ? 'folder-open' : 'folder') : 'file')}</span><span>${esc(name)}</span></div>`;
      if (isDir && isOpen) html += (node.children || []).map(c => render(c, depth + 1)).join('');
      return html;
    };
    $('#tree').innerHTML = render(root, 0);
  }
  $('#tree').addEventListener('click', ev => {
    const n = ev.target.closest('.node'); if (!n) return;
    const path = n.dataset.path, node = findNode(getState().tree, path);
    if (node?.type === 'dir') { expanded.has(path) ? expanded.delete(path) : expanded.add(path); }
    selectPath(path, false);
    showView('canvas'); canvas.focus(path);
  });
  $('#btnTreeExpand').onclick = ev => { ev.preventDefault(); const walk = n => { if (n.type === 'dir') { expanded.add(n.path); (n.children || []).forEach(walk); } }; if (getState().tree) walk(getState().tree); renderTree(); };
  $('#btnTreeCollapse').onclick = ev => { ev.preventDefault(); expanded = new Set(['']); renderTree(); };

  /** Sync the tree + file preview with a path selected elsewhere (canvas, activity). */
  function selectPath(path, reveal) {
    selected = path;
    const node = findNode(getState().tree, path);
    for (let p = path; p; p = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '') expanded.add(p.includes('/') || node?.type === 'dir' ? p : (p === path && node?.type === 'file' ? '' : p));
    expanded.add('');
    if (node?.type === 'file') { loadFile(path, null); if (reveal) { const d = el.querySelector('details[data-sec="file"]'); if (d) d.open = true; } }
    renderTree();
    if (reveal) el.querySelector(`.tree .node[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  function renderTasks() {
    const s = getState(), order = { in_progress: 0, pending: 1, completed: 2 };
    const list = [...s.tasks].sort((a, b) => (order[a.status] ?? 1) - (order[b.status] ?? 1) || b.at - a.at);
    $('#tasksCount').textContent = `(${list.length})`;
    $('#tasks').innerHTML = list.length ? list.slice(0, 20).map(t => {
      const cls = t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'doing' : '';
      const label = t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'in progress' : 'to do';
      return `<li class="${cls}"><span class="ck">${t.status === 'completed' ? icon('check') : ''}</span><span class="lbl" title="${esc(t.subject)}">${esc(t.subject)}</span>
        <span class="tr"><span class="pct">${label}</span></span></li>`;
    }).join('') : `<li class="empty">No tasks. Agents' TodoWrite / TaskCreate lists show up here.</li>`;
  }

  function renderGit() {
    const g = getState().git;
    if (!g.repo) { $('#branches').innerHTML = `<li class="empty">No git repository in this folder.</li>`; return; }
    const changedIn = g.changes.length;
    $('#branches').innerHTML = g.branches.map(b => `<li class="${b.current ? 'current' : ''}" data-branch="${esc(b.name)}" title="${esc(b.health ? b.health.checks.map(c => `${c.label}: ${c.detail}`).join('\n') : 'Show on the canvas')}"><i class="hdot ${b.health?.level || 'na'}"></i><span class="nm" title="${esc(b.name)}">${esc(b.name)}</span>
      ${b.current && changedIn ? `<span class="chg">${changedIn} file${changedIn > 1 ? 's' : ''} modified</span>` : ''}
      ${b.name === g.base ? `<span class="chg">base</span>` : b.merged ? `<span class="chg" title="Every commit is in ${esc(g.base)}">merged</span>` : ''}
      <span class="ab"><span class="up">↑ ${b.ahead}</span><span class="dn">↓ ${b.behind}</span></span></li>`).join('') || `<li class="empty">No branches.</li>`;
  }
  $('#branches').addEventListener('click', ev => { const li = ev.target.closest('li[data-branch]'); if (li) { showView('canvas'); canvas.focus('b:' + li.dataset.branch); } });
  $('#btnNewBranch').onclick = () => {
    openModal('New branch', `<p>WA2 observes without changing your repository. To create a branch, in your terminal:</p>
      <label>Name</label><input id="nbName" placeholder="feature/my-feature">
      <p><code id="nbCmd">git checkout -b feature/my-feature</code></p>
      <div class="row"><button class="btn" id="nbCopy">Copy the command</button></div>`);
    const inp = document.getElementById('nbName'), cmd = document.getElementById('nbCmd');
    inp.oninput = () => cmd.textContent = `git checkout -b ${inp.value || 'feature/my-feature'}`;
    document.getElementById('nbCopy').onclick = () => { navigator.clipboard?.writeText(cmd.textContent); toast('Command copied'); closeModal(); };
  };

  function ringHtml(pct, label, bad) {
    const r = 36, c = 2 * Math.PI * r, p = Math.max(0, Math.min(100, pct ?? 0));
    return `<div class="ring"><svg viewBox="0 0 84 84"><circle class="bgc" cx="42" cy="42" r="${r}"/><circle class="fgc ${bad ? 'bad' : ''}" cx="42" cy="42" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - p / 100)}"/></svg><div class="val">${label}</div></div>`;
  }
  function renderMetrics() {
    const s = getState(), m = s.metrics;
    const tile = (title, ok, ring, sub) => `<div class="metric"><div class="mt ${ok === false ? 'bad' : ''}">${title} ${ok == null ? '' : icon(ok ? 'check-circle' : 'close')}</div>${ring}<div class="sub" title="${esc(sub)}">${esc(sub)}</div></div>`;
    const b = m.build, t = m.test, c = m.coverage;
    $('#metrics').innerHTML =
      tile('Build', b ? b.ok : null, ringHtml(b ? 100 : 0, b ? dur(b.durationMs) : '-', b && !b.ok), b ? `${ago(b.at)} · ${b.command}` : 'No build detected') +
      tile('Tests', t ? t.ok : null, ringHtml(t ? 100 : 0, t ? (t.ok ? 'OK' : 'KO') : '-', t && !t.ok), t ? `${ago(t.at)} · ${t.command}` : 'No tests detected') +
      tile('Coverage', null, ringHtml(c?.pct ?? 0, c ? `${Math.round(c.pct)} %` : '-'), c ? 'coverage/coverage-summary.json' : 'No coverage report') +
      tile('WA2 latency', null, ringHtml(s.perfMs == null ? 0 : Math.max(5, 100 - s.perfMs / 5), s.perfMs == null ? '-' : `${s.perfMs} ms`), 'Round trip to the WA2 server, not your app');
  }

  let raf = 0;
  /** Re-render everything (cheap: only when the panel is visible). */
  function render() {
    if (!isOpen()) return;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { renderCard(); renderAgents(); renderActivity(); renderTasks(); renderGit(); renderMetrics(); renderTree(); markNav(); });
  }
  /** Called on fresh tool events: show the file being written by an agent. */
  function fileTouched(path, by) {
    if (!isOpen() || !path) return;
    const d = el.querySelector('details[data-sec="file"]');
    if (d?.open && fileShown !== path) loadFile(path, by);
  }

  if (pref.open) setOpen(true);
  return { toggle: () => setOpen(!isOpen()), open: () => setOpen(true), close: () => setOpen(false), isOpen, render, selectPath, fileTouched, showSection };
}
