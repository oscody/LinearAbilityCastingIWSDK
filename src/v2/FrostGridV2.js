import { PlaneGeometry } from '@iwsdk/core';
import { DecalSystemV2, DecalType } from './GroundDecalsV2.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';

/** Experiment: sample frost's static coverage/height on a grid. Fine lighting
 * detail and animated glints still run per pixel. Off restores the approved V2. */
export class FrostGridV2 extends DecalSystemV2 {
  constructor(scene) {
    super(scene);
    this.frostGrid = false;
    this.gridGeometry = new PlaneGeometry(1, 1, 64, 64).rotateX(-Math.PI / 2);
  }

  setFrostGrid(enabled) {
    this.frostGrid = enabled;
    for (const decal of this.active) this._applyGrid(decal);
    for (const pool of this.pools.values()) for (const decal of pool.free) this._applyGrid(decal);
  }

  _applyGrid(decal) {
    if (decal.type !== DecalType.FROST) return;
    decal.material.uniforms.uFrostGrid.value = this.frostGrid ? 1 : 0;
    decal.mesh.geometry = this.frostGrid ? this.gridGeometry : this.geometry;
  }

  _createDecal(type) {
    const decal = super._createDecal(type);
    if (type !== DecalType.FROST) return decal;
    const material = decal.material;
    const fragment = material.fragmentShader;
    const snowStart = fragment.indexOf('  float snowDepth(');
    const snowEnd = fragment.indexOf('\n  void main()', snowStart);
    if (snowStart < 0 || snowEnd < 0) throw new Error('Frost height shader contract changed');
    const snow = fragment.slice(snowStart, snowEnd);
    material.uniforms.uFrostGrid = { value: this.frostGrid ? 1 : 0 };
    material.vertexShader = /* glsl */ `
      uniform float uFrostGrid;
      uniform float uSeed;
      uniform float uWidth;
      uniform float uRadius;
      varying vec2 vFrostField;
      ${noiseGLSL}
      ${snow}
    ` + material.vertexShader.replace('vUv = uv;', /* glsl */ `
      vUv = uv;
      vFrostField = vec2(0.0);
      if (uFrostGrid > 0.5) {
        vec2 q = (uv - 0.5) * 2.0 * max(0.35, uRadius);
        float seed = uSeed * 37.0;
        float sharp = clamp(uWidth, 0.05, 4.0);
        vec2 warp = vec2(fbm3(vec3(q * 0.55, seed)), fbm3(vec3(q * 0.55, seed + 5.7))) * 0.45;
        vFrostField.x = fbm3(vec3(q * 0.8 + warp, seed + 13.0));
        vFrostField.y = snowDepth(q, seed, sharp);
      }
    `);
    const originalCoverage = 'vec2 warp = vec2(fbm3(vec3(q * 0.55, seed)), fbm3(vec3(q * 0.55, seed + 5.7))) * 0.45;\n      float lobes = fbm3(vec3(q * 0.8 + warp, seed + 13.0));';
    const originalHeight = 'float h  = snowDepth(q, seed, sharp);';
    if (!fragment.includes(originalCoverage) || !fragment.includes(originalHeight))
      throw new Error('Frost coverage shader contract changed');
    material.fragmentShader = /* glsl */ `
      uniform float uFrostGrid;
      varying vec2 vFrostField;
    ` + fragment.replace(originalCoverage, /* glsl */ `
      float lobes;
      if (uFrostGrid > 0.5) lobes = vFrostField.x;
      else {
        vec2 warp = vec2(fbm3(vec3(q * 0.55, seed)), fbm3(vec3(q * 0.55, seed + 5.7))) * 0.45;
        lobes = fbm3(vec3(q * 0.8 + warp, seed + 13.0));
      }
    `).replace(originalHeight, 'float h = uFrostGrid > 0.5 ? vFrostField.y : snowDepth(q, seed, sharp);');
    this._applyGrid(decal);
    return decal;
  }

  dispose() {
    super.dispose();
    this.gridGeometry.dispose();
  }
}
