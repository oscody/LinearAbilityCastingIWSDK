# Ice VFX v2 experiment

The original `src/particles/ParticleSystem.js`, `src/effects/GroundDecals.js`,
`src/abilities/IceAbility.js`, and authored settings are preserved. This directory
contains independent copies of the two effect implementations, plus opt-in wiring.
Plain URLs use the original services. This is not a second application scaffold.

- `ParticleSystemV2.js`: original particle implementation with an alternative
  SMOKE mask. Two animated 2D value-noise octaves replace three 3D simplex octaves.
  Only `ice.mist` uses this copy, through `ParticleEngineV2.js`.
- `GroundDecalsV2.js`: original decal implementation with an alternative FROST
  normal. The original snow height, ragged coverage, alpha, glints, colours, patch
  radius, growth, and lifetime remain. Analytic value-noise gradients approximate
  the relief normal instead of two additional full snow-height evaluations.
- `cheapNoiseV2.glsl.js`: signed 2D value noise and its analytic gradient.
- `VfxVersion.ts`: explicit URL opt-in; no settings preset is overwritten.

These are appearance-intent approximations, not pixel-identical shader results.
Mist's noise pattern and frost's lighting detail change. Visual approval in the
headset remains required, especially for close views and moving heads.

## URLs

- `?bench=v2`: forward/reverse comparison of original shader paths, mist v2,
  frost v2, both v2, no mist/frost, and no cast. Two casts per 12-second window.
- `?bench=remaining`: forward/reverse subtraction from both-v2 to isolate the
  remaining mist, frost, shards, glitter, shockwaves, bursts, and crystals.
- `?vfx=v2&bench=off`: both-v2 with the benchmark disabled; the existing automatic
  six-second debug casting continues. Original counterpart: `?bench=off`.
- `CastSystem.setVfxV2(mist, frost)` switches shader uniforms without recompiling
  or changing simulation settings. It requires one of the v2 opt-in URLs.

Benchmark CURRENT uses the copied implementations' original shader branches;
the normal original URL still uses the entirely untouched original modules.
Tests check the copies' unchanged simulation, vertex shaders, and frost coverage.

## FPS in the headset

Both manual URLs show a head-locked readout labelled ORIGINAL or V2. The large
number is app FPS over the latest half-second; the smaller lines show the last
completed five-second average and p95/worst frame intervals in milliseconds.
Higher FPS is better; lower frame intervals are better. These are application
frames, not the headset compositor's refresh rate. Visibility changes reset the
sample so taking the headset off does not become part of the next average.

The automated benchmark shows the condition, run number, live FPS and time left.
It keeps the previous run's average FPS and p95/worst visible below the current
run. The V2 comparison ends with original and V2 averages together. A new run
shows a dash until real timing samples arrive. The display itself has a small
rendering cost; compare configurations with the same display enabled.

## Repeat on the connected Quest

Run `npx tsc --noEmit`, `node --test tests/*.test.mjs`, and `npm run build` first.
With the project open in Quest Browser and an ADB developer connection:

```sh
adb -s <quest-serial> forward tcp:9223 localabstract:chrome_devtools_remote
node scripts/quest-benchmark.mjs <unused-result-stem> --v2
node scripts/quest-benchmark.mjs <another-unused-result-stem> --remaining
```

The scripts do not configure proximity or move the headset. Keep the headset worn
or explicitly manage and restore any temporary keep-awake override. The benchmark
rejects loss of visible XR. Do not take screenshots or serialize large ECS
snapshots during scored performance windows.

Stationary tests establish repeatable comparisons, not moving-gameplay approval.
For worn validation, compare original and v2 close-up and at standing height,
turn both directions, and test two overlapping casts. Record head motion, p95,
worst, visible particles, and visual defects. Do not call this complete merely
because average frame intervals improve; the 90 Hz target is 11.1 ms.

The worn-test runner requires an explicit operator confirmation:

```sh
node scripts/quest-v2-validation.mjs <unused-baseline.json> --baseline --worn
node scripts/quest-v2-validation.mjs <unused-v2.json> --worn
```

It records three roughly 20-second scenarios (close view, turning, overlap),
head poses, full-frame mean/p95/worst, and whether substantial turning and two
active casts were actually observed. `--stationary` is a diagnostic dry run,
not a substitute for worn validation. The runner restores its profiler and
casting control in `finally`. Visual approval still needs the wearer.
