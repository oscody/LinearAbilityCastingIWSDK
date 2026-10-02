# FPS readout in the Quest

Manual viewing now shows a head-locked badge on both `?bench=off` (ORIGINAL)
and `?vfx=v2&bench=off` (V2). The large number measures application FPS over the
latest half-second. The smaller lines retain the last completed five-second
average and p95/worst frame intervals. Samples reset on visibility changes;
hidden XR and invalid/zero deltas are excluded. This is app frame rate, not
the headset compositor's refresh rate.

The automatic benchmark badge now shows the condition and run number, live
FPS, time left, and the previous completed run's average FPS and p95/worst.
New windows show a dash until samples arrive, replacing the old placeholder
90 FPS. A completed V2 comparison displays Original and V2 FPS equivalents
of the mean window frame intervals together.

The UI uses the existing debug canvas-badge approach. Manual viewing adds one
plane and updates its texture twice a second. Automatic runs reuse the existing
benchmark plane. Compare runs with the same readout enabled; the display has
some rendering cost. The diagnostic code does not change VFX settings.

Verified on the connected physical Quest 3 in visible immersive VR: both manual
labels, changing FPS values, five-second statistics, and the benchmark's next-run
transition. These checks establish UI behavior, not a new controlled performance
comparison or worn visual approval. Screenshots:

- [V2 live view](images/Quest3-fps-v2-visible-2026-10-02.png)
- [Original live view](images/Quest3-fps-original-2026-10-02.png)
- [Benchmark with preceding result](images/Quest3-fps-benchmark-2026-10-02.png)

Type-checking, the 12 existing tests, and production build pass. The managed
desktop preview could not launch under the macOS sandbox; the existing Quest
Browser tab was inspected directly through its debugging connection instead.

Handoff: Quest Browser is back on `?bench=off&vfx=v2`, with normal casting and
the FPS readout active. Normal proximity sensing was restored and temporary
ADB TCP 9223 forwarding removed. The failed managed preview launch left an
unused Vite listener on port 8083 (PID 32158); macOS sandbox permissions rejected
its termination. The existing Quest-serving Vite listener on 8081 was preserved.
