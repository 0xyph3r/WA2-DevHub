// Dev helper: records a short demo of the interface as a GIF (docs/demo.gif)
//. Drives headless Chrome over the
// DevTools protocol: a scripted sequence of real events is sent to a running
// server while Page.startScreencast streams frames; frames are resampled to a
// fixed rate and assembled with ImageMagick (`magick`). Zero npm dependencies.
//   node test/record.mjs [http://127.0.0.1:4242] [repoRoot] [--out docs/demo.gif] [--size 1280x800] [--fps 10] [--width 900]
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

const args = process.argv.slice(2);
const pos = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const base = pos[0] || 'http://127.0.0.1:4242';
const root = resolve(pos[1] || process.cwd());
const out = resolve(opt('--out', 'docs/demo.gif'));
const shotsDir = resolve(opt('--shots', 'docs'));
const [W, H] = (opt('--size', '1280x800')).split('x').map(Number);
const FPS = Number(opt('--fps', 10));
const GIF_W = Number(opt('--width', 900));
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9300 + Math.floor(Math.random() * 500);
const prof = mkdtempSync(join(tmpdir(), 'wa2-rec-'));
const frames = mkdtempSync(join(tmpdir(), 'wa2-frames-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--window-size=${W},${H}`, `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, 'about:blank'], { stdio: 'ignore' });
async function targets() {
  for (let i = 0; i < 50; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json`); if (r.ok) return r.json(); } catch {} await sleep(200); }
  throw new Error('chrome did not open the debugging port');
}
let id = 0; const pending = new Map();
const captured = [];   // { t, buf } from the screencast
const page = (await targets()).find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
  else if (m.method === 'Page.screencastFrame') {
    captured.push({ t: Date.now(), buf: Buffer.from(m.params.data, 'base64') });
    send('Page.screencastFrameAck', { sessionId: m.params.sessionId }).catch(() => {});
  }
};
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = js => send('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true });

// ---- the scripted session: real events through the real API ----
const S = 'demo';
const file = rel => resolve(root, rel);
const post = body => fetch(`${base}/api/event`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const tool = (n, tl, agent, extra, provider = 'claude') => post([
  { type: 'tool', phase: 'start', id: n, tool: tl, agent, session: S, provider, root, ...extra },
  { type: 'tool', phase: 'end', id: n, tool: tl, agent, session: S, provider, root, durationMs: 120, ...extra },
]);
const click = sel => evaluate(`document.querySelector(${JSON.stringify(sel)})?.click(); true`);
let shotN = 0;
async function still(name) {
  mkdirSync(shotsDir, { recursive: true });
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(shotsDir, `shot-${++shotN}-${name}.png`), Buffer.from(shot.data, 'base64'));
}

async function story() {
  await sleep(1400);
  await post([
    { type: 'agent', phase: 'spawn', agent: 'main', session: S, provider: 'claude', root, description: 'Main session', agentType: 'main' },
    { type: 'agent', phase: 'spawn', agent: 'builder', session: S, provider: 'claude', root, description: 'Build the sidebar panel', agentType: 'general-purpose' },
    { type: 'agent', phase: 'spawn', agent: 'reviewer', session: S, provider: 'claude', root, description: 'Review the server diff', agentType: 'code-reviewer' },
    { type: 'agent', phase: 'spawn', agent: 'gem', session: 'gemini', provider: 'gemini', root, description: 'Gemini CLI · refactor adapters', agentType: 'main' },
  ]);
  await sleep(1200);
  await tool('r1', 'Read', 'reviewer', { file: file('server/index.mjs') }); await sleep(1100);
  await tool('e1', 'Edit', 'builder', { file: file('client/sidebar.js') }); await sleep(1800);
  await tool('w1', 'Write', 'main', { file: file('client/views/canvas.js') }); await sleep(1500);
  await tool('g1', 'Edit', 'gem', { file: file('adapters/normalize.mjs') }, 'gemini'); await sleep(1400);
  await post([{ type: 'task', kind: 'todos', session: S, agent: 'main', todos: [
    { content: 'Left panel with collapsible sections', status: 'completed' },
    { content: 'Agent characters on the canvas', status: 'completed' },
    { content: 'Branch health checks', status: 'in_progress' },
    { content: 'Adapters for other AI tools', status: 'pending' },
  ] }]);
  await click('[data-act="relief"]'); await sleep(1100);
  await tool('e2', 'Edit', 'builder', { file: file('client/styles.css') }); await sleep(1800);
  await tool('b1', 'Bash', 'reviewer', { detail: 'npm test' }); await sleep(900);
  await click('[data-act="relief"]'); await sleep(700);
  await click('#btnMenu'); await sleep(1600);
  await sleep(600);
  await click('#btnMenu'); await sleep(400);
  await click('#btnStack'); await sleep(2200);
  await click('#btnStack'); await sleep(500);
  await click('[data-act="fit"]'); await sleep(1200);
}

try {
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: base + '/' });
  await sleep(500);
  await send('Page.startScreencast', { format: 'jpeg', quality: 82, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  const t0 = Date.now();
  await story();
  await send('Page.stopScreencast');
  const t1 = Date.now();
  // resample the irregular screencast frames to a fixed rate: at every tick keep the latest frame painted so far
  const list = []; let k = 0;
  for (let t = captured[0]?.t ?? t0, n = 0; t <= t1 && captured.length; t += 1000 / FPS, n++) {
    while (k + 1 < captured.length && captured[k + 1].t <= t) k++;
    const f = join(frames, `f${String(n).padStart(4, '0')}.jpg`); writeFileSync(f, captured[k].buf); list.push(f);
  }
  mkdirSync(dirname(out), { recursive: true });
  execFileSync('magick', ['-delay', String(Math.round(100 / FPS)), '-loop', '0', ...list, '-resize', `${GIF_W}x`, '-fuzz', '3%', '-colors', '128', '-layers', 'Optimize', out], { stdio: 'inherit', maxBuffer: 64e6 });
  console.log(`${captured.length} painted frames -> ${list.length} frames at ${FPS} fps (${((t1 - t0) / 1000).toFixed(1)} s) -> ${out} (${(statSync(out).size / 1e6).toFixed(1)} MB); ${shotN} stills in ${shotsDir}`);
} finally {
  ws.close(); chrome.kill(); await sleep(300);
  try { rmSync(prof, { recursive: true, force: true }); rmSync(frames, { recursive: true, force: true }); } catch {}
}
