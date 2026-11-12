import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileOfToolInput, normalizeEvent } from '../server/events.mjs';

test('fileOfToolInput picks the path field a tool uses', () => {
  assert.equal(fileOfToolInput({ file_path: '/r/a.ts' }), '/r/a.ts');
  assert.equal(fileOfToolInput({ notebook_path: '/r/n.ipynb' }), '/r/n.ipynb');
  assert.equal(fileOfToolInput({ path: '/r/src' }), '/r/src');
  assert.equal(fileOfToolInput({ command: 'ls' }), null);
});

test('normalizeEvent rejects junk and stamps time', () => {
  assert.equal(normalizeEvent(null), null);
  assert.equal(normalizeEvent({ type: 'bogus' }), null);
  const e = normalizeEvent({ type: 'tool', phase: 'start', id: 't1', tool: 'Edit', agent: 'main', session: 's', file: 'src/a.ts' });
  assert.equal(e.type, 'tool');
  assert.ok(typeof e.at === 'number');
  assert.equal(e.file, 'src/a.ts');
});
