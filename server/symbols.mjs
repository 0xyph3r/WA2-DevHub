// Symbol outline of a source file from a cheap regex scan: no parser, zero
// dependencies. Good enough to list what a file declares, not to type-check it.
const MAX = 200;

const JS = [
  // export? async? function name(   |  export? class Name
  { re: /^(export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: 'function' },
  { re: /^(export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
  // export? const|let|var name = (...) =>   -> function ; otherwise const
  { re: /^(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=>/, kind: 'function' },
  { re: /^(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?function\b/, kind: 'function' },
  { re: /^(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/, kind: 'const' },
  // TS: interface / type / enum
  { re: /^(export\s+)?(?:declare\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/, kind: 'type' },
];
// class methods at 2-space indent:   name(...) {   |   async name(...) {   |   static get name() {
const JS_METHOD = /^  (?:(?:public|private|protected|static|readonly|async|get|set|override)\s+)*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/;
const JS_METHOD_SKIP = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'function', 'return']);

const PY = [
  { re: /^(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: 'function' },
  { re: /^class\s+([A-Za-z_]\w*)/, kind: 'class' },
  { re: /^\s+(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: 'method' },
];

const RS = [
  { re: /^(pub(?:\([^)]*\))?\s+)?(?:async\s+|const\s+|unsafe\s+|extern\s+"[^"]*"\s+)*fn\s+([A-Za-z_]\w*)/, kind: 'function' },
  { re: /^(pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/, kind: 'class' },
  { re: /^(pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/, kind: 'type' },
  { re: /^(pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?trait\s+([A-Za-z_]\w*)/, kind: 'type' },
  { re: /^impl(?:<[^>]*>)?\s+(?:[A-Za-z_][\w:<>]*\s+for\s+)?([A-Za-z_][\w:]*)/, kind: 'class' },
  { re: /^\s+(pub(?:\([^)]*\))?\s+)?(?:async\s+|const\s+|unsafe\s+)*fn\s+([A-Za-z_]\w*)/, kind: 'method' },
];

const JS_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte']);

/** Lists `{ name, kind, line, exported }` declared in `text`; `ext` picks the language. */
export function symbolsOf(text, ext) {
  const out = [];
  const lines = String(text || '').split('\n');
  const push = (name, kind, line, exported) => { if (out.length < MAX) out.push({ name, kind, line, exported }); };
  if (ext === '.py') {
    for (let i = 0; i < lines.length && out.length < MAX; i++) {
      for (const { re, kind } of PY) { const m = lines[i].match(re); if (m) { push(m[1], kind, i + 1, !m[1].startsWith('_')); break; } }
    }
  } else if (ext === '.rs') {
    for (let i = 0; i < lines.length && out.length < MAX; i++) {
      for (const { re, kind } of RS) {
        const m = lines[i].match(re);
        if (!m) continue;
        if (kind === 'class' && re.source.startsWith('^impl')) push(m[1], kind, i + 1, false);
        else push(m[2], kind, i + 1, Boolean(m[1]));
        break;
      }
    }
  } else if (JS_EXT.has(ext) || !ext) {
    for (let i = 0; i < lines.length && out.length < MAX; i++) {
      const line = lines[i];
      let hit = false;
      for (const { re, kind } of JS) {
        const m = line.match(re);
        if (m) { push(m[2], kind, i + 1, Boolean(m[1])); hit = true; break; }
      }
      if (hit) continue;
      const m = line.match(JS_METHOD);
      if (m && !JS_METHOD_SKIP.has(m[1])) push(m[1], 'method', i + 1, false);
    }
  }
  return out;
}
