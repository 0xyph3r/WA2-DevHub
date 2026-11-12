// WA2 client: state, event stream, top bar. The workspace itself is
// views/canvas.js; the floating inspector is inspector.js; the two optional
// 3D views (architecture stack, exploded city) live in views/.
import { applyIcons } from './icons.js';
import { createCanvas } from './views/canvas.js';
import { createInspector } from './inspector.js';
import { createStack } from './views/stack.js';
import { createCity } from './views/city.js';
import { createSidebar } from './sidebar.js';
import { createControlTray, setGate, GATES_ORDER, GATE_LABELS, collisionText, agentName, approvalText } from './control.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const state = {
  hello: { repo: '', name: '', app: '', version: '' },
  tree: null,
  deps: null,          // { nodes, edges, files, externals }
  agents: new Map(),
  events: [],          // tool / agent / fs events, newest last
  tasks: [],
  approvals: [],       // tool calls held on the canvas (gate)
  collisions: [],      // agents on the same file / folder
  gate: 'off',
  metrics: { build: null, test: null, coverage: null },
  sys: { cpu: null, ram: null },
  perfMs: null,
  git: { repo: false, branches: [], changes: [], commits: {}, conflicts: [], merged: [] },
  hot: new Map(),      // repo path -> last touched at
  search: '',
  view: 'canvas',
  lastEventAt: 0,
};

// ---------- views ----------
const views = {};
let inspector, sidebar, tray;
function initViews() {
  views.canvas = createCanvas($('#view-canvas'), { onSelect: onCanvasSelect, onViewChange: () => inspector.position(), insets: () => ({ ...(inspector.current() ? { right: 400 } : {}), ...(sidebar?.isOpen() ? { left: 340 } : {}) }) });
  inspector = createInspector($('#app'), { getState: () => state, canvas: views.canvas, onClose: () => {}, toast });
  tray = createControlTray($('#app'), { getState: () => state, focus: p => { showView('canvas'); views.canvas.focus(p); }, toast });
  views.stack = createStack($('#view-stack'), { onSelect: path => views.canvas.focus(path) });
  views.city = createCity($('#view-city'), { onSelect: path => { showView('canvas'); views.canvas.focus(path); } });
  sidebar = createSidebar($('#sidebar'), {
    getState: () => state, canvas: views.canvas, showView, openSettings, openModal, closeModal, toast,
    onToggle: on => { $('#btnMenu').classList.toggle('active', on); setTimeout(() => { activeView()?.resize?.(); inspector.position(); }, 30); },
  });
}
function activeView() { return views[state.view]; }
function showView(v) {
  if (!views[v]) v = 'canvas';
  state.view = v;
  if (location.hash.replace('#', '') !== v) history.replaceState(null, '', v === 'canvas' ? ' ' : `#${v}`);
  document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  for (const [k, view] of Object.entries(views)) {
    const el = $(`#view-${k}`), on = k === v;
    el.classList.toggle('hidden', !on);
    on ? view.show?.(state) : view.hide?.();
  }
  if (v !== 'canvas') inspector.hide();
  activeView()?.update?.(state);
  sidebar?.render();
}
function onCanvasSelect(sel) {
  sel ? inspector.show(sel) : inspector.hide();
  if (sel && (sel.kind === 'dir' || sel.kind === 'file') && sidebar.isOpen()) sidebar.selectPath(sel.data.path, !sel.auto);
}

// ---------- SSE ----------
let es;
function connect() {
  es = new EventSource('/events');
  es.onmessage = m => { try { handle(JSON.parse(m.data)); } catch (err) { console.error(err); } };
  es.onerror = () => { $('#liveText').textContent = 'reconnecting…'; $('#live').classList.add('off'); };
  es.onopen = () => { $('#live').classList.remove('off'); renderLive(); };
}
let depsTimer;
function scheduleDeps() { clearTimeout(depsTimer); depsTimer = setTimeout(loadDeps, 800); }
async function loadDeps() {
  try { state.deps = await (await fetch('/api/deps')).json(); } catch { return; }
  views.canvas.refresh(state);
}

function handle(e) {
  switch (e.type) {
    case 'hello':
      state.hello = e; state.gate = e.gate || 'off'; renderHeader(); views.canvas.update(state); sidebar.render(); break;
    case 'tree':
      state.tree = e.tree; for (const v of Object.values(views)) v.update?.(state); scheduleDeps(); sidebar.render(); break;
    case 'agents':
      state.agents = new Map(e.agents.map(a => [a.key || `${a.session}:${a.agent}`, a])); refreshAll(); break;
    case 'tasks':
      state.tasks = e.tasks; refreshAll(); break;
    case 'metric':
      state.metrics = e.metrics; inspector.refresh(); sidebar.render(); break;
    case 'sys':
      state.sys = e; sidebar.render(); break;
    case 'app':
      state.hello.app = e.url; if (e.name) state.hello.name = e.name; if (e.gate) state.gate = e.gate; renderHeader(); views.canvas.refresh(state); break;
    case 'approvals':
      state.approvals = e.approvals; renderHeader(); tray.render(); views.canvas.refresh(state); inspector.refresh(); inspector.position(); break;
    case 'approval':
      if (e.approval.status === 'pending' && isFresh(e.approval.at)) { const t = approvalText(e.approval); toast(`${agentName(state, `${e.approval.session}:${e.approval.agent}`)} waits for you: ${t.verb}${t.target}`); }
      break;
    case 'collisions':
      state.collisions = e.collisions; tray.render(); views.canvas.refresh(state); inspector.refresh(); inspector.position(); break;
    case 'collision':
      if (isFresh(e.collision.lastAt)) toast(`${e.collision.level === 'bad' ? 'Collision' : 'Overlap'}: ${collisionText(state, e.collision)}`);
      break;
    case 'control':
      if (isFresh(e.command.at)) toast(`${e.command.kind === 'message' ? 'Message sent to' : e.command.kind === 'stop' ? 'Stop sent to' : 'Resumed'} ${agentName(state, `${e.command.session}:${e.command.agent}`)}`);
      break;
    case 'fs':
      pushEvent(e); touch(e.path, e.at); scheduleGit(); sidebar.render(); break;
    case 'tool':
      onTool(e); break;
    case 'agent':
      pushEvent(e); refreshAll(); break;
  }
}
function refreshAll() { activeView()?.agents?.(state); views.canvas.refresh(state); inspector.refresh(); renderLive(); sidebar.render(); }

function pushEvent(e) {
  state.events.push(e);
  if (state.events.length > 600) state.events.shift();
  if (isFresh(e.at)) state.lastEventAt = Date.now();
}

// Events older than this (SSE history replayed on connect) update state but are not animated.
const FRESH_MS = 8000;
const isFresh = at => typeof at !== 'number' || Date.now() - at < FRESH_MS;
function touch(path, at) {
  if (!path) return;
  state.hot.set(path, at && Date.now() - at > FRESH_MS ? at : Date.now());
  if (isFresh(at)) activeView()?.pulse?.(path, state);
}

function onTool(e) {
  const key = `${e.session}:${e.agent}`;
  let a = state.agents.get(key);
  if (!a) { a = { key, agent: e.agent, session: e.session, calls: 0, description: e.agent === 'main' ? 'Main session' : '', agentType: e.agent === 'main' ? 'main' : '', firstAt: e.at }; state.agents.set(key, a); }
  if (e.phase === 'start') a.calls++;
  a.lastAt = e.at; a.status = 'active'; a.tool = e.tool; a.phase = e.phase; if (e.file) a.file = e.file; if (e.detail) a.detail = e.detail; if (e.provider) a.provider = e.provider;
  if (e.phase === 'start' || e.isError) pushEvent(e);
  if (e.file) {
    if (e.phase === 'start') touch(e.file, e.at); else state.hot.set(e.file, Date.now());
    if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(e.tool) && e.phase === 'end') scheduleGit();
  }
  if (isFresh(e.at) && (e.phase === 'start' || e.isError)) activeView()?.agentEvent?.(e, a, state);
  else views.canvas.refresh(state);
  inspector.refresh(); renderLive(); sidebar.render();
  if (isFresh(e.at) && e.file && ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(e.tool)) sidebar.fileTouched(e.file, a);
}

// ---------- header ----------
function renderHeader() {
  const name = state.hello.name || 'Project';
  $('#projectName').textContent = name;
  const waiting = state.approvals.length;
  document.title = `${waiting ? `(${waiting}) ` : ''}${name} · WA2`;
}
function renderLive() {
  const active = [...state.agents.values()].filter(a => a.status === 'active' && Date.now() - (a.lastAt || 0) < 120000).length;
  const recent = Date.now() - state.lastEventAt < 5000;
  $('#live').classList.toggle('on', recent);
  $('#liveText').textContent = active ? `${active} active agent${active > 1 ? 's' : ''}` : state.agents.size ? 'agents idle' : 'no agents';
}

// ---------- git ----------
let gitTimer;
function scheduleGit() { clearTimeout(gitTimer); gitTimer = setTimeout(loadGit, 1500); }
async function loadGit() {
  try { state.git = await (await fetch('/api/git')).json(); } catch { return; }
  views.canvas.refresh(state); inspector.refresh(); sidebar.render();
}
async function measurePerf() {
  const t0 = performance.now();
  try { await fetch('/api/health', { cache: 'no-store' }); state.perfMs = Math.round(performance.now() - t0); } catch { state.perfMs = null; }
  sidebar.render();
}

// ---------- top bar actions ----------
document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => showView(state.view === b.dataset.view ? 'canvas' : b.dataset.view));
$('#btnMenu').onclick = () => sidebar.toggle();
function renderFollow() { $('#btnFollow').classList.toggle('active', views.canvas.follow()); }
$('#btnFollow').onclick = () => { views.canvas.setFollow(!views.canvas.follow()); renderFollow(); toast(views.canvas.follow() ? 'Agent following on' : 'Agent following off'); };
$('#btnFullscreen').onclick = () => document.fullscreenElement ? document.exitFullscreen() : $('#app').requestFullscreen?.();
$('#projectSelector').onclick = openSettings;
$('#search').addEventListener('input', ev => { state.search = ev.target.value.trim(); views.canvas.search(state.search); activeView()?.search?.(state.search); sidebar.render(); });
$('#search').addEventListener('keydown', ev => { if (ev.key === 'Enter') { showView('canvas'); views.canvas.searchGo(state.search); } if (ev.key === 'Escape') { ev.target.value = ''; state.search = ''; views.canvas.search(''); ev.target.blur(); } });
window.addEventListener('keydown', ev => {
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'k') { ev.preventDefault(); $('#search').focus(); }
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'b') { ev.preventDefault(); sidebar.toggle(); }
  if (ev.key === 'Escape') { closeModal(); if (!ev.target.closest('input, textarea')) inspector.hide(); }
});
window.addEventListener('resize', () => { activeView()?.resize?.(); inspector.position(); });
document.addEventListener('fullscreenchange', () => setTimeout(() => activeView()?.resize?.(), 50));

// ---------- settings / modal ----------
function openModal(title, bodyHtml) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = bodyHtml;
  applyIcons($('#modal'));
  $('#modal').classList.remove('hidden');
}
function closeModal() { $('#modal').classList.add('hidden'); }
$('#modalClose').onclick = closeModal;
$('#modal').addEventListener('click', ev => { if (ev.target.id === 'modal') closeModal(); });
const THEMES = [['', 'Lime (default)'], ['cyan', 'Cyan'], ['amber', 'Amber'], ['rose', 'Rose'], ['violet', 'Violet'], ['mono', 'Monochrome'], ['light', 'Light (experimental)']];
function currentTheme() { try { return localStorage.getItem('wa2.theme') || ''; } catch { return ''; } }
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  try { localStorage.setItem('wa2.theme', t); } catch { /* ignore */ }
  views.canvas.refresh(state);
}
function openSettings() {
  openModal('Project', `
    <label>Theme</label>
    <div class="themes" id="setThemes">${THEMES.map(([id, label]) => `<button class="theme-pick ${id === currentTheme() ? 'on' : ''}" data-theme-pick="${id}" title="${esc(label)}"><span class="sw" data-sw="${id}"></span>${esc(label)}</button>`).join('')}</div>
    <p class="hint">The canvas changes immediately; 3D views pick up the colour on the next load.</p>
    <label>Hold agent actions for approval on the canvas (Claude Code sessions)</label>
    <div class="gates" id="setGate">${GATES_ORDER.map(g => `<label class="gate-pick"><input type="radio" name="gate" value="${g}" ${g === state.gate ? 'checked' : ''}>${esc(GATE_LABELS[g])}</label>`).join('')}</div>
    <p class="hint">Only while this page is open. A held call waits 90 s at most, then runs through Claude Code's own permissions as usual.</p>
    <label>Project name</label><input id="setName" value="${esc(state.hello.name)}">
    <label>URL of the application being built (&quot;Live app&quot; node)</label><input id="setApp" placeholder="http://localhost:3000" value="${esc(state.hello.app)}">
    <p>Watched repository: <code>${esc(state.hello.repo)}</code><br>These settings are saved in <code>.wa2.json</code> at the repository root.
    To watch another project, run <code>/wa2</code> in a Claude Code session opened there, or <code>node server/index.mjs --repo &lt;folder&gt;</code>.</p>
    <div class="row"><button class="btn" id="setSave">Save</button></div>`);
  $('#setThemes').addEventListener('click', ev => {
    const b = ev.target.closest('[data-theme-pick]'); if (!b) return;
    applyTheme(b.dataset.themePick);
    $('#setThemes').querySelectorAll('.theme-pick').forEach(x => x.classList.toggle('on', x === b));
  });
  $('#setGate').addEventListener('change', async ev => {
    const g = ev.target.value;
    const r = await setGate(g).catch(() => null);
    if (r && !r.error) { state.gate = g; toast(`Approval: ${GATE_LABELS[g].split(':')[0]}`); } else toast('Could not change the approval setting');
  });
  $('#setSave').onclick = async () => {
    const r = await fetch('/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: $('#setName').value.trim(), app: $('#setApp').value.trim() }) }).then(x => x.json()).catch(() => null);
    if (!r || r.error) { toast(r?.error ? `Not saved: ${r.error}` : 'Not saved: WA2 server unreachable'); return; }
    toast('Settings saved'); closeModal();
  };
}
let toastTimer;
export function toast(text) {
  const el = $('#toast'); el.textContent = text; el.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.add('hidden'), 2500);
}

// ---------- boot ----------
function boot() {
  applyIcons();
  initViews();
  renderFollow();
  showView(location.hash.replace('#', '') || 'canvas');
  window.addEventListener('hashchange', () => showView(location.hash.replace('#', '') || 'canvas'));
  connect();
  loadGit();
  setInterval(loadGit, 12000);
  setInterval(() => { renderLive(); views.canvas.refresh(state); sidebar.render(); }, 10000);
  measurePerf(); setInterval(measurePerf, 30000);
}
boot();
