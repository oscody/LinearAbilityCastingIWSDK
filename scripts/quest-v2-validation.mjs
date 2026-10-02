import { chromium } from 'playwright';
import { writeFile, access } from 'node:fs/promises';

// Worn test: original first (--baseline), then v2; use a fresh output path each time.
// Requires adb forwarding and the project already open on the physical Quest.
const output = process.argv[2];
if (!output) throw new Error('Pass an unused output JSON path.');
try { await access(output); throw new Error('Output already exists.'); }
catch (err) { if (err.code !== 'ENOENT') throw err; }
const baseline = process.argv.includes('--baseline');
const worn = process.argv.includes('--worn');
if (!worn && !process.argv.includes('--stationary')) {
  throw new Error('Pass --worn only with a wearer present, or --stationary for a diagnostic dry run.');
}
const browser = await chromium.connectOverCDP('http://localhost:9223');
let page;
try {
  page = browser.contexts().flatMap(c => c.pages()).find(p => /:808[123]\//.test(p.url()));
  if (!page) throw new Error('Project page not found.');
  const url = new URL(page.url());
  url.searchParams.set('bench', 'off');
  if (baseline) url.searchParams.delete('vfx');
  else url.searchParams.set('vfx', 'v2');
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => globalThis.FRAMEWORK_MCP_RUNTIME?.world?.getSystems()
    .some(s => s.constructor.name === 'CastSystem'), null, { timeout: 60000 });
  const session = await page.context().newCDPSession(page);
  await session.send('Runtime.evaluate', {
    expression: 'if(!globalThis.FRAMEWORK_MCP_RUNTIME.world.renderer.xr.isPresenting) globalThis.FRAMEWORK_MCP_RUNTIME.world.launchXR()', userGesture: true,
  });
  await page.waitForFunction(() => {
    const w = globalThis.FRAMEWORK_MCP_RUNTIME.world;
    return w.renderer.xr.isPresenting && w.renderer.xr.getSession()?.visibilityState === 'visible';
  }, null, { timeout: 60000 });
  await page.evaluate(async () => {
    const { Vector3, Quaternion } = await import('/node_modules/.vite/deps/@iwsdk_core.js');
    const { RenderFrameProbe } = await import('/src/debug/RenderFrameProbe.ts');
    const w = globalThis.FRAMEWORK_MCP_RUNTIME.world;
    const cast = w.getSystems().find(s => s.constructor.name === 'CastSystem');
    globalThis.__wornTest = {
      cast, originalControlled: cast.benchControlled,
      probe: new RenderFrameProbe(w, w.renderer, 3),
      origin: new Vector3(), direction: new Vector3(), head: new Vector3(), rotation: new Quaternion(),
      samples: [], casts: [], start: performance.now(), window: -1,
    };
    cast.benchControlled = true;
    cast.clearAll();
    cast.abilities.select('ice');
  });
  const fire = () => page.evaluate(() => {
    const t = globalThis.__wornTest, w = globalThis.FRAMEWORK_MCP_RUNTIME.world;
    w.camera.getWorldPosition(t.origin);
    t.origin.y = 0;
    w.camera.getWorldDirection(t.direction);
    t.direction.y = 0;
    t.direction.normalize();
    t.cast.cast(t.origin, t.direction, 6);
    t.casts.push({ window: t.window, seconds: (performance.now()-t.start)/1000, active: t.cast.abilities.active.length });
  });
  console.log('Warmup: put the Quest on; look down the ice field.');
  await fire();
  await page.waitForTimeout(6000);
  const names = ['CLOSE_VIEW', 'TURNING', 'TWO_OVERLAPPING_CASTS'];
  for (let window = 0; window < names.length; window++) {
    console.log(names[window], window === 1 ? 'Turn left/right repeatedly.' : 'Inspect mist and frost up close.');
    await page.evaluate(({ window, name }) => {
      const t = globalThis.__wornTest;
      t.cast.clearAll();
      t.window = window;
      t.probe.setWindow(window, name);
    }, { window, name: names[window] });
    for (let tick = 0; tick < 80; tick++) {
      // Six-second singles; the overlap scenario also fires two seconds later.
      if (tick % 24 === 0 || (window === 2 && tick % 24 === 8)) await fire();
      await page.waitForTimeout(250);
      await page.evaluate(() => {
        const t = globalThis.__wornTest, w = globalThis.FRAMEWORK_MCP_RUNTIME.world;
        if (!w.renderer.xr.isPresenting || w.renderer.xr.getSession().visibilityState !== 'visible') {
          throw new Error('Visible XR lost; validation invalid.');
        }
        w.camera.getWorldPosition(t.head);
        w.camera.getWorldQuaternion(t.rotation);
        t.samples.push({ window: t.window, seconds: (performance.now()-t.start)/1000,
          head: t.head.toArray(), rotation: t.rotation.toArray(),
          particles: t.cast.liveParticles(), active: t.cast.abilities.active.length });
      });
    }
  }
  const report = await page.evaluate(() => {
    const t = globalThis.__wornTest;
    t.probe.setWindow(-1, 'done');
    const turns = t.samples.filter(s => s.window === 1);
    const first = turns[0].rotation;
    let maxAngle = 0;
    for (const sample of turns) {
      const dot = Math.abs(first.reduce((sum, v, i) => sum + v*sample.rotation[i], 0));
      maxAngle = Math.max(maxAngle, 2*Math.acos(Math.min(1, dot))*180/Math.PI);
    }
    return { capturedAt: new Date().toISOString(), userAgent: navigator.userAgent,
      url: location.href, frames: t.probe.report(), samples: t.samples, casts: t.casts,
      maximumTurnDegrees: maxAngle, turningObserved: maxAngle >= 25,
      overlapObserved: t.samples.some(s => s.window === 2 && s.active === 2),
      note: 'Head motion and overlap are measured; wearing and visual approval require human confirmation.' };
  });
  report.wearingConfirmedByOperator = worn;
  await writeFile(output, JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log('Saved', output, 'turningObserved', report.turningObserved, 'overlapObserved', report.overlapObserved);
} finally {
  if (page) await page.evaluate(async () => {
    const t = globalThis.__wornTest;
    if (!t) return;
    t.probe.dispose();
    t.cast.clearAll();
    t.cast.benchControlled = t.originalControlled;
    await globalThis.FRAMEWORK_MCP_RUNTIME.dispatch('ecs_resume', {});
  }).catch(() => {});
  await browser.close();
}
