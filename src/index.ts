/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { FrameUniformSystem } from './core/FrameUniformSystem.js';
import { PanelSystem } from './panel.js';

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then((world) => {
  // Shared VFX uniforms and the scaled simulation clock. Runs before anything
  // that samples them.
  world.registerSystem(FrameUniformSystem, { priority: -10 });
  world.registerSystem(PanelSystem);
});
