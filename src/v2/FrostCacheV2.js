import {
  HalfFloatType, LinearFilter, Mesh, NoBlending, OrthographicCamera,
  PlaneGeometry, ShaderMaterial, Vector4, WebGLRenderTarget,
} from '@iwsdk/core';
import { DecalSystemV2, DecalType } from './GroundDecalsV2.js';

const COVERAGE = 'vec2 warp = vec2(fbm3(vec3(q * 0.55, seed)), fbm3(vec3(q * 0.55, seed + 5.7))) * 0.45;\n      float lobes = fbm3(vec3(q * 0.8 + warp, seed + 13.0));';
const HEIGHT = 'float h  = snowDepth(q, seed, sharp);';
const SLOPE_START = '        vec3 broad = valueNoiseV2(q * 0.85 + seed);';
const SLOPE_END = '        slope = clamp(slope, vec2(-1.5), vec2(1.5));';
const MAX_BYTES = 64 * 1024 * 1024;

/** Build from the approved shader so static fields use the same equations.
 * Only finite texture sampling approximates the result; animation stays live. */
export function frostCacheShaders(fragment) {
  const start = fragment.indexOf(SLOPE_START);
  const end = fragment.indexOf(SLOPE_END, start) + SLOPE_END.length;
  const main = fragment.indexOf('  void main()');
  if (start < 0 || end < SLOPE_END.length || main < 0 || !fragment.includes(COVERAGE) || !fragment.includes(HEIGHT))
    throw new Error('Approved frost shader contract changed');
  const slope = fragment.slice(start, end);
  return {
    bake: fragment.slice(0, main) + `
      void main() {
        vec2 q = (vUv - 0.5) * 2.0 * max(0.35, uRadius);
        float seed = uSeed * 37.0;
        float sharp = clamp(uWidth, 0.05, 4.0);
        float e = 0.16;
        ${COVERAGE}
        ${HEIGHT}
        vec2 slope;
        ${slope}
        gl_FragColor = vec4(lobes, h, slope);
      }
    `,
    live: 'uniform sampler2D uFrostField;\nuniform float uFrostCached;\n' + fragment
      .replace(COVERAGE, `
        bool cached = uFrostCached > 0.5 && uFrostV2 > 0.5;
        vec4 field = vec4(0.0);
        float lobes;
        if (cached) { field = texture2D(uFrostField, vUv); lobes = field.r; }
        else { ${COVERAGE.replace('float lobes =', 'lobes =')} }
      `)
      .replace(HEIGHT, 'float h = cached ? field.g : snowDepth(q, seed, sharp);')
      .replace('if (uFrostV2 > 0.5) {', 'if (cached) { slope = field.ba; } else if (uFrostV2 > 0.5) {'),
  };
}

/** Opt-in V2 experiment. Pooled RGBA16F maps: coverage, height, normal slope.
 * The approved DecalSystemV2 and all particle/ability settings remain intact. */
export class FrostCacheV2 extends DecalSystemV2 {
  constructor(scene, renderer) {
    super(scene);
    this.renderer = renderer;
    this.supported = renderer.extensions.has('EXT_color_buffer_float');
    this.frostCache = false;
    this.cacheBytes = 0;
    this.bakes = 0;
    this.cacheFallbacks = 0;
    this.bakeMaterial = null;
    this.bakeQuad = new Mesh(new PlaneGeometry(2, 2));
    this.bakeQuad.material.dispose();
    this.bakeQuad.frustumCulled = false;
    this.bakeCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.savedViewport = new Vector4();
    this.savedScissor = new Vector4();
  }

  setFrostCache(enabled) {
    this.frostCache = !!enabled && this.supported;
    for (const decal of this.active) {
      if (decal.type !== DecalType.FROST) continue;
      if (this.frostCache && !decal.cacheValid) decal.cacheAttempted = false;
      decal.material.uniforms.uFrostCached.value = this.frostCache && decal.cacheValid ? 1 : 0;
    }
    for (const pool of this.pools.values()) for (const decal of pool.free) {
      if (decal.type === DecalType.FROST) decal.material.uniforms.uFrostCached.value = 0;
    }
  }

  _createDecal(type) {
    const decal = super._createDecal(type);
    if (type !== DecalType.FROST) return decal;
    const shaders = frostCacheShaders(decal.material.fragmentShader);
    decal.material.fragmentShader = shaders.live;
    decal.material.uniforms.uFrostField = { value: null };
    decal.material.uniforms.uFrostCached = { value: 0 };
    decal.cacheTarget = null;
    decal.cacheValid = false;
    decal.cacheAttempted = false;
    if (!this.bakeMaterial) {
      this.bakeMaterial = new ShaderMaterial({
        uniforms: { uSeed: { value: 0 }, uWidth: { value: 0 }, uRadius: { value: 1 } },
        vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: shaders.bake,
        depthTest: false, depthWrite: false, blending: NoBlending, toneMapped: false,
      });
      this.bakeQuad.material = this.bakeMaterial;
    }
    return decal;
  }

  spawn(type, position, options = {}) {
    const decal = super.spawn(type, position, options);
    if (type === DecalType.FROST) {
      // A pooled decal has a fresh seed/size. Never reuse its previous pattern.
      decal.cacheValid = false;
      decal.cacheAttempted = false;
      decal.material.uniforms.uFrostCached.value = 0;
    }
    return decal;
  }

  update(dt) {
    super.update(dt);
    if (!this.frostCache) return;
    // UI/CDP toggles can happen between XR frames, when the XR render target
    // is not usable. Bake only inside the world's frame update, never there.
    for (const decal of this.active) {
      if (decal.type !== DecalType.FROST || decal.cacheValid || decal.cacheAttempted) continue;
      decal.cacheAttempted = true;
      this._bake(decal);
    }
  }

  _bake(decal) {
    const size = decal.radius > 5 ? 512 : 256;
    const oldBytes = decal.cacheTarget ? decal.cacheTarget.width ** 2 * 8 : 0;
    const bytes = size * size * 8;
    if (this.cacheBytes - oldBytes + bytes > MAX_BYTES) {
      this.cacheFallbacks++;
      return; // Preserve the procedural effect when the cache budget is full.
    }
    if (!decal.cacheTarget || decal.cacheTarget.width !== size) {
      decal.cacheTarget?.dispose();
      decal.cacheTarget = new WebGLRenderTarget(size, size, {
        type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter,
        depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
      });
      this.cacheBytes += bytes - oldBytes;
      decal.material.uniforms.uFrostField.value = decal.cacheTarget.texture;
    }
    const r = this.renderer;
    const target = r.getRenderTarget(), face = r.getActiveCubeFace(), mip = r.getActiveMipmapLevel();
    const xr = r.xr.enabled, autoClear = r.autoClear, scissorTest = r.getScissorTest();
    r.getViewport(this.savedViewport); r.getScissor(this.savedScissor);
    const u = decal.material.uniforms, b = this.bakeMaterial.uniforms;
    b.uSeed.value = u.uSeed.value; b.uWidth.value = u.uWidth.value; b.uRadius.value = u.uRadius.value;
    try {
      r.xr.enabled = false;
      r.autoClear = false;
      r.setRenderTarget(decal.cacheTarget);
      r.setViewport(0, 0, size, size); r.setScissorTest(false);
      r.render(this.bakeQuad, this.bakeCamera);
      decal.cacheValid = true;
      u.uFrostCached.value = 1;
      this.bakes++;
    } finally {
      r.setRenderTarget(target, face, mip);
      r.setViewport(this.savedViewport); r.setScissor(this.savedScissor);
      r.setScissorTest(scissorTest);
      r.autoClear = autoClear; r.xr.enabled = xr;
    }
  }

  dispose() {
    this.clear();
    for (const pool of this.pools.values()) for (const decal of pool.free) decal.cacheTarget?.dispose();
    this.cacheBytes = 0;
    this.bakeMaterial?.dispose();
    this.bakeQuad.geometry.dispose();
    super.dispose();
  }
}
