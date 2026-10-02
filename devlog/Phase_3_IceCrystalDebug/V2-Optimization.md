# Ice VFX v2 — implementation and verification

Original effect implementations and authored settings remain untouched. V2 lives
under `src/v2/`; `CastSystem` selects services only when explicitly opted in.
This implements the shader experiments, not a declaration that the frame-budget
or fidelity gates have passed.

## Implementation

- Mist: two animated 2D value-noise octaves instead of three 3D simplex octaves.
  Same simulation, particle capacity/count controls, size curve, lifetime, fade,
  colours, blending, and glow. The puff's procedural noise pattern changes.
- Frost: one original snow-height evaluation for thickness/alpha, plus cheap
  analytic value-noise gradients for an approximate powder normal. Removes two
  additional complete snow-height evaluations. Keeps original coverage, radius,
  spawn rate, growth, lifetime, glints and colours. Relief lighting changes.
- Baseline: retained original branch within the copied shaders for same-session
  A/B tests; plain URLs still instantiate the untouched original classes.

## V15-A: first shader comparison on physical Quest 3

Artifacts: `Phase_3_IceCrystalDebug-V15-A.log` and `.json`.
Twelve 12-second windows, two casts per window, forward/reverse; six-second
discarded warmup. All 12 particle checks passed. Quest Browser, real visible
immersive VR, two views at 1680×1760, foveation 1. Stationary near/low head pose
approximately (0.42, 0.76, -0.46), yaw -145°, pitch -19°.

This differs from the V14 camera pose: compare against this run's own CURRENT,
not V14's 91 ms headline. No settings preset, particle count, size, lifetime,
frost footprint or glow was reduced.

| Condition | Mean interval ms | Mean of window p95s ms | Worst interval ms | Forward / reverse mean ms |
|---|---:|---:|---:|---|
| CURRENT | 64.14 | 100.10 | 101.2 | 63.04 / 65.23 |
| MIST_V2 | 34.41 | 59.15 | 99.1 | 33.96 / 34.85 |
| FROST_V2 | 59.92 | 100.10 | 100.7 | 57.62 / 62.23 |
| BOTH_V2 | 30.94 | 42.50 | 63.8 | 30.31 / 31.57 |
| NO_MIST_OR_FROST | 13.99 | 16.50 | 47.5 | 14.01 / 13.97 |
| NO_CAST | 11.11 | 11.90 | 13.0 | 11.11 / 11.11 |

Combined mean improvement: ~52%. Full CPU update-to-render span for BOTH_V2 was
3.494 / 3.439 ms. GPU timer queries remain unavailable in Quest Browser.
The p95 summary above averages the two window p95s; it is not a pooled p95.
Individual window CPU/frame mean, p95, worst and counts are in `.json.frames`.
Worst intervals are the maximum recorded across either window.

The mist change is substantial; the frost-normal approximation provides a much
smaller gain. BOTH_V2 remains far over 11.1 ms, including its tail frames.

An initial `V15.log` remained on the old `?bench=frost` suite during reload. It
was interrupted and is not V2 comparison evidence. V15-A and V16 log a startup
OfferSession cancellation around reload; their scored sessions were visible
and their particle checks passed. No shader compilation failure was observed.

## V16: remaining-cost subtraction

This run used the first, unfiltered V2 normal. See the visual correction below
for the subsequent fine-grain filtering change and its own rerun artifacts.

Artifacts: `Phase_3_IceCrystalDebug-V16.log` and `.json`. Eighteen 12-second
forward/reverse windows at the same stationary pose; all 18 particle checks pass.

| Condition | Mean interval ms | Mean of window p95s ms | Worst interval ms |
|---|---:|---:|---:|
| BOTH_V2 | 31.02 | 41.60 | 62.0 |
| V2_NO_MIST | 19.77 | 37.65 | 53.4 |
| V2_NO_FROST | 21.27 | 35.65 | 44.7 |
| V2_NO_SHARDS | 30.27 | 41.95 | 63.5 |
| V2_NO_GLITTER | 31.18 | 42.20 | 64.8 |
| V2_NO_SHOCKWAVES | 30.79 | 43.55 | 65.9 |
| V2_NO_BURSTS | 29.94 | 41.50 | 64.7 |
| V2_NO_CRYSTALS | 47.67 | 68.55 | 112.1 |
| NO_CAST | 11.16 | 11.85 | 42.9 |

**Remaining dominant costs:** mist and frost themselves, even after their shader
optimizations. Removing either improves the mean by ~10–11 ms. Other individual
removals improve the mean by at most ~1 ms here; hiding crystals worsens it.
Depth occlusion reducing transparent fragment work is a plausible explanation for
that reversal, not a measured per-draw proof. Do not infer additive per-effect
GPU durations from these conditional subtraction deltas.

The ~3 ms over the idle floor in V15-A's no-mist/frost control is not completely
attributed by V16: interactions and frame pacing matter, and lights were not
isolated. In particular, the old 20.8 ms no-mist/frost result belongs to V14's
different camera pose. There is no evidence for declaring a new single hidden
effect the bottleneck or for removing the crystals as a fix.

## Worn/visual validation gate

### Stationary validation-runner dry runs

These dry runs used the first V2 normal, before the fine-grain visual correction.

Artifacts: `Quest3-validation-original-stationary.json` and
`Quest3-validation-v2-stationary.json`. These use actual original classes on
`?bench=off` versus V2 classes on `?vfx=v2&bench=off`, rather than only the
copied shaders' original branch. Casts aim along the head's horizontal direction,
so their screen coverage differs from V15-A/V16's fixed +X comparison.

| Scenario | Original mean / p95 / worst ms | V2 mean / p95 / worst ms |
|---|---|---|
| Close-view schedule | 84.533 / 100.3 / 100.6 | 48.342 / 64.7 / 95.8 |
| Turning-labelled schedule, **no actual turning** | 88.252 / 100.3 / 100.6 | 47.083 / 62.8 / 96.8 |
| Two-overlap schedule | 99.722 / 100.3 / 100.8 | 60.389 / 73.1 / 84.3 |

Two active casts were confirmed in both overlap runs. Maximum measured head
rotation in the turning-labelled windows was only 0.043° original / 0.018° V2.
Both reports explicitly record `wearingConfirmedByOperator: false` and
`turningObserved: false`. These are successful runner/overlap checks, **not**
successful worn or turning checks. Host-driven sampling adds small overhead;
the dry-run windows run once per implementation, not forward/reverse repeats.

V2 still fails the frame budget, especially when casts overlap. Mist/frost
fragment arithmetic was reduced, but their broad transparent coverage and
overlap remain. Any next representation/coverage change must be explicit and
visually reviewed; particle count, size and lifetime were not cut in this pass.

Not yet approved by a wearer. Stationary hardware tests do not prove moving
gameplay comfort, visual fidelity, or frame-budget compliance. The runner
`scripts/quest-v2-validation.mjs` supports original/v2 close-view, turning, and
two-overlap scenarios, logs head poses and mean/p95/worst, and explicitly records
operator confirmation of wearing. Substantial turning and overlap are measured
separately; visual approval is still human.

See `src/v2/README.md` for URLs and commands. Original: `?bench=off`.
V2: `?vfx=v2&bench=off`. No production default is switched to V2.

## Visual review and fine-grain correction

Frozen captures were taken after a paused cast and 103 fixed 1/72-second steps:
190 crystal instances, impact age 1.431 s, and over 1,000 live particles.
`V2-frozen-original.png` / `V2-frozen-v2.png` show the full field. Isolated
captures temporarily hide crystals to expose mist/frost, outside scored windows.

One isolated V2 capture (`V2-isolated-v2.png`) was black and is **not accepted
visual evidence**. A fresh stepped V2 capture (`V2-isolated-v2-check.png`) shows
frost, and `V2-isolated-original-check.png` shows the original branch at the
same frozen age/particle count. The blank capture's cause was not established.

The fresh comparison exposed overly blocky V2 relief. Analytic fine-grain
gradients are now attenuated at the original normal's 0.16 m sampling scale;
the original height/alpha/coverage, colour and authored settings are unchanged.
V15-B reruns the shader comparison after this correction. First-round V15-A,
V16 and stationary dry-run numbers must not be relabelled as corrected-shader
measurements.

### V15-B: corrected normal, recentered reference space

Artifacts: `Phase_3_IceCrystalDebug-V15-B.log` and `.json`; all 12 particle
checks passed. Logged head pose is now (0, 0.76, 0), yaw 0°, pitch -19° after
wake/XR re-entry. Fixed +X casts are viewed differently than V15-A. The lower
absolute baseline is therefore **not** evidence that filtering alone produced
the extra speed; compare each variant to its own same-session CURRENT.

| Condition | Mean interval ms | Mean of window p95s ms | Worst interval ms |
|---|---:|---:|---:|
| CURRENT | 28.94 | 62.00 | 96.4 |
| MIST_V2 | 15.86 | 23.80 | 31.4 |
| FROST_V2 | 22.73 | 57.60 | 98.2 |
| BOTH_V2 | 13.52 | 20.35 | 26.8 |
| NO_MIST_OR_FROST | 11.13 | 11.85 | 26.9 |
| NO_CAST | 11.11 | 12.00 | 22.0 |

The corrected implementation still improves both forward/reverse comparisons,
but 90 Hz is not sustained, and this partial-view result is not close-view or
overlap approval. The next artifacts, V16-B and the corrected stationary
head-facing validation run, use the current filtered normal.

### V16-B: corrected normal, remaining-cost subtraction

Artifacts: `Phase_3_IceCrystalDebug-V16-B.log` and `.json`. All 18 particle
checks passed, at the recentered partial-view pose. The report records its URL
and successful completion. As above, p95 is the mean of window p95s, not pooled.

| Condition | Mean interval ms | Mean of window p95s ms | Worst interval ms |
|---|---:|---:|---:|
| BOTH_V2 | 14.27 | 20.80 | 28.0 |
| V2_NO_MIST | 11.26 | 12.35 | 17.4 |
| V2_NO_FROST | 11.90 | 15.60 | 20.4 |
| V2_NO_SHARDS | 14.36 | 21.60 | 27.6 |
| V2_NO_GLITTER | 13.72 | 21.90 | 30.3 |
| V2_NO_SHOCKWAVES | 14.04 | 20.25 | 25.1 |
| V2_NO_BURSTS | 14.29 | 21.85 | 27.6 |
| V2_NO_CRYSTALS | 14.08 | 21.80 | 48.4 |
| NO_CAST | 11.13 | 12.15 | 27.9 |

Mist and frost remain the clear subtraction gains. Other removals are small
relative to order drift (for example, no-shockwaves means are 12.63 / 15.45 ms).
The earlier crystal-removal reversal does not recur at this view: its effect is
view-dependent, not proof that crystals always help or hurt. Full CPU spans for
BOTH_V2 are 3.935 / 3.896 ms; these are not GPU durations. No new GPU counter
trace was collected for V2, and browser GPU timer queries remain unavailable.

### Corrected head-facing stationary validation

Artifact: `Quest3-validation-v2-filtered-stationary.json`. The actual V2 services
run on `?bench=off&vfx=v2`, with casts aimed into view rather than sideways +X.
This is a diagnostic dry run, not a wearer-confirmed test or an exact-pose A/B
repeat of the earlier original-class dry run. Host sampling has some overhead.

| Scenario | Mean interval ms | p95 ms | Worst ms |
|---|---:|---:|---:|
| Close-view schedule | 42.593 | 56.7 | 75.8 |
| Turning-labelled schedule, **no actual turning** | 49.013 | 65.0 | 89.9 |
| Two overlapping casts | 59.681 | 75.2 | 84.4 |

Two active casts were observed. Maximum head rotation was only 0.034°;
`turningObserved` and `wearingConfirmedByOperator` are false. The heavier
screen coverage still fails badly despite the improved shader arithmetic.
Full CPU mean for overlap was 4.872 ms, not its 59.681 ms frame interval.

## Verification and handoff

Corrected isolated captures: `V2-filtered-reference-v2.png` (age 1.431 s,
1,118 live particles) and `V2-filtered-reference-original-check.png` (age 1.458 s,
1,101 live particles). Same cast, head position within approximately 0.1 mm at
the checked switch, crystals temporarily hidden. Two additional 1/72-second
steps separate the accepted images; this is a near-age qualitative comparison,
not a pixel-exact comparison. The corrected V2 retains pale blue-white powder
and ragged edges with softer relief. Close-up moving fidelity still needs a
wearer. `V2-filtered-reference-original.png` was another blank capture and is
not accepted visual evidence; the cause remains unestablished.

After captures, crystal visibility was restored, transient effects cleared,
normal automatic casting and ECS updates resumed. Quest proximity sensing was
restored to enabled / override DISABLED / autosleep normal, and the temporary
ADB TCP 9223 forwarding was removed. The browser remains on the opt-in V2 manual
URL; the source default was not changed.

`npx tsc --noEmit`, all 12 Node tests, `npm run build`, script syntax checks,
and `git diff --check` pass. The build retains existing dependency annotation
and large-chunk warnings. Original `ParticleSystem.js`, `GroundDecals.js`,
`IceAbility.js`, and `settings.js` are byte-identical to HEAD. There are 60 valid
scored comparison/subtraction windows across V15-A/V16/V15-B/V16-B, plus the
three stationary runner dry runs. None is a worn comfort/fidelity approval.

The scene-composer skill's visual-review gate exposed overly blocky relief and
led to the fine-grain filtering correction. The debugging skill supplied
pause/step/snapshot/diff checks at fixed cast ages. No particle density, lifetime,
frost coverage, crystal geometry or authored preset was changed to get the gains.

Next gate: a wearer must compare the untouched original and corrected V2 at
close range, turn left/right, and inspect two overlaps. Then consider further
mist/frost representation or fragment-work experiments; do not silently reduce
coverage or remove other effects on the strength of these conditional deltas.
