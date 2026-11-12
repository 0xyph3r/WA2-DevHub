import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanTree, isIgnored, toRepoPath } from '../server/tree.mjs';

test('scanTree builds a tree with sizes and skips ignored dirs', () => {
  const root = mkdtempSync(join(tmpdir(), 'wa2-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.js'), 'hello');
  writeFileSync(join(root, 'node_modules', 'x', 'i.js'), 'nope');
  writeFileSync(join(root, 'README.md'), '# hi');
  const tree = scanTree(root);
  assert.equal(tree.type, 'dir');
  const names = tree.children.map(c => c.name).sort();
  assert.deepEqual(names, ['README.md', 'src']);
  const src = tree.children.find(c => c.name === 'src');
  assert.equal(src.children[0].path, 'src/a.js');
  assert.equal(src.children[0].size, 5);
});

test('isIgnored and toRepoPath', () => {
  assert.equal(isIgnored('node_modules'), true);
  assert.equal(isIgnored('.git'), true);
  assert.equal(isIgnored('src'), false);
  if (process.platform === 'win32') {
    assert.equal(toRepoPath(String.raw`C:\repo`, String.raw`C:\repo\src\a.js`), 'src/a.js');
  }
  assert.equal(toRepoPath('/repo', '/repo/src/a.js'), 'src/a.js');
  assert.equal(toRepoPath('/repo', '/elsewhere/a.js'), null);
});

test('scanTree: past the limit, deep files go first and every top folder stays', () => {
  const root = mkdtempSync(join(tmpdir(), 'wa2-big-'));
  try {
    for (const top of ['a', 'b', 'c']) {
      mkdirSync(join(root, top, 'deep'), { recursive: true });
      writeFileSync(join(root, top, 'index.js'), '');
      for (let i = 0; i < 5; i++) writeFileSync(join(root, top, 'deep', `f${i}.js`), '');
    }
    const t = scanTree(root, 6);
    assert.deepEqual(t.children.map(c => c.name), ['a', 'b', 'c']);
    for (const c of t.children) assert.ok(c.children.some(x => x.name === 'index.js'), `${c.name}/index.js kept`);
    assert.equal(t.truncated, true);
    assert.equal(t.skipped, 12);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
