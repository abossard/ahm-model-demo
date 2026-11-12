import type { Page } from "@playwright/test";

export interface FrameStats {
  readonly frames: number;
  readonly p50: number;
  readonly p95: number;
  readonly work50: number;
  readonly work95: number;
  readonly workMax: number;
  readonly wheels: number;
  readonly commits: number;
  /** How often the plot drew itself. */
  readonly draws: number;
}

/**
 * Counts what a gesture costs, from before the app loads: the script time of every animation frame (the plot draws inside
 * one), the wheel events the page saw and the commits React made. React reports a commit to the devtools hook it finds.
 */
export async function instrument(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __perf: { work: Map<number, number>; frames: number[]; wheels: number; commits: number; draws: number; on: boolean }; __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown };
    w.__perf = { work: new Map(), frames: [], wheels: 0, commits: 0, draws: 0, on: false };
    // The plot clears its canvas once per draw.
    const clearRect = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      w.__perf.draws += 1;
      clearRect.apply(this, args);
    };
    w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      isDisabled: false,
      renderers: new Map(),
      inject: () => 1,
      checkDCE: () => undefined,
      onCommitFiberUnmount: () => undefined,
      onPostCommitFiberRoot: () => undefined,
      onCommitFiberRoot: () => {
        w.__perf.commits += 1;
      },
    };
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) =>
      raf((time) => {
        const start = performance.now();
        callback(time);
        if (w.__perf.on) w.__perf.work.set(time, (w.__perf.work.get(time) ?? 0) + performance.now() - start);
      });
    window.addEventListener("wheel", () => (w.__perf.wheels += 1), { capture: true, passive: true });
    let last = 0;
    const tick = (now: number): void => {
      if (w.__perf.on && last > 0) w.__perf.frames.push(now - last);
      last = now;
      raf(tick);
    };
    raf(tick);
  });
}

/** The frames, the frame work, the wheel events and the React commits while `drive` runs. */
export async function measure(page: Page, drive: () => Promise<void>): Promise<FrameStats> {
  await page.evaluate(() => {
    const perf = (window as unknown as { __perf: { work: Map<number, number>; frames: number[]; wheels: number; commits: number; draws: number; on: boolean } }).__perf;
    perf.work.clear();
    perf.frames.length = 0;
    perf.wheels = 0;
    perf.commits = 0;
    perf.draws = 0;
    perf.on = true;
  });
  await drive();
  const raw = await page.evaluate(() => {
    const perf = (window as unknown as { __perf: { work: Map<number, number>; frames: number[]; wheels: number; commits: number; draws: number; on: boolean } }).__perf;
    perf.on = false;
    return { work: [...perf.work.values()], frames: perf.frames, wheels: perf.wheels, commits: perf.commits, draws: perf.draws };
  });
  const pick = (values: readonly number[], q: number): number => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  };
  return {
    frames: raw.frames.length,
    p50: pick(raw.frames, 0.5),
    p95: pick(raw.frames, 0.95),
    work50: pick(raw.work, 0.5),
    work95: pick(raw.work, 0.95),
    workMax: pick(raw.work, 1),
    wheels: raw.wheels,
    commits: raw.commits,
    draws: raw.draws,
  };
}

/** Prints what a gesture cost. The numbers are the result: a bound on a frame interval flakes on a loaded machine. */
export const report = (name: string, stats: FrameStats): void =>
  console.log(
    `${name}: frames n=${stats.frames} p50=${stats.p50.toFixed(1)}ms p95=${stats.p95.toFixed(1)}ms, frame work p50=${stats.work50.toFixed(2)}ms p95=${stats.work95.toFixed(2)}ms max=${stats.workMax.toFixed(2)}ms, wheel events=${stats.wheels}, plot draws=${stats.draws}, React commits=${stats.commits}`,
  );
