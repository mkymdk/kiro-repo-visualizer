/**
 * Progress heartbeat tests (Req 4.3, 4.17, 4.18; Property 16).
 *
 * Deterministic: `setInterval`/`setTimeout`/`Date` are faked; `fluent-ffmpeg`
 * is replaced by a scripted emitter whose events fire at fake times. Real
 * `setImmediate` is kept so the renderer's per-slide yield is exercised: the
 * driver advances fake time in steps and lets one real macrotask run per step.
 * No wall-clock sleeps.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import { EventEmitter } from "events";
import type { PassThrough } from "stream";

// ---------------------------------------------------------------------------
// Scripted fluent-ffmpeg
// ---------------------------------------------------------------------------

type ScriptEvent = { at: number; event: "progress"; frames: number } | { at: number; event: "end" } | { at: number; event: "error"; message: string };

const ffmpegState = vi.hoisted(() => ({
  script: [] as unknown[],
  runCalledAt: null as number | null,
  outputs: [] as string[],
  breakWrites: false,
}));

vi.mock("fluent-ffmpeg", () => {
  const factory = (): unknown => {
    const em = new EventEmitter();
    let outPath = "";
    const cmd = {
      input(stream: PassThrough) {
        // Like fluent-ffmpeg, own the input stream's error event.
        stream.on("error", () => {});
        if (ffmpegState.breakWrites) {
          stream.write = (() => {
            throw new Error("EPIPE: encoder closed");
          }) as typeof stream.write;
        } else {
          stream.resume(); // consume frames so backpressure resolves
        }
        return cmd;
      },
      inputOptions: () => cmd,
      outputOptions: () => cmd,
      output(p: string) {
        outPath = p;
        ffmpegState.outputs.push(p);
        return cmd;
      },
      on(ev: string, fn: (...a: unknown[]) => void) {
        em.on(ev, fn);
        return cmd;
      },
      ffmpegProc: undefined as (EventEmitter & { exitCode: number | null; signalCode: string | null }) | undefined,
      kill(sig: string) {
        // A killed child exits right away here; tests/cancellation.test.ts scripts exit separately.
        const proc = cmd.ffmpegProc;
        if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
        setTimeout(() => {
          proc.signalCode = sig;
          proc.emit("exit", null, sig);
          em.emit("error", new Error(`ffmpeg was killed with signal ${sig}`));
        }, 0);
      },
      run() {
        ffmpegState.runCalledAt = Date.now();
        const proc = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null as string | null });
        cmd.ffmpegProc = proc;
        em.emit("start", "ffmpeg (scripted)");
        for (const raw of ffmpegState.script) {
          const e = raw as ScriptEvent;
          setTimeout(() => {
            if (proc.exitCode !== null || proc.signalCode !== null) return;
            if (e.event === "progress") em.emit("progress", { frames: e.frames });
            else if (e.event === "end") {
              fs.writeFileSync(outPath, "mp4");
              proc.exitCode = 0;
              proc.emit("exit", 0, null);
              em.emit("end");
            } else {
              proc.exitCode = 1;
              proc.emit("exit", 1, null);
              em.emit("error", new Error(e.message));
            }
          }, e.at);
        }
      },
    };
    return cmd;
  };
  factory.setFfmpegPath = (): void => {};
  return { default: factory };
});

import { VideoRenderer, ProgressTracker, HEARTBEAT_MS, FRAME_PHASE_WEIGHT, calculateSecondsPerSlide } from "../src/server/renderer.js";
import { VIDEO_CONFIG } from "../src/config/output.js";
import type { Slide } from "../src/types/index.js";

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

const realImmediate = (): Promise<void> => new Promise((r) => (globalThis as { setImmediate: (f: () => void) => void }).setImmediate(r));

const slide = (i: number): Slide => ({ id: String(i), type: "feature", title: `Slide ${i}`, body: `Body ${i}`, previewSummary: "" });
const slides = (n: number): Slide[] => Array.from({ length: n }, (_, i) => slide(i));

interface Emission {
  t: number;
  percent: number;
  encoderStarted: boolean;
}

/** Run a render to completion under fake time and record every emission. */
async function drive(
  n: number,
  script: ScriptEvent[],
  opts: { step?: number; onTick?: (t: number, r: VideoRenderer) => Promise<void> | void } = {},
): Promise<{ emissions: Emission[]; outcome: "ok" | "failed"; error?: unknown; renderer: VideoRenderer; t0: number }> {
  ffmpegState.script = script;
  const renderer = new VideoRenderer();
  const emissions: Emission[] = [];
  const t0 = Date.now();
  let outcome: "ok" | "failed" | null = null;
  let error: unknown;
  const p = renderer
    .start(slides(n), (percent) => emissions.push({ t: Date.now() - t0, percent, encoderStarted: ffmpegState.runCalledAt !== null }), VIDEO_CONFIG.minDurationSeconds)
    .then(
      () => (outcome = "ok"),
      (e) => {
        outcome = "failed";
        error = e;
      },
    );
  const step = opts.step ?? 100;
  for (let i = 0; outcome === null && i < 5000; i++) {
    await vi.advanceTimersByTimeAsync(step);
    await realImmediate();
    await opts.onTick?.(Date.now() - t0, renderer);
  }
  await p;
  return { emissions, outcome: outcome!, error, renderer, t0 };
}

const gaps = (e: Emission[]): number[] => e.slice(1).map((x, i) => x.t - e[i]!.t);
const totalFrames = (n: number): number => calculateSecondsPerSlide(n, VIDEO_CONFIG.minDurationSeconds) * VIDEO_CONFIG.fps * n;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  ffmpegState.script = [];
  ffmpegState.runCalledAt = null;
  ffmpegState.breakWrites = false;
});

afterEach(() => {
  vi.useRealTimers();
  for (const p of ffmpegState.outputs) fs.rmSync(p, { force: true });
  ffmpegState.outputs = [];
});

// ---------------------------------------------------------------------------
// ProgressTracker unit
// ---------------------------------------------------------------------------

describe("ProgressTracker", () => {
  it(`HEARTBEAT_MS is derived from progressIntervalMs (${VIDEO_CONFIG.progressIntervalMs} / 2)`, () => {
    expect(HEARTBEAT_MS).toBe(VIDEO_CONFIG.progressIntervalMs / 2);
  });

  it("emits immediately on start, then on every heartbeat, even without updates", () => {
    const out: number[] = [];
    const t = new ProgressTracker((p) => out.push(p));
    t.start();
    expect(out).toEqual([0]);
    vi.advanceTimersByTime(HEARTBEAT_MS * 3);
    expect(out).toEqual([0, 0, 0, 0]);
    t.stop();
  });

  it("update() never emits; only the heartbeat does", () => {
    const out: number[] = [];
    const t = new ProgressTracker((p) => out.push(p));
    t.start();
    for (let i = 0; i < 50; i++) t.update(i / 100);
    expect(out).toEqual([0]);
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(out).toEqual([0, 49]);
    t.stop();
  });

  it("is monotonic, clamps, ignores non-finite values, and caps at 99", () => {
    const t = new ProgressTracker(() => {});
    t.update(0.5);
    t.update(0.2);
    expect(t.current).toBe(50);
    t.update(Number.NaN);
    t.update(-3);
    expect(t.current).toBe(50);
    t.update(1);
    t.update(7);
    expect(t.current).toBe(99);
  });

  it("stop() is idempotent, clears the timer, and makes later calls no-ops", () => {
    const out: number[] = [];
    const t = new ProgressTracker((p) => out.push(p));
    t.start();
    t.stop();
    t.stop();
    expect(vi.getTimerCount()).toBe(0);
    t.update(0.9);
    t.start();
    vi.advanceTimersByTime(HEARTBEAT_MS * 5);
    expect(out).toEqual([0]);
  });
});

// ---------------------------------------------------------------------------
// VideoRenderer.start cadence (Property 16)
// ---------------------------------------------------------------------------

describe("render cadence is independent of the encoder", () => {
  const LIMIT = VIDEO_CONFIG.progressIntervalMs;

  it.each<[string, (tf: number) => ScriptEvent[]]>([
    ["no ffmpeg reports at all", () => [{ at: 8_000, event: "end" }]],
    ["a single report", (tf) => [{ at: 3_000, event: "progress", frames: tf / 2 }, { at: 6_000, event: "end" }]],
    [
      "reports just before the 2 s boundary (+1,999 / +3,998 ms)",
      (tf) => [
        { at: 1_999, event: "progress", frames: tf / 4 },
        { at: 3_998, event: "progress", frames: tf / 2 },
        { at: 5_997, event: "progress", frames: (3 * tf) / 4 },
        { at: 7_996, event: "end" },
      ],
    ],
    ["a burst of reports", (tf) => [...Array.from({ length: 25 }, (_, i) => ({ at: 4_000 + i, event: "progress" as const, frames: (tf * i) / 25 })), { at: 9_000, event: "end" }]],
    ["a long silent encode", () => [{ at: 30_000, event: "end" }]],
  ])("max gap ≤ progressIntervalMs with %s", async (_label, script) => {
    const { emissions, outcome } = await drive(5, script(totalFrames(5)));
    expect(outcome).toBe("ok");
    expect(emissions.length).toBeGreaterThan(2);
    expect(Math.max(...gaps(emissions))).toBeLessThanOrEqual(LIMIT);
    expect(emissions[0]!.t).toBe(0);
  });

  it("covers frame preparation: heartbeats fire between slides, before the encoder starts", async () => {
    // 15 slides with a coarse step: the frame loop yields after each slide, so
    // fake time passes and the heartbeat reports frame-phase values (< 10).
    const { emissions } = await drive(15, [{ at: 2_000, event: "end" }], { step: 400 });
    const framePhase = emissions.filter((e) => !e.encoderStarted);
    expect(framePhase.length).toBeGreaterThan(1);
    expect(framePhase.some((e) => e.percent > 0 && e.percent < FRAME_PHASE_WEIGHT * 100)).toBe(true);
    expect(Math.max(...gaps(emissions))).toBeLessThanOrEqual(LIMIT);
  });

  it("values never decrease and stay ≤ 99, even when ffmpeg reports 100% or goes backwards", async () => {
    const tf = totalFrames(4);
    const { emissions } = await drive(4, [
      { at: 1_500, event: "progress", frames: tf * 0.9 },
      { at: 2_500, event: "progress", frames: tf * 0.3 },
      { at: 3_500, event: "progress", frames: tf },
      { at: 6_000, event: "end" },
    ]);
    const values = emissions.map((e) => e.percent);
    expect([...values].sort((a, b) => a - b)).toEqual(values);
    expect(Math.max(...values)).toBe(99);
    expect(values).not.toContain(100);
  });
});

// ---------------------------------------------------------------------------
// Cleanup (Req 4.18)
// ---------------------------------------------------------------------------

describe("heartbeat cleanup", () => {
  it("leaves no timers after success", async () => {
    const { outcome } = await drive(3, [{ at: 3_000, event: "end" }]);
    expect(outcome).toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves no timers after an ffmpeg error", async () => {
    const { outcome } = await drive(3, [{ at: 2_500, event: "error", message: "encoder crashed" }]);
    expect(outcome).toBe("failed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves no timers after a frame-write error", async () => {
    ffmpegState.breakWrites = true;
    const { outcome, error } = await drive(3, [{ at: 60_000, event: "end" }]);
    expect(outcome).toBe("failed");
    expect(String((error as Error).message)).toContain("EPIPE");
    // The scripted end timer is the only one left; the heartbeat is gone.
    expect(vi.getTimerCount()).toBe(1);
  });

  it("abort() stops the heartbeat immediately; nothing is emitted afterwards", async () => {
    let abortedAt: number | null = null;
    const result = await drive(3, [{ at: 9_000, event: "end" }], {
      onTick: async (t, r) => {
        if (abortedAt === null && t >= 4_000) {
          abortedAt = t;
          // Not awaited: cancellation waits for confirmed exit, which needs fake time to advance.
          void r.abort([...r.jobs.keys()][0]!);
        }
      },
    });
    expect(abortedAt).not.toBeNull();
    expect(result.emissions.some((e) => e.t <= abortedAt!)).toBe(true);
    expect(result.emissions.filter((e) => e.t > abortedAt!)).toEqual([]);
    // Let the script's own late "end" timer fire (it is ignored after the kill), then nothing may remain.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(result.emissions.filter((e) => e.t > abortedAt!)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
