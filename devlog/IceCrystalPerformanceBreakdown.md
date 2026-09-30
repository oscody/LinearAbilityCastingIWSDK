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

## Step 3 — Find the missing ~38 ms ✅ ANSWERED (V3-A, V4): it is the mist

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

**Next:** rerun a trimmed list (`NO_CAST`, `CURRENT`, `NO_MIST`, `MIST_*`) with the headset
cooled, and add burst-targeting modes (count 90 → 30, size 1.6 → 0.8, life ×1.5 → ×0.75).
Judge the look of `MIST_HALF_LIFE` in the headset before choosing.

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
