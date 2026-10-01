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
  /**
   * Milliseconds a completed render's output file is retained on disk before
   * a periodic sweep deletes it. Downloads (including repeated downloads and
   * a HEAD size-check followed by a GET) must succeed within this window.
   */
  outputFileTtlMs: 10 * 60 * 1000, // 10 minutes
  /** Interval in milliseconds between output-file cleanup sweeps. */
  outputFileSweepIntervalMs: 60 * 1000, // 1 minute
} as const);

export const SLIDE_CONFIG = Object.freeze({
  /** Minimum number of slides in a storyboard */
  minSlides: 3,
  /** Maximum number of slides in a storyboard */
  maxSlides: 15,
  /** Maximum words shown in each slide preview summary */
  previewMaxWords: 50,
  /** Maximum words extracted from the README's first prose paragraph for the overview slide */
  introMaxWords: 120,
  /** Maximum section headings listed on a spec documentation slide */
  specMaxHeadings: 5,
  /** Maximum sentences extracted per spec section on a spec documentation slide */
  specMaxSentences: 3,
  /** Maximum Engineering Highlights extracted from commit history */
  maxHighlights: 10,
  /** Maximum steps/lines shown on the "how to run" slide */
  runMaxSteps: 8,
  /** Maximum words kept per step on the "how to run" slide */
  runMaxWordsPerStep: 20,
  /** Maximum Capabilities listed on the capabilities slide */
  capabilitiesMaxItems: 6,
  /** Maximum words kept per Capability */
  capabilityMaxWords: 20,
  /** Capabilities slide is omitted when more than this fraction of Capabilities match a Key_Feature */
  capabilitiesMaxOverlapRatio: 0.5,
  /** Maximum Key_Feature slides (individual + summary); a ceiling, not a target */
  maxFeatureSlides: 5,
  /** Maximum words kept per Key_Feature description */
  featureMaxWords: 40,
  /** Maximum evolution slides (timeline + notable changes + commit highlights); a ceiling, not a target */
  maxEvolutionSlides: 4,
  /** Maximum entries listed on the Evolution_Timeline slide */
  maxEvolutionItems: 8,
  /** Minimum eligible entries required before an Evolution_Timeline slide is generated */
  minEvolutionItems: 2,
  /** Maximum words kept for a PR / release / commit Change_Context */
  changeContextMaxWords: 30,
  /** Minimum length of a token that can act as an Anchor_Term for relevance matching */
  relevanceMinTermLength: 4,
  /** Maximum `feat:` commit highlights used when no Anchor_Terms exist; a ceiling within maxEvolutionSlides */
  maxFallbackHighlights: 2,
} as const);

export type VideoConfig = typeof VIDEO_CONFIG;
export type SlideConfig = typeof SLIDE_CONFIG;
