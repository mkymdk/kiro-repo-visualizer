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

vi.mock("../src/server/analyzer.js", async () => {
  // Keep the real validateAndExtractTokens (and its real ApiError instance)
  // so that thrown errors are recognized by the route error handler; mock
  // only the network-calling analyzeRepository.
  const actual = await vi.importActual<typeof import("../src/server/analyzer.js")>(
    "../src/server/analyzer.js",
  );
  return {
    ...actual,
    analyzeRepository: vi.fn(),
  };
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

import { analyzeRepository } from "../src/server/analyzer.js";
import { videoRenderer } from "../src/server/renderer.js";
import { router, apiErrorHandler } from "../src/server/routes.js";
import { analysisCache } from "../src/server/cache.js";
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

// The analysis cache is a real module-level singleton shared across the
// route handlers. Clear it before every test to prevent cross-test cache
// hits from masking mocked analyzer behavior.
beforeEach(() => {
  analysisCache.clear();
});

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const VALID_RESULT: RepoAnalysisResult = {
  owner: "testowner",
  repo: "testrepo",
  metadata: null,
  directoryTree: [
    { path: "src", type: "tree" },
    { path: "README.md", type: "blob", size: 100 },
  ],
  readmeText: "# Hello\nThis is a test repository.",
  commits: [
    {
      sha: "abc",
      author: "Alice",
      timestamp: "2024-01-01T00:00:00Z",
      subject: "feat: add feature",
      body: "",
      message: "feat: add feature",
      parents: [],
    },
  ],
  specDocs: [],
  pullRequests: [],
  releases: [],
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

  it("re-analyzes on a cache miss instead of returning 404", async () => {
    // New behavior (Option A): storyboard re-runs analysis when the cache is
    // empty rather than dead-ending with a 404.
    vi.mocked(analyzeRepository).mockResolvedValue({
      ...VALID_RESULT,
      owner: "unknown",
      repo: "repo",
    });
    const res = await request(app).get(
      "/api/storyboard?url=https://github.com/unknown/repo",
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(vi.mocked(analyzeRepository)).toHaveBeenCalledTimes(1);
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
      completedAtMs: null,
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
      completedAtMs: null,
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
      completedAtMs: Date.now(),
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
      completedAtMs: Date.now(),
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
      completedAtMs: Date.now(),
    });

    const res = await request(app).get(`/api/download/${jobId}`);
    expect(res.headers["x-file-size-warning"]).toBe("true");
  });

  it("HEAD returns headers with no body and does not delete the file", async () => {
    const jobId = "head-no-side-effect-job";
    const { writeFileSync, existsSync } = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const outputPath = path.default.join(os.default.tmpdir(), `${jobId}.mp4`);
    writeFileSync(outputPath, "head fake mp4 data");

    videoRenderer.jobs.set(jobId, {
      id: jobId,
      status: "complete",
      outputPath,
      fileSizeBytes: 18,
      errorMessage: null,
      sizeWarning: false,
      completedAtMs: Date.now(),
    });

    const head = await request(app).head(`/api/download/${jobId}`);
    expect(head.status).toBe(200);
    expect(head.headers["content-type"]).toContain("video/mp4");
    expect(head.headers["content-length"]).toBe("18");
    // No body on a HEAD response.
    expect(head.text).toBeFalsy();
    // The file must still be on disk — HEAD has no side effect.
    expect(existsSync(outputPath)).toBe(true);

    // cleanup
    if (existsSync(outputPath)) (await import("fs")).unlinkSync(outputPath);
  });

  it("HEAD followed by GET both succeed (regression: HEAD must not delete the file)", async () => {
    const jobId = "head-then-get-job";
    const { writeFileSync, existsSync } = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const outputPath = path.default.join(os.default.tmpdir(), `${jobId}.mp4`);
    const contents = "valid mp4 payload bytes";
    writeFileSync(outputPath, contents);

    videoRenderer.jobs.set(jobId, {
      id: jobId,
      status: "complete",
      outputPath,
      fileSizeBytes: contents.length,
      errorMessage: null,
      sizeWarning: false,
      completedAtMs: Date.now(),
    });

    // Frontend does a HEAD size-check first...
    const head = await request(app).head(`/api/download/${jobId}`);
    expect(head.status).toBe(200);
    expect(existsSync(outputPath)).toBe(true);

    // ...then the real GET download must still work.
    const get = await request(app).get(`/api/download/${jobId}`);
    expect(get.status).toBe(200);
    expect(get.headers["content-length"]).toBe(String(contents.length));
    // File is NOT deleted by the download itself.
    expect(existsSync(outputPath)).toBe(true);

    // cleanup
    if (existsSync(outputPath)) (await import("fs")).unlinkSync(outputPath);
  });

  it("repeated GETs within the retention window both succeed", async () => {
    const jobId = "repeated-get-job";
    const { writeFileSync, existsSync } = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const outputPath = path.default.join(os.default.tmpdir(), `${jobId}.mp4`);
    const contents = "repeatable payload";
    writeFileSync(outputPath, contents);

    videoRenderer.jobs.set(jobId, {
      id: jobId,
      status: "complete",
      outputPath,
      fileSizeBytes: contents.length,
      errorMessage: null,
      sizeWarning: false,
      completedAtMs: Date.now(),
    });

    const first = await request(app).get(`/api/download/${jobId}`);
    expect(first.status).toBe(200);
    expect(existsSync(outputPath)).toBe(true);

    const second = await request(app).get(`/api/download/${jobId}`);
    expect(second.status).toBe(200);
    expect(second.headers["content-length"]).toBe(String(contents.length));
    expect(existsSync(outputPath)).toBe(true);

    // cleanup
    if (existsSync(outputPath)) (await import("fs")).unlinkSync(outputPath);
  });
});

// ---------------------------------------------------------------------------
// Analysis cache behavior (Option A) at the route level
// ---------------------------------------------------------------------------

describe("POST /api/analyze — TTL cache", () => {
  let app: Express;
  const URL = "https://github.com/CacheOwner/CacheRepo";

  beforeEach(() => {
    app = buildApp();
    vi.mocked(analyzeRepository).mockReset();
    analysisCache.clear();
  });

  it("second identical request is served from cache (no second GitHub call)", async () => {
    vi.mocked(analyzeRepository).mockResolvedValue({
      ...VALID_RESULT,
      owner: "CacheOwner",
      repo: "CacheRepo",
    });

    const r1 = await request(app).post("/api/analyze").send({ url: URL });
    const r2 = await request(app).post("/api/analyze").send({ url: URL });

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    // analyzeRepository must have run exactly once — the 2nd was a cache hit.
    expect(vi.mocked(analyzeRepository)).toHaveBeenCalledTimes(1);
  });

  it("cache key is case-insensitive on owner/repo", async () => {
    vi.mocked(analyzeRepository).mockResolvedValue({
      ...VALID_RESULT,
      owner: "CacheOwner",
      repo: "CacheRepo",
    });

    await request(app).post("/api/analyze").send({ url: URL });
    // Different casing → same normalized key → cache hit
    await request(app)
      .post("/api/analyze")
      .send({ url: "https://github.com/cacheowner/cacherepo" });

    expect(vi.mocked(analyzeRepository)).toHaveBeenCalledTimes(1);
  });

  it("does NOT cache partial results (re-analyzes on next request)", async () => {
    vi.mocked(analyzeRepository).mockResolvedValue({
      ...VALID_RESULT,
      owner: "CacheOwner",
      repo: "CacheRepo",
      partialFailures: ["commits"],
    });

    await request(app).post("/api/analyze").send({ url: URL });
    await request(app).post("/api/analyze").send({ url: URL });

    // Partial results are never cached → analyzer runs both times.
    expect(vi.mocked(analyzeRepository)).toHaveBeenCalledTimes(2);
  });

  it("does NOT cache error results", async () => {
    vi.mocked(analyzeRepository).mockRejectedValue(
      new ApiError("repo_not_found", "nope"),
    );

    await request(app).post("/api/analyze").send({ url: URL });
    await request(app).post("/api/analyze").send({ url: URL });

    expect(vi.mocked(analyzeRepository)).toHaveBeenCalledTimes(2);
  });
});

describe("GET /api/storyboard — cache integration", () => {
  let app: Express;
  const URL = "https://github.com/SbOwner/SbRepo";
  const ENCODED = encodeURIComponent(URL);

  beforeEach(() => {
    app = buildApp();
    vi.mocked(analyzeRepository).mockReset();
    analysisCache.clear();
  });

  it("uses the cached analysis populated by /api/analyze (no extra call)", async () => {
    vi.mocked(analyzeRepository).mockResolvedValue({
      ...VALID_RESULT,
      owner: "SbOwner",
      repo: "SbRepo",
    });

    await request(app).post("/api/analyze").send({ url: URL });
    const res = await request(app).get(`/api/storyboard?url=${ENCODED}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // analyze called once; storyboard reused the cache.
    expect(vi.mocked(analyzeRepository)).toHaveBeenCalledTimes(1);
  });

  it("re-analyzes when no cached entry exists (e.g. after expiry)", async () => {
    vi.mocked(analyzeRepository).mockResolvedValue({
      ...VALID_RESULT,
      owner: "SbOwner",
      repo: "SbRepo",
    });

    // No prior /api/analyze → storyboard must analyze on demand.
    const res = await request(app).get(`/api/storyboard?url=${ENCODED}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(vi.mocked(analyzeRepository)).toHaveBeenCalledTimes(1);
  });

  it("returns 400 for an invalid URL", async () => {
    const res = await request(app).get("/api/storyboard?url=not-a-url");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_url");
  });
});

// ---------------------------------------------------------------------------
// End-to-end flow per repository shape (analysis mocked at the analyzer boundary)
// ---------------------------------------------------------------------------

import { ALL_FIXTURES, kiroRepo } from "./fixtures/repos.js";

describe("full flow per repository shape", () => {
  let app: Express;

  beforeEach(() => {
    app = buildApp();
    vi.mocked(analyzeRepository).mockReset();
    vi.mocked(videoRenderer.start).mockReset();
  });

  it.each(Object.entries(ALL_FIXTURES))("%s: analyze → storyboard → render → download", async (_name, fixture) => {
    const url = `https://github.com/${fixture.owner}/${fixture.repo}`;
    vi.mocked(analyzeRepository).mockResolvedValue(fixture);

    const analyze = await request(app).post("/api/analyze").send({ url });
    expect(analyze.status).toBe(200);

    const sb = await request(app).get("/api/storyboard").query({ url });
    expect(sb.status).toBe(200);
    const slides = sb.body as Slide[];
    expect(slides[0]?.type).toBe("intro");
    expect(slides[slides.length - 1]?.type).toBe("conclusion");
    expect(vi.mocked(analyzeRepository)).toHaveBeenCalledTimes(1); // storyboard used the cache

    const { writeFileSync, rmSync } = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const jobId = `flow-${fixture.repo}`;
    const outputPath = path.default.join(os.default.tmpdir(), `${jobId}.mp4`);
    vi.mocked(videoRenderer.start).mockImplementation(async (received: Slide[]) => {
      expect(received).toEqual(slides);
      writeFileSync(outputPath, "mp4");
      const job = {
        id: jobId, status: "complete" as const, outputPath, fileSizeBytes: 3,
        errorMessage: null, sizeWarning: false, completedAtMs: Date.now(),
      };
      videoRenderer.jobs.set(jobId, job);
      return job;
    });

    try {
      const render = await request(app).post("/api/render").send({ slides });
      expect(render.status).toBe(200);
      expect(render.text).toContain(`"jobId":"${jobId}"`);

      const download = await request(app).get(`/api/download/${jobId}`);
      expect(download.status).toBe(200);
      expect(download.headers["content-type"]).toContain("video/mp4");
    } finally {
      rmSync(outputPath, { force: true });
      videoRenderer.jobs.delete(jobId);
    }
  });

  it("PR-step failure: partial_data, storyboard still generates without PR-based slides", async () => {
    const url = `https://github.com/${kiroRepo.owner}/${kiroRepo.repo}`;
    vi.mocked(analyzeRepository).mockResolvedValue({
      ...kiroRepo,
      pullRequests: [],
      partialFailures: ["pullRequests"],
    });

    const analyze = await request(app).post("/api/analyze").send({ url });
    expect(analyze.status).toBe(200);
    expect(analyze.body.error).toBe("partial_data");

    const sb = await request(app).get("/api/storyboard").query({ url });
    expect(sb.status).toBe(200);
    const out = sb.body as Slide[];
    // No PR deep dives; releases and commits take over as evolution evidence.
    expect(out.filter((s) => s.type === "change").every((s) => s.title.startsWith("Release"))).toBe(true);
    expect(out.some((s) => s.type === "highlight")).toBe(true);
    expect(out.some((s) => s.type === "feature")).toBe(true);
  });
});
