/**
 * Unit tests for src/server/renderer.ts
 *
 * The full VideoRenderer.start() pipeline (canvas + ffmpeg) is not exercised
 * here because it requires a real ffmpeg binary and produces large output.
 * Instead we test the pure helper functions and abort/cleanup logic.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import os from "os";
import path from "path";
import {
  sanitizeJobId,
  buildOutputPath,
  calculateSecondsPerSlide,
  VideoRenderer,
} from "../src/server/renderer.js";
import { VIDEO_CONFIG } from "../src/config/output.js";
import { ApiError } from "../src/types/index.js";

// ---------------------------------------------------------------------------
// sanitizeJobId
// ---------------------------------------------------------------------------

describe("sanitizeJobId", () => {
  it("strips non-alphanumeric, non-hyphen characters", () => {
    expect(sanitizeJobId("abc-123_def/../../etc/passwd")).toBe("abc-123defetcpasswd");
  });

  it("leaves a clean UUID unchanged", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    expect(sanitizeJobId(uuid)).toBe(uuid);
  });

  it("strips null bytes and special shell characters, preserves hyphens", () => {
    // hyphens are allowed; spaces, semicolons, slashes, null bytes are stripped
    expect(sanitizeJobId("job\0id;rm -rf /")).toBe("jobidrm-rf");
  });
});

// ---------------------------------------------------------------------------
// buildOutputPath — path traversal prevention
// ---------------------------------------------------------------------------

describe("buildOutputPath", () => {
  it("resolves to a path inside os.tmpdir()", () => {
    const tmpDir = os.tmpdir();
    const jobId = "550e8400-e29b-41d4-a716-446655440000";
    const result = buildOutputPath(jobId);
    expect(result.startsWith(tmpDir)).toBe(true);
    expect(result.endsWith(".mp4")).toBe(true);
  });

  it("includes the sanitized job ID in the filename", () => {
    const jobId = "my-job-id";
    const result = buildOutputPath(jobId);
    expect(path.basename(result)).toBe("my-job-id.mp4");
  });

  it("path traversal attempt in jobId is neutralised", () => {
    // After sanitization, "../" becomes "" so the path cannot escape tmpdir
    const maliciousId = "../../etc/passwd";
    const result = buildOutputPath(maliciousId);
    expect(result.startsWith(os.tmpdir())).toBe(true);
    expect(result).not.toContain("..");
  });

  it("path traversal attempt with encoded chars is neutralised", () => {
    const maliciousId = "..%2F..%2Fetc%2Fpasswd";
    const result = buildOutputPath(maliciousId);
    // After sanitization, % is stripped, result stays in tmpdir
    expect(result.startsWith(os.tmpdir())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// calculateSecondsPerSlide — boundary values
// ---------------------------------------------------------------------------

describe("calculateSecondsPerSlide", () => {
  it("returns minDurationSeconds when slideCount is 0", () => {
    expect(calculateSecondsPerSlide(0)).toBe(VIDEO_CONFIG.minDurationSeconds);
  });

  it("returns minDurationSeconds when slideCount is 1", () => {
    // 1 slide should get at least minDurationSeconds
    const result = calculateSecondsPerSlide(1);
    expect(result).toBeGreaterThanOrEqual(VIDEO_CONFIG.minDurationSeconds);
  });

  it("total duration never exceeds maxDurationSeconds for many slides", () => {
    for (const count of [1, 3, 5, 10, 15, 20]) {
      const sps = calculateSecondsPerSlide(count);
      const total = sps * count;
      expect(total).toBeLessThanOrEqual(VIDEO_CONFIG.maxDurationSeconds);
    }
  });

  it("total duration is at least minDurationSeconds for a normal slide count", () => {
    // For a count <= minDurationSeconds, each slide gets >=1 s so total >= count
    const sps = calculateSecondsPerSlide(5);
    const total = sps * 5;
    expect(total).toBeGreaterThanOrEqual(VIDEO_CONFIG.minDurationSeconds);
  });

  it("seconds per slide is a positive integer", () => {
    for (const count of [3, 7, 15]) {
      const sps = calculateSecondsPerSlide(count);
      expect(sps).toBeGreaterThan(0);
      expect(Number.isInteger(sps)).toBe(true);
    }
  });

  it("never returns 0 when slideCount exceeds maxDurationSeconds (zero-duration regression)", () => {
    // Regression guard: for slideCount > maxDurationSeconds, Math.floor(maxSeconds / slideCount)
    // is 0, which previously produced 0 seconds per slide -> a zero-frame render that ffmpeg
    // rejects. The fix floors the result at 1. The render route accepts a caller-supplied slide
    // array with no upper bound, so this path is reachable.
    for (const count of [
      VIDEO_CONFIG.maxDurationSeconds + 1,
      VIDEO_CONFIG.maxDurationSeconds * 2,
      1000,
    ]) {
      const sps = calculateSecondsPerSlide(count);
      expect(sps).toBe(1);
      expect(sps).toBeGreaterThan(0);
      expect(Number.isInteger(sps)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// VideoRenderer.abort — cleanup and state
// ---------------------------------------------------------------------------

describe("VideoRenderer.abort", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws internal_error when the job ID is not found", async () => {
    const renderer = new VideoRenderer();
    await expect(renderer.abort("nonexistent-job")).rejects.toThrow(
      expect.objectContaining({ code: "internal_error" }),
    );
  });

  it("sets job status to cancelled", async () => {
    const renderer = new VideoRenderer();
    // Manually insert a job record
    const jobId = "test-job-id";
    renderer.jobs.set(jobId, {
      id: jobId,
      status: "rendering",
      outputPath: null,
      fileSizeBytes: null,
      errorMessage: null,
      sizeWarning: false,
    });
    await renderer.abort(jobId);
    expect(renderer.jobs.get(jobId)?.status).toBe("cancelled");
  });

  it("deletes the partial output file if it exists", async () => {
    // Use a real temp file so we can verify deletion without mocking fs internals
    const { writeFileSync, existsSync } = await import("fs");
    const renderer = new VideoRenderer();
    const jobId = "test-job-file-delete";
    const outputPath = path.join(os.tmpdir(), `${jobId}.mp4`);

    // Create a real temp file
    writeFileSync(outputPath, "partial data");
    expect(existsSync(outputPath)).toBe(true);

    renderer.jobs.set(jobId, {
      id: jobId,
      status: "rendering",
      outputPath,
      fileSizeBytes: null,
      errorMessage: null,
      sizeWarning: false,
    });

    await renderer.abort(jobId);
    expect(existsSync(outputPath)).toBe(false);
  });

  it("completes within cancelTimeoutSeconds", async () => {
    const renderer = new VideoRenderer();
    const jobId = "timeout-test";
    renderer.jobs.set(jobId, {
      id: jobId,
      status: "rendering",
      outputPath: null,
      fileSizeBytes: null,
      errorMessage: null,
      sizeWarning: false,
    });

    const start = Date.now();
    await renderer.abort(jobId);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(VIDEO_CONFIG.cancelTimeoutSeconds * 1000 + 100);
  });
});
