/**
 * Video renderer — converts a Slide[] into an MP4 file using node-canvas
 * for frame rasterisation and fluent-ffmpeg for H.264 encoding.
 */

import { createCanvas } from "canvas";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import Ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { VIDEO_CONFIG } from "../config/output.js";
import { ApiError, RenderJob, RenderJobStatus, Slide } from "../types/index.js";

// Set the ffmpeg binary path at module load time
Ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Strip all characters that are not alphanumeric or hyphens from a job ID
 * to prevent path traversal or shell injection.
 *
 * @param jobId - The raw job ID string (typically a UUID).
 * @returns A sanitized string containing only `[a-zA-Z0-9-]`.
 */
export function sanitizeJobId(jobId: string): string {
  return jobId.replace(/[^a-zA-Z0-9-]/g, "");
}

/**
 * Build the absolute output path for a render job's MP4 file, confined to
 * the OS temp directory.
 *
 * @param jobId - The render job UUID (will be sanitized before use).
 * @returns The absolute path `<os.tmpdir()>/<sanitizedId>.mp4`.
 * @throws {@link ApiError} With code `internal_error` if the resolved path
 *   escapes the temp directory (path traversal guard).
 */
export function buildOutputPath(jobId: string): string {
  const sanitized = sanitizeJobId(jobId);
  const tmpDir = os.tmpdir();
  const resolved = path.resolve(tmpDir, `${sanitized}.mp4`);
  if (!resolved.startsWith(tmpDir + path.sep) && resolved !== path.join(tmpDir, `${sanitized}.mp4`)) {
    throw new ApiError(
      "internal_error",
      "Render output path escapes the temp directory.",
    );
  }
  // Secondary check: resolved must start with tmpDir
  if (!resolved.startsWith(tmpDir)) {
    throw new ApiError(
      "internal_error",
      "Render output path escapes the temp directory.",
    );
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Duration calculation
// ---------------------------------------------------------------------------

/**
 * Calculate the number of seconds to display each slide so the total video
 * duration stays within `[VIDEO_CONFIG.minDurationSeconds, VIDEO_CONFIG.maxDurationSeconds]`.
 *
 * @param slideCount - The number of slides to render.
 * @returns Seconds per slide — always at least 1. Chosen so the total
 *   duration is close to `minDurationSeconds` for small slide counts and does
 *   not exceed `maxDurationSeconds` until the count itself exceeds
 *   `maxDurationSeconds`.
 *
 * @remarks
 * The result is floored at 1 second. When `slideCount` exceeds
 * `maxDurationSeconds` the total video will necessarily run longer than
 * `maxDurationSeconds` (one second per slide is the minimum meaningful
 * display time); returning 0 here would produce a zero-frame render that
 * ffmpeg rejects. `generateStoryboard` caps storyboards at
 * `SLIDE_CONFIG.maxSlides`, but the render route accepts a caller-supplied
 * slide array, so this floor guards the unbounded input path.
 */
export function calculateSecondsPerSlide(slideCount: number): number {
  if (slideCount <= 0) return VIDEO_CONFIG.minDurationSeconds;

  const targetSeconds = VIDEO_CONFIG.minDurationSeconds;
  const maxSeconds = VIDEO_CONFIG.maxDurationSeconds;

  // Try to spread evenly across minDuration first
  const ideal = Math.ceil(targetSeconds / slideCount);

  // Clamp so total doesn't exceed maxDuration, but never drop below 1 second
  // per slide (a 0 would yield a zero-frame render that ffmpeg rejects).
  const maxPerSlide = Math.floor(maxSeconds / slideCount);
  return Math.max(1, Math.min(ideal, maxPerSlide));
}

// ---------------------------------------------------------------------------
// Frame rendering
// ---------------------------------------------------------------------------

/**
 * Render all frames for a single slide onto a canvas and return PNG buffers.
 *
 * The same frame (a still image of the slide) is repeated for
 * `secondsPerSlide × VIDEO_CONFIG.fps` frames.
 *
 * @param slide - The slide data to render.
 * @param secondsPerSlide - How many seconds this slide should be on screen.
 * @returns An array of PNG `Buffer` objects, one per frame.
 */
export function renderSlideFrames(
  slide: Slide,
  secondsPerSlide: number,
): Buffer[] {
  const canvas = createCanvas(VIDEO_CONFIG.width, VIDEO_CONFIG.height);
  const ctx = canvas.getContext("2d");

  // Background
  ctx.fillStyle = "#1e1e2e";
  ctx.fillRect(0, 0, VIDEO_CONFIG.width, VIDEO_CONFIG.height);

  // Title
  ctx.fillStyle = "#cdd6f4";
  ctx.font = `bold 36px sans-serif`;
  ctx.fillText(
    slide.title.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'"),
    60,
    80,
  );

  // Divider
  ctx.strokeStyle = "#89b4fa";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(60, 100);
  ctx.lineTo(VIDEO_CONFIG.width - 60, 100);
  ctx.stroke();

  // Body text — word-wrap at ~100 chars per line
  ctx.fillStyle = "#cdd6f4";
  ctx.font = "20px monospace";
  const plainBody = slide.body
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  const lines = plainBody.split("\n");
  let y = 140;
  const lineHeight = 28;
  for (const line of lines) {
    if (y > VIDEO_CONFIG.height - 60) break;
    ctx.fillText(line.slice(0, 100), 60, y);
    y += lineHeight;
  }

  // Encode to PNG buffer once and replicate for each frame
  const framePng = canvas.toBuffer("image/png");
  const frameCount = secondsPerSlide * VIDEO_CONFIG.fps;
  return Array.from({ length: frameCount }, () => framePng);
}

// ---------------------------------------------------------------------------
// VideoRenderer class
// ---------------------------------------------------------------------------

/** Callback type used to report render progress. */
export type ProgressCallback = (percent: number) => void;

/**
 * Singleton-style video renderer that manages render job lifecycle.
 *
 * Each job is stored in an in-memory `Map` keyed by UUID. Jobs write their
 * output to `os.tmpdir()/<jobId>.mp4`.
 */
export class VideoRenderer {
  /** In-memory store of all render jobs keyed by job UUID. */
  public readonly jobs: Map<string, RenderJob> = new Map();

  /**
   * Start a new video render job for the given slides.
   *
   * Renders each slide to a PNG frame sequence, then pipes the frames to
   * ffmpeg for H.264/MP4 encoding. Progress callbacks are fired at
   * `VIDEO_CONFIG.progressIntervalMs` intervals.
   *
   * @param slides - The ordered array of {@link Slide} objects to render.
   * @param onProgress - Callback invoked with a percent value (0–100) as
   *   encoding proceeds.
   * @returns The completed {@link RenderJob} record.
   * @throws {@link ApiError} With code `internal_error` if rendering fails.
   *
   * @remarks
   * Writes one MP4 file to `os.tmpdir()`. The file is the caller's
   * responsibility to delete after download (see `VideoRenderer.abort` and
   * the download route's `res.on("finish")` handler).
   */
  async start(
    slides: Slide[],
    onProgress: ProgressCallback,
  ): Promise<RenderJob> {
    const jobId = randomUUID();
    const outputPath = buildOutputPath(jobId);

    const job: RenderJob = {
      id: jobId,
      status: "pending" as RenderJobStatus,
      outputPath,
      fileSizeBytes: null,
      errorMessage: null,
      sizeWarning: false,
      completedAtMs: null,
    };
    this.jobs.set(jobId, job);

    try {
      job.status = "rendering";
      const secondsPerSlide = calculateSecondsPerSlide(slides.length);

      // Render all frames
      const allFrames: Buffer[] = [];
      for (const slide of slides) {
        allFrames.push(...renderSlideFrames(slide, secondsPerSlide));
      }

      const totalFrames = allFrames.length;

      await new Promise<void>((resolve, reject) => {
        let encodedFrames = 0;
        let lastProgressAt = 0;

        const command = Ffmpeg();

        // Pipe frames through a PassThrough stream
        const { PassThrough } = require("stream") as typeof import("stream");
        const frameStream = new PassThrough();

        command
          .input(frameStream)
          .inputOptions([
            "-f", "image2pipe",
            "-framerate", String(VIDEO_CONFIG.fps),
            "-vcodec", "png",
          ])
          .outputOptions([
            "-vcodec", "libx264",
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
          ])
          .output(outputPath)
          .on("progress", (progress: { frames?: number }) => {
            // ffmpeg reports the number of frames it has actually encoded so
            // far. Use that for real progress rather than how fast we can push
            // buffers into the input stream. Throttle to the configured
            // interval so we don't spam SSE events.
            if (typeof progress.frames === "number") {
              encodedFrames = progress.frames;
            }
            const now = Date.now();
            if (now - lastProgressAt >= VIDEO_CONFIG.progressIntervalMs) {
              lastProgressAt = now;
              const percent = totalFrames > 0
                ? Math.min(99, Math.round((encodedFrames / totalFrames) * 100))
                : 0;
              onProgress(percent);
            }
          })
          .on("error", (err: Error) => {
            reject(err);
          })
          .on("end", () => {
            resolve();
          })
          .run();

        // Push frames into the stream while respecting backpressure. Writing
        // hundreds of full-resolution PNG buffers in a tight synchronous loop
        // ignores the `false` returned by write() when the internal buffer is
        // full, buffering every frame in memory at once and producing a
        // truncated/corrupt MP4. Instead, pause on backpressure and resume on
        // the stream's "drain" event so ffmpeg consumes at its own pace.
        (async () => {
          try {
            for (const frame of allFrames) {
              const hasCapacity = frameStream.write(frame);
              if (!hasCapacity) {
                await new Promise<void>((resolveDrain) =>
                  frameStream.once("drain", resolveDrain),
                );
              }
            }
            frameStream.end();
          } catch (writeErr: unknown) {
            frameStream.destroy(
              writeErr instanceof Error ? writeErr : undefined,
            );
            reject(
              writeErr instanceof Error
                ? writeErr
                : new Error("Failed to write frames to the encoder."),
            );
          }
        })();
      });

      // Record file size
      const stat = fs.statSync(outputPath);
      job.fileSizeBytes = stat.size;
      job.sizeWarning = stat.size > VIDEO_CONFIG.maxFileSizeBytes;
      job.status = "complete";
      job.completedAtMs = Date.now();
      onProgress(100);
    } catch (err: unknown) {
      job.status = "failed";
      job.errorMessage =
        err instanceof Error ? err.message : "Unknown render error";
      throw new ApiError("internal_error", job.errorMessage);
    }

    return job;
  }

  /**
   * Abort an in-progress render job, kill ffmpeg, and delete the partial file.
   *
   * Waits up to `VIDEO_CONFIG.cancelTimeoutSeconds` seconds for cleanup to
   * complete before resolving.
   *
   * @param jobId - The UUID of the render job to cancel.
   * @throws {@link ApiError} With code `internal_error` if no job with the
   *   given ID is found.
   *
   * @remarks
   * Deletes the partial MP4 output file from `os.tmpdir()` as a side effect.
   */
  async abort(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new ApiError("internal_error", `Render job ${jobId} not found.`);
    }

    job.status = "cancelled";

    // Attempt to delete the partial output file
    if (job.outputPath) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, VIDEO_CONFIG.cancelTimeoutSeconds * 1000);
        try {
          if (fs.existsSync(job.outputPath!)) {
            fs.unlinkSync(job.outputPath!);
          }
        } catch {
          // Best-effort cleanup
        } finally {
          clearTimeout(timeout);
          resolve();
        }
      });
    }
  }

  /**
   * Delete output files for completed jobs whose retention TTL has elapsed.
   *
   * Mirrors the analysis cache's TTL approach: a completed job's MP4 is kept
   * on disk for `VIDEO_CONFIG.outputFileTtlMs` after completion so that a
   * HEAD size-check, the actual GET download, and any repeated downloads all
   * succeed. Once the TTL elapses the file is removed and the job record is
   * forgotten. This replaces the previous, buggy approach of deleting the
   * file on the download response's `finish` event, which fired for HEAD
   * requests and made the download single-use.
   *
   * @param nowMs - Current time in epoch milliseconds. Defaults to
   *   `Date.now()`; injectable for deterministic testing.
   * @returns The number of jobs swept (files deleted / records removed).
   *
   * @remarks
   * Deletes files from `os.tmpdir()` and removes entries from the in-memory
   * `jobs` map as a side effect. Best-effort: filesystem errors are swallowed
   * so one bad entry cannot stall the sweep.
   */
  sweepExpiredOutputs(nowMs: number = Date.now()): number {
    let swept = 0;
    for (const [jobId, job] of this.jobs) {
      if (job.status !== "complete" || job.completedAtMs === null) {
        continue;
      }
      if (nowMs - job.completedAtMs < VIDEO_CONFIG.outputFileTtlMs) {
        continue;
      }
      try {
        if (job.outputPath && fs.existsSync(job.outputPath)) {
          fs.unlinkSync(job.outputPath);
        }
      } catch {
        // Best-effort cleanup — never let one entry stall the sweep.
      }
      this.jobs.delete(jobId);
      swept++;
    }
    return swept;
  }
}

/** Module-level singleton renderer instance used by the route handlers. */
export const videoRenderer = new VideoRenderer();

/** Handle for the periodic output-file sweep, if running. */
let sweepIntervalHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Start the periodic sweep that deletes expired render output files.
 *
 * Idempotent: calling it while a sweep is already scheduled is a no-op. The
 * interval is `unref`'d so it does not keep the Node process alive on its own.
 *
 * @returns void
 *
 * @remarks
 * Schedules a recurring timer that invokes
 * {@link VideoRenderer.sweepExpiredOutputs} on the module singleton every
 * `VIDEO_CONFIG.outputFileSweepIntervalMs` milliseconds.
 */
export function startOutputSweep(): void {
  if (sweepIntervalHandle !== null) {
    return;
  }
  sweepIntervalHandle = setInterval(() => {
    videoRenderer.sweepExpiredOutputs();
  }, VIDEO_CONFIG.outputFileSweepIntervalMs);
  // Do not hold the event loop open solely for the sweep timer.
  sweepIntervalHandle.unref?.();
}

/**
 * Stop the periodic output-file sweep if it is running.
 *
 * @returns void
 */
export function stopOutputSweep(): void {
  if (sweepIntervalHandle !== null) {
    clearInterval(sweepIntervalHandle);
    sweepIntervalHandle = null;
  }
}
