import { chromium } from 'playwright';
import { createWriteStream, existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

// adb forward tcp:9223 localabstract:chrome_devtools_remote
// node scripts/quest-benchmark.mjs <unused output stem> [--reload] [--frost]
const stem = process.argv[2];
if (!stem) throw new Error('Pass an output stem for the captured log and JSON report.');
if (existsSync(stem + '.log') || existsSync(stem + '.json')) throw new Error('Output already exists; choose a new stem.');
const browser = await chromium.connectOverCDP('http://localhost:9223', { timeout: 15000 });
const page = browser.contexts().flatMap(c => c.pages()).find(p => /:808[123]\//.test(p.url()));
if (!page) throw new Error('Open the project in the Quest browser first.');
const log = createWriteStream(stem + '.log', { flags: 'wx' });
let invalid = false;
let done = false;
page.on('console', msg => {
  const line = msg.text();
  log.write(new Date().toISOString() + ' ' + line + '\n');
  if (line.includes('INVALID RUN')) invalid = true;
  if (line.startsWith('[frame-probe] RESULTS')) done = true;
  if (/WINDOW RESULT|PARTICLE CHECK|GPU timer|INVALID RUN|## WINDOW/.test(line)) console.log(line);
});
page.on('pageerror', err => { log.write('PAGE ERROR ' + err.stack + '\n'); console.error(err.message); });
try {
  if (process.argv.includes('--frost')) {
    const url = new URL(page.url());
    url.searchParams.set('bench', 'frost');
    await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } else if (process.argv.includes('--reload')) {
    const url = new URL(page.url());
    url.searchParams.delete('bench');
    await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }
  await page.waitForFunction(() => !!globalThis.__benchStatus, null, { timeout: 60000 });
  const session = await page.context().newCDPSession(page);
  const state = await session.send('Runtime.evaluate', {
    expression: '({status:globalThis.__benchStatus,session:globalThis.FRAMEWORK_MCP_RUNTIME.world.session?.visibilityState,visible:document.visibilityState})',
    returnByValue: true,
  });
  console.log('Initial state', JSON.stringify(state.result.value));
  await session.send('Runtime.evaluate', {
    expression: 'globalThis.FRAMEWORK_MCP_RUNTIME.world.launchXR()', userGesture: true,
  });
  const deadline = Date.now() + 12 * 60 * 1000;
  while (!done && Date.now() < deadline) {
    if (invalid) throw new Error('Benchmark invalidated; inspect the captured log.');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!done) throw new Error('Timed out waiting for a visible XR session and completed benchmark.');
  const report = await page.evaluate(() => ({
    capturedAt: new Date().toISOString(), userAgent: navigator.userAgent,
    status: globalThis.__benchStatus, effects: globalThis.__bench,
    frames: globalThis.__benchFrames, perf: globalThis.__perf,
  }));
  await writeFile(stem + '.json', JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log('Saved', stem + '.json');
} finally {
  log.end();
  await browser.close();
}
