/**
 * Shared domain types for the GitHub Repository Visualizer.
 *
 * These types are used across frontend components, backend API routes,
 * and server modules. No business logic lives here — only type definitions.
 */

// ---------------------------------------------------------------------------
// Repository analysis types
// ---------------------------------------------------------------------------

/** A single commit record fetched from the GitHub commits API. */
export interface Commit {
  /** Full 40-character SHA hash of the commit. */
  sha: string;
  /** Display name of the commit author. */
  author: string;
  /** ISO 8601 timestamp of when the commit was authored. */
  timestamp: string;
  /** The first line of the commit message. */
  subject: string;
  /**
   * The remainder of the commit message after the first line, with leading
   * blank lines trimmed. Empty string when the commit has no body. Trailer
   * lines are retained here and removed during Change_Context extraction.
   */
  body: string;
  /** Alias of `subject`, retained for existing callers. */
  message: string;
}

/** A merged pull request fetched from the GitHub pulls API. */
export interface PullRequest {
  /** Pull request number. */
  number: number;
  /** Pull request title. */
  title: string;
  /** Pull request description; empty string when absent. Length-capped by the analyzer. */
  body: string;
  /** Lowercased label names. */
  labels: string[];
  /** ISO 8601 merge timestamp. Only merged pull requests are retained. */
  mergedAt: string;
  /** True when the author account is a bot. */
  isBot: boolean;
}

/** A published, non-draft GitHub release. */
export interface Release {
  /** Release display name, or null when unnamed. */
  name: string | null;
  /** Git tag the release points at. */
  tagName: string;
  /** ISO 8601 publication timestamp. */
  publishedAt: string;
  /** Release notes; empty string when absent. Length-capped by the analyzer. */
  body: string;
}

/** Repository-level metadata from the GitHub repository endpoint. */
export interface RepoMetadata {
  /** Short repository description, or null. */
  description: string | null;
  /** Repository topics. */
  topics: string[];
  /** Star count, or null when unavailable. */
  stars: number | null;
  /** Primary language, or null. */
  language: string | null;
  /** License SPDX id or name, or null. */
  license: string | null;
}

/** The nature of a notable change. */
export type ChangeCategory = "Breaking Change" | "Feature" | "Bug Fix" | "Refactor";

/** A single node in the repository's git tree. */
export interface DirectoryNode {
  /** Repository-relative path to the file or directory. */
  path: string;
  /** Whether the node is a file blob or a tree (directory). */
  type: "blob" | "tree";
  /** File size in bytes; only present for blob nodes. */
  size?: number;
}

/** A spec document fetched from the `.kiro` directory. */
export interface SpecDocument {
  /** Repository-relative path to the spec file. */
  path: string;
  /** Raw text content of the spec file. */
  content: string;
}

/**
 * The full result of analysing a GitHub repository.
 *
 * Every data section may be empty because any extraction step may have been
 * skipped due to a partial failure, or the source may legitimately be empty. The `partialFailures`
 * array records the names of steps that were skipped.
 */
export interface RepoAnalysisResult {
  /** GitHub owner (user or organisation) login name. */
  owner: string;
  /** GitHub repository name. */
  repo: string;
  /** Repository metadata, or null if the step failed. */
  metadata: RepoMetadata | null;
  /** Flat list of directory/file nodes up to 3 path-separator levels deep. */
  directoryTree: DirectoryNode[];
  /** Raw text of the repository README, or null if not present or failed. */
  readmeText: string | null;
  /** Up to 50 most-recent commits. */
  commits: Commit[];
  /** Markdown spec documents found under `.kiro/specs/` (at most 6). */
  specDocs: SpecDocument[];
  /** Merged pull requests among the 50 most recently updated closed PRs. */
  pullRequests: PullRequest[];
  /** Published, non-draft releases among the 10 most recent. */
  releases: Release[];
  /**
   * Names of extraction steps that were skipped due to non-fatal errors.
   * An empty array means all steps succeeded.
   */
  partialFailures: string[];
}

// ---------------------------------------------------------------------------
// Storyboard types
// ---------------------------------------------------------------------------

/**
 * Discriminated union of all slide types produced by the storyboard generator.
 *
 * - `"intro"` — overview: name, description, topics, first README paragraph
 * - `"capabilities"` — what users can do with the repository
 * - `"run"` — "how to run this repository" steps extracted from the README
 * - `"architecture"` — ASCII tree of the top-level directory structure
 * - `"howItWorks"` — how the repository works (README section or spec docs)
 * - `"feature"` — one Key_Feature, or the Key_Feature summary slide
 * - `"evolution"` — Evolution_Timeline of releases and significant PRs
 * - `"change"` — deep dive on a significant PR or release
 * - `"highlight"` — a commit used as fallback or supplementary evolution evidence
 * - `"conclusion"` — closing slide with repo name, URL, and metadata
 */
export type SlideType =
  | "intro"
  | "capabilities"
  | "run"
  | "architecture"
  | "howItWorks"
  | "feature"
  | "evolution"
  | "change"
  | "highlight"
  | "conclusion";

/** A single slide in a generated storyboard. */
export interface Slide {
  /** Stable UUID used for drag-reorder and remove operations. */
  id: string;
  /** The category of content on this slide. */
  type: SlideType;
  /** Short title rendered at the top of the slide card. */
  title: string;
  /** HTML-escaped body text for the slide; may contain newlines. */
  body: string;
  /** Truncated plain-text summary shown in the preview card (≤ 50 words). */
  previewSummary: string;
}

// ---------------------------------------------------------------------------
// Render job types
// ---------------------------------------------------------------------------

/** The status lifecycle of a server-side video render job. */
export type RenderJobStatus =
  | "pending"
  | "rendering"
  | "complete"
  | "failed"
  | "cancelled";

/** A server-side video render job record. */
export interface RenderJob {
  /** UUID that uniquely identifies this render job. */
  id: string;
  /** Current lifecycle status of the job. */
  status: RenderJobStatus;
  /** Absolute path to the rendered MP4 file, or null if not yet complete. */
  outputPath: string | null;
  /** Size of the completed output file in bytes, or null if not yet complete. */
  fileSizeBytes: number | null;
  /** Human-readable error message if status is `"failed"`. */
  errorMessage: string | null;
  /** True when `fileSizeBytes` exceeds `VIDEO_CONFIG.maxFileSizeBytes`. */
  sizeWarning: boolean;
  /**
   * Epoch milliseconds at which the job reached `"complete"`, or null if it
   * has not completed. Used by the renderer's periodic sweep to delete the
   * output file once it is older than `VIDEO_CONFIG.outputFileTtlMs`.
   */
  completedAtMs: number | null;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * All valid error codes that can be returned by the API.
 *
 * - `invalid_url`          — URL fails the GitHub allowlist regex
 * - `repo_not_found`       — repository is inaccessible or does not exist
 * - `rate_limit_exceeded`  — GitHub API rate limit hit
 * - `request_timeout`      — individual outbound request exceeded 10 s
 * - `network_error`        — generic DNS/connection failure
 * - `partial_data`         — some extraction steps failed; partial result returned
 * - `insufficient_content` — storyboard cannot reach minimum slide count
 * - `internal_error`       — unexpected server-side failure
 */
export type ApiErrorCode =
  | "invalid_url"
  | "repo_not_found"
  | "rate_limit_exceeded"
  | "request_timeout"
  | "network_error"
  | "partial_data"
  | "insufficient_content"
  | "internal_error";

/**
 * Typed error class used throughout the server to represent all known
 * failure modes. Route handlers map these to structured JSON responses.
 */
export class ApiError extends Error {
  /** Machine-readable error code used by route handlers for HTTP status mapping. */
  public readonly code: ApiErrorCode;

  /**
   * Construct a new ApiError.
   *
   * @param code - The machine-readable error code.
   * @param message - A human-readable description of the error.
   */
  constructor(code: ApiErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "ApiError";
    // Maintain proper prototype chain in compiled JS
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}
