#!/usr/bin/env node
// Send one WA2 event from any script or AI tool, no SDK needed.
//
//   node adapters/emit.mjs --provider aider --tool Edit --file src/app.js [--phase start|end] [--detail "..."]
//   node adapters/emit.mjs --provider aider --spawn "Refactor the auth module"      # agent appears
//   node adapters/emit.mjs --provider aider --done                           # agent goes idle
//   node adapters/emit.mjs --provider aider --task "Write the tests" --status in_progress
//
// Options: --session <id> (default: provider name), --agent <id> (default main), --root <dir>, --port 4242, --error
const args = process.argv.slice(2);
const has = n => args.includes(`--${n}`);
const opt = (n, def) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] != null && !args[i + 1].startsWith('--') ? args[i + 1] : def; };

const provider = opt('provider', 'custom');
const base = { provider, session: opt('session', provider), agent: opt('agent', 'main'), root: opt('root', process.cwd()), at: Date.now() };
let event;
if (has('spawn')) event = { type: 'agent', phase: 'spawn', description: opt('spawn', ''), agentType: opt('type', 'main'), ...base };
else if (has('done')) event = { type: 'agent', phase: 'done', ...base };
else if (has('task')) event = { type: 'task', kind: has('id') ? 'update' : 'create', id: opt('id'), subject: opt('task', ''), status: opt('status', 'pending'), ...base };
else if (has('tool')) event = { type: 'tool', phase: opt('phase', 'end'), tool: opt('tool'), file: opt('file'), detail: opt('detail'), isError: has('error'), ...base };
else {
  console.error('usage: emit.mjs --provider <name> (--tool <Tool> [--file <path>] [--phase start|end] [--detail <text>] [--error] | --spawn <description> | --done | --task <subject> [--status pending|in_progress|completed] [--id <id>])');
  process.exit(2);
}
const port = Number(opt('port', process.env.WA2_PORT || 4242));
const r = await fetch(`http://127.0.0.1:${port}/api/event`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event), signal: AbortSignal.timeout(2000) }).catch(e => ({ ok: false, statusText: e.message }));
if (!r.ok) { console.error(`WA2 unreachable on port ${port} (${r.statusText || r.status})`); process.exit(1); }
