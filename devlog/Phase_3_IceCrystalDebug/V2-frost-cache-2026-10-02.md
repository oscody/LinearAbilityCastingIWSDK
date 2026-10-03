# Cached frost: implemented and measured on Quest 3

## What is enabled

New candidate: `https://192.168.4.34:8081/?bench=off&vfx=v2&work=cache`.
The headset HUD reads **V2 • CACHED FROST**. This is a real implementation
change, enabled for wearer evaluation, not the disabled grid/mist experiments.

Approved V2 remains available at `?bench=off&vfx=v2`; original at `?bench=off`.
Neither `GroundDecalsV2.js` nor original effect/ability/settings files changed.
Mist is visible, with approved V2 noise and pruning off. Automatic six-second
casting resumes after each test. Neither the old frost grid nor two versions of
the effect are drawing alongside the new candidate.

## Implementation

`src/v2/FrostCacheV2.js` extends the approved decal service. On the first world
update after each frost spawn, it evaluates static coverage noise, original snow height and V2 normal slope
into a pooled RGBA16F texture. The frame shader samples those fields instead of
recalculating their noise. Equations are extracted from the approved shader;
growth, coverage thresholds, fade, lifetime, colours and animated glints remain
live. Particle count/size/lifetime and decal radius/count are not reduced.

Finite texture sampling approximates fine detail; it is not pixel-identical.
Trail patches use 256×256 maps, impacts above 5 m radius use 512×512. Allocation
is capped at 64 MiB of texture data (driver overhead excluded). A full budget or
unsupported float target falls back to procedural frost, preserving the patch.
Maps are invalidated/rebaked for new pooled seeds and released on disposal.
The two comparison runs peaked at 45 and 44 MiB, with zero fallbacks.

A final runtime check found `INVALID_OPERATION` when an external control enabled
caching on existing uncached patches between XR frames. Baking is now deferred
to the normal world update, including after runtime toggles. There is no render
call inside the toggle or spawn method. A regression test verifies this ordering;
budget-failed patches are not retried every frame. The earlier A/B runs below
precede this scheduling fix; static shader equations are unchanged.

`RenderFrameProbe` no longer counts an offscreen bake as an extra rendered frame.
Full frame intervals still include baking; update time includes baking inside
the world update. GPU/render metrics cover the main scene submission only.
Quest GPU timer queries were unavailable; these are not direct GPU durations.

## Physical Quest 3 results

Device `2G0YC5ZG8B08SY`, visible immersive XR, two views, HUD enabled. Each run
used eight 12-second windows: procedural/cache/cache/procedural for singles,
then the same ordering for overlaps. All cast, live-particle and stationary-pose
checks passed. The initial cast RNG seed is fixed; subsequent simulation random
draws are not guaranteed identical. View and settings were held fixed within
each comparison. These are stationary head-facing close-up stress tests, not
worn turning approval. Warmup precedes scoring; first-load shader compilation
is **not** characterized. New pooled texture allocations during scored windows
are included.

FPS is derived from the sample-count-weighted mean interval. p95 entries are
the two window percentiles, not a pooled percentile.

| Run / condition | Mean FPS | Mean interval (ms) | p95 intervals (ms) | Worst (ms) |
| --- | ---: | ---: | --- | ---: |
| A: approved V2 single | 22.75 | 43.95 | 60.2 / 59.8 | 88.5 |
| A: cached frost single | 33.05 | 30.26 | 52.1 / 50.9 | 60.4 |
| A: approved V2 overlap | 16.31 | 61.32 | 81.7 / 86.2 | 96.7 |
| A: cached frost overlap | 16.81 | 59.50 | 81.6 / 84.5 | 96.7 |
| B: approved V2 single | 22.89 | 43.68 | 58.2 / 61.4 | 84.4 |
| B: cached frost single | 33.09 | 30.22 | 52.1 / 53.6 | 61.1 |
| B: approved V2 overlap | 16.34 | 61.21 | 83.1 / 87.1 | 97.2 |
| B: cached frost overlap | 16.89 | 59.22 | 83.7 / 81.9 | 92.2 |
| Final: approved V2 single | 23.12 | 43.25 | 57.5 / 57.4 | 81.0 |
| Final: cached frost single | 33.71 | 29.67 | 52.6 / 51.1 | 57.8 |
| Final: approved V2 overlap | 16.24 | 61.59 | 85.7 / 85.4 | 99.6 |
| Final: cached frost overlap | 16.76 | 59.68 | 80.1 / 82.3 | 97.6 |

Single-blast mean intervals improved about 31%, equivalent to roughly 45% more
app frames per second. The overlap improvement is small, about 3% in mean
interval, with overlapping p95s: it is **not solved** and is far below 72–90 FPS.

Reports:

- [Comparison A](Quest3-v2-frost-cache-2026-10-02.json)
- [Comparison B](Quest3-v2-frost-cache-repeat-2026-10-02.json)
- [Final comparison after deferred-bake fix](Quest3-v2-frost-cache-final-2026-10-02.json)
- [Mist diagnostic](Quest3-v2-frost-cache-residual-2026-10-02.json)

The final comparison checks `gl.getError()` after each scored window: all eight
returned zero, with zero cache fallbacks. One warmup `INVALID_ENUM` (1280) was
recorded separately before scoring; do not silently treat that as a clean startup.
The [startup control check](Quest3-v2-frost-cache-startup-2026-10-02.json)
reproduced 1280 on both untouched approved V2 and cached frost. It is not specific
to this cache; its underlying startup cause remains uninvestigated.
The [active-patch toggle check](Quest3-v2-frost-cache-toggle-2026-10-02.json)
confirmed zero errors immediately after switching and after seven seconds in
each mode. Re-enabling returned all 24 live frost patches to cached rendering.

The separate residual test held cached frost on and alternated mist drawing
on/off/off/on, retaining particle simulation/emission. With mist, the two overlap
windows averaged 52.016 and 53.423 ms (about 19 FPS); without mist, 30.178 and
29.909 ms (about 33 FPS). p95 changed from 76.3/79.8 to 46.8/47.0 ms; worst
changed from 89.6/91.9 to 55.0/60.1 ms. This identifies mist rendering as a major
remaining cost, not a recommendation to remove it. Even without mist the scene
does not meet the frame budget. Use within-run comparisons: absolute results
vary between runs.

## Visual and code verification

Following the IWSDK frame-stepping workflow, paused before casting, took an ECS
snapshot, stepped 3 frames then five batches of 20 at 1/72 s, captured another
snapshot and diff, and photographed both shader modes at the same simulation
age. Full-effect and isolated-frost screenshots preserve overall coverage,
shape and colour; cached fine detail is slightly softened. These are actual
Quest captures, not desktop previews. Wearer approval of the new candidate is
still required, especially close-up and while turning.

- [Full effect, approved](images/Quest3-frost-cache-2026-10-02-approved.png)
- [Full effect, cached](images/Quest3-frost-cache-2026-10-02-cached.png)
- [Frost only, approved](images/Quest3-frost-cache-solo-2026-10-02-approved.png)
- [Frost only, cached](images/Quest3-frost-cache-solo-2026-10-02-cached.png)

Each pair has adjacent JSON with snapshots, steps, diff, head poses, particle
count, decal ages/seeds/radii and cache flags. Other VFX visibility was restored
after the isolated captures. The frozen HUD's 72 FPS value reflects fixed-step
updates and is **not benchmark evidence**; the timed reports above are the
performance evidence. Its cached-frost label indicates the selected URL even
when the diagnostic temporarily switches the cache off.

TypeScript checking, all 18 Node tests, script syntax checks and production build
pass. New tests cover shader equations, pooled rebaking, toggling, non-frost
isolation, disposal, renderer/XR state restoration on errors, unsupported-device
and budget fallback, and correct frame accounting for offscreen renders.
Build warnings remain dependency annotation/bundle-size warnings. No shader
compile failures were reported by Quest. The managed editor bridge remains
unavailable; no static scene/manifest changes were made, and live dynamic VFX
verification used the physical Quest runtime.

Final headset state was verified as visible XR on the cached-frost URL, cache
enabled, mist visible, automatic casting active, zero cache fallbacks and zero
shader compile failures. Normal proximity sensing was restored and the temporary
ADB forward was removed after verification.

## Next validation

Wear the headset on **V2 • CACHED FROST** and inspect the frost closely, turn,
and check overlap. Keep approved V2 for comparison. Next performance work should
target mist rendering without reducing the approved particle count, size or
lifetime. Do not enable the earlier frost-grid regression or claim overlap is
smooth based on the single-blast improvement.
