import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMergeTree, parseWorktrees, branchHealth } from '../server/health.mjs';

test('parseMergeTree: clean, conflicted, unknown', () => {
  assert.deepEqual(parseMergeTree(0, 'abc123\n'), []);
  assert.deepEqual(parseMergeTree(1, 'abc123\nsrc/a.js\nsrc/b.js\n\nCONFLICT (content): Merge conflict in src/a.js\n'), ['src/a.js', 'src/b.js']);
  assert.equal(parseMergeTree(128, 'fatal: unknown option'), null);
});

test('branchHealth: conflicts make the branch bad, nothing invented', () => {
  const now = Date.UTC(2026, 10, 10);
  const h = branchHealth({ name: 'feat', base: 'main', conflictFiles: ['x.js'], behindBase: 3, aheadBase: 2, hasUpstream: true, behind: 0, ahead: 1, date: now - 2 * 86400000 }, now);
  assert.equal(h.level, 'bad');
  assert.equal(h.base, 'main');
  assert.equal(h.checks.find(c => c.id === 'conflicts').level, 'bad');
  assert.equal(h.checks.find(c => c.id === 'base').level, 'warn');
  assert.equal(h.checks.find(c => c.id === 'upstream').detail, '1 commit to push');
  assert.match(h.summary, /1 problem/);
});

test('branchHealth: base branch, current, clean worktree is ok; unknown merge-tree is na', () => {
  const now = Date.UTC(2026, 10, 10);
  const main = branchHealth({ name: 'main', base: 'main', current: true, hasUpstream: false, changes: 0, date: now }, now);
  assert.equal(main.level, 'ok');
  assert.ok(!main.checks.some(c => c.id === 'conflicts'));
  const old = branchHealth({ name: 'old', base: 'main', conflictFiles: null, behindBase: null, hasUpstream: false, date: now - 40 * 86400000 }, now);
  assert.equal(old.checks.find(c => c.id === 'conflicts').level, 'na');
  assert.equal(old.checks.find(c => c.id === 'age').level, 'warn', 'unmerged work left aside is a warning, not a breakage');
  assert.equal(old.level, 'warn');
});

test('branchHealth: a merged branch is healthy however old and far behind', () => {
  const now = Date.UTC(2026, 10, 10);
  const h = branchHealth({ name: 'spec/x', base: 'master', conflictFiles: [], behindBase: 116, aheadBase: 0, merged: true, hasUpstream: false, date: now - 35 * 86400000 }, now);
  assert.equal(h.level, 'ok');
  assert.ok(!h.checks.some(c => c.id === 'base' || c.id === 'age'));
  assert.match(h.checks.find(c => c.id === 'merged').detail, /safe to delete/);
});

test('branchHealth: base and current branch are never stale; behind the remote is a warning', () => {
  const now = Date.UTC(2026, 10, 10);
  const base = branchHealth({ name: 'master', base: 'master', hasUpstream: true, ahead: 136, behind: 0, date: now - 40 * 86400000 }, now);
  assert.equal(base.checks.find(c => c.id === 'age').level, 'ok');
  assert.equal(base.level, 'warn');
  const cur = branchHealth({ name: 'feat', base: 'master', current: true, conflictFiles: [], behindBase: 0, aheadBase: 5, hasUpstream: true, behind: 30, ahead: 0, changes: 3, date: now - 40 * 86400000 }, now);
  assert.equal(cur.checks.find(c => c.id === 'age').level, 'ok');
  assert.equal(cur.checks.find(c => c.id === 'upstream').level, 'warn');
  assert.equal(cur.level, 'warn');
});

test('parseWorktrees: main, linked, detached, locked', () => {
  const out = [
    'worktree C:/repo', 'HEAD 1111111111111111', 'branch refs/heads/main', '',
    'worktree C:/repo/.worktrees/feat-a', 'HEAD 2222222222222222', 'branch refs/heads/feat/a', 'locked agent at work', '',
    'worktree /tmp/x', 'HEAD 3333333333333333', 'detached', '',
  ].join('\n');
  const w = parseWorktrees(out);
  assert.equal(w.length, 3);
  assert.deepEqual([w[0].branch, w[1].branch, w[2].branch], ['main', 'feat/a', '']);
  assert.equal(w[1].locked, true);
  assert.equal(w[2].detached, true);
  assert.equal(w[1].head, '222222222222');
  assert.deepEqual(parseWorktrees(''), []);
});
