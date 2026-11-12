import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layout, fileHeight } from '../client/layout.js';

const tree = {
  name: 'repo', path: '', type: 'dir', children: [
    { name: 'a.js', path: 'a.js', type: 'file', size: 100 },
    { name: 'src', path: 'src', type: 'dir', children: [
      { name: 'b.js', path: 'src/b.js', type: 'file', size: 5000 },
      { name: 'c.js', path: 'src/c.js', type: 'file', size: 0 },
    ] },
  ],
};

test('layout emits one block per node, root included', () => {
  const blocks = layout(tree);
  assert.equal(blocks.length, 5);
  assert.deepEqual(blocks.map(b => b.path).sort(), ['', 'a.js', 'src', 'src/b.js', 'src/c.js']);
});

test('children stay inside their directory footprint', () => {
  const blocks = layout(tree);
  const by = Object.fromEntries(blocks.map(b => [b.path, b]));
  for (const p of ['src/b.js', 'src/c.js']) {
    const c = by[p], d = by['src'];
    assert.ok(c.x >= d.x && c.x + c.w <= d.x + d.w, `${p} x inside src`);
    assert.ok(c.z >= d.z && c.z + c.d <= d.z + d.d, `${p} z inside src`);
  }
});

test('file blocks never overlap', () => {
  const files = layout(tree).filter(b => b.type === 'file');
  for (let i = 0; i < files.length; i++) for (let j = i + 1; j < files.length; j++) {
    const a = files[i], b = files[j];
    const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.z + a.d <= b.z || b.z + b.d <= a.z;
    assert.ok(apart, `${a.path} overlaps ${b.path}`);
  }
});

test('depth increases with nesting and height grows with size', () => {
  const by = Object.fromEntries(layout(tree).map(b => [b.path, b]));
  assert.equal(by[''].depth, 0);
  assert.equal(by['src'].depth, 1);
  assert.equal(by['src/b.js'].depth, 2);
  assert.ok(fileHeight(5000) > fileHeight(100));
  assert.ok(fileHeight(0) > 0);
});
