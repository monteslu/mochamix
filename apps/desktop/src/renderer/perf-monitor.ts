/**
 * Perf monitor — logs real frame-rate + timing stats to the console every few
 * seconds so waveform/render jank is measurable instead of guessed. Reports FPS,
 * min/avg/max frame time, the count of long frames (jank), and how many waveform
 * lanes are drawing. Enabled always in dev; cheap (just timestamps per frame).
 */

let started = false;

interface LaneStat {
  gpu: boolean;
  drawMs: number;
}

// lanes register their per-frame draw cost here so the monitor can attribute jank
const laneStats = new Map<string, LaneStat>();

export function reportLaneDraw(id: string, gpu: boolean, drawMs: number): void {
  laneStats.set(id, { gpu, drawMs });
}

export function startPerfMonitor(intervalSec = 3): void {
  if (started) return;
  started = true;

  let frames = 0;
  let last = performance.now();
  let windowStart = last;
  let minDt = Infinity;
  let maxDt = 0;
  let sumDt = 0;
  let longFrames = 0; // > 20ms (below ~50fps)
  let jankFrames = 0; // > 33ms (below 30fps)

  const tick = () => {
    const now = performance.now();
    const dt = now - last;
    last = now;
    frames++;
    minDt = Math.min(minDt, dt);
    maxDt = Math.max(maxDt, dt);
    sumDt += dt;
    if (dt > 20) longFrames++;
    if (dt > 33) jankFrames++;

    if (now - windowStart >= intervalSec * 1000) {
      const elapsed = (now - windowStart) / 1000;
      const fps = frames / elapsed;
      const avg = sumDt / frames;
      const lanes = [...laneStats.values()];
      const gpuLanes = lanes.filter((l) => l.gpu).length;
      const laneDraw = lanes.reduce((a, l) => a + l.drawMs, 0);
      console.log(
        `[perf] ${fps.toFixed(1)} fps | frame avg ${avg.toFixed(1)}ms ` +
          `(min ${minDt.toFixed(1)} / max ${maxDt.toFixed(1)}) | ` +
          `long(>20ms) ${longFrames} jank(>33ms) ${jankFrames} of ${frames} | ` +
          `lanes ${lanes.length} (gpu ${gpuLanes}) draw ${laneDraw.toFixed(2)}ms`,
      );
      frames = 0;
      windowStart = now;
      minDt = Infinity;
      maxDt = 0;
      sumDt = 0;
      longFrames = 0;
      jankFrames = 0;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
