# Ice Crystal Performance Breakdown

**Branch:** `Phase_3_IceCrystalDebug` (from `master` @ `b112186`)
**Harness:** `src/debug/CrystalBench.ts`, registered in `index.ts` at priority 50.
Set `BENCH_ENABLED = false` in that file to run the app normally on this branch.

---

## Method

The rule from the brief, enforced in code:

> **Same cast, same crystal count, same positions, same camera. Only the crystal
> material changes between tests.**

Two mechanisms enforce it:

- **Seeded RNG.** `Math.random` is swapped for an LCG reset to the same seed before
  every cast, so each mode erupts a byte-identical field (190 instances, every run).
  Without this the per-cast dice move crystals between modes and the comparison
  measures luck. Restored on teardown.
- **Bench owns casting.** `CastSystem.benchControlled` suspends its own debug trigger;
  the bench casts with fixed origin, direction (+X) and distance (6 m), and re-fires
  whenever the field retires so one field stands for the whole window.

**Crystal count is deliberately not reduced.** Cutting it would improve the numbers
without explaining them.

### Interleaved repeats

Run 1 was blocked (all modes once, in order) and **its results were not usable**: it
measured `CURRENT` twice and got **28.8 ms** and **43.4 ms** — a 14.6 ms spread on an
identical config, larger than the entire effect being measured.

Run 2 therefore uses `REPEATS = 3` **round-robin**, so thermal drift and background load
land on every mode equally rather than on whichever ran last. The reported value is the
median of each mode's per-repeat medians, with min/max/spread kept visible.

### Modes

| Mode | What changes | What it isolates |
|---|---|---|
| `NO_CAST` | no ability at all | in-session floor |
| `CRYSTALS_HIDDEN` | ability simulates, crystals not drawn | splits CPU/sim from *all* crystal GPU cost |
| `CURRENT` | unchanged | baseline: ice shader + transparent + DoubleSide |
| `SIMPLE_OPAQUE` | `MeshBasicMaterial` | cheapest possible fragment |
| `SIMPLE_TRANSPARENT` | `MeshBasicMaterial` + blend | overdraw |
| `STANDARD_OPAQUE` | stock PBR, opaque | normal lighting cost |
| `ICE_OPAQUE` | full ice shader, `transparent: false` | custom shader cost |
| `ICE_SINGLE_SIDE` | `CURRENT` but `FrontSide` | double-sided fragments |

`CRYSTALS_HIDDEN` and `NO_CAST` were added after run 1, because run 1 showed the cheapest
possible material was still ~35 ms and something outside the material had to dominate.

---

## Step 1 — Results ✅ (2026-09-22, browser, 1 view, 2194×1780, M1 Pro)

| mode | median | min | max | spread | vs CURRENT |
|---|---|---|---|---|---|
| `NO_CAST` | **8.4** | 8.3 | 11.0 | 2.7 | −37.9 |
| `CRYSTALS_HIDDEN` | **46.9** | 46.1 | 47.5 | 1.4 | +0.6 |
| `CURRENT` | **46.3** | 43.2 | 47.9 | 4.7 | 0.0 |
| `SIMPLE_OPAQUE` | 34.6 | 33.6 | 35.3 | 1.7 | −11.7 |
| `SIMPLE_TRANSPARENT` | 34.5 | 33.9 | 38.8 | 4.9 | −11.8 |
| `STANDARD_OPAQUE` | 38.1 | 34.8 | 48.8 | 14.0 | −8.2 |
| `ICE_OPAQUE` | 37.8 | 37.5 | 87.6 | 50.1 | −8.5 |
| `ICE_SINGLE_SIDE` | 45.3 | 45.2 | 50.3 | 5.1 | −1.0 |

### Answer to the question we set out to ask

```
190 crystals are slow because...
  A. each pixel is drawn too many times?        -> NO
  B. each pixel's shader is too expensive?      -> NO
  C. too many surfaces, because double-sided?   -> NO
  D. some combination?                          -> NO
  E. the crystals are not the problem at all.   -> YES
```

**`CRYSTALS_HIDDEN` (46.9 ms) ≈ `CURRENT` (46.3 ms).** Not drawing the crystals *at all*
changes the frame by +0.6 ms, inside the spread. Both spreads are tight (1.4 and 4.7), so
this is not noise.

A cast costs **~38 ms**, and ~38 ms of it is spent **with no crystal on screen**.

This overturns the hypothesis in port-plan §12, which concluded transparent-crystal
overdraw was the one candidate the data did not exclude. It was excluded by the first test
that actually removed the crystals.

### Unexplained anomaly — do not skip

`SIMPLE_OPAQUE` (34.6 ms, spread 1.7) is **~12 ms faster than `CRYSTALS_HIDDEN`**
(46.9 ms, spread 1.4). Drawing cheap crystals is faster than drawing none. Both spreads
are tight, so it is a real effect, not variance.

That is physically backwards and means the harness is perturbing something it should not.
The difference between the two modes is not only visibility — `CRYSTALS_HIDDEN` also
leaves the **full ice material assigned** (the `materials` map has no entry for it, so
`applyMode` falls back to `ability.material`). So the comparison is confounded:
hidden+ice-material vs drawn+basic-material.

**This must be resolved before trusting any number in the table**, because it implies an
unaccounted per-frame cost tied to the ice material that is paid even when nothing is
drawn. Candidates: per-frame uniform writes the ability performs regardless of visibility;
`needsUpdate` churn on instanced attributes; transparent-list sorting.

---

## Step 2 — Fix the confound ✅ RUN (V2, V2A; see below)

> Superseded in practice by Step 3: V2 was invalidated by state leaking between modes
> (fixed with the settle phase), and the Quest run in V4 showed the hidden-material pair
> makes little difference (33 vs 38 ms).

Run 1 conflated two axes. `CRYSTALS_HIDDEN` hid the meshes **and** left the ice material
assigned; `SIMPLE_OPAQUE` drew them **and** swapped the material. So the backwards result —
drawing cheap crystals (34.6 ms) beating drawing none (46.9 ms) — compared two things that
differed in two ways at once.

`CrystalBench` now treats visibility and material as **independent axes**, declared in one
`MODE_SPECS` table rather than inferred from the mode name. Two new modes differ *only* in
which material is assigned to meshes that are never drawn:

| Mode | visible | material |
|---|---|---|
| `HIDDEN_ICE_MAT` | ✗ | ability's own ice material *(= run 1's `CRYSTALS_HIDDEN`)* |
| `HIDDEN_SIMPLE_MAT` | ✗ | `MeshBasicMaterial` |

### How to read the outcome

| Result | Meaning |
|---|---|
| both ≈ 47 ms | Run 1's `SIMPLE_*` numbers were an artefact. Re-run and re-interpret the whole table. |
| `HIDDEN_ICE_MAT` ≈ 47, `HIDDEN_SIMPLE_MAT` ≈ 34 | The ice material costs ~12 ms/frame **while invisible** — a CPU/upload cost, not a fragment cost, and a bug worth fixing on its own. |

Run cost: 9 modes × 3 repeats × (1.5 s warmup + 4 s measure) ≈ **150 s**, plus page load.

### Run 2 (V2.log) — invalidated: state leaked between modes

Run 2 is **not usable**. Draw calls at `instances=190`, rep 1:

| mode | calls |
|---|---|
| `NO_CAST` | 9 |
| `HIDDEN_ICE_MAT` | **89** |
| `HIDDEN_SIMPLE_MAT` | **102** |
| `CURRENT` | 42 |
| `SIMPLE_OPAQUE` | 56 |

The two HIDDEN modes drew *more* than `CURRENT` while drawing **no crystals at all**. That
can only be the previous mode's decals, fissures, bursts and still-living particles carried
over. Every mode was measuring the one before it, plus leftovers.

**Fix (implemented):** each mode now begins with a full teardown and an empty-scene settle
window before anything is cast.

- `CastSystem.clearAll()` — the source's `App.clearEffects()`: retires abilities and clears
  particles, decals, fissures, bursts, lights, shake and flash.
- `CrystalBench` gains a `settle` phase (`SETTLE_SECONDS = 1.5`) that runs *before* the
  cast, with auto-refire suppressed, so the scene is genuinely empty.
- The drained state is **logged** before every measurement —
  `settled <MODE> -> abilities=0 particles=0 calls=N CLEAN` — so a failed drain is visible
  rather than silently poisoning the numbers again.
- `finish()` also clears, so the app is left in a clean state.

Run cost rises to 9 modes × 3 repeats × (1.5 settle + 1.5 warmup + 4 measure) ≈ **190 s**.

### Second confound in V2 — a hard 100 ms floor

Unrelated to leftovers, and unresolved: many V2 modes pinned at **100.2–100.4 ms**, i.e.
almost exactly 10 fps, with p95 sitting on the same number. A clamp that flat is not GPU
cost — it looks like requestAnimationFrame throttling, which Chrome applies to a
backgrounded or occluded window.

If that is what happened, V2 measured the throttle, not the scene. **Before trusting run 3,
confirm the managed browser window is foregrounded and visible for the whole run**, and
treat any mode reporting ~100 ms with a p95 equal to its median as suspect.

## Step 3 — Find the missing ~38 ms ⚠️ STATIC BENCH SAID MIST (V3-A, V4); LIVE PLAY SAYS GROUND DECALS (V9)

Crystals are ruled out, so every Step 3 mode runs with them **hidden** and removes one
subsystem at a time. The reference is `HIDDEN_ICE_MAT` — the same cast, nothing suppressed.

| Mode | Removes | How |
|---|---|---|
| `NO_PARTICLES` | all emission | `settings.global.particleCount = 0`, `emissionRate = 0` |
| `NO_DECALS` | ground decals | `ctx.decals` → no-op stub |
| `NO_BURSTS` | burst spheres | `ctx.bursts` → no-op stub |
| `NO_SIM` | `_updateSpikes` | own-property no-op shadowing the prototype method |
| `NO_ANYTHING` | all four | whatever remains is unaccounted for |

### Two things the code had to work around

**Particles cannot be stubbed through `ctx`.** `IceAbility.createParticles()` caches its
system references (`this.mist`, `this.shards`, `this.glitter`) at construction, so swapping
`ctx.particles` afterwards changes nothing. But every emit is
`Math.round(N * g.particleCount)`, so zeroing the source's own global multiplier is exact —
and idiomatic to the architecture rather than a hack around it.

Decals and bursts *are* read from `ctx` at call time, so stubs work there.

**`NO_FISSURES` was dropped.** The plan sketched it, but `IceAbility` never references
`ctx.fissures` — the mode would have measured nothing. `FissureSystem.update()` still ticks
from `CastSystem` every frame with an empty pool; if that turns out to matter it belongs in
a separate "idle service tick" test, not here.

### Reading the outcome

Subtract each mode from `HIDDEN_ICE_MAT` to get that subsystem's per-frame cost. The
prediction on record is that **`NO_SIM` accounts for most of it**: 190 records recomposed
into instance matrices and re-uploaded every frame is the largest per-frame CPU work in a
cast, and it is paid whether or not anything is drawn — which is precisely the shape of the
Step 1 result.

If `NO_ANYTHING` is still far above `NO_CAST`, the cost is in something none of these modes
touches — `Ability.update()`'s own bookkeeping, the light pool, or per-frame uniform writes.

`NO_SIM` reports `instances: 0` by design; the counter lives inside the method being
suppressed.

Run cost: 14 modes × 3 repeats × 7 s ≈ **5 minutes**.

### Results — V3-A (Quest, first run) and V4 (Quest, corrected harness)

**V3-A** was the first complete run on the headset. It was too noisy to rank modes: rep 1
was slow everywhere (shader compile), rep 3 degraded again, and the median hid hitches
(`CURRENT` rep 3: 11.2 ms median at 15.6 fps). Two things it did show reliably: only
`NO_PARTICLES` and `NO_ANYTHING` returned to ~90 fps, and `NO_SIM` did **not** help — the
prediction above was wrong.

The harness was then changed before V4:

- Ranked on **mean frame time** and **% frames over 13.9 ms**, not the median.
- A full **discarded warm-up pass** runs before rep 1.
- `NO_PARTICLES` split into `NO_MIST`, `NO_SHARDS`, `NO_GLITTER` (each shadows `emit` on
  one system).
- A head-locked in-headset badge shows rep, phase (settle/warmup/measure) and mode.

**V4 — mean frame time on Quest 3, 2 views, 1680×1760, median of 3 reps.** Target is
11.1 ms (90 fps).

| Mode | Mean ms | % slow | Spread ms |
|---|---|---|---|
| `NO_CAST` (floor) | 11.1 | 0 | 0 |
| **`NO_MIST`** | **11.1** | **0** | **0.02** |
| `NO_PARTICLES` | 11.2 | 0.8 | 0.6 |
| `NO_ANYTHING` | 11.2 | 0.8 | 0.05 |
| `NO_GLITTER` | 25.7 | 67 | 1.0 |
| `NO_SHARDS` | 28.2 | 84 | 9.8 |
| `NO_SIM` | 21.9 | 50 | 7.0 |
| `NO_BURSTS` | 23.2 | 50 | 9.4 |
| `NO_DECALS` | 24.5 | 53 | 11.9 |
| `HIDDEN_ICE_MAT` (nothing removed) | 33.2 | 87 | 28.0 |
| `HIDDEN_SIMPLE_MAT` | 37.8 | 100 | 31.8 |
| `CURRENT` | 37.8 | 100 | 16.4 |
| `SIMPLE_OPAQUE` / `SIMPLE_TRANSPARENT` | 38.1 / 37.1 | 100 | 14.4 / 12.5 |
| `STANDARD_OPAQUE` / `ICE_OPAQUE` | 39.3 / 40.1 | 100 | 30.6 / 14.6 |
| `ICE_SINGLE_SIDE` | 37.1 | 100 | 16.1 |

### Conclusions

1. **`ice.mist` is the cost.** Removing it alone returns the cast to the floor (11.1 ms, 0%
   slow, 0.02 ms spread). Removing glitter or shards alone helps only partially and never
   approaches 90 fps.
2. **Nothing is unaccounted for.** `NO_ANYTHING` equals `NO_CAST`, so `Ability.update()`
   bookkeeping, the light pool and uniform writes are not a factor.
3. **The crystals are cheap.** Drawing them adds ~4–5 ms (`HIDDEN_ICE_MAT` 33 vs `CURRENT`
   38). All five material variants land within 37–40 ms, so the ice shader, blending and
   double-sided rendering are not the problem.
4. **`NO_SIM` prediction refuted.** Recomposing the 190 instance matrices is not the main
   cost.
5. **Unexplained:** `NO_DECALS`, `NO_BURSTS` and `NO_SIM` each cut ~9–11 ms although mist is
   still running. Their spreads (7–12 ms) are as large as the effect, so this is probably
   noise or general load relief. Do not read anything into it.

### Hypothesis, not measured

Mist is the only system of large, soft, overlapping translucent sprites: ~260/s, ~2.8 s
lifetime, growing to 3.4× size, drawn once per eye. That points at **overdraw / fill rate**.
This is in tension with Step 1's desktop result, which ruled overdraw out for the
*crystals*; that finding was about the crystal meshes, not particles, and the desktop camera
was a different view. Confirm before tuning — see Step 5.

### V5 — mist tuning (Quest, **noisy: read the ranking only**)

V5 added five `MIST_*` modes on top of `CURRENT` (crystals visible). The run itself was
degraded: `CURRENT` read 78 ms against 38 ms in V4, and `NO_MIST` slid 17 → 21 → 91 ms
across reps, while `NO_CAST` / `NO_ANYTHING` stayed at 11.1 ms. Cause unconfirmed — headset
thermal throttling or something accumulating in the app. **Do not quote V5's absolute
numbers.** The ranking of the tuning modes was identical in every rep, so that is usable.

Mean ms, rep 3 (rep 1):

| Mode | Change | Mean ms |
|---|---|---|
| `CURRENT` | baseline | 77.7 (45.8) |
| `MIST_QUARTER_RATE` | emission rate ×0.25 | 62.7 (60.1) |
| `MIST_SMALL_END` | end size ×0.5 | 36.5 (27.9) |
| `MIST_HALF_SIZE` | size ×0.5 (¼ area) | 27.3 (25.9) |
| `MIST_LEAN` | combined | 19.4 (14.4) |
| `MIST_HALF_LIFE` | lifetime ×0.5 | **16.8 (13.1)** |

1. **Screen coverage, not sprite count.** Quarter the area helps a lot; quarter the
   emission rate barely helps. This supports the overdraw hypothesis.
2. **Lifetime is the best lever** and the most stable mode. It is the only one that gets
   near 90 fps.
3. **Why the rate change did nothing (inferred from code, not measured):** `mistRate` only
   drives the continuous stream. The biggest puffs come from a one-off burst of 90
   (`IceAbility.js` ~line 712: size 1.6, life `mistLifetime × 1.5` ≈ 4.2 s) that the rate
   setting never touches. `mistLifetime` scales it.
4. `MIST_LEAN` is no better than `MIST_HALF_LIFE` alone.

> **Correction (see V6):** finding 3 above, the burst theory, was wrong.

### V6 — burst-targeting modes (Quest, clean run)

Trimmed to 11 modes (~5 min) and run with the headset cooled. The run was clean: spreads
0.05–2 ms on the winning modes, every settle `CLEAN`. That V5's degradation did not recur
suggests it was headset heat, not an app leak, but this is unconfirmed.

Mean ms, median of 3 reps (target 11.1):

| Mode | Change | Mean ms | % slow |
|---|---|---|---|
| `NO_CAST` | floor | 11.1 | 0 |
| **`MIST_HALF_LIFE`** | lifetime ×0.5 | **11.15** | 0.3 |
| **`MIST_LEAN`** | combined | **11.2** | 1.7 |
| `NO_ANYTHING` | | 11.4 | 2.8 |
| `NO_MIST` | | 11.7 | 9.4 |
| `MIST_HALF_SIZE` | size ×0.5 | 14.7 | 29 |
| `BURST_HALF_SIZE` | burst puffs 0.8 | 18.7 | 30 |
| `BURST_THIRD_COUNT` | burst 30 puffs | 19.0 | 44 |
| `BURST_NONE` | burst removed | 19.5 | 34 |
| `BURST_HALF_LIFE` | burst life ×0.5 | 19.6 | 38 |
| `CURRENT` | baseline | 20.9 | 46 |

1. **`mistLifetime` ×0.5 is the fix.** It reaches the floor with the mist still present.
2. **The burst theory is refuted.** Removing the burst entirely saves only 1.3 ms.
3. **Screen coverage helps partway.** Half size gives ~6 ms back, less than lifetime.
4. **Unexplained:** V5 saw `MIST_QUARTER_RATE` barely help, yet halving lifetime fixes
   everything, though both cut the live puff count. V5 was noisy, so that result may be
   wrong. It is re-tested in the next run.

Note `CURRENT` read 20.9 ms here against 38 ms in V4 for the same config: absolute levels
drift between sessions, so compare modes only within one run.

**Next:** run the lifetime sweep (`MIST_LIFE_70`, `MIST_LIFE_85` alongside `MIST_HALF_LIFE`)
plus a `MIST_QUARTER_RATE` re-check, to find the mildest lifetime cut that reaches 90 fps.
The user must judge the look in the headset before `mistLifetime` in `settings.js` is
changed.

### V7 — lifetime sweep (Quest, slow-state session)

Adds `MIST_LIFE_70` / `MIST_LIFE_85` and a re-check of `MIST_QUARTER_RATE`, plus a 12 s
purple "LOOK" pause after each mode's first scored measure window (unsampled, so it cannot
affect the numbers) and a badge line showing the actual setting.

Mean ms, median of 3 reps (target 11.1):

| Mode | Mean ms | % slow |
|---|---|---|
| `NO_CAST` / `NO_ANYTHING` | 11.1 / 11.1 | 0 |
| `MIST_HALF_LIFE` (×0.5) | 36.8 | 100 |
| `MIST_LIFE_70` (×0.7) | 47.4 | 100 |
| `MIST_LIFE_85` (×0.85) | 59.3 | 100 |
| `MIST_QUARTER_RATE` | 65.3 | 100 |
| `CURRENT` | 74.2 | 100 |

1. **Lifetime is a monotonic dial:** each step down improves things (×0.85 → ×0.7 → ×0.5).
2. **The V5 rate result was real:** emission rate helps (−9 ms) but far less than lifetime.
3. **No lifetime setting reached the floor in this session.** `MIST_HALF_LIFE` was 11.15 ms
   in V6 and 36.8 ms here; `CURRENT` was 20.9 ms in V6 and 74 ms here.

### Validity — the runs so far do NOT establish a fix

- **Absolute level swings between sessions** (V4, V6 fast; V5, V7 slow) by up to ~3.5× for the
  same config. Only rankings *within* one run are meaningful. Cause unknown: headset heat,
  or where the player stood/looked (the cast fires from the player position in a fixed
  direction, so fog screen coverage changes with pose). Neither is logged.
- **The user still experiences problems in VR**, including after runs that read as fast.
  So the benchmark has not been validated against felt performance, and the "fast" runs
  (V4/V6) should not be read as "the game is fine at ×0.5". The benchmark holds one static
  field with the player standing still; real play differs (repeated casts, head/hand motion,
  overlapping fields, other systems running).
- **Not established:** that mist is the *only* cost in real play, or that any lifetime value
  is a sufficient fix. What is established is a relative ranking inside each run: mist is the
  dominant subsystem and lifetime is the strongest of the levers tried.

**Next:**
1. Log head position and gaze direction at each measure window, so a slow session can be
   explained instead of guessed at.
2. Judge the look at ×0.5 / ×0.7 / ×0.85 in the headset (not yet recorded).
3. Measure real play — repeated casts, while moving — not just the static bench. Consider
   the Quest's own GPU/CPU counters (`mcp__metavr__` tools; adb is now connected) as an
   independent check on the in-page timings.

### V8 — live real-play probe on the Quest (supersedes the static-bench conclusion)

`BENCH_MODE = 'live'`: the game's own casting runs untouched (unseeded, every 6 s) while the
player moves freely; only the mist lifetime multiplier is cycled (8 × 30 s windows, second
cycle reversed). Quest 3, `xr`, 1680×1760, head at ~1.55 m. A desktop-emulator pass of the
same probe was also run (headset fixed at origin, editor sharing the window, ~26 ms at ×1
falling to ~17 ms at ×0.5; two passes agreed within 1 ms) but it does not represent the
headset and is not scored here.

Mean ms per window (window 1 / window 2), target 11.1:

| Mist lifetime | Mean ms | ≈ fps |
|---|---|---|
| ×0.5 | 58 / 48 | 17–21 |
| ×0.7 | 69 / 68 | 14–15 |
| ×1 (current) | 67 / 86 | 12–15 |
| ×0.85 | 85 / 82 | 12 |

1. **Live play runs at 12–20 fps** on the headset. This matches what the user sees. The
   static bench (V4, V6) made it look far better than it is.
2. **Lifetime is a small lever, not the fix.** ×0.5 was best in both windows (~76 → ~53 ms
   averaged) but is still ~5× over budget. The V6 result that ×0.5 reaches the floor does
   not hold in live play.
3. **Noise is ±15–20 ms.** ×0.85 came out worse than ×1; ×1 itself swung 67 → 86 ms. Only
   "×0.5 is best" is supported. Many frames sit on the 100 ms cap, so true times may be
   worse.
4. **Slow even with no active cast.** In the 11 of 112 two-second samples with no active
   ability, frames still took 44–88 ms with only ~150 live particles and ~45 draw calls (a
   clean scene is 15). Something remaining after the cast is expensive, and no bench mode
   isolated it.
5. **One ability at a time** (`abilities:1` in every `[perf]` line), so stacking fields is
   not the explanation.

**Revised understanding.** In the static bench, removing mist restores the floor. In live
play it does not come close. So either (a) something the static bench doesn't reproduce is
also expensive (what lingers after a cast; the cast's ramp-up/tail; head motion against the
fog), or (b) the static bench under-loads the GPU relative to real play. Mist is *a* cost,
not established as *the* cost.

**Next (V9): subtract, in live play.** Instead of cycling lifetime, cycle what is
switched off while the game casts normally — nothing, mist, all particles, decals, bursts,
everything, plus a no-cast control — each in a 30 s window, repeated in reverse to expose
drift. Whichever removal brings live play near the floor is the real cost.

### V9 — subtraction in live play (Quest): the ground decals

Each 20 s window removes one thing while the game casts on its own (first 3 s of each window
discarded; list run forward then reversed). Quest 3, `xr`, 1680×1760, user moving. Crystals
stay visible except in `NO_CRYSTALS` / `NO_ANYTHING`. Mean ms, average of 2 windows (w1 / w2):

| Condition | Mean ms | w1 / w2 | Idle-frame ms |
|---|---|---|---|
| `NO_CAST` | 11.1 | 11.12 / 11.12 | 11.1 |
| `NO_ANYTHING` | 11.1 | 11.13 / 11.11 | 11.1 |
| **`NO_DECALS`** | **18.5** | **19.4 / 17.6** | **11.2** |
| `NO_BURSTS` | 43.7 | 38.6 / 48.8 | 59 |
| `NO_MIST` | 44.8 | 41.3 / 48.3 | 60 |
| `NO_PARTICLES` | 49.8 | 55.0 / 44.6 | 100 |
| `CURRENT` | 55.9 | 78.5 / 33.2 | 47 |
| `NO_CRYSTALS` | 96.1 | 96.1 / 96.1 | 100 |

1. **Ground decals are the dominant live cost.** Removing them alone takes 56 → 18.5 ms,
   reproducibly. No other single removal comes close.
2. **This overturns the static-bench conclusion.** There decals only cut draw calls
   (40 → 17) with no reliable fps gain, and mist looked like the whole cost. The static bench
   (one seeded field, player still, one cast per window) does not reproduce the load that
   matters.
3. **It explains V8's "slow with no active cast".** With decals removed, idle frames are the
   11.2 ms floor; with them present the game stays slow after the spell ends, because
   frost patches live for `frostLife` = 7 s while casts come every 6 s, so decals from
   consecutive casts overlap.
4. **Mist, bursts, particles are secondary** (each ~6–12 ms, inside the noise: `CURRENT`
   swung 78 → 33 ms between windows). `NO_DECALS` still leaves ~7 ms above the floor.
5. **Nothing else in the scene is slow:** `NO_CAST` and `NO_ANYTHING` sit exactly on the
   floor.
6. **Unexplained:** `NO_CRYSTALS` is the slowest condition (96 ms, both windows), slower
   than drawing the crystals. This echoes Step 1's unexplained anomaly. Hypothesis, not
   measured: drawn crystals occlude the fog/decals behind them, so hiding them lets more of
   those fragments through.

**Why decals are expensive (from reading `GroundDecals.js` / `IceAbility.js`, not measured):**
each decal is a large ground quad, transparent, `depthWrite: false`, with a procedural
multi-scale noise fragment shader. The ice cast lays `frostRate` (3.6) patches per metre of
front travel, each of radius `halfWidth × frostSpread (1.35)` and life `frostLife` (7 s),
plus a broad patch under the burst (`frostSpread × 2.2`, life ×1.3). Rendered once per eye,
overlapping each other and the previous cast's patches.

**Next (V10):** live-play tests of decal fixes — fewer patches (`frostRate`), shorter life
(`frostLife` below the 6 s cast interval so casts stop overlapping), smaller radius
(`frostSpread`), and a combination — against `CURRENT` and `NO_DECALS`.

### V10 — decal fixes in live play (Quest): did NOT reproduce V9

Same format as V9 (20 s windows, forward then reversed, first 3 s discarded). Mean ms, average
of 2 windows (w1 / w2):

| Condition | Mean ms | w1 / w2 | Draw calls while casting |
|---|---|---|---|
| `NO_CAST` | 11.1 | 11.1 / 11.1 | – |
| `CURRENT` | 52.4 | 52.3 / 52.5 | 50 |
| `NO_DECALS` | 55.0 | 40.0 / 69.9 | 23 |
| `FROST_LIFE_HALF` | 61.2 | 48.1 / 74.3 | 39 |
| `FROST_LEAN` | 60.8 | 72.3 / 49.3 | 32 |
| `FROST_RATE_QUARTER` | 67.3 | 81.4 / 53.2 | 32 |
| `FROST_SPREAD_HALF` | 83.9 | 81.4 / 86.5 | 50 |
| `FROST_RATE_HALF` | 88.8 | 93.0 / 84.7 | 38 |

1. **V9's headline did not reproduce.** `NO_DECALS` was 18.5 ms in V9 and is 55 ms here
   (while casting: 20.6 → 68 ms). Its two windows disagree by 30 ms.
2. **The tuning did take effect:** draw calls while casting fall as intended (50 → 38 → 32;
   23 with decals off). Frame time does not follow them — every casting condition sits at
   68–82 ms.
3. **Results are physically implausible.** Halving the frost rate was *worse* than doing
   nothing (89 vs 52 ms) in both windows; halving the radius also. Fewer or smaller
   transparent quads cannot cost more. So something other than the setting being changed
   dominates frame time, and it varies between windows and sessions.
4. **Each window starts fast and degrades:** first-2 s samples are 11–15 ms in many windows,
   then rise toward the 100 ms cap as the cast plays out.

**Conclusion: the in-page timing experiments are not resolving cause.** Across V4–V10 the
same condition has read 11 ms in one session and 55–95 ms in another (`CURRENT`, `NO_MIST`,
`NO_DECALS` all show it). The ground decals (V9) and mist (V4/V6) were each "the answer" in
one session and not in the next. Neither is established. What *is* stable across every run:
`NO_CAST` and `NO_ANYTHING` sit on the 11.1 ms floor, and live play with a normal cast is
12–20 fps.

**Untested explanations for the session swing:** headset thermal state or clock level; the
USB cable (adb) keeping the headset charging and warm during runs; the 100 ms delta clamp in
the in-page timing hiding the true size of spikes; GPU work the page cannot see.

### V10-A — rerun of V10 (Quest): reveals a flaw in the live probe

Same conditions and schedule, run again. Mean ms, w1 / w2:

| Condition | V10 | V10-A |
|---|---|---|
| `CURRENT` | 52 / 53 | 38 / 57 |
| `NO_DECALS` | 40 / 70 | 25 / 67 |
| `FROST_LIFE_HALF` | 48 / 74 | 24 / 73 |
| `FROST_LEAN` | 72 / 49 | 61 / 20 |
| `FROST_RATE_HALF` | 93 / 85 | 56 / 84 |
| `NO_CAST` | 11.1 | 11.1 |

1. **V9's decal result still does not reproduce** (`NO_DECALS` 46 ms here against 18.5 in V9).
2. **Not a heat effect.** The two runs match closely *by window slot* (windows 13–16: 54/55,
   85/84, 70/67, 52/57), which heat would not produce; and frame time returns to the 11 ms
   floor after the no-cast windows. The thermals logger planned for V11 was therefore
   dropped before use.
3. **Harness flaw — cast timing is confounded with the condition.** The game fires its own
   cast every 6 s; windows are 20 s, so each window catches casts at a different phase
   (the cast pattern in the per-2 s log repeats with period 3 windows), and the first 3 s
   (discarded) sometimes contains a cast's expensive start. Which condition gets which
   phase is fixed by its slot, so slot and condition cannot be separated.
4. **A cliff, not a slope.** Frame time sits at ~11 ms until a cast fires, then jumps to
   30–100 ms (the clamp) for several seconds. If the post-cast load straddles that cliff,
   modest cuts show nothing and then suddenly look dramatic, which would explain the
   non-monotone tuning results. Hypothesis, not proven.

### V11 — fixed-schedule probe (Quest): the stall is 2–4 s after a cast, and not the decals

The probe fires every cast itself at 0, 6, 12, 18 s of a 24 s window (nothing discarded), so
every condition sees an identical schedule; frame time is also binned by seconds since the last
cast. Conditions as V10. Mean ms (w1 / w2), and by cast age (0–2 / 2–4 / 4–6 s):

| Condition | Mean ms | w1 / w2 | Age 0–2 / 2–4 / 4–6 s |
|---|---|---|---|
| `NO_CAST` | 11.1 | 11.1 / 11.1 | – |
| `FROST_LEAN` | 50.4 | 53.4 / 47.4 | 48 / 100 / 35 |
| `NO_DECALS` | 52.8 | 43.1 / 62.5 | 50 / 92 / 40 |
| `CURRENT` | 65.1 | 46.1 / 84.0 | 57 / 79 / 64 |
| `FROST_LIFE_HALF` | 65.1 | 60.6 / 69.6 | 60 / 100 / 52 |
| `FROST_SPREAD_HALF` | 73.6 | 70.8 / 76.5 | 58 / 100 / 74 |
| `FROST_RATE_QUARTER` | 78.7 | 75.4 / 82.0 | 63 / 100 / 83 |
| `FROST_RATE_HALF` | 85.4 | 82.3 / 88.4 | 70 / 100 / 93 |

1. **Fixing the cast schedule helped:** most conditions now agree between their two windows
   (e.g. `FROST_LEAN` 53 / 47). `CURRENT` (46 / 84) still does not.
2. **Every casting condition hits the 100 ms clamp 2–4 s after a cast — including
   `NO_DECALS`.** Removing or shrinking decals does not remove it, so the ground decals
   are not the cause of the stall (consistent with V9 failing to reproduce in V10/V10-A).
3. **The costliest moment has the least on screen.** At age 2–4 s there are ~27 draw calls and
   ~350 particles, the minimum of the cast cycle, against ~38 calls / ~850–1000 particles at
   age 0–2 s. Frame time is therefore not tracking how much is drawn.
4. **Recovery by 4–6 s is where the conditions differ** (35–40 ms for `FROST_LEAN` and
   `NO_DECALS`, 83–93 ms for the rate-cut conditions), but the 2–4 s stall dominates.

**Hypothesis (from reading the code, not measured):** 2–4 s after the cast the front reaches
the end of its travel and the burst fires: a shockwave decal, a 90-puff mist emit, shards,
150 glitter particles, the burst sphere, a light, screen flash and camera shake. Emitting into
the GPU particle buffers is a candidate for the stall.

**Next (V12): split JavaScript time from everything else.** Wrap every system's `update` with a
timer and log, every 2 s and per cast-age bin, the total JS time per frame and the top three
systems. If JS is slow at 2–4 s the stall is in code and the per-system split names it; if JS
is fast while the frame is 100 ms the stall is on the GPU/compositor side.

## Step 4 — Re-run on Quest ✅ DONE

The retrieval gap is closed. `adb devices` sees the headset, and the console log is
captured by hand from the Quest browser. V3-A and V4 are both Quest runs
(`mode:"xr"`, 1680×1760).

Access from the headset: `adb reverse tcp:8081 tcp:8081`, then open
`https://localhost:8081/` in the Quest Browser.

## Step 5 — Only then, optimise ⬜ NEXT

The cost is now named, so this step is unblocked. Do it one lever at a time, re-measuring
each on the Quest, in this order:

1. Confirm it is fill rate: shrink `mistSize` / end size (`uEndSize` 3.4) and see if the
   time falls with sprite area, not particle count.
2. Lower `mistRate` (260/s).
3. Shorten `mistLifetime` (2.8 s).
4. Fewer, larger puffs.

Note that D2 still applies: no re-tuning of emissive or `global.glow` while the post stack is
deferred. Add a mist-tuning mode to `CrystalBench` so each change is measured, not guessed.

---

## Caveats on every number here

- **Step 1 numbers** are desktop, one view, inside the managed browser with the editor
  running in the same window. Relative comparisons only.
- **V3-A and V4 numbers** are Quest 3, two views. They include one constant extra draw call
  from the in-headset badge in every mode, so relative comparisons hold and absolute `calls`
  read 1 higher.
- A field stands continuously for the whole window. Real play is occasional casts, so this
  is closer to worst case.
- The camera sits close to the field, which maximises screen coverage and so inflates
  overdraw-bound costs specifically. That matters for the mist hypothesis: re-test at a
  realistic distance before deciding how much to cut.
