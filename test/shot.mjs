// Dev helper: drives headless Chrome over the DevTools protocol to screenshot
// the interface and evaluate JS in the page (zero dependencies, Node >= 22).
//   node test/shot.mjs <url> <out.png> [--wait ms] [--eval "js"] [--post repoRoot] [--size WxH]
import { spawn, execFile } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const url = args[0], out = args[1];
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const wait = Number(opt('--wait', 4000));
const evalArg = opt('--eval', null);
const evalJs = evalArg && evalArg.startsWith('@') ? readFileSync(evalArg.slice(1), 'utf8') : evalArg;
const postRepo = opt('--post', null);
const [W, H] = (opt('--size', '1680x940')).split('x').map(Number);
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9300 + Math.floor(Math.random() * 500);
const prof = mkdtempSync(join(tmpdir(), 'wa2-shot-'));

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--window-size=${W},${H}`, `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json`); if (r.ok) return r.json(); } catch {}
    await sleep(200);
  }
  throw new Error('chrome did not open the debugging port');
}

let id = 0; const pending = new Map(); const logs = [];
const list = await targets();
const page = list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
  else if (m.method === 'Runtime.consoleAPICalled') logs.push(`[${m.params.type}] ${m.params.args.map(a => a.value ?? a.description ?? '').join(' ')}`);
  else if (m.method === 'Runtime.exceptionThrown') logs.push(`[exception] ${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`);
};
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });

try {
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  if (postRepo) { await sleep(1500); await new Promise((res, rej) => execFile(process.execPath, [new URL('./events.post.mjs', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'), new URL(url).origin, postRepo], e => e ? rej(e) : res())); }
  await sleep(wait);
  if (evalJs) {
    const r = await send('Runtime.evaluate', { expression: evalJs, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) console.log('eval error:', r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    else console.log(JSON.stringify(r.result.value, null, 1));
  }
  if (out) {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log(`saved ${out}`);
  }
  if (logs.length) { console.log('--- console ---'); for (const l of logs) console.log(l); }
} finally {
  ws.close(); chrome.kill();
  await sleep(300);
  try { rmSync(prof, { recursive: true, force: true }); } catch {}
}
