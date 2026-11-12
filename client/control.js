// Acting on agents from the canvas, and the multi-agent collision alerts.
//   - commands: stop, resume, message (Claude Code sessions: the hooks module
//     collects them; other tools have no way to receive them)
//   - approvals: tool calls held by the gate, answered Allow / Deny here
//   - collisions: two agents on the same file (bad) or folder (warn)
// The tray floats under the top bar and only shows when something waits.
import { icon } from './icons.js';
import { roleOf } from './roles.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
const ago = at => { const s = Math.max(0, Math.round((Date.now() - at) / 1000)); return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };

/** Only Claude Code sessions run the hooks module that receives commands. */
export const controllable = a => !!a && (!a.provider || a.provider === 'claude');

export const sendCommand = (a, kind, text) => post('/api/control', { session: a.session, agent: a.agent, kind, ...(text ? { text } : {}) });
export const decide = (id, decision) => post('/api/approval/decide', { id, decision });
export const dismissCollision = id => post('/api/collisions', { dismiss: id });
export const setGate = gate => post('/api/config', { gate });

export const GATES_ORDER = ['off', 'collisions', 'writes'];
export const GATE_LABELS = {
  off: 'Off: agents run as usual',
  collisions: 'On collisions: hold a write to a file another agent is editing',
  writes: 'Always: hold every file write and shell command',
};

export function agentName(state, key) {
  const a = state.agents.get(key);
  return a ? roleOf(a).name : key.split(':').pop();
}
export function collisionText(state, c) {
  const names = c.agents.map(k => agentName(state, k));
  const who = names.length > 2 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names.join(' and ');
  return c.level === 'bad' ? `${who} both edit ${c.file}` : `${who} work in the same folder ${c.dir || '(root)'}`;
}
const REASONS = { collision: 'another agent edits this file', write: 'file write', command: 'shell command' };
export function approvalText(a) {
  const target = a.file || (a.detail ? String(a.detail).slice(0, 80) : '');
  return { verb: `${a.tool}${target ? ' ' : ''}`, target, reason: REASONS[a.reason] || a.reason };
}

export function createControlTray(root, { getState, focus, toast }) {
  const el = document.createElement('div');
  el.className = 'tray hidden';
  root.appendChild(el);
  let timer = 0;

  function render() {
    const state = getState();
    const approvals = state.approvals || [], collisions = (state.collisions || []).slice(0, 4);
    if (!approvals.length && !collisions.length) { el.classList.add('hidden'); el.innerHTML = ''; clearInterval(timer); timer = 0; return; }
    el.innerHTML = approvals.map(a => {
      const t = approvalText(a), left = Math.max(0, Math.round((a.expiresAt - Date.now()) / 1000));
      return `<div class="tray-card wait" data-approval="${esc(a.id)}">
        <span class="tray-ic">${icon('shield')}</span>
        <div class="tray-t"><b><button class="lnk" data-focus="a:${esc(a.session)}:${esc(a.agent)}">${esc(agentName(state, `${a.session}:${a.agent}`))}</button> wants to ${esc(t.verb)}${t.target ? `<code>${esc(t.target)}</code>` : ''}</b>
          <small>${esc(t.reason)}${a.with?.length ? ` · also edited by ${esc(a.with.map(k => agentName(state, k)).join(', '))}` : ''} · runs normally in ${left} s</small></div>
        <button class="btn" data-decide="allow">${icon('check')}Allow</button>
        <button class="btn danger" data-decide="deny">${icon('close')}Deny</button></div>`;
    }).join('') + collisions.map(c => `<div class="tray-card ${c.level}" data-collision="${esc(c.id)}">
        <span class="tray-ic">${icon('alert')}</span>
        <div class="tray-t"><b>${c.level === 'bad' ? 'Collision' : 'Overlap'}: ${esc(collisionText(state, c))}</b><small>${c.count} write${c.count > 1 ? 's' : ''} · last ${ago(c.lastAt)}</small></div>
        <button class="btn ghost" data-focus="${c.file ? `f:${esc(c.file)}` : `d:${esc(c.dir)}`}">Show</button>
        <button class="btn ghost" data-dismiss title="Hide until another agent joins">${icon('close')}</button></div>`).join('');
    el.classList.remove('hidden');
    if (approvals.length && !timer) timer = setInterval(render, 1000);
    if (!approvals.length && timer) { clearInterval(timer); timer = 0; }
  }

  el.addEventListener('click', async ev => {
    const f = ev.target.closest('[data-focus]');
    if (f) { const id = f.dataset.focus; focus(id.startsWith('a:') ? id : id.slice(2), id); return; }
    const d = ev.target.closest('[data-decide]');
    if (d) {
      const id = d.closest('[data-approval]').dataset.approval;
      d.disabled = true;
      const r = await decide(id, d.dataset.decide).catch(() => null);
      toast(r?.approval ? (r.approval.status === 'allow' ? 'Allowed' : r.approval.status === 'deny' ? 'Denied: the agent was told not to retry' : `Already ${r.approval.status}`) : 'WA2 server unreachable');
      return;
    }
    const x = ev.target.closest('[data-dismiss]');
    if (x) dismissCollision(x.closest('[data-collision]').dataset.collision);
  });
  el.addEventListener('pointerdown', ev => ev.stopPropagation());
  el.addEventListener('wheel', ev => ev.stopPropagation());
  return { render };
}
