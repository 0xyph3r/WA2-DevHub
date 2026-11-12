// "Architecture" tab: the current directory as a calm, exploded stack of glass
// layers (one per sub-directory), module cards on the right, an agent column
// on the left that says in plain words what each agent is doing, and a
// breadcrumb to drill into any branch and back. Nothing orbits: the camera is
// fixed and auto-framed, labels never overlap.
import * as THREE from 'three';
import { createBase, LIME, GLASS } from './three-base.js';
const ACC = (getComputedStyle(document.documentElement).getPropertyValue('--lime') || '').trim() || '#c8ff00';
import { icon, iconForName, roleForName } from '../icons.js';
import { roleOf } from '../roles.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const RANK = [[/mobile|ios|android|native|web|www|site|front|client|ui|pages|views|app|components/, 0], [/api|server|service|backend|route|functions|edge|hooks/, 1], [/lib|core|domain|logic|shared|common|util|src|packages/, 2], [/db|database|prisma|migration|schema|sql|supabase|data/, 3], [/infra|docker|deploy|k8s|terraform|ci|ops|cloud|scripts|test/, 4]];
const rank = name => { const n = name.toLowerCase(); for (const [re, r] of RANK) if (re.test(n)) return r; return 2.5; };
const countFiles = node => node.type === 'file' ? 1 : (node.children || []).reduce((s, c) => s + countFiles(c), 0);
const ago = at => { const s = Math.max(0, Math.round((Date.now() - at) / 1000)); return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };

const W = 9, D = 6.2, STEP = 1.55, COLS = 6;

// Exploded view at the root: top-level directories are grouped into architectural layers.
const CATS = [
  ['Frontend', /mobile|ios|android|native|web|www|site|front|client|ui|pages|views|app|components|public|static|assets|styles/, 'laptop'],
  ['Backend', /api|server|service|backend|route|functions|edge|worker|job|queue|hooks/, 'api'],
  ['Business logic', /lib|core|domain|logic|shared|common|util|src|packages|modules|engine/, 'brain'],
  ['Database', /db|database|prisma|migration|schema|sql|supabase|data|models|store/, 'database'],
  ['Integrations', /integr|plugin|extension|connector|sdk|vendor|third|external|adapters/, 'puzzle'],
  ['Infrastructure', /infra|docker|deploy|k8s|terraform|ci|ops|cloud|scripts|config|\.github|test|spec|e2e|tools|bin/, 'cloud'],
];
const categoryOf = name => { const n = name.toLowerCase(); for (const [cat, re] of CATS) if (re.test(n)) return cat; return 'Others'; };
const catRank = cat => { const i = CATS.findIndex(c => c[0] === cat); return i < 0 ? (cat === '(files)' ? 9 : 8) : i; };
const catIcon = cat => (CATS.find(c => c[0] === cat) || [])[2] || 'folder';

// What an agent is doing, in plain English, from its record.
export function actionOf(a) {
  if (a.status === 'idle' && !a.tool) return 'waiting';
  if (a.status === 'done') return 'done';
  const f = a.file ? a.file.split('/').slice(-2).join('/') : '';
  const past = a.phase === 'end';
  const stale = Date.now() - (a.lastAt || 0) > 60000;
  if (stale) return a.status === 'idle' ? 'waiting' : 'thinking…';
  switch (a.tool) {
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return `${past ? 'edited' : 'edits'} ${f}`;
    case 'Write': return `${past ? 'wrote' : 'writes'} ${f}`;
    case 'Read': return `${past ? 'read' : 'reads'} ${f}`;
    case 'Grep': case 'Glob': return `${past ? 'searched' : 'searches'} ${f || 'the project'}`;
    case 'Bash': case 'PowerShell': return `${past ? 'ran' : 'runs'}: ${(a.detail || '').slice(0, 48)}`;
    case 'Agent': return `${past ? 'delegated' : 'delegates'}: ${(a.detail || '').slice(0, 40)}`;
    case 'TodoWrite': return past ? 'planned' : 'plans';
    case 'TaskCreate': return past ? 'created a task' : 'creates a task';
    case 'TaskUpdate': return past ? 'updated a task' : 'updates a task';
    case 'WebFetch': return past ? 'fetched the web' : 'fetches the web';
    case 'WebSearch': return past ? 'searched the web' : 'searches the web';
    case undefined: return a.agent === 'main' ? 'starts the session' : 'starts';
    default: return `${past ? 'used' : 'uses'} ${a.tool}`;
  }
}

function findNode(tree, path) {
  if (!tree || path === '' || path === tree.path) return tree;
  for (const c of tree.children || []) {
    if (c.path === path) return c;
    if (c.type === 'dir' && path.startsWith(c.path + '/')) return findNode(c, path);
  }
  return null;
}

export function createStack(container, { onSelect } = {}) {
  const CAM = [10, 6.5, 14];
  const base = createBase(container, { camera: { position: CAM, target: [0, 3, 0], fov: 30, autoRotate: false } });
  base.renderer.domElement.addEventListener('dblclick', fit);
  const group = new THREE.Group();
  base.scene.add(group);

  let layers = [], cards = [], blocks = new Map(), title = null, cube = null, labelsOn = true, hoverable = [], centerY = 3, isolated = null;
  let root = '', lastState = null;
  const crumbs = base.label('crumbs', '');
  crumbs.style.pointerEvents = 'auto';
  const agentCol = document.createElement('div'); agentCol.className = 'agent-col'; base.overlay.appendChild(agentCol);
  const agentCards = new Map();   // key -> el
  let beams = [];                 // { from: el, to: layer, at }

  // ---------- scene ----------
  function clear() {
    group.clear(); hoverable = []; blocks.clear(); isolated = null;
    for (const l of layers) l.label.remove();
    for (const c of cards) c.el.remove();
    title?.remove(); title = null; layers = []; cards = [];
  }

  function build(state) {
    lastState = state;
    clear();
    const node = findNode(state.tree, root) || state.tree;
    if (!node) return;
    if (node !== state.tree && node.path !== root) root = node.path;
    const dirs = (node.children || []).filter(c => c.type === 'dir').map(n => ({ node: n, name: n.name, count: countFiles(n) })).filter(d => d.count > 0);
    const files = (node.children || []).filter(c => c.type === 'file');
    if (files.length || !dirs.length) dirs.push({ node: { name: dirs.length ? '(files)' : node.name, path: node.path, type: 'dir', children: files }, name: dirs.length ? '(files)' : node.name, count: files.length, isFiles: true });
    dirs.sort((a, b) => b.count - a.count);
    let layerDirs, cardDirs;
    if (!root && dirs.filter(d => !d.isFiles).length > 1) {
      // root: one layer per architectural category, the member directories become the blocks on it
      const groups = new Map();
      for (const d of dirs) { const cat = d.isFiles ? '(files)' : categoryOf(d.name); if (!groups.has(cat)) groups.set(cat, []); groups.get(cat).push(d); }
      layerDirs = [...groups].map(([cat, ds]) => ({
        node: { name: cat, path: '', type: 'dir', children: ds.flatMap(d => d.isFiles ? d.node.children : [d.node]) },
        name: cat, count: ds.reduce((t, d) => t + d.count, 0), isFiles: cat === '(files)', isCat: cat !== '(files)', members: ds.filter(d => !d.isFiles).map(d => d.name),
      })).sort((a, b) => catRank(a.name) - catRank(b.name));
      cardDirs = [];
    } else {
      layerDirs = dirs.slice(0, Math.min(5, dirs.length)).sort((a, b) => rank(a.name) - rank(b.name) || b.count - a.count);
      cardDirs = dirs.slice(layerDirs.length, layerDirs.length + 6);
    }
    const n = layerDirs.length;
    centerY = ((n - 1) * STEP) / 2 + 0.6;

    const bgeo = new THREE.BoxGeometry(1, 1, 1);
    layerDirs.forEach((d, i) => {
      const y = (n - 1 - i) * STEP;
      const slab = new THREE.Mesh(new THREE.BoxGeometry(W, 0.28, D), new THREE.MeshPhysicalMaterial({ color: GLASS, transparent: true, opacity: 0.7, roughness: 0.3, metalness: 0.15, clearcoat: 0.5, emissive: 0x0a140a }));
      slab.position.y = y; slab.userData = { path: d.node.path, name: d.name, count: d.count, dir: true, files: d.isFiles || d.isCat };
      slab.add(new THREE.LineSegments(new THREE.EdgesGeometry(slab.geometry), new THREE.LineBasicMaterial({ color: LIME, transparent: true, opacity: 0.55 })));
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(W + 0.8, D + 0.8), new THREE.MeshBasicMaterial({ color: LIME, transparent: true, opacity: 0.05, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
      glow.rotation.x = -Math.PI / 2; glow.position.y = y - 0.18;
      group.add(slab, glow); hoverable.push(slab);
      const kids = (d.node.children || []).slice(0, COLS * 6);
      const rows = Math.max(1, Math.ceil(kids.length / COLS));
      const cw = (W - 1.4) / COLS, cd = (D - 1.2) / Math.max(rows, 3);
      const layerBlocks = [];
      kids.forEach((k, j) => {
        const h = k.type === 'dir' ? 0.42 : 0.26;
        const m = new THREE.Mesh(bgeo, new THREE.MeshStandardMaterial({ color: k.type === 'dir' ? 0x2a3a14 : 0x1f2d10, emissive: LIME, emissiveIntensity: 0.18, roughness: 0.5, transparent: true }));
        layerBlocks.push(m);
        m.scale.set(cw * 0.55, h, cd * 0.55);
        m.position.set(-W / 2 + 0.7 + (j % COLS + 0.5) * cw, y + 0.14 + h / 2, -D / 2 + 0.6 + (Math.floor(j / COLS) + 0.5) * cd);
        m.userData = { path: k.path, name: k.name, count: k.type === 'dir' ? countFiles(k) : null, size: k.size, dir: k.type === 'dir', hot: 0 };
        group.add(m); hoverable.push(m); blocks.set(k.path, m);
      });
      const sub = d.isFiles ? 'files at the root' : d.isCat ? esc(d.members.join(', ')) : esc(roleForName(d.name));
      const label = base.label('layer-label', `${icon(d.isFiles ? 'file' : d.isCat ? catIcon(d.name) : iconForName(d.name))}<span>${esc(d.name)}</span><small>${sub} · ${d.count}${d.isCat ? ' · click: isolate' : ''}</small>`);
      label.style.pointerEvents = 'auto'; label.style.cursor = d.isFiles ? 'default' : 'pointer';
      const layer = { ...d, mesh: slab, glow, edges: slab.children[0], label, y, hot: 0, blocks: layerBlocks };
      if (d.isCat) label.onclick = () => { isolated = isolated === layer ? null : layer; };
      else if (!d.isFiles) label.onclick = () => drill(d.node.path);
      layers.push(layer);
    });

    const top = (n ? (n - 1) * STEP : 0) + 1.7;
    cube = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1.3, 1.3, 1.3)), new THREE.LineBasicMaterial({ color: LIME }));
    cube.position.y = top; cube.rotation.y = Math.PI / 4;
    group.add(cube);
    title = base.label('stack-title', esc(root ? root.split('/').pop() : (state.hello.name || state.tree.name)));
    title.dataset.y = top + 1.2;

    cardDirs.forEach((d, i) => {
      const el = base.label('side-card', `<div class="ic">${icon(iconForName(d.name))}</div><div><div class="t">${esc(d.name)}</div><div class="s">${esc(roleForName(d.name))} · ${d.count} file${d.count > 1 ? 's' : ''}</div></div><span class="ok">${icon('chevron-right')}</span>`);
      el.style.pointerEvents = 'auto';
      el.onclick = () => drill(d.node.path);
      cards.push({ ...d, el, index: i, hot: 0 });
    });
    renderCrumbs(state);
    layoutCards();
    renderAgents(state);
    fit();
  }

  function drill(path) {
    if (!lastState) return;
    const node = findNode(lastState.tree, path);
    if (!node || node.type !== 'dir') return;
    root = path;
    build(lastState);
    onSelect?.(path);
  }

  function renderCrumbs(state) {
    const parts = root ? root.split('/') : [];
    let acc = '';
    const items = [`<button data-p="">${icon('home')}${esc(state.hello.name || state.tree?.name || 'root')}</button>`];
    for (const p of parts) { acc = acc ? `${acc}/${p}` : p; items.push(`<span>/</span><button data-p="${esc(acc)}">${esc(p)}</button>`); }
    crumbs.innerHTML = items.join('') + (root ? `<em>click a module to open its branch · double-click the background to reframe</em>` : `<em>click a module to open its branch</em>`);
    crumbs.querySelectorAll('button').forEach(b => b.onclick = () => { root = b.dataset.p; build(lastState); });
  }

  function layoutCards() {
    const h = container.clientHeight;
    const gap = Math.min(92, (h - 160) / Math.max(1, cards.length));
    cards.forEach(c => {
      c.el.style.top = `${h / 2 - (cards.length - 1) * gap / 2 + c.index * gap - 30}px`;
      c.el.style.right = '14px'; c.el.style.removeProperty('left');
    });
  }

  function fit() {
    const h = container.clientHeight || 1, w = container.clientWidth || 1;
    const aspect = w / h, tan = Math.tan((base.camera.fov / 2) * Math.PI / 180);
    const height = Math.max(1, (layers.length - 1) * STEP + 4.2);
    const dist = Math.max(height / (2 * tan), (W + 3) / (2 * tan * aspect)) * 1.5;
    const dir = new THREE.Vector3(...CAM).normalize();
    const look = new THREE.Vector3(0, centerY - 1.1, 0);
    base.controls.target.copy(look);
    base.camera.position.copy(dir.multiplyScalar(dist)).add(look);
  }

  // ---------- agents column ----------
  function renderAgents(state) {
    if (!state) return;
    const list = [...state.agents.values()].sort((a, b) => (a.firstAt || 0) - (b.firstAt || 0)).slice(0, 7);
    const seen = new Set();
    for (const a of list) {
      seen.add(a.key);
      let el = agentCards.get(a.key);
      if (!el) { el = document.createElement('div'); el.className = 'agent-card'; agentCol.appendChild(el); agentCards.set(a.key, el); }
      const r = roleOf(a);
      const active = a.status === 'active' && Date.now() - (a.lastAt || 0) < 60000;
      el.classList.toggle('idle', !active);
      el.dataset.file = a.file || '';
      el.innerHTML = `<div class="ic">${icon(r.icon)}</div><div class="ab">
        <div class="row1"><b>${esc(r.name)}</b><span class="st"><span class="dot ${active ? 'dot-lime' : 'dot-grey'}"></span>${active ? 'active' : a.status === 'done' ? 'done' : 'idle'}</span></div>
        <div class="mission" title="${esc(a.description || '')}">${esc(a.description || a.agentType || '-')}</div>
        <div class="act">${icon('chevron-right')}<span>${esc(actionOf(a))}</span></div>
        <div class="meta">${a.calls || 0} action${(a.calls || 0) > 1 ? 's' : ''}${a.lastAt ? ` · ${ago(a.lastAt)}` : ''}</div>
      </div>`;
    }
    for (const [k, el] of agentCards) if (!seen.has(k)) { el.remove(); agentCards.delete(k); }
    agentCol.classList.toggle('empty', !list.length);
    if (!list.length) agentCol.innerHTML = `<div class="agent-card idle"><div class="ic">${icon('agents')}</div><div class="ab"><b>No agents</b><div class="mission">Run <code>/wa2</code> in Claude Code: the session and its sub-agents appear here with what they are doing.</div></div></div>`;
    else if (agentCol.querySelector('code')) { agentCol.innerHTML = ''; agentCards.clear(); renderAgents(state); }
  }
  let agentTick = 0;

  // ---------- labels column ----------
  function placeLabels() {
    const w = container.clientWidth, h = container.clientHeight;
    const pts = layers.map(l => ({ l, p: base.project(W / 2, l.y, D / 2) }));
    if (!pts.length) return;
    const x = Math.min(w - 260, Math.max(...pts.map(o => o.p.x)) + 16);
    pts.sort((a, b) => a.p.y - b.p.y);
    const minGap = 40, top = 56, bottom = h - 40;
    for (let i = 1; i < pts.length; i++) if (pts[i].p.y - pts[i - 1].p.y < minGap) pts[i].p.y = pts[i - 1].p.y + minGap;
    pts[pts.length - 1].p.y = Math.min(bottom, pts[pts.length - 1].p.y);
    for (let i = pts.length - 2; i >= 0; i--) if (pts[i + 1].p.y - pts[i].p.y < minGap) pts[i].p.y = pts[i + 1].p.y - minGap;
    for (const { l, p } of pts) {
      l.label.style.left = `${x}px`; l.label.style.top = `${Math.max(top, p.y)}px`;
      l.label.style.transform = 'translate(0, -50%)';
      l.label.style.display = labelsOn && !p.behind ? '' : 'none';
      l.anchor = base.project(W / 2, l.y, D / 2);
      l.left = base.project(-W / 2, l.y, D / 2 - 1);
    }
  }

  function layerOf(path) {
    if (path == null) return null;
    const rel = root ? (path === root || path.startsWith(root + '/') ? path.slice(root.length).replace(/^\//, '') : null) : path;
    if (rel == null) return null;
    const top = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : rel;
    return layers.find(l => l.name === top || l.members?.includes(top)) || (rel && !rel.includes('/') ? layers.find(l => l.isFiles) : null) || null;
  }

  base.tickers.add(dt => {
    if (cube) cube.rotation.y += dt * 0.25;
    if (isolated && !layers.includes(isolated)) isolated = null;
    for (const l of layers) {
      if (l.hot > 0) l.hot = Math.max(0, l.hot - dt * 0.5);
      const dim = isolated && isolated !== l ? 0.12 : 1;   // isolate one layer: the others fade
      l.mesh.material.opacity = 0.7 * dim;
      l.edges.material.opacity = (0.5 + l.hot * 0.5) * dim;
      l.mesh.material.emissive.setHex(l.hot > 0.05 ? 0x2a4a00 : 0x0a140a);
      l.glow.material.opacity = (0.05 + l.hot * 0.22) * dim;
      for (const m of l.blocks || []) m.material.opacity = dim;
      l.label.classList.toggle('hot', l.hot > 0.05);
      l.label.style.opacity = dim < 1 ? 0.35 : 1;
    }
    for (const m of blocks.values()) if (m.userData.hot > 0) { m.userData.hot = Math.max(0, m.userData.hot - dt * 0.4); m.material.emissiveIntensity = 0.18 + m.userData.hot * 1.4; }
    for (const c of cards) { if (c.hot > 0) c.hot = Math.max(0, c.hot - dt * 0.5); c.el.classList.toggle('hot', c.hot > 0.05); }
    placeLabels();
    if (title) { const p = base.project(0, Number(title.dataset.y), 0); title.style.left = p.x + 'px'; title.style.top = p.y + 'px'; title.style.display = labelsOn && !p.behind ? '' : 'none'; }
    if ((agentTick += dt) > 1) { agentTick = 0; if (lastState) renderAgents(lastState); }

    const cr = container.getBoundingClientRect();
    let paths = '';
    // module cards -> nearest layer (right side)
    for (const c of cards) {
      const r = c.el.getBoundingClientRect();
      const x0 = r.left - cr.left, y0 = r.top - cr.top + r.height / 2;
      const near = layers.reduce((best, l) => !best || Math.abs(l.anchor.y - y0) < Math.abs(best.y - y0) ? l.anchor : best, null);
      if (!near) continue;
      const dx = (x0 - near.x) * 0.5;
      paths += `<path d="M${x0},${y0} C${x0 - dx},${y0} ${near.x + dx},${near.y} ${near.x},${near.y}" fill="none" stroke="${ACC}" stroke-opacity="${0.22 + c.hot * 0.6}" stroke-width="${1.2 + c.hot}"/>`;
    }
    // agents -> the layer they work on (left side), persistent thin line + beam on activity
    const now = performance.now();
    for (const [key, el] of agentCards) {
      const l = layerOf(el.dataset.file || null);
      if (!l || !l.left || el.classList.contains('idle')) continue;
      const r = el.getBoundingClientRect();
      const x0 = r.right - cr.left, y0 = r.top - cr.top + r.height / 2;
      const dx = (l.left.x - x0) * 0.5;
      const beam = beams.find(b => b.key === key && now - b.at < 2600);
      const life = beam ? 1 - (now - beam.at) / 2600 : 0;
      paths += `<path class="${beam ? 'beam' : ''}" d="M${x0},${y0} C${x0 + dx},${y0} ${l.left.x - dx},${l.left.y} ${l.left.x},${l.left.y}" fill="none" stroke="${ACC}" stroke-opacity="${0.35 + life * 0.65}" stroke-width="${1.2 + life * 2}"/><circle cx="${l.left.x}" cy="${l.left.y}" r="3" fill="${ACC}"/>`;
    }
    beams = beams.filter(b => now - b.at < 2600);
    base.svg.innerHTML = `<style>.beam{stroke-dasharray:8 10;animation:bm .5s linear infinite}@keyframes bm{to{stroke-dashoffset:-18}}</style><g style="filter:drop-shadow(0 0 5px rgba(200,255,0,.5))">${paths}</g>`;

    const hit = base.cast(hoverable)[0];
    if (hit) { const u = hit.object.userData; base.showTip(u.dir ? `${u.path || u.name}/ · ${u.count} files${u.files ? '' : ' · click: open'}` : `${u.path} · ${u.size ?? 0} B · click: preview`); container.style.cursor = 'pointer'; }
    else { base.hideTip(); container.style.cursor = ''; }
  });
  base.renderer.domElement.addEventListener('click', () => {
    const hit = base.cast(hoverable)[0]; if (!hit) return;
    const u = hit.object.userData;
    if (u.dir && !u.files) drill(u.path); else if (!u.dir) onSelect?.(u.path);
  });

  function touch(path) {
    const l = layerOf(path);
    if (l) { l.hot = 1; const b = blocks.get(path); if (b) b.userData.hot = 1; }
    else { const top = root ? null : (path.includes('/') ? path.slice(0, path.indexOf('/')) : null); const c = cards.find(x => x.name === top); if (c) c.hot = 1; }
    return l;
  }

  return {
    update(state) { build(state); },
    show(state) { base.show(); if (!layers.length && state?.tree) build(state); else if (state) renderAgents(state); layoutCards(); fit(); },
    hide() { base.hide(); },
    resize() { base.resize(); layoutCards(); fit(); },
    setLabels(on) { labelsOn = on; for (const c of cards) c.el.style.display = on ? '' : 'none'; agentCol.style.display = on ? '' : 'none'; crumbs.style.display = on ? '' : 'none'; },
    pulse(path) { touch(path); },
    agents(state) { lastState = state; renderAgents(state); },
    agentEvent(e, a, state) {
      if (state) { lastState = state; renderAgents(state); }
      const el = agentCards.get(a.key);
      if (el) { el.classList.add('hot'); setTimeout(() => el.classList.remove('hot'), 1200); }
      if (e.file) { const l = touch(e.file); if (l) beams.push({ key: a.key, at: performance.now() }); }
    },
    focus(path) { const node = lastState && findNode(lastState.tree, path); if (node?.type === 'dir') { root = path; build(lastState); } else touch(path); },
    dispose() { base.dispose(); },
  };
}
