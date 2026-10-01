import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

// Execute the real suppression methods without constructing a browser/XR world.
const file = ts.createSourceFile('CrystalBench.ts', readFileSync(new URL('../src/debug/CrystalBench.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const cls = file.statements.find(s => ts.isClassDeclaration(s) && s.name.text === 'CrystalBench');
const members = cls.members.filter(s => s.name && [
  'savedDecals', 'savedBursts', 'savedParticleCount', 'savedEmissionRate',
  'simSuppressed', 'emitStubbed', 'suppressParticles', 'restoreSuppression',
  'liveApply', 'applySuppression',
  'update',
].includes(s.name.getText(file))).map(s => s.getText(file)).join('\n');
const source = `class Harness { forEachIceInstance() {} stubInstances() {} ${members} }`;
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;

function setup(count = 0.75, rate = 0.6, enabled = true) {
  const settings = { global: { particleCount: count, emissionRate: rate } };
  const Harness = new Function('settings', 'MODE_SPECS', 'DecalType', 'BENCH_ENABLED', `${js}; return Harness;`)(settings, {
    NO_PARTICLES: { suppress: ['particles'] },
  }, { FROST: 6, SHOCKWAVE: 3 }, enabled);
  return { settings, harness: new Harness() };
}

test('repeated live suppression restores the original non-default multipliers', () => {
  const { settings, harness } = setup();
  const off = { visible: true, suppress: ['particles'] };
  harness.liveApply(off);
  harness.liveApply(off); // cast activation immediately re-applies the condition
  harness.liveApply(off); // subsequent casts do the same
  assert.deepEqual(settings.global, { particleCount: 0, emissionRate: 0 });
  harness.restoreSuppression();
  harness.liveApply({ visible: true, suppress: [] });
  assert.deepEqual(settings.global, { particleCount: 0.75, emissionRate: 0.6 });
});

test('restoration is a no-op when nothing was suppressed', () => {
  const { settings, harness } = setup();
  harness.restoreSuppression();
  assert.deepEqual(settings.global, { particleCount: 0.75, emissionRate: 0.6 });
});

test('a second suppression cycle captures fresh settings', () => {
  const { settings, harness } = setup();
  harness.applySuppression('NO_PARTICLES');
  harness.restoreSuppression();
  settings.global.particleCount = 0.4;
  settings.global.emissionRate = 0.2;
  harness.liveApply({ visible: true, suppress: ['particles'] });
  harness.liveApply({ visible: true, suppress: ['particles'] });
  harness.restoreSuppression();
  assert.deepEqual(settings.global, { particleCount: 0.4, emissionRate: 0.2 });
});

test('intentional zero settings survive suppression and repeated restoration', () => {
  const { settings, harness } = setup(0, 0);
  harness.liveApply({ visible: true, suppress: ['particles'] });
  harness.restoreSuppression();
  harness.restoreSuppression();
  assert.deepEqual(settings.global, { particleCount: 0, emissionRate: 0 });
});

test('disabling the benchmark leaves update inert without initialization', () => {
  const { harness } = setup(1, 1, false);
  assert.doesNotThrow(() => harness.update(1 / 72));
});

test('selective frost suppression preserves shockwaves and restores the original service', () => {
  const { harness } = setup();
  const calls = [];
  const decals = { spawn(type) { calls.push(type); } };
  harness.cast = { ctx: { decals } };
  const cond = { visible: true, suppress: ['frost'] };
  harness.liveApply(cond);
  harness.liveApply(cond);
  harness.cast.ctx.decals.spawn(6, {}, {});
  harness.cast.ctx.decals.spawn(3, {}, {});
  assert.deepEqual(calls, [3]);
  harness.restoreSuppression();
  assert.equal(harness.cast.ctx.decals, decals);
  harness.cast.ctx.decals.spawn(6, {}, {});
  assert.deepEqual(calls, [3, 6]);
});

const probeSource = readFileSync(new URL('../src/debug/RenderFrameProbe.ts', import.meta.url), 'utf8');
const probeJS = ts.transpileModule(probeSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
}).outputText;
const { RenderFrameProbe } = await import('data:text/javascript;base64,' + Buffer.from(probeJS).toString('base64'));

test('full-frame timing includes render and callbacks, and keeps delayed GPU samples in their original window', (t) => {
  let clock = 1000;
  t.mock.method(performance, 'now', () => clock);
  let ready = false;
  const ext = { TIME_ELAPSED_EXT: 10, GPU_DISJOINT_EXT: 11 };
  const gl = {
    CURRENT_QUERY: 1, QUERY_RESULT_AVAILABLE: 2, QUERY_RESULT: 3,
    getExtension: () => ext, createQuery: () => ({}), deleteQuery() {},
    beginQuery() {}, endQuery() {}, getQuery: () => null,
    getParameter: () => false,
    getQueryParameter: (_, key) => key === 2 ? ready : 40e6,
  };
  const world = { update() { clock += 3; } };
  const renderer = { getContext: () => gl, xr: { isPresenting: true }, render() { clock += 7; } };
  const originalUpdate = world.update;
  const originalRender = renderer.render;
  const probe = new RenderFrameProbe(world, renderer, 2);
  probe.setWindow(0, 'CURRENT');
  world.update(0.12, 1);
  clock += 2; // XR callbacks run between ECS updates and render.
  renderer.render({}, {});
  clock = 1120;
  probe.setWindow(1, 'NO_PARTICLES');
  ready = true;
  world.update(0.12, 1.12);
  renderer.render({}, {});
  const { windows } = probe.report();
  assert.equal(windows[0].interval.mean, 120); // no 100 ms cap
  assert.equal(windows[0].cpuFrame.mean, 12);
  assert.equal(windows[0].update.mean, 3);
  assert.equal(windows[0].render.mean, 7);
  assert.equal(windows[0].gpu.mean, 40);
  assert.equal(windows[1].cpuFrame.mean, 10);
  probe.dispose();
  assert.equal(world.update, originalUpdate);
  assert.equal(renderer.render, originalRender);
});

test('GPU clock discontinuities discard outstanding timings', () => {
  let disjoint = false;
  const gl = {
    CURRENT_QUERY: 1, QUERY_RESULT_AVAILABLE: 2, QUERY_RESULT: 3,
    getExtension: () => ({ TIME_ELAPSED_EXT: 10, GPU_DISJOINT_EXT: 11 }),
    createQuery: () => ({}), deleteQuery() {}, beginQuery() {}, endQuery() {},
    getQuery: () => null, getParameter: () => disjoint,
    getQueryParameter: () => true,
  };
  const world = { update() {} };
  const renderer = { getContext: () => gl, xr: { isPresenting: true }, render() {} };
  const probe = new RenderFrameProbe(world, renderer, 1);
  probe.setWindow(0, 'CURRENT');
  world.update(0.01, 1);
  renderer.render({}, {});
  disjoint = true;
  const result = probe.report();
  assert.equal(result.disjointCount, 1);
  assert.equal(result.windows[0].gpu.count, 0);
  assert.equal(result.pendingQueries, 0);
  probe.dispose();
});
