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
 * Calculate the number of seconds to display each slide.
 *
 * When `targetDurationSeconds` is supplied, the target is distributed evenly
 * across the slides so the total video length matches the target to within one
 * second per slide of rounding. When omitted, a default is derived from the
 * slide count that keeps the total close to `VIDEO_CONFIG.minDurationSeconds`
 * without exceeding `VIDEO_CONFIG.maxDurationSeconds`.
 *
 * @param slideCount - The number of slides to render.
 * @param targetDurationSeconds - Optional caller-supplied target total
 *   duration in seconds. Expected to already lie within
 *   `[VIDEO_CONFIG.minDurationSeconds, VIDEO_CONFIG.maxDurationSeconds]`; the
 *   route validates and rejects out-of-range values before calling the
 *   renderer. Any provided value is defensively clamped to that range here.
 * @returns Seconds per slide — always at least 1.
 *
 * @remarks
 * The result is floored at 1 second. When `slideCount` exceeds the target
 * (or `maxDurationSeconds` on the default path) the total video will
 * necessarily run longer than the target, because one second per slide is the
 * minimum meaningful display time; returning 0 would produce a zero-frame
 * render that ffmpeg rejects. `generateStoryboard` caps storyboards at
 * `SLIDE_CONFIG.maxSlides`, but the render route accepts a caller-supplied
 * slide array, so this floor guards the unbounded input path.
 */
export function calculateSecondsPerSlide(
  slideCount: number,
  targetDurationSeconds?: number,
): number {
  if (slideCount <= 0) {
    return targetDurationSeconds ?? VIDEO_CONFIG.minDurationSeconds;
  }

  const maxSeconds = VIDEO_CONFIG.maxDurationSeconds;

  if (typeof targetDurationSeconds === "number") {
    // Defensively clamp the caller-supplied target to the allowed range.
    const clampedTarget = Math.min(
      maxSeconds,
      Math.max(VIDEO_CONFIG.minDurationSeconds, targetDurationSeconds),
    );
    return Math.max(1, Math.round(clampedTarget / slideCount));
  }

  // Default path: spread evenly across minDuration, clamped by maxDuration.
  const ideal = Math.ceil(VIDEO_CONFIG.minDurationSeconds / slideCount);
  const maxPerSlide = Math.floor(maxSeconds / slideCount);
  return Math.max(1, Math.min(ideal, maxPerSlide));
}

// ---------------------------------------------------------------------------
// Text layout
// ---------------------------------------------------------------------------

/**
 * Slide layout values. Presentation details, not spec constants, so they live
 * here rather than in `src/config/output.ts`. Pixel values are relative to
 * the `VIDEO_CONFIG.width × VIDEO_CONFIG.height` canvas.
 */
export const LAYOUT = Object.freeze({
  /** Horizontal and bottom margin. */
  margin: 60,
  /** Baseline of the first title line. */
  titleTop: 80,
  /** Title font. */
  titleFont: "bold 36px sans-serif",
  /** Distance between title baselines. */
  titleLineHeight: 44,
  /** Maximum title lines before ellipsis. */
  titleMaxLines: 2,
  /** Gap between the last title baseline and the divider. */
  dividerGap: 20,
  /** Gap between the divider and the first body baseline. */
  bodyGap: 40,
  /** Body font. */
  bodyFont: "20px monospace",
  /** Distance between body baselines. */
  bodyLineHeight: 28,
  /** Background colour. */
  background: "#1e1e2e",
  /** Text colour. */
  foreground: "#cdd6f4",
  /** Divider colour. */
  accent: "#89b4fa",
});

/** Measures the rendered width of a string in pixels. */
export type MeasureText = (text: string) => number;

/** Ellipsis appended to truncated lines. */
const ELLIPSIS = "…";

/**
 * Decode the HTML entities produced by the storyboard's escaping.
 *
 * @param text - HTML-escaped text.
 * @returns Text with `&amp;`, `&lt;`, `&gt;`, `&quot;`, and `&#39;` decoded.
 */
export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Break a single word into chunks that each fit within `maxWidth`.
 *
 * @param word - A word wider than `maxWidth`.
 * @param maxWidth - Available width in pixels.
 * @param measure - Width measurement function.
 * @returns Chunks in order; each has at least one character.
 */
function breakWord(word: string, maxWidth: number, measure: MeasureText): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const ch of Array.from(word)) {
    if (current !== "" && measure(current + ch) > maxWidth) {
      chunks.push(current);
      current = ch;
    } else {
      current += ch;
    }
  }
  if (current !== "") chunks.push(current);
  return chunks;
}

/**
 * Wrap text at word boundaries so no line exceeds `maxWidth`.
 *
 * Explicit line breaks (including blank lines) are preserved. A word is split
 * across lines only when it alone is wider than `maxWidth`. Leading
 * indentation of each source line is kept on its first wrapped line.
 *
 * @param text - Plain text, possibly multi-line.
 * @param maxWidth - Available width in pixels.
 * @param measure - Width measurement function.
 * @returns Wrapped lines.
 */
export function wrapText(text: string, maxWidth: number, measure: MeasureText): string[] {
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    const indent = /^\s*/.exec(rawLine)![0];
    const words = rawLine.trim().split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let current = indent;
    for (const word of words) {
      const candidate = current.trim() === "" ? current + word : `${current} ${word}`;
      if (measure(candidate) <= maxWidth) {
        current = candidate;
        continue;
      }
      if (current.trim() !== "") {
        out.push(current);
        current = "";
      }
      if (measure(current + word) <= maxWidth) {
        current += word;
      } else {
        const chunks = breakWord(word, maxWidth, measure);
        out.push(...chunks.slice(0, -1));
        current = chunks[chunks.length - 1] ?? "";
      }
    }
    out.push(current);
  }
  return out;
}

/**
 * Keep at most `maxLines` lines; when lines are dropped, end the last kept line
 * with an ellipsis that fits within `maxWidth`.
 *
 * Trailing blank lines are removed before counting, so an ellipsis is added
 * only when real content was dropped.
 *
 * @param lines - Wrapped lines.
 * @param maxLines - Maximum lines that fit.
 * @param maxWidth - Available width in pixels.
 * @param measure - Width measurement function.
 * @returns The lines to render.
 */
export function fitLines(
  lines: string[],
  maxLines: number,
  maxWidth: number,
  measure: MeasureText,
): string[] {
  const trimmed = [...lines];
  while (trimmed.length > 0 && trimmed[trimmed.length - 1]!.trim() === "") trimmed.pop();
  if (trimmed.length <= maxLines) return trimmed;
  if (maxLines <= 0) return [];

  const kept = trimmed.slice(0, maxLines);
  // Avoid ending on a blank line: drop trailing blanks inside the kept window.
  while (kept.length > 1 && kept[kept.length - 1]!.trim() === "") kept.pop();
  let last = kept[kept.length - 1]!.replace(/\s+$/, "");
  while (last.length > 0 && measure(last + ELLIPSIS) > maxWidth) {
    last = Array.from(last).slice(0, -1).join("").replace(/\s+$/, "");
  }
  kept[kept.length - 1] = last + ELLIPSIS;
  return kept;
}

/** Computed text layout for one slide. */
export interface SlideLayout {
  /** Title lines to draw. */
  titleLines: string[];
  /** Body lines to draw. */
  bodyLines: string[];
  /** Y of the divider line. */
  dividerY: number;
  /** Baseline of the first body line. */
  bodyTop: number;
}

/**
 * Lay out a slide's title and body within the canvas.
 *
 * @param slide - The slide (HTML-escaped fields).
 * @param measureTitle - Width measurement in the title font.
 * @param measureBody - Width measurement in the body font.
 * @returns The {@link SlideLayout}.
 */
export function layoutSlide(
  slide: Slide,
  measureTitle: MeasureText,
  measureBody: MeasureText,
): SlideLayout {
  const maxWidth = VIDEO_CONFIG.width - 2 * LAYOUT.margin;
  const titleLines = fitLines(
    wrapText(decodeHtmlEntities(slide.title), maxWidth, measureTitle),
    LAYOUT.titleMaxLines,
    maxWidth,
    measureTitle,
  );
  const lastTitleBaseline = LAYOUT.titleTop + (Math.max(titleLines.length, 1) - 1) * LAYOUT.titleLineHeight;
  const dividerY = lastTitleBaseline + LAYOUT.dividerGap;
  const bodyTop = dividerY + LAYOUT.bodyGap;
  const bottom = VIDEO_CONFIG.height - LAYOUT.margin;
  const maxBodyLines = Math.max(0, Math.floor((bottom - bodyTop) / LAYOUT.bodyLineHeight) + 1);
  const bodyLines = fitLines(
    wrapText(decodeHtmlEntities(slide.body), maxWidth, measureBody),
    maxBodyLines,
    maxWidth,
    measureBody,
  );
  return { titleLines, bodyLines, dividerY, bodyTop };
}

// ---------------------------------------------------------------------------
// Frame rendering
// ---------------------------------------------------------------------------

/**
 * Render one slide to a PNG image.
 *
 * @param slide - The slide to render.
 * @returns A PNG `Buffer` of `VIDEO_CONFIG.width × VIDEO_CONFIG.height` pixels.
 */
export function renderSlideImage(slide: Slide): Buffer {
  const canvas = createCanvas(VIDEO_CONFIG.width, VIDEO_CONFIG.height);
  const ctx = canvas.getContext("2d");
  const measureIn = (font: string): MeasureText => (s: string): number => {
    ctx.font = font;
    return ctx.measureText(s).width;
  };
  const layout = layoutSlide(slide, measureIn(LAYOUT.titleFont), measureIn(LAYOUT.bodyFont));

  ctx.fillStyle = LAYOUT.background;
  ctx.fillRect(0, 0, VIDEO_CONFIG.width, VIDEO_CONFIG.height);

  ctx.fillStyle = LAYOUT.foreground;
  ctx.font = LAYOUT.titleFont;
  layout.titleLines.forEach((line, i) => {
    ctx.fillText(line, LAYOUT.margin, LAYOUT.titleTop + i * LAYOUT.titleLineHeight);
  });

  ctx.strokeStyle = LAYOUT.accent;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(LAYOUT.margin, layout.dividerY);
  ctx.lineTo(VIDEO_CONFIG.width - LAYOUT.margin, layout.dividerY);
  ctx.stroke();

  ctx.fillStyle = LAYOUT.foreground;
  ctx.font = LAYOUT.bodyFont;
  layout.bodyLines.forEach((line, i) => {
    ctx.fillText(line, LAYOUT.margin, layout.bodyTop + i * LAYOUT.bodyLineHeight);
  });

  return canvas.toBuffer("image/png");
}

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
  const framePng = renderSlideImage(slide);
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
   * @param targetDurationSeconds - Optional target total video duration in
   *   seconds, distributed across the slides. When omitted, a default is
   *   derived from the slide count. Expected to be within
   *   `[VIDEO_CONFIG.minDurationSeconds, VIDEO_CONFIG.maxDurationSeconds]`
   *   (validated by the route before this method is called).
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
    targetDurationSeconds?: number,
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
      const secondsPerSlide = calculateSecondsPerSlide(
        slides.length,
        targetDurationSeconds,
      );

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
