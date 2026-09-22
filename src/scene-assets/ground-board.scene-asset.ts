/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from '@iwsdk/core';
import { settings } from '../config/settings.js';

/** Walkable span in meters. */
const BOARD_SIZE = 8;
/** Slab thickness; enough to read as a board from a grazing angle. */
const BOARD_THICKNESS = 0.08;

/**
 * The stage floor, in the source's palette: dark cinematic stone, so the
 * elemental VFX stay the brightest thing in the scene.
 *
 * Exported so `StageSystem` can keep it synced to `settings.environment` — the
 * project's central promise is that settings are sampled live, not captured.
 * There is one placement, so mutating this shared material is intended.
 */
export const boardMaterial = new MeshStandardMaterial({
  color: settings.environment.floorColor,
  roughness: settings.environment.floorRoughness,
  metalness: 0,
  dithering: true,
});

const board = new Group();
board.name = 'Ground board';

const slab = new Mesh(
  new BoxGeometry(BOARD_SIZE, BOARD_THICKNESS, BOARD_SIZE),
  boardMaterial,
);
// The walking surface sits at the prototype's local y=0, so a scene node's
// y position is the height a player stands at.
slab.position.y = -BOARD_THICKNESS / 2;
slab.receiveShadow = true;
board.add(slab);

export default board;
