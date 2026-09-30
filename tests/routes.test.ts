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
      abort: vi.fn(),
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
    expect(videoRenderer.start).not.toHaveBeenCalled();
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
    expect(videoRenderer.start).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric target with HTTP 400 invalid_input", async () => {
    const res = await request(app)
      .post("/api/render")
      .send({ slides: sampleSlides, targetDurationSeconds: "not-a-number" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_input");
    expect(videoRenderer.start).not.toHaveBeenCalled();
  });

  it("accepts an in-range target and passes it to the renderer", async () => {
    vi.mocked(videoRenderer.start).mockResolvedValue(completedJob());
    const inRange = VIDEO_CONFIG.minDurationSeconds + 5;

    const res = await request(app)
      .post("/api/render")
      .send({ slides: sampleSlides, targetDurationSeconds: inRange });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(videoRenderer.start).toHaveBeenCalledTimes(1);
    // Third positional arg is the validated target duration.
    const call = vi.mocked(videoRenderer.start).mock.calls[0];
    expect(call?.[2]).toBe(inRange);
  });

  it("accepts the boundary values (min and max) as in-range", async () => {
    vi.mocked(videoRenderer.start).mockResolvedValue(completedJob());

    for (const boundary of [
      VIDEO_CONFIG.minDurationSeconds,
      VIDEO_CONFIG.maxDurationSeconds,
    ]) {
      vi.mocked(videoRenderer.start).mockClear();
      const res = await request(app)
        .post("/api/render")
        .send({ slides: sampleSlides, targetDurationSeconds: boundary });
      expect(res.status).toBe(200);
      expect(vi.mocked(videoRenderer.start).mock.calls[0]?.[2]).toBe(boundary);
    }
  });

  it("falls back to the derived default when no target is provided", async () => {
    vi.mocked(videoRenderer.start).mockResolvedValue(completedJob());

    const res = await request(app)
      .post("/api/render")
      .send({ slides: sampleSlides });

    expect(res.status).toBe(200);
    expect(videoRenderer.start).toHaveBeenCalledTimes(1);
    // No target passed → third arg is undefined, renderer derives the default.
    const call = vi.mocked(videoRenderer.start).mock.calls[0];
    expect(call?.[2]).toBeUndefined();
  });

  it("still rejects an empty slides array with 422 before duration checks", async () => {
    const res = await request(app)
      .post("/api/render")
      .send({ slides: [], targetDurationSeconds: VIDEO_CONFIG.minDurationSeconds });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("insufficient_content");
    expect(videoRenderer.start).not.toHaveBeenCalled();
  });
});
