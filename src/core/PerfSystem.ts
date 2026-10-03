/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { CanvasTexture, createSystem, Mesh, MeshBasicMaterial, PlaneGeometry } from '@iwsdk/core';
import { CastSystem } from '../abilities/CastSystem.js';
import { frame } from './FrameUniforms.js';
import { V2_ENABLED, V2_MANUAL, V2_FROST_GRID, V2_FROST_CACHE } from '../v2/VfxVersion.js';

/** Seconds between reports. */
const REPORT_INTERVAL = 5;
/** Rolling frame-time samples kept for percentiles. Allocated once. */
const WINDOW = 600;

/**
 * Frame-cost telemetry.
 *
 * Replaces the source HUD's live counters (FPS, particles, instances, draw
 * calls). Manual viewing (?bench=off) also gets a head-locked FPS badge using
 * the same lightweight canvas approach as CrystalBench's diagnostic badge.
 * Automated benchmarks retain their own per-condition badge.
 *
 * Every sample records whether XR was presenting, because a desktop number and
 * an on-device number are not comparable: XR renders two views at the headset's
 * panel resolution.
 *
 * `window.__perf` exposes the last report for manual inspection over
 * chrome://inspect when the MCP bridge cannot see the client.
 */
export class PerfSystem extends createSystem({}) {
  private elapsed = 0;
  private frames = 0;
  private samples!: Float32Array;
  private sampleCount = 0;
  private sorted!: Float32Array;
  private cast?: CastSystem;
  private badgeCtx?: CanvasRenderingContext2D;
  private badgeTex?: CanvasTexture;
  private liveElapsed = 0;
  private liveFrames = 0;
  private liveFps = 0;
  private lastSummary = 'Collecting a 5-second sample...';
  private lastTail = 'App FPS  |  Higher is smoother';

  init(): void {
    this.samples = new Float32Array(WINDOW);
    this.sorted = new Float32Array(WINDOW);
    this.cast = this.world.getSystem(CastSystem);
    if (V2_MANUAL) this.buildBadge();

    // A blurred headset idles its frame loop; folding those frames into the
    // average would flatter the numbers.
    this.cleanupFuncs.push(
      this.visibilityState.subscribe(() => {
        this.reset();
        this.liveElapsed = 0;
        this.liveFrames = 0;
        this.liveFps = 0;
        this.lastSummary = 'Collecting a 5-second sample...';
        this.lastTail = 'App FPS  |  Higher is smoother';
        this.drawBadge();
      }),
    );
  }

  private buildBadge(): void {
    const canvas = document.createElement('canvas');
    canvas.width = 768;
    canvas.height = 320;
    this.badgeCtx = canvas.getContext('2d')!;
    this.badgeTex = new CanvasTexture(canvas);
    const material = new MeshBasicMaterial({
      map: this.badgeTex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
    });
    const mesh = new Mesh(new PlaneGeometry(0.36, 0.15), material);
    mesh.name = 'FPS readout';
    mesh.position.set(0, -0.22, -0.8);
    mesh.frustumCulled = false;
    mesh.renderOrder = 9999;
    const entity = this.world.createTransformEntity(mesh);
    this.player.head.add(mesh);
    this.cleanupFuncs.push(() => {
      entity.dispose();
      this.badgeTex?.dispose();
    });
    this.drawBadge();
  }

  /** Two texture uploads per second; no canvas work on the other frames. */
  private drawBadge(): void {
    const ctx = this.badgeCtx;
    if (!ctx || !this.badgeTex) return;
    ctx.fillStyle = '#101b2b';
    ctx.fillRect(0, 0, 768, 320);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#d5e7ff';
    ctx.font = 'bold 38px sans-serif';
    ctx.fillText(V2_FROST_CACHE ? 'V2  •  CACHED FROST' : V2_FROST_GRID ? 'V2  •  FROST GRID' : V2_ENABLED ? 'V2  •  LIVE VIEW' : 'ORIGINAL  •  LIVE VIEW', 384, 48);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 104px sans-serif';
    ctx.fillText(this.liveFps > 0 ? Math.round(this.liveFps) + ' FPS' : '— FPS', 384, 157);
    ctx.font = '30px sans-serif';
    ctx.fillText(this.lastSummary, 384, 225);
    ctx.font = '28px sans-serif';
    ctx.fillText(this.lastTail, 384, 273);
    this.badgeTex.needsUpdate = true;
  }

  private reset(): void {
    this.elapsed = 0;
    this.frames = 0;
    this.sampleCount = 0;
  }

  update(delta: number): void {
    if (!(delta > 0) || !Number.isFinite(delta)) return;
    if (this.renderer.xr.isPresenting
      && this.renderer.xr.getSession()?.visibilityState !== 'visible') return;
    this.elapsed += delta;
    this.frames++;
    if (this.sampleCount < WINDOW) {
      this.samples[this.sampleCount++] = delta * 1000;
    }
    if (this.badgeTex) {
      this.liveElapsed += delta;
      this.liveFrames++;
      if (this.liveElapsed >= 0.5) {
        this.liveFps = this.liveFrames / this.liveElapsed;
        this.liveElapsed = 0;
        this.liveFrames = 0;
        this.drawBadge();
      }
    }
    if (this.elapsed < REPORT_INTERVAL) return;

    this.report();
    this.reset();
  }

  private report(): void {
    const n = this.sampleCount;
    if (n === 0) return;

    this.sorted.set(this.samples.subarray(0, n));
    const view = this.sorted.subarray(0, n);
    view.sort();

    const median = view[Math.floor(n * 0.5)];
    const p95 = view[Math.floor(n * 0.95)];
    const worst = view[n - 1];
    const fps = this.frames / this.elapsed;
    this.lastSummary = 'Last 5 sec: ' + fps.toFixed(1) + ' FPS average';
    this.lastTail = 'p95 ' + p95.toFixed(1) + ' ms  |  Worst ' + worst.toFixed(1) + ' ms';

    const info = this.renderer.info;
    const xr = this.renderer.xr;
    const presenting = xr.isPresenting;

    // Fill rate is the usual Quest bottleneck, so record what is actually being
    // rasterised: in XR that is the headset panel, not the canvas.
    let target = `${this.renderer.domElement.width}x${this.renderer.domElement.height}`;
    let views = 1;
    if (presenting) {
      const session = xr.getSession();
      const layer = session?.renderState.baseLayer;
      if (layer) target = `${layer.framebufferWidth}x${layer.framebufferHeight}`;
      views = 2;
    }

    const abilities = this.cast?.abilities;
    const active = abilities?.active ?? [];
    let instances = 0;
    for (const ability of active as Array<{ instanceCount: number }>) {
      instances += ability.instanceCount;
    }

    const sample = {
      mode: presenting ? 'xr' : 'browser',
      views,
      target,
      fps: +fps.toFixed(1),
      msMedian: +median.toFixed(2),
      msP95: +p95.toFixed(2),
      msWorst: +worst.toFixed(2),
      calls: info.render.calls,
      tris: info.render.triangles,
      points: info.render.points,
      programs: info.programs?.length ?? 0,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      abilities: active.length,
      instances,
      // Walks the particle pools, so only on the report tick -- never per frame.
      particles: this.cast?.particles.countLive(frame.uTime.value) ?? 0,
      foveation: xr.getFoveation?.() ?? null,
    };

    (globalThis as { __perf?: unknown }).__perf = sample;
    console.log('[perf] ' + JSON.stringify(sample));
  }
}
