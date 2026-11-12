import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { specifiers, topOf, scanDeps, resolveImport } from '../server/deps.mjs';
import { scanTree } from '../server/tree.mjs';
import { classifyCommand } from '../server/events.mjs';

test('specifiers reads JS, Python and Rust imports', () => {
  assert.deepEqual(specifiers(`import a from './a'; const b = require("lodash"); export { x } from '../x'; import('@scope/pkg')`, '.js'), ['./a', 'lodash', '../x', '@scope/pkg']);
  assert.deepEqual(specifiers('import os\nfrom .local import y\nfrom numpy import z', '.py'), ['os', '.local', 'numpy']);
  assert.deepEqual(specifiers('use crate::a;\nuse serde::Serialize;', '.rs'), ['crate', 'serde']);
});

test('topOf and scanDeps build edges between top-level dirs', () => {
  assert.equal(topOf('src/a.js'), 'src');
  assert.equal(topOf('index.js'), '(racine)');
  const root = mkdtempSync(join(tmpdir(), 'wa2deps-'));
  mkdirSync(join(root, 'app'));
  mkdirSync(join(root, 'lib'));
  writeFileSync(join(root, 'app', 'main.js'), `import x from '../lib/x.js'; import react from 'react';`);
  writeFileSync(join(root, 'lib', 'x.js'), 'export default 1');
  const d = scanDeps(root, scanTree(root));
  assert.deepEqual(d.edges, [{ from: 'app', to: 'lib', count: 1 }]);
  assert.deepEqual(d.externals, [{ name: 'react', count: 1 }]);
  assert.equal(d.scanned, 2);
});

test('classifyCommand tells builds from tests', () => {
  assert.equal(classifyCommand('npm test'), 'test');
  assert.equal(classifyCommand('npx vitest run'), 'test');
  assert.equal(classifyCommand('npm run build'), 'build');
  assert.equal(classifyCommand('ls -la'), null);
});

test('resolveImport maps relative specifiers and aliases onto the tree', () => {
  const files = new Set(['src/a.ts', 'src/b/index.ts', 'src/c.js', 'src/d.json', 'lib/x.js', 'app/main.js']);
  assert.equal(resolveImport('src/a.ts', './b', files), 'src/b/index.ts');
  assert.equal(resolveImport('src/a.ts', './c', files), 'src/c.js');
  assert.equal(resolveImport('src/a.ts', './c.js', files), 'src/c.js');
  assert.equal(resolveImport('src/a.ts', './d', files), 'src/d.json');
  assert.equal(resolveImport('src/a.ts', './missing', files), null);
  assert.equal(resolveImport('app/main.js', '../lib/x.js', files), 'lib/x.js');
  assert.equal(resolveImport('app/main.js', '../../outside', files), null);
  assert.equal(resolveImport('lib/x.js', '@/a', files), 'src/a.ts');
  assert.equal(resolveImport('lib/x.js', '~/b', files), 'src/b/index.ts');
  assert.equal(resolveImport('lib/x.js', 'react', files), null);
  // TS imports its sibling with the compiled .js suffix
  assert.equal(resolveImport('src/c.js', './a.js', files), 'src/a.ts');
});

test('scanDeps returns deduped file-level edges without self-edges', () => {
  const root = mkdtempSync(join(tmpdir(), 'wa2deps-'));
  mkdirSync(join(root, 'app'));
  mkdirSync(join(root, 'lib'));
  writeFileSync(join(root, 'app', 'main.js'), `import x from '../lib/x.js'; import y from '../lib/x'; import me from './main.js'; import nope from './nope';`);
  writeFileSync(join(root, 'lib', 'x.js'), 'export default 1');
  const d = scanDeps(root, scanTree(root));
  assert.deepEqual(d.files, [{ from: 'app/main.js', to: 'lib/x.js' }]);
  assert.deepEqual(d.edges, [{ from: 'app', to: 'lib', count: 2 }]);
});
