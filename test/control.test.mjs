import test from 'node:test';
import assert from 'node:assert/strict';
import { createControl, WINDOW_MS, NEAR_MS, APPROVAL_TIMEOUT_MS } from '../server/control.mjs';

const clock = () => { let t = 1_000_000; const now = () => t; now.add = ms => { t += ms; }; return now; };
const edit = (agent, file, extra = {}) => ({ type: 'tool', phase: 'end', tool: 'Edit', session: 's', agent, file, ...extra });

test('commands: queued per session, taken once, stop/resume tracked', () => {
  const c = createControl();
  assert.ok(c.command({ session: 's', agent: 'a1', kind: 'stop' }).command);
  c.command({ session: 'other', kind: 'message', text: 'hi' });
  assert.equal(c.isStopped('s', 'a1'), true);
  assert.equal(c.pendingFor('s'), true);
  const got = c.take('s');
  assert.deepEqual(got.map(x => x.kind), ['stop']);
  assert.equal(c.pendingFor('s'), false);
  assert.equal(c.take('other')[0].text, 'hi');
  c.command({ session: 's', agent: 'a1', kind: 'resume' });
  assert.equal(c.isStopped('s', 'a1'), false);
});

test('commands: bad input refused', () => {
  const c = createControl();
  assert.ok(c.command({ kind: 'stop' }).error);
  assert.ok(c.command({ session: 's', kind: 'reboot' }).error);
  assert.ok(c.command({ session: 's', kind: 'message', text: '   ' }).error);
});

test('collisions: same file by two agents is bad, the same agent alone is not', () => {
  const now = clock(), c = createControl({ now });
  assert.equal(c.trackTool(edit('a', 'src/x.js')).changed, false);
  now.add(1000);
  assert.equal(c.trackTool(edit('a', 'src/x.js')).changed, false);
  now.add(1000);
  const r = c.trackTool(edit('b', 'src/x.js'));
  assert.equal(r.fresh.length, 1);
  assert.equal(r.fresh[0].level, 'bad');
  assert.deepEqual(r.fresh[0].agents.sort(), ['s:a', 's:b']);
  // same pair again: updated, not fresh
  assert.equal(c.trackTool(edit('a', 'src/x.js')).fresh.length, 0);
  assert.equal(c.listCollisions()[0].count, 2);
});

test('collisions: reads, errors and old writes do not count', () => {
  const now = clock(), c = createControl({ now });
  c.trackTool(edit('a', 'src/x.js'));
  assert.equal(c.trackTool({ ...edit('b', 'src/x.js'), tool: 'Read' }).changed, false);
  assert.equal(c.trackTool(edit('b', 'src/x.js', { isError: true })).changed, false);
  now.add(WINDOW_MS + 1);
  assert.equal(c.trackTool(edit('b', 'src/x.js')).changed, false);
});

test('collisions: same folder within NEAR_MS is a warn overlap', () => {
  const now = clock(), c = createControl({ now });
  c.trackTool(edit('a', 'src/x.js'));
  now.add(NEAR_MS - 10);
  const r = c.trackTool(edit('b', 'src/y.js'));
  assert.equal(r.fresh[0].level, 'warn');
  assert.equal(r.fresh[0].dir, 'src');
  now.add(NEAR_MS + 10);
  assert.equal(c.trackTool(edit('c', 'lib/z.js')).changed, false);
});

test('collisions: dismissed stays quiet for the same agents, a third agent re-raises', () => {
  const now = clock(), c = createControl({ now });
  c.trackTool(edit('a', 'x.js')); c.trackTool(edit('b', 'x.js'));
  assert.equal(c.dismiss('f:x.js'), true);
  assert.equal(c.listCollisions().length, 0);
  assert.equal(c.trackTool(edit('a', 'x.js')).changed, false);
  assert.equal(c.trackTool(edit('c', 'x.js')).fresh.length, 1);
});

test('approvals: gate off never holds, collisions holds only a colliding write', () => {
  const c = createControl();
  assert.equal(c.request({ session: 's', agent: 'b', tool: 'Edit', file: 'x.js', gate: 'off' }).approval, null);
  assert.equal(c.request({ session: 's', agent: 'b', tool: 'Edit', file: 'x.js', gate: 'collisions' }).approval, null);
  c.trackTool(edit('a', 'x.js'));
  const { approval } = c.request({ session: 's', agent: 'b', tool: 'Edit', file: 'x.js', gate: 'collisions' });
  assert.equal(approval.reason, 'collision');
  assert.deepEqual(approval.with, ['s:a']);
  assert.equal(c.request({ session: 's', agent: 'b', tool: 'Bash', detail: 'ls', gate: 'collisions' }).approval, null);
});

test('approvals: gate writes holds writes and commands, decide and expire', () => {
  const now = clock(), c = createControl({ now });
  const w = c.request({ session: 's', tool: 'Write', file: 'n.js', gate: 'writes' }).approval;
  const b = c.request({ session: 's', tool: 'Bash', detail: 'rm -rf build', gate: 'writes' }).approval;
  assert.equal(w.reason, 'write'); assert.equal(b.reason, 'command');
  assert.equal(c.request({ session: 's', tool: 'Read', file: 'n.js', gate: 'writes' }).approval, null);
  assert.equal(c.decide(w.id, 'allow').approval.status, 'allow');
  assert.equal(c.decide(w.id, 'deny').approval.status, 'allow', 'a decision is final');
  assert.ok(c.decide('nope', 'allow').error);
  now.add(APPROVAL_TIMEOUT_MS);
  assert.deepEqual(c.expire().map(a => a.id), [b.id]);
  assert.equal(c.getApproval(b.id).status, 'expired');
});

test('approvals: stopping an agent denies what it waits for', () => {
  const c = createControl();
  const a = c.request({ session: 's', agent: 'x', tool: 'Write', file: 'n.js', gate: 'writes' }).approval;
  c.request({ session: 's', agent: 'y', tool: 'Write', file: 'm.js', gate: 'writes' });
  assert.deepEqual(c.denyAllFor('s', 'x').map(p => p.id), [a.id]);
  assert.equal(c.pendingApprovals().length, 1);
});
