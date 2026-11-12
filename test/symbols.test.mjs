import { test } from 'node:test';
import assert from 'node:assert/strict';
import { symbolsOf } from '../server/symbols.mjs';

const pick = list => list.map(s => `${s.kind}:${s.name}${s.exported ? '*' : ''}@${s.line}`);

test('symbolsOf reads JS/TS declarations, arrows, classes and methods', () => {
  const src = [
    `export function alpha(a) {}`,            // 1
    `async function beta() {}`,               // 2
    `export const gamma = (x) => x`,          // 3
    `const delta = async x => x`,             // 4
    `export const EPS = 42`,                  // 5
    `let zeta = function () {}`,              // 6
    `export default class Eta extends Base {`, // 7
    `  constructor(a) {`,                     // 8
    `  }`,
    `  async run(x) {`,                       // 10
    `  }`,
    `  static of(v): Eta {`,                  // 12
    `  }`,
    `  if (x) {`,                             // 14 not a method
    `}`,
    `export interface Theta { a: number }`,   // 16
    `type Iota = string`,                     // 17
    `export enum Kappa { A }`,                // 18
  ].join('\n');
  assert.deepEqual(pick(symbolsOf(src, '.ts')), [
    'function:alpha*@1', 'function:beta@2', 'function:gamma*@3', 'function:delta@4', 'const:EPS*@5', 'function:zeta@6',
    'class:Eta*@7', 'method:constructor@8', 'method:run@10', 'method:of@12',
    'type:Theta*@16', 'type:Iota@17', 'type:Kappa*@18',
  ]);
});

test('symbolsOf reads Python and Rust', () => {
  const py = `import os\nclass Foo:\n    def bar(self):\n        pass\ndef _hidden():\n    pass\nasync def go():\n    pass\n`;
  assert.deepEqual(pick(symbolsOf(py, '.py')), ['class:Foo*@2', 'method:bar*@3', 'function:_hidden@5', 'function:go*@7']);
  const rs = `pub struct A;\nenum B { X }\npub trait T {}\nimpl T for A {\n    pub fn new() -> A { A }\n    fn hidden() {}\n}\npub async fn main() {}\n`;
  assert.deepEqual(pick(symbolsOf(rs, '.rs')), ['class:A*@1', 'type:B@2', 'type:T*@3', 'class:A@4', 'method:new*@5', 'method:hidden@6', 'function:main*@8']);
});

test('symbolsOf caps at 200 and tolerates junk', () => {
  const many = Array.from({ length: 300 }, (_, i) => `function f${i}() {}`).join('\n');
  assert.equal(symbolsOf(many, '.js').length, 200);
  assert.deepEqual(symbolsOf('', '.js'), []);
  assert.deepEqual(symbolsOf(null, '.py'), []);
  assert.deepEqual(symbolsOf('function x() {}', '.css'), []);
});
