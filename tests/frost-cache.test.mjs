import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { noiseGLSL } from '../src/shaders/lib/noise.glsl.js';
import { commonGLSL } from '../src/shaders/lib/common.glsl.js';
import { cheapNoiseV2 } from '../src/v2/cheapNoiseV2.glsl.js';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const approved = read('src/v2/GroundDecalsV2.js');
const ast = ts.createSourceFile('decal.js', approved, ts.ScriptTarget.Latest, true);
const shader = ast.statements.filter(ts.isVariableStatement).flatMap(s => [...s.declarationList.declarations])
  .find(d => d.name.getText(ast) === 'DECAL_FRAGMENT').initializer.getText(ast);
const fragment = new Function('noiseGLSL', 'commonGLSL', 'cheapNoiseV2', `return ${shader}`)(noiseGLSL, commonGLSL, cheapNoiseV2);
const source = read('src/v2/FrostCacheV2.js').replace(/^import[\s\S]*?from [^;]+;\n/gm, '').replaceAll('export ', '');

class Resource { dispose() { this.disposed = (this.disposed || 0) + 1; } }
class Geometry extends Resource {}
class Material extends Resource { constructor(options = {}) { super(); Object.assign(this, options); } }
class Mesh { constructor(geometry) { this.geometry = geometry; this.material = new Material(); } }
class Target extends Resource { constructor(width, height) { super(); this.width = width; this.height = height; this.texture = {}; } }
class Base {
  constructor() { this.active = []; this.pools = new Map([[6, { free: [] }]]); }
  _createDecal(type) {
    return { type, material: new Material({ fragmentShader: fragment, uniforms: {
      uSeed: { value: 0 }, uWidth: { value: 0.12 }, uRadius: { value: 1 },
    } }) };
  }
  spawn(type, position, options = {}) {
    const d = type === 6 ? this.pools.get(6).free.pop() || this._createDecal(type) : this._createDecal(type);
    d.radius = options.radius || 1;
    d.material.uniforms.uRadius.value = d.radius;
    d.material.uniforms.uSeed.value++;
    this.active.push(d); return d;
  }
  clear() { this.pools.get(6).free.push(...this.active.filter(d => d.type === 6)); this.active.length = 0; }
  update() {}
  dispose() { this.clear(); this.pools.clear(); }
}
const { FrostCacheV2, frostCacheShaders } = new Function(
  'HalfFloatType', 'LinearFilter', 'Mesh', 'NoBlending', 'OrthographicCamera', 'PlaneGeometry',
  'ShaderMaterial', 'Vector4', 'WebGLRenderTarget', 'DecalSystemV2', 'DecalType',
  source + ';return { FrostCacheV2, frostCacheShaders };',
)(1, 1, Mesh, 0, class {}, Geometry, Material, class {}, Target, Base, { FROST: 6 });

function setup(supported = true) {
  const initialTarget = {};
  const r = { extensions: { has: () => supported }, xr: { enabled: true }, autoClear: true,
    target: initialTarget, viewport: [7, 8, 9, 10], scissor: [1, 2, 3, 4], scissorTest: true, calls: 0,
    getRenderTarget() { return this.target; }, getActiveCubeFace: () => 2, getActiveMipmapLevel: () => 3,
    getScissorTest() { return this.scissorTest; },
    getViewport(v) { v.values = this.viewport; }, getScissor(v) { v.values = this.scissor; },
    setViewport(...a) { this.viewport = a.length === 1 ? a[0].values : a; },
    setScissor(v) { this.scissor = v.values; }, setScissorTest(v) { this.scissorTest = v; },
    setRenderTarget(v, face, mip) { this.target = v; this.face = face; this.mip = mip; },
    render() { this.calls++; if (this.fail) throw new Error('render failed'); },
  };
  return { cache: new FrostCacheV2({}, r), r, initialTarget };
}

test('cache uses approved static equations and preserves animated coverage/alpha/glints', () => {
  const { bake, live } = frostCacheShaders(fragment);
  assert.match(bake, /gl_FragColor = vec4\(lobes, h, slope\)/);
  assert.match(bake, /float h  = snowDepth\(q, seed, sharp\)/);
  for (const line of fragment.split('\n').filter(l => /float (grow|reach|cover|lie|glint|lip) =|alpha =|alpha \*=/.test(l)))
    assert.ok(live.includes(line), line);
  assert.match(live, /if \(cached\) \{ slope = field.ba; \}/);
  assert.throws(() => frostCacheShaders('changed shader'), /contract changed/);
});

test('pooled frost rebakes once per spawn, toggle restores procedural, other decals untouched', () => {
  const { cache, r } = setup();
  cache.setFrostCache(true);
  const d = cache.spawn(6, {});
  assert.equal(r.calls, 0); // No offscreen render outside a world frame.
  cache.update(1 / 72);
  assert.equal(r.calls, 1);
  cache.setFrostCache(true);
  assert.equal(r.calls, 1);
  cache.setFrostCache(false);
  assert.equal(d.material.uniforms.uFrostCached.value, 0);
  cache.setFrostCache(true);
  assert.equal(d.material.uniforms.uFrostCached.value, 1);
  assert.equal(r.calls, 1);
  const target = d.cacheTarget;
  cache.clear();
  assert.equal(cache.spawn(6, {}), d);
  cache.update(1 / 72);
  assert.equal(d.cacheTarget, target);
  assert.equal(r.calls, 2);
  const wave = cache.spawn(3, {});
  assert.equal(wave.cacheTarget, undefined);
  assert.equal(wave.material.fragmentShader, fragment);
  cache.dispose();
  assert.equal(target.disposed, 1);
  assert.equal(cache.cacheBytes, 0);
});

test('baking restores XR render target, viewport, scissor and flags even on failure', () => {
  const { cache, r, initialTarget } = setup();
  cache.setFrostCache(true);
  cache.spawn(6, {});
  cache.update(1 / 72);
  r.fail = true;
  cache.spawn(6, {});
  assert.throws(() => cache.update(1 / 72), /render failed/);
  assert.equal(r.target, initialTarget);
  assert.equal(r.face, 2); assert.equal(r.mip, 3);
  assert.deepEqual(r.viewport, [7, 8, 9, 10]);
  assert.deepEqual(r.scissor, [1, 2, 3, 4]);
  assert.equal(r.scissorTest, true); assert.equal(r.xr.enabled, true); assert.equal(r.autoClear, true);
  assert.equal(cache.active[1].cacheValid, false);
});

test('unsupported hardware and full budget preserve procedural frost', () => {
  const unsupported = setup(false);
  unsupported.cache.setFrostCache(true);
  assert.equal(unsupported.cache.spawn(6, {}).material.uniforms.uFrostCached.value, 0);
  unsupported.cache.update(1 / 72);
  assert.equal(unsupported.r.calls, 0);
  const { cache, r } = setup();
  cache.setFrostCache(true);
  for (let i = 0; i < 33; i++) cache.spawn(6, {}, { radius: 7 });
  cache.update(1 / 72);
  cache.update(1 / 72); // A full budget is not retried on every frame.
  assert.equal(cache.cacheBytes, 64 * 1024 * 1024);
  assert.equal(cache.cacheFallbacks, 1);
  assert.equal(r.calls, 32);
  assert.equal(cache.active[32].material.uniforms.uFrostCached.value, 0);
});

test('enabling cache on existing frost defers new bakes to the next world update', () => {
  const { cache, r } = setup();
  const decal = cache.spawn(6, {});
  cache.setFrostCache(true);
  assert.equal(r.calls, 0);
  assert.equal(decal.material.uniforms.uFrostCached.value, 0);
  cache.update(1 / 72);
  assert.equal(r.calls, 1);
  assert.equal(decal.material.uniforms.uFrostCached.value, 1);
  cache.update(1 / 72);
  assert.equal(r.calls, 1);
});
