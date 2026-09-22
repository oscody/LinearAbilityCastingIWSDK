/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem, Vector3 } from '@iwsdk/core';
import { AbilityManager } from './AbilityManager.js';
import { ParticleEngine } from '../particles/ParticleEngine.js';
import { LightPool } from '../effects/LightPool.js';
import { DecalSystem } from '../effects/GroundDecals.js';
import { FissureSystem } from '../effects/GroundFissures.js';
import { BurstSystem } from '../effects/BurstSphere.js';
import { CameraShake } from '../effects/CameraShake.js';
import { ScreenFlash } from '../effects/ScreenFlash.js';
import { patchOnBeforeCompile } from '../utils/shaderPatch.js';
import { frame } from '../core/FrameUniforms.js';

/**
 * Casting: the shared VFX services, the ability pool, and the per-frame order
 * they update in.
 *
 * This is the middle of the ported `App` — its constructor's "shared VFX
 * services" block plus the simulation half of `App.frame()`, in the same order.
 * Ability *content* is untouched from the source; only the wiring moved.
 *
 * Targeting is Phase 4. Until then `cast()` is driven by the debug trigger at
 * the bottom of this file.
 */
export class CastSystem extends createSystem({}) {
  public abilities!: AbilityManager;
  /** Exposed for telemetry (PerfSystem). */
  public particles!: ParticleEngine;

  private lights!: LightPool;
  private decals!: DecalSystem;
  private fissures!: FissureSystem;
  private bursts!: BurstSystem;
  private shake!: CameraShake;
  private flash!: ScreenFlash;

  private origin!: Vector3;
  private direction!: Vector3;

  /** TEMP (Phase 3): auto-fire so the ability can be verified without aiming. */
  private debugCastTimer = 0;

  /** Set by CrystalBench, which owns casting while a benchmark runs. */
  public benchControlled = false;

  init(): void {
    this.origin = new Vector3();
    this.direction = new Vector3();

    // One entity owns every VFX object. The ported services all take a "scene"
    // and call `.add()` on it; handing them this entity's Object3D keeps scene
    // graph membership with IWSDK and leaves the ported files untouched.
    const vfxRoot = this.world.createTransformEntity();
    const vfxScene = vfxRoot.object3D!;
    vfxScene.name = 'VFX';

    this.particles = new ParticleEngine(vfxScene);
    this.lights = new LightPool(vfxScene);
    this.decals = new DecalSystem(vfxScene);
    this.fissures = new FissureSystem(vfxScene);
    this.bursts = new BurstSystem(vfxScene);
    this.flash = new ScreenFlash();

    // The source shakes the orbit rig. There is no rig in first person (D1), and
    // shaking a headset camera is a motion-sickness hazard -- so the trauma model
    // stays wired and drives a sink instead. Phase 4/8 redirects it to controller
    // haptics, which is the honest VR translation of the same intent.
    this.shake = new CameraShake({ shakeOffset: new Vector3(), shakeRoll: 0 });

    this.abilities = new AbilityManager({
      scene: vfxScene,
      camera: this.camera,
      // `Environment.registerShadowCasterWithPatch` is a 3-line wrapper around
      // `patchOnBeforeCompile`; the rest of Environment is not needed here.
      environment: {
        registerShadowCasterWithPatch: (material: never, patch: never) =>
          patchOnBeforeCompile(material, patch),
      },
      particles: this.particles,
      lights: this.lights,
      decals: this.decals,
      fissures: this.fissures,
      bursts: this.bursts,
      shake: this.shake,
      flash: this.flash,
    });

    this.cleanupFuncs.push(() => {
      this.abilities.dispose();
      this.particles.dispose();
      this.decals.dispose();
      this.fissures.dispose();
      this.bursts.dispose();
      this.lights.dispose();
    });
  }

  /**
   * Fire the selected ability along a line. This is the signature
   * `AimController` emits in Phase 4, unchanged.
   */
  cast(origin: Vector3, direction: Vector3, distance: number): void {
    this.abilities.cast(origin, direction, distance);
  }

  update(delta: number): void {
    // Scaled simulation time, written by FrameUniformSystem at priority -10.
    const dt = frame.uDelta.value;

    this.debugCast(delta);

    // Same order as the source's `App.frame()`.
    this.abilities.update(dt);
    this.particles.flush();
    this.decals.update(dt);
    this.fissures.update(dt);
    this.bursts.update(dt);
    this.lights.update(dt);
    this.shake.update(delta);
    this.flash.update(delta);
  }

  /**
   * TEMP (Phase 3 only): cast down +Z from the player every few seconds, so the
   * ported ability can be verified before targeting exists. Deleted in Phase 4.
   */
  private debugCast(delta: number): void {
    if (this.benchControlled) return;
    this.debugCastTimer -= delta;
    if (this.debugCastTimer > 0) return;
    this.debugCastTimer = 6;

    this.player.getWorldPosition(this.origin);
    this.origin.y = 0;
    this.direction.set(1, 0, 0);
    this.cast(this.origin, this.direction, 6);
  }
}
