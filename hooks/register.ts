// WA2 hooks module: the Claude Code side of the plugin.
//   /wa2            start the WA2 server for this repository and open the web interface
//   /wa2 open       open the interface again
//   /wa2 app <url>  set the URL of the application under construction (App live tab)
//   /wa2 status     say whether the server answers
// Every tool call, subagent start/stop and task list of the session is
// forwarded to the server (with the session's root, so it can show the branch
// each session works on), which streams it to the browser.
//
// Control from the canvas: a long poll (/api/control/wait) brings back the
// commands the person sent from the browser for this session: stop (the main
// turn is aborted; the agent's next tool calls are refused until the person
// types a prompt, sends a message or clicks Resume), resume, and
// message (a prompt for the main session, a SendMessage for a subagent). When
// the approval gate is on, a tool call waits for Allow / Deny on the canvas
// (90 s at most, then it runs through Claude Code's own permissions as usual).
import type { Register, EngineInterface } from 'claude-code'

const PORT = 4242
const BASE = `http://127.0.0.1:${PORT}`
const FILE_KEYS = ['file_path', 'notebook_path', 'path'] as const

let sessionId = 'session'
let sessionRoot = ''
let offlineUntil = 0
let mainTurnId = ''               // running main-loop turn, for stop
let gate = 'off'                  // approval gate, as the server last said
let viewers = 0                   // browsers watching, as the server last said
let polling = false
let gateKnown = false              // first answer from the server received
let pollTimer: { cancel: () => void } | null = null
const stopped = new Set<string>() // agents of this session stopped from the canvas
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell'])
const LONG_POLL_MS = 15_000
const APPROVAL_MAX_MS = 90_000
const STOP_REASON = 'Stopped by the user from WA2 - DevHub. Do not call any more tools: reply with a short status of what you did and what is left.'

type Event = Record<string, unknown> & { type: string }
type Engine = EngineInterface

function fileOf(input: Record<string, unknown>): string | undefined {
  for (const key of FILE_KEYS) {
    const v = input[key]
    if (typeof v === 'string' && v) return v
  }
  return undefined
}

async function post($: Engine, events: Event[]): Promise<void> {
  events = events.map(e => ({ provider: 'claude', ...e }))
  if (Date.now() < offlineUntil) return
  try {
    if (!sessionRoot) sessionRoot = await $.session.root()
    const body = JSON.stringify(events.map(ev => ({ root: sessionRoot, ...ev })))
    const r = await $.http.fetch(`${BASE}/api/event`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    if (!r.ok) offlineUntil = Date.now() + 10_000
  } catch {
    offlineUntil = Date.now() + 10_000
  }
}

async function getJson($: Engine, path: string, init?: Parameters<Engine['http']['fetch']>[1]): Promise<any> {
  const r = await $.http.fetch(`${BASE}${path}`, init)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return JSON.parse(r.text)
}

type Command = { id: string; agent: string; kind: 'stop' | 'resume' | 'message'; text?: string }

async function runCommand($: Engine, c: Command): Promise<void> {
  const main = c.agent === 'main'
  if (c.kind === 'stop') {
    // aborting alone is not enough: a background job finishing can start a new
    // turn, so every later tool call of the agent is refused too
    stopped.add(c.agent)
    if (main) {
      if (mainTurnId) { try { await $.turn.abort({ turnId: mainTurnId }) } catch { /* the turn already ended */ } }
    } else {
      try { await $.session.send({ to: { agentId: c.agent }, text: STOP_REASON }) } catch { /* agent already finished */ }
    }
    $.ui.toast(`WA2: ${main ? 'main session' : `agent ${c.agent}`} stopped from the canvas`)
  } else if (c.kind === 'resume') {
    stopped.delete(c.agent)
  } else if (c.kind === 'message' && c.text) {
    if (main) { stopped.delete('main'); await $.prompt.submit({ text: c.text, asUser: true }) }
    else { stopped.delete(c.agent); await $.session.send({ to: { agentId: c.agent }, text: c.text }) }
  }
}

/** One poll (long unless `now`): commands for this session, plus the gate setting and viewer count. */
async function pollControl($: Engine, now = false): Promise<void> {
  if (polling || Date.now() < offlineUntil) return
  polling = true
  try {
    const wait = now || !gateKnown ? 0 : LONG_POLL_MS
    const r = await getJson($, `/api/control/wait?session=${encodeURIComponent(sessionId)}&timeout=${wait}`)
    gate = typeof r.gate === 'string' ? r.gate : 'off'
    viewers = Number(r.viewers) || 0
    gateKnown = true
    for (const c of (r.commands || []) as Command[]) {
      try { await runCommand($, c) } catch (err) { $.ui.log(`wa2: command ${c.kind} failed (${String(err)})`, { to: 'debug' }) }
    }
  } catch {
    offlineUntil = Date.now() + 10_000
  } finally {
    polling = false
  }
}
function startPolling($: Engine): void {
  if (pollTimer) return
  void pollControl($, true)
  pollTimer = $.clock.every(1000, () => { void pollControl($) })
}

/** Asks the canvas before a tool call; 'run' also when nobody answers in time. */
async function approve($: Engine, ask: Record<string, unknown>): Promise<'run' | 'deny'> {
  if (!gateKnown) await pollControl($, true)
  if (gate === 'off' || viewers === 0 || Date.now() < offlineUntil) return 'run'
  try {
    const { approval } = await getJson($, '/api/approval', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: sessionId, ...ask }) })
    if (!approval) return 'run'
    const until = Date.now() + APPROVAL_MAX_MS + 5_000
    let a = approval
    while (a.status === 'pending' && Date.now() < until) {
      a = (await getJson($, `/api/approval/wait?id=${encodeURIComponent(a.id)}&timeout=${LONG_POLL_MS}`)).approval
    }
    return a.status === 'deny' ? 'deny' : 'run'
  } catch {
    return 'run'
  }
}

async function healthy($: Engine): Promise<boolean> {
  try { return (await $.http.fetch(`${BASE}/api/health`)).ok } catch { return false }
}

async function openBrowser($: Engine, url: string): Promise<void> {
  const os = await $.env.get('OS')
  const argv = os === 'Windows_NT'
    ? ['cmd', '/c', 'start', '', url]
    : ['sh', '-c', `(command -v xdg-open >/dev/null 2>&1 && xdg-open "${url}") || open "${url}"`]
  try { await $.process.run(argv, { timeoutMs: 8000 }) } catch { /* the UI url is printed anyway */ }
}

async function startServer($: Engine, root: string): Promise<string> {
  if (await healthy($)) {
    offlineUntil = 0
    await openBrowser($, BASE)
    return `WA2 already running: ${BASE}`
  }
  void (async () => {
    const child = $.process.spawn({ argv: ['node', `${$.plugin.root}/server/index.mjs`, '--repo', root, '--port', String(PORT), '--open'] })
    try {
      for await (const chunk of child) {
        if ('text' in chunk && chunk.text.trim()) $.ui.log(`wa2: ${chunk.text.trim()}`, { to: 'debug' })
      }
    } catch (err) {
      $.ui.log(`wa2: server stopped (${String(err)})`, { to: 'debug' })
    }
  })()
  for (let i = 0; i < 24; i++) {
    await $.clock.sleep(250)
    if (await healthy($)) {
      offlineUntil = 0
      $.ui.status(`WA2 :${PORT}`)
      return `WA2 started: ${BASE} (repo ${root})`
    }
  }
  return `WA2 did not answer on ${BASE}. Check that \`node\` is on the PATH, or start it by hand: node "${$.plugin.root}/server/index.mjs" --repo "${root}" --open`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    sessionId = await $.session.id()
    sessionRoot = await $.session.root()
    startPolling($)
    await $.command.register({ name: 'wa2', description: 'Open WA2 - DevHub (live canvas of the project, its agents, branches and app)', argumentHint: '[open | app <url> | status]' })
    if (await healthy($)) {
      $.ui.status(`WA2 :${PORT}`)
      void post($, [{ type: 'agent', phase: 'spawn', agent: 'main', session: sessionId, description: `Main session · ${e.cwd.split(/[\\/]/).pop()}`, agentType: 'main', at: Date.now() }])
    }
    return next(e)
  })

  on('command.run', { command: 'wa2' }, async ($, e) => {
    const [sub = '', ...rest] = e.args.trim().split(/\s+/)
    const root = await $.session.root()
    if (sub === 'open') { await openBrowser($, BASE); return { text: `WA2: ${BASE}` } }
    if (sub === 'status') return { text: (await healthy($)) ? `WA2 online: ${BASE}` : 'WA2 offline. Run /wa2 to start it.' }
    if (sub === 'app') {
      const url = rest.join(' ')
      try { await $.http.fetch(`${BASE}/api/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app: url }) }) } catch { return { text: 'WA2 offline. Run /wa2 first.' } }
      return { text: url ? `Live app: ${url}` : 'Live app disabled.' }
    }
    const text = await startServer($, root)
    startPolling($)
    void post($, [{ type: 'agent', phase: 'spawn', agent: 'main', session: sessionId, description: `Main session · ${root.split(/[\\/]/).pop()}`, agentType: 'main', at: Date.now() }])
    $.ui.toast(text)
    return { text }
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const agent = typeof input.agentId === 'string' ? input.agentId : 'main'
    const file = fileOf(input)
    const detail = e.tool === 'Bash' || e.tool === 'PowerShell'
      ? (typeof input.command === 'string' ? input.command.slice(0, 200) : undefined)
      : typeof input.description === 'string' ? input.description.slice(0, 200) : undefined
    if (stopped.has(agent)) {
      void post($, [{ type: 'tool', phase: 'end', id: e.tool_use_id, tool: e.tool, agent, session: sessionId, file, detail: 'blocked: stopped from the canvas', isError: true, blocked: true, at: Date.now() }])
      return { deny: STOP_REASON }
    }
    const gated = WRITE_TOOLS.has(e.tool) || COMMAND_TOOLS.has(e.tool)
    if (gated && (await approve($, { agent, tool: e.tool, file, detail })) === 'deny') {
      void post($, [{ type: 'tool', phase: 'end', id: e.tool_use_id, tool: e.tool, agent, session: sessionId, file, detail: 'denied on the canvas', isError: true, blocked: true, at: Date.now() }])
      return { deny: 'Denied by the user from WA2 - DevHub. Do not retry this call; ask the user or choose another approach.' }
    }
    const started = Date.now()
    void post($, [{ type: 'tool', phase: 'start', id: e.tool_use_id, tool: e.tool, agent, session: sessionId, file, detail, at: started }])

    const ran = await next(e)

    const ended = Date.now()
    const isError = ran.deny === undefined && (ran as { isError?: boolean }).isError === true
    const events: Event[] = [{ type: 'tool', phase: 'end', id: e.tool_use_id, tool: e.tool, agent, session: sessionId, file, detail, isError, durationMs: ended - started, at: ended }]
    if (e.tool === 'TodoWrite' && Array.isArray(input.todos)) {
      events.push({ type: 'task', kind: 'todos', session: sessionId, agent, todos: input.todos, at: ended })
    } else if (e.tool === 'TaskCreate' && typeof input.subject === 'string') {
      const text = typeof (ran as { text?: unknown }).text === 'string' ? (ran as { text: string }).text : ''
      const id = (text.match(/#(\d+)/) || [])[1]
      events.push({ type: 'task', kind: 'create', session: sessionId, agent, subject: input.subject, status: 'pending', id: id ? `${sessionId}:${id}` : undefined, at: ended })
    } else if (e.tool === 'TaskUpdate' && input.taskId != null) {
      events.push({ type: 'task', kind: 'update', session: sessionId, agent, id: `${sessionId}:${String(input.taskId)}`, status: typeof input.status === 'string' ? input.status : undefined, subject: typeof input.subject === 'string' ? input.subject : undefined, at: ended })
    }
    void post($, events)
    return ran
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.deny === undefined && r.agentId) {
      void post($, [{ type: 'agent', phase: 'spawn', agent: r.agentId, session: sessionId, description: e.description, agentType: e.subagentType, at: Date.now() }])
    }
    return r
  }).catch(($, e, next) => next(e))

  // a prompt the person typed (terminal, phone, SDK) lifts a stop of the main session
  on('prompt.submit', async ($, e, next) => {
    const kind = (e as { origin?: { kind?: string } }).origin?.kind
    if (kind === 'composer' || kind === 'bridge' || kind === 'sdk') stopped.delete('main')
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) mainTurnId = e.turnId
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) { stopped.delete(e.agentId); void post($, [{ type: 'agent', phase: 'done', agent: e.agentId, session: sessionId, at: Date.now() }]) }
    else mainTurnId = ''
    return next(e)
  })
}
