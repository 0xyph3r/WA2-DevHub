// Agent control and multi-agent collision tracking. Pure state, no I/O:
// server/index.mjs wires it to HTTP, tested in test/control.test.mjs.
//
//   Control: the browser queues commands (stop, resume, message) for one agent
//   of one session; the Claude Code hooks module of that session collects them
//   with a long poll. Tool calls can be held for approval on the canvas
//   (gate: off | collisions | writes) and are released by the browser.
//
//   Collisions: two different agents writing the same file within WINDOW_MS is
//   a collision (level bad); two agents writing in the same folder within
//   NEAR_MS is an overlap (level warn). Only real tool events feed it.

export const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
export const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);
export const GATES = ['off', 'collisions', 'writes'];
export const WINDOW_MS = 15 * 60 * 1000;
export const NEAR_MS = 5 * 60 * 1000;
export const COLLISION_TTL_MS = 30 * 60 * 1000;
export const APPROVAL_TIMEOUT_MS = 90 * 1000;
const MAX_TEXT = 4000;

const parentDir = p => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

export function createControl({ now = () => Date.now() } = {}) {
  const commands = [];               // { id, session, agent, kind, text?, at }
  const approvals = new Map();       // id -> approval
  const stopped = new Set();         // `${session}:${agent}`
  const writes = new Map();          // file -> Map(agentKey -> at)
  const collisions = new Map();      // id -> collision
  const dismissed = new Map();       // id -> { agents, at }
  let seq = 0;
  const nextId = p => `${p}${(++seq).toString(36)}${now().toString(36)}`;

  // ---------- commands ----------
  function command({ session, agent = 'main', kind, text } = {}) {
    if (typeof session !== 'string' || !session) return { error: 'session required' };
    if (!['stop', 'resume', 'message'].includes(kind)) return { error: 'kind must be stop, resume or message' };
    agent = String(agent || 'main');
    let body;
    if (kind === 'message') {
      body = String(text ?? '').trim().slice(0, MAX_TEXT);
      if (!body) return { error: 'empty message' };
    }
    const key = `${session}:${agent}`;
    if (kind === 'stop') stopped.add(key);
    if (kind === 'resume') stopped.delete(key);
    const c = { id: nextId('c'), session, agent, kind, ...(body ? { text: body } : {}), at: now() };
    commands.push(c);
    if (commands.length > 200) commands.shift();
    return { command: c };
  }
  /** Removes and returns the commands waiting for `session`. */
  function take(session) {
    const out = [];
    for (let i = commands.length - 1; i >= 0; i--) if (commands[i].session === session) out.unshift(...commands.splice(i, 1));
    return out;
  }
  const pendingFor = session => commands.some(c => c.session === session);
  const isStopped = (session, agent) => stopped.has(`${session}:${agent}`);
  /** A stopped agent that starts again by itself (new spawn) is no longer stopped. */
  function clearStop(session, agent) { return stopped.delete(`${session}:${agent}`); }

  // ---------- collisions ----------
  function sweep() {
    const t = now();
    for (const [file, m] of writes) { for (const [k, at] of m) if (t - at > WINDOW_MS) m.delete(k); if (!m.size) writes.delete(file); }
    for (const [id, c] of collisions) if (t - c.lastAt > COLLISION_TTL_MS) collisions.delete(id);
    for (const [id, d] of dismissed) if (t - d.at > COLLISION_TTL_MS) dismissed.delete(id);
  }
  /** Agents (other than `key`) that wrote `file` within WINDOW_MS. */
  function writersOf(file, key) {
    const t = now(), m = writes.get(file);
    return m ? [...m].filter(([k, at]) => k !== key && t - at <= WINDOW_MS).map(([k]) => k) : [];
  }
  function upsert(id, level, target, keys, t) {
    const prev = collisions.get(id);
    const agents = [...new Set([...(prev?.agents || []), ...keys])];
    // a dismissed collision stays quiet while the same agents keep going; a new agent re-raises it
    const quiet = dismissed.get(id);
    if (quiet && agents.every(k => quiet.agents.includes(k))) return null;
    dismissed.delete(id);
    const c = { id, level, ...target, agents, firstAt: prev?.firstAt ?? t, lastAt: t, count: (prev?.count || 0) + 1 };
    collisions.set(id, c);
    return { collision: c, isNew: !prev || prev.agents.length !== agents.length };
  }
  /**
   * Feeds one normalized tool event. Returns { changed, fresh: [collision] }:
   * `fresh` lists collisions that are new or gained an agent (worth a toast).
   */
  function trackTool(e) {
    sweep();
    if (e?.type !== 'tool' || !WRITE_TOOLS.has(e.tool) || !e.file || e.isError) return { changed: false, fresh: [] };
    const key = `${e.session}:${e.agent}`, file = String(e.file), t = now();
    const fresh = [];
    let changed = false;
    const same = writersOf(file, key);
    if (same.length) {
      const r = upsert('f:' + file, 'bad', { file }, [key, ...same], t);
      if (r) { changed = true; if (r.isNew) fresh.push(r.collision); }
    } else {
      const dir = parentDir(file);
      const near = new Set();
      for (const [f, m] of writes) {
        if (f === file || parentDir(f) !== dir) continue;
        for (const [k, at] of m) if (k !== key && t - at <= NEAR_MS) near.add(k);
      }
      if (near.size) {
        const r = upsert('d:' + dir, 'warn', { dir }, [key, ...near], t);
        if (r) { changed = true; if (r.isNew) fresh.push(r.collision); }
      }
    }
    let m = writes.get(file);
    if (!m) { m = new Map(); writes.set(file, m); }
    m.set(key, t);
    return { changed, fresh };
  }
  function dismiss(id) {
    const c = collisions.get(id);
    if (!c) return false;
    collisions.delete(id);
    dismissed.set(id, { agents: c.agents, at: now() });
    return true;
  }
  /** Would a write of `file` by this agent collide right now? */
  function wouldCollide(session, agent, file) {
    return !!file && writersOf(String(file), `${session}:${agent}`).length > 0;
  }
  const listCollisions = () => { sweep(); return [...collisions.values()].sort((a, b) => b.lastAt - a.lastAt); };

  // ---------- approvals ----------
  /**
   * The hooks module asks before running a tool call. Returns { approval } when
   * the call must wait for the browser, or { approval: null } when it may run.
   */
  function request({ session, agent = 'main', tool, file, detail, gate }) {
    if (typeof session !== 'string' || !session || typeof tool !== 'string') return { error: 'session and tool required' };
    agent = String(agent || 'main');
    const write = WRITE_TOOLS.has(tool), cmd = COMMAND_TOOLS.has(tool);
    let reason = null, others = [];
    if (write && file) others = writersOf(String(file), `${session}:${agent}`);
    if (gate === 'collisions' && others.length) reason = 'collision';
    else if (gate === 'writes' && (write || cmd)) reason = others.length ? 'collision' : write ? 'write' : 'command';
    if (!reason) return { approval: null };
    const t = now();
    const a = {
      id: nextId('p'), session, agent, tool, reason, status: 'pending', at: t, expiresAt: t + APPROVAL_TIMEOUT_MS,
      ...(file ? { file: String(file).slice(0, 1024) } : {}),
      ...(detail ? { detail: String(detail).slice(0, 300) } : {}),
      ...(others.length ? { with: others } : {}),
    };
    approvals.set(a.id, a);
    return { approval: a };
  }
  function decide(id, decision) {
    const a = approvals.get(id);
    if (!a) return { error: 'unknown approval' };
    if (a.status !== 'pending') return { approval: a };
    if (!['allow', 'deny'].includes(decision)) return { error: 'decision must be allow or deny' };
    a.status = decision; a.decidedAt = now();
    return { approval: a };
  }
  /** Pending approvals past their deadline become `expired` (the tool then runs as usual). */
  function expire() {
    const t = now(), out = [];
    for (const a of approvals.values()) if (a.status === 'pending' && t >= a.expiresAt) { a.status = 'expired'; a.decidedAt = t; out.push(a); }
    for (const [id, a] of approvals) if (a.status !== 'pending' && t - (a.decidedAt || a.at) > 10 * 60 * 1000) approvals.delete(id);
    return out;
  }
  const getApproval = id => approvals.get(id) || null;
  const pendingApprovals = () => [...approvals.values()].filter(a => a.status === 'pending');
  /** Ends every pending approval of an agent (stopped, or its session ended). */
  function denyAllFor(session, agent) {
    const out = [];
    for (const a of approvals.values()) if (a.status === 'pending' && a.session === session && (agent == null || a.agent === agent)) { a.status = 'deny'; a.decidedAt = now(); out.push(a); }
    return out;
  }

  return {
    command, take, pendingFor, isStopped, clearStop, stopped: () => [...stopped],
    trackTool, dismiss, wouldCollide, listCollisions,
    request, decide, expire, getApproval, pendingApprovals, denyAllFor,
  };
}
