// Contextual floating inspector. Appears next to whatever is selected on the
// canvas (module, file, symbol, agent, branch, dependency, group, live app),
// shows only real data, and disappears with Escape or the close button.
import { icon, iconForName, roleForName } from './icons.js';
import { roleOf } from './roles.js';
import { findNode } from './views/canvas.js';
import { controllable, sendCommand, decide, dismissCollision, collisionText, approvalText } from './control.js';

/** Only http(s) URLs may be rendered as links or iframes (blocks javascript:/data: schemes). */
const safeHttpUrl = v => { try { const u = new URL(String(v || '')); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch { return ''; } };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtSize = n => !n ? '0 B' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const ago = at => { if (!at) return '-'; const s = Math.max(0, Math.round((Date.now() - at) / 1000)); return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
const fmtTime = at => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const under = (path, dir) => dir === '' || path === dir || path.startsWith(dir + '/');
const countFiles = node => node.type === 'file' ? 1 : (node.children || []).reduce((s, c) => s + countFiles(c), 0);
const VERBS = {
  Edit: 'edits', MultiEdit: 'edits', Write: 'writes', NotebookEdit: 'edits', Read: 'reads', Bash: 'runs', PowerShell: 'runs', Grep: 'searches in', Glob: 'searches in',
  Agent: 'delegates', TodoWrite: 'plans', TaskCreate: 'creates a task', TaskUpdate: 'updates a task', WebFetch: 'fetches the web', WebSearch: 'searches the web',
};
const KW = /\b(import|export|from|const|let|var|function|return|if|else|for|while|class|extends|new|await|async|try|catch|throw|default|switch|case|break|continue|typeof|instanceof|this|null|undefined|true|false|def|pub|fn|struct|impl|use|mod|match|enum|interface|type|public|private|static|void|int|string|bool)\b/g;
const TOKEN = new RegExp(`(\\/\\/.*$|#.*$)|(&quot;.*?&quot;|&#39;.*?&#39;|\`.*?\`)|(&lt;\\/?[A-Za-z][\\w.-]*)|${KW.source}|(?<![&#\\w])\\b(\\d+(?:\\.\\d+)?)\\b`, 'g');
const highlight = line => esc(String(line).replace(/\r$/, '')).replace(TOKEN, (m, c, s, tg, k, n) => c ? `<span class="c">${c}</span>` : s ? `<span class="s">${s}</span>` : tg ? `<span class="tg">${tg}</span>` : k ? `<span class="k">${k}</span>` : `<span class="n">${n}</span>`);

export function createInspector(root, { getState, canvas, onClose, toast = () => {} } = {}) {
  const el = document.createElement('aside');
  el.className = 'insp hidden';
  root.appendChild(el);
  let sel = null, anchorId = null;

  const crumbs = path => {
    const parts = path ? path.split('/') : [];
    let acc = '';
    return `<nav class="insp-crumbs"><button data-go="">${icon('home')}</button>${parts.map(p => { acc = acc ? `${acc}/${p}` : p; return `<span>/</span><button data-go="${esc(acc)}">${esc(p)}</button>`; }).join('')}</nav>`;
  };
  const section = (title, body, cls = '') => body ? `<section class="insp-sec ${cls}"><h4>${title}</h4>${body}</section>` : '';
  const kv = pairs => `<dl class="insp-kv">${pairs.filter(p => p && p[1] != null && p[1] !== '').map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
  const eventsFor = (state, pred, n = 8) => state.events.filter(pred).slice(-n).reverse();
  const describe = (state, e) => {
    if (e.type === 'fs') return `file ${e.kind === 'remove' ? 'deleted' : 'changed'} <code>${esc(e.path)}</code>`;
    const a = state.agents.get(`${e.session}:${e.agent}`) || { agent: e.agent };
    if (e.type === 'agent') return `<b>${esc(roleOf(a).name)}</b> ${e.phase === 'done' ? 'finishes' : 'starts'}${e.description ? ` <code>${esc(String(e.description).slice(0, 70))}</code>` : ''}`;
    const target = e.file ? `<code>${esc(e.file)}</code>` : e.detail ? `<code>${esc(String(e.detail).slice(0, 70))}</code>` : '';
    return `<b>${esc(roleOf(a).name)}</b> ${e.isError ? 'fails: ' : VERBS[e.tool] || 'uses ' + esc(e.tool || '')} ${target}`;
  };
  const eventList = (state, list) => list.length ? `<ul class="insp-log">${list.map(e => `<li class="${e.isError ? 'err' : ''}"><time>${fmtTime(e.at)}</time><span>${describe(state, e)}</span></li>`).join('')}</ul>` : '';

  function body(s) {
    const state = getState();
    if (!s) return '';
    if (s.kind === 'dir') {
      const d = s.data, p = d.path, isRoot = p === '';
      const dirs = (d.children || []).filter(c => c.type === 'dir'), files = countFiles(d);
      const ag = [...state.agents.values()].filter(a => a.file && under(a.file, p) && a.status === 'active');
      const chg = state.git.changes.filter(c => under(c.file, p));
      const deps = state.deps?.files || [];
      const out = new Map(), inn = new Map();
      for (const e of deps) {
        const fo = under(e.from, p), to = under(e.to, p);
        if (fo && !to) out.set(topOf(e.to, p), (out.get(topOf(e.to, p)) || 0) + 1);
        if (to && !fo) inn.set(topOf(e.from, p), (inn.get(topOf(e.from, p)) || 0) + 1);
      }
      const depList = m => [...m].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `<li><button data-go="${esc(k)}">${esc(k)}</button><span>${v} import${v > 1 ? 's' : ''}</span></li>`).join('');
      const ev = eventsFor(state, e => (e.file && under(e.file, p)) || (e.type === 'fs' && under(e.path, p)));
      const m = state.metrics, dur = ms => ms == null ? '' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
      const tasks = state.tasks;
      return `<header><span class="insp-ic">${icon(isRoot ? 'cube' : iconForName(d.name))}</span><div><b>${esc(isRoot ? state.hello.name || d.name : d.name)}</b><small>${esc(isRoot ? 'Application' : roleForName(d.name))} · ${files} file${files > 1 ? 's' : ''} · ${dirs.length} folder${dirs.length > 1 ? 's' : ''}</small></div></header>
        ${isRoot ? '' : crumbs(p)}
        ${isRoot ? kv([['Repository', `<code>${esc(state.hello.repo)}</code>`], ['Version', state.hello.version ? 'v' + esc(state.hello.version) : null], ['Branch', state.git.current ? `<code>${esc(state.git.current)}</code>` : null], ['Uncommitted', state.git.changes.length ? `${state.git.changes.length} file${state.git.changes.length > 1 ? 's' : ''}` : 'nothing'], ['Last build', m.build ? `${m.build.ok ? 'OK' : 'KO'} ${dur(m.build.durationMs)} · ${ago(m.build.at)}` : null], ['Last tests', m.test ? `${m.test.ok ? 'OK' : 'KO'} · ${ago(m.test.at)}` : null], ['Coverage', m.coverage ? `${Math.round(m.coverage.pct)} %` : null]]) : ''}
        ${section('Agents here', ag.length ? `<ul class="insp-list">${ag.map(a => `<li><button data-agent="${esc(a.key)}">${icon(roleOf(a).icon)}${esc(roleOf(a).name)}</button><span>${esc(a.description || '')}</span></li>`).join('')}</ul>` : '')}
        ${section('Subfolders', dirs.length ? `<ul class="insp-list">${dirs.slice(0, 12).map(c => `<li><button data-go="${esc(c.path)}">${icon('folder')}${esc(c.name)}</button><span>${countFiles(c)}</span></li>`).join('')}${dirs.length > 12 ? `<li><span>… ${dirs.length - 12} more</span></li>` : ''}</ul>` : '')}
        ${section('Imports from', depList(out) ? `<ul class="insp-list">${depList(out)}</ul>` : '')}
        ${section('Imported by', depList(inn) ? `<ul class="insp-list">${depList(inn)}</ul>` : '')}
        ${isRoot && tasks.length ? section(`Tasks (${tasks.filter(t => t.status === 'completed').length}/${tasks.length})`, `<ul class="insp-tasks">${[...tasks].sort((a, b) => ({ in_progress: 0, pending: 1, completed: 2 }[a.status] ?? 1) - ({ in_progress: 0, pending: 1, completed: 2 }[b.status] ?? 1)).slice(0, 10).map(t => `<li class="${t.status}">${icon(t.status === 'completed' ? 'check' : t.status === 'in_progress' ? 'zap' : 'more')}<span>${esc(t.subject)}</span></li>`).join('')}</ul>`) : ''}
        ${section('Uncommitted changes', chg.length ? `<ul class="insp-list">${chg.slice(0, 10).map(c => `<li><button data-go="${esc(c.file)}">${icon('file')}${esc(c.file.split('/').pop())}</button><span class="g-${c.status}">${c.status === 'A' ? 'new' : c.status === 'D' ? 'deleted' : `+${c.add} −${c.del}`}</span></li>`).join('')}</ul>` : '')}
        ${section('Recent activity', eventList(state, ev))}
        ${!ag.length && !chg.length && !ev.length ? '<p class="insp-empty">No activity recorded on this module.</p>' : ''}`;
    }
    if (s.kind === 'file') {
      const f = s.data, p = f.path, chg = state.git.changes.find(c => c.file === p);
      const ag = [...state.agents.values()].filter(a => a.file === p && a.status === 'active');
      const syms = canvas.symbolsFor(p);
      const ev = eventsFor(state, e => e.file === p || (e.type === 'fs' && e.path === p));
      const deps = (state.deps?.files || []), imports = deps.filter(e => e.from === p), importedBy = deps.filter(e => e.to === p);
      return `<header><span class="insp-ic">${icon('file')}</span><div><b>${esc(f.name)}</b><small>${fmtSize(f.size)}${chg ? ` · <em class="g-${chg.status}">${chg.status === 'A' ? 'new' : chg.status === 'D' ? 'deleted' : `modified +${chg.add} −${chg.del}`}</em>` : ' · committed'}</small></div></header>
        ${crumbs(p)}
        ${section('Agents on this file', ag.length ? `<ul class="insp-list">${ag.map(a => `<li><button data-agent="${esc(a.key)}">${icon(roleOf(a).icon)}${esc(roleOf(a).name)}</button><span>${esc(VERBS[a.tool] || a.tool || '')}</span></li>`).join('')}</ul>` : '')}
        ${section(`Symbols${syms ? ` (${syms.length})` : ''}`, syms == null ? '<p class="insp-empty">Loading…</p>' : syms.length ? `<ul class="insp-list syms">${syms.slice(0, 40).map(x => `<li><button data-sym="${esc(x.name)}">${icon(x.kind === 'class' ? 'box' : 'code')}${esc(x.name)}</button><span>${x.exported ? 'export · ' : ''}l. ${x.line}</span></li>`).join('')}</ul>` : '<p class="insp-empty">No symbol recognised.</p>')}
        ${section('Imports', imports.length ? `<ul class="insp-list">${imports.slice(0, 10).map(e => `<li><button data-go="${esc(e.to)}">${icon('file')}${esc(e.to)}</button></li>`).join('')}</ul>` : '')}
        ${section('Imported by', importedBy.length ? `<ul class="insp-list">${importedBy.slice(0, 10).map(e => `<li><button data-go="${esc(e.from)}">${icon('file')}${esc(e.from)}</button></li>`).join('')}</ul>` : '')}
        ${section('Recent activity', eventList(state, ev))}
        <section class="insp-sec"><h4>Preview</h4><pre class="code insp-code" data-file="${esc(p)}"><span class="empty">Loading…</span></pre></section>`;
    }
    if (s.kind === 'symbol') {
      const d = s.data, list = canvas.refsFor(s.id);
      return `<header><span class="insp-ic">${icon(d.kind === 'class' ? 'box' : 'code')}</span><div><b>${esc(d.name)}</b><small>${d.exported ? 'export · ' : ''}${esc(d.kind)} · line ${d.line}</small></div></header>
        ${crumbs(d.file)}
        ${section(`References${list ? ` (${list.length})` : ''}`, list == null ? '<p class="insp-empty">Searching…</p>' : list.length ? `<ul class="insp-list refs">${list.slice(0, 60).map(r => `<li><button data-go="${esc(r.file)}">${icon('file')}${esc(r.file)}<em>:${r.line}</em></button><code>${esc(r.text)}</code></li>`).join('')}</ul>` : '<p class="insp-empty">No other reference in the repository.</p>')}`;
    }
    if (s.kind === 'agent') {
      const a = s.data, r = roleOf(a), active = a.status === 'active';
      const tasks = state.tasks.filter(t => t.session === a.session);
      const done = tasks.filter(t => t.status === 'completed').length;
      const ev = eventsFor(state, e => e.session === a.session && e.agent === a.agent, 20);
      const files = [...new Set(state.events.filter(e => e.session === a.session && e.agent === a.agent && e.file && ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(e.tool)).map(e => e.file))].slice(-8).reverse();
      return `<header><span class="insp-ic av ${active ? 'on' : ''}">${icon(r.icon)}</span><div><b>${esc(r.name)}</b><small>${esc(a.description || a.agentType || 'Agent')}</small></div></header>
        ${controls(state, a)}
        ${kv([['Status', a.stopped ? '<em class="bad">stopped from the canvas</em>' : active ? '<em class="ok">active</em>' : `idle · ${ago(a.lastAt)}`], ['Session', `<code>${esc(a.session)}</code>${a.agent !== 'main' ? ` · <code>${esc(a.agent)}</code>` : ''}`], ['Branch', a.branch ? `<code>${esc(a.branch)}</code>` : state.git.current ? `<code>${esc(state.git.current)}</code> (watched repository)` : null], ['Module', a.file ? `<button class="lnk" data-go="${esc(a.file.includes('/') ? a.file.slice(0, a.file.indexOf('/')) : a.file)}">${esc(a.file.includes('/') ? a.file.slice(0, a.file.indexOf('/')) : a.file)}</button>` : 'none'], ['Current file', a.file ? `<button class="lnk" data-go="${esc(a.file)}">${esc(a.file)}</button>` : null], ['Last action', a.tool ? `${esc(VERBS[a.tool] || a.tool)}${a.detail ? ` <code>${esc(String(a.detail).slice(0, 60))}</code>` : ''}` : null], ['Tool calls', a.calls || 0]])}
        ${tasks.length ? section(`Tasks (${done}/${tasks.length})`, `<div class="progress"><div class="progress-fill" style="width:${Math.round(done / tasks.length * 100)}%"></div></div><ul class="insp-tasks">${tasks.slice(0, 10).map(t => `<li class="${t.status}">${icon(t.status === 'completed' ? 'check' : t.status === 'in_progress' ? 'zap' : 'more')}<span>${esc(t.subject)}</span></li>`).join('')}</ul>`) : ''}
        ${section('Modified files', files.length ? `<ul class="insp-list">${files.map(f => `<li><button data-go="${esc(f)}">${icon('file')}${esc(f)}</button></li>`).join('')}</ul>` : '')}
        ${section('Log', eventList(state, ev) || '<p class="insp-empty">No events received for this agent.</p>')}`;
    }
    if (s.kind === 'branch') {
      const b = s.data, g = state.git, commits = g.commits?.[b.name] || [];
      const ag = [...state.agents.values()].filter(a => (a.branch || g.current) === b.name && a.status === 'active');
      const merged = !!b.merged, isBase = b.name === g.base;
      return `<header><span class="insp-ic">${icon('git')}</span><div><b>${esc(b.name)}</b><small>${[b.current ? `current branch · HEAD ${esc(g.head || '')}` : '', isBase ? 'base branch' : '', merged ? `merged into ${esc(g.base)}` : ''].filter(Boolean).join(' · ') || 'branch'}</small></div></header>
        ${kv([['Worktree', b.worktree ? `<code>${esc(b.worktree)}</code>` : b.current ? 'main checkout' : null], ['Remote tracking', b.ahead || b.behind ? `↑ ${b.ahead} ahead · ↓ ${b.behind} behind` : 'up to date or untracked'], ['Last commit', b.date ? ago(b.date) : null], ['Merge', isBase ? null : merged ? `yes, every commit is in ${esc(g.base)}` : b.aheadBase != null ? `${b.aheadBase} commit${b.aheadBase === 1 ? '' : 's'} not in ${esc(g.base)} yet` : `not merged into ${esc(g.base)}`]])}
        ${b.health ? section(`Health · ${esc(b.health.summary)}`, `<ul class="insp-health">${b.health.checks.map(c => `<li class="${c.level}"><i></i><div><b>${esc(c.label)}</b><span>${esc(c.detail)}</span>${c.files?.length ? `<div class="insp-hfiles">${c.files.map(f => `<button data-go="${esc(f)}">${esc(f)}</button>`).join('')}</div>` : ''}</div></li>`).join('')}</ul>`, b.health.level === 'bad' ? 'bad' : '') : ''}
        ${section('Agents on this branch', ag.length ? `<ul class="insp-list">${ag.map(a => `<li><button data-agent="${esc(a.key)}">${icon(roleOf(a).icon)}${esc(roleOf(a).name)}</button><span>${esc(a.description || '')}</span></li>`).join('')}</ul>` : '')}
        ${b.current && g.conflicts?.length ? section('Conflicts', `<ul class="insp-list">${g.conflicts.map(f => `<li><button data-go="${esc(f)}">${icon('close')}${esc(f)}</button><span class="bad">conflict</span></li>`).join('')}</ul>`, 'bad') : ''}
        ${b.current ? section('Modified files', g.changes.length ? `<ul class="insp-list">${g.changes.slice(0, 12).map(c => `<li><button data-go="${esc(c.file)}">${icon('file')}${esc(c.file)}</button><span class="g-${c.status}">${c.status === 'A' ? 'new' : c.status === 'D' ? 'deleted' : `+${c.add} −${c.del}`}</span></li>`).join('')}</ul>` : '<p class="insp-empty">Clean working tree.</p>') : ''}
        ${section('Commits', commits.length ? `<ul class="insp-commits">${commits.map(c => `<li><code>${esc(c.short)}</code><span>${esc(c.subject)}</span><small>${esc(c.author)} · ${ago(c.at)}</small></li>`).join('')}</ul>` : '<p class="insp-empty">No commits read.</p>')}`;
    }
    if (s.kind === 'edge') {
      const e = s.edge;
      const name = n => n.kind === 'agent' ? roleOf(n.data).name : n.kind === 'branch' ? n.data.name : n.data.name || n.data.path || n.id;
      const title = e.kind === 'import' ? 'Dependency' : e.kind === 'link' ? 'Manual link' : e.kind === 'ref' ? 'Reference' : 'Link';
      return `<header><span class="insp-ic">${icon('deps')}</span><div><b>${title}</b><small>${esc(name(e.from))} → ${esc(name(e.to))}</small></div></header>
        ${e.kind === 'import' ? section(`${e.count} import${e.count > 1 ? 's' : ''}`, `<ul class="insp-list refs">${e.files.map(f => `<li><button data-go="${esc(f.from)}">${icon('file')}${esc(f.from)}</button><span>→ ${esc(f.to)}</span></li>`).join('')}${e.count > e.files.length ? `<li><span>… ${e.count - e.files.length} more</span></li>` : ''}</ul>`) : ''}
        ${e.kind === 'link' ? `<p class="insp-empty">Link drawn by hand on the canvas. It does not exist in the code.</p><div class="row"><button class="btn danger" data-del-link="${esc(e.from.id)}|${esc(e.to.id)}">Remove the link</button></div>` : ''}`;
    }
    if (s.kind === 'group') {
      const g = s.group;
      return `<header><span class="insp-ic">${icon('modules')}</span><div><input class="insp-rename" data-group="${esc(g.id)}" value="${esc(g.name)}"><small>${g.members.length} item${g.members.length > 1 ? 's' : ''}</small></div></header>
        <p class="insp-empty">Visual group saved in this browser. Press Delete to dissolve it.</p>`;
    }
    if (s.kind === 'app') {
      const u = safeHttpUrl(s.data.url);
      if (!u) return `<header><span class="insp-ic">${icon('play')}</span><div><b>Live app</b><small>URL rejected (http/https only)</small></div></header>`;
      return `<header><span class="insp-ic">${icon('play')}</span><div><b>Live app</b><small><a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a></small></div></header>
        <iframe class="insp-iframe" src="${esc(u)}" sandbox="allow-scripts allow-forms allow-popups" referrerpolicy="no-referrer"></iframe>`;
    }
    return '';
  }
  /** Stop / resume / message, and the calls this agent waits on. */
  function controls(state, a) {
    const pend = (state.approvals || []).filter(p => p.session === a.session && p.agent === a.agent);
    const cols = (state.collisions || []).filter(c => c.agents.includes(a.key));
    const colHtml = cols.length ? section('Collisions', `<ul class="insp-list">${cols.map(c => `<li><button data-go="${esc(c.file || c.dir || '')}">${icon('alert')}${esc(collisionText(state, c))}</button></li>`).join('')}</ul>`, 'bad') : '';
    if (!controllable(a)) return colHtml + `<p class="insp-empty">Control from the canvas needs a Claude Code session: this tool has no channel back.</p>`;
    const main = a.agent === 'main';
    return `<section class="insp-sec insp-ctl ${pend.length ? 'wait' : ''}"><h4>Control</h4>
      ${pend.map(p => { const t = approvalText(p); return `<div class="insp-wait" data-approval="${esc(p.id)}"><span>${icon('shield')}Waits for you: ${esc(t.verb)}${t.target ? `<code>${esc(t.target)}</code>` : ''}<small>${esc(t.reason)}</small></span><button class="btn" data-decide="allow">Allow</button><button class="btn danger" data-decide="deny">Deny</button></div>`; }).join('')}
      <div class="row">${a.stopped
        ? `<button class="btn" data-ctl="resume">${icon('play')}Resume</button>`
        : `<button class="btn danger" data-ctl="stop" title="${main ? 'Abort the running turn' : 'Refuse its next tool calls and tell it to stop'}">${icon('stop')}Stop</button>`}</div>
      <div class="insp-send"><textarea class="insp-msg" rows="2" maxlength="4000" placeholder="${main ? 'Message to the session (sent as your prompt)' : 'Message to this subagent'}"></textarea><button class="btn" data-ctl="message" title="Send (Ctrl+Enter)">${icon('send')}</button></div>
    </section>${colHtml}`;
  }
  /** Collisions on a file or folder, for its inspector. */
  function collisionsFor(state, path, isDir) {
    const cols = (state.collisions || []).filter(c => isDir ? (c.dir === path || (c.file && under(c.file, path) && path !== '')) : c.file === path);
    return cols.length ? section('Collisions', `<ul class="insp-list">${cols.map(c => `<li><span class="${c.level}">${icon('alert')}${esc(collisionText(state, c))}</span><button class="lnk" data-dismiss-col="${esc(c.id)}">dismiss</button></li>`).join('')}</ul>`, 'bad') : '';
  }

  const topOf = (path, within) => { const rest = within ? path.slice(within.length).replace(/^\//, '') : path; const parts = (within ? within + '/' : '') + (rest.includes('/') ? rest.slice(0, rest.indexOf('/')) : rest); return parts.replace(/^\//, ''); };

  const codeCache = new Map();
  async function loadCode(pre) {
    const path = pre.dataset.file;
    if (codeCache.has(path)) { pre.innerHTML = codeCache.get(path); return; }
    try {
      const r = await fetch(`/api/file?path=${encodeURIComponent(path)}&limit=160`); if (!r.ok) throw new Error(r.status);
      const f = await r.json();
      pre.innerHTML = f.lines.map((l, i) => `<div><span class="ln">${i + 1}</span>${highlight(l)}</div>`).join('') || '<span class="empty">Empty file</span>';
      codeCache.set(path, pre.innerHTML); setTimeout(() => codeCache.delete(path), 15000);
    } catch { pre.innerHTML = '<span class="empty">Preview unavailable</span>'; }
  }

  function render() {
    if (!sel) { el.classList.add('hidden'); return; }
    let html = body(sel);
    if (sel.kind === 'dir' || sel.kind === 'file') html = html.replace('</header>', `</header>${collisionsFor(getState(), sel.data.path, sel.kind === 'dir')}`);
    el.innerHTML = `<button class="insp-close" title="Close (Esc)">${icon('close')}</button>${html}`;
    el.classList.toggle('wide', sel.kind === 'app');
    el.classList.remove('hidden');
    const pre = el.querySelector('.insp-code'); if (pre) loadCode(pre);
    position();
  }
  function position() {
    if (!sel || el.classList.contains('hidden')) return;
    const r = anchorId ? canvas.screenRect(anchorId) : null;
    const c = anchorId ? canvas.clusterRect(anchorId) || r : null;
    const W = window.innerWidth, H = window.innerHeight, w = el.offsetWidth, h = el.offsetHeight;
    // stay below the control tray when it shows
    const tray = document.querySelector('.tray:not(.hidden)');
    const top = tray ? Math.round(tray.getBoundingClientRect().bottom) + 10 : 76;
    let x, y;
    if (r) {
      // sit beside the node and its revealed children, on the side with more room
      const right = c.x + c.w + 18, left = c.x - w - 18;
      const roomRight = W - 12 - (right + w), roomLeft = left - 12;
      x = roomRight >= 0 ? right : roomLeft >= 0 ? left : roomRight > roomLeft ? Math.min(right, W - w - 12) : Math.max(12, left);
      y = Math.max(top, Math.min(H - h - 12, r.y));
    } else { x = W - w - 20; y = top + 4; }
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }
  el.addEventListener('click', ev => {
    if (ev.target.closest('.insp-close')) { hide(); onClose?.(); return; }
    const go = ev.target.closest('[data-go]'); if (go) { canvas.focus(go.dataset.go); return; }
    const ag = ev.target.closest('[data-agent]'); if (ag) { canvas.focus('a:' + ag.dataset.agent); return; }
    const del = ev.target.closest('[data-del-link]'); if (del) { const [f, t] = del.dataset.delLink.split('|'); canvas.removeLink(f, t); hide(); onClose?.(); return; }
    const dc = ev.target.closest('[data-dismiss-col]'); if (dc) { dismissCollision(dc.dataset.dismissCol); return; }
    const dd = ev.target.closest('[data-decide]');
    if (dd) { dd.disabled = true; decide(dd.closest('[data-approval]').dataset.approval, dd.dataset.decide).catch(() => toast('WA2 server unreachable')); return; }
    const ctl = ev.target.closest('[data-ctl]'); if (ctl && sel?.kind === 'agent') act(ctl.dataset.ctl);
  });
  el.addEventListener('keydown', ev => {
    if (ev.target.closest('.insp-msg') && ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); act('message'); }
    if (ev.target.closest('.insp-msg')) ev.stopPropagation();
  });
  async function act(kind) {
    const a = sel.data, ta = el.querySelector('.insp-msg');
    const text = kind === 'message' ? (ta?.value || '').trim() : '';
    if (kind === 'message' && !text) { ta?.focus(); return; }
    const r = await sendCommand(a, kind, text).catch(() => null);
    if (!r || r.error) { toast(r?.error || 'WA2 server unreachable'); return; }
    // live events may have re-rendered the panel meanwhile: clear the current box
    if (kind === 'message') { const now = el.querySelector('.insp-msg'); if (now && now.value.trim() === text) now.value = ''; }
  }
  el.addEventListener('change', ev => { const inp = ev.target.closest('.insp-rename'); if (inp) canvas.renameGroup(inp.dataset.group, inp.value.trim() || 'Group'); });
  el.addEventListener('wheel', ev => ev.stopPropagation());
  el.addEventListener('pointerdown', ev => ev.stopPropagation());

  function show(s) {
    sel = s; anchorId = s && s.id ? s.id : null;
    render();
  }
  function hide() { sel = null; anchorId = null; el.classList.add('hidden'); }
  return {
    show, hide, position,
    /** Data changed: re-render the same selection without losing the code preview scroll. */
    refresh() {
      if (!sel) return;
      const pre = el.querySelector('.insp-code'), scroll = pre?.scrollTop;
      // keep a message being typed across live re-renders
      const ta = el.querySelector('.insp-msg'), draft = ta ? { value: ta.value, focus: document.activeElement === ta, start: ta.selectionStart, end: ta.selectionEnd } : null;
      if (sel.kind === 'agent') { const fresh = getState().agents.get(sel.data.key); if (fresh) sel = { ...sel, data: fresh }; }
      render();
      const pre2 = el.querySelector('.insp-code'); if (pre2 && scroll) pre2.scrollTop = scroll;
      const ta2 = el.querySelector('.insp-msg');
      if (ta2 && draft) { ta2.value = draft.value; if (draft.focus) { ta2.focus(); ta2.setSelectionRange(draft.start, draft.end); } }
    },
    current: () => sel,
  };
}
