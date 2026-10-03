import { access, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { connectQuestPage } from './quest-page-cdp.mjs';

const run = promisify(execFile);
const [stem, serial] = process.argv.slice(2);
const solo = process.argv.includes('--solo');
if (!stem || !serial) throw new Error('Pass an unused result stem and Quest serial.');
for (const suffix of ['.json', '-approved.png', '-cached.png']) {
  try { await access(stem + suffix); throw new Error('Output exists: ' + stem + suffix); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const p = await connectQuestPage();
const dispatch = (name, args = {}) => p.evaluate(`globalThis.FRAMEWORK_MCP_RUNTIME.dispatch(${JSON.stringify(name)}, ${JSON.stringify(args)})`);
const state = () => p.evaluate(`(() => {
  const t = globalThis.__cacheVisual, w = t.world, d = t.cast.decals;
  if (w.renderer.xr.getSession()?.visibilityState !== 'visible') throw new Error('Visible XR required');
  w.camera.getWorldPosition(t.head); w.camera.getWorldQuaternion(t.rotation);
  return { url: location.href, session: w.renderer.xr.getSession().visibilityState,
    head: t.head.toArray(), rotation: t.rotation.toArray(), particles: t.cast.liveParticles(),
    enabled: d.frostCache, bytes: d.cacheBytes, fallbacks: d.cacheFallbacks,
    frost: d.active.filter(v => v.type === 6).map(v => ({ age: v.age, life: v.life,
      radius: v.radius, seed: v.material.uniforms.uSeed.value, cached: v.material.uniforms.uFrostCached.value })),
    shaderErrors: w.renderer.info.programs.filter(v => v.diagnostics?.runnable === false).map(v => v.diagnostics) };
})()`);
try {
  await p.evaluate(`(async () => {
    const { Vector3, Quaternion } = await import('/node_modules/.vite/deps/@iwsdk_core.js');
    const world = globalThis.FRAMEWORK_MCP_RUNTIME.world;
    const cast = world.getSystems().find(s => s.constructor.name === 'CastSystem');
    if (cast.decals.constructor.name !== 'FrostCacheV2' || !cast.decals.supported) throw new Error('Load work=cache first');
    globalThis.__cacheVisual = { world, cast, controlled: cast.benchControlled, enabled: cast.decals.frostCache,
      origin: new Vector3(), direction: new Vector3(), head: new Vector3(), rotation: new Quaternion() };
    cast.benchControlled = true; cast.clearAll(); cast.abilities.select('ice'); cast.decals.setFrostCache(true);
  })()`);
  const paused = await dispatch('ecs_pause');
  const before = await dispatch('ecs_snapshot', { label: 'cache-before' });
  await p.evaluate(`(() => {
    const t = globalThis.__cacheVisual;
    t.world.camera.getWorldPosition(t.origin); t.origin.y = 0;
    t.world.camera.getWorldDirection(t.direction); t.direction.y = 0; t.direction.normalize();
    t.cast.cast(t.origin, t.direction, 6);
  })()`);
  const steps = [await dispatch('ecs_step', { count: 3, delta: 1 / 72 })];
  for (let i = 0; i < 5; i++) steps.push(await dispatch('ecs_step', { count: 20, delta: 1 / 72 }));
  const after = await dispatch('ecs_snapshot', { label: 'cache-after' });
  const diff = await dispatch('ecs_diff', { from: 'cache-before', to: 'cache-after' });
  if (solo) await p.evaluate(`(() => {
    const t = globalThis.__cacheVisual, d = t.cast.decals;
    t.hidden = d.group.parent.children.filter(o => o !== d.group).map(o => [o, o.visible]);
    for (const [o] of t.hidden) o.visible = false;
  })()`);
  const captures = [];
  for (const enabled of [false, true]) {
    await p.evaluate(`globalThis.__cacheVisual.cast.decals.setFrostCache(${enabled})`);
    await new Promise(resolve => setTimeout(resolve, 500));
    const pre = await state();
    const file = stem + (enabled ? '-cached.png' : '-approved.png');
    await run('npx', ['metavr', '-d', serial, 'capture', 'screenshot', '-o', file, '--json']);
    captures.push({ file, pre, post: await state() });
    console.log('Captured', file);
  }
  if (captures.some(c => c.pre.shaderErrors.length || c.pre.frost.length === 0)) throw new Error('Invalid visual capture');
  await writeFile(stem + '.json', JSON.stringify({ paused, before, steps, after, diff, solo, captures,
    note: 'Actual Quest captures at a fixed ECS age; no simulation step between A/B. Head pose recorded, wearer approval still required.' }, null, 2), { flag: 'wx' });
} finally {
  await p.evaluate(`(() => {
    const t = globalThis.__cacheVisual;
    if (!t) return;
    for (const [o, visible] of t.hidden || []) o.visible = visible;
    t.cast.clearAll(); t.cast.benchControlled = t.controlled; t.cast.decals.setFrostCache(t.enabled);
  })()`).catch(() => {});
  await dispatch('ecs_resume').catch(() => {});
  p.close();
}
