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
  startOutputSweep,
  stopOutputSweep,
  wrapText,
  fitLines,
  layoutSlide,
  decodeHtmlEntities,
  LAYOUT,
} from "../src/server/renderer.js";
import { VIDEO_CONFIG } from "../src/config/output.js";
import { ApiError, RenderJob } from "../src/types/index.js";

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

  // --- explicit Target_Duration path ---

  it("distributes an explicit in-range target across slides", () => {
    const target = VIDEO_CONFIG.minDurationSeconds; // known in-range value
    const count = 5;
    const sps = calculateSecondsPerSlide(count, target);
    expect(sps).toBe(Math.round(target / count));
    // Total matches the target to within one second per slide of rounding.
    expect(Math.abs(sps * count - target)).toBeLessThanOrEqual(count);
  });

  it("floors each slide at 1 second when the target is smaller than the slide count", () => {
    // target < count would give < 1s per slide before the floor
    const sps = calculateSecondsPerSlide(
      VIDEO_CONFIG.minDurationSeconds + 10,
      VIDEO_CONFIG.minDurationSeconds,
    );
    expect(sps).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(sps)).toBe(true);
  });

  it("defensively clamps an out-of-range target into the allowed range", () => {
    const count = 6;
    const belowMin = calculateSecondsPerSlide(count, 1);
    const aboveMax = calculateSecondsPerSlide(
      count,
      VIDEO_CONFIG.maxDurationSeconds + 1000,
    );
    expect(belowMin).toBe(
      Math.max(1, Math.round(VIDEO_CONFIG.minDurationSeconds / count)),
    );
    expect(aboveMax).toBe(
      Math.max(1, Math.round(VIDEO_CONFIG.maxDurationSeconds / count)),
    );
  });

  it("uses the slide-count-derived default when no target is provided", () => {
    // The default path is unchanged from the pre-feature behaviour.
    const withoutTarget = calculateSecondsPerSlide(5);
    const explicitUndefined = calculateSecondsPerSlide(5, undefined);
    expect(withoutTarget).toBe(explicitUndefined);
    expect(withoutTarget * 5).toBeLessThanOrEqual(VIDEO_CONFIG.maxDurationSeconds);
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
      completedAtMs: null,
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
      completedAtMs: null,
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
      completedAtMs: null,
    });

    const start = Date.now();
    await renderer.abort(jobId);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(VIDEO_CONFIG.cancelTimeoutSeconds * 1000 + 100);
  });
});

// ---------------------------------------------------------------------------
// VideoRenderer.sweepExpiredOutputs — TTL-based output file cleanup
// ---------------------------------------------------------------------------

describe("VideoRenderer.sweepExpiredOutputs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function completeJob(
    renderer: VideoRenderer,
    jobId: string,
    outputPath: string,
    completedAtMs: number,
  ): void {
    const job: RenderJob = {
      id: jobId,
      status: "complete",
      outputPath,
      fileSizeBytes: 100,
      errorMessage: null,
      sizeWarning: false,
      completedAtMs,
    };
    renderer.jobs.set(jobId, job);
  }

  it("keeps the output file for a completed job still within the TTL", async () => {
    const { writeFileSync, existsSync, unlinkSync } = await import("fs");
    const renderer = new VideoRenderer();
    const jobId = "sweep-within-ttl";
    const outputPath = path.join(os.tmpdir(), `${jobId}.mp4`);
    writeFileSync(outputPath, "data");
    completeJob(renderer, jobId, outputPath, 1_000);

    // now is just before the TTL boundary
    const swept = renderer.sweepExpiredOutputs(1_000 + VIDEO_CONFIG.outputFileTtlMs - 1);
    expect(swept).toBe(0);
    expect(existsSync(outputPath)).toBe(true);
    expect(renderer.jobs.has(jobId)).toBe(true);

    unlinkSync(outputPath);
  });

  it("deletes the output file and forgets the job once older than the TTL", async () => {
    const { writeFileSync, existsSync } = await import("fs");
    const renderer = new VideoRenderer();
    const jobId = "sweep-past-ttl";
    const outputPath = path.join(os.tmpdir(), `${jobId}.mp4`);
    writeFileSync(outputPath, "data");
    completeJob(renderer, jobId, outputPath, 1_000);

    // now is exactly at the TTL boundary (>= expires)
    const swept = renderer.sweepExpiredOutputs(1_000 + VIDEO_CONFIG.outputFileTtlMs);
    expect(swept).toBe(1);
    expect(existsSync(outputPath)).toBe(false);
    expect(renderer.jobs.has(jobId)).toBe(false);
  });

  it("does not sweep jobs that never completed", () => {
    const renderer = new VideoRenderer();
    renderer.jobs.set("still-rendering", {
      id: "still-rendering",
      status: "rendering",
      outputPath: null,
      fileSizeBytes: null,
      errorMessage: null,
      sizeWarning: false,
      completedAtMs: null,
    });
    const swept = renderer.sweepExpiredOutputs(Date.now() + VIDEO_CONFIG.outputFileTtlMs * 10);
    expect(swept).toBe(0);
    expect(renderer.jobs.has("still-rendering")).toBe(true);
  });

  it("tolerates an already-missing output file (best-effort) and still forgets the job", () => {
    const renderer = new VideoRenderer();
    const jobId = "sweep-missing-file";
    completeJob(renderer, jobId, path.join(os.tmpdir(), "does-not-exist-xyz.mp4"), 0);
    const swept = renderer.sweepExpiredOutputs(VIDEO_CONFIG.outputFileTtlMs + 1);
    expect(swept).toBe(1);
    expect(renderer.jobs.has(jobId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// startOutputSweep / stopOutputSweep — periodic sweep scheduling
// ---------------------------------------------------------------------------

describe("startOutputSweep / stopOutputSweep", () => {
  afterEach(() => {
    stopOutputSweep();
    vi.useRealTimers();
  });

  it("schedules a recurring sweep on the singleton and is idempotent", () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

    startOutputSweep();
    startOutputSweep(); // second call must be a no-op

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledWith(
      expect.any(Function),
      VIDEO_CONFIG.outputFileSweepIntervalMs,
    );
  });

  it("stopOutputSweep clears the timer so a subsequent start re-schedules", () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

    startOutputSweep();
    stopOutputSweep();
    startOutputSweep(); // allowed to schedule again after stop

    expect(setIntervalSpy).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Text layout — wrapText / fitLines / layoutSlide (Req 4.15, 4.16; Property 13)
// ---------------------------------------------------------------------------

/** Fake measure: every character is 10px wide. */
const measure10 = (s: string): number => Array.from(s).length * 10;

describe("wrapText", () => {
  it("wraps at word boundaries so no line exceeds maxWidth", () => {
    const lines = wrapText("the quick brown fox jumps over the lazy dog", 100, measure10);
    expect(lines).toEqual(["the quick", "brown fox", "jumps over", "the lazy", "dog"]);
    for (const l of lines) expect(measure10(l)).toBeLessThanOrEqual(100);
  });

  it("keeps a line that fits exactly", () => {
    expect(wrapText("abcde fghi", 100, measure10)).toEqual(["abcde fghi"]);
  });

  it("preserves explicit line breaks and blank lines", () => {
    expect(wrapText("one\n\ntwo", 100, measure10)).toEqual(["one", "", "two"]);
  });

  it("breaks a word by characters only when it alone is wider than maxWidth", () => {
    const lines = wrapText("hi abcdefghijklmnop ok", 50, measure10);
    expect(lines).toEqual(["hi", "abcde", "fghij", "klmno", "p ok"]);
    for (const l of lines) expect(measure10(l)).toBeLessThanOrEqual(50);
  });

  it("keeps leading indentation on the first wrapped line", () => {
    expect(wrapText("  npm run dev", 200, measure10)).toEqual(["  npm run dev"]);
  });
});

describe("fitLines", () => {
  it("returns all lines unchanged when they fit (no ellipsis)", () => {
    expect(fitLines(["a", "b"], 2, 100, measure10)).toEqual(["a", "b"]);
  });

  it("ignores trailing blank lines when deciding whether content was dropped", () => {
    expect(fitLines(["a", "b", "", ""], 2, 100, measure10)).toEqual(["a", "b"]);
  });

  it("truncates and ends the last kept line with an ellipsis that fits", () => {
    const out = fitLines(["aaaaaaaaaa", "bbbbbbbbbb", "cc"], 2, 100, measure10);
    expect(out).toHaveLength(2);
    expect(out[1]!.endsWith("…")).toBe(true);
    expect(measure10(out[1]!)).toBeLessThanOrEqual(100);
  });

  it("does not end on a blank line when truncating", () => {
    const out = fitLines(["aaa", "", "ccc"], 2, 100, measure10);
    expect(out).toEqual(["aaa…"]);
  });
});

describe("layoutSlide", () => {
  const maxWidth = VIDEO_CONFIG.width - 2 * LAYOUT.margin;
  const slide = (title: string, body: string) => ({ id: "x", type: "intro" as const, title, body, previewSummary: "" });

  it("keeps short content intact without ellipsis", () => {
    const layout = layoutSlide(slide("Short", "line one\nline two"), measure10, measure10);
    expect(layout.titleLines).toEqual(["Short"]);
    expect(layout.bodyLines).toEqual(["line one", "line two"]);
    expect(layout.bodyLines.join("")).not.toContain("…");
  });

  it("wraps a long title to at most titleMaxLines and moves the body down", () => {
    const longTitle = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const one = layoutSlide(slide("T", "b"), measure10, measure10);
    const long = layoutSlide(slide(longTitle, "b"), measure10, measure10);
    expect(long.titleLines).toHaveLength(LAYOUT.titleMaxLines);
    expect(long.titleLines[long.titleLines.length - 1]!.endsWith("…")).toBe(true);
    expect(long.bodyTop).toBeGreaterThan(one.bodyTop);
  });

  it("never places a body line below the bottom margin and ellipsizes overflow", () => {
    const body = Array.from({ length: 100 }, (_, i) => `row ${i}`).join("\n");
    const layout = layoutSlide(slide("T", body), measure10, measure10);
    const lastBaseline = layout.bodyTop + (layout.bodyLines.length - 1) * LAYOUT.bodyLineHeight;
    expect(lastBaseline).toBeLessThanOrEqual(VIDEO_CONFIG.height - LAYOUT.margin);
    expect(layout.bodyLines[layout.bodyLines.length - 1]!.endsWith("…")).toBe(true);
    for (const l of [...layout.titleLines, ...layout.bodyLines]) {
      expect(measure10(l)).toBeLessThanOrEqual(maxWidth);
    }
  });

  it("decodes HTML entities before measuring and drawing", () => {
    const layout = layoutSlide(slide("a &amp; b", "&lt;x&gt; &quot;q&quot; &#39;s&#39;"), measure10, measure10);
    expect(layout.titleLines).toEqual(["a & b"]);
    expect(layout.bodyLines).toEqual([`<x> "q" 's'`]);
  });
});

describe("decodeHtmlEntities", () => {
  it("decodes &amp; last so escaped entities are not double-decoded", () => {
    expect(decodeHtmlEntities("&amp;lt;")).toBe("&lt;");
  });
});
