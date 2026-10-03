# V2 performance recheck — 2026-10-02

The wearer approved the existing V2 appearance. Neither new experiment is
enabled in the normal `?bench=off&vfx=v2` view. Original effects remain unchanged.

## Physical Quest 3 measurements

Each experiment used eight 12-second windows: approved/experimental/experimental/
approved for single casts, then the same order for overlapping casts. Casts were
head-facing, with the same initial random seed; head-motion and live-particle
checks are recorded in the JSON reports. These are stationary close-up stress
tests, not a wearer turning test. The FPS HUD was enabled throughout.

FPS below is 1000 divided by the sample-count-weighted mean frame interval.
Each p95 pair is the two individual window p95s, not a pooled percentile.

| Experiment / condition | Mean FPS | p95 intervals (ms) | Worst interval (ms) |
| --- | ---: | --- | ---: |
| Mist test: approved V2, single | 22.6 | 59.8 / 54.7 | 87.1 |
| Mist test: pruned mist, single | 23.0 | 56.5 / 58.7 | 73.7 |
| Mist test: approved V2, overlap | 16.0 | 84.4 / 86.4 | 97.3 |
| Mist test: pruned mist, overlap | 16.7 | 80.1 / 83.0 | 97.0 |
| Frost test: approved V2, single | 22.3 | 58.8 / 56.2 | 78.3 |
| Frost test: 64×64 frost grid, single | 18.9 | 70.9 / 67.8 | 97.3 |
| Frost test: approved V2, overlap | 15.7 | 84.6 / 96.1 | 100.2 |
| Frost test: 64×64 frost grid, overlap | 11.1 | 100.4 / 100.3 | 100.6 |

Sources: [mist pruning report](Quest3-v2-pruning-2026-10-02.json) and
[frost grid report](Quest3-v2-frost-grid-2026-10-02.json).

The conservative mist discard avoids shading pixels that cannot reach the
existing visibility cutoff. Its measured gain is small (about 2% single, 4%
overlap in mean interval), with baseline drift; it needs replication before
claiming a reliable improvement. Its uniform defaults to zero.

The frost grid moves static noise calculations to vertices and interpolates the
result. It clearly regressed this Quest workload and is not recommended. It is
available only through the explicit `work=grid` experiment URL.

GPU timer queries were unavailable: these are full frame intervals, not direct
GPU execution times. Do not compare absolute FPS across separate headset poses
as though they were controlled A/B results.

## Live recheck and verification

After the experiments the Quest was navigated back to
`https://192.168.4.34:8081/?bench=off&vfx=v2`. The runtime confirmed
`DecalSystemV2`, mist pruning zero, and a visible immersive XR session. A live
HUD sample after 12 seconds showed 23.4 FPS, median 42.2 ms, p95 55.2 ms and
worst 61.8 ms. This short live sample is separate from the controlled windows
above, and is not a new performance improvement.

Rechecked: `npx tsc --noEmit`, all 12 Node tests, production build and
`git diff --check` pass. Build warnings concern dependency annotations and bundle
size; the tests do not establish visual equivalence of the experimental grid.

Next candidate, not implemented or measured: cache the static frost pattern so
it is not recalculated for every pixel on every frame. Validate its first-cast
cost, memory use and close-up appearance before promoting it.
