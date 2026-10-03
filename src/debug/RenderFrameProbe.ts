import type { Camera, Object3D, WebGLRenderer, World } from '@iwsdk/core';

interface TimerExtension {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

const METRICS = ['interval', 'cpuFrame', 'update', 'render', 'gpu'] as const;
const CAPACITY = 8192;
const QUERY_COUNT = 16;

/** Debug instrumentation. CPU submission and GPU duration are distinct metrics. */
export class RenderFrameProbe {
  private window = -1;
  private frameWindow = -1;
  private previousWindow = -1;
  private previousStart = 0;
  private frameStart = 0;
  private updateMs = 0;
  private names: string[];
  private samples: Float64Array[][];
  private counts: Uint32Array[];
  private sums: Float64Array[];
  private worst: Float64Array[];
  private scratch = new Float64Array(CAPACITY);
  private gl: WebGL2RenderingContext;
  private ext: TimerExtension | null;
  private queries: WebGLQuery[] = [];
  private queryWindows = new Int32Array(QUERY_COUNT).fill(-1);
  private disjointCount = 0;
  private skippedQueries = 0;
  private disposed = false;
  private originalUpdate: World['update'];
  private originalRender: WebGLRenderer['render'];
  private wrappedUpdate: World['update'];
  private wrappedRender: WebGLRenderer['render'];

  constructor(private world: World, private renderer: WebGLRenderer, windows: number) {
    this.names = new Array(windows).fill('');
    this.samples = Array.from({ length: windows }, () => METRICS.map(() => new Float64Array(CAPACITY)));
    this.counts = Array.from({ length: windows }, () => new Uint32Array(METRICS.length));
    this.sums = Array.from({ length: windows }, () => new Float64Array(METRICS.length));
    this.worst = Array.from({ length: windows }, () => new Float64Array(METRICS.length));
    this.gl = renderer.getContext() as WebGL2RenderingContext;
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExtension | null;
    if (this.ext) {
      for (let i = 0; i < QUERY_COUNT; i++) {
        const query = this.gl.createQuery();
        if (query) this.queries.push(query);
      }
    }
    console.log('[frame-probe] GPU timer ' + (this.ext ? 'available' : 'unavailable; use a device trace'));
    this.originalUpdate = world.update;
    this.originalRender = renderer.render;
    const probe = this;
    this.wrappedUpdate = function (delta: number, time: number): void {
      probe.pollGPU();
      const start = performance.now();
      // Attribute the interval to the preceding rendered condition, not a new window.
      if (probe.previousStart > 0) probe.record(probe.previousWindow, 0, start - probe.previousStart);
      probe.frameStart = start;
      probe.originalUpdate.call(this, delta, time);
      probe.updateMs = performance.now() - start;
      probe.frameWindow = probe.window;
      probe.previousWindow = probe.window;
      probe.previousStart = start;
    };
    this.wrappedRender = function (scene: Object3D, camera: Camera): void {
      // Offscreen frost baking is work within a frame, not another XR frame.
      // Update/interval timing still includes it; GPU/render metrics cover the
      // main scene submission only (not offscreen passes).
      if (probe.world.scene && scene !== probe.world.scene) {
        probe.originalRender.call(this, scene, camera);
        return;
      }
      const slot = probe.beginGPU();
      const start = performance.now();
      try {
        probe.originalRender.call(this, scene, camera);
      } finally {
        const end = performance.now();
        if (slot >= 0) probe.gl.endQuery(probe.ext!.TIME_ELAPSED_EXT);
        probe.record(probe.frameWindow, 1, end - probe.frameStart);
        probe.record(probe.frameWindow, 2, probe.updateMs);
        probe.record(probe.frameWindow, 3, end - start);
      }
    };
    world.update = this.wrappedUpdate;
    renderer.render = this.wrappedRender;
  }

  setWindow(window: number, name: string): void {
    this.window = window;
    if (window >= 0) this.names[window] = name;
    console.timeStamp('ice-bench ' + (window + 1) + ' ' + name);
  }

  private record(window: number, metric: number, ms: number): void {
    if (window < 0) return;
    const n = this.counts[window][metric]++;
    if (n < CAPACITY) this.samples[window][metric][n] = ms;
    this.sums[window][metric] += ms;
    this.worst[window][metric] = Math.max(this.worst[window][metric], ms);
  }

  private beginGPU(): number {
    if (!this.ext || this.frameWindow < 0) return -1;
    // Do not nest a timer owned by another profiler.
    if (this.gl.getQuery(this.ext.TIME_ELAPSED_EXT, this.gl.CURRENT_QUERY)) return -1;
    for (let i = 0; i < this.queries.length; i++) {
      if (this.queryWindows[i] < 0) {
        this.queryWindows[i] = this.frameWindow;
        this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.queries[i]);
        return i;
      }
    }
    this.skippedQueries++;
    return -1;
  }

  private pollGPU(): void {
    if (!this.ext) return;
    const disjoint = this.gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    if (disjoint) {
      this.disjointCount++;
      // Outstanding results cannot be trusted after a GPU clock discontinuity.
      for (let i = 0; i < this.queries.length; i++) {
        if (this.queryWindows[i] >= 0) {
          this.gl.deleteQuery(this.queries[i]);
          this.queries[i] = this.gl.createQuery()!;
          this.queryWindows[i] = -1;
        }
      }
      return;
    }
    for (let i = 0; i < this.queries.length; i++) {
      if (this.queryWindows[i] < 0) continue;
      if (!this.gl.getQueryParameter(this.queries[i], this.gl.QUERY_RESULT_AVAILABLE)) continue;
      const ns = this.gl.getQueryParameter(this.queries[i], this.gl.QUERY_RESULT) as number;
      this.record(this.queryWindows[i], 4, ns / 1e6);
      this.queryWindows[i] = -1;
    }
  }

  report() {
    this.pollGPU();
    return {
      mode: this.renderer.xr.isPresenting ? 'xr' : 'browser',
      gpuTimer: !!this.ext,
      disjointCount: this.disjointCount,
      skippedQueries: this.skippedQueries,
      pendingQueries: this.queryWindows.filter((w) => w >= 0).length,
      // cpuFrame: ECS update entry through renderer.render return. Includes XR
      // frame callbacks; excludes compositor wait and work outside that span.
      windows: this.names.map((name, w) => ({
        w: w + 1,
        name,
        ...Object.fromEntries(METRICS.map((key, m) => {
          const count = this.counts[w][m];
          const n = Math.min(count, CAPACITY);
          this.scratch.set(this.samples[w][m].subarray(0, n));
          const view = this.scratch.subarray(0, n);
          view.sort();
          return [key, {
            count,
            mean: count ? +(this.sums[w][m] / count).toFixed(3) : null,
            p95: n ? +view[Math.floor(n * 0.95)].toFixed(3) : null,
            worst: count ? +this.worst[w][m].toFixed(3) : null,
          }];
        })),
      })),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.world.update === this.wrappedUpdate) this.world.update = this.originalUpdate;
    if (this.renderer.render === this.wrappedRender) this.renderer.render = this.originalRender;
    for (const query of this.queries) this.gl.deleteQuery(query);
  }
}
