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

// ---------------------------------------------------------------------------
// Progress heartbeat (Req 4.3, 4.17, 4.18)
// ---------------------------------------------------------------------------

/**
 * Heartbeat interval. Half of the required maximum gap, so one late timer
 * tick still keeps consecutive events within `VIDEO_CONFIG.progressIntervalMs`.
 */
export const HEARTBEAT_MS = VIDEO_CONFIG.progressIntervalMs / 2;

/** Share of the 0–99 progress scale covered by frame preparation; encoding covers the rest. */
export const FRAME_PHASE_WEIGHT = 0.1;

/** Highest percentage reported before the single terminal 100 event. */
const MAX_RUNNING_PERCENT = 99;

/**
 * Holds the current render progress and emits it on a fixed timer.
 *
 * `update()` only stores a value; the timer started by `start()` is the sole
 * emitter, so the cadence never depends on how often ffmpeg reports.
 */
export class ProgressTracker {
  private percent = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  /**
   * Create a tracker.
   *
   * @param emit - Receives the current percentage on every heartbeat.
   */
  constructor(private readonly emit: ProgressCallback) {}

  /**
   * Store a new progress estimate without emitting.
   *
   * @param fraction - Overall completion in [0, 1]; values are clamped, rounded,
   *   kept non-decreasing, and capped at 99.
   */
  update(fraction: number): void {
    if (this.stopped || !Number.isFinite(fraction)) return;
    const next = Math.min(MAX_RUNNING_PERCENT, Math.round(Math.max(0, Math.min(1, fraction)) * 100));
    if (next > this.percent) this.percent = next;
  }

  /** The last stored percentage. */
  get current(): number {
    return this.percent;
  }

  /**
   * Emit the current value now, then every {@link HEARTBEAT_MS}. Idempotent.
   *
   * @remarks
   * Schedules a recurring timer until {@link ProgressTracker.stop} is called.
   */
  start(): void {
    if (this.stopped || this.timer !== null) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), HEARTBEAT_MS);
  }

  /** Clear the timer and turn every later call into a no-op. Idempotent. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Emit the stored value unless stopped. */
  private tick(): void {
    if (!this.stopped) this.emit(this.percent);
  }
}

/** Yield to the event loop so timers (the heartbeat) can run. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Statuses that never change again (Req 4.20). */
const TERMINAL_STATES: ReadonlySet<RenderJobStatus> = new Set(["complete", "failed", "cancelled"]);

/** Allowed status transitions of the Render_Job state machine. */
const ALLOWED_TRANSITIONS: Readonly<Record<RenderJobStatus, readonly RenderJobStatus[]>> = {
  pending: ["rendering", "cancelled"],
  rendering: ["complete", "failed", "cancelled"],
  complete: [],
  failed: [],
  cancelled: [],
};

/**
 * Compare-and-set a job's status (the only way to change `job.status`).
 *
 * @param job - The job to update.
 * @param from - Statuses the job must currently be in.
 * @param to - The new status; must be an allowed transition from the current one.
 * @returns True when the status was changed.
 */
export function transition(job: RenderJob, from: readonly RenderJobStatus[], to: RenderJobStatus): boolean {
  if (!from.includes(job.status) || !ALLOWED_TRANSITIONS[job.status].includes(to)) return false;
  job.status = to;
  return true;
}

/** True when the job is in a Terminal_State. */
export function isTerminal(job: RenderJob): boolean {
  return TERMINAL_STATES.has(job.status);
}

/**
 * Time after the cancellation request at which `SIGKILL` replaces `SIGTERM`.
 * Half of the cancellation deadline, leaving room to confirm exit and delete the file.
 */
export const KILL_GRACE_MS = (VIDEO_CONFIG.cancelTimeoutSeconds * 1000) / 2;

/** The subset of fluent-ffmpeg's command used for cancellation. */
interface KillableCommand {
  kill(signal: string): unknown;
  ffmpegProc?: ChildProcessLike;
}

/** The subset of a child process observed for confirmed exit. */
interface ChildProcessLike {
  once(event: "exit", listener: () => void): unknown;
  removeListener(event: "exit", listener: () => void): unknown;
  exitCode: number | null;
  signalCode: string | null;
}

/** Observes confirmed exit of the encoder process for one job. */
class EncoderExit {
  /** The fluent-ffmpeg command, once `run()` was called. */
  command: KillableCommand | null = null;
  /** The spawned child process, once fluent-ffmpeg emitted `start`. */
  private child: ChildProcessLike | null = null;
  /** Signal to deliver as soon as the child spawns (cancellation before spawn). */
  private pendingSignal: string | null = null;
  private exitedFlag = false;
  private readonly waiters = new Set<() => void>();
  private childListener: (() => void) | null = null;

  /** Whether an encoder was started (`run()` called). */
  get started(): boolean {
    return this.command !== null;
  }

  /** Whether exit has been confirmed. */
  get exited(): boolean {
    return this.exitedFlag;
  }

  /**
   * Record the spawned child and observe its own `exit` event.
   *
   * @param child - The child process (`command.ffmpegProc`).
   */
  attachChild(child: ChildProcessLike | undefined): void {
    if (!child || this.child) return;
    this.child = child;
    if (child.exitCode !== null || child.signalCode !== null) {
      this.markExited();
      return;
    }
    this.childListener = () => this.markExited();
    child.once("exit", this.childListener);
    if (this.pendingSignal) this.signal(this.pendingSignal);
  }

  /**
   * fluent-ffmpeg reported `end`/`error`. That confirms exit only when no
   * child ever spawned; otherwise the child's own `exit` event is authoritative.
   */
  commandSettled(): void {
    if (this.child === null) this.markExited();
  }

  /**
   * Send a signal to the encoder, or queue it until the child spawns.
   *
   * @param sig - `SIGTERM` or `SIGKILL`.
   */
  signal(sig: string): void {
    if (this.exitedFlag || !this.command) return;
    if (!this.child) {
      this.pendingSignal = sig;
      return;
    }
    this.command.kill(sig);
  }

  /**
   * Wait until exit is confirmed or `ms` elapses.
   *
   * @param ms - Maximum wait in milliseconds.
   * @returns True when exit was confirmed.
   */
  waitForExit(ms: number): Promise<boolean> {
    if (this.exitedFlag) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve(this.exitedFlag);
      };
      const timer = setTimeout(done, Math.max(0, ms));
      this.waiters.add(done);
    });
  }

  /**
   * Run a callback once exit is confirmed, without any timer. Used to keep a
   * surviving process observed after a cancellation-termination failure.
   *
   * @param cb - Called once on confirmed exit.
   */
  onExit(cb: () => void): void {
    if (this.exitedFlag) {
      cb();
      return;
    }
    this.exitCallbacks.push(cb);
  }

  private readonly exitCallbacks: (() => void)[] = [];

  private markExited(): void {
    if (this.exitedFlag) return;
    this.exitedFlag = true;
    if (this.child && this.childListener) this.child.removeListener("exit", this.childListener);
    this.childListener = null;
    for (const w of [...this.waiters]) w();
    for (const cb of this.exitCallbacks.splice(0)) cb();
  }
}

/** Per-job record of a job that has not settled yet. */
interface ActiveRender {
  tracker: ProgressTracker;
  controller: AbortController;
  encoder: EncoderExit;
  /** The in-flight cancellation, shared by concurrent callers. */
  cancelling: Promise<void> | null;
}

/**
 * Delete a file if present, never throwing.
 *
 * @param filePath - The file to remove.
 * @returns The error, if removal failed for a reason other than absence.
 *
 * @remarks
 * Removes a file from `os.tmpdir()` as a side effect.
 */
function removeFileQuietly(filePath: string | null): Error | null {
  if (!filePath) return null;
  try {
    fs.rmSync(filePath, { force: true });
    return null;
  } catch (err: unknown) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * Singleton-style video renderer that manages render job lifecycle.
 *
 * Each job is stored in an in-memory `Map` keyed by UUID and moves through
 * the guarded state machine `pending → rendering → complete | failed |
 * cancelled` (`pending → cancelled` also allowed). Jobs write their output
 * to `os.tmpdir()/<jobId>.mp4`.
 */
export class VideoRenderer {
  /** In-memory store of all render jobs keyed by job UUID. */
  public readonly jobs: Map<string, RenderJob> = new Map();

  /** Records of jobs that have not settled yet, keyed by job UUID. */
  private readonly active: Map<string, ActiveRender> = new Map();

  /**
   * Create and register a pending job. No rendering work is done.
   *
   * @returns The new {@link RenderJob}, whose `id` can be exposed immediately (Req 4.19).
   */
  createJob(): RenderJob {
    const id = randomUUID();
    const job: RenderJob = {
      id,
      status: "pending",
      outputPath: buildOutputPath(id),
      fileSizeBytes: null,
      errorMessage: null,
      sizeWarning: false,
      completedAtMs: null,
    };
    this.jobs.set(id, job);
    this.active.set(id, {
      tracker: new ProgressTracker(() => {}),
      controller: new AbortController(),
      encoder: new EncoderExit(),
      cancelling: null,
    });
    return job;
  }

  /**
   * Create a job and run it (compatibility wrapper for {@link createJob} + {@link run}).
   *
   * @param slides - The ordered slides to render.
   * @param onProgress - Heartbeat callback (non-decreasing 0–99).
   * @param targetDurationSeconds - Optional validated target duration in seconds.
   * @returns The settled job (`complete` or `cancelled`).
   * @throws {@link ApiError} With code `internal_error` if the job fails.
   *
   * @remarks
   * Writes one MP4 file to `os.tmpdir()`.
   */
  async start(slides: Slide[], onProgress: ProgressCallback, targetDurationSeconds?: number): Promise<RenderJob> {
    return this.run(this.createJob().id, slides, onProgress, targetDurationSeconds);
  }

  /**
   * Render a pending job: frame preparation, then H.264/MP4 encoding.
   *
   * A {@link ProgressTracker} emits progress every {@link HEARTBEAT_MS} during
   * both phases; ffmpeg reports only update the stored value. The terminal
   * 100 event is the caller's. Frame preparation checks the job's abort
   * signal after each slide. Completion and failure go through the guarded
   * state machine, so a cancelled job is never completed or failed.
   *
   * @param jobId - A job created by {@link createJob}.
   * @param slides - The ordered slides to render.
   * @param onProgress - Heartbeat callback (non-decreasing 0–99).
   * @param targetDurationSeconds - Optional validated target duration in seconds.
   * @returns The settled job: `complete`, or `cancelled` (also returned
   *   immediately for a job cancelled while pending).
   * @throws {@link ApiError} With code `internal_error` if the job is unknown,
   *   not pending, or fails (the partial output is deleted first, Req 4.7).
   *
   * @remarks
   * Writes one MP4 file to `os.tmpdir()`; deletes it on failure.
   */
  async run(
    jobId: string,
    slides: Slide[],
    onProgress: ProgressCallback,
    targetDurationSeconds?: number,
  ): Promise<RenderJob> {
    const job = this.jobs.get(jobId);
    const record = this.active.get(jobId);
    if (!job) throw new ApiError("internal_error", `Render job ${jobId} not found.`);
    if (job.status === "cancelled") return job;
    if (!record || !transition(job, ["pending"], "rendering")) {
      throw new ApiError("internal_error", `Render job ${jobId} is not pending.`);
    }

    const tracker = new ProgressTracker(onProgress);
    record.tracker = tracker;
    const { signal } = record.controller;
    const outputPath = job.outputPath!;

    try {
      tracker.start();
      const secondsPerSlide = calculateSecondsPerSlide(slides.length, targetDurationSeconds);

      // Frame preparation, stopping at the next slide boundary once aborted.
      const allFrames: Buffer[] = [];
      for (let i = 0; i < slides.length; i++) {
        if (signal.aborted) return job;
        allFrames.push(...renderSlideFrames(slides[i]!, secondsPerSlide));
        tracker.update(((i + 1) / slides.length) * FRAME_PHASE_WEIGHT);
        await yieldToEventLoop();
      }
      if (signal.aborted) return job;

      const totalFrames = allFrames.length;
      await new Promise<void>((resolve, reject) => {
        const command = Ffmpeg();
        record.encoder.command = command as unknown as KillableCommand;

        const { PassThrough } = require("stream") as typeof import("stream");
        const frameStream = new PassThrough();
        signal.addEventListener("abort", () => frameStream.destroy(), { once: true });

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
          .on("start", () => {
            record.encoder.attachChild((command as unknown as KillableCommand).ffmpegProc);
          })
          .on("progress", (progress: { frames?: number }) => {
            // ffmpeg's encoded-frame count only updates the stored value; the
            // heartbeat timer alone decides when progress is emitted.
            if (typeof progress.frames === "number" && totalFrames > 0) {
              tracker.update(
                FRAME_PHASE_WEIGHT + (1 - FRAME_PHASE_WEIGHT) * (progress.frames / totalFrames),
              );
            }
          })
          .on("error", (err: Error) => {
            record.encoder.commandSettled();
            reject(err);
          })
          .on("end", () => {
            record.encoder.commandSettled();
            resolve();
          })
          .run();

        // Push frames while respecting backpressure; stop once aborted.
        (async () => {
          try {
            for (const frame of allFrames) {
              if (signal.aborted) return;
              const hasCapacity = frameStream.write(frame);
              if (!hasCapacity) {
                await new Promise<void>((resolveDrain) => {
                  // Resume on drain, or on close after an abort; remove both listeners either way.
                  const done = (): void => {
                    frameStream.removeListener("drain", done);
                    frameStream.removeListener("close", done);
                    resolveDrain();
                  };
                  frameStream.once("drain", done);
                  frameStream.once("close", done);
                });
              }
            }
            frameStream.end();
          } catch (writeErr: unknown) {
            if (signal.aborted) return;
            frameStream.destroy(writeErr instanceof Error ? writeErr : undefined);
            reject(writeErr instanceof Error ? writeErr : new Error("Failed to write frames to the encoder."));
          }
        })();
      });

      // Completion: guarded so a cancelled job is never completed (Req 4.20).
      if (job.status !== "rendering") return job;
      const stat = fs.statSync(outputPath);
      job.fileSizeBytes = stat.size;
      job.sizeWarning = stat.size > VIDEO_CONFIG.maxFileSizeBytes;
      job.completedAtMs = Date.now();
      if (!transition(job, ["rendering"], "complete")) {
        job.fileSizeBytes = null;
        job.sizeWarning = false;
        job.completedAtMs = null;
      }
      return job;
    } catch (err: unknown) {
      // Cancellation won: the encoder's error is the expected result of the kill.
      if (!transition(job, ["rendering"], "failed")) return job;
      // Failure (Req 4.7): delete the partial output; no signal is sent.
      job.errorMessage = err instanceof Error ? err.message : "Unknown render error";
      const cleanupError = removeFileQuietly(outputPath);
      if (cleanupError) {
        console.error(`[renderer] job ${jobId}: failed to delete partial output: ${cleanupError.message}`);
      }
      throw new ApiError("internal_error", job.errorMessage);
    } finally {
      // Release the heartbeat on every outcome. The route sends the single 100 (Req 4.17).
      tracker.stop();
      if (record.cancelling === null) this.active.delete(jobId);
    }
  }

  /**
   * Cancel a job: the single cancellation implementation (DELETE, client
   * disconnect, internal callers). Idempotent; concurrent callers share one
   * in-flight cancellation, and a job in a Terminal_State is left unchanged.
   *
   * Sequence: claim `cancelled` → stop progress → abort frame work →
   * `SIGTERM` → wait for confirmed exit → `SIGKILL` at {@link KILL_GRACE_MS}
   * → wait for confirmed exit until `VIDEO_CONFIG.cancelTimeoutSeconds` →
   * delete the partial output.
   *
   * @param jobId - The job to cancel.
   * @throws {@link ApiError} With code `internal_error` if the job is unknown,
   *   or if the encoder's exit could not be confirmed by the deadline
   *   (cancellation-termination failure; the job still stays cancelled).
   *
   * @remarks
   * Sends signals to the ffmpeg child process and deletes the partial MP4
   * from `os.tmpdir()`.
   */
  async cancel(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) throw new ApiError("internal_error", `Render job ${jobId} not found.`);
    const record = this.active.get(jobId);
    if (record?.cancelling) return record.cancelling;
    if (!record || !transition(job, ["pending", "rendering"], "cancelled")) return;

    record.cancelling = this.runCancellation(job, record).finally(() => {
      this.active.delete(jobId);
    });
    return record.cancelling;
  }

  /** Alias of {@link VideoRenderer.cancel}, kept for existing callers. */
  async abort(jobId: string): Promise<void> {
    return this.cancel(jobId);
  }

  /** Steps 2–8 of the cancellation sequence for a job already marked cancelled. */
  private async runCancellation(job: RenderJob, record: ActiveRender): Promise<void> {
    const deadline = Date.now() + VIDEO_CONFIG.cancelTimeoutSeconds * 1000;
    const graceAt = Date.now() + KILL_GRACE_MS;
    record.tracker.stop();
    record.controller.abort();

    const { encoder } = record;
    let confirmed = true;
    if (encoder.started) {
      encoder.signal("SIGTERM");
      confirmed = await encoder.waitForExit(graceAt - Date.now());
      if (!confirmed) {
        encoder.signal("SIGKILL");
        confirmed = await encoder.waitForExit(deadline - Date.now());
      }
    }

    const cleanupError = removeFileQuietly(job.outputPath);
    if (cleanupError) {
      console.error(`[renderer] job ${job.id}: failed to delete partial output: ${cleanupError.message}`);
    }

    if (!confirmed) {
      const message = `Cancellation-termination failure: encoder exit for job ${job.id} not confirmed within ${VIDEO_CONFIG.cancelTimeoutSeconds}s.`;
      job.errorMessage = message;
      console.error(`[renderer] ${message}`);
      // Keep observing the surviving process so its late exit is still recorded.
      encoder.onExit(() => {
        console.warn(`[renderer] job ${job.id}: encoder exited after the cancellation deadline.`);
      });
      throw new ApiError("internal_error", message);
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
