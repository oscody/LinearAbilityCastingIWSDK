/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * DEBUG ONLY -- branch `Phase_3_IceCrystalDebug`. Not for master.
 */

import {
  createSystem,
  DoubleSide,
  FrontSide,
  Material,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Vector3,
} from '@iwsdk/core';
import { CastSystem } from '../abilities/CastSystem.js';
import { settings } from '../config/settings.js';
import { createIceMaterial } from '../materials/IceMaterial.js';
import { patchOnBeforeCompile } from '../utils/shaderPatch.js';

/** Flip to false to run the app normally on this branch. */
const BENCH_ENABLED = true;

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

/** Fixed cast, identical for every mode. */
const CAST_DISTANCE = 6;
const CAST_DIRECTION = new Vector3(1, 0, 0);

type ModeName =
  | 'NO_CAST'
  | 'NO_PARTICLES'
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
type Suppress = 'particles' | 'decals' | 'bursts' | 'sim';

interface ModeSpec {
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

const MODES = Object.keys(MODE_SPECS) as ModeName[];

interface Result {
  mode: ModeName;
  rep: number;
  median: number;
  p95: number;
  fps: number;
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
  private rep = 0;
  private phase: 'idle' | 'settle' | 'warmup' | 'measure' | 'done' = 'idle';
  private phaseTime = 0;
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
  private realRandom?: () => number;
  private seed = 0;

  init(): void {
    if (!BENCH_ENABLED) return;

    this.origin = new Vector3();
    this.samples = new Float32Array(4096);
    this.sorted = new Float32Array(4096);
    this.cast = this.world.getSystem(CastSystem);
    if (!this.cast) return;

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
      } else if (what === 'sim') {
        // Own-property no-op shadows the prototype method; `delete` restores it.
        this.forEachIceInstance((ability) => {
          (ability as unknown as Record<string, unknown>)._updateSpikes =
            () => {};
        });
        this.simSuppressed = true;
      }
    }
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
    if (MODE_SPECS[MODES[this.modeIndex]].suppress?.includes('sim')) {
      this.forEachIceInstance((ability) => {
        (ability as unknown as Record<string, unknown>)._updateSpikes = () => {};
      });
    }
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
      '[bench] rep' + (this.rep + 1) + ' --> ' + mode +
        '  (' + MODE_SPECS[mode].isolates + ')',
    );

    // Clean slate. Nothing from the previous mode may survive into this one --
    // neither its effects nor its suppressions.
    this.restoreSuppression();
    this.cast!.clearAll();
    this.applyMode(mode);
    this.applySuppression(mode);
    this.phase = 'settle';
    this.phaseTime = 0;
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
    if (this.phase === 'idle' || this.phase === 'done') return;

    const mode = MODES[this.modeIndex];
    this.phaseTime += delta;

    // Empty scene, nothing cast, nothing re-fired: let the previous mode drain.
    if (this.phase === 'settle') {
      if (this.phaseTime >= SETTLE_SECONDS) {
        this.reportDrain(mode);
        this.fireCast();
        this.phase = 'warmup';
        this.phaseTime = 0;
      }
      return;
    }

    // Keep exactly one field standing for the rest of the window.
    if (mode !== 'NO_CAST' && this.cast!.abilities.active.length === 0) {
      this.fireCast();
    }

    if (this.phase === 'warmup') {
      if (this.phaseTime >= WARMUP_SECONDS) {
        this.phase = 'measure';
        this.phaseTime = 0;
      }
      return;
    }

    if (this.count < this.samples.length) {
      this.samples[this.count++] = delta * 1000;
    }
    this.frames++;

    if (this.phaseTime >= MEASURE_SECONDS) {
      this.record();
      this.nextMode();
    }
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

    const result: Result = {
      mode: MODES[this.modeIndex],
      rep: this.rep + 1,
      median: +view[Math.floor(n * 0.5)].toFixed(2),
      p95: +view[Math.floor(n * 0.95)].toFixed(2),
      fps: +(this.frames / this.phaseTime).toFixed(1),
      calls: this.renderer.info.render.calls,
      instances,
    };
    this.results.push(result);
    console.log('[bench] ' + JSON.stringify(result));
  }

  private finish(): void {
    this.phase = 'done';
    this.restoreSuppression();
    this.cast!.clearAll();
    this.applyMode('CURRENT');
    this.restoreRandom();
    if (this.cast) this.cast.benchControlled = false;

    // Median of each mode's per-repeat medians, with the spread kept visible --
    // a single number here would hide exactly the noise that made run 1 useless.
    const mid = (xs: number[]) =>
      xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];

    const rows = MODES.map((mode) => {
      const ms = this.results.filter((r) => r.mode === mode).map((r) => r.median);
      return {
        mode,
        median: +mid(ms).toFixed(2),
        min: +Math.min(...ms).toFixed(2),
        max: +Math.max(...ms).toFixed(2),
        spread: +(Math.max(...ms) - Math.min(...ms)).toFixed(2),
        reps: ms.length,
      };
    });
    const base = rows.find((r) => r.mode === 'CURRENT')?.median ?? 0;
    for (const r of rows) {
      (r as unknown as { vsCurrent: number }).vsCurrent = base
        ? +(r.median - base).toFixed(2)
        : 0;
    }

    (globalThis as { __bench?: unknown }).__bench = rows;
    console.log('[bench] RESULTS ' + JSON.stringify(rows));
    console.log('[bench] done -- results also on window.__bench');
  }
}
