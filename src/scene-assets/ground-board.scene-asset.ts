/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from '@iwsdk/core';

/** Walkable span in meters. */
const BOARD_SIZE = 15;
/** Slab thickness; enough to read as a board from a grazing angle. */
const BOARD_THICKNESS = 0.08;

const boardMaterial = new MeshStandardMaterial({
  color: '#8d8f93',
  roughness: 0.92,
  metalness: 0,
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
