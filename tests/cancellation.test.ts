/**
 * Render cancellation lifecycle tests (Req 4.7, 4.8, 4.18–4.22; Properties 6, 18).
 *
 * Deterministic: `setTimeout`/`setInterval`/`Date` are faked; real
 * `setImmediate` is kept for the renderer's per-slide yield. `fluent-ffmpeg`
 * is replaced by a scripted command whose `kill(signal)` is **recorded
 * separately** from the child process's `exit`, so tests distinguish "signal
 * sent" from "process actually exited". `canvas` is wrapped to count frame
 * preparation per slide.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import { EventEmitter } from "events";
import type { PassThrough } from "stream";

// ---------------------------------------------------------------------------
// Scripted fluent-ffmpeg with separate signal and exit control
// ---------------------------------------------------------------------------

type ScriptEvent =
  | { at: number; event: "progress"; frames: number }
  | { at: number; event: "partial" }
  | { at: number; event: "end" }
  | { at: number; event: "error"; message: string };

interface FakeChild extends EventEmitter {
  exitCode: number | null;
  signalCode: string | null;
}

const ff = vi.hoisted(() => ({
  script: [] as unknown[],
  /** Delay after each signal before the child exits; null = the signal is ignored. */
  exitOn: { SIGTERM: null as number | null, SIGKILL: null as number | null },
  signals: [] as { sig: string; t: number }[],
  runCalledAt: null as number | null,
  child: null as unknown,
  outputs: [] as string[],
  canvasCount: 0,
  /** Make the running encoder finish on its own (exit 0 + "end"). */
  finish: null as null | (() => void),
}));

vi.mock("canvas", async (importOriginal) => {
  const actual = await importOriginal<typeof import("canvas")>();
  return {
    ...actual,
    createCanvas: (...args: Parameters<typeof actual.createCanvas>) => {
      ff.canvasCount++;
      return actual.createCanvas(...args);
    },
  };
});

vi.mock("fluent-ffmpeg", () => {
  const factory = (): unknown => {
    const em = new EventEmitter();
    let outPath = "";
    const exitChild = (child: FakeChild, code: number | null, sig: string | null): boolean => {
      if (child.exitCode !== null || child.signalCode !== null) return false;
      child.exitCode = code;
      child.signalCode = sig;
      child.emit("exit", code, sig);
      return true;
    };
    const cmd = {
      ffmpegProc: undefined as FakeChild | undefined,
      input(stream: PassThrough) {
        stream.on("error", () => {});
        stream.resume();
        return cmd;
      },
      inputOptions: () => cmd,
      outputOptions: () => cmd,
      output(p: string) {
        outPath = p;
        ff.outputs.push(p);
        return cmd;
      },
      on(ev: string, fn: (...a: unknown[]) => void) {
        em.on(ev, fn);
        return cmd;
      },
      kill(sig: string) {
        ff.signals.push({ sig, t: Date.now() });
        const delay = (ff.exitOn as Record<string, number | null>)[sig];
        const child = cmd.ffmpegProc;
        if (delay === null || delay === undefined || !child) return;
        setTimeout(() => {
          if (exitChild(child, null, sig)) em.emit("error", new Error(`ffmpeg was killed with signal ${sig}`));
        }, delay);
      },
      run() {
        ff.runCalledAt = Date.now();
        const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }) as FakeChild;
        cmd.ffmpegProc = child;
        ff.child = child;
        em.emit("start", "ffmpeg (scripted)");
        (ff as unknown as { emitEnd?: () => void }).emitEnd = () => em.emit("end");
        ff.finish = () => {
          fs.writeFileSync(outPath, "mp4");
          exitChild(child, 0, null);
          em.emit("end");
        };
        for (const raw of ff.script) {
          const e = raw as ScriptEvent;
          setTimeout(() => {
            if (e.event === "progress") {
              if (child.exitCode === null && child.signalCode === null) em.emit("progress", { frames: e.frames });
            } else if (e.event === "partial") {
              fs.writeFileSync(outPath, "partial mp4");
            } else if (e.event === "end") {
              fs.writeFileSync(outPath, "mp4");
              exitChild(child, 0, null);
              em.emit("end");
            } else {
              exitChild(child, 1, null);
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

import express from "express";
import request from "supertest";
import { VideoRenderer, KILL_GRACE_MS, transition } from "../src/server/renderer.js";
import { VIDEO_CONFIG } from "../src/config/output.js";
import type { RenderJob, Slide } from "../src/types/index.js";

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

const T = VIDEO_CONFIG.cancelTimeoutSeconds * 1000;
const realImmediate = (): Promise<void> => new Promise((r) => (globalThis as { setImmediate: (f: () => void) => void }).setImmediate(r));
const slides = (n: number): Slide[] => Array.from({ length: n }, (_, i) => ({ id: String(i), type: "feature", title: `S${i}`, body: "b", previewSummary: "" }));

/** Advance fake time in small steps, letting one real macrotask run per step. */
async function advance(ms: number, step = 25): Promise<void> {
  for (let t = 0; t < ms; t += step) {
    await vi.advanceTimersByTimeAsync(step);
    await realImmediate();
  }
}

/** Advance until `cond()` is true (bounded). */
async function until(cond: () => boolean, maxMs = 20_000): Promise<void> {
  for (let t = 0; !cond() && t < maxMs; t += 25) await advance(25);
  if (!cond()) throw new Error("condition not reached");
}

interface Running {
  renderer: VideoRenderer;
  job: RenderJob;
  emissions: number[];
  settled: { value?: RenderJob; error?: unknown; done: boolean };
}

/** Create a job and start running it without awaiting. */
function startRender(n: number, renderer = new VideoRenderer()): Running {
  const job = renderer.createJob();
  const emissions: number[] = [];
  const settled: Running["settled"] = { done: false };
  renderer.run(job.id, slides(n), (p) => emissions.push(p), VIDEO_CONFIG.minDurationSeconds).then(
    (v) => Object.assign(settled, { value: v, done: true }),
    (e) => Object.assign(settled, { error: e, done: true }),
  );
  return { renderer, job, emissions, settled };
}

/** Start cancellation without awaiting; record its outcome and time. */
function startCancel(r: VideoRenderer, id: string) {
  const out = { done: false, ok: false, error: undefined as unknown, at: 0, startedAt: Date.now() };
  r.cancel(id).then(
    () => Object.assign(out, { done: true, ok: true, at: Date.now() }),
    (e) => Object.assign(out, { done: true, ok: false, error: e, at: Date.now() }),
  );
  return out;
}

const child = (): FakeChild => ff.child as FakeChild;
const exited = (): boolean => child().exitCode !== null || child().signalCode !== null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  Object.assign(ff, { script: [], signals: [], runCalledAt: null, child: null, canvasCount: 0, finish: null });
  ff.exitOn = { SIGTERM: null, SIGKILL: null };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const p of ff.outputs) fs.rmSync(p, { force: true, recursive: true });
  ff.outputs = [];
});

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

describe("transition (guarded state machine)", () => {
  const job = (status: RenderJob["status"]): RenderJob => ({ id: "x", status, outputPath: null, fileSizeBytes: null, errorMessage: null, sizeWarning: false, completedAtMs: null });

  it("allows only pending→rendering|cancelled and rendering→complete|failed|cancelled", () => {
    const all = ["pending", "rendering", "complete", "failed", "cancelled"] as const;
    const allowed = new Set(["pending>rendering", "pending>cancelled", "rendering>complete", "rendering>failed", "rendering>cancelled"]);
    for (const from of all) for (const to of all) {
      const j = job(from);
      expect(transition(j, all, to), `${from}>${to}`).toBe(allowed.has(`${from}>${to}`));
    }
  });

  it("terminal states never change, including cancelled→complete", () => {
    for (const s of ["complete", "failed", "cancelled"] as const) {
      const j = job(s);
      for (const to of ["pending", "rendering", "complete", "failed", "cancelled"] as const) transition(j, [s], to);
      expect(j.status).toBe(s);
    }
  });
});

// ---------------------------------------------------------------------------
// Property 6: termination with confirmed exit
// ---------------------------------------------------------------------------

describe("Property 6: cancellation terminates the encoder within the timeout", () => {
  it("race 7: SIGTERM, then the process exits — SIGKILL is never sent", async () => {
    ff.exitOn.SIGTERM = 200;
    ff.script = [{ at: 0, event: "partial" }, { at: 60_000, event: "end" }];
    const r = startRender(3);
    await until(() => ff.runCalledAt !== null && fs.existsSync(r.job.outputPath!));
    const c = startCancel(r.renderer, r.job.id);

    // Signal sent, but the process has not exited: cancellation must not have settled.
    await advance(100);
    expect(ff.signals.map((s) => s.sig)).toEqual(["SIGTERM"]);
    expect(exited()).toBe(false);
    expect(c.done).toBe(false);

    await until(() => c.done);
    expect(exited()).toBe(true);
    expect(c.ok).toBe(true);
    expect(ff.signals.map((s) => s.sig)).toEqual(["SIGTERM"]);
    expect(c.at - c.startedAt).toBeLessThan(T);
    expect(r.job.status).toBe("cancelled");
    expect(fs.existsSync(r.job.outputPath!)).toBe(false);
    await until(() => r.settled.done);
    expect(r.settled.value?.status).toBe("cancelled");
    expect(child().listenerCount("exit")).toBe(0);
  });

  it("race 8: SIGTERM ignored — SIGKILL at KILL_GRACE_MS, exit observed before the deadline", async () => {
    ff.exitOn.SIGKILL = 100;
    ff.script = [{ at: 0, event: "partial" }, { at: 60_000, event: "end" }];
    const r = startRender(3);
    await until(() => ff.runCalledAt !== null);
    const c = startCancel(r.renderer, r.job.id);

    await advance(KILL_GRACE_MS - 100);
    expect(ff.signals.map((s) => s.sig)).toEqual(["SIGTERM"]);
    expect(c.done).toBe(false);

    await until(() => c.done);
    const kill = ff.signals.find((s) => s.sig === "SIGKILL")!;
    expect(ff.signals.map((s) => s.sig)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(kill.t - c.startedAt).toBeGreaterThanOrEqual(KILL_GRACE_MS);
    expect(kill.t - c.startedAt).toBeLessThan(T);
    expect(exited()).toBe(true);
    expect(c.ok).toBe(true);
    expect(c.at - c.startedAt).toBeLessThanOrEqual(T);
    expect(r.job.status).toBe("cancelled");
    expect(fs.existsSync(r.job.outputPath!)).toBe(false);
  });

  it("exit never confirmed: rejects at the deadline as a cancellation-termination failure; job stays cancelled", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    ff.script = [{ at: 0, event: "partial" }];
    const r = startRender(3);
    await until(() => ff.runCalledAt !== null && fs.existsSync(r.job.outputPath!));
    const c = startCancel(r.renderer, r.job.id);
    await until(() => c.done);

    expect(c.ok).toBe(false);
    expect(String((c.error as Error).message)).toMatch(/Cancellation-termination failure/);
    expect(c.at - c.startedAt).toBeGreaterThanOrEqual(T);
    expect(c.at - c.startedAt).toBeLessThan(T + 100);
    expect(ff.signals.map((s) => s.sig)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(exited()).toBe(false);
    expect(r.job.status).toBe("cancelled");
    expect(fs.existsSync(r.job.outputPath!)).toBe(false);
    expect(errors).toHaveBeenCalled();

    // The surviving process stays observed; its late exit is recorded and the listener removed.
    child().signalCode = "SIGKILL";
    child().emit("exit", null, "SIGKILL");
    expect(warns).toHaveBeenCalledWith(expect.stringContaining("exited after the cancellation deadline"));
    expect(child().listenerCount("exit")).toBe(0);
    expect(r.job.status).toBe("cancelled");
  });

  it("frame preparation stops at the next slide boundary; no encoder, so no signal is needed", async () => {
    const r = startRender(15);
    await until(() => ff.canvasCount >= 3);
    const c = startCancel(r.renderer, r.job.id);
    await until(() => c.done && r.settled.done);
    expect(c.ok).toBe(true);
    expect(ff.canvasCount).toBeLessThan(15);
    expect(ff.runCalledAt).toBeNull();
    expect(ff.signals).toEqual([]);
    expect(r.settled.value?.status).toBe("cancelled");
  });

  it("a pending job: cancel needs no signal, and run() then does no work", async () => {
    const renderer = new VideoRenderer();
    const job = renderer.createJob();
    await renderer.cancel(job.id);
    expect(job.status).toBe("cancelled");
    const emissions: number[] = [];
    const result = await renderer.run(job.id, slides(5), (p) => emissions.push(p));
    expect(result.status).toBe("cancelled");
    expect(ff.canvasCount).toBe(0);
    expect(ff.runCalledAt).toBeNull();
    expect(emissions).toEqual([]);
  });

  it("race 2: ffmpeg 'end' during cancellation cannot complete the job", async () => {
    ff.script = [{ at: 0, event: "partial" }];
    const r = startRender(3);
    await until(() => ff.runCalledAt !== null);
    const c = startCancel(r.renderer, r.job.id);
    // The encoder finishes on its own (writes the MP4, exits 0, emits "end") while SIGTERM is ignored.
    setTimeout(() => ff.finish!(), 50);
    await until(() => c.done && r.settled.done);
    expect(c.ok).toBe(true);
    expect(r.job.status).toBe("cancelled");
    expect(r.job.fileSizeBytes).toBeNull();
    expect(r.job.completedAtMs).toBeNull();
    expect(fs.existsSync(r.job.outputPath!)).toBe(false);
  });

  it("race 2b: 'end' reaches run() while cancellation is still waiting for exit — the guard keeps it cancelled", async () => {
    ff.script = [];
    const r = startRender(2);
    await until(() => ff.runCalledAt !== null);
    const c = startCancel(r.renderer, r.job.id);
    await advance(50);
    // The encoder reports "end" and leaves a finished MP4, but its process has not exited yet.
    fs.writeFileSync(r.job.outputPath!, "finished mp4");
    (ff as unknown as { emitEnd?: () => void }).emitEnd?.();
    await until(() => r.settled.done);
    expect(r.job.status).toBe("cancelled");
    expect(r.job.completedAtMs).toBeNull();
    expect(c.done).toBe(false);
    // Process exit then confirms cancellation; the file is removed.
    child().signalCode = "SIGTERM";
    child().emit("exit", null, "SIGTERM");
    await until(() => c.done);
    expect(c.ok).toBe(true);
    expect(r.job.status).toBe("cancelled");
    expect(fs.existsSync(r.job.outputPath!)).toBe(false);
  });

  it("race 3: ffmpeg 'error' after SIGTERM / SIGKILL leaves the job cancelled, not failed, and run() resolves", async () => {
    for (const exitOn of [{ SIGTERM: 10, SIGKILL: null }, { SIGTERM: null, SIGKILL: 10 }]) {
      Object.assign(ff, { signals: [], runCalledAt: null });
      ff.exitOn = exitOn;
      ff.script = [{ at: 60_000, event: "end" }];
      const r = startRender(2);
      await until(() => ff.runCalledAt !== null);
      const c = startCancel(r.renderer, r.job.id);
      await until(() => c.done && r.settled.done);
      expect(c.ok).toBe(true);
      expect(r.job.status).toBe("cancelled");
      expect(r.job.errorMessage).toBeNull();
      expect(r.settled.error).toBeUndefined();
      expect(r.settled.value?.status).toBe("cancelled");
    }
  });

  it("no progress is emitted after cancellation, even while ffmpeg still reports progress before exiting", async () => {
    // SIGTERM exit is delayed so the encoder keeps reporting frames during cancellation.
    ff.exitOn.SIGTERM = KILL_GRACE_MS - 100;
    ff.script = [
      { at: 0, event: "partial" },
      // Fired after cancellation starts (cancel begins at ≈ one progress interval).
      { at: VIDEO_CONFIG.progressIntervalMs + 200, event: "progress", frames: 10 },
      { at: VIDEO_CONFIG.progressIntervalMs + 400, event: "progress", frames: 20 },
      { at: 60_000, event: "end" },
    ];
    const r = startRender(2);
    await until(() => ff.runCalledAt !== null);
    // Let the heartbeat emit at least once so the test proves emissions were live.
    await advance(VIDEO_CONFIG.progressIntervalMs);
    const beforeCancel = r.emissions.length;
    expect(beforeCancel).toBeGreaterThan(0);

    const c = startCancel(r.renderer, r.job.id);
    await until(() => c.done && r.settled.done);
    await advance(VIDEO_CONFIG.progressIntervalMs * 2);
    expect(c.ok).toBe(true);
    expect(r.emissions.length).toBe(beforeCancel);
    expect(r.emissions).not.toContain(100);
    expect(r.settled.value?.status).toBe("cancelled");
    expect(r.job.errorMessage).toBeNull();
  });

  it("no timers or exit listeners remain after cancellation settles", async () => {
    ff.exitOn.SIGTERM = 5;
    ff.script = [];
    const r = startRender(2);
    await until(() => ff.runCalledAt !== null);
    const c = startCancel(r.renderer, r.job.id);
    await until(() => c.done && r.settled.done);
    expect(vi.getTimerCount()).toBe(0);
    expect(child().listenerCount("exit")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Property 18: one outcome, idempotent cancellation
// ---------------------------------------------------------------------------

describe("Property 18: one terminal outcome; idempotent cancellation", () => {
  it("race 1: DELETE and disconnect at the same instant share one cancellation", async () => {
    ff.exitOn.SIGTERM = 50;
    ff.script = [{ at: 60_000, event: "end" }];
    const r = startRender(2);
    await until(() => ff.runCalledAt !== null);
    const fromDelete = startCancel(r.renderer, r.job.id);
    const fromDisconnect = startCancel(r.renderer, r.job.id);
    // Neither caller (e.g. DELETE's 204) may settle before encoder exit is confirmed.
    await advance(25);
    expect(exited()).toBe(false);
    expect(fromDelete.done || fromDisconnect.done).toBe(false);
    await until(() => fromDelete.done && fromDisconnect.done);
    expect(exited()).toBe(true);
    expect(Math.min(fromDelete.at, fromDisconnect.at)).toBeGreaterThanOrEqual(fromDelete.startedAt + 50);
    expect(fromDelete.ok && fromDisconnect.ok).toBe(true);
    expect(ff.signals.map((s) => s.sig)).toEqual(["SIGTERM"]);
    expect(r.job.status).toBe("cancelled");
  });

  it("race 5: repeated cancel after cancelled is a no-op", async () => {
    ff.exitOn.SIGTERM = 5;
    const r = startRender(2);
    await until(() => ff.runCalledAt !== null);
    const first = startCancel(r.renderer, r.job.id);
    await until(() => first.done);
    const before = ff.signals.length;
    const again = startCancel(r.renderer, r.job.id);
    await until(() => again.done);
    expect(again.ok).toBe(true);
    expect(ff.signals.length).toBe(before);
    expect(r.job.status).toBe("cancelled");
  });

  it("race 6: cancel after complete keeps the MP4 and the job complete", async () => {
    ff.script = [{ at: 100, event: "end" }];
    const r = startRender(2);
    await until(() => r.settled.done);
    expect(r.job.status).toBe("complete");
    const c = startCancel(r.renderer, r.job.id);
    await until(() => c.done);
    expect(c.ok).toBe(true);
    expect(r.job.status).toBe("complete");
    expect(fs.existsSync(r.job.outputPath!)).toBe(true);
    expect(ff.signals).toEqual([]);
  });

  it("race 4: completion that wins first is never undone by a later cancel", async () => {
    ff.script = [{ at: 0, event: "end" }];
    const r = startRender(1);
    await until(() => r.settled.done);
    await r.renderer.cancel(r.job.id);
    expect(r.job.status).toBe("complete");
  });
});

// ---------------------------------------------------------------------------
// Requirement 4.7: failed-render cleanup
// ---------------------------------------------------------------------------

describe("Req 4.7: a failed render deletes its partial output", () => {
  it("partial output exists → render fails → job failed, output deleted, no signal sent", async () => {
    ff.script = [{ at: 0, event: "partial" }, { at: 200, event: "error", message: "encoder crashed" }];
    const r = startRender(2);
    await until(() => ff.runCalledAt !== null && fs.existsSync(r.job.outputPath!));
    await until(() => r.settled.done);
    expect((r.settled.error as Error).message).toBe("encoder crashed");
    expect(r.job.status).toBe("failed");
    expect(fs.existsSync(r.job.outputPath!)).toBe(false);
    expect(ff.signals).toEqual([]);
  });

  it("a cleanup error keeps the original failure and makes no second transition", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    ff.script = [{ at: 200, event: "error", message: "encoder crashed" }];
    const r = startRender(2);
    await until(() => ff.runCalledAt !== null);
    // Make deletion fail: a directory with content at the output path.
    fs.mkdirSync(r.job.outputPath!, { recursive: true });
    fs.writeFileSync(`${r.job.outputPath!}/x`, "x");
    await until(() => r.settled.done);
    expect((r.settled.error as Error).message).toBe("encoder crashed");
    expect(r.job.status).toBe("failed");
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("failed to delete partial output"));
  });
});

// ---------------------------------------------------------------------------
// Routes with the real renderer: DELETE semantics and download (real timers)
// ---------------------------------------------------------------------------

describe("DELETE and download through the real routes", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  async function appWith(renderer: VideoRenderer): Promise<express.Express> {
    vi.resetModules();
    vi.doMock("../src/server/renderer.js", async () => {
      const actual = await vi.importActual<typeof import("../src/server/renderer.js")>("../src/server/renderer.js");
      return { ...actual, videoRenderer: renderer };
    });
    const { router, apiErrorHandler } = await import("../src/server/routes.js");
    const app = express();
    app.use("/api", router);
    app.use(apiErrorHandler);
    return app;
  }

  it("unknown job → 404; complete job DELETE → 204, file kept, download still works", async () => {
    const renderer = new VideoRenderer();
    const app = await appWith(renderer);
    expect((await request(app).delete("/api/render/nope")).status).toBe(404);

    const job = renderer.createJob();
    fs.writeFileSync(job.outputPath!, "finished");
    ff.outputs.push(job.outputPath!);
    transition(job, ["pending"], "rendering");
    transition(job, ["rendering"], "complete");
    job.completedAtMs = Date.now();
    expect((await request(app).delete(`/api/render/${job.id}`)).status).toBe(204);
    expect((await request(app).delete(`/api/render/${job.id}`)).status).toBe(204);
    expect(fs.existsSync(job.outputPath!)).toBe(true);
    expect((await request(app).get(`/api/download/${job.id}`)).status).toBe(200);
  });

  it("cancelled and failed jobs are not downloadable (409); repeated DELETE → 204", async () => {
    const renderer = new VideoRenderer();
    const app = await appWith(renderer);
    const cancelled = renderer.createJob();
    expect((await request(app).delete(`/api/render/${cancelled.id}`)).status).toBe(204);
    expect(cancelled.status).toBe("cancelled");
    expect((await request(app).delete(`/api/render/${cancelled.id}`)).status).toBe(204);
    expect((await request(app).get(`/api/download/${cancelled.id}`)).status).toBe(409);

    const failed = renderer.createJob();
    transition(failed, ["pending"], "rendering");
    transition(failed, ["rendering"], "failed");
    expect((await request(app).get(`/api/download/${failed.id}`)).status).toBe(409);
    expect((await request(app).delete(`/api/render/${failed.id}`)).status).toBe(204);
    expect(failed.status).toBe("failed");
  });
});
