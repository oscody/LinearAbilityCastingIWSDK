/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem } from '@iwsdk/core';
import { CastSystem } from '../abilities/CastSystem.js';
import { frame } from './FrameUniforms.js';

/** Seconds between reports. */
const REPORT_INTERVAL = 5;
/** Rolling frame-time samples kept for percentiles. Allocated once. */
const WINDOW = 600;

/**
 * Frame-cost telemetry.
 *
 * Replaces the source HUD's live counters (FPS, particles, instances, draw
 * calls), which were plain DOM and do not exist in a headset. Until the spatial
 * HUD lands in Phase 6 this reports to the console, which is the only readout
 * that works identically in the browser and on device.
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

  init(): void {
    this.samples = new Float32Array(WINDOW);
    this.sorted = new Float32Array(WINDOW);
    this.cast = this.world.getSystem(CastSystem);

    // A blurred headset idles its frame loop; folding those frames into the
    // average would flatter the numbers.
    this.cleanupFuncs.push(
      this.visibilityState.subscribe(() => this.reset()),
    );
  }

  private reset(): void {
    this.elapsed = 0;
    this.frames = 0;
    this.sampleCount = 0;
  }

  update(delta: number): void {
    this.elapsed += delta;
    this.frames++;
    if (this.sampleCount < WINDOW) {
      this.samples[this.sampleCount++] = delta * 1000;
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
