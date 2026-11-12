// Dev helper: posts a realistic burst of agent/tool/task events to a running
// WA2 server, to exercise the interface without a Claude Code session.
//   node test/events.post.mjs [http://127.0.0.1:4242] [repoRoot]
import { resolve } from 'node:path';

const base = process.argv[2] || 'http://127.0.0.1:4242';
const root = resolve(process.argv[3] || process.cwd());
const file = rel => resolve(root, rel);
const post = body => fetch(`${base}/api/event`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); });
const S = 'demo';
const withRoot = events => events.map(e => ({ root, ...e }));

await post(withRoot([
  { type: 'agent', phase: 'spawn', agent: 'main', session: S, description: 'Main session · demo', agentType: 'main' },
  { type: 'agent', phase: 'spawn', agent: 'a-build', session: S, description: 'Implement the Flow view', agentType: 'general-purpose' },
  { type: 'agent', phase: 'spawn', agent: 'a-test', session: S, description: 'Review the server diff', agentType: 'code-reviewer' },
  { type: 'agent', phase: 'spawn', agent: 'a-explore', session: S, description: 'Locate the hooks', agentType: 'Explore' },
]));
const tool = (id, tool, agent, extra) => [
  { type: 'tool', phase: 'start', id, tool, agent, session: S, ...extra },
  { type: 'tool', phase: 'end', id, tool, agent, session: S, durationMs: 40 + Math.round(Math.random() * 400), ...extra },
];
await post(withRoot([
  ...tool('t1', 'Read', 'a-explore', { file: file('hooks/register.ts') }),
  ...tool('t2', 'Edit', 'a-build', { file: file('client/views/flow.js') }),
  ...tool('t3', 'Bash', 'a-test', { detail: 'npm test', isError: false }),
  ...tool('t4', 'Bash', 'main', { detail: 'npm run build', isError: false }),
  ...tool('t5', 'Grep', 'a-explore', { file: file('server') }),
  ...tool('t6', 'Write', 'main', { file: file('server/index.mjs') }),
]));
await post([{ type: 'task', kind: 'todos', session: S, agent: 'main', todos: [
  { content: 'Finish the hooks module', status: 'completed' },
  { content: 'Integrate the Dependencies view', status: 'in_progress' },
  { content: 'Optimise the import scan', status: 'in_progress' },
  { content: 'End-to-end tests', status: 'pending' },
  { content: 'Prepare the v0.1.0 release', status: 'pending' },
] }]);
console.log(`events posted to ${base} for ${root}`);
