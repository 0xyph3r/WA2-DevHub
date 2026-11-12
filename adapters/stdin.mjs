#!/usr/bin/env node
// Bridge for other AI coding tools: reads their hook payload (JSON on stdin,
// or as the first argument for tools that pass it that way, like Codex notify),
// converts it to WA2 events and posts them to the local WA2 server.
//
//   node adapters/stdin.mjs --from gemini|cursor|codex|generic [--port 4242] [--root <dir>]
//
// Never blocks the calling tool: the payload is echoed back untouched on stdout
// (hooks that expect a JSON answer keep working) and all errors are swallowed.
import { normalize } from './normalize.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] != null ? args[i + 1] : def; };
const from = opt('from', 'generic');
const port = Number(opt('port', process.env.WA2_PORT || 4242));
const root = opt('root', process.env.WA2_ROOT || process.cwd());
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

const post = events => fetch(`http://127.0.0.1:${port}/api/event`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(events), signal: AbortSignal.timeout(1500) }).catch(() => {});

const raw = positional.length ? positional.join(' ') : await readStdin();
if (raw.trim()) {
  const payloads = [];
  try { payloads.push(JSON.parse(raw)); } catch { for (const line of raw.split('\n')) { try { payloads.push(JSON.parse(line)); } catch { /* not JSON */ } } }
  const events = payloads.flatMap(p => normalize(from, p, { root }));
  if (events.length) await post(events);
  if (!positional.length) process.stdout.write(raw);   // pass the hook payload through
}
