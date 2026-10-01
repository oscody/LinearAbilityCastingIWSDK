/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * DEBUG ONLY -- branch `Phase_3_IceCrystalDebug`. Not for master.
 */

import {
  CanvasTexture,
  createSystem,
  DoubleSide,
  FrontSide,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Vector3,
} from '@iwsdk/core';
import { CastSystem } from '../abilities/CastSystem.js';
import { settings } from '../config/settings.js';
import { createIceMaterial } from '../materials/IceMaterial.js';
import { patchOnBeforeCompile } from '../utils/shaderPatch.js';

/** Flip to false to run the app normally on this branch. */
const BENCH_ENABLED = true;

/**
 * `controlled` = the mode benchmark: one seeded static field, player still.
 * `live`       = real-play probe: the game's own casting (unseeded, every 6 s)
 *                runs untouched while you move and look around freely. Only the
 *                mist lifetime multiplier is cycled, and every 2 s the frame
 *                stats, cast/particle load and head pose are logged, so a slow
 *                stretch can be explained by what you were doing.
 *
 * V4-V7 read fast in some sessions and slow in others, and the user still saw
 * problems in VR; the controlled bench does not reproduce real play.
 */
const BENCH_MODE: 'controlled' | 'live' = 'live';

/**
 * V9 -- subtract in live play. Each window removes one thing while the game
 * casts on its own, so the condition that brings live play near the 11.1 ms floor
 * is the real cost. V8 showed lifetime x0.5 only takes ~76 -> ~53 ms live.
 *
 * Unlike the static bench's NO_* modes these keep the crystals VISIBLE (except
 * NO_CRYSTALS / NO_ANYTHING), so each result is player-facing. Cycle 2 runs the
 * list reversed to expose drift.
 */
interface LiveCondition {
  name: string;
  visible: boolean;
  suppress: Suppress[];
  /** False = the game never casts in this window (control). */
  casts: boolean;
  /** Multipliers on the ice frost decals' own settings, applied on top of CURRENT. */
  frost?: { rate?: number; life?: number; spread?: number };
}

/**
 * V10 -- decal fixes in live play. V9 showed removing the ground decals takes
 * live play from ~56 to ~18.5 ms. The frost patches are laid at `frostRate`
 * per metre of front travel, radius `halfWidth * frostSpread`, living
 * `frostLife` = 7 s while casts come every 6 s -- so consecutive casts overlap.
 * Each row changes one lever (plus a combination) and is compared against
 * CURRENT and the NO_DECALS ceiling.
 */
const LIVE_CONDITIONS: LiveCondition[] = [
  { name: 'CURRENT', visible: true, suppress: [], casts: true },
  { name: 'NO_DECALS', visible: true, suppress: ['decals'], casts: true },
  {
    name: 'FROST_RATE_HALF',
    visible: true,
    suppress: [],
    casts: true,
    frost: { rate: 0.5 },
  },
  {
    name: 'FROST_RATE_QUARTER',
    visible: true,
    suppress: [],
    casts: true,
    frost: { rate: 0.25 },
  },
  {
    name: 'FROST_LIFE_HALF',
    visible: true,
    suppress: [],
    casts: true,
    frost: { life: 0.5 },
  },
  {
    name: 'FROST_SPREAD_HALF',
    visible: true,
    suppress: [],
    casts: true,
    frost: { spread: 0.5 },
  },
  {
    name: 'FROST_LEAN',
    visible: true,
    suppress: [],
    casts: true,
    frost: { rate: 0.5, life: 0.5, spread: 0.7 },
  },
  { name: 'NO_CAST', visible: false, suppress: [], casts: false },
];

/**
 * V11: the probe fires every cast itself, at the same offsets in every window
 * (0, 6, 12, 18 s), so each condition sees an identical schedule. V10/V10-A showed
 * the game's own 6 s clock against 20 s windows gave each slot a different cast
 * phase, confounding condition with timing. Nothing is discarded: the window
 * starts clean (clearAll) and the first cast fires on frame 0.
 */
const LIVE_WINDOW_SECONDS = 24;
const LIVE_CAST_INTERVAL = 6;
/** Frame time is also binned by seconds since the last cast: [0-2), [2-4), [4-6). */
const LIVE_AGE_BINS = 3;
const LIVE_SKIP_SECONDS = 0;
const LIVE_LOG_SECONDS = 2;

/**
 * Every effect is torn down and the scene left empty for this long before the
 * next mode casts.
 *
 * Run 2 showed why this is mandatory: the two HIDDEN modes reported **89 and 102
 * draw calls** while drawing no crystals at all, against 42 for CURRENT. Those
 * were the previous mode's decals, fissures, bursts and still-living particles
 * carried over. Each mode was measuring "the mode before it, plus leftovers".
 */
const SETTLE_SECONDS = 1.5;
/** Discarded after a material swap, so shader compile never lands in a sample. */
const WARMUP_SECONDS = 1.5;
/** Sampled per mode, per repeat. */
const MEASURE_SECONDS = 4;
/**
 * Repeats of the whole mode list, **interleaved** rather than blocked.
 *
 * The first run of this bench measured CURRENT twice and got 28.8 ms and
 * 43.4 ms -- a 14.6 ms spread on an identical config, larger than the entire
 * effect being measured. Running the list round-robin means thermal drift and
 * background load land on every mode equally instead of on whichever ran last.
 */
const REPEATS = 3;

/**
 * After the first scored rep's measure window, the field keeps standing for this
 * long with nothing being sampled, so the fog can be judged by eye. Purple badge.
 * Skipped for the warm-up pass and later reps (heat) and for NO_CAST (nothing to see).
 */
const LOOK_SECONDS = 12;

/** Fixed cast, identical for every mode. */
/** A frame this long has missed the 90 Hz budget (11.1 ms) by a visible margin. */
const SLOW_MS = 13.9;

const CAST_DISTANCE = 6;
const CAST_DIRECTION = new Vector3(1, 0, 0);

type ModeName =
  | 'NO_CAST'
  | 'NO_PARTICLES'
  | 'NO_MIST'
  | 'NO_SHARDS'
  | 'NO_GLITTER'
  | 'MIST_QUARTER_RATE'
  | 'MIST_HALF_LIFE'
  | 'MIST_LIFE_70'
  | 'MIST_LIFE_85'
  | 'MIST_HALF_SIZE'
  | 'MIST_SMALL_END'
  | 'MIST_LEAN'
  | 'BURST_NONE'
  | 'BURST_THIRD_COUNT'
  | 'BURST_HALF_SIZE'
  | 'BURST_HALF_LIFE'
  | 'NO_DECALS'
  | 'NO_BURSTS'
  | 'NO_SIM'
  | 'NO_ANYTHING'
  | 'HIDDEN_ICE_MAT'
  | 'HIDDEN_SIMPLE_MAT'
  | 'CURRENT'
  | 'SIMPLE_OPAQUE'
  | 'SIMPLE_TRANSPARENT'
  | 'STANDARD_OPAQUE'
  | 'ICE_OPAQUE'
  | 'ICE_SINGLE_SIDE';

/** Which prebuilt material a mode assigns. `null` = the ability's own ice material. */
type MaterialKey =
  | 'SIMPLE_OPAQUE'
  | 'SIMPLE_TRANSPARENT'
  | 'STANDARD_OPAQUE'
  | 'ICE_OPAQUE'
  | 'ICE_SINGLE_SIDE';

/**
 * Step 3 axis: what the cast is forbidden to do this mode.
 *
 *  `particles` — zeroes `settings.global.particleCount` / `emissionRate`. Every
 *                emit in IceAbility is `Math.round(N * g.particleCount)`, so this
 *                is exact. It has to go through settings rather than a ctx stub
 *                because `createParticles()` caches its system references.
 *  `decals`    — swaps `ctx.decals` for a no-op; read at call time.
 *  `bursts`    — swaps `ctx.bursts` for a no-op; read at call time.
 *  `sim`       — no-ops `_updateSpikes`, the per-frame recomposition of up to 190
 *                instance matrices and their instanced-attribute upload. This is
 *                the largest per-frame CPU work in a cast and is paid whether or
 *                not anything is drawn -- which is exactly the shape of the
 *                result we are chasing. Reported `instances` drops to 0 by
 *                design, since that counter is maintained inside the method.
 *
 * `fissures` is deliberately absent: `IceAbility` never spawns one, so the mode
 * the plan sketched would have measured nothing.
 */
type Suppress =
  | 'particles'
  | 'mist'
  | 'shards'
  | 'glitter'
  | 'decals'
  | 'bursts'
  | 'sim';

/** Particle systems that can be silenced one at a time by shadowing `emit`. */
const PARTICLE_SYSTEMS = ['mist', 'shards', 'glitter'] as const;

/**
 * Step 5: multipliers on the mist's own settings, applied on top of CURRENT.
 * Crystals stay visible, so each result is the real player-facing cost and is
 * compared against CURRENT, not HIDDEN_ICE_MAT.
 *
 * Fill-rate test: `MIST_HALF_SIZE` (quarter the sprite area) vs
 * `MIST_QUARTER_RATE` (quarter the sprite count) remove the same amount of
 * fill. If both recover similar time, the cost is overdraw. If only the count
 * change helps, it is per-particle CPU/upload cost instead.
 */
interface MistTune {
  rate?: number;
  size?: number;
  life?: number;
  endSize?: number;
  /**
   * The one-off burst of 90 large puffs (`IceAbility.js` ~line 712: size 1.6,
   * life `mistLifetime * 1.5`). Hardcoded there, so it is intercepted at
   * `mist.emit` rather than through settings; `mistRate` never touches it.
   */
  burstCount?: number;
  burstSize?: number;
  burstLife?: number;
}

interface ModeSpec {
  mist?: MistTune;
  /** Are the crystal meshes drawn? */
  visible: boolean;
  material: MaterialKey | null;
  isolates: string;
  suppress?: Suppress[];
}

/**
 * Step 2 of the breakdown: visibility and material are now **independent axes**.
 *
 * Run 1 conflated them. `CRYSTALS_HIDDEN` hid the meshes *and* left the ice
 * material assigned, while `SIMPLE_OPAQUE` drew them *and* swapped the material
 * -- so the two could not be compared, and the result was backwards: drawing
 * cheap crystals (34.6 ms) beat drawing none (46.9 ms).
 *
 * `HIDDEN_ICE_MAT` and `HIDDEN_SIMPLE_MAT` differ only in the material assigned
 * to meshes that are never drawn, which makes the pair a clean test:
 *
 *   both ~47 ms  -> run 1's SIMPLE_* numbers were an artefact; re-run them
 *   ~47 vs ~34   -> the ice material costs ~12 ms/frame **while invisible**,
 *                   which is a CPU/upload cost and a bug in its own right
 */
const MODE_SPECS: Record<ModeName, ModeSpec> = {
  NO_CAST: {
    visible: false,
    material: null,
    isolates: 'floor: no ability at all, in-session reference',
  },
  HIDDEN_ICE_MAT: {
    visible: false,
    material: null,
    isolates: 'not drawn, ice material assigned (run 1 CRYSTALS_HIDDEN)',
  },
  HIDDEN_SIMPLE_MAT: {
    visible: false,
    material: 'SIMPLE_OPAQUE',
    isolates: 'not drawn, cheap material assigned -> pairs with HIDDEN_ICE_MAT',
  },
  CURRENT: {
    visible: true,
    material: null,
    isolates: 'baseline: custom ice shader + transparent + DoubleSide',
  },
  SIMPLE_OPAQUE: {
    visible: true,
    material: 'SIMPLE_OPAQUE',
    isolates: 'cheapest possible fragment, no blend, no lighting',
  },
  SIMPLE_TRANSPARENT: {
    visible: true,
    material: 'SIMPLE_TRANSPARENT',
    isolates: 'SIMPLE_OPAQUE + blending -> isolates overdraw',
  },
  STANDARD_OPAQUE: {
    visible: true,
    material: 'STANDARD_OPAQUE',
    isolates: 'stock PBR, opaque -> isolates normal lighting cost',
  },
  ICE_OPAQUE: {
    visible: true,
    material: 'ICE_OPAQUE',
    isolates: 'full ice shader, opaque -> isolates custom shader cost',
  },
  ICE_SINGLE_SIDE: {
    visible: true,
    material: 'ICE_SINGLE_SIDE',
    isolates: 'CURRENT but FrontSide -> isolates double-sided fragments',
  },

  // --- Step 3: crystals hidden throughout, one subsystem removed at a time.
  // Compare each against HIDDEN_ICE_MAT, which is the same cast with nothing
  // suppressed.
  NO_PARTICLES: {
    visible: false,
    material: null,
    isolates: 'hidden + no particle emission',
    suppress: ['particles'],
  },
  NO_MIST: {
    visible: false,
    material: null,
    isolates: 'hidden + no mist emission (ice.mist only)',
    suppress: ['mist'],
  },
  NO_SHARDS: {
    visible: false,
    material: null,
    isolates: 'hidden + no shard emission (ice.shards only)',
    suppress: ['shards'],
  },
  NO_GLITTER: {
    visible: false,
    material: null,
    isolates: 'hidden + no glitter emission (ice.glitter only)',
    suppress: ['glitter'],
  },
  MIST_QUARTER_RATE: {
    visible: true,
    material: null,
    isolates: 'CURRENT with mist emission rate x0.25 (quarter the sprites)',
    mist: { rate: 0.25 },
  },
  MIST_HALF_LIFE: {
    visible: true,
    material: null,
    isolates: 'CURRENT with mist lifetime x0.5 (half the live sprites)',
    mist: { life: 0.5 },
  },
  MIST_LIFE_70: {
    visible: true,
    material: null,
    isolates: 'CURRENT with mist lifetime x0.7 (lifetime sweep)',
    mist: { life: 0.7 },
  },
  MIST_LIFE_85: {
    visible: true,
    material: null,
    isolates: 'CURRENT with mist lifetime x0.85 (lifetime sweep)',
    mist: { life: 0.85 },
  },
  MIST_HALF_SIZE: {
    visible: true,
    material: null,
    isolates: 'CURRENT with mist size x0.5 (quarter the sprite area)',
    mist: { size: 0.5 },
  },
  MIST_SMALL_END: {
    visible: true,
    material: null,
    isolates: 'CURRENT with mist end size x0.5 (stops growing to 3.4x)',
    mist: { endSize: 0.5 },
  },
  MIST_LEAN: {
    visible: true,
    material: null,
    isolates: 'CURRENT with rate x0.5, life x0.7, size x0.7, end size x0.6 combined',
    mist: { rate: 0.5, life: 0.7, size: 0.7, endSize: 0.6 },
  },
  BURST_NONE: {
    visible: true,
    material: null,
    isolates: 'CURRENT with the 90-puff burst removed (upper bound for burst fixes)',
    mist: { burstCount: 0 },
  },
  BURST_THIRD_COUNT: {
    visible: true,
    material: null,
    isolates: 'CURRENT with the burst at 30 puffs instead of 90',
    mist: { burstCount: 1 / 3 },
  },
  BURST_HALF_SIZE: {
    visible: true,
    material: null,
    isolates: 'CURRENT with burst puffs at size 0.8 instead of 1.6',
    mist: { burstSize: 0.5 },
  },
  BURST_HALF_LIFE: {
    visible: true,
    material: null,
    isolates: 'CURRENT with burst life x0.75 instead of x1.5 mistLifetime',
    mist: { burstLife: 0.5 },
  },
  NO_DECALS: {
    visible: false,
    material: null,
    isolates: 'hidden + no ground decals',
    suppress: ['decals'],
  },
  NO_BURSTS: {
    visible: false,
    material: null,
    isolates: 'hidden + no burst spheres',
    suppress: ['bursts'],
  },
  NO_SIM: {
    visible: false,
    material: null,
    isolates: 'hidden + no _updateSpikes (190 matrices + attribute upload)',
    suppress: ['sim'],
  },
  NO_ANYTHING: {
    visible: false,
    material: null,
    isolates: 'hidden + all of the above -> what remains is unaccounted',
    suppress: ['particles', 'decals', 'bursts', 'sim'],
  },
};

/**
 * Trimmed list for the mist investigation: V5 ran 22 modes for ~10 minutes and
 * the headset degraded partway through (CURRENT 38 -> 78 ms). Set to `null` to
 * run every mode.
 */
const RUN_ONLY: ModeName[] | null = [
  'NO_CAST',
  'CURRENT',
  'MIST_HALF_LIFE',
  'MIST_LIFE_70',
  'MIST_LIFE_85',
  'MIST_QUARTER_RATE', // re-check: V5 said it barely helps, V6 says lifetime fixes all
  'NO_ANYTHING',
];

const MODES: ModeName[] =
  RUN_ONLY ?? (Object.keys(MODE_SPECS) as ModeName[]);

interface Result {
  mode: ModeName;
  rep: number;
  median: number;
  p95: number;
  fps: number;
  /** Mean frame time -- unlike the median, it does not hide hitches. */
  mean: number;
  /** Percent of frames over SLOW_MS. The stutter signal. */
  slowPct: number;
  calls: number;
  instances: number;
}

/**
 * Controlled crystal-rendering benchmark.
 *
 * The rule from the brief: **same cast, same crystal count, same positions, same
 * camera -- only the crystal material changes.** Two things enforce that:
 *
 *  - `Math.random` is replaced with a seeded LCG, reset to the same seed before
 *    every cast, so each mode erupts a byte-identical field. Without this the
 *    per-cast dice would move crystals between modes and the comparison would be
 *    measuring luck.
 *  - `CastSystem`'s own debug trigger is suspended; this system owns casting for
 *    the duration, with fixed origin, direction and distance.
 *
 * Crystal *count* is deliberately not reduced. Cutting it would improve the
 * numbers without explaining them.
 *
 * Step 2 adds the HIDDEN_ICE_MAT / HIDDEN_SIMPLE_MAT pair; see MODE_SPECS.
 *
 * Every mode is preceded by a full teardown (`CastSystem.clearAll()`) and a
 * settle window with an empty scene, so no mode inherits the previous one's
 * leftovers. The drained state is logged before each measurement.
 */
export class CrystalBench extends createSystem({}) {
  private cast?: CastSystem;
  private materials = new Map<MaterialKey, Material>();
  private results: Result[] = [];

  private modeIndex = -1;
  /** -1 is a discarded warm-up pass: shaders compile, caches fill, results dropped. */
  private rep = -1;
  private phase: 'idle' | 'settle' | 'warmup' | 'measure' | 'look' | 'done' = 'idle';
  private phaseTime = 0;

  /** Every phase change is logged so the console shows exactly where each mode's window starts and ends. */
  private setPhase(phase: 'settle' | 'warmup' | 'measure' | 'look' | 'done'): void {
    this.phase = phase;
    this.phaseTime = 0;
    const mode = MODES[this.modeIndex];
    const step = (this.rep + 1) * MODES.length + this.modeIndex + 1;
    const total = (REPEATS + 1) * MODES.length;
    this.drawBadge(phase, mode, step, total);
    (globalThis as { __benchStatus?: unknown }).__benchStatus = {
      phase,
      mode,
      rep: this.rep + 1,
      step,
      total,
    };
    if (phase !== 'done') {
      console.log(
        '[bench] ## ' + phase.toUpperCase() + ' ' + mode +
          ' (' + this.repLabel() + ', ' + step + '/' + total + ')',
      );
    }
  }
  /* Head-locked status badge. Redrawn only on a phase change, never per frame.
   * It adds one constant draw call to every mode, so relative results hold. */
  private badgeCtx?: CanvasRenderingContext2D;
  private badgeTex?: CanvasTexture;
  private badge?: Mesh;

  private static readonly PHASE_COLOR = {
    settle: '#c2410c',
    warmup: '#a16207',
    measure: '#15803d',
    look: '#7e22ce',
    done: '#1d4ed8',
  } as const;

  private buildBadge(): void {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    this.badgeCtx = canvas.getContext('2d')!;
    this.badgeTex = new CanvasTexture(canvas);
    const material = new MeshBasicMaterial({
      map: this.badgeTex,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.badge = new Mesh(new PlaneGeometry(0.2, 0.1), material);
    this.badge.renderOrder = 9999;
    this.badge.frustumCulled = false;
    this.badge.position.set(0, -0.16, -0.6);
    this.player.head.add(this.badge);
    this.cleanupFuncs.push(() => {
      this.badge?.removeFromParent();
      this.badge?.geometry.dispose();
      material.dispose();
      this.badgeTex?.dispose();
    });
  }

  private drawBadge(
    phase: 'settle' | 'warmup' | 'measure' | 'look' | 'done',
    mode: string,
    step: number,
    total: number,
  ): void {
    const ctx = this.badgeCtx;
    if (!ctx || !this.badgeTex) return;
    ctx.fillStyle = CrystalBench.PHASE_COLOR[phase];
    ctx.fillRect(0, 0, 512, 256);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    if (phase === 'done') {
      ctx.font = 'bold 120px sans-serif';
      ctx.fillText('DONE', 256, 150);
    } else {
      ctx.font = 'bold 60px sans-serif';
      ctx.fillText(
        this.rep < 0 ? 'WARM-UP' : 'REP ' + (this.rep + 1) + '/' + REPEATS,
        256,
        62,
      );
      ctx.font = 'bold 52px sans-serif';
      ctx.fillText(phase.toUpperCase(), 256, 120);
      this.fitText(mode + '  ' + step + '/' + total, 256, 172, 38);
      // The actual setting, so 0.5 / 0.7 / 0.85 can be told apart by eye.
      this.fitText(this.tuneLabel(MODES[this.modeIndex]), 256, 226, 42);
    }
    this.badgeTex.needsUpdate = true;
  }

  /** Human-readable setting for the current mode, e.g. `mist lifetime x0.7`. */
  private tuneLabel(mode: ModeName): string {
    const parts: string[] = [];
    const t = MODE_SPECS[mode].mist;
    if (t) {
      if (t.rate !== undefined) parts.push('rate x' + +t.rate.toFixed(2));
      if (t.life !== undefined) parts.push('life x' + +t.life.toFixed(2));
      if (t.size !== undefined) parts.push('size x' + +t.size.toFixed(2));
      if (t.endSize !== undefined) parts.push('end x' + +t.endSize.toFixed(2));
      if (t.burstCount !== undefined) parts.push('burst n x' + +t.burstCount.toFixed(2));
      if (t.burstSize !== undefined) parts.push('burst size x' + +t.burstSize.toFixed(2));
      if (t.burstLife !== undefined) parts.push('burst life x' + +t.burstLife.toFixed(2));
    }
    if (parts.length) return parts.join(', ');
    return MODE_SPECS[mode].suppress ? 'removed: ' + MODE_SPECS[mode].suppress.join('+') : 'unchanged';
  }

  /** Draws centred text, shrinking the font until it fits the 512 px badge. */
  private fitText(text: string, x: number, y: number, size: number): void {
    const ctx = this.badgeCtx!;
    let px = size;
    ctx.font = 'bold ' + px + 'px sans-serif';
    while (ctx.measureText(text).width > 490 && px > 18) {
      px -= 2;
      ctx.font = 'bold ' + px + 'px sans-serif';
    }
    ctx.fillText(text, x, y);
  }

  private repLabel(): string {
    return this.rep < 0 ? 'WARM-UP PASS' : 'rep' + (this.rep + 1);
  }

  private samples!: Float32Array;
  private sorted!: Float32Array;
  private count = 0;
  private frames = 0;

  private origin!: Vector3;

  /** Saved originals, restored at the end of every mode. */
  private savedDecals: unknown = null;
  private savedBursts: unknown = null;
  private savedParticleCount = 1;
  private savedEmissionRate = 1;
  private simSuppressed = false;
  private emitStubbed = false;
  private mistBase?: { rate: number; size: number; life: number };
  private endSizeBase?: number;
  private realRandom?: () => number;
  private seed = 0;

  init(): void {
    if (!BENCH_ENABLED) return;

    this.origin = new Vector3();
    this.samples = new Float32Array(4096);
    this.sorted = new Float32Array(4096);
    this.cast = this.world.getSystem(CastSystem);
    if (!this.cast) return;

    this.buildBadge();
    if (BENCH_MODE === 'live') {
      this.initLive();
      return;
    }

    this.cast.benchControlled = true;
    this.installSeededRandom();
    this.buildMaterials();

    console.log(
      '[bench] crystal rendering benchmark: ' +
        MODES.length +
        ' modes x (' +
        WARMUP_SECONDS +
        's warmup + ' +
        MEASURE_SECONDS +
        's measure)',
    );
    this.nextMode();

    this.cleanupFuncs.push(() => {
      this.restoreRandom();
      this.restoreSuppression();
    });
  }

  /* ---------------------------------------------------------------- */

  /**
   * Deterministic LCG in place of `Math.random`, so every mode gets the same
   * field. Restored on teardown.
   */
  private installSeededRandom(): void {
    this.realRandom = Math.random;
    Math.random = () => {
      this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
      return this.seed / 4294967296;
    };
  }

  private restoreRandom(): void {
    if (this.realRandom) Math.random = this.realRandom;
  }

  private buildMaterials(): void {
    const environment = {
      registerShadowCasterWithPatch: (m: never, p: never) =>
        patchOnBeforeCompile(m, p),
    };

    this.materials.set(
      'SIMPLE_OPAQUE',
      new MeshBasicMaterial({ color: 0x9fd8ff }),
    );
    this.materials.set(
      'SIMPLE_TRANSPARENT',
      new MeshBasicMaterial({
        color: 0x9fd8ff,
        transparent: true,
        opacity: 0.92,
        depthWrite: true,
      }),
    );
    this.materials.set(
      'STANDARD_OPAQUE',
      new MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.16,
        metalness: 0,
        flatShading: true,
      }),
    );

    const iceOpaque = createIceMaterial(environment);
    iceOpaque.transparent = false;
    iceOpaque.side = DoubleSide;
    this.materials.set('ICE_OPAQUE', iceOpaque);

    const iceSingle = createIceMaterial(environment);
    iceSingle.transparent = true;
    iceSingle.side = FrontSide;
    this.materials.set('ICE_SINGLE_SIDE', iceSingle);
  }

  /** Every ice instance: the ones in flight and the ones parked in the pool. */
  private forEachIceInstance(
    fn: (a: { meshes: Array<{ material: Material }>; material: Material }) => void,
  ): void {
    const manager = this.cast!.abilities as unknown as {
      active: unknown[];
      pools: Map<string, { free: unknown[] }>;
    };
    for (const a of manager.active) fn(a as never);
    const pool = manager.pools.get('ice');
    if (pool) for (const a of pool.free) fn(a as never);
  }

  /**
   * Undo every suppression. Always run before applying the next mode's, so a
   * mode can never inherit the previous one's stubs.
   */
  private restoreSuppression(): void {
    if (this.savedDecals) {
      this.cast!.ctx.decals = this.savedDecals;
      this.savedDecals = null;
    }
    if (this.savedBursts) {
      this.cast!.ctx.bursts = this.savedBursts;
      this.savedBursts = null;
    }
    settings.global.particleCount = this.savedParticleCount;
    settings.global.emissionRate = this.savedEmissionRate;
    if (this.simSuppressed) {
      this.forEachIceInstance((ability) => {
        delete (ability as unknown as Record<string, unknown>)._updateSpikes;
      });
      this.simSuppressed = false;
    }
    if (this.frostBase) {
      settings.ice.frostRate = this.frostBase.rate;
      settings.ice.frostLife = this.frostBase.life;
      settings.ice.frostSpread = this.frostBase.spread;
    }
    if (this.mistBase) {
      settings.ice.mistRate = this.mistBase.rate;
      settings.ice.mistSize = this.mistBase.size;
      settings.ice.mistLifetime = this.mistBase.life;
    }
    if (this.endSizeBase !== undefined) this.setMistEndSize(1);
    if (this.emitStubbed) {
      this.forEachIceInstance((ability) => {
        for (const key of PARTICLE_SYSTEMS) {
          const system = (ability as unknown as Record<string, object | undefined>)[key];
          if (system) delete (system as Record<string, unknown>).emit;
        }
      });
      this.emitStubbed = false;
    }
  }

  /** Scales the mist's `uEndSize` from its original value; `1` restores it. */
  private setMistEndSize(mult: number): void {
    this.forEachIceInstance((ability) => {
      const mist = (ability as unknown as {
        mist?: { uniforms: { uEndSize: { value: number } } };
      }).mist;
      if (!mist) return;
      if (this.endSizeBase === undefined) {
        this.endSizeBase = mist.uniforms.uEndSize.value;
      }
      mist.uniforms.uEndSize.value = this.endSizeBase * mult;
    });
  }

  /**
   * Wraps `mist.emit` so the burst call (identified by its unique size 1.6) is
   * scaled. `_emit` is a shared mutable object, so it is restored after the call.
   */
  private wrapBurstEmit(tune: MistTune): void {
    this.forEachIceInstance((ability) => {
      const mist = (ability as unknown as Record<string, unknown>).mist as
        | {
            emit: (count: number, p: { size: number; life: number }) => void;
          }
        | undefined;
      if (!mist) return;
      const original = Object.getPrototypeOf(mist).emit as (
        this: unknown,
        count: number,
        p: { size: number; life: number },
      ) => void;
      (mist as Record<string, unknown>).emit = (
        count: number,
        p: { size: number; life: number },
      ) => {
        if (Math.abs(p.size - 1.6) > 1e-6) {
          original.call(mist, count, p);
          return;
        }
        const size = p.size;
        const life = p.life;
        p.size = size * (tune.burstSize ?? 1);
        p.life = life * (tune.burstLife ?? 1);
        original.call(mist, Math.round(count * (tune.burstCount ?? 1)), p);
        p.size = size;
        p.life = life;
      };
    });
    this.emitStubbed = true;
  }

  private applyMistTune(mode: ModeName): void {
    const tune = MODE_SPECS[mode].mist;
    if (!tune) return;
    const base = (this.mistBase ??= {
      rate: settings.ice.mistRate,
      size: settings.ice.mistSize,
      life: settings.ice.mistLifetime,
    });
    settings.ice.mistRate = base.rate * (tune.rate ?? 1);
    settings.ice.mistSize = base.size * (tune.size ?? 1);
    settings.ice.mistLifetime = base.life * (tune.life ?? 1);
    if (tune.endSize !== undefined) this.setMistEndSize(tune.endSize);
    this.wrapBurstIfNeeded(tune);
  }

  private wrapBurstIfNeeded(tune: MistTune): void {
    if (
      tune.burstCount !== undefined ||
      tune.burstSize !== undefined ||
      tune.burstLife !== undefined
    ) {
      this.wrapBurstEmit(tune);
    }
  }

  /**
   * Own-property no-ops that shadow prototype methods, so `delete` restores them.
   * Re-run after every cast: the pool may hand back a fresh instance.
   */
  private stubInstances(list: Suppress[]): void {
    const systems = PARTICLE_SYSTEMS.filter((k) => list.includes(k));
    if (systems.length) {
      this.forEachIceInstance((ability) => {
        for (const key of systems) {
          const system = (ability as unknown as Record<string, object | undefined>)[key];
          if (system) (system as Record<string, unknown>).emit = () => {};
        }
      });
      this.emitStubbed = true;
    }
    if (list.includes('sim')) {
      this.forEachIceInstance((ability) => {
        (ability as unknown as Record<string, unknown>)._updateSpikes = () => {};
      });
      this.simSuppressed = true;
    }
  }

  private applySuppression(mode: ModeName): void {
    const list = MODE_SPECS[mode].suppress;
    if (!list) return;

    for (const what of list) {
      if (what === 'particles') {
        this.savedParticleCount = settings.global.particleCount;
        this.savedEmissionRate = settings.global.emissionRate;
        settings.global.particleCount = 0;
        settings.global.emissionRate = 0;
      } else if (what === 'decals') {
        this.savedDecals = this.cast!.ctx.decals;
        this.cast!.ctx.decals = { spawn: () => {} };
      } else if (what === 'bursts') {
        this.savedBursts = this.cast!.ctx.bursts;
        this.cast!.ctx.bursts = { spawn: () => {} };
      }
    }
    this.stubInstances(list);
  }

  private applyMode(mode: ModeName): void {
    const spec = MODE_SPECS[mode];
    this.forEachIceInstance((ability) => {
      const material =
        spec.material === null
          ? (ability.material as Material)
          : this.materials.get(spec.material)!;
      for (const mesh of ability.meshes) {
        mesh.material = material;
        (mesh as unknown as { visible: boolean }).visible = spec.visible;
      }
    });
  }

  private fireCast(): void {
    this.cast!.abilities.clear();
    if (MODES[this.modeIndex] === 'NO_CAST') return;
    // Same seed before every cast -> identical field in every mode.
    this.seed = 0x1234567;
    this.player.getWorldPosition(this.origin);
    this.origin.y = 0;
    this.cast!.cast(this.origin, CAST_DIRECTION, CAST_DISTANCE);
    // The pool may have grown a fresh instance on that cast; re-apply both axes.
    this.applyMode(MODES[this.modeIndex]);
    const suppress = MODE_SPECS[MODES[this.modeIndex]].suppress;
    if (suppress) this.stubInstances(suppress);
    // A pooled instance may have been rebuilt; the uniform must be re-scaled.
    const endSize = MODE_SPECS[MODES[this.modeIndex]].mist?.endSize;
    if (endSize !== undefined) this.setMistEndSize(endSize);
    const tune = MODE_SPECS[MODES[this.modeIndex]].mist;
    if (tune) this.wrapBurstIfNeeded(tune);
  }

  private nextMode(): void {
    this.modeIndex++;
    if (this.modeIndex >= MODES.length) {
      // Interleaved: finish a full pass over every mode before repeating.
      this.modeIndex = 0;
      this.rep++;
      if (this.rep >= REPEATS) {
        this.finish();
        return;
      }
    }
    const mode = MODES[this.modeIndex];
    console.log(
      '[bench] ' + this.repLabel() + ' --> ' + mode +
        '  (' + MODE_SPECS[mode].isolates + ')',
    );

    // Clean slate. Nothing from the previous mode may survive into this one --
    // neither its effects nor its suppressions.
    this.restoreSuppression();
    this.cast!.clearAll();
    this.applyMode(mode);
    this.applySuppression(mode);
    this.applyMistTune(mode);
    this.setPhase('settle');
    this.count = 0;
    this.frames = 0;
  }

  /** Logged at the end of every settle, so a failed drain is visible, not silent. */
  private reportDrain(mode: ModeName): void {
    const active = this.cast!.abilities.active.length;
    const particles = this.cast!.liveParticles();
    const calls = this.renderer.info.render.calls;
    const clean = active === 0 && particles === 0;
    console.log(
      '[bench] settled ' + mode + ' -> abilities=' + active +
        ' particles=' + particles + ' calls=' + calls +
        (clean ? ' CLEAN' : ' *** NOT CLEAN ***'),
    );
  }

  update(delta: number): void {
    if (BENCH_MODE === 'live') {
      this.liveUpdate(delta);
      return;
    }
    if (this.phase === 'idle' || this.phase === 'done') return;

    const mode = MODES[this.modeIndex];
    this.phaseTime += delta;

    // Empty scene, nothing cast, nothing re-fired: let the previous mode drain.
    if (this.phase === 'settle') {
      if (this.phaseTime >= SETTLE_SECONDS) {
        this.reportDrain(mode);
        this.fireCast();
        this.setPhase('warmup');
      }
      return;
    }

    // Keep exactly one field standing for the rest of the window.
    if (mode !== 'NO_CAST' && this.cast!.abilities.active.length === 0) {
      this.fireCast();
    }

    if (this.phase === 'warmup') {
      if (this.phaseTime >= WARMUP_SECONDS) {
        this.setPhase('measure');
      }
      return;
    }

    if (this.phase === 'look') {
      if (this.phaseTime >= LOOK_SECONDS) this.nextMode();
      return;
    }

    if (this.count < this.samples.length) {
      this.samples[this.count++] = delta * 1000;
    }
    this.frames++;

    if (this.phaseTime >= MEASURE_SECONDS) {
      this.record();
      if (this.rep === 0 && mode !== 'NO_CAST') this.setPhase('look');
      else this.nextMode();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Live probe                                                       */
  /* ---------------------------------------------------------------- */

  private liveDone = false;
  private liveWindow = 0;
  private liveTime = 0;
  private liveLogTime = 0;
  private liveCastSum = 0;
  private liveIdleSum = 0;
  private liveCastFrames = 0;
  private liveSlow = 0;
  private liveWorst = 0;
  private liveSum = 0;
  private liveCount = 0;
  private liveWin!: Float32Array;
  private subCount = 0;
  private subSum = 0;
  private subWorst = 0;
  private liveLastActive: unknown = null;
  private liveNextCast = 0;
  private liveSinceCast = 0;
  private liveAgeSum = new Float64Array(LIVE_AGE_BINS);
  private liveAgeCount = new Float64Array(LIVE_AGE_BINS);
  private frostBase?: { rate: number; life: number; spread: number };
  private liveResults: Array<{
    name: string;
    age: number[];
    mean: number;
    p95: number;
    slowPct: number;
    worst: number;
    castMean: number;
    idleMean: number;
  }> = [];
  private liveHead!: Vector3;
  private liveDir!: Vector3;

  private liveCond(): LiveCondition {
    const n = LIVE_CONDITIONS.length;
    const w = this.liveWindow;
    return w < n ? LIVE_CONDITIONS[w] : LIVE_CONDITIONS[2 * n - 1 - w];
  }

  private initLive(): void {
    this.liveWin = new Float32Array(8192);
    this.liveHead = new Vector3();
    this.liveDir = new Vector3();
    this.frostBase = {
      rate: settings.ice.frostRate,
      life: settings.ice.frostLife,
      spread: settings.ice.frostSpread,
    };
    this.cleanupFuncs.push(() => {
      this.restoreSuppression();
      if (this.cast) this.cast.benchControlled = false;
    });
    console.log(
      '[live] fixed-schedule probe: ' + LIVE_CONDITIONS.length * 2 + ' windows x ' +
        LIVE_WINDOW_SECONDS + 's (first ' + LIVE_SKIP_SECONDS +
        's of each discarded). Move and look around normally.',
    );
    this.beginLiveWindow();
  }

  /** Tear down the previous condition, then apply this window's. */
  private beginLiveWindow(): void {
    const cond = this.liveCond();
    this.restoreSuppression();
    this.cast!.clearAll();
    // The probe owns casting in every window so the schedule is identical.
    this.cast!.benchControlled = true;
    this.liveNextCast = 0;
    this.liveSinceCast = 0;
    this.liveAgeSum.fill(0);
    this.liveAgeCount.fill(0);
    this.liveLastActive = null;
    this.liveApply(cond);

    this.liveTime = 0;
    this.liveLogTime = 0;
    this.liveCount = 0;
    this.liveSum = 0;
    this.liveSlow = 0;
    this.liveWorst = 0;
    this.liveCastFrames = 0;
    this.liveCastSum = 0;
    this.liveIdleSum = 0;
    this.subCount = 0;
    this.subSum = 0;
    this.subWorst = 0;
    this.setLivePhase('measure', cond.name);
    console.log(
      '[live] ## WINDOW ' + (this.liveWindow + 1) + '/' + LIVE_CONDITIONS.length * 2 +
        ' ' + cond.name,
    );
    this.drawLiveBadge(11.1);
  }

  /**
   * Applies the condition to every ice instance. Called at window start and
   * again whenever the game activates a new ability (pooled instances change).
   */
  private liveApply(cond: LiveCondition): void {
    this.forEachIceInstance((ability) => {
      for (const mesh of (ability as unknown as { meshes: Array<{ visible: boolean }> }).meshes) {
        mesh.visible = cond.visible;
      }
    });
    if (cond.frost && this.frostBase) {
      settings.ice.frostRate = this.frostBase.rate * (cond.frost.rate ?? 1);
      settings.ice.frostLife = this.frostBase.life * (cond.frost.life ?? 1);
      settings.ice.frostSpread = this.frostBase.spread * (cond.frost.spread ?? 1);
    }
    const list = cond.suppress;
    if (list.includes('particles')) {
      this.savedParticleCount = settings.global.particleCount;
      this.savedEmissionRate = settings.global.emissionRate;
      settings.global.particleCount = 0;
      settings.global.emissionRate = 0;
    }
    if (list.includes('decals') && !this.savedDecals) {
      this.savedDecals = this.cast!.ctx.decals;
      this.cast!.ctx.decals = { spawn: () => {} };
    }
    if (list.includes('bursts') && !this.savedBursts) {
      this.savedBursts = this.cast!.ctx.bursts;
      this.cast!.ctx.bursts = { spawn: () => {} };
    }
    this.stubInstances(list);
  }

  private setLivePhase(phase: 'measure' | 'done', name: string): void {
    (globalThis as { __benchStatus?: unknown }).__benchStatus = {
      live: true,
      phase,
      condition: name,
      window: this.liveWindow + 1,
    };
  }

  private liveUpdate(delta: number): void {
    if (this.liveDone) return;
    const ms = delta * 1000;
    if (this.liveTime >= this.liveNextCast) {
      this.liveNextCast += LIVE_CAST_INTERVAL;
      if (this.liveCond().casts) {
        this.liveSinceCast = 0;
        this.player.getWorldPosition(this.origin);
        this.origin.y = 0;
        this.cast!.cast(this.origin, CAST_DIRECTION, CAST_DISTANCE);
        // A new cast may be a fresh pooled instance beside a still-living one.
        this.liveApply(this.liveCond());
      }
    }
    const active = this.cast!.abilities.active as unknown[];
    const casting = active.length > 0;

    // A new ability may be a fresh pooled instance: re-apply the condition.
    const first = casting ? active[0] : null;
    if (first !== this.liveLastActive) {
      this.liveLastActive = first;
      if (first) this.liveApply(this.liveCond());
    }

    this.liveTime += delta;
    this.liveLogTime += delta;
    this.liveSinceCast += delta;

    if (this.liveCond().casts) {
      const bin = Math.min(LIVE_AGE_BINS - 1, Math.floor(this.liveSinceCast / 2));
      this.liveAgeSum[bin] += ms;
      this.liveAgeCount[bin]++;
    }

    if (this.liveTime >= LIVE_SKIP_SECONDS) {
      if (this.liveCount < this.liveWin.length) this.liveWin[this.liveCount++] = ms;
      this.liveSum += ms;
      if (ms > SLOW_MS) this.liveSlow++;
      if (ms > this.liveWorst) this.liveWorst = ms;
      if (casting) {
        this.liveCastFrames++;
        this.liveCastSum += ms;
      } else {
        this.liveIdleSum += ms;
      }
    }
    this.subCount++;
    this.subSum += ms;
    if (ms > this.subWorst) this.subWorst = ms;

    if (this.liveLogTime >= LIVE_LOG_SECONDS) {
      const mean = this.subSum / this.subCount;
      this.player.head.getWorldPosition(this.liveHead);
      this.player.head.getWorldDirection(this.liveDir);
      const yaw = (Math.atan2(this.liveDir.x, this.liveDir.z) * 180) / Math.PI;
      const pitch = (Math.asin(this.liveDir.y) * 180) / Math.PI;
      console.log(
        '[live] ' + JSON.stringify({
          w: this.liveWindow + 1,
          cond: this.liveCond().name,
          t: +this.liveTime.toFixed(1),
          scored: this.liveTime >= LIVE_SKIP_SECONDS,
          fps: +(1000 / mean).toFixed(1),
          ms: +mean.toFixed(1),
          worst: +this.subWorst.toFixed(1),
          casting,
          particles: this.cast!.liveParticles(),
          calls: this.renderer.info.render.calls,
          head: [+this.liveHead.x.toFixed(2), +this.liveHead.y.toFixed(2), +this.liveHead.z.toFixed(2)],
          yaw: +yaw.toFixed(0),
          pitch: +pitch.toFixed(0),
        }),
      );
      this.drawLiveBadge(mean);
      this.liveLogTime = 0;
      this.subCount = 0;
      this.subSum = 0;
      this.subWorst = 0;
    }

    if (this.liveTime >= LIVE_WINDOW_SECONDS) this.endLiveWindow();
  }

  private drawLiveBadge(meanMs: number): void {
    const ctx = this.badgeCtx;
    if (!ctx || !this.badgeTex) return;
    ctx.fillStyle = this.liveDone ? CrystalBench.PHASE_COLOR.done : CrystalBench.PHASE_COLOR.measure;
    ctx.fillRect(0, 0, 512, 256);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    if (this.liveDone) {
      ctx.font = 'bold 120px sans-serif';
      ctx.fillText('DONE', 256, 150);
    } else {
      ctx.font = 'bold 56px sans-serif';
      ctx.fillText('LIVE ' + (this.liveWindow + 1) + '/' + LIVE_CONDITIONS.length * 2, 256, 62);
      this.fitText(this.liveCond().name, 256, 150, 76);
      ctx.font = '42px sans-serif';
      ctx.fillText(
        Math.round(1000 / meanMs) + ' fps   ' + Math.max(0, Math.round(LIVE_WINDOW_SECONDS - this.liveTime)) + ' s left',
        256,
        216,
      );
    }
    this.badgeTex.needsUpdate = true;
  }

  private endLiveWindow(): void {
    const n = this.liveCount;
    const m = Math.min(n, this.sorted.length);
    this.sorted.set(this.liveWin.subarray(0, m));
    const view = this.sorted.subarray(0, m);
    view.sort();
    const idleFrames = n - this.liveCastFrames;
    const r = {
      name: this.liveCond().name,
      age: Array.from(this.liveAgeSum, (sum, i) =>
        this.liveAgeCount[i] ? +(sum / this.liveAgeCount[i]).toFixed(1) : 0,
      ),
      mean: +(this.liveSum / n).toFixed(2),
      p95: +view[Math.floor(m * 0.95)].toFixed(2),
      slowPct: +((this.liveSlow / n) * 100).toFixed(1),
      worst: +this.liveWorst.toFixed(1),
      castMean: this.liveCastFrames ? +(this.liveCastSum / this.liveCastFrames).toFixed(2) : 0,
      idleMean: idleFrames ? +(this.liveIdleSum / idleFrames).toFixed(2) : 0,
    };
    this.liveResults.push(r);
    console.log('[live] WINDOW RESULT ' + JSON.stringify(r));

    this.liveWindow++;
    if (this.liveWindow >= LIVE_CONDITIONS.length * 2) {
      this.liveDone = true;
      this.restoreSuppression();
      this.cast!.clearAll();
      this.cast!.benchControlled = false;
      const base = LIVE_CONDITIONS[0].name;
      const avg = (rs: typeof this.liveResults, k: 'mean' | 'p95' | 'slowPct' | 'castMean' | 'idleMean') =>
        +(rs.reduce((a, x) => a + x[k], 0) / rs.length).toFixed(2);
      const rows = LIVE_CONDITIONS.map((c) => {
        const rs = this.liveResults.filter((x) => x.name === c.name);
        return {
          name: c.name,
          mean: avg(rs, 'mean'),
          p95: avg(rs, 'p95'),
          slowPct: avg(rs, 'slowPct'),
          castMean: avg(rs, 'castMean'),
          idleMean: avg(rs, 'idleMean'),
          age: [0, 1, 2].map((i) =>
            +(rs.reduce((a, x) => a + x.age[i], 0) / rs.length).toFixed(1),
          ),
          worst: Math.max(...rs.map((x) => x.worst)),
          windows: rs.map((x) => x.mean),
        };
      });
      const baseMean = rows.find((x) => x.name === base)!.mean;
      for (const row of rows) {
        Object.assign(row, { vsCurrent: +(row.mean - baseMean).toFixed(2) });
      }
      (globalThis as { __bench?: unknown }).__bench = rows;
      console.log('[live] RESULTS ' + JSON.stringify(rows));
      this.setLivePhase('done', 'done');
      this.drawLiveBadge(11);
      return;
    }
    this.beginLiveWindow();
  }

  private record(): void {
    const n = this.count;
    this.sorted.set(this.samples.subarray(0, n));
    const view = this.sorted.subarray(0, n);
    view.sort();

    let instances = 0;
    for (const a of this.cast!.abilities.active as Array<{
      instanceCount: number;
    }>) {
      instances += a.instanceCount;
    }

    let sum = 0;
    let slow = 0;
    for (let i = 0; i < n; i++) {
      sum += view[i];
      if (view[i] > SLOW_MS) slow++;
    }

    const result: Result = {
      mode: MODES[this.modeIndex],
      rep: this.rep + 1,
      mean: +(sum / n).toFixed(2),
      slowPct: +((slow / n) * 100).toFixed(1),
      median: +view[Math.floor(n * 0.5)].toFixed(2),
      p95: +view[Math.floor(n * 0.95)].toFixed(2),
      fps: +(this.frames / this.phaseTime).toFixed(1),
      calls: this.renderer.info.render.calls,
      instances,
    };
    // The warm-up pass (rep -1 -> reported as rep 0) is logged but never scored.
    if (this.rep >= 0) this.results.push(result);
    console.log(
      '[bench] ' + (this.rep < 0 ? '(warm-up, discarded) ' : '') +
        JSON.stringify(result),
    );
  }

  private finish(): void {
    this.setPhase('done');
    this.restoreSuppression();
    this.cast!.clearAll();
    this.applyMode('CURRENT');
    this.restoreRandom();
    if (this.cast) this.cast.benchControlled = false;

    // Ranked on mean frame time and % slow frames, not the median: a mode that
    // is fast 80% of the time and hitches the rest has a good median and a
    // terrible experience (V3-A: CURRENT rep 3 was 11.2 ms median at 15.6 fps).
    const mid = (xs: number[]) =>
      xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];

    const rows = MODES.map((mode) => {
      const rs = this.results.filter((r) => r.mode === mode);
      const mean = rs.map((r) => r.mean);
      const slow = rs.map((r) => r.slowPct);
      return {
        mode,
        meanMs: +mid(mean).toFixed(2),
        slowPct: +mid(slow).toFixed(1),
        minMs: +Math.min(...mean).toFixed(2),
        maxMs: +Math.max(...mean).toFixed(2),
        spreadMs: +(Math.max(...mean) - Math.min(...mean)).toFixed(2),
        reps: rs.length,
      };
    });
    const base = rows.find((r) => r.mode === 'CURRENT')?.meanMs ?? 0;
    const hidden = rows.find((r) => r.mode === 'HIDDEN_ICE_MAT')?.meanMs ?? 0;
    for (const r of rows) {
      Object.assign(r, {
        vsCurrent: base ? +(r.meanMs - base).toFixed(2) : 0,
        vsHidden: hidden ? +(r.meanMs - hidden).toFixed(2) : 0,
      });
    }

    (globalThis as { __bench?: unknown }).__bench = rows;
    console.log('[bench] RESULTS ' + JSON.stringify(rows));
    console.log('[bench] done -- results also on window.__bench');
  }
}
