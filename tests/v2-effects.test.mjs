import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const particle = read('src/particles/ParticleSystem.js');
const particleV2 = read('src/v2/ParticleSystemV2.js');
const decals = read('src/effects/GroundDecals.js');
const decalsV2 = read('src/v2/GroundDecalsV2.js');

function parse(source) {
  return ts.createSourceFile('effect.js', source, ts.ScriptTarget.Latest, true);
}
function method(source, name) {
  const file = parse(source);
  const cls = file.statements.find(ts.isClassDeclaration);
  return cls.members.find(m => name === 'constructor' ? ts.isConstructorDeclaration(m) : m.name?.getText(file) === name).getText(file);
}
function declaration(source, name) {
  const file = parse(source);
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const found = statement.declarationList.declarations.find(d => d.name.getText(file) === name);
    if (found) return found.initializer.getText(file);
  }
  throw new Error('Missing ' + name);
}

test('V2 mist leaves motion, emission, lifetime, geometry and gradients unchanged', () => {
  assert.equal(declaration(particleV2, 'PARTICLE_VERTEX'), declaration(particle, 'PARTICLE_VERTEX'));
  for (const name of ['emit', 'flush', 'countLive', 'reset', 'setGradient', 'dispose']) {
    assert.equal(method(particleV2, name), method(particle, name), name);
  }
  const oldConstructor = method(particle, 'constructor');
  const newConstructor = method(particleV2, 'constructor')
    .replace('uMistV2: { value: 0 },\n        ', '')
    .replace('uMistPruning: { value: 0 },\n        ', '');
  assert.equal(newConstructor, oldConstructor);
  assert.match(particleV2, /if \(uMistV2 > 0\.5\)/);
  assert.match(particleV2, /n = fbm3\(vec3\(c \* 1\.6, vSeed \* 21\.0 \+ uTime \* 0\.25\)\)/);
});

test('V2 frost leaves spawn, radius, growth, coverage, alpha and lifetime unchanged', () => {
  assert.equal(declaration(decalsV2, 'DECAL_VERTEX'), declaration(decals, 'DECAL_VERTEX'));
  for (const name of ['spawn', 'update', 'clear', 'dispose']) {
    assert.equal(method(decalsV2, name), method(decals, name), name);
  }
  const originalFrost = decals.slice(decals.indexOf('float seed = uSeed * 37.0;'), decals.indexOf('#elif DECAL == 5'));
  const newFrost = decalsV2.slice(decalsV2.indexOf('float seed = uSeed * 37.0;'), decalsV2.indexOf('#elif DECAL == 5'));
  assert.equal(newFrost.slice(0, newFrost.indexOf('/* ---- relief ---- */')),
    originalFrost.slice(0, originalFrost.indexOf('/* ---- relief ---- */')));
  assert.equal(newFrost.slice(newFrost.indexOf('float lambert')),
    originalFrost.slice(originalFrost.indexOf('float lambert')));
  assert.match(newFrost, /float h  = snowDepth\(q, seed, sharp\)/);
});

test('frost switch reaches active, pooled, and subsequently created decals', () => {
  const Harness = new Function(`return class { ${method(decalsV2, 'setFrostV2')} }`)();
  const harness = new Harness();
  const decal = () => ({ material: { uniforms: { uFrostV2: { value: 0 } } } });
  const active = decal(), parked = decal();
  harness.active = [active];
  harness.pools = new Map([[6, { free: [parked] }]]);
  harness.frostV2 = false;
  harness.setFrostV2(true);
  assert.equal(active.material.uniforms.uFrostV2.value, 1);
  assert.equal(parked.material.uniforms.uFrostV2.value, 1);
  assert.match(method(decalsV2, '_createDecal'), /uFrostV2: \{ value: this.frostV2 \? 1 : 0 \}/);
  harness.setFrostV2(false);
  assert.equal(active.material.uniforms.uFrostV2.value, 0);
  assert.equal(parked.material.uniforms.uFrostV2.value, 0);
});

test('V2 switches are idempotent and affect only ice mist', () => {
  const engine = read('src/v2/ParticleEngineV2.js');
  const Harness = new Function(`return class { ${method(engine, 'setMistV2')} }`)();
  const h = new Harness();
  const mist = { uniforms: { uMistV2: { value: 0 } } };
  h.systems = new Map([['ice.mist', mist], ['ice.shards', {}]]);
  h.setMistV2(true);
  h.setMistV2(true);
  assert.equal(mist.uniforms.uMistV2.value, 1);
  h.setMistV2(false);
  assert.equal(mist.uniforms.uMistV2.value, 0);
  assert.match(engine, /if \(name !== 'ice\.mist'\) return super\.get/);
});
