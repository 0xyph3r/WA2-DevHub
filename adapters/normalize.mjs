// Turns the hook payloads of other AI coding tools into WA2 events.
// Pure functions, tested in test/adapters.test.mjs. Every adapter maps the
// tool's own names onto WA2's canonical tool set so the UI (verbs, colours,
// read/write distinction) behaves the same whatever the provider.
//
//   normalize('gemini' | 'cursor' | 'codex' | 'generic', payload, { root }) -> WA2 event[]

const CANON = {
  // Gemini CLI built-in tools
  write_file: 'Write', replace: 'Edit', edit: 'Edit', read_file: 'Read', read_many_files: 'Read', list_directory: 'LS', glob: 'Glob',
  search_file_content: 'Grep', grep_search: 'Grep', run_shell_command: 'Bash', web_fetch: 'WebFetch', google_web_search: 'WebSearch', write_todos: 'TodoWrite',
  // common lower-case spellings used by other tools
  bash: 'Bash', shell: 'Bash', read: 'Read', write: 'Write', grep: 'Grep', ls: 'LS', webfetch: 'WebFetch', websearch: 'WebSearch', task: 'Agent', agent: 'Agent',
};
export function canonicalTool(name) {
  if (!name) return 'Tool';
  const n = String(name);
  if (/^(Edit|Write|Read|Bash|PowerShell|Grep|Glob|LS|Agent|WebFetch|WebSearch|TodoWrite|TaskCreate|TaskUpdate|MultiEdit|NotebookEdit)$/.test(n)) return n;
  const c = CANON[n] || CANON[n.toLowerCase()];
  if (c) return c;
  if (/edit|replace|patch|str_replace/i.test(n)) return 'Edit';
  if (/write|create_file|save/i.test(n)) return 'Write';
  if (/read|view|open|cat/i.test(n)) return 'Read';
  if (/shell|bash|exec|terminal|command/i.test(n)) return 'Bash';
  if (/search|grep|find/i.test(n)) return 'Grep';
  if (/glob|list/i.test(n)) return 'Glob';
  if (/fetch|http/i.test(n)) return 'WebFetch';
  return n;
}

/** Repo-relative path with forward slashes; absolute paths outside `root` are returned as-is. */
export function relPath(file, root) {
  if (!file) return undefined;
  let f = String(file).replace(/\\/g, '/');
  if (root) {
    const r = String(root).replace(/\\/g, '/').replace(/\/+$/, '');
    if (f.toLowerCase().startsWith(r.toLowerCase() + '/')) f = f.slice(r.length + 1);
  }
  return f;
}

export function fileOfInput(input) {
  if (!input || typeof input !== 'object') return undefined;
  for (const k of ['file_path', 'filePath', 'path', 'absolute_path', 'notebook_path', 'target_file', 'file']) {
    if (typeof input[k] === 'string' && input[k]) return input[k];
  }
  return undefined;
}

const str = (...vals) => { for (const v of vals) if (typeof v === 'string' && v) return v; return undefined; };
const short = (v, n = 200) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v)).slice(0, n);

/** Gemini CLI hooks: BeforeTool / AfterTool / SessionStart / SessionEnd payloads on stdin. */
function gemini(p, { root }) {
  const ev = str(p.hook_event_name, p.hookEventName, p.event, p.type) || '';
  const session = str(p.session_id, p.sessionId, p.conversation_id) || 'gemini';
  const cwd = str(p.cwd, p.workspace_dir, p.project_root) || root;
  const base = { session, agent: 'main', provider: 'gemini', root: cwd, at: Date.now() };
  if (/SessionStart/i.test(ev)) return [{ type: 'agent', phase: 'spawn', description: `Gemini CLI · ${(cwd || '').split(/[\\/]/).pop() || 'session'}`, agentType: 'main', ...base }];
  if (/SessionEnd/i.test(ev)) return [{ type: 'agent', phase: 'done', ...base }];
  const toolName = str(p.tool_name, p.toolName, p.name);
  if (!toolName) return [];
  const input = p.tool_input || p.toolInput || p.args || p.input || {};
  const tool = canonicalTool(toolName);
  const file = relPath(fileOfInput(input), cwd);
  const detail = tool === 'Bash' ? short(str(input.command, input.cmd)) : short(str(input.pattern, input.query, input.url, input.description) || '');
  const phase = /Before/i.test(ev) ? 'start' : 'end';
  const resp = p.tool_response || p.toolResponse || p.response;
  const isError = phase === 'end' ? !!(p.is_error || p.error || (resp && typeof resp === 'object' && (resp.error || resp.isError))) : undefined;
  return [{ type: 'tool', phase, id: str(p.tool_call_id, p.toolCallId, p.id), tool, file, detail: detail || undefined, isError, ...base }];
}

/** Cursor hooks (.cursor/hooks.json): afterFileEdit, beforeShellExecution, beforeMCPExecution, beforeReadFile, stop... */
function cursor(p, { root }) {
  const ev = str(p.hook_event_name, p.hookEventName, p.event) || '';
  const session = str(p.conversation_id, p.conversationId, p.session_id) || 'cursor';
  const cwd = (Array.isArray(p.workspace_roots) && p.workspace_roots[0]) || str(p.cwd, p.workspace_root) || root;
  const base = { session, agent: 'main', provider: 'cursor', root: cwd, at: Date.now() };
  if (/stop/i.test(ev)) return [{ type: 'agent', phase: 'done', ...base }];
  if (/afterFileEdit/i.test(ev)) {
    const file = relPath(str(p.file_path, p.filePath), cwd);
    return [{ type: 'tool', phase: 'end', tool: 'Edit', file, detail: Array.isArray(p.edits) ? `${p.edits.length} modification${p.edits.length > 1 ? 's' : ''}` : undefined, ...base }];
  }
  if (/beforeShellExecution/i.test(ev)) return [{ type: 'tool', phase: 'start', tool: 'Bash', detail: short(str(p.command)), ...base }];
  if (/afterShellExecution/i.test(ev)) return [{ type: 'tool', phase: 'end', tool: 'Bash', detail: short(str(p.command)), isError: typeof p.exit_code === 'number' ? p.exit_code !== 0 : undefined, ...base }];
  if (/beforeReadFile/i.test(ev)) return [{ type: 'tool', phase: 'start', tool: 'Read', file: relPath(str(p.file_path, p.filePath), cwd), ...base }];
  if (/beforeMCPExecution/i.test(ev)) return [{ type: 'tool', phase: 'start', tool: canonicalTool(str(p.tool_name)), detail: short(str(p.tool_name)), ...base }];
  if (/beforeSubmitPrompt/i.test(ev)) return [{ type: 'agent', phase: 'spawn', description: `Cursor · ${(cwd || '').split(/[\\/]/).pop() || 'session'}`, agentType: 'main', ...base }];
  return [];
}

/** Codex CLI `notify` program: one JSON argument per turn, type agent-turn-complete. */
function codex(p, { root }) {
  const session = str(p['thread-id'], p.thread_id, p['turn-id'], p.turn_id) || 'codex';
  const cwd = str(p.cwd) || root;
  const base = { session, agent: 'main', provider: 'codex', root: cwd, at: Date.now() };
  if (/turn-complete|turn_complete/i.test(str(p.type) || '')) {
    const msg = short(str(p['last-assistant-message'], p.last_assistant_message) || '', 160);
    return [
      { type: 'tool', phase: 'end', tool: 'Turn', detail: msg || 'turn finished', ...base },
      { type: 'agent', phase: 'done', description: `Codex · ${(cwd || '').split(/[\\/]/).pop() || 'session'}`, agentType: 'main', ...base },
    ];
  }
  return [];
}

/** Already WA2-shaped event(s); only the provider is defaulted. */
function generic(p) {
  const list = Array.isArray(p) ? p : [p];
  return list.filter(e => e && typeof e === 'object' && e.type).map(e => ({ provider: 'custom', at: Date.now(), ...e, tool: e.tool ? canonicalTool(e.tool) : e.tool }));
}

export function normalize(from, payload, opts = {}) {
  const f = String(from || 'generic').toLowerCase();
  const fn = f === 'gemini' ? gemini : f === 'cursor' ? cursor : f === 'codex' ? codex : generic;
  try { return fn(payload, opts).filter(Boolean); } catch { return []; }
}
