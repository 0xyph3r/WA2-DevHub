import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, canonicalTool, relPath } from '../adapters/normalize.mjs';

test('canonicalTool maps other tools onto the WA2 set', () => {
  assert.equal(canonicalTool('write_file'), 'Write');
  assert.equal(canonicalTool('run_shell_command'), 'Bash');
  assert.equal(canonicalTool('search_file_content'), 'Grep');
  assert.equal(canonicalTool('str_replace_editor'), 'Edit');
  assert.equal(canonicalTool('Read'), 'Read');
});

test('relPath makes paths repo-relative with forward slashes', () => {
  assert.equal(relPath('C:\\proj\\src\\a.js', 'C:\\proj'), 'src/a.js');
  assert.equal(relPath('/other/x.js', '/proj'), '/other/x.js');
  assert.equal(relPath(undefined, '/proj'), undefined);
});

test('gemini BeforeTool becomes a tool start with file and provider', () => {
  const [e] = normalize('gemini', { hook_event_name: 'BeforeTool', session_id: 's1', cwd: '/proj', tool_name: 'write_file', tool_input: { file_path: '/proj/src/app.js', content: 'x' } });
  assert.equal(e.type, 'tool'); assert.equal(e.phase, 'start'); assert.equal(e.tool, 'Write');
  assert.equal(e.file, 'src/app.js'); assert.equal(e.provider, 'gemini'); assert.equal(e.session, 's1'); assert.equal(e.root, '/proj');
});

test('cursor afterFileEdit and stop', () => {
  const [edit] = normalize('cursor', { hook_event_name: 'afterFileEdit', conversation_id: 'c1', workspace_roots: ['/ws'], file_path: '/ws/lib/x.ts', edits: [{}, {}] });
  assert.equal(edit.tool, 'Edit'); assert.equal(edit.file, 'lib/x.ts'); assert.equal(edit.detail, '2 modifications'); assert.equal(edit.provider, 'cursor');
  const [stop] = normalize('cursor', { hook_event_name: 'stop', conversation_id: 'c1' });
  assert.equal(stop.type, 'agent'); assert.equal(stop.phase, 'done');
});

test('codex notify turn-complete yields a turn + idle agent', () => {
  const evs = normalize('codex', { type: 'agent-turn-complete', 'thread-id': 't9', cwd: '/p', 'last-assistant-message': 'Done.' });
  assert.equal(evs.length, 2); assert.equal(evs[0].tool, 'Turn'); assert.equal(evs[1].phase, 'done'); assert.equal(evs[0].provider, 'codex');
});

test('generic passthrough keeps WA2 events, defaults provider, ignores junk', () => {
  const evs = normalize('generic', [{ type: 'tool', tool: 'bash', detail: 'npm test', session: 'x' }, 'junk', null]);
  assert.equal(evs.length, 1); assert.equal(evs[0].tool, 'Bash'); assert.equal(evs[0].provider, 'custom');
});
