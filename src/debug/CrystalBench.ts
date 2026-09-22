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
import { createIceMaterial } from '../materials/IceMaterial.js';
import { patchOnBeforeCompile } from '../utils/shaderPatch.js';

/** Flip to false to run the app normally on this branch. */
const BENCH_ENABLED = true;

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
  | 'CRYSTALS_HIDDEN'
  | 'CURRENT'
  | 'SIMPLE_OPAQUE'
  | 'SIMPLE_TRANSPARENT'
  | 'STANDARD_OPAQUE'
  | 'ICE_OPAQUE'
  | 'ICE_SINGLE_SIDE';

const MODES: ModeName[] = [
  'NO_CAST',
  'CRYSTALS_HIDDEN',
  'CURRENT',
  'SIMPLE_OPAQUE',
  'SIMPLE_TRANSPARENT',
  'STANDARD_OPAQUE',
  'ICE_OPAQUE',
  'ICE_SINGLE_SIDE',
];

const WHAT_IT_ISOLATES: Record<ModeName, string> = {
  NO_CAST: 'floor: no ability at all, in-session reference',
  CRYSTALS_HIDDEN:
    'ability simulates, crystals not drawn -> splits CPU/sim from all crystal GPU cost',
  CURRENT: 'baseline: custom ice shader + transparent + DoubleSide',
  SIMPLE_OPAQUE: 'floor: cheapest possible fragment, no blend, no lighting',
  SIMPLE_TRANSPARENT: 'SIMPLE_OPAQUE + blending -> isolates overdraw',
  STANDARD_OPAQUE: 'stock PBR, opaque -> isolates normal lighting cost',
  ICE_OPAQUE: 'full ice shader, opaque -> isolates custom shader cost',
  ICE_SINGLE_SIDE: 'CURRENT but FrontSide -> isolates double-sided fragments',
};

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
 */
export class CrystalBench extends createSystem({}) {
  private cast?: CastSystem;
  private materials = new Map<ModeName, Material>();
  private results: Result[] = [];

  private modeIndex = -1;
  private rep = 0;
  private phase: 'idle' | 'warmup' | 'measure' | 'done' = 'idle';
  private phaseTime = 0;
  private samples!: Float32Array;
  private sorted!: Float32Array;
  private count = 0;
  private frames = 0;

  private origin!: Vector3;
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

    this.cleanupFuncs.push(() => this.restoreRandom());
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

  private applyMode(mode: ModeName): void {
    const hidden = mode === 'CRYSTALS_HIDDEN' || mode === 'NO_CAST';
    this.forEachIceInstance((ability) => {
      const material =
        this.materials.get(mode) ?? (ability.material as Material);
      for (const mesh of ability.meshes) {
        mesh.material = material;
        (mesh as unknown as { visible: boolean }).visible = !hidden;
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
    // The pool may have grown a fresh instance on that cast; re-apply.
    this.applyMode(MODES[this.modeIndex]);
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
        '  (' + WHAT_IT_ISOLATES[mode] + ')',
    );
    this.applyMode(mode);
    this.fireCast();
    this.phase = 'warmup';
    this.phaseTime = 0;
    this.count = 0;
    this.frames = 0;
  }

  update(delta: number): void {
    if (this.phase === 'idle' || this.phase === 'done') return;

    // Keep exactly one field standing for the whole window.
    if (
      MODES[this.modeIndex] !== 'NO_CAST' &&
      this.cast!.abilities.active.length === 0
    ) {
      this.fireCast();
    }

    this.phaseTime += delta;

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
