# Implementation Plan: repo-visualizer

## Overview

Full implementation of the GitHub Repository Visualizer — a React SPA with an Express/TypeScript backend that accepts a public GitHub repository URL, extracts repository data via the GitHub REST API, generates a storyboard of slides, allows the user to preview and reorder them, then renders and downloads an H.264/MP4 video.

## Tasks

- [x] 1. Project scaffolding and toolchain setup
  - [x] 1.1 Run `npm create vite@latest` with the `react-ts` template to initialise the frontend
  - [x] 1.2 Install backend dependencies: `express`, `cors`, `typescript`, `ts-node`, `nodemon` at pinned versions
  - [x] 1.3 Install renderer dependencies: `canvas`, `fluent-ffmpeg`, `@ffmpeg-installer/ffmpeg` at pinned versions
  - [x] 1.4 Install test dependencies: `vitest`, `@vitest/coverage-v8`, `supertest` at pinned versions
  - [x] 1.5 Create `tsconfig.json` with strict mode and ES2022 target, and `tsconfig.server.json` with CommonJS module and `outDir: dist/server`
  - [x] 1.6 Add `package.json` scripts: `dev` (concurrently runs Vite and nodemon), `build`, `test`, `server`
  - [x] 1.7 Create `.gitignore` covering `node_modules`, `dist`, `tmp`, and `*.mp4`
  - [x] 1.8 Verify `npm run dev` starts without errors, `npm run build` compiles cleanly, `npm test` exits with zero failures

- [x] 2. Configuration module and domain types
  - [x] 2.1 Create `src/config/output.ts` and export `VIDEO_CONFIG` as a frozen `as const` object with all video spec constants: `width`, `height`, `fps`, `codec`, `container`, `minDurationSeconds`, `maxDurationSeconds`, `maxFileSizeBytes`, `progressIntervalMs`, `downloadReadyMs`, `cancelTimeoutSeconds`
  - [x] 2.2 Export `SLIDE_CONFIG` as a frozen `as const` object: `minSlides`, `maxSlides`, `previewMaxWords`, `introMaxWords`, `specMaxHeadings`, `specMaxSentences`, `maxHighlights`
  - [x] 2.3 Create `src/types/index.ts` and define `Commit`, `DirectoryNode`, `SpecDocument`, and `RepoAnalysisResult` (including `partialFailures: string[]`) interfaces
  - [x] 2.4 Define `SlideType` union, `Slide` interface, and `RenderJob` interface (including `sizeWarning: boolean`)
  - [x] 2.5 Define `ApiErrorCode` union type and `ApiError` class extending `Error` with `readonly code: ApiErrorCode`
  - [x] 2.6 Verify both config objects are immutable at runtime and all types compile under `strict: true`

- [x] 3. Repository analyzer backend module
  - [x] 3.1 Create `src/server/analyzer.ts`; define URL allowlist regex and allowed host `Set` as module-level constants
  - [x] 3.2 Implement `validateAndExtractTokens(url: string): { owner: string; repo: string }` — throws `ApiError("invalid_url")` if regex does not match
  - [x] 3.3 Implement `safeFetch(url: string): Promise<Response>` — asserts hostname against allowed host set, attaches `AbortController` with 10 000 ms timeout, uses `redirect: "manual"`, caps response body at 10 MB
  - [x] 3.4 Implement `fetchDirectoryTree(owner, repo)` calling `GET /repos/{owner}/{repo}/git/trees/HEAD?recursive=1`, filtering paths to at most 3 separator levels
  - [x] 3.5 Implement `fetchReadme(owner, repo)` calling `GET /repos/{owner}/{repo}/readme` with raw Accept header, returning `null` on 404, enforcing 1 MB limit
  - [x] 3.6 Implement `fetchCommits(owner, repo)` calling `GET /repos/{owner}/{repo}/commits?per_page=50`, mapping response to `Commit[]`
  - [x] 3.7 Implement `fetchSpecDocs(owner, repo)` calling `GET /repos/{owner}/{repo}/contents/.kiro`, fetching each file's `download_url`, skipping files > 1 MB, returning `[]` on 404
  - [x] 3.8 In each fetch function detect 403/429 + `X-RateLimit-Remaining: 0` and throw `ApiError("rate_limit_exceeded")`
  - [x] 3.9 Implement exported `analyzeRepository(url: string): Promise<RepoAnalysisResult>` — runs all four fetch steps with `Promise.allSettled`, collects fulfilled values, records skipped step names in `partialFailures`
  - [x] 3.10 Write `tests/analyzer.test.ts` covering: invalid URL format, inaccessible repo, 10 s timeout, rate-limit 429, each extraction step in isolation, partial failure (one step fails, others succeed)

- [x] 4. Storyboard generator backend module
  - [x] 4.1 Create `src/server/storyboard.ts` as a pure module; implement `htmlEscape` and `truncateToWords` helpers
  - [x] 4.2 Implement `buildIntroSlide` using `SLIDE_CONFIG.introMaxWords` via `truncateToWords`, HTML-escaping output, type `"intro"`
  - [x] 4.3 Implement `buildArchitectureSlide` rendering top-level directory as ASCII tree, HTML-escaping, type `"architecture"`
  - [x] 4.4 Implement `buildHighlightSlides` — case-insensitive substring match against `feat|fix|refactor|add|implement|redesign`, capped at `SLIDE_CONFIG.maxHighlights`, type `"highlight"`
  - [x] 4.5 Implement `buildSpecSlide` — returns `null` if no spec docs; extracts up to `SLIDE_CONFIG.specMaxHeadings` headings and `SLIDE_CONFIG.specMaxSentences` sentences from design/architecture/decision sections; type `"spec"`
  - [x] 4.6 Implement `buildConclusionSlide` with repo name and GitHub URL, type `"conclusion"`
  - [x] 4.7 Implement `generatePreviewSummary` capped at `SLIDE_CONFIG.previewMaxWords`
  - [x] 4.8 Implement exported `generateStoryboard(result): Slide[]` — assembles slides in order (intro → architecture → highlights → spec → conclusion), trims highlights to stay within `SLIDE_CONFIG.maxSlides`, throws `ApiError("insufficient_content")` if count < `SLIDE_CONFIG.minSlides`; assigns `randomUUID()` as each slide's `id`
  - [x] 4.9 Write `tests/storyboard.test.ts` covering: slide order, all 6 keyword matches, `maxSlides` trimming, `minSlides` error, word truncation, HTML escaping

- [x] 5. Video renderer backend module
  - [x] 5.1 Create `src/server/renderer.ts`; set ffmpeg path from `@ffmpeg-installer/ffmpeg` at module load time
  - [x] 5.2 Implement `sanitizeJobId` stripping non-alphanumeric/hyphen characters, and `buildOutputPath` — `path.resolve(os.tmpdir(), sanitizedId + ".mp4")` asserted to stay within `os.tmpdir()`
  - [x] 5.3 Implement `calculateSecondsPerSlide(slideCount: number): number` — keeps total duration within `[VIDEO_CONFIG.minDurationSeconds, VIDEO_CONFIG.maxDurationSeconds]`
  - [x] 5.4 Implement `renderSlideFrames` — creates a `VIDEO_CONFIG.width × VIDEO_CONFIG.height` canvas per frame and returns PNG `Buffer[]`
  - [x] 5.5 Implement `VideoRenderer` class with `jobs: Map<string, RenderJob>` store and `VideoRenderer.start(slides, onProgress): Promise<RenderJob>` — writes PNG frames, pipes to ffmpeg with codec `libx264`, frame rate `VIDEO_CONFIG.fps`, emits `onProgress` at `VIDEO_CONFIG.progressIntervalMs` intervals, resolves with `RenderJob` including `fileSizeBytes` and `sizeWarning`
  - [x] 5.6 Implement `VideoRenderer.abort(jobId): Promise<void>` — kills ffmpeg, waits up to `VIDEO_CONFIG.cancelTimeoutSeconds` seconds, deletes partial output file, sets status `"cancelled"`
  - [x] 5.7 Write `tests/renderer.test.ts` covering: path traversal prevention in `buildOutputPath`, `calculateSecondsPerSlide` boundary values, `onProgress` interval, abort/cleanup

- [x] 6. Express API routes and error handling
  - [x] 6.1 Create `src/server/index.ts` — instantiate Express with `cors()` and `express.json()`, mount router, listen on port 3001
  - [x] 6.2 Create `src/server/routes.ts` with the `ApiErrorCode`-to-HTTP-status map (`invalid_url→400`, `repo_not_found→404`, `rate_limit_exceeded→429`, `request_timeout→504`, `network_error→502`, `insufficient_content→422`, `internal_error→500`) and a top-level error handler middleware returning `{ "error": code, "message": "..." }` JSON
  - [x] 6.3 Implement `POST /api/analyze` — call `analyzeRepository`, cache result in a module-level `Map`, return 200 with result
  - [x] 6.4 Implement `GET /api/storyboard` — look up cached result, call `generateStoryboard`, return `Slide[]`
  - [x] 6.5 Implement `POST /api/render` — validate non-empty `slides`, set SSE headers (`Content-Type: text/event-stream`, `Cache-Control: no-cache`), call `videoRenderer.start` with `onProgress` writing `data: {"percent": N}` events, write `data: {"percent": 100, "jobId": id}` on completion
  - [x] 6.6 Implement `DELETE /api/render/:jobId` — call `videoRenderer.abort`, return 204 or 404
  - [x] 6.7 Implement `GET /api/download/:jobId` — verify job is complete, stream MP4 with `Content-Type: video/mp4`, `Content-Disposition: attachment`, `X-File-Size-Warning: true` when `job.sizeWarning`; delete temp file after streaming via `res.on("finish")`
  - [x] 6.8 Write `tests/integration.test.ts` with supertest covering: full happy path, partial-data path, each `ApiError` HTTP status, empty-slides 422

- [x] 7. URL input frontend component
  - [x] 7.1 Create `src/components/UrlInput.tsx` with a controlled `<input type="url" maxLength={2048}>`
  - [x] 7.2 Implement client-side format pre-validation on submit against the URL allowlist regex; set inline error and return early on mismatch without making any API call
  - [x] 7.3 On format pass, set `isLoading: true`, disable the submit button, call `POST /api/analyze`
  - [x] 7.4 Map API error codes to user-facing messages and display them as inline errors; re-enable submit on error
  - [x] 7.5 On `partial_data`, show a warning banner listing skipped steps and call `onSuccess` with the result
  - [x] 7.6 Add accessibility: `<label>` with `htmlFor`, `aria-describedby` on error region, `aria-busy` on form during loading

- [x] 8. Analysis progress frontend component
  - [x] 8.1 Create `src/components/AnalysisProgress.tsx` rendering a spinner with "Analyzing repository…" during in-flight state
  - [x] 8.2 When `partialFailures` is non-empty, render a warning banner with `role="alert"` listing skipped step names with WCAG AA contrast
  - [x] 8.3 Render a "Continue" button (calls `onContinue`) only after analysis completes, not during in-flight state

- [x] 9. Storyboard preview frontend component
  - [x] 9.1 Install `@dnd-kit/core` and `@dnd-kit/sortable` at pinned versions
  - [x] 9.2 Create `src/components/StoryboardPreview.tsx` — initialise local state from `initialSlides` prop; import `SLIDE_CONFIG` from `src/config/output.ts`
  - [x] 9.3 Render slide cards (title + previewSummary) in `DndContext` + `SortableContext`; implement `onDragEnd` to reorder state array
  - [x] 9.4 Add "Remove" button per card — disabled with tooltip `"Minimum ${SLIDE_CONFIG.minSlides} slides required"` when `slides.length <= SLIDE_CONFIG.minSlides`
  - [x] 9.5 Add "Export Video" button calling `onExport(slides)`, disabled when `slides.length === 0`
  - [x] 9.6 Add accessibility: drag handle `aria-label="Drag to reorder"`, remove button `aria-label="Remove slide: {title}"`

- [x] 10. Video export component and render hook
  - [x] 10.1 Create `src/hooks/useRenderJob.ts` — open SSE connection to `POST /api/render` using `fetch` + `ReadableStream` reader; parse `data:` lines for `percent` and `jobId`; expose `{ percent, jobId, status, error, cancel }`
  - [x] 10.2 Implement `cancel()` in `useRenderJob` — call `DELETE /api/render/:jobId` and set status `"cancelled"`
  - [x] 10.3 Create `src/components/VideoExport.tsx` — call `useRenderJob(slides)`, render `<progress>` with `aria-label="Video rendering progress"` and an `aria-live="polite"` percentage readout
  - [x] 10.4 Show "Cancel" button while `status === "rendering"`; disable after cancellation or completion
  - [x] 10.5 On completion, fetch `Content-Length`; if size exceeds `VIDEO_CONFIG.maxFileSizeBytes`, show confirmation dialog with size in MB before triggering browser download via `<a download>` click
  - [x] 10.6 On failure, show error message and "Retry" button that calls `onBack`

- [x] 11. Top-level app router
  - [x] 11.1 Create `src/App.tsx` with `step` state: `"input" | "analysis" | "storyboard" | "export"` and shared `repoResult` and `slides` state
  - [x] 11.2 On `UrlInput.onSuccess`: store result, show `AnalysisProgress` while fetching `GET /api/storyboard`, then advance to `"storyboard"` with the returned slides
  - [x] 11.3 Render the correct step component per state; pass `onBack` from `VideoExport` returning to `"storyboard"` with slide order preserved
  - [x] 11.4 Render a step indicator ("Step N of 4") above the active component
  - [x] 11.5 Wrap the app in `<main aria-label="GitHub Repository Visualizer">`

- [x] 12. End-to-end validation and polish
  - [x] 12.1 Run `npm test` and ensure all files pass with ≥ 80% coverage on `src/server/` modules
  - [x] 12.2 Run `npm run build` and verify zero TypeScript errors across frontend and backend
  - [x] 12.3 Verify no inline literals for governed constants exist outside `src/config/output.ts` (grep for hardcoded `1280`, `720`, `"h264"`, `"mp4"`, `300`, `200`, `15`, `30` etc.)
  - [x] 12.4 Verify all public functions in `src/server/` have explicit type annotations and docstrings covering Summary, Args, Returns, Raises, and Side effects
  - [x] 12.5 Write `README.md` documenting setup, `GITHUB_PERSONAL_ACCESS_TOKEN` environment variable, Docker prerequisite, and the four-step user flow

## Task Dependency Graph

```json
{
  "waves": [
    {
      "id": 0,
      "tasks": ["1.1", "1.2", "1.3", "1.4", "1.5", "1.6", "1.7", "1.8"]
    },
    {
      "id": 1,
      "tasks": ["2.1", "2.2", "2.3", "2.4", "2.5", "2.6"]
    },
    {
      "id": 2,
      "tasks": [
        "3.1", "3.2", "3.3", "3.4", "3.5", "3.6", "3.7", "3.8", "3.9",
        "4.1", "4.2", "4.3", "4.4", "4.5", "4.6", "4.7", "4.8",
        "5.1", "5.2", "5.3", "5.4", "5.5", "5.6",
        "7.1", "7.2", "7.3", "7.4", "7.5", "7.6",
        "8.1", "8.2", "8.3",
        "9.1", "9.2", "9.3", "9.4", "9.5", "9.6",
        "10.1", "10.2", "10.3", "10.4", "10.5", "10.6"
      ]
    },
    {
      "id": 3,
      "tasks": [
        "3.10",
        "4.9",
        "5.7",
        "6.1", "6.2", "6.3", "6.4", "6.5", "6.6", "6.7",
        "11.1", "11.2", "11.3", "11.4", "11.5"
      ]
    },
    {
      "id": 4,
      "tasks": [
        "6.8",
        "12.1", "12.2", "12.3", "12.4", "12.5"
      ]
    }
  ]
}
```

## Notes

- All numeric and string literals for video/slide constants must be imported from `src/config/output.ts` via `VIDEO_CONFIG` or `SLIDE_CONFIG`. Inline literals for governed values are a bug.
- Tasks within wave 2 (backend modules 3–5, frontend components 7–10) have no inter-dependencies and can be implemented in parallel.
- The GitHub MCP server in `.kiro/mcp.json` (disabled by default) can be enabled by setting `GITHUB_PERSONAL_ACCESS_TOKEN` and flipping `disabled: false` — useful for testing `src/server/analyzer.ts` against real repositories.
- ffmpeg must be available in the runtime environment; `@ffmpeg-installer/ffmpeg` bundles a binary automatically.
- Component boundaries are fixed per `design.md`: GitHub API calls belong only in `analyzer.ts`; slide assembly belongs only in `storyboard.ts`. No component may circumvent these boundaries.

## Correctness Properties Verification

Run against the completed implementation:

| # | Property | Result |
|---|----------|--------|
| 1 | URL Validation Is Server-Authoritative | PASS |
| 2 | Output Constants Are Immutable at Runtime | PASS (fixed) |
| 3 | Slide Ordering Invariant | PASS |
| 4 | Partial Extraction Does Not Abort the Pipeline | PASS |
| 5 | Render Job Isolation | PASS |
| 6 | Cancellation Is Time-Bounded | PASS |

- Property 2 initially failed: `as const` provides compile-time readonly typing only and does not freeze the object at runtime, so `VIDEO_CONFIG`/`SLIDE_CONFIG` were mutable in emitted JS. Fixed by wrapping both exports in `Object.freeze(...)` in `src/config/output.ts` (task 2.1/2.2 required a "frozen" object). Regression guard added in `tests/config.test.ts`.
- Full suite after fix: 120 tests passing across 5 files; `src/server/` coverage 83.16%.
