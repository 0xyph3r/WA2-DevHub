// Event shapes shared by the hooks module, the server and the client.
//   hello : { type, repo, name, app, version, at }
//   tree  : { type, tree }
//   fs    : { type, kind: change|rename|remove, path, size?, at }
//   tool  : { type, phase: start|end, id, tool, agent, session, root?, provider?, file?, detail?, isError?, durationMs?, at }
//           provider: which AI tool emits (claude | codex | gemini | cursor | ...); tool names are the WA2 canonical set
//           (Edit, Write, Read, Bash, Grep, Glob, Agent, WebFetch, WebSearch, TodoWrite...) so every adapter maps to them.
//   agent : { type, phase: spawn|done, agent, session, root?, description?, agentType?, at }
//           root: absolute working directory of the Claude Code session (<= 1024 chars);
//           the server derives the agent's git `branch` from it.
//   agents: { type, agents: [{ key, agent, session, root?, branch?, status, calls, ... }] }  snapshot
//   task  : { type, kind: todos|create|update, session, agent, todos?|id?, subject?, status?, at }
//   tasks : { type, tasks: [...] }             snapshot
//   app   : { type, url, name }                live app url changed
//   sys   : { type, cpu, ram, at }             host load
//   metric: { type, metrics: {...} }           build/test/coverage snapshot
//   approval  : { type, approval }             a tool call held, or decided, on the canvas
//   approvals : { type, approvals: [...] }     pending approvals snapshot
//   collision : { type, collision }            two agents on the same file (bad) or folder (warn)
//   collisions: { type, collisions: [...] }    snapshot
//   control   : { type, command }              stop / resume / message sent to an agent
const TYPES = new Set(['hello', 'tree', 'fs', 'tool', 'agent', 'agents', 'task', 'tasks', 'app', 'sys', 'metric', 'approval', 'approvals', 'collision', 'collisions', 'control']);

export function fileOfToolInput(input) {
  if (!input || typeof input !== 'object') return null;
  for (const key of ['file_path', 'notebook_path', 'path']) {
    if (typeof input[key] === 'string' && input[key]) return input[key];
  }
  return null;
}

export function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object' || !TYPES.has(raw.type)) return null;
  const e = { ...raw, at: typeof raw.at === 'number' ? raw.at : Date.now() };
  for (const k of ['id', 'tool', 'agent', 'session', 'file', 'detail', 'phase', 'description', 'agentType', 'path', 'kind', 'url', 'subject', 'status', 'provider']) {
    if (k in e && e[k] != null && typeof e[k] !== 'string') e[k] = String(e[k]);
  }
  if ('root' in e && (typeof e.root !== 'string' || e.root.length > 1024)) delete e.root;
  if ('provider' in e) e.provider = String(e.provider).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24) || undefined;
  return e;
}

const BUILD_RE = /\b(build|tsc\b|webpack|esbuild|rollup|cargo build|go build|make\b|gradle|mvn)/i;
const TEST_RE = /\b(test|vitest|jest|mocha|pytest|cargo test|go test|phpunit|rspec)\b/i;

/** Classifies a finished Bash command as a build or a test run, or null. */
export function classifyCommand(command) {
  if (!command) return null;
  if (TEST_RE.test(command)) return 'test';
  if (BUILD_RE.test(command)) return 'build';
  return null;
}
