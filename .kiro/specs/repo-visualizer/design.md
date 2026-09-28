# Design Document

## Overview

The GitHub Repository Visualizer is a single-page web application with a Node.js/TypeScript backend API. A user submits a public GitHub repository URL; the system fetches repository data via the GitHub REST API, synthesizes a storyboard of slides, lets the user preview and reorder them, then renders and downloads an MP4 video.

The system is split into three logical tiers:

- **Frontend** — React SPA (Vite) that drives the four-step user flow
- **Backend API** — Express server that owns all GitHub communication, storyboard generation, and video rendering
- **Config layer** — a single `src/config/output.ts` module that is the sole source of truth for all video and slide constants

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Browser (React SPA)                  │
│  ┌──────────┐  ┌──────────────┐  ┌──────────┐  ┌────────┐  │
│  │  URL     │  │  Analysis    │  │Storyboard│  │ Video  │  │
│  │  Input   │→ │  Progress    │→ │  Preview │→ │ Export │  │
│  └──────────┘  └──────────────┘  └──────────┘  └────────┘  │
└─────────────────────┬───────────────────────────────────────┘
                      │ HTTPS REST (JSON)
┌─────────────────────▼───────────────────────────────────────┐
│                    Express API Server                        │
│                                                             │
│  POST /api/analyze       →  RepositoryAnalyzer              │
│  GET  /api/storyboard    →  StoryboardGenerator             │
│  POST /api/render        →  VideoRenderer (SSE progress)    │
│  DELETE /api/render/:id  →  VideoRenderer                   │
│  GET  /api/download/:id  →  file stream                     │
└────────────┬──────────────────────────┬─────────────────────┘
             │                          │
  ┌──────────▼──────────┐   ┌───────────▼───────────┐
  │   GitHub REST API   │   │  Local temp directory  │
  │  api.github.com     │   │  (rendered MP4 files)  │
  └─────────────────────┘   └───────────────────────┘
```

---

## Components and Interfaces

### 1. URL Input Component (`src/components/UrlInput.tsx`)

Renders the repository URL form. Responsible for client-side format pre-validation before submission.

**Behaviour:**
- Text input with `maxLength={2048}`
- On submit: validates against `/^https:\/\/github\.com\/[a-zA-Z0-9_-]{1,100}\/[a-zA-Z0-9_-]{1,100}$/` before calling the API
- Displays inline error on format failure; shows loading spinner and disables submit button while the API call is in flight
- Surfaces API error messages (`invalid_url`, `repo_not_found`, `request_timeout`) as inline text beneath the input

---

### 2. Repository Analyzer (`src/server/analyzer.ts`)

Owns all GitHub API communication. Called by `POST /api/analyze`.

**Responsibilities:**
- Re-validate URL server-side (never trust client validation alone)
- Extract `owner` and `repo` tokens; build all GitHub API URLs from tokens only
- Enforce the allowed host set: `{ api.github.com, raw.githubusercontent.com }`
- Apply a 10-second `AbortController` timeout to every individual fetch
- Cap response body reads at 10 MB
- Run four extraction steps independently; skip and record failures rather than aborting:
  1. Directory tree (3 levels deep) — `GET /repos/{owner}/{repo}/git/trees/HEAD?recursive=1`
  2. README content — `GET /repos/{owner}/{repo}/readme` (root-level only, ≤ 1 MB)
  3. Commit history — `GET /repos/{owner}/{repo}/commits?per_page=50`
  4. `.kiro` spec docs — `GET /repos/{owner}/{repo}/contents/.kiro` (each file ≤ 1 MB)

**Return type:**
```typescript
interface RepoAnalysisResult {
  owner: string;
  repo: string;
  directoryTree: DirectoryNode[];
  readmeText: string | null;
  commits: Commit[];
  specDocs: SpecDocument[];
  partialFailures: string[];   // names of steps that were skipped
}
```

**Error handling:** Throws typed `ApiError` instances (`invalid_url`, `repo_not_found`, `rate_limit_exceeded`, `request_timeout`, `network_error`). The route handler catches these and returns the structured JSON error response.

---

### 3. Storyboard Generator (`src/server/storyboard.ts`)

Transforms a `RepoAnalysisResult` into an ordered `Slide[]`. Pure function — no I/O.

**Slide assembly order** (per spec):
1. **Introduction slide** — first 300 words of README (or repo name + description if no README)
2. **Architecture overview slide** — top-level directory structure rendered as a tree
3. **Engineering Highlight slides** — up to 10 commits whose messages match keywords `feat|fix|refactor|add|implement|redesign` (case-insensitive); one slide per highlight
4. **Spec documentation slide** — if `.kiro` docs exist: document title + up to 5 section headings + up to 3 sentences from sections whose headings contain "design", "architecture", or "decision"
5. **Conclusion slide** — repository name, star count, primary language, link

**Constraints enforced here** (imported from `src/config/output.ts`):
- `SLIDE_CONFIG.minSlides` (3) — throws `insufficient_content` error if slides cannot reach minimum
- `SLIDE_CONFIG.maxSlides` (15) — trims highlight slides from the end if over limit

**Return type:**
```typescript
interface Slide {
  id: string;           // stable UUID for reorder/remove operations
  type: SlideType;      // "intro" | "architecture" | "highlight" | "spec" | "conclusion"
  title: string;
  body: string;         // markdown-safe text, HTML-escaped
  previewSummary: string; // ≤ 50 words
}
```

---

### 4. Storyboard Preview Component (`src/components/StoryboardPreview.tsx`)

Displays the generated slides with drag-to-reorder and per-slide remove controls.

**Behaviour:**
- Renders each slide as a card showing `slide.title` and `slide.previewSummary`
- Drag-and-drop reordering via HTML5 Drag API (or `@dnd-kit/core` if already a project dependency)
- Remove button on each card; guarded: if current slide count equals `SLIDE_CONFIG.minSlides`, the remove button is disabled with a tooltip explaining the minimum
- "Export Video" button becomes active only when at least one slide is present
- Slide state is held in React component state; only the final ordered array is sent to the render API

---

### 5. Video Renderer (`src/server/renderer.ts`)

Converts a `Slide[]` into an MP4 file. Runs on the server.

**Technology:** [`canvas`](https://www.npmjs.com/package/canvas) (node-canvas) for frame rasterisation + [`fluent-ffmpeg`](https://www.npmjs.com/package/fluent-ffmpeg) for encoding. ffmpeg must be available in the runtime environment.

**Rendering pipeline:**
1. For each slide, render `VIDEO_CONFIG.fps` frames × `secondsPerSlide` onto a `1280×720` canvas, producing a PNG frame sequence
2. Pipe the frame sequence to ffmpeg with codec `libx264`, container `mp4`, frame rate `VIDEO_CONFIG.fps`
3. Calculate `secondsPerSlide` = `clamp(totalDuration / slideCount, minPerSlide, maxPerSlide)` where `totalDuration` is derived to keep output within `VIDEO_CONFIG.minDurationSeconds`–`VIDEO_CONFIG.maxDurationSeconds`
4. Write output to a temp file at `os.tmpdir()/{renderJobId}.mp4`

**Progress reporting:** The render route uses Server-Sent Events (SSE). The renderer emits progress callbacks every `VIDEO_CONFIG.progressIntervalMs` (2 000 ms); the route handler forwards them as `data: {"percent": N}` SSE events.

**Cancellation:** The renderer exposes an `abort()` method. When called, it signals ffmpeg to terminate and deletes the partial output file within `VIDEO_CONFIG.cancelTimeoutSeconds` (3 s).

**File size check:** After encoding completes, if file size exceeds `VIDEO_CONFIG.maxFileSizeBytes` (200 MB), the download response includes a `X-File-Size-Warning` header and the frontend prompts for confirmation before triggering the browser download.

---

### 6. API Routes (`src/server/routes.ts`)

| Method | Path | Handler | Description |
|---|---|---|---|
| `POST` | `/api/analyze` | `RepositoryAnalyzer` | Validate URL, fetch repo data |
| `GET` | `/api/storyboard` | `StoryboardGenerator` | Generate slides from cached analysis |
| `POST` | `/api/render` | `VideoRenderer` | Start render job, return SSE stream |
| `DELETE` | `/api/render/:jobId` | `VideoRenderer.abort` | Cancel in-progress render |
| `GET` | `/api/download/:jobId` | file stream | Stream completed MP4 to browser |

All routes apply a top-level error handler that maps `ApiError` codes to HTTP status codes and returns the standard `{ "error": "...", "message": "..." }` JSON shape.

---

### 7. Config Module (`src/config/output.ts`)

The single source of truth for all output constants. No other file may declare inline numeric or string literals for these values.

Exports `VIDEO_CONFIG` and `SLIDE_CONFIG` as `const` objects. See `output-constants.md` for the full definition.

---

## Data Models

```typescript
// Core domain types — src/types/index.ts

interface Commit {
  sha: string;
  author: string;
  timestamp: string;       // ISO 8601
  message: string;
}

interface DirectoryNode {
  path: string;
  type: "blob" | "tree";
  size?: number;
}

interface SpecDocument {
  path: string;
  content: string;
}

interface RepoAnalysisResult {
  owner: string;
  repo: string;
  directoryTree: DirectoryNode[];
  readmeText: string | null;
  commits: Commit[];
  specDocs: SpecDocument[];
  partialFailures: string[];
}

type SlideType = "intro" | "architecture" | "highlight" | "spec" | "conclusion";

interface Slide {
  id: string;
  type: SlideType;
  title: string;
  body: string;
  previewSummary: string;
}

interface RenderJob {
  id: string;
  status: "pending" | "rendering" | "complete" | "failed" | "cancelled";
  outputPath: string | null;
  fileSizeBytes: number | null;
  errorMessage: string | null;
}

class ApiError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
  ) { super(message); }
}

type ApiErrorCode =
  | "invalid_url"
  | "repo_not_found"
  | "rate_limit_exceeded"
  | "request_timeout"
  | "network_error"
  | "partial_data"
  | "insufficient_content"
  | "internal_error";
```

---

## Security Constraints

These are enforced in code, not just documented:

1. **URL allowlist** — `RepositoryAnalyzer` validates the raw user URL against the regex before any network call; `owner` and `repo` tokens are extracted and used for all downstream URL construction. The raw URL string is never forwarded.
2. **Host allowlist** — every constructed URL is parsed and its `hostname` asserted against `{ api.github.com, raw.githubusercontent.com }` before fetch is called.
3. **No automatic redirects** — `fetch` calls use `redirect: "manual"`; any 3xx response is treated as an error.
4. **Path confinement** — temp file paths for rendered videos are built as `path.resolve(os.tmpdir(), sanitizedJobId + ".mp4")` and asserted to remain within `os.tmpdir()`.
5. **Response size cap** — all GitHub API response bodies are streamed and truncated at 10 MB.
6. **Content escaping** — all text from GitHub (README, commit messages, file names) is HTML-escaped before being placed in slide `body` or `previewSummary` fields.

---

## Correctness Properties

### Property 1: URL Validation Is Server-Authoritative

For any URL submitted by a client, `RepositoryAnalyzer` re-validates it against the allowlist regex server-side before making any network call. Client-side validation is a UX optimisation only and is never trusted as the authority.

**Validates: Requirements 1.2, 1.4**

### Property 2: Output Constants Are Immutable at Runtime

For all render jobs and storyboard generation, `VIDEO_CONFIG` and `SLIDE_CONFIG` values exported from `src/config/output.ts` remain unchanged throughout execution. No module may mutate these objects or declare inline literals for governed values.

**Validates: Requirements 3.4, 4.1, 4.5**

### Property 3: Slide Ordering Invariant

For every generated storyboard before any user reordering, slides are ordered as: introduction → architecture overview → engineering highlights → spec documentation (if present) → conclusion.

**Validates: Requirements 3.4**

### Property 4: Partial Extraction Does Not Abort the Pipeline

If any one of the four extraction steps (directory tree, README, commits, spec docs) fails for a non-rate-limit reason, the remaining steps proceed and the result is returned with a populated `partialFailures` array rather than an error response.

**Validates: Requirements 2.6**

### Property 5: Render Job Isolation

Each render job writes its output to a unique temp file path derived from a UUID. Concurrent render jobs cannot overwrite each other's output files.

**Validates: Requirements 4.7, 4.8**

### Property 6: Cancellation Is Time-Bounded

Calling `abort()` on an active render job guarantees that the ffmpeg process is terminated and the partial output file is deleted within `VIDEO_CONFIG.cancelTimeoutSeconds` (3 seconds) of the cancellation request.

**Validates: Requirements 4.8**

---

## Error Handling

```
User submits URL
     │
     ▼
[Client format validation]
     │ fails → inline error, stop
     │ passes
     ▼
POST /api/analyze
     │
     ├─ invalid_url         → HTTP 400, inline error below input
     ├─ repo_not_found      → HTTP 404, inline error below input
     ├─ rate_limit_exceeded → HTTP 429, banner: computed wait from headers
     ├─ request_timeout     → HTTP 504, inline error, retry prompt
     ├─ network_error       → HTTP 502, inline error, retry prompt
     └─ partial_data        → HTTP 200, warning banner, continue
          │
          ▼
     GET /api/storyboard
          │
          └─ insufficient_content → HTTP 422, error screen, halt
               │
               ▼
          POST /api/render  (SSE stream)
               │
               ├─ SSE percent updates → progress bar
               ├─ render failure      → error banner + retry button
               └─ cancel              → DELETE /api/render/:id
```

---

## Testing Strategy

### Unit Tests

- **`tests/analyzer.test.ts`** — test URL validation (valid, invalid format, inaccessible repo), each extraction step in isolation (mock GitHub API responses), timeout enforcement (mock AbortController), rate-limit and partial-failure paths.
- **`tests/storyboard.test.ts`** — test slide assembly order, keyword matching for highlights, min/max slide count enforcement, truncation of README words and spec sentences, `insufficient_content` error on thin repos.
- **`tests/renderer.test.ts`** — test `secondsPerSlide` calculation, frame count derivation from config, progress callback intervals, abort/cancellation cleanup, file-size warning threshold.

### Integration Tests

- Full happy-path flow: valid URL → analysis → storyboard → render → download.
- Partial-data path: one extraction step fails, storyboard generates from remaining data.
- Error propagation: each `ApiError` code maps to the correct HTTP status and response shape.

### What Not to Test Here

- GitHub API behaviour (mocked at the HTTP client boundary in all tests).
- ffmpeg encoding correctness (tested via acceptance tests on a known slide fixture).

---

## Project Structure

```
kiro-repo-visualizer/
├── src/
│   ├── config/
│   │   └── output.ts              # VIDEO_CONFIG, SLIDE_CONFIG (sole source of constants)
│   ├── types/
│   │   └── index.ts               # Commit, Slide, RenderJob, ApiError, etc.
│   ├── server/
│   │   ├── index.ts               # Express app entry point
│   │   ├── routes.ts              # Route definitions and top-level error handler
│   │   ├── analyzer.ts            # RepositoryAnalyzer
│   │   ├── storyboard.ts          # StoryboardGenerator
│   │   └── renderer.ts            # VideoRenderer (canvas + ffmpeg)
│   ├── components/
│   │   ├── UrlInput.tsx           # Step 1 — URL form
│   │   ├── AnalysisProgress.tsx   # Step 2 — loading/partial-data state
│   │   ├── StoryboardPreview.tsx  # Step 3 — slide preview, reorder, remove
│   │   └── VideoExport.tsx        # Step 4 — progress bar, download, cancel
│   ├── hooks/
│   │   └── useRenderJob.ts        # React hook wrapping the SSE render stream
│   └── App.tsx                    # Top-level step router
├── tests/
│   ├── analyzer.test.ts
│   ├── storyboard.test.ts
│   └── renderer.test.ts
├── .kiro/
│   ├── steering/
│   └── hooks/
└── package.json
```
