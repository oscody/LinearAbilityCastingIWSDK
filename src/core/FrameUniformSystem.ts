/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem, Vector2, VisibilityState } from '@iwsdk/core';
import { frame } from './FrameUniforms.js';
import { settings } from '../config/settings.js';

/**
 * Writes the shared per-frame uniform boxes, and owns the scaled simulation
 * clock everything downstream reads.
 *
 * This is the top of the ported `App.frame()`. Because `FrameUniforms` hands the
 * *same* `{ value }` box to every VFX material, the handful of assignments below
 * update all of them — there is no traversal and no per-material bookkeeping.
 *
 * Two clocks, deliberately:
 *   - `delta` (this system's argument) is real seconds. Targeting and indicator
 *     reveal animations use it, so they keep moving while the sandbox is paused.
 *   - `frame.uDelta` / `frame.uTime` are *scaled* by `global.timeScale` and stop
 *     dead when paused. Every ability and particle system reads these.
 *
 * Registered at priority -10 so the uniforms are current before anything samples
 * them.
 */
export class FrameUniformSystem extends createSystem({}) {
  /** Scaled simulation time, in seconds. Mirrors `frame.uTime.value`. */
  public elapsed = 0;
  /** Freezes the simulation clock without stopping the indicators. */
  public paused = false;

  private drawingBufferSize!: Vector2;

  init(): void {
    this.drawingBufferSize = new Vector2();

    // Pause the simulation when the headset is off the face. The project rule
    // is to stop simulating on blur; the indicators keep their real-time clock.
    this.cleanupFuncs.push(
      this.visibilityState.subscribe((state) => {
        if (state === VisibilityState.VisibleBlurred) this.paused = true;
      }),
    );
  }

  update(delta: number): void {
    const dt = this.paused ? 0 : delta * settings.global.timeScale;
    this.elapsed += dt;

    frame.uTime.value = this.elapsed;
    frame.uDelta.value = dt;
    frame.uShaderIntensity.value = settings.global.shaderIntensity;
    frame.uGlobalGlow.value = settings.global.glow;
    frame.uCameraNear.value = this.camera.near;
    frame.uCameraFar.value = this.camera.far;

    // Set here rather than by the post pipeline, which is deferred (plan §2d).
    this.renderer.getDrawingBufferSize(this.drawingBufferSize);
    frame.uResolution.value.copy(this.drawingBufferSize);
  }
}
