/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { AssetManager, createSystem, Texture, Vector3 } from '@iwsdk/core';
import { DustMotes } from './DustMotes.js';
import { LAYER } from '../core/Layers.js';
import { boardMaterial } from '../scene-assets/ground-board.scene-asset.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * The stage: ambient dust, the floor's live material sync, and the two
 * environment-owned shared uniforms.
 *
 * This is the part of the ported `App` that owned `world/`. It exists mostly to
 * preserve the project's central invariant — settings are *sampled* every frame,
 * never captured — for values that would otherwise freeze at module evaluation.
 */
export class StageSystem extends createSystem({}) {
  private dust!: DustMotes;
  private anchor!: Vector3;

  init(): void {
    this.anchor = new Vector3();

    // Every ported VFX object is assigned LAYER.VFX, because the deferred post
    // stack (D2) separates it from opaque WORLD geometry for the depth prepass.
    // Three's camera only renders layer 0, so until those passes come back the
    // camera has to be told to draw layer 1 as well -- otherwise VFX are simply
    // absent, with no error. LAYER.DISTORTION stays off deliberately: those
    // proxies are meant to be invisible to the main pass.
    //
    // When D2 lands, this line goes away and the passes own layer selection.
    this.camera.layers.enable(LAYER.VFX);

    this.dust = new DustMotes();
    this.dust.setPixelRatio(this.renderer.getPixelRatio());
    this.world.createTransformEntity(this.dust.points);

    // The raw equirect, for cheap reflections in the VFX materials. The level
    // root's IBLTexture references the same manifest id, so this shares its
    // decode rather than adding a second one.
    // `FrameUniforms.js` is untyped JS, so its boxes infer from their null
    // initialisers. Narrow at the boundary rather than editing the ported file.
    const envMapBox = frame.uEnvMap as { value: Texture | null };
    void AssetManager.loadHDRTextureById('stage-hdr').then((texture) => {
      envMapBox.value = texture;
    });

    this.cleanupFuncs.push(() => this.dust.dispose());
  }

  update(delta: number): void {
    const env = settings.environment;

    // Floor. One placement, so mutating the shared prototype material is the
    // intended path (see the scene-asset module).
    boardMaterial.color.copy(getColor(env.floorColor));
    boardMaterial.roughness = env.floorRoughness;

    // Direction *toward* the key light, mirrored from the stage's sun angles so
    // shaders that fake a normal agree with the lit meshes.
    const cosElevation = Math.cos(env.sunElevation);
    frame.uLightDir.value
      .set(
        cosElevation * Math.sin(env.sunAzimuth),
        Math.sin(env.sunElevation),
        cosElevation * Math.cos(env.sunAzimuth),
      )
      .normalize();

    // Dust rides the *scaled* clock like the rest of the simulation, and keeps
    // its volume centred on the player without re-uploading positions.
    this.player.getWorldPosition(this.anchor);
    this.dust.update(frame.uTime.value, this.anchor);
    void delta;
  }
}
