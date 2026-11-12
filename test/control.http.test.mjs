// End-to-end: a real server, the hooks module simulated over HTTP, a browser
// simulated by an SSE connection. Covers collisions, stop/message commands
// (long poll) and the approval gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'index.mjs');
const PORT = 4700 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const post = (path, body) => fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
const get = path => fetch(BASE + path).then(r => r.json());
const tool = (agent, file, tl = 'Edit') => ({ type: 'tool', phase: 'end', tool: tl, agent, session: 'S', provider: 'claude', file });

let srv, repo, sse;
test.before(async () => {
  repo = mkdtempSync(join(tmpdir(), 'wa2-ctl-'));
  writeFileSync(join(repo, 'a.js'), 'export const a = 1\n');
  srv = spawn(process.execPath, [SERVER, '--repo', repo, '--port', String(PORT)], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch {} await sleep(100); }
  // one browser watching (the gate only holds calls while someone can answer)
  sse = new AbortController();
  const r = await fetch(BASE + '/events', { signal: sse.signal });
  r.body.getReader().read();
  await sleep(100);
});
test.after(() => { sse?.abort(); srv?.kill(); try { rmSync(repo, { recursive: true, force: true }); } catch {} });

test('collision raised when two agents edit the same file, dismissable', async () => {
  await post('/api/event', [tool('a1', 'src/x.js'), tool('a2', 'src/x.js')]);
  const list = await get('/api/collisions');
  assert.equal(list.length, 1);
  assert.equal(list[0].level, 'bad');
  assert.deepEqual(list[0].agents.sort(), ['S:a1', 'S:a2']);
  await post('/api/collisions', { dismiss: list[0].id });
  assert.equal((await get('/api/collisions')).length, 0);
});

test('stop and message reach the session through the long poll', async () => {
  const waiting = get('/api/control/wait?session=S&timeout=5000');
  await sleep(150);
  const r = await post('/api/control', { session: 'S', agent: 'a1', kind: 'stop' });
  assert.ok(r.command);
  const got = await waiting;
  assert.deepEqual(got.commands.map(c => [c.agent, c.kind]), [['a1', 'stop']]);
  const agents = await get('/api/agents');
  assert.equal(agents.find(a => a.agent === 'a1').stopped, true);
  await post('/api/control', { session: 'S', agent: 'main', kind: 'message', text: 'run the tests' });
  const now = await get('/api/control/wait?session=S&timeout=5000');
  assert.equal(now.commands[0].text, 'run the tests');
  assert.equal((await post('/api/control', { session: 'S', kind: 'message', text: '' })).error, 'empty message');
});

test('approval gate: off runs, collisions holds, deny reaches the waiting hook', async () => {
  assert.equal((await post('/api/approval', { session: 'S', agent: 'a3', tool: 'Edit', file: 'src/x.js' })).approval, null, 'gate off by default');
  assert.equal((await post('/api/config', { gate: 'bogus' })).error !== undefined, true);
  await post('/api/config', { gate: 'collisions' });
  assert.equal((await post('/api/approval', { session: 'S', agent: 'a3', tool: 'Edit', file: 'src/new.js' })).approval, null, 'no collision, runs');
  const { approval } = await post('/api/approval', { session: 'S', agent: 'a3', tool: 'Edit', file: 'src/x.js' });
  assert.equal(approval.status, 'pending');
  assert.equal(approval.reason, 'collision');
  const waiting = get(`/api/approval/wait?id=${approval.id}&timeout=5000`);
  await sleep(150);
  await post('/api/approval/decide', { id: approval.id, decision: 'deny' });
  assert.equal((await waiting).approval.status, 'deny');
  await post('/api/config', { gate: 'off' });
});

test('control endpoints refuse a foreign origin', async () => {
  const r = await fetch(BASE + '/api/control', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ session: 'S', kind: 'stop' }) });
  assert.equal(r.status, 403);
});
