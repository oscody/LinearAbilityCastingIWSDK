Lets create a sperate branch from master call it Phase_3_IceCrystalDebug and perform these test lets log the events to the console 
fix up the plan so we can execute it in steps 

We do it as a controlled experiment: **change only the crystal rendering, while keeping the Ice ability itself identical**.

I checked your actual repo. Right now the crystals are fairly expensive because each crystal uses a full physically based material, custom ice shader work, transparency, and double-sided rendering. The Ice ability itself already uses instancing efficiently, so the question is whether the GPU is spending its time calculating the **material** or repeatedly drawing **overlapping transparent crystal pixels**.

The key rule is: **same cast, same crystal count, same positions, same camera. Only change the crystal material between tests.**

| Test                   | What we change                                                 | What it tells us                                           |
| ---------------------- | -------------------------------------------------------------- | ---------------------------------------------------------- |
| A — Current            | Everything exactly as it is                                    | Baseline: ~55 ms                                           |
| B — Simple opaque      | Basic solid material, no transparency, no custom ice shading   | Shows the cheapest possible crystal field                  |
| C — Simple transparent | Same cheap material, but transparent                           | If performance collapses here, **overdraw is the problem** |
| D — Standard opaque    | Normal MeshStandard/PBR material, opaque, no custom ice shader | Measures normal lighting/material cost                     |
| E — Custom Ice opaque  | Your full Ice shader, but transparency disabled                | Measures how expensive your custom shader is               |
| F — Current Ice        | Custom shader + transparency + double-sided                    | Full production version                                    |

Then compare the numbers.

For example, imagine you get:

```text
Current Ice             55 ms
Simple opaque            9 ms
Simple transparent      40 ms
Standard opaque         12 ms
Custom Ice opaque       16 ms
Current Ice             55 ms
```

That would tell us:

**Transparency/overdraw is overwhelmingly the problem.**

Because simply turning transparency back on takes you from roughly 9 → 40 ms.

But suppose instead you got:

```text
Simple opaque            9 ms
Simple transparent      12 ms
Standard opaque         15 ms
Custom Ice opaque       42 ms
Current Ice             55 ms
```

Then the expensive part is mostly **your custom Ice shader**.

And if you get:

```text
Simple transparent      28 ms
Custom Ice opaque       30 ms
Current Ice             55 ms
```

then it's **both**.

There's another important test I would add because of your actual material.

Your Ice material is currently **double-sided**. That means the GPU renders both the outside and inside-facing crystal surfaces. That's part of what gives the crystal its translucent look, but it can increase the number of fragments being processed substantially.

So after identifying the main culprit, test:

**current Ice + single-sided rendering**

versus:

**current Ice + double-sided rendering**

If that produces a large improvement, then part of the cost isn't merely transparency—it's transparency combined with rendering both sides of many overlapping crystals.

Also, don't reduce the crystal count yet. Your Ice ability already uses three instanced meshes, which is good. Reducing crystal count would make performance improve, but it wouldn't tell us **why**.

We want to answer a more precise question first:

```text
190 crystals are slow because...

A. each pixel is being drawn too many times?

B. each pixel's shader is too expensive?

C. we're drawing too many surfaces because they're double-sided?

D. some combination?
```

I'd add these as temporary **Perf modes** rather than manually editing the material for every run. Something like:

```text
CURRENT
SIMPLE_OPAQUE
SIMPLE_TRANSPARENT
STANDARD_OPAQUE
ICE_OPAQUE
ICE_SINGLE_SIDE
```

Then your `PerfSystem` can run each configuration for several seconds and record median frame time.

That gives you an actual **crystal rendering benchmark**, and once we know the winner, we can optimize the right thing instead of cutting visual features randomly.
