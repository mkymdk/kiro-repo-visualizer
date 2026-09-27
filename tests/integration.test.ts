/**
 * Integration tests for the Express API routes.
 *
 * All GitHub network calls are mocked via `vi.mock` on the analyzer module.
 * The VideoRenderer is also mocked to avoid requiring a real ffmpeg binary.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express, { Express } from "express";

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any imports that use them
// ---------------------------------------------------------------------------

vi.mock("../src/server/analyzer.js", () => ({
  analyzeRepository: vi.fn(),
}));

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

import { analyzeRepository } from "../src/server/analyzer.js";
import { videoRenderer } from "../src/server/renderer.js";
import { router, apiErrorHandler } from "../src/server/routes.js";
import { ApiError, RepoAnalysisResult, Slide } from "../src/types/index.js";

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  app.use(apiErrorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const VALID_RESULT: RepoAnalysisResult = {
  owner: "testowner",
  repo: "testrepo",
  directoryTree: [
    { path: "src", type: "tree" },
    { path: "README.md", type: "blob", size: 100 },
  ],
  readmeText: "# Hello\nThis is a test repository.",
  commits: [
    { sha: "abc", author: "Alice", timestamp: "2024-01-01T00:00:00Z", message: "feat: add feature" },
  ],
  specDocs: [],
  partialFailures: [],
};

const SAMPLE_SLIDES: Slide[] = [
  { id: "slide-1", type: "intro", title: "Introduction: testrepo", body: "Hello", previewSummary: "Hello" },
  { id: "slide-2", type: "architecture", title: "Architecture: testrepo", body: "src/", previewSummary: "src/" },
  { id: "slide-3", type: "conclusion", title: "Conclusion: testrepo", body: "URL: ...", previewSummary: "URL: ..." },
];

// ---------------------------------------------------------------------------
// POST /api/analyze
// ---------------------------------------------------------------------------

describe("POST /api/analyze", () => {
  let app: Express;

  beforeEach(() => {
    app = buildApp();
    vi.mocked(analyzeRepository).mockReset();
  });

  it("returns 200 with analysis result on success", async () => {
    vi.mocked(analyzeRepository).mockResolvedValue(VALID_RESULT);

    const res = await request(app)
      .post("/api/analyze")
      .send({ url: "https://github.com/testowner/testrepo" });

    expect(res.status).toBe(200);
    expect(res.body.owner).toBe("testowner");
    expect(res.body.repo).toBe("testrepo");
  });

  it("returns 200 with partial_data when some steps failed", async () => {
    vi.mocked(analyzeRepository).mockResolvedValue({
      ...VALID_RESULT,
      partialFailures: ["commits"],
    });

    const res = await request(app)
      .post("/api/analyze")
      .send({ url: "https://github.com/testowner/testrepo" });

    expect(res.status).toBe(200);
    expect(res.body.error).toBe("partial_data");
  });

  it("returns 400 for invalid_url error", async () => {
    vi.mocked(analyzeRepository).mockRejectedValue(
      new ApiError("invalid_url", "Invalid URL format."),
    );

    const res = await request(app)
      .post("/api/analyze")
      .send({ url: "not-a-url" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_url");
  });

  it("returns 404 for repo_not_found error", async () => {
    vi.mocked(analyzeRepository).mockRejectedValue(
      new ApiError("repo_not_found", "Repo not found."),
    );

    const res = await request(app)
      .post("/api/analyze")
      .send({ url: "https://github.com/testowner/testrepo" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("repo_not_found");
  });

  it("returns 429 for rate_limit_exceeded error", async () => {
    vi.mocked(analyzeRepository).mockRejectedValue(
      new ApiError("rate_limit_exceeded", "Rate limit hit."),
    );

    const res = await request(app)
      .post("/api/analyze")
      .send({ url: "https://github.com/testowner/testrepo" });

    expect(res.status).toBe(429);
    expect(res.body.error).toBe("rate_limit_exceeded");
  });

  it("returns 504 for request_timeout error", async () => {
    vi.mocked(analyzeRepository).mockRejectedValue(
      new ApiError("request_timeout", "Timed out."),
    );

    const res = await request(app)
      .post("/api/analyze")
      .send({ url: "https://github.com/testowner/testrepo" });

    expect(res.status).toBe(504);
    expect(res.body.error).toBe("request_timeout");
  });

  it("returns 502 for network_error", async () => {
    vi.mocked(analyzeRepository).mockRejectedValue(
      new ApiError("network_error", "Network failed."),
    );

    const res = await request(app)
      .post("/api/analyze")
      .send({ url: "https://github.com/testowner/testrepo" });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("network_error");
  });

  it("returns 400 when url is missing from body", async () => {
    const res = await request(app).post("/api/analyze").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_url");
  });

  it("never exposes stack traces in the error response", async () => {
    vi.mocked(analyzeRepository).mockRejectedValue(new Error("Unexpected crash"));
    const res = await request(app)
      .post("/api/analyze")
      .send({ url: "https://github.com/testowner/testrepo" });
    expect(res.status).toBe(500);
    expect(res.body).not.toHaveProperty("stack");
    expect(res.body.error).toBe("internal_error");
  });
});

// ---------------------------------------------------------------------------
// GET /api/storyboard
// ---------------------------------------------------------------------------

describe("GET /api/storyboard", () => {
  let app: Express;

  beforeEach(() => {
    app = buildApp();
    vi.mocked(analyzeRepository).mockReset();
  });

  it("returns 400 when url query param is missing", async () => {
    const res = await request(app).get("/api/storyboard");
    expect(res.status).toBe(400);
  });

  it("returns 404 when no cached analysis exists for the URL", async () => {
    const res = await request(app).get("/api/storyboard?url=https://github.com/unknown/repo");
    expect(res.status).toBe(404);
  });

  it("returns Slide[] after a successful analyze + storyboard flow", async () => {
    vi.mocked(analyzeRepository).mockResolvedValue(VALID_RESULT);

    // First populate the cache
    await request(app)
      .post("/api/analyze")
      .send({ url: "https://github.com/testowner/testrepo" });

    const res = await request(app).get(
      "/api/storyboard?url=https%3A%2F%2Fgithub.com%2Ftestowner%2Ftestrepo",
    );

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(3);
    // First slide is always intro
    expect(res.body[0].type).toBe("intro");
  });

  it("returns 422 for insufficient_content (empty repo produces storyboard errors)", async () => {
    // Simulate a repo so thin that generateStoryboard throws
    vi.mocked(analyzeRepository).mockResolvedValue({
      ...VALID_RESULT,
      readmeText: null,
      directoryTree: [],
      commits: [],
      specDocs: [],
    });

    await request(app)
      .post("/api/analyze")
      .send({ url: "https://github.com/testowner/testrepo" });

    // generateStoryboard with no commits still produces 3 slides (intro+arch+conclusion)
    // so it won't throw. We test the 422 path via a mock that directly throws.
    // Override with a direct mock to force the error.
    const { generateStoryboard } = await import("../src/server/storyboard.js");
    const mockGen = vi.spyOn(
      await import("../src/server/storyboard.js"),
      "generateStoryboard",
    ).mockImplementationOnce(() => {
      throw new ApiError("insufficient_content", "Not enough content.");
    });

    const res = await request(app).get(
      "/api/storyboard?url=https%3A%2F%2Fgithub.com%2Ftestowner%2Ftestrepo",
    );

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("insufficient_content");
    mockGen.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// POST /api/render — empty slides → 422
// ---------------------------------------------------------------------------

describe("POST /api/render", () => {
  let app: Express;

  beforeEach(() => {
    app = buildApp();
  });

  it("returns 422 when slides array is empty", async () => {
    const res = await request(app)
      .post("/api/render")
      .send({ slides: [] });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("insufficient_content");
  });

  it("returns 422 when slides is missing", async () => {
    const res = await request(app).post("/api/render").send({});
    expect(res.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/render/:jobId
// ---------------------------------------------------------------------------

describe("DELETE /api/render/:jobId", () => {
  let app: Express;

  beforeEach(() => {
    app = buildApp();
    vi.mocked(videoRenderer.abort).mockReset();
  });

  it("returns 404 when job is not found", async () => {
    vi.mocked(videoRenderer.abort).mockRejectedValue(
      new ApiError("internal_error", "Job not found."),
    );
    // jobs Map is empty from the mock
    const res = await request(app).delete("/api/render/nonexistent-id");
    expect(res.status).toBe(404);
  });

  it("returns 204 on successful cancellation", async () => {
    const jobId = "test-cancel-job";
    videoRenderer.jobs.set(jobId, {
      id: jobId,
      status: "rendering",
      outputPath: null,
      fileSizeBytes: null,
      errorMessage: null,
      sizeWarning: false,
    });
    vi.mocked(videoRenderer.abort).mockResolvedValue(undefined);

    const res = await request(app).delete(`/api/render/${jobId}`);
    expect(res.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// Error response shape invariant
// ---------------------------------------------------------------------------

describe("Error response shape", () => {
  let app: Express;

  beforeEach(() => {
    app = buildApp();
    vi.mocked(analyzeRepository).mockReset();
  });

  it.each([
    ["invalid_url", 400],
    ["repo_not_found", 404],
    ["rate_limit_exceeded", 429],
    ["request_timeout", 504],
    ["network_error", 502],
    ["internal_error", 500],
  ] as const)(
    "ApiError(%s) maps to HTTP %d with { error, message } shape",
    async (code, expectedStatus) => {
      vi.mocked(analyzeRepository).mockRejectedValue(
        new ApiError(code, `Test: ${code}`),
      );
      const res = await request(app)
        .post("/api/analyze")
        .send({ url: "https://github.com/testowner/testrepo" });

      expect(res.status).toBe(expectedStatus);
      expect(res.body).toHaveProperty("error", code);
      expect(res.body).toHaveProperty("message");
      expect(typeof res.body.message).toBe("string");
    },
  );
});

// ---------------------------------------------------------------------------
// GET /api/download/:jobId
// ---------------------------------------------------------------------------

describe("GET /api/download/:jobId", () => {
  let app: Express;
  const { writeFileSync, existsSync } = require("fs") as typeof import("fs");

  beforeEach(() => {
    app = buildApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 404 when job is not found", async () => {
    const res = await request(app).get("/api/download/nonexistent-job");
    expect(res.status).toBe(404);
  });

  it("returns 409 when job is not yet complete", async () => {
    const jobId = "incomplete-job";
    videoRenderer.jobs.set(jobId, {
      id: jobId,
      status: "rendering",
      outputPath: null,
      fileSizeBytes: null,
      errorMessage: null,
      sizeWarning: false,
    });
    const res = await request(app).get(`/api/download/${jobId}`);
    expect(res.status).toBe(409);
  });

  it("returns 404 when output file is missing from disk", async () => {
    const jobId = "complete-but-missing-file";
    videoRenderer.jobs.set(jobId, {
      id: jobId,
      status: "complete",
      outputPath: "/tmp/nonexistent-file-abc123.mp4",
      fileSizeBytes: 1000,
      errorMessage: null,
      sizeWarning: false,
    });
    const res = await request(app).get(`/api/download/${jobId}`);
    expect(res.status).toBe(404);
  });

  it("streams MP4 file with correct headers when job is complete", async () => {
    const jobId = "download-test-job";
    const { writeFileSync, existsSync } = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const outputPath = path.default.join(os.default.tmpdir(), `${jobId}.mp4`);
    writeFileSync(outputPath, "fake mp4 data");

    videoRenderer.jobs.set(jobId, {
      id: jobId,
      status: "complete",
      outputPath,
      fileSizeBytes: 13,
      errorMessage: null,
      sizeWarning: false,
    });

    const res = await request(app).get(`/api/download/${jobId}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("video/mp4");
    expect(res.headers["content-disposition"]).toContain("attachment");
  });

  it("sets X-File-Size-Warning header when sizeWarning is true", async () => {
    const jobId = "large-file-job";
    const { writeFileSync } = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const outputPath = path.default.join(os.default.tmpdir(), `${jobId}.mp4`);
    writeFileSync(outputPath, "large fake mp4");

    videoRenderer.jobs.set(jobId, {
      id: jobId,
      status: "complete",
      outputPath,
      fileSizeBytes: 300 * 1024 * 1024,
      errorMessage: null,
      sizeWarning: true,
    });

    const res = await request(app).get(`/api/download/${jobId}`);
    expect(res.headers["x-file-size-warning"]).toBe("true");
  });
});
