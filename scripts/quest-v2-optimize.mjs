import { access, writeFile } from 'node:fs/promises';
import { connectQuestPage } from './quest-page-cdp.mjs';

const output = process.argv[2];
const grid = process.argv.includes('--grid');
const residual = process.argv.includes('--cache-residual');
const cache = process.argv.includes('--cache') || residual;
const windows = residual ? 4 : 8;
if (grid && cache) throw new Error('Choose one experiment.');
if (!output) throw new Error('Pass an unused output JSON path.');
try { await access(output); throw new Error('Output already exists'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const page = await connectQuestPage();
try {
  const url = new URL(page.url);
  url.searchParams.set('bench', 'off');
  url.searchParams.set('vfx', 'v2');
  if (cache) url.searchParams.set('work', 'cache');
  else if (grid) url.searchParams.set('work', 'grid');
  else url.searchParams.delete('work');
  await page.call('Page.bringToFront');
  await page.call('Page.navigate', { url: url.href });
  await page.waitFor('!!globalThis.FRAMEWORK_MCP_RUNTIME?.world?.getSystems().find(s => s.constructor.name === "CastSystem")');
  await page.evaluate('globalThis.FRAMEWORK_MCP_RUNTIME.world.launchXR()', true);
  await page.waitFor('globalThis.FRAMEWORK_MCP_RUNTIME.world.renderer.xr.getSession()?.visibilityState === "visible"');
  await page.evaluate(`(async () => {
    const { Vector3, Quaternion } = await import('/node_modules/.vite/deps/@iwsdk_core.js');
    const { RenderFrameProbe } = await import('/src/debug/RenderFrameProbe.ts');
    const world = globalThis.FRAMEWORK_MCP_RUNTIME.world;
    const cast = world.getSystems().find(s => s.constructor.name === 'CastSystem');
    const mist = cast.particles.systems.get('ice.mist');
    if (!mist?.uniforms.uMistPruning) throw new Error('Pruning shader not loaded');
    const t = globalThis.__optimizationTest = {
      world, cast, mist, controlled: cast.benchControlled,
      pruning: mist.uniforms.uMistPruning.value,
      grid: cast.decals.frostGrid,
      cache: cast.decals.frostCache,
      mistVisible: mist.mesh.visible,
      origin: new Vector3(), direction: new Vector3(), head: new Vector3(), rotation: new Quaternion(),
      initialHead: new Vector3(), initialRotation: new Quaternion(),
      probe: new RenderFrameProbe(world, world.renderer, ${windows}), windows: [],
    };
    world.camera.getWorldPosition(t.initialHead);
    world.camera.getWorldQuaternion(t.initialRotation);
    t.origin.copy(t.initialHead); t.origin.y = 0;
    world.camera.getWorldDirection(t.direction); t.direction.y = 0; t.direction.normalize();
    cast.benchControlled = true; cast.clearAll(); cast.abilities.select('ice');
    t.fire = () => {
      const original = Math.random; let seed = 0x1234567;
      Math.random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      try { cast.cast(t.origin, t.direction, 6); } finally { Math.random = original; }
    };
    if (${cache} && !cast.decals.supported) throw new Error('Frost cache unsupported');
    mist.uniforms.uMistPruning.value = ${grid || cache ? 0 : 1};
    t.fire();
  })()`);
  console.log('Warmup');
  await new Promise(resolve => setTimeout(resolve, 6000));
  await page.evaluate(`(() => {
    const t = globalThis.__optimizationTest, gl = t.world.renderer.getContext();
    t.warmupGLErrors = [];
    for (let i = 0; i < 16; i++) { const e = gl.getError(); if (!e) break; t.warmupGLErrors.push(e); }
  })()`);
  for (let index = 0; index < windows; index++) {
    const pruning = [false, true, true, false][index % 4];
    const overlap = residual || index >= 4;
    const name = (residual ? (pruning ? 'CACHED_FROST_NO_MIST' : 'CACHED_FROST')
      : pruning ? (cache ? 'CACHED_FROST' : grid ? 'FROST_GRID' : 'PRUNED_MIST') : 'APPROVED_V2') + (overlap ? '_OVERLAP' : '_SINGLE');
    console.log(index + 1, name);
    const result = await page.evaluate(`(async () => {
      const t = globalThis.__optimizationTest;
      t.cast.clearAll();
      t.mist.uniforms.uMistPruning.value = ${!grid && !cache && pruning ? 1 : 0};
      if (${grid}) t.cast.decals.setFrostGrid(${pruning});
      if (${cache}) t.cast.decals.setFrostCache(${residual || pruning});
      t.mist.mesh.visible = ${!(residual && pruning)};
      const bakesBefore = t.cast.decals.bakes || 0;
      t.probe.setWindow(${index}, ${JSON.stringify(name)});
      const start = performance.now(), times = ${overlap ? '[0, 2000, 6000, 8000]' : '[0, 6000]'};
      const fired = []; let next = 0, peak = 0, maxActive = 0, moved = 0, turned = 0;
      while (performance.now() - start < 12000) {
        if (!t.world.renderer.xr.isPresenting || t.world.renderer.xr.getSession()?.visibilityState !== 'visible')
          throw new Error('XR visibility lost');
        const elapsed = performance.now() - start;
        if (next < times.length && elapsed >= times[next]) { t.fire(); fired.push(elapsed); next++; }
        peak = Math.max(peak, t.cast.liveParticles());
        maxActive = Math.max(maxActive, t.cast.abilities.active.length);
        t.world.camera.getWorldPosition(t.head); t.world.camera.getWorldQuaternion(t.rotation);
        moved = Math.max(moved, t.head.distanceTo(t.initialHead));
        turned = Math.max(turned, t.rotation.angleTo(t.initialRotation) * 180 / Math.PI);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      t.probe.setWindow(-1, 'between');
      const result = { name: ${JSON.stringify(name)}, fired, peak, maxActive, moved, turned,
        bakes: (t.cast.decals.bakes || 0) - bakesBefore,
        cacheBytes: t.cast.decals.cacheBytes || 0, cacheFallbacks: t.cast.decals.cacheFallbacks || 0,
        mistVisible: t.mist.mesh.visible, glError: t.world.renderer.getContext().getError() };
      if (result.glError !== 0) throw new Error('WebGL error during scored window: ' + result.glError);
      if (next !== times.length || peak === 0 || (${overlap} && maxActive !== 2)) throw new Error('Cast/particle check failed');
      if (${cache && (residual || pruning)} && (result.bakes === 0 || result.cacheFallbacks !== 0)) throw new Error('Cache not fully active');
      if (t.world.renderer.info.programs.some(p => p.diagnostics?.runnable === false)) throw new Error('Shader compilation failed');
      if (moved > 0.05 || turned > 3) throw new Error('Head moved: stationary comparison invalid');
      t.windows.push(result);
      return result;
    })()`);
    console.log(JSON.stringify(result));
  }
  const report = await page.evaluate(`(() => {
    const t = globalThis.__optimizationTest;
    return { capturedAt: new Date().toISOString(), url: location.href, userAgent: navigator.userAgent,
      frames: t.probe.report(), checks: t.windows, warmupGLErrors: t.warmupGLErrors,
      head: t.initialHead.toArray(), rotation: t.initialRotation.toArray(),
      origin: t.origin.toArray(), direction: t.direction.toArray(), foveation: t.world.renderer.xr.getFoveation(),
      note: ${JSON.stringify(residual
        ? 'Stationary overlap ABBA, cached frost throughout; only mist rendering toggled. Simulation/emission retained. Twelve seconds/window. HUD enabled.'
        : 'Stationary ABBA, then overlap ABBA. Twelve seconds/window, same initial cast seed and head-facing direction. HUD enabled throughout.')} };
  })()`);
  await writeFile(output, JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log('Saved', output);
} finally {
  await page.evaluate(`(() => {
    const t = globalThis.__optimizationTest;
    if (!t) return;
    t.probe.dispose(); t.cast.clearAll(); t.cast.benchControlled = t.controlled;
    t.mist.uniforms.uMistPruning.value = t.pruning;
    t.mist.mesh.visible = t.mistVisible;
    if (t.grid !== undefined) t.cast.decals.setFrostGrid(t.grid);
    if (t.cache !== undefined) t.cast.decals.setFrostCache(t.cache);
  })()`).catch(() => {});
  page.close();
}
