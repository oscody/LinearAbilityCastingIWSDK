/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { AssetType, defineAssets } from '@iwsdk/core';
import groundBoard from './scene-assets/ground-board.scene-asset.js';

const publicAssetUrl = (filePath: string): string =>
  `${import.meta.env.BASE_URL}${filePath.replace(/^\/+/u, '')}`;

export default defineAssets({
  'ground-board': groundBoard,

  /**
   * Stage IBL. Referenced by the level root's `IBLTexture` by *asset id* —
   * `CacheManager.resolveUrl` maps the id to this url, so the component and any
   * runtime `loadHDRTextureById` share one decode.
   */
  'stage-hdr': {
    url: publicAssetUrl('hdri/spruit_sunrise.hdr'),
    type: AssetType.HDRTexture,
    name: 'Stage HDR (Spruit Sunrise)',
  },

  /**
   * ambientCG Rock030 (CC0). Registered so the floor can switch to sampled
   * stone, but `settings.environment.floorTexture` ships `false` — the stage's
   * default floor is the procedural dark stone, so these stay lazy until the
   * Ground shader patch is ported.
   */
  'floor-color': {
    url: publicAssetUrl('textures/cathedral/color.jpg'),
    type: AssetType.Texture,
    name: 'Floor Colour',
    priority: 'lazy',
  },
  'floor-normal': {
    url: publicAssetUrl('textures/cathedral/normal.jpg'),
    type: AssetType.Texture,
    name: 'Floor Normal',
    priority: 'lazy',
  },
  'floor-roughness': {
    url: publicAssetUrl('textures/cathedral/roughness.jpg'),
    type: AssetType.Texture,
    name: 'Floor Roughness',
    priority: 'lazy',
  },
  'floor-ao': {
    url: publicAssetUrl('textures/cathedral/ao.jpg'),
    type: AssetType.Texture,
    name: 'Floor AO',
    priority: 'lazy',
  },

  'welcome-panel': {
    url: publicAssetUrl('ui/welcome.uikitml'),
    type: AssetType.UIKitML,
    name: 'Welcome Panel',
  },
});
