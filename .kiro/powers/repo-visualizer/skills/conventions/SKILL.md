---
name: conventions
description: >
  Load architecture context and project conventions for the repo-visualizer.
  Use when writing or reviewing any backend server code, React components,
  video rendering logic, storyboard generation, GitHub API calls, or config
  constants. Activates the four steering files that govern this codebase.
---

# repo-visualizer: Architecture & Conventions

## System Overview

The GitHub Repository Visualizer is a **React SPA + Express API** application.
A user submits a public GitHub repository URL; the backend fetches repository
data, synthesizes a storyboard of slides, and renders it as a downloadable MP4.

Three logical tiers:

| Tier | Technology | Role |
|---|---|---|
| Frontend | React (Vite) + TypeScript | Four-step UI: URL input → analysis progress → storyboard preview → video export |
| Backend API | Express + TypeScript | GitHub communication, storyboard generation, video rendering |
| Config layer | `src/config/output.ts` | Single source of truth for all video and slide constants |

---

## Key Source Files

| File | Responsibility |
|---|---|
| `src/config/output.ts` | `VIDEO_CONFIG` + `SLIDE_CONFIG` — sole location for all spec constants |
| `src/types/index.ts` | Domain types: `Commit`, `Slide`, `RepoAnalysisResult`, `RenderJob`, `ApiError` |
| `src/server/analyzer.ts` | GitHub REST API calls, URL validation, 10s timeout, 10 MB cap, host allowlist |
| `src/server/storyboard.ts` | Pure function: `RepoAnalysisResult → Slide[]`, slide ordering, min/max enforcement |
| `src/server/renderer.ts` | node-canvas frame rasterisation → fluent-ffmpeg H.264/MP4 encoding, SSE progress |
| `src/server/routes.ts` | 5 REST endpoints, top-level `ApiError` → HTTP status mapping |
| `src/components/UrlInput.tsx` | Step 1 — client-side format pre-validation, inline error display |
| `src/components/StoryboardPreview.tsx` | Step 3 — drag reorder, guarded slide remove, export trigger |
| `src/components/VideoExport.tsx` | Step 4 — SSE progress bar, download, cancel |
| `src/hooks/useRenderJob.ts` | React hook wrapping the SSE render stream |

---

## API Routes

| Method | Path | Handler | Purpose |
|---|---|---|---|
| `POST` | `/api/analyze` | `RepositoryAnalyzer` | Validate URL, fetch repo data |
| `GET` | `/api/storyboard` | `StoryboardGenerator` | Build slides from cached analysis |
| `POST` | `/api/render` | `VideoRenderer` | Start render job, stream SSE progress |
| `DELETE` | `/api/render/:jobId` | `VideoRenderer.abort` | Cancel in-progress render |
| `GET` | `/api/download/:jobId` | file stream | Download completed MP4 |

All routes use a top-level error handler that maps `ApiError` codes to HTTP
statuses and returns `{ "error": "<code>", "message": "..." }`.

---

## Storyboard Slide Order

Generated slides are always assembled in this sequence before user reordering:

1. **Introduction** — first 300 words of README
2. **Architecture overview** — top-level directory tree
3. **Engineering Highlights** — up to 10 commits matching `feat|fix|refactor|add|implement|redesign`
4. **Spec documentation** — if `.kiro` docs exist (up to 5 headings, 3 sentences per section)
5. **Conclusion** — repo name, language, link

Minimum 3 slides, maximum 15. Enforced from `SLIDE_CONFIG`.

---

## Approved Spec Constants

All values below live **only** in `src/config/output.ts`. Import them; never inline literals.

**`VIDEO_CONFIG`**

| Key | Value |
|---|---|
| `width` | `1280` px |
| `height` | `720` px |
| `fps` | `30` |
| `codec` | `"h264"` |
| `container` | `"mp4"` |
| `minDurationSeconds` | `30` |
| `maxDurationSeconds` | `300` (5 min) |
| `maxFileSizeBytes` | `200 * 1024 * 1024` (200 MB) |
| `progressIntervalMs` | `2000` |
| `downloadReadyMs` | `5000` |
| `cancelTimeoutSeconds` | `3` |

**`SLIDE_CONFIG`**

| Key | Value |
|---|---|
| `minSlides` | `3` |
| `maxSlides` | `15` |
| `previewMaxWords` | `50` |
| `introMaxWords` | `300` |
| `specMaxHeadings` | `5` |
| `specMaxSentences` | `3` |
| `maxHighlights` | `10` |

---

## Security Non-Negotiables

1. **URL allowlist first** — validate against `^https://github\.com/[a-zA-Z0-9_-]{1,100}/[a-zA-Z0-9_-]{1,100}$` server-side before any network call. Extract `owner` + `repo` tokens; never forward the raw URL string.
2. **Host allowlist** — outbound fetches only to `api.github.com` and `raw.githubusercontent.com`. Assert `hostname` after constructing each URL.
3. **10-second timeout** — every outbound HTTP request uses `AbortController` with a 10 000 ms timeout.
4. **No raw input in paths or shells** — file paths built from `os.tmpdir() + sanitized UUID`; no shell interpolation.
5. **10 MB response cap** — truncate all GitHub API response bodies at 10 MB.
6. **HTML-escape all GitHub content** — README text, commit messages, and file names before placing in slide fields.

---

## Error Response Shape

Every error — validation, network, timeout, unexpected — must return:

```json
{ "error": "<code>", "message": "<human-readable explanation>" }
```

Standard codes: `invalid_url` · `repo_not_found` · `rate_limit_exceeded` ·
`request_timeout` · `network_error` · `partial_data` · `insufficient_content` ·
`internal_error`

Stack traces never reach the response body. Log them server-side only.

---

## Code Style Requirements

- **Every** function parameter and return type must be explicitly annotated (TypeScript) or type-hinted (Python).
- **Every** public function must have a docstring with Summary, Args, Returns, Raises, and Side effects sections (omit sections that don't apply).
- Use `unknown` instead of `any`; justify any exceptions inline.
- Domain objects use named interfaces/types, not anonymous object shapes.
- Default numeric/string values reference `VIDEO_CONFIG` / `SLIDE_CONFIG` constants — never inline literals.

---

## Detailed Steering References

The four steering files below contain full rules, examples, and enforcement
checklists. They are bundled in `dev.kiro/steering/` and also exist at their
canonical workspace paths:

| File | Topic |
|---|---|
| `dev.kiro/steering/code-style.md` | Type annotations, docstrings, naming, single responsibility |
| `dev.kiro/steering/api-error-handling.md` | Structured error responses, timeouts, rate-limit/404/502 handling |
| `dev.kiro/steering/input-security.md` | SSRF prevention, URL allowlisting, path traversal, shell injection |
| `dev.kiro/steering/output-constants.md` | Config module rules, governed constants table, derived value patterns |
