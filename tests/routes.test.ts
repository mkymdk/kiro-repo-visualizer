/**
 * Route-level tests for POST /api/render target-duration validation.
 *
 * These verify that `targetDurationSeconds` is validated BEFORE the SSE stream
 * is opened: out-of-range or non-numeric values return a plain HTTP 400 JSON
 * `invalid_input` error with no SSE stream, while in-range and absent values
 * proceed to the (mocked) renderer.
 *
 * The renderer is mocked to avoid requiring a real ffmpeg binary, and the
 * analyzer is mocked to avoid any GitHub network access — the network boundary
 * is the only thing stubbed, matching design.md's Testing Strategy.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Express } from "express";

// ---------------------------------------------------------------------------
// Module mocks — declared before importing the router
// ---------------------------------------------------------------------------

vi.mock("../src/server/analyzer.js", async () => {
  const actual = await vi.importActual<typeof import("../src/server/analyzer.js")>(
    "../src/server/analyzer.js",
  );
  return { ...actual, analyzeRepository: vi.fn() };
});

vi.mock("../src/server/renderer.js", () => {
  const jobs = new Map();
  return {
    videoRenderer: {
      jobs,
      start: vi.fn(),
      run: vi.fn(),
      cancel: vi.fn(async () => {}),
      abort: vi.fn(),
      createJob: vi.fn(() => {
        const job = {
          id: "job-1",
          status: "pending",
          outputPath: "/tmp/job-1.mp4",
          fileSizeBytes: null,
          errorMessage: null,
          sizeWarning: false,
          completedAtMs: null,
        };
        jobs.set(job.id, job);
        return job;
      }),
    },
    buildOutputPath: vi.fn((id: string) => `/tmp/${id}.mp4`),
  };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { videoRenderer } from "../src/server/renderer.js";
import { router, apiErrorHandler } from "../src/server/routes.js";
import { VIDEO_CONFIG } from "../src/config/output.js";
import { RenderJob, Slide } from "../src/types/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  app.use(apiErrorHandler);
  return app;
}

const sampleSlides: Slide[] = [
  { id: "1", type: "intro", title: "Intro", body: "b", previewSummary: "s" },
  { id: "2", type: "architecture", title: "Arch", body: "b", previewSummary: "s" },
  { id: "3", type: "conclusion", title: "End", body: "b", previewSummary: "s" },
];

function completedJob(): RenderJob {
  return {
    id: "job-1",
    status: "complete",
    outputPath: "/tmp/job-1.mp4",
    fileSizeBytes: 1234,
    errorMessage: null,
    sizeWarning: false,
    completedAtMs: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/render — targetDurationSeconds validation", () => {
  let app: Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
  });

  it("rejects a target above the maximum with HTTP 400 invalid_input and opens no SSE stream", async () => {
    const res = await request(app)
      .post("/api/render")
      .send({
        slides: sampleSlides,
        targetDurationSeconds: VIDEO_CONFIG.maxDurationSeconds + 1,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_input");
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.headers["content-type"]).not.toContain("text/event-stream");
    expect(videoRenderer.run).not.toHaveBeenCalled();
  });

  it("rejects a target below the minimum with HTTP 400 invalid_input", async () => {
    const res = await request(app)
      .post("/api/render")
      .send({
        slides: sampleSlides,
        targetDurationSeconds: VIDEO_CONFIG.minDurationSeconds - 1,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_input");
    expect(videoRenderer.run).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric target with HTTP 400 invalid_input", async () => {
    const res = await request(app)
      .post("/api/render")
      .send({ slides: sampleSlides, targetDurationSeconds: "not-a-number" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_input");
    expect(videoRenderer.run).not.toHaveBeenCalled();
  });

  it("accepts an in-range target and passes it to the renderer", async () => {
    vi.mocked(videoRenderer.run).mockResolvedValue(completedJob());
    const inRange = VIDEO_CONFIG.minDurationSeconds + 5;

    const res = await request(app)
      .post("/api/render")
      .send({ slides: sampleSlides, targetDurationSeconds: inRange });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(videoRenderer.run).toHaveBeenCalledTimes(1);
    // Third positional arg is the validated target duration.
    const call = vi.mocked(videoRenderer.run).mock.calls[0];
    expect(call?.[3]).toBe(inRange);
  });

  it("accepts the boundary values (min and max) as in-range", async () => {
    vi.mocked(videoRenderer.run).mockResolvedValue(completedJob());

    for (const boundary of [
      VIDEO_CONFIG.minDurationSeconds,
      VIDEO_CONFIG.maxDurationSeconds,
    ]) {
      vi.mocked(videoRenderer.run).mockClear();
      const res = await request(app)
        .post("/api/render")
        .send({ slides: sampleSlides, targetDurationSeconds: boundary });
      expect(res.status).toBe(200);
      expect(vi.mocked(videoRenderer.run).mock.calls[0]?.[3]).toBe(boundary);
    }
  });

  it("falls back to the derived default when no target is provided", async () => {
    vi.mocked(videoRenderer.run).mockResolvedValue(completedJob());

    const res = await request(app)
      .post("/api/render")
      .send({ slides: sampleSlides });

    expect(res.status).toBe(200);
    expect(videoRenderer.run).toHaveBeenCalledTimes(1);
    // No target passed → third arg is undefined, renderer derives the default.
    const call = vi.mocked(videoRenderer.run).mock.calls[0];
    expect(call?.[3]).toBeUndefined();
  });

  it("still rejects an empty slides array with 422 before duration checks", async () => {
    const res = await request(app)
      .post("/api/render")
      .send({ slides: [], targetDurationSeconds: VIDEO_CONFIG.minDurationSeconds });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("insufficient_content");
    expect(videoRenderer.run).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /api/render — SSE sink (Req 4.17, 4.18; Property 16)
// ---------------------------------------------------------------------------

import { EventEmitter } from "events";
import type { ProgressCallback } from "../src/server/renderer.js";

/** Minimal Express-like response that records SSE writes. */
class FakeSseResponse extends EventEmitter {
  writes: string[] = [];
  headersSent = false;
  writableEnded = false;
  statusCode = 200;
  setHeader(): void {}
  flushHeaders(): void {
    this.headersSent = true;
  }
  write(chunk: string): boolean {
    if (this.writableEnded) throw new Error("write after end");
    this.writes.push(chunk);
    return true;
  }
  end(): void {
    this.writableEnded = true;
  }
  status(code: number): this {
    this.statusCode = code;
    return this;
  }
  json(): this {
    this.writableEnded = true;
    return this;
  }
  /** Parsed SSE data payloads. */
  events(): Record<string, unknown>[] {
    return this.writes.map((w) => JSON.parse(w.replace(/^data: /, "").trim()) as Record<string, unknown>);
  }
}

/** The real POST /render handler from the router stack. */
function renderHandler(): (req: unknown, res: unknown, next: (e?: unknown) => void) => Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Express internals have no public types
  const layer = (router as any).stack.find((l: any) => l.route?.path === "/render" && l.route.methods.post);
  return layer.route.stack[0].handle;
}

describe("POST /api/render — SSE sink", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends exactly one terminal percent:100 event with the jobId, last", async () => {
    let sink: ProgressCallback = () => {};
    vi.mocked(videoRenderer.run).mockImplementation(async (_id, _s, onProgress) => {
      sink = onProgress;
      onProgress(0);
      onProgress(40);
      onProgress(99);
      return completedJob();
    });
    const res = new FakeSseResponse();
    const next = vi.fn();
    await renderHandler()({ body: { slides: sampleSlides } }, res, next);
    const evs = res.events();
    expect(evs.filter((e) => e["percent"] === 100)).toEqual([{ percent: 100, jobId: "job-1" }]);
    expect(evs[evs.length - 1]).toEqual({ percent: 100, jobId: "job-1" });
    expect(res.writableEnded).toBe(true);

    // A late progress callback after completion writes nothing.
    sink(55);
    expect(res.events()).toHaveLength(evs.length);
    expect(next).not.toHaveBeenCalled();
  });

  it("after an error, sends one error event and nothing more", async () => {
    let sink: ProgressCallback = () => {};
    vi.mocked(videoRenderer.run).mockImplementation(async (_id, _s, onProgress) => {
      sink = onProgress;
      onProgress(10);
      throw new Error("encoder crashed");
    });
    const res = new FakeSseResponse();
    const next = vi.fn();
    await renderHandler()({ body: { slides: sampleSlides } }, res, next);
    expect(res.events()).toEqual([{ jobId: "job-1", percent: 0 }, { percent: 10 }, { error: "encoder crashed" }]);
    sink(20);
    expect(res.events()).toHaveLength(3);
    expect(next).not.toHaveBeenCalled();
  });

  it("after the client disconnects, writes nothing more — not even the terminal event", async () => {
    let release: () => void = () => {};
    let sink: ProgressCallback = () => {};
    vi.mocked(videoRenderer.run).mockImplementation(async (_id, _s, onProgress) => {
      sink = onProgress;
      onProgress(5);
      await new Promise<void>((r) => (release = r));
      return completedJob();
    });
    const res = new FakeSseResponse();
    const done = renderHandler()({ body: { slides: sampleSlides } }, res, vi.fn());
    await Promise.resolve();
    res.emit("close"); // client went away
    sink(50);
    release();
    await done;
    expect(res.events()).toEqual([{ jobId: "job-1", percent: 0 }, { percent: 5 }]);
  });
});

// ---------------------------------------------------------------------------
// Render job lifecycle through the routes (Req 4.18–4.22; Property 18)
// ---------------------------------------------------------------------------

describe("POST /api/render — lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    videoRenderer.jobs.clear();
  });

  const job1 = () => videoRenderer.jobs.get("job-1")!;

  it("sends the job ID as the first event, before run() starts any work", async () => {
    let firstWritesAtRun: string[] = [];
    const res = new FakeSseResponse();
    vi.mocked(videoRenderer.run).mockImplementation(async () => {
      firstWritesAtRun = [...res.writes];
      job1().status = "complete";
      return job1() as RenderJob;
    });
    await renderHandler()({ body: { slides: sampleSlides } }, res, vi.fn());
    expect(firstWritesAtRun.map((w) => JSON.parse(w.slice(6)))).toEqual([{ jobId: "job-1", percent: 0 }]);
    expect(res.events()[0]).toEqual({ jobId: "job-1", percent: 0 });
  });

  it("a cancelled job ends the stream quietly: no 100 and no error event", async () => {
    vi.mocked(videoRenderer.run).mockImplementation(async (_id, _s, onProgress) => {
      onProgress(30);
      job1().status = "cancelled";
      return job1() as RenderJob;
    });
    const res = new FakeSseResponse();
    const next = vi.fn();
    await renderHandler()({ body: { slides: sampleSlides } }, res, next);
    expect(res.events()).toEqual([{ jobId: "job-1", percent: 0 }, { percent: 30 }]);
    expect(res.writableEnded).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });

  it("disconnect while rendering cancels through the shared cancel()", async () => {
    let release: () => void = () => {};
    vi.mocked(videoRenderer.run).mockImplementation(async () => {
      job1().status = "rendering";
      await new Promise<void>((r) => (release = r));
      return job1() as RenderJob;
    });
    const res = new FakeSseResponse();
    const done = renderHandler()({ body: { slides: sampleSlides } }, res, vi.fn());
    await Promise.resolve();
    res.emit("close");
    expect(videoRenderer.cancel).toHaveBeenCalledWith("job-1");
    job1().status = "cancelled";
    release();
    await done;
    expect(res.events()).toEqual([{ jobId: "job-1", percent: 0 }]);
  });

  it("disconnect while still pending also cancels", async () => {
    let release: () => void = () => {};
    vi.mocked(videoRenderer.run).mockImplementation(async () => {
      await new Promise<void>((r) => (release = r));
      return job1() as RenderJob;
    });
    const res = new FakeSseResponse();
    const done = renderHandler()({ body: { slides: sampleSlides } }, res, vi.fn());
    res.emit("close");
    expect(job1().status).toBe("pending");
    expect(videoRenderer.cancel).toHaveBeenCalledWith("job-1");
    release();
    await done;
  });

  it("race 4: completion just before the connection closes leaves the job complete (no cancel)", async () => {
    vi.mocked(videoRenderer.run).mockImplementation(async () => {
      job1().status = "complete";
      return job1() as RenderJob;
    });
    const res = new FakeSseResponse();
    await renderHandler()({ body: { slides: sampleSlides } }, res, vi.fn());
    res.emit("close");
    expect(videoRenderer.cancel).not.toHaveBeenCalled();
    expect(job1().status).toBe("complete");
    expect(res.events().filter((e) => e["percent"] === 100)).toHaveLength(1);
  });

  it("disconnect after a failure changes nothing", async () => {
    vi.mocked(videoRenderer.run).mockImplementation(async () => {
      job1().status = "failed";
      throw new Error("encoder crashed");
    });
    const res = new FakeSseResponse();
    await renderHandler()({ body: { slides: sampleSlides } }, res, vi.fn());
    res.emit("close");
    expect(videoRenderer.cancel).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/render/:jobId — idempotent cancellation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    videoRenderer.jobs.clear();
  });

  it("calls the shared cancel() for every existing job and returns 204, repeatedly", async () => {
    const job = videoRenderer.createJob();
    vi.mocked(videoRenderer.cancel).mockResolvedValue(undefined);
    const app = buildApp();
    for (const _ of [1, 2, 3]) expect((await request(app).delete(`/api/render/${job.id}`)).status).toBe(204);
    expect(videoRenderer.cancel).toHaveBeenCalledTimes(3);
    expect(videoRenderer.abort).not.toHaveBeenCalled();
  });

  it("a cancellation-termination failure surfaces as a structured 500", async () => {
    const job = videoRenderer.createJob();
    const { ApiError } = await import("../src/types/index.js");
    vi.mocked(videoRenderer.cancel).mockRejectedValue(new ApiError("internal_error", "Cancellation-termination failure: test"));
    const res = await request(buildApp()).delete(`/api/render/${job.id}`);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "internal_error", message: "Cancellation-termination failure: test" });
  });

  it("unknown job → 404 without calling cancel()", async () => {
    const res = await request(buildApp()).delete("/api/render/missing");
    expect(res.status).toBe(404);
    expect(videoRenderer.cancel).not.toHaveBeenCalled();
  });
});
