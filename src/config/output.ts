/**
 * Output constants for the GitHub Repository Visualizer.
 *
 * This is the single source of truth for all video and slide specification
 * constants. No other module may declare inline literals for these values.
 * All consumers must import from this module.
 */

export const VIDEO_CONFIG = Object.freeze({
  /** Output frame width in pixels */
  width: 1280,
  /** Output frame height in pixels */
  height: 720,
  /** Frames per second */
  fps: 30,
  /** Video codec identifier */
  codec: "h264",
  /** Container format */
  container: "mp4",
  /** Minimum video duration in seconds */
  minDurationSeconds: 30,
  /** Maximum video duration in seconds */
  maxDurationSeconds: 300, // 5 minutes
  /** Maximum downloadable file size in bytes before warning the user */
  maxFileSizeBytes: 200 * 1024 * 1024, // 200 MB
  /** Progress indicator update interval in milliseconds */
  progressIntervalMs: 2_000,
  /** Milliseconds after render completion before download is offered */
  downloadReadyMs: 5_000,
  /** Maximum time in seconds to honour a cancellation request */
  cancelTimeoutSeconds: 3,
} as const);

export const SLIDE_CONFIG = Object.freeze({
  /** Minimum number of slides in a storyboard */
  minSlides: 3,
  /** Maximum number of slides in a storyboard */
  maxSlides: 15,
  /** Maximum words shown in each slide preview summary */
  previewMaxWords: 50,
  /** Maximum words extracted from README for the introduction slide */
  introMaxWords: 300,
  /** Maximum section headings listed on a spec documentation slide */
  specMaxHeadings: 5,
  /** Maximum sentences extracted per spec section on a spec documentation slide */
  specMaxSentences: 3,
  /** Maximum Engineering Highlights extracted from commit history */
  maxHighlights: 10,
} as const);

export type VideoConfig = typeof VIDEO_CONFIG;
export type SlideConfig = typeof SLIDE_CONFIG;
