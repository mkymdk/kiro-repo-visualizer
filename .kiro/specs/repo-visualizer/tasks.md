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

---

# Implementation Plan: Download-flow Features (Run-Instructions Slide + Target Duration)

## Overview

Two independent extensions to the existing pipeline:

- **Feature A — "How to run this repository" slide** (Requirements 5.7–5.11). A new `"run"` slide type extracted from the already-fetched README section (Installation / Getting Started / Setup / Usage / Quick Start), assembled purely in `storyboard.ts`, positioned after architecture and before highlights. No new GitHub calls, no repository code execution.
- **Feature B — user-selectable video duration** (Requirements 4.10–4.14). A user-chosen `Target_Duration` within `[VIDEO_CONFIG.minDurationSeconds, VIDEO_CONFIG.maxDurationSeconds]`, validated pre-SSE in `routes.ts` (new `invalid_input` / HTTP 400 code), threaded through `useRenderJob` and `VideoExport`, consumed by `calculateSecondsPerSlide`.

The two features share only the config/type foundation (wave 0) and the final verification (last wave). Their feature-specific work does not cross modules, so it runs in parallel.

## Tasks

- [x] 13. Shared foundation — config, types, steering
  - [x] 13.1 Add `runMaxSteps` (8) and `runMaxWordsPerStep` (20) to `SLIDE_CONFIG` in `src/config/output.ts` (values only; imported by name everywhere else)
  - [x] 13.2 Add `"run"` member to the `SlideType` union in `src/types/index.ts` and update its doc comment
  - [x] 13.3 Add `"invalid_input"` member to the `ApiErrorCode` union in `src/types/index.ts` and update its doc comment
  - [x] 13.4 Add the `invalid_input` row (HTTP 400 — malformed/out-of-range request parameter) to the standard error-code table in `.kiro/steering/api-error-handling.md`
  - [x] 13.5 Verify `npm run build` compiles cleanly with the new union members and config keys

- [x] 14. Feature A — run-instructions slide (storyboard.ts)
  - [x] 14.1 Implement an unexported `extractRunInstructions(readmeText: string): { heading: string; steps: string[] } | null` helper — finds the first Markdown heading matching (case-insensitive) `Installation|Getting Started|Setup|Usage|Quick Start` in document order, returns its section content
  - [x] 14.2 Within the extractor, prefer the first fenced code block in the matched section as the step source (split into lines, cap at `SLIDE_CONFIG.runMaxSteps`); fall back to non-blank prose lines when no code block is present
  - [x] 14.3 Truncate each step to `SLIDE_CONFIG.runMaxWordsPerStep` words via `truncateToWords`; HTML-escape all output
  - [x] 14.4 Implement exported `buildRunSlide(readmeText: string | null): Slide | null` — returns `null` when README is absent or no heading matches; otherwise builds a `"run"` slide with heading title, step body, and a `previewSummary` capped at `SLIDE_CONFIG.previewMaxWords`
  - [x] 14.5 Insert the run slide into `generateStoryboard` immediately after architecture and before highlights; include it in the `fixedCount` used for the `maxSlides` highlight-trim math so the count stays within `[minSlides, maxSlides]`
  - [x] 14.6 Extend `tests/storyboard.test.ts`: heading-keyword matching, fenced-code-block preference over prose, first-match-in-document-order, `runMaxSteps`/`runMaxWordsPerStep` truncation, graceful omission (no README / no match), and ordering assertion (run slide index is directly after architecture)

- [x] 15. Feature B — target duration (renderer.ts, routes.ts, hook, component)
  - [x] 15.1 Change `calculateSecondsPerSlide(slideCount: number, targetDurationSeconds?: number): number` — when a target is supplied, distribute it across slides (floor at 1s); when omitted, keep existing slide-count-derived default; update the TSDoc (Args/Returns/Raises)
  - [x] 15.2 Thread the target through `VideoRenderer.start(slides, onProgress, targetDurationSeconds?)`, passing it to `calculateSecondsPerSlide`; update TSDoc
  - [x] 15.3 In `routes.ts`, add `invalid_input: 400` to the `HTTP_STATUS` map
  - [x] 15.4 In `POST /api/render`, read `targetDurationSeconds` from the body and validate it **before** setting SSE headers — reject non-finite or out-of-range values with `HTTP 400 { error: "invalid_input", message: <permitted range> }`; pass a valid value (or `undefined`) to `videoRenderer.start`
  - [x] 15.5 In `useRenderJob.ts`, accept an optional `targetDurationSeconds` and include it in the `POST /api/render` JSON body; update the hook's param types/TSDoc and effect dependencies
  - [x] 15.6 In `VideoExport.tsx`, add a duration selector (range/number input) bounded by `VIDEO_CONFIG.minDurationSeconds`–`VIDEO_CONFIG.maxDurationSeconds`, defaulted sensibly, with an accessible `<label>`; pass the chosen value into `useRenderJob`
  - [x] 15.7 Extend `tests/renderer.test.ts`: `calculateSecondsPerSlide` with an explicit in-range target, the 1s-per-slide floor, and the default (no-target) path
  - [x] 15.8 Add `tests/routes.test.ts`: out-of-range target → 400 `invalid_input` with no SSE stream; non-numeric target → 400; in-range target → render proceeds; absent target → derived default

- [x] 16. End-to-end validation for both features
  - [x] 16.1 Run `npm test`; ensure new and existing suites pass and `src/server/` coverage stays ≥ 80%
  - [x] 16.2 Run `npm run build`; verify zero TypeScript errors across frontend and backend
  - [x] 16.3 Grep to confirm no inline literals for the new governed constants (`8`, `20`) or duration bounds leaked outside `src/config/output.ts`
  - [x] 16.4 Verify Property 3 (updated ordering incl. run slide) and Property 7 (Target Duration Is Range-Bounded) hold against the implementation

## Task Dependency Graph

```json
{
  "waves": [
    {
      "id": 0,
      "tasks": ["13.1", "13.2", "13.3", "13.4", "13.5"]
    },
    {
      "id": 1,
      "tasks": [
        "14.1", "14.2", "14.3", "14.4", "14.5",
        "15.1", "15.2", "15.3", "15.4", "15.5", "15.6"
      ]
    },
    {
      "id": 2,
      "tasks": ["14.6", "15.7", "15.8"]
    },
    {
      "id": 3,
      "tasks": ["16.1", "16.2", "16.3", "16.4"]
    }
  ]
}
```

## Notes

- Wave 0 is the only shared prerequisite: both features depend on the config keys and union members landing first (per output-constants.md §2.3, config follows requirements, which are already merged). Task 13.4 keeps api-error-handling.md's code table in sync with the new `invalid_input` code.
- Wave 1 is fully parallel: Feature A touches only `storyboard.ts`; Feature B touches `renderer.ts`, `routes.ts`, `useRenderJob.ts`, and `VideoExport.tsx`. There is no file overlap between the two features, so 14.x and 15.x can proceed simultaneously.
- Wave 2 is the test-authoring pass for both features (kept separate from implementation so a failing test points at implementation, not scaffolding).
- Component boundaries are unchanged: README section extraction is pure string work and stays in `storyboard.ts`; no new GitHub calls are added to `analyzer.ts`; duration validation lives in `routes.ts` and duration math in `renderer.ts`.
- The `invalid_input` validation must run before `res.flushHeaders()` so the error never rides the SSE channel (design.md Error Handling flow).

---

# Implementation Plan: Repository-Focused Storyboard

## Overview

Reworks the storyboard around the narrative **What is it? → What can I do with it? → How do I run it? → How does it work? → What are its key features? → How has it evolved?** (Requirements 2, 3, 5, 6, 7 and 4.15–4.16; design.md §2, §3, §5, Properties 3, 4, 8–14).

- Current-state content (overview, capabilities, run, architecture, how-it-works, features) comes from README first, specs second, never from history (Req 3.13).
- Evolution (timeline, PR/release deep dives, commit highlights) is capped at `maxEvolutionSlides`, relevance-gated by Anchor_Terms, and never padded. Repositories with no Anchor_Terms get only the narrow `feat:` commit fallback (Req 7.14).
- The renderer gains measured-width wrapping so the prose-heavy slides render correctly.

This plan supersedes the slide ordering from tasks 4.8 and 14.5 (run slide after architecture) and the `"spec"` slide type from 4.5. Existing run-slide extraction (14.1–14.4) and target-duration work (15.x) are reused unchanged.

## Tasks

- [x] 17. Foundation — config, types, fixtures
  - [x] 17.1 In `src/config/output.ts`, set `SLIDE_CONFIG.introMaxWords` to 120 and add `capabilitiesMaxItems`, `capabilityMaxWords`, `capabilitiesMaxOverlapRatio`, `maxFeatureSlides`, `featureMaxWords`, `maxEvolutionSlides`, `maxEvolutionItems`, `minEvolutionItems`, `changeContextMaxWords`, `relevanceMinTermLength`, and `maxFallbackHighlights` with the values in output-constants.md
  - [x] 17.2 In `src/types/index.ts`, add `subject`/`body` to `Commit` (keep `message` as an alias of `subject`), and add `PullRequest`, `Release`, `RepoMetadata`, and `ChangeCategory`; extend `RepoAnalysisResult` with `metadata`, `pullRequests`, `releases`
  - [x] 17.3 Update `SlideType`: rename `"spec"` → `"howItWorks"`; add `"capabilities"`, `"feature"`, `"evolution"`, `"change"`; update doc comments
  - [x] 17.4 Type-check. Expected errors are limited to consumers updated in wave 1 (`analyzer.ts`, `storyboard.ts`) and test fixtures (`cache.test.ts`, `integration.test.ts`, `storyboard.test.ts`); record the list and treat anything else as a defect
  - [x] 17.5 Create `tests/fixtures/` with typed `RepoAnalysisResult` fixtures: `kiroRepo` (README Features/How it works/Installation sections, `.kiro/specs` requirements + design, releases incl. a patch release, labeled PRs incl. bot/docs/bump/bug-fix noise), `readmeOnlyRepo` (README with Features, commits only), `thinRepo` (one-line README, mixed `feat:`/`fix:`/`chore:`/`Add …` commits), and `hostileRepo` (HTML metacharacters in every text field)

- [x] 18. Repository analyzer (`analyzer.ts`)
  - [x] 18.1 Implement `fetchMetadata(owner, repo): Promise<RepoMetadata>` (`GET /repos/{o}/{r}`); make its 404 / non-rate-limit 403 the `repo_not_found` source in `analyzeRepository`
  - [x] 18.2 Change `fetchDirectoryTree` to return both the 3-level `DirectoryNode[]` and the unfiltered blob list (internal type)
  - [x] 18.3 Replace `fetchSpecDocs` with `selectSpecPaths(blobs)` (prefix/extension/segment validation, requirements/design priority, ascending-path ties, `MAX_SPEC_FILES` = 6, > 1 MB skipped) and `fetchSpecDocs(owner, repo, paths)` (per-segment `encodeURIComponent`, `contents` endpoint, raw Accept, host assertion)
  - [x] 18.4 Map commits to `subject` + `body` (leading blank lines trimmed)
  - [x] 18.5 Implement `fetchPullRequests(owner, repo): Promise<PullRequest[]>` — merged only, lowercased labels, `isBot`, body capped at `MAX_CHANGE_BODY_CHARS`; 404 → `[]`
  - [x] 18.6 Implement `fetchReleases(owner, repo): Promise<Release[]>` — drafts dropped, body capped; 404 → `[]`
  - [x] 18.7 Rework `analyzeRepository`: steps 1–4, 6, 7 via `Promise.allSettled`; spec step after tree (skipped and recorded when tree fails); new `partialFailures` names; empty sources never recorded; rate-limit rethrow unchanged
  - [x] 18.8 Update `tests/analyzer.test.ts`: replace `.kiro` directory-listing tests with spec-selection tests (4-level paths, priority, cap, size, invalid/traversal paths, encoding); add metadata, PR, release, commit-body, empty-vs-failure, and tree-failure-skips-specs cases

- [x] 19. Storyboard — current-state sections (`storyboard.ts`)
  - [x] 19.1 Make `makeSlide` escape `title`, `body`, and `previewSummary` itself; refactor all existing builders to pass raw text (fixes the unescaped conclusion preview)
  - [x] 19.2 Add shared helpers `findSection`, `listItems`, `firstSentences`, `toPlainText`; re-implement run-section lookup on `findSection` with unchanged behaviour
  - [x] 19.3 Rewrite the overview slide: name + description + topics + first README prose paragraph (skip heading/badge/image/HTML/blank lines) ≤ `introMaxWords`; fallback text
  - [x] 19.4 Implement Capabilities extraction (README headings, then spec user-story `I want` clauses) ≤ `capabilitiesMaxItems` / `capabilityMaxWords`; "Usage" excluded
  - [x] 19.5 Implement how-it-works (README `How it works|Architecture|Design`, then design.md-first spec fallback reusing the former spec-slide logic) as type `"howItWorks"`
  - [x] 19.6 Implement Key_Feature extraction (README list items with name/description parsing, then design Components subheadings, then requirement titles) and slide building: described → individual slides, name-only → one summary slide, total ≤ `maxFeatureSlides`
  - [x] 19.7 Implement the Capabilities/Key_Feature overlap check (> `capabilitiesMaxOverlapRatio` → omit Capabilities slide)
  - [x] 19.8 Extend the conclusion slide with stars, language, and license from metadata

- [x] 20. Storyboard — evolution and assembly (`storyboard.ts`)
  - [x] 20.1 Implement `GENERIC_TERMS`, `buildAnchorTerms` (current-state inputs only), and `isRelevant` with prefix matching
  - [x] 20.2 Implement `extractChangeContext` (strip HTML comments, task lists, headings, code fences, trailers; plain text; first sentence; ≤ `changeContextMaxWords`)
  - [x] 20.3 Implement PR significance (7.1), category precedence (7.2), and ranking (7.3)
  - [x] 20.4 Implement patch-release detection and release timeline / deep-dive eligibility
  - [x] 20.5 Implement commit highlights: relevant path (7.9, Bug Fix excluded, PR-reference dedup) and empty-anchor fallback (7.14, `^feat(\([^)]*\))?!?:` only, dependency wording excluded, ≤ `maxFallbackHighlights`)
  - [x] 20.6 Implement evolution allocation: timeline only when ≥ `minEvolutionItems` eligible entries (≤ `maxEvolutionItems`, chronological), then PR deep dives, release deep dives, highlights; stop at `maxEvolutionSlides` or when candidates run out — never pad
  - [x] 20.7 Rewrite `generateStoryboard` stage 5: new ordering (run after capabilities or overview), trim guard in the 3.4 order, `minSlides` guard

- [x] 21. Renderer text layout (`renderer.ts`)
  - [x] 21.1 Move layout literals into a module-level `LAYOUT` constant and add a single `decodeHtmlEntities` helper
  - [x] 21.2 Implement pure `wrapText(text, maxWidth, measure)` (explicit breaks preserved, greedy word wrap, long-word character breaking)
  - [x] 21.3 Implement `fitLines(lines, maxLines, maxWidth, measure)` with measured ellipsis; title limited to `LAYOUT.titleMaxLines`
  - [x] 21.4 Use both in `renderSlideFrames`, positioning divider and body from the rendered title height
  - [x] 21.5 Add `wrapText`/`fitLines`/title tests to `tests/renderer.test.ts` using a fake `measure`

- [x] 22. Storyboard and integration tests
  - [x] 22.1 Update existing `tests/storyboard.test.ts` cases broken by the redesign (overview paragraph + 120-word limit, `"spec"` → `"howItWorks"`, run-slide position, ordering, raw-in/escaped-out builders)
  - [x] 22.2 Current-state section tests: README → spec fallbacks, "Usage" not a capability, overlap threshold boundaries, feature individual vs. summary slides and cap
  - [x] 22.3 Evolution tests: PR filters/categories/ranking, patch releases, timeline min/cap/chronology, Bug Fix timeline-only, release deep dives only on PR shortfall, relevant-commit path, empty-anchor `feat:` fallback accept/reject cases, PR-reference dedup
  - [x] 22.4 Property tests on the four fixtures: ordering (P3), no fabrication (P8), ceilings with metamorphic noise injection (P9), anchoring and fallback (P10), escaping for every slide type (P11), non-redundant capabilities (P12), history invariance (P14)
  - [x] 22.5 Update `tests/cache.test.ts` and `tests/integration.test.ts` fixtures to the new `RepoAnalysisResult` shape; add an integration flow per fixture shape and a PR-step-failure partial-data flow

- [x] 23. End-to-end validation
  - [x] 23.1 Run `npm test`; all suites pass, `src/server/` coverage ≥ 80%
  - [x] 23.2 Run `npm run build`; zero TypeScript errors across frontend and backend
  - [x] 23.3 Grep for inline literals of every governed constant (incl. `120`, `0.5`, and the new caps) outside `src/config/output.ts`
  - [x] 23.4 Manual end-to-end: drive the real `generateStoryboard` → real `/api/storyboard` and `/api/render` routes for all four fixtures with only the analyzer fetch boundary and ffmpeg stubbed; confirm slide order, evolution counts below the caps where noise dominates, the thin-repo `feat:` fallback, and escaping
  - [x] 23.5 Visual check: render one frame per slide type from `kiroRepo` via `renderSlideFrames`, inspect the PNGs for wrapping, title truncation, and body ellipsis; delete the images afterwards
  - [x] 23.6 Record a verification table for Properties 1–14

## Task Dependency Graph

```json
{
  "waves": [
    {
      "id": 0,
      "tasks": ["17.1", "17.2", "17.3", "17.4"]
    },
    {
      "id": 1,
      "tasks": [
        "17.5",
        "18.1", "18.2", "18.3", "18.4", "18.5", "18.6", "18.7",
        "19.1", "19.2", "19.3", "19.4", "19.5", "19.6", "19.7", "19.8",
        "21.1", "21.2", "21.3", "21.4"
      ]
    },
    {
      "id": 2,
      "tasks": [
        "20.1", "20.2", "20.3", "20.4", "20.5", "20.6", "20.7",
        "18.8",
        "21.5"
      ]
    },
    {
      "id": 3,
      "tasks": ["22.1", "22.2", "22.3", "22.4", "22.5"]
    },
    {
      "id": 4,
      "tasks": ["23.1", "23.2", "23.3", "23.4", "23.5", "23.6"]
    }
  ]
}
```

## Notes

- Wave 0 changes shared types, so the type-check in 17.4 is expected to fail in known consumers until wave 1 lands. The failure list is recorded, not fixed, in wave 0.
- Wave 1 runs three independent tracks in parallel: analyzer (18.x), storyboard current-state sections (19.x), and renderer layout (21.1–21.4). They touch different files. Fixtures (17.5) only depend on the wave 0 types.
- Wave 2 holds the storyboard evolution work (20.x) because it shares `storyboard.ts` with 19.x and needs 19.x's extracted sections for anchors and assembly. Analyzer tests (18.8) and renderer tests (21.5) run alongside it.
- Wave 3 is the storyboard and integration test pass. It depends on the full `generateStoryboard` from 20.7.
- Component boundaries are unchanged: all GitHub calls stay in `analyzer.ts`; all section matching, relevance, allocation, and ordering stay in `storyboard.ts`; layout stays in `renderer.ts`. No new network hosts.
- All `max*` slide constants are ceilings (output-constants.md §2.4). Tests must assert "at most", plus the metamorphic check that ineligible input never adds slides.
- `GENERIC_TERMS` is algorithm data defined in design.md, not a governed constant.

## Correctness Properties Verification (Repository-Focused Storyboard)

| # | Property | Result | Evidence |
|---|----------|--------|----------|
| 1 | URL Validation Is Server-Authoritative | PASS | analyzer URL tests; `analyzeRepository` validates before any fetch |
| 2 | Output Constants Are Immutable at Runtime | PASS | `tests/config.test.ts`; governed-literal scan clean |
| 3 | Slide Ordering Invariant | PASS | property test on all 4 fixtures; run-slide position tests |
| 4 | Partial Extraction Does Not Abort | PASS | analyzer tests: failing step recorded, tree failure records specDocs, 404/[] sources not recorded |
| 5 | Render Job Isolation | PASS | existing renderer path tests (unchanged) |
| 6 | Cancellation Is Time-Bounded | PASS | existing abort tests (unchanged) |
| 7 | Target Duration Is Range-Bounded | PASS | `tests/routes.test.ts`; manual e2e 400 + in-range render per fixture |
| 8 | Content Is Never Fabricated | PASS | corpus-substring property test on all 4 fixtures |
| 9 | Slide Caps Are Ceilings | PASS | cap assertions + metamorphic noise injection on all 4 fixtures |
| 10 | Evolution Anchored / feat Fallback | PASS | property test + fallback accept/reject cases |
| 11 | Escaping for Every Slide Type | PASS | hostile fixtures cover all 10 slide types |
| 12 | Capabilities Not Redundant | PASS | ratio boundary tests + per-fixture property |
| 13 | Text Stays Within Slide Bounds | PASS | `wrapText`/`fitLines`/`layoutSlide` tests; real-canvas visual check |
| 14 | History Never Defines Current Capabilities | PASS | history-swap property test on all 4 fixtures |

Full suite: 292 tests across 7 files; `src/server/` coverage 92.62%. Mutation checks (unescaped title, `Add …` accepted by fallback, anchors fed from commits, bug-fix deep dives, unrelated release deep dives) each made the storyboard tests fail.

---

# Implementation Plan: Evolution Deduplication and Progress Heartbeat

## Overview

A focused bug-fix cycle for the two highest-priority issues from post-merge live validation:

- **Issue 1, evolution duplication** (Requirements 2.4, 2.8, 2.11, 2.12, 7.9, 7.14–7.18; Properties 15, 17). A Selected_PR's change takes at most one detailed evolution slot. Membership evidence has two levels:
  1. Graph-proven Change_Groups from commit `parents` and PR `mergeCommitSha`. No extra requests; nothing inferred beyond the 50-commit window.
  2. Exact GitHub evidence from `GET /pulls/{n}/commits`, fetched lazily only for Selected_PRs the graph can't prove (truncated merge-commit PRs), with at most 3 requests.

  Budget: ≤ 12 analysis requests + ≤ 3 lookups = **≤ 15** per uncached analysis. A failed lookup falls back to graph-only grouping.
- **Issue 2, progress cadence** (Requirements 4.3, 4.17, 4.18; Property 16). A 1-second heartbeat (`progressIntervalMs / 2`) guarantees the 2-second maximum gap during frame preparation and encoding. ffmpeg callbacks only update the stored value. Approved unchanged.

Out of scope: issues 3–12 from live validation, and the cancellation lifecycle (F1). The new tracker must still release its timer when the existing cancellation path runs.

Branch and commit plan:
- `fix/render-sse-double-error-handling` is merged into `main` on its own first.
- This work then goes on a new branch from the updated `main`.
- Commits: (1) `docs:` spec changes, (2) `fix:` Change_Group deduplication with selected-PR evidence, (3) `fix:` progress heartbeat. No amending. No push without approval.

## Request-budget rules

| Situation | PR-commit requests |
|---|---|
| No Selected_PR | 0 |
| Selected_PRs are all squash, rebase, graph-proven merges, or have an unknown merge commit | 0 |
| N Selected_PRs are truncated merge-commit PRs | min(N, 3) |
| Lookup fails (timeout, error, 429, malformed, redirect) | Counted; that PR falls back to graph-only grouping; analysis and storyboard still succeed |
| Storyboard served from the analysis cache | 0 (evidence cached with the analysis) |
| **Maximum per uncached analysis** | **12 + 3 = 15** |

`MAX_SELECTED_PR_LOOKUPS = 3` is an analyzer module constant beside `MAX_SPEC_FILES`. It is a request limit, not an output constant, so `output-constants.md` is unchanged.

## Merge-style behavior

| Style | Graph grouping | Selected-PR lookup | Verified live |
|---|---|---|---|
| Merge commit, ancestry in window | Merge commit + provable branch commits | Not requested (already exact) | This repo, PR #9 |
| Merge commit, ancestry leaves window | Merge commit only | Requested; returned SHAs are on the base branch and match exactly | `rails/rails` #58882, #58883 (1/1); `systemd/systemd` #43827 (4/4) |
| Squash | The squashed commit | Not requested; returned SHAs are pre-squash and not on the base branch | `chalk/chalk` #689 (0/1) |
| Rebase | The last rebased commit only (F3) | Not requested; rebasing rewrites SHAs | Single-parent merges 0/1; multi-commit rebase not yet observed |

## Tasks

- [x] 24. Prerequisites and data model
  - [x] 24.1 Check `fix/render-sse-double-error-handling` is ready: trial-merge it with current `main` (`git merge-tree`), and in a throwaway worktree of the merge result run type-check, the full test suite, and the production build. Report any conflict or failure and stop if there is one.
  - [x] 24.2 Merge that branch into `main` through its pull request (user action, or a local merge pushed to `main` only with explicit approval). Fast-forward local `main` to `origin/main` and run the full existing validation once on it: type-check, tests, build.
  - [x] 24.3 Create `fix/evolution-dedup-progress-heartbeat` from the updated `main`. Carry over the uncommitted spec changes (requirements.md, design.md, tasks.md) without touching the merged fix, and commit them as `docs: specify change-group dedup and progress heartbeat`.
  - [x] 24.4 In `src/types/index.ts`, add `Commit.parents: string[]`, `PullRequest.mergeCommitSha: string | null`, `PrCommitEvidence = Record<number, string[]>`, and optional `RepoAnalysisResult.prCommitEvidence` for caching, with doc comments.
  - [x] 24.5 In `analyzer.ts`, map `parents[].sha` (default `[]`) and `merge_commit_sha` (default `null`) from the existing responses. Steps 1–7 send no new requests and the same URLs.
  - [x] 24.6 Update test-data builders (`commit()` defaults `parents: []`, `pr()` defaults `mergeCommitSha: null`) and the cache/integration fixtures. Type-check must be clean.

- [x] 25. Change_Group deduplication with selected-PR evidence
  - [x] 25.1 `storyboard.ts`: `walk` (window-only, reports `complete`) and `buildChangeGroups` exactly as design.md Stage 3b.
  - [x] 25.2 `storyboard.ts`: `selectDeepDivePullRequests(result)` (pure, evidence-independent) and `prsNeedingEvidence(result, selected)` (selected, merge-commit, first-parent walk incomplete; never squash, rebase, graph-proven merges, or unknown merge commits). Both are exported for the pipeline and have no I/O.
  - [x] 25.3 `analyzer.ts`: `fetchSelectedPrCommits(owner, repo, prNumbers)`, the lazy step 8. `per_page=100`, one page; at most `MAX_SELECTED_PR_LOOKUPS` (3) requests; duplicates fetched once; non-positive or unsafe integers dropped before any URL is built; host asserted; each lookup isolated so a timeout, non-2xx, 429, malformed body, or redirect omits that PR and never throws.
  - [x] 25.4 `storyboard.ts`: `generateStoryboard(result, evidence?)` applies Req 7.15 during evolution allocation on both the relevant path (7.9) and the fallback path (7.14):
    - A Selected_PR blocks its graph group plus every window commit whose SHA is in its evidence.
    - Merge commits are never highlight candidates; at most one highlight per group.
    - Timeline entries don't block.
    - Evidence for non-selected PRs and SHAs outside the window are ignored.

    Remove `referencedPullRequests` and every subject-based exclusion.
  - [x] 25.5 New `src/server/pipeline.ts` with `buildStoryboardForUrl(url)`, owning the workflow from design.md §6a: validate and derive the cache key → cached or fresh analysis → evidence already cached? → `selectDeepDivePullRequests` → `prsNeedingEvidence` → `fetchSelectedPrCommits` → store evidence on the analysis → `generateStoryboard(result, evidence)`.
    `routes.ts` `GET /api/storyboard` becomes a transport-only call to `buildStoryboardForUrl`, with no analyzer, storyboard, or cache calls left in the handler. Error mapping is unchanged.
  - [x] 25.6 Test histories:
    - Merge-commit PR fully in the window (PR #9 graph).
    - Merge-commit PR truncated at the window, with evidence.
    - Squash PR.
    - Rebase PR (tip linked; earlier rebased commits independent).
    - Nested merges.
    - Branch commit reachable only through an out-of-window commit.
    - PR data unavailable.
    - `mergeCommitSha` null or outside the window.

- [x] 26. Progress heartbeat (`renderer.ts`, `routes.ts`)
  - [x] 26.1 Implement and export `ProgressTracker`: `update(fraction)` only stores a value (non-decreasing, capped at 99); `start()` emits immediately and then every `HEARTBEAT_MS = VIDEO_CONFIG.progressIntervalMs / 2`; `stop()` is idempotent, clears the interval, and makes later calls no-ops. `FRAME_PHASE_WEIGHT = 0.1` is a renderer-module constant.
  - [x] 26.2 Frame preparation awaits `setImmediate` after each slide and calls `update()` for the frame phase.
  - [x] 26.3 ffmpeg `progress` callbacks only call `update()` for the encode phase. Remove the `lastProgressAt` throttle and the renderer's own `onProgress(100)`. Wrap the job in `try/finally { tracker.stop() }`.
  - [x] 26.4 Keep one tracker per active job. `abort(jobId)` stops it before its existing cleanup. Do not change ffmpeg termination or when the job ID is sent (F1).
  - [x] 26.5 Building on the merged SSE fix in `routes.ts`, add a `closed` flag set on completion, error, and `res.on("close")`; the progress sink checks it before writing; exactly one terminal `{"percent":100,"jobId":…}` event.

- [ ] 27. Tests and validation
  - [x] 27.1 `tests/analyzer.test.ts`:
    - `parents`/`mergeCommitSha` mapping; steps 1–7 unchanged (same URLs, same count).
    - `fetchSelectedPrCommits([])` makes **0** requests.
    - N numbers make **≤ N** requests (N = 1, 2, 3); 5 numbers make exactly 3.
    - Duplicates are fetched once; invalid numbers make no request.
    - Each failure kind omits only that PR, never throws, and leaves the other PRs' evidence intact.
  - [x] 27.2 `tests/storyboard.test.ts`:
    - `buildChangeGroups` on every 25.6 history.
    - `prsNeedingEvidence` returns nothing for squash, rebase, and graph-proven merges.
    - Property 15: evidence suppression; the timeline-plus-deep-dive allowance; invariance under rewriting every subject and PR title; window soundness; no evidence equals graph-only output; Selected_PRs identical with and without evidence.
    - The PR #9-shaped history yields exactly one detailed slide for PR #9.
    - The truncated merge-commit PR with evidence yields exactly one, and without evidence falls back to graph behavior.
    - Properties 3, 8–12 and 14 still pass on all four existing test repos.
  - [x] 27.3 Route/integration tests count every stubbed GitHub request (Property 17):
    - No Selected_PR: baseline requests only.
    - N truncated merge-commit Selected_PRs: baseline + ≤ N.
    - Never more than 15 in total.
    - A cached storyboard request makes 0.
    - A failing lookup still returns HTTP 200 with a storyboard.
  - [x] 27.4 Add `tests/progress.test.ts` using `vi.useFakeTimers()` and `vi.mock("fluent-ffmpeg")` with scripted events. Cover:
    - Cadence: no ffmpeg reports, a single report, reports at +1,999 ms and +3,998 ms, bursts, a long silent encode, frame preparation of 15 slides.
    - Values: monotonic, ≤ 99 before completion.
    - Cleanup: no timers left (`vi.getTimerCount() === 0`) after success, ffmpeg error, frame-write error, and `abort()`.

    Add route tests: exactly one terminal event, and no write after completion, error, or client disconnect. No wall-clock sleeps.
  - [x] 27.5 Type-check (server, frontend, tests) with 0 errors; full test suite; production build; governed-constant literal scan (the heartbeat must be derived from `progressIntervalMs`, not a literal); `git diff main..HEAD --check`; traceability check (Requirement 2 numbered 1–12, Requirement 4 1–18, Requirement 7 1–18, Properties 1–17, no dangling references).
  - [x] 27.6 Update the README's rate-limit note: ≤ 15 requests per uncached analysis, with lookups only for selected merge-commit PRs.
  - [ ] 27.7 Live validation through the real server, real GitHub and real ffmpeg, counting every GitHub request.
    - **Long-history merge-commit repository (required):** `rails/rails`.
      - Run analysis first, then use `selectDeepDivePullRequests`/`prsNeedingEvidence` locally, before rendering.
      - If rails yields no Selected_PR that needs evidence, use the next candidate (`systemd/systemd`, then `kubernetes/kubernetes`) and record why.
      - Success means: at least one truncated merge-commit Selected_PR; its PR-commit SHAs match commits in the window; none of them gets a highlight beside the deep dive; total requests ≤ 15.
    - `mkymdk/kiro-repo-visualizer`: PR #9 takes one detailed slot with 0 lookups (graph-proven).
    - `chalk/chalk` (squash): 0 lookups, and no evolution regression.
    - For each run: largest SSE gap ≤ `progressIntervalMs` (about 1 s expected), and a single 100 event.
    - Plan for GitHub quota: up to 15 requests per repository; unauthenticated runs may need to span a rate-limit reset.
  - [x] 27.8 Fill in the verification table below, remove all temporary files and render outputs, confirm the working tree is clean, and commit (2) and (3) separately. Do not push without approval.

**27.7 status.** Required long-history live run not achieved: `rails/rails`, `systemd/systemd` and `kubernetes/kubernetes` each produced **zero** Selected_PRs, so no lookup path was exercised.
- Cause: their READMEs have no capabilities, features, or how-it-works section, so there are no Anchor_Terms and no PR is a Relevant_Change. Each probe was analysis only, 6 requests.
- Probes stopped there to save quota, per the cheap-probe rule.
- Completed live runs: this repository (PR #9, one slot, 0 lookups) and `chalk/chalk` (0 lookups, no regression), both with the heartbeat bound met.
- A qualifying repository needs README feature terms **and** merge-commit PRs with history beyond 50 commits. Candidate search is follow-up F4.
- **Bounded F4 attempt (second pass):** four candidates were pre-screened with no core API quota (README read from `raw.githubusercontent.com`, through the real extractor, plus one commit-search request each). Only the two with anchor terms were then probed, analysis only, 6 requests each:

  | Candidate | Pre-screen | Probe result | Why it does not exercise the path |
  |---|---|---|---|
  | `jesseduffield/lazygit` | 0 anchor terms | not probed | No PR can be selected |
  | `Textualize/rich` | 0 anchor terms | not probed | No PR can be selected |
  | `httpie/cli` | 24 anchor terms | 0 merge commits in window, 0 merged PRs | No merge-commit Selected_PR |
  | `encode/httpx` | 58 anchor terms | 2 Selected_PRs, 0 merge commits in window | Selected PRs' merge commits are outside the 50-commit window (Req 7.16), so they need no lookup |

  The search stopped there, as required. 27.7 stays **incomplete** and F4 stays open. The missing live path is covered by automated tests:
  - `tests/storyboard.test.ts`: the "truncated merge-commit PR" Property 15 test (graph-only keeps 2 highlights; evidence suppresses both), `prsNeedingEvidence` tests, and window-soundness and evidence-independence tests.
  - `tests/analyzer.test.ts`: `fetchSelectedPrCommits` bounds, endpoint, and failure isolation.
  - `tests/pipeline.test.ts`: 1–3 truncated merge-commit Selected_PRs through the real route, with exactly N lookups, highlights suppressed, ≤ 15 requests, 0 on a cache hit, and failure falling back to graph-only.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["24.1"] },
    { "id": 1, "tasks": ["24.2"] },
    { "id": 2, "tasks": ["24.3", "24.4", "24.5", "24.6"] },
    { "id": 3, "tasks": ["25.1", "25.2", "25.3", "25.6", "26.1", "26.2", "26.3", "26.4"] },
    { "id": 4, "tasks": ["25.4", "25.5", "26.5"] },
    { "id": 5, "tasks": ["27.1", "27.2", "27.3", "27.4", "27.6"] },
    { "id": 6, "tasks": ["27.5", "27.7", "27.8"] }
  ]
}
```

## Notes

- Waves 0–1 are a gate: tasks 24–27 do not start until the SSE fix is in `main` and the existing suite passes there.
- In wave 3 the Change_Group track (`storyboard.ts`, `analyzer.ts`) and the heartbeat track (`renderer.ts`) run in parallel.
- Wave 4 holds the pipeline (25.5, which also edits the storyboard handler in `routes.ts`), the SSE sink (26.5, which edits the render handler), and the evidence-aware allocation (25.4, which needs 25.1–25.2). 25.5 and 26.5 touch different handlers of `routes.ts` and are done one after the other.
- The storyboard stays pure. The only new I/O is `fetchSelectedPrCommits` in `analyzer.ts`. The workflow is sequenced only in `pipeline.ts`, and `routes.ts` stays a transport boundary.
- Graph membership is proven only inside the 50-commit window (Req 7.17). Exact evidence is used only as returned by GitHub, and only for Selected_PRs (Req 2.11). Neither uses commit messages, dates, or listing order.
- `HEARTBEAT_MS` is derived from `VIDEO_CONFIG.progressIntervalMs`; `FRAME_PHASE_WEIGHT` and `MAX_SELECTED_PR_LOOKUPS` are module constants. No new governed constants.

## Correctness Properties Verification (Evolution Deduplication and Progress Heartbeat)

| # | Property | Result | Evidence |
|---|----------|--------|----------|
| 1 | URL Validation Is Server-Authoritative | PASS | Analyzer URL tests unchanged; pipeline test: `invalid_url` before any request |
| 2 | Output Constants Are Immutable at Runtime | PASS | `tests/config.test.ts`; literal scan clean; `HEARTBEAT_MS` derived from `progressIntervalMs` |
| 3 | Slide Ordering Invariant | PASS | Property test on all four repository fixtures; live order checks |
| 4 | Partial Extraction Does Not Abort | PASS | Analyzer partial-failure tests; failed selected-PR lookup never surfaces as a failure |
| 5 | Render Job Isolation | PASS | Renderer path/isolation tests unchanged |
| 6 | Cancellation Is Time-Bounded | PASS | Abort tests unchanged; `abort()` also stops the tracker (`vi.getTimerCount() === 0`) |
| 7 | Target Duration Is Range-Bounded | PASS | `tests/routes.test.ts` duration validation; live render hit 60.00 s for a 60 s target |
| 8 | Content Is Never Fabricated | PASS | Corpus-substring property test on all fixtures |
| 9 | Slide Caps Are Ceilings | PASS | Caps and noise-injection tests; evolution ≤ 4 in every live run |
| 10 | Evolution Anchored / feat Fallback | PASS | Fallback tests updated for the group rule (one highlight per group; cap counted after it) |
| 11 | Escaping for Every Slide Type | PASS | Hostile fixtures cover all 10 slide types |
| 12 | Capabilities Not Redundant | PASS | Ratio boundary and per-fixture tests |
| 13 | Text Stays Within Slide Bounds | PASS | Wrap/fit/layout tests unchanged |
| 14 | History Never Defines Current Capabilities | PASS | History-swap test on all fixtures, including merge-commit histories |
| 15 | One Logical Change, At Most One Detailed Slot | PASS (live partial) | 20 Change_Group/Property 15 tests incl. PR #9 shape, truncated window with and without evidence, subject-rewrite invariance, window soundness. Live: PR #9 one detailed slot, 0 lookups. The long-history evidence path is unit-tested only; no qualifying live repository (see 27.7) |
| 16 | Progress Cadence Is Independent of the Encoder | PASS | 16 fake-timer tests (`tests/progress.test.ts`) plus 3 SSE sink tests. Live max gap 1,001 ms and 1,000 ms; one 100 event per render |
| 17 | Selected-PR Lookups Are Lazy and Bounded | PASS | 7 analyzer lookup tests and 10 pipeline request-count tests (0 for none, N for N, cap 3, ≤ 15 with 6 spec files, 0 on a cache hit, failure → 200). Live: 9 and 6 requests, 0 lookups, 0 on a cache hit |

## Follow-ups (not in this cycle)

- **F1. Cancellation lifecycle.** (a) `VideoRenderer.abort()` does not terminate the ffmpeg process: it marks the job cancelled and deletes the output file, but encoding keeps running. (b) The UI receives the job ID only with the final SSE event, so it cannot send `DELETE /api/render/:jobId` for an active render. Fix both together. Tasks 24–27 only make sure `abort()` releases the progress timer. **Resolved** by the Render Cancellation Lifecycle plan (tasks 28–31, Properties 6 and 18).
- **F2. Graph-only grouping beyond the 50-commit window.** Graph-proven membership stops at the window, so merge commits in long-history repositories group only themselves (live: every merge commit in `rails/rails` and `kubernetes/kubernetes`). Selected_PRs are now covered by exact PR-commit lookup. The remaining gap is commits of merge-style PRs that are **not** selected: two commits from the same unselected PR may still each get a highlight. Closing it would mean more lookups beyond Selected_PRs, which needs a separate budget decision.
- **F3. Rebase-merged PRs.** Only the last rebased commit is linked to its PR (Req 7.18). The PR-commit endpoint returns the pre-rebase SHAs, which don't match the base branch (single-parent merges verified 0/1 on `chalk/chalk` and `systemd/systemd`). This stays a limitation unless a multi-commit rebase merge is shown to keep exact SHAs. No message-based workaround.
- **F4. Live validation of the selected-PR lookup on a long-history repository.** Find a public repository with README features or capabilities (so PRs can be selected) and merge-commit PRs whose history extends beyond the 50-commit window, then run task 27.7's success criteria. The three suggested candidates don't qualify (no Anchor_Terms). A bounded second attempt (`lazygit`, `rich`, `httpie/cli`, `encode/httpx`) also found none; see the 27.7 status note. The combination is uncommon: repositories with a README features section tend to squash-merge or have merge commits older than their last 50 commits.
- **Deferred live-validation issues 3–12:**
  - 3: patch-release detection misses prefixed tags.
  - 4: release Change_Context and release-vs-PR duplication.
  - 5: maintenance-type commits on the relevance path.
  - 6: capability phrasing from user stories.
  - 7: spec-based how-it-works shows headings only.
  - 8: "Install"/"Example" run headings not recognized.
  - 9: noisy anchor terms.
  - 10: duration rounding remainder.
  - 11: emoji shortcodes and near-duplicate overview text.
  - 12: no category for performance changes.

---

# Implementation Plan: Render Cancellation Lifecycle (Candidate A, resolves F1)

## Overview

A correctness fix for the existing cancellation requirements (Req 4.7, 4.8, 4.18–4.22; Properties 6, 18).

Today `abort()` deletes the output file but never stops ffmpeg. The encode keeps running, a late `end` overwrites `cancelled` with `complete` and recreates a downloadable MP4, and the UI can't cancel, because it only learns the job ID from the final event. Failed renders also leave their partial output (Req 4.7).

**Correction to earlier verification tables:** previous Property 6 "PASS" rows were verified only by file deletion and elapsed time. Process termination, frame-loop stop, and late-completion protection were never tested.

Out of scope: Candidates B–D, and retrying or resuming cancelled renders.

Commit plan, on a new branch `fix/render-cancellation-lifecycle` from `main`:
1. `docs:` specs.
2. `fix:` renderer and route lifecycle.
3. `fix:` UI cancel.

No push without approval.

## Tasks

- [x] 28. Job state machine and renderer API (`renderer.ts`, `types/index.ts`)
  - [x] 28.1 Add the guarded `transition(job, from, to)` compare-and-set and route every status change through it. Allowed: `pending→rendering`, `pending→cancelled`, `rendering→{complete, failed, cancelled}`. Terminal states have no outgoing transitions.
  - [x] 28.2 Split the API into `createJob()` (pending, registered, no work) and `run(jobId, slides, onProgress, target?)`. `run` resolves on `complete`/`cancelled`, rejects only on `failed`, and returns immediately for a job cancelled while pending. Keep `start()` as a `createJob` + `run` wrapper.
  - [x] 28.3 Active-render record `{ tracker, controller, command, exited, cancelling }`. The frame loop checks `controller.signal.aborted` after each slide. Keep a handle to the ffmpeg command and its child process. Settle `exited` only from the child process's own `exit` event; fluent-ffmpeg's `end` or `error` counts only when no child was ever spawned. A sent signal never settles `exited`.
  - [x] 28.4 Single `cancel(jobId)`, with `abort` as an alias:
    1. Compare-and-set to `cancelled`, so completion can no longer win.
    2. Stop the tracker.
    3. `controller.abort()`.
    4. `SIGTERM`.
    5. Wait for exit.
    6. `SIGKILL` at `KILL_GRACE_MS = cancelTimeoutSeconds × 1000 / 2` if ffmpeg hasn't exited.
    7. Wait for **confirmed exit**: the child process's `exit` event, not the signal call, until the deadline.
    8. Delete the partial file.
    9. Resolve; if exit wasn't confirmed by the deadline, reject with a cancellation-termination failure (job stays `cancelled`, file still deleted, the late exit still observed). A pending job with no encoder resolves without signals.

    Concurrent callers share the in-flight promise; terminal jobs return immediately.

    Deadline (Req 4.8, Property 6): for an active encoder, sending `SIGTERM` or `SIGKILL` is not sufficient. Actual exit must be observed within `VIDEO_CONFIG.cancelTimeoutSeconds`. If it isn't, the job stays terminal `cancelled` and non-downloadable, the termination failure is logged, and Property 6 fails for that execution even though `cancel()` returned and the partial file was deleted.
  - [x] 28.5 Completion uses compare-and-set `rendering→complete`. If it fails, nothing is recorded and the job stays `cancelled`. Failure uses `rendering→failed` and deletes the partial output (Req 4.7) without signalling the encoder. An unlink error is logged; the original error stays the reported failure, with no second transition.

- [x] 29. Route lifecycle (`routes.ts`)
  - [x] 29.1 `POST /api/render`:
    - `createJob()` after validation, open SSE, write `{"jobId","percent":0}` first, then `run()`.
    - `complete`: one terminal 100. `cancelled`: end quietly, with no 100 and no error. `failed`: one error event.
  - [x] 29.2 `res.on("close")`: set `closed`. If the job is still pending or rendering, call `cancel(jobId)` (shared path). If it's terminal, change nothing.
  - [x] 29.3 `DELETE`: 404 for an unknown job (unchanged). Otherwise `await cancel(jobId)` then 204. A terminal job is a no-op 204 and never deletes a complete job's file.
  - [x] 29.4 Confirm download serves only `complete` and returns 409 for every other state.

- [x] 30. UI cancel (`useRenderJob.ts`, `VideoExport.tsx`)
  - [x] 30.1 Hook: take the job ID from the first event. `cancel()` sends `DELETE` first, then closes the stream. Don't treat a quiet stream end after cancellation as a failure.
  - [x] 30.2 Disable the Cancel button until a job ID is known; enable it while rendering.

- [x] 31. Tests and validation
  - [x] 31.1 New `tests/cancellation.test.ts` (fake timers; scripted ffmpeg with recorded `kill(signal)` and scripted exit):
    - Signals vs. exit: the scripted ffmpeg records `kill(signal)` separately from a scripted process `exit`. `SIGTERM` sent; when the process exits after it, `SIGKILL` is never sent (race 7); when it doesn't, `SIGKILL` is sent at `KILL_GRACE_MS` and exit is observed before the deadline (race 8). When exit never comes, `cancel()` rejects at the deadline, the job stays `cancelled`, the file is deleted, and download returns 409.
    - Frame loop stops mid-way; partial file deleted; `cancel()` resolves within `cancelTimeoutSeconds`.
    - Final state `cancelled`, and it stays `cancelled` when `end` arrives during cancellation (race 2) or `error` arrives after `SIGTERM`/`SIGKILL` (race 3).
    - Concurrent `cancel()` calls run cleanup once.
    - Cancel while pending: `run` does no work.
    - Repeated cancel after `cancelled` (race 5) and cancel after `complete` keeps the MP4 (race 6).
    - Req 4.7 regression: partial output exists, rendering fails, the job becomes `failed`, the output is deleted, download is rejected, no signal is sent. An unlink error keeps the original failure.
    - No timers or listeners left.
  - [x] 31.2 Route tests (`tests/routes.test.ts`, integration):
    - The job ID event comes first.
    - Cancel ends the stream with no 100 and no error event.
    - Disconnect while rendering calls the shared `cancel`.
    - Completion just before close leaves the job `complete` (race 4).
    - `DELETE` and disconnect nearly simultaneous produce one cleanup and a 204 (race 1).
    - Repeated `DELETE` returns 204.
    - `DELETE` after `complete` keeps the file and download still works.
    - Download of `cancelled`/`failed` returns 409.
    - Unknown-job `DELETE` returns 404.
  - [x] 31.3 Hook/UI test: the Cancel button is disabled before the job ID arrives, then sends `DELETE` during rendering.
  - [x] 31.4 Update existing tests for the `createJob`/`run` split and the routes mock. Properties 1–17 must still pass.
  - [x] 31.5 Type-check (0 errors), full suite, build, governed-literal scan (`KILL_GRACE_MS` derived from `cancelTimeoutSeconds`), `git diff --check`, traceability (Req 4 numbered 1–22, Properties 1–18).
  - [x] 31.6 Mutation checks, each of which must fail tests:
    - no `kill`;
    - no `SIGKILL` escalation;
    - `SIGKILL` sent unconditionally;
    - completion without compare-and-set;
    - no frame-loop abort;
    - disconnect not cancelling;
    - disconnect cancelling a terminal job;
    - `DELETE` deleting a complete file;
    - no job-ID-first event;
    - error event on cancel.
  - [x] 31.7 One local manual end-to-end run with real ffmpeg (no GitHub): start a render, cancel it mid-encode through `DELETE`, record the ffmpeg child PID, then confirm the process is no longer alive (`process.kill(pid, 0)` → `ESRCH`), the file is deleted, the status is `cancelled`, and download returns 409.
  - [x] 31.8 Fill the verification table, clean up temporary files, commit as planned.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["28.1", "28.2", "28.3"] },
    { "id": 1, "tasks": ["28.4", "28.5"] },
    { "id": 2, "tasks": ["29.1", "29.2", "29.3", "29.4", "30.1", "30.2"] },
    { "id": 3, "tasks": ["31.1", "31.2", "31.3", "31.4"] },
    { "id": 4, "tasks": ["31.5", "31.6", "31.7", "31.8"] }
  ]
}
```

## Notes

- One cancellation implementation (`cancel`) serves `DELETE`, client disconnect, and internal paths. Neither route duplicates the cleanup logic.
- `KILL_GRACE_MS` is derived from the governed `cancelTimeoutSeconds`; no new governed constants.
- Cancellation records stay in `jobs` so repeated `DELETE` returns 204. Sweeping old cancelled/failed records is not part of this change.
- No GitHub API usage in this cycle.

**Mutation checks (31.6):** 17 of 18 caught.
- Caught: progress tracker not stopped on cancellation; no `kill`; no `SIGKILL` escalation; `SIGKILL` sent unconditionally; signal treated as exit; completion with no state check; no frame-loop abort; failure keeps partial output; termination failure not surfaced; no shared cancellation; `DELETE` deleting a complete file; disconnect not cancelling; disconnect cancelling a terminal job; no job-ID-first event; error event on cancel; UI aborting before `DELETE`.
- Not caught: replacing the completion compare-and-set alone. The `job.status !== "rendering"` check immediately before it guards the same synchronous region, so the compare-and-set is defense in depth that no single-threaded interleaving can reach.

## Correctness Properties Verification (Render Cancellation Lifecycle)

| # | Property | Result | Evidence |
|---|----------|--------|----------|
| 1–5, 7–17 | Unchanged properties | PASS | Full suite: 393 tests across 11 files (existing tests updated only for the `createJob`/`run` split and the job-ID-first event) |
| 6 | Cancellation Terminates Rendering Within the Timeout | PASS | `tests/cancellation.test.ts`, with signals recorded separately from the child's `exit`:
- races 7/8: `SIGTERM` only when it exits; `SIGKILL` at `KILL_GRACE_MS` with exit observed before `T`;
- cancellation not settled while a signal is sent but exit not observed;
- no exit by `T`: rejects as a cancellation-termination failure, job stays `cancelled`, file deleted;
- frame loop stops (< 15 canvases), output deleted, late `end`/`error` can't resurrect the job (races 2, 2b, 3);
- no progress emitted after cancellation, even while ffmpeg still reports frames before exiting;
- download 409; Req 4.7 failure cleanup.

PASS rests on the observed child `exit` event, not on `cancel()` returning or the file being deleted.

Real ffmpeg (31.7, re-run on the final code): child PID alive and encoding (12%) before `DELETE`. `SIGTERM` sent 37 ms after the request; the child's own `exit` event fired at 78 ms (code 255), within the 3,000 ms deadline, so no `SIGKILL` was needed. Afterwards the PID was gone (`process.kill(pid, 0)` → `ESRCH`, no `/proc` entry, 0 ffmpeg processes for the job). `DELETE` 204 in 83 ms, file gone, status `cancelled`, 0 active records, download 409, repeated `DELETE` 204, no resources left after the server closed. |
| 18 | Render Job Lifecycle Has One Outcome | PASS | Guarded-transition matrix test; job ID first, written before `run()` starts; quiet stream end on cancel; disconnect while pending or rendering → shared `cancel()`; disconnect after complete/failed → no change (race 4); `DELETE` + disconnect share one cancellation and neither settles before exit (race 1); repeated `DELETE` 204 (race 5); `DELETE` after complete keeps the MP4 and download still works (race 6); unknown → 404; termination failure → structured 500; UI: Cancel enabled only with a job ID, `DELETE` sent before the stream closes. Real run: first event `{jobId, percent: 0}`, no event after cancel, no 100, no error, stream ended |

---

# Implementation Plan: Extraction Quality (Candidate B, narrowed)

## Overview

Six deterministic extraction fixes from live-validation issues 3, 4 (noise only), 5 (docs only), 8, 9, and 11 (Req 3.14, 5.7, 5.12, 7.19–7.22; Properties 19–25). All changes are in `src/server/storyboard.ts` plus tests. No analyzer, pipeline, route, renderer, or config changes; GitHub request counts are unchanged.

Out of scope: capability rewriting (6), heading-only how-it-works (7), performance category (12), release-vs-PR duplication (rest of 4), other maintenance commit types (rest of 5), Candidates C and D, LLM rewriting or similarity.

Branch `fix/extraction-quality` from `main`. Commit plan:
1. `docs:` specs.
2. `fix:` release classification and release-note context (B1, B2).
3. `fix:` highlight and relevance filtering (B3, B5).
4. `fix:` run headings, emoji shortcodes, and overview duplicates (B4, B6a, B6b).

No push without approval.

## Tasks

- [ ] 32. Patch-release classification (B1, Req 7.19)
  - [ ] 32.1 Add `parseSemanticVersionTag(tag)` (boundary strip → anchored SemVer core/prerelease/build, no prerelease-label allowlist, no dependency); reimplement `isPatchRelease` on `parsed.patch > 0`.
  - [ ] 32.2 Tests: the positive and negative tag table below; arbitrary prerelease identifiers (`1.2.3-api`, `1.2.3-rc.1`) and build metadata (`1.2.3+build.5`); SemVer validity vs. patch classification kept distinct (`v1.2.0`/`v2.0.0` valid but not patches); a timeline/deep-dive test showing a prefixed patch release is excluded and a prefixed minor release is kept.

- [ ] 33. Release-note cleanup (B2, Req 7.20)
  - [ ] 33.1 Add `cleanReleaseNotes(body)` (steps 1–8 in design B2) and use it only in the release loop of `buildEvolutionSlides`. PR and commit contexts stay unchanged.
  - [ ] 33.2 Tests: GitHub-generated notes; prose plus bullets; bullets only; links; bare URLs and autolinks; hashes (7 and 40 chars, backticked, parenthesized); reference lists; inline prose references kept; `sha256`/`0x…`/`deadbeef` kept; everything-noise notes → no release deep dive.

- [ ] 34. Documentation-only commits (B3, Req 7.21)
  - [ ] 34.1 Add `isDocsCommit(subject)`; reject before `take()` on both `selectHighlightCommits` paths.
  - [ ] 34.2 Tests: `docs:`, `docs(scope):`, `docs!:`, `docs(scope)!:`, `Docs:`, `DOCS(api)!:` excluded; `feat: generate docs site`, `Add docs command`, `docsite: …`, `doc: …`, `fix(docs): …` keep their previous eligibility; a docs commit and a feature commit in one Change_Group → the feature commit is selected; a `docs:` PR's eligibility is unchanged (Req 7.1).

- [ ] 35. Calendar terms (B5, Req 7.22)
  - [ ] 35.1 Add `CALENDAR_TERMS` and `isCalendarTerm`; filter in `relevanceTokens`. Update its docstring.
  - [ ] 35.2 Tests: years 1900/2024/2099 dropped; 1899/2100/8080/3000 kept; all months and abbreviations dropped; `http2`, `es2022`, `v2024`, `1080p`, `ipv6`, `base64` kept; a PR relevant only through `2024` or `March` is no longer relevant; `2024` no longer prefix-matches `20240115`.

- [ ] 36. Run headings (B4, Req 5.7)
  - [ ] 36.1 Extend `RUN_HEADING_RE`; make `headingKey` strip leading shortcodes (after task 37.1).
  - [ ] 36.2 Tests: all eight keywords in lower, upper, and title case; `**Install**`, `## 📦 Installation`, `## :package: Install:`, `Example usage`; `Installing`, `Instance`, `Exampleapp` not matched; document order between `Example` and `Installation`; code-block preference and caps unchanged.

- [ ] 37. Emoji shortcodes (B6a, Req 3.14)
  - [ ] 37.1 Add `stripEmojiShortcodes`; apply it in `makeSlide` (title, body lines, preview), `headingKey`, and `releaseTitle`. Add an optional `literalBody` flag to `makeSlide` that escapes but does not shortcode-strip the body; `buildRunSlide` sets it for code-block-sourced steps so commands/examples are preserved. Prose-fallback Run steps and the Run title are still stripped.
  - [ ] 37.2 Tests: `:muscle:`, `:+1:`, `:-1:`, `:white_check_mark:`, and unknown `:not_a_real_emoji:` removed; `10:30:45`, `2001:db8::1`, `a:b:c`, `std::vector`, `:Note:` kept; a shortcode-only release name falls back to the tag; a generated storyboard over a fixture seeded with shortcodes in every text field has no shortcode outside code-block Run steps.

- [ ] 38. Overview duplicates (B6b, Req 5.12)
  - [ ] 38.1 Add `overviewKey` and `dedupeParagraph`; compare before truncation in `buildIntroSlide`.
  - [ ] 38.2 Tests: collapse cases (case, punctuation, `**bold**`, extra whitespace, shortcode, `chalk: …`, `chalk — …`, description repeated as first sentence with extra sentences kept); keep cases (description plus extra words in one sentence; a different sentence sharing most terms; a negated sentence; a different repository name as the lead-in; `chalk is a styling library` vs. description `A styling library` NOT collapsed — the accepted limit).

- [ ] 39. Validation
  - [ ] 39.1 Update existing tests only where the new rules intentionally change output (Property 8's corpus check normalizes shortcodes the same way).
  - [ ] 39.2 Type-check (0 errors), full suite, build, governed-literal scan, `git diff --check`, traceability (Req 3: 1–14, Req 5: 1–12, Req 7: 1–22, Properties 1–25).
  - [ ] 39.3 Regression: Properties 1–18 pass; duration and slide-count limits, repository-first ordering, and Change_Group tests unchanged; analyzer request-count tests unchanged (no analyzer diff).
  - [ ] 39.4 Mutation checks (below); each must fail a behavioral test, not compilation.
  - [ ] 39.5 Fixture comparison: storyboards for the three existing fixtures before and after, with every difference explained. No GitHub requests.
  - [ ] 39.6 Fill the verification table, clean temporary files, commit as planned.

## Test Matrix

| Item | Must apply | Must not apply |
|---|---|---|
| B1 (excluded as patch) | `v1.2.3`, `1.2.3`, `V1.2.3`, `release-v1.2.3`, `yargs-parser-v20.2.9`, `pkg@1.2.3`, `@scope/pkg@1.2.3`, `cli/v1.2.3`, `my_tool_1.2.3`, `v1.2.3-rc.1`, `1.2.3-api`, `v1.2.3+build.5` | `v1.2.0`, `v2.0.0`, `v2.0.0-beta.1`, `v1.2.0-rc.1` (valid SemVer, not patches); `1.2.3.4`, `2024.01.15`, `node-1.2.3-compat`, `support-1.2.3x`, `nightly`, `latest` (not SemVer); release name `Support for 1.2.3` on tag `v2.0.0` |
| B2 | URLs, `[text](url)`, `<url>`, `by @u in url`, hashes (7–40 hex), `(#12)`, `(#12, #13)`, `(o/r#12)`, Full Changelog, New Contributors | prose sentence, version `v2.1`, inline `#123` in prose, `@alice` in prose, `sha256`, `0x1f2e3d4c`, `deadbeef` |
| B3 | `docs:`, `docs(scope):`, `docs!:`, `docs(scope)!:`, `Docs:`, `DOCS(api)!:` | `feat: generate docs site`, `Add docs command`, `docsite:`, `doc:`, `fix(docs):` |
| B4 | Install, Installation, Getting Started, Setup, Usage, Quick Start, Example, Examples (any case, emphasis, emoji/shortcode lead, trailing colon) | Installing, Instance, Exampleapp |
| B5 | 1900–2099 standalone, month names, abbreviations | 1899, 2100, 8080, `http2`, `es2022`, `v2024`, `1080p`, `ipv6`, `base64` |
| B6a | `:muscle:`, `:+1:`, `:-1:`, `:white_check_mark:`, unknown shortcode | `10:30:45`, `2001:db8::1`, `a:b:c`, `std::vector`, `:Note:`, code-block Run steps |
| B6b | case, punctuation, Markdown, whitespace, shortcode, `<repo> —/:/,/is` lead-in, duplicate first sentence | superset sentence, shared-terms sentence, negated sentence, other-name lead-in |

## Mutation Plan

Each mutation must make a behavioral test fail; a type or syntax error doesn't count.

| Item | Mutation | Expected failing test |
|---|---|---|
| B1 | Restore the old start-anchored regex | prefixed-tag cases; `1.2.3.4` / `2024.01.15` kept |
| B1 | Drop the `$` anchor after the SemVer suffix (allow trailing text) | `node-1.2.3-compat`, `support-1.2.3x` kept |
| B1 | Allow a leading-zero version component | `2024.01.15` kept (not a version) |
| B2 | Skip URL removal | Property 20 URL check |
| B2 | Skip the prose-only preference (join bullets) | bullet-joining check |
| B2 | Remove every `#\d+` (over-broad) | inline prose reference kept |
| B3 | Remove the docs check | docs forms excluded |
| B3 | Check docs after `take()` | same-group feature commit selected |
| B3 | Case-sensitive match | `Docs:` / `DOCS(api)!:` excluded |
| B4 | Drop `install`/`examples?` from the regex | new keywords recognized |
| B4 | Compare raw heading text instead of `headingKey` | emphasis/shortcode headings |
| B5 | Remove the calendar filter | year/month relevance cases |
| B5 | Drop every all-digit token (over-broad) | `8080` / `3000` kept |
| B6a | Skip stripping in `makeSlide` prose | Property 24 prose-removal check |
| B6a | Strip inside `literalBody` code steps too | Property 24 code-preservation check |
| B6a | Drop the lookarounds | `10:30:45` / `2001:db8::1` kept |
| B6b | Restore whole-paragraph equality | duplicate-first-sentence case |
| B6b | Use substring containment instead of sentence equality | superset/shared-terms keep cases |
| B6b | Strip a leading `repo is` wording prefix | `chalk is …` kept whole |

## Notes

- No governed constants are added or changed. `CALENDAR_TERMS`, the release section names, and the shortcode pattern are algorithm data in `storyboard.ts`, like `GENERIC_TERMS`. There is no prerelease-label list.
- Caps are unaffected: cleanup only removes text, so word and slide caps remain ceilings.
- Fixtures are synthetic; this cycle makes no GitHub requests.

**Accepted limitations (carried from design, confirmed with the user):**
- B1: a leading-zero-free calendar version such as `2024.1.15` is classified as a semantic version (and a patch when the third component > 0).
- B5: a standalone year-range number (1900–2099) like `2048` is treated as calendar noise; other numeric and mixed alphanumeric technical terms stay eligible.
- B6b: deterministic normalized equality only, so `chalk is a styling library` and a bare `A styling library` description are both kept.

**Scope guard:** if implementation shows any change is needed outside `storyboard.ts`, or would need an analyzer change, a new GitHub request, a governed constant, or a new dependency, stop and report instead of expanding scope.

---

# Implementation Plan: Semantic/Story Quality (Cycle B2a)

## Overview

Two deterministic text-quality fixes from deferred live-validation items 6 and 7 (Req 5.4, 5.13, 6.3, 6.10; Properties 26, 27). Both are confined to `src/server/storyboard.ts` plus tests. No analyzer, pipeline, route, config, or GitHub-request changes; no change to evolution classification, `ChangeCategory`, `perf:` handling, slide ordering, slide caps, duration, or Change_Group behavior.

Out of scope: B2b (`perf:` category), capability source selection or dedup semantics, how-it-works slide structure/ordering, Candidates C and D, and any generative/LLM/NLP text.

Branch `fix/story-quality` from `main`. Commit plan:
1. `docs:` specs.
2. `fix:` capability phrasing (B2a-1).
3. `fix:` spec how-it-works prose fallback (B2a-2).

No push without approval.

## Tasks

- [ ] 40. Capability phrasing (B2a-1, Req 5.13)
  - [ ] 40.1 Add `SYSTEM_SUBJECTS` (two members: `the system`, `the video`) and `userStoryActionPhrase(clause)`; apply it to the spec-story branch of `extractCapabilities` for display text, preserving the raw clause for dedup/overlap so selection is unchanged.
  - [ ] 40.2 Prove selection invariance: dedup keys and `capabilitiesOverlapFeatures` input produce the same surviving items and order as before; if the Action_Phrase cannot be shown selection-safe for dedup, key dedup on the raw clause.
  - [ ] 40.3 Tests: the transform table and the preserve table below; the kiro fixture capabilities now read action-first; overlap/selection unchanged on all fixtures.

- [ ] 41. Spec how-it-works prose fallback (B2a-2, Req 6.3, 6.10)
  - [ ] 41.1 Add `isExplanatoryProse(line)` (structural rules only, no character threshold) and `specExplanatoryProse(docs)`; wire into `extractHowItWorks` only when the preferred paths yield no sentences. Headings and `HowItWorks.headings` are untouched.
  - [ ] 41.2 Tests: a spec with prose only under "Overview"/"Components" now yields prose; a design/architecture section still wins when present; a headings-only spec stays headings-only; requirement lines, glossary lines, tables, code, and short fragments are rejected; anchors unchanged.

- [ ] 42. Validation
  - [ ] 42.1 Update existing tests only where output intentionally improves (the kiro capability strings; any how-it-works fixture that gains prose). Property 8 corpus check still holds.
  - [ ] 42.2 Type-check (0 errors), full suite, build, governed-literal scan, `git diff --check`, traceability (Req 5: 1–12, Req 6: 1–10, Properties 1–27).
  - [ ] 42.3 Regression: Properties 1–25 pass; slide ordering, caps, duration, Change_Group, evolution classification, and `ChangeCategory` unchanged; analyzer request-count tests unchanged (no analyzer diff).
  - [ ] 42.4 Mutation checks (below); each must fail a behavioral test.
  - [ ] 42.5 Fixture before/after on the four existing fixtures plus a seeded spec-only fixture; explain every difference; zero GitHub requests.
  - [ ] 42.6 Fill the verification table, clean temporary files, commit as planned.

## Test Matrix

**B2a-1 transform (display becomes the action phrase):**
| Clause after "I want" | Action_Phrase |
|---|---|
| `to submit a GitHub repository URL` | `Submit a GitHub repository URL` |
| `the System to automatically analyze a repository` | `Automatically analyze a repository` |
| `the video to explain how the repository works` | `Explain how the repository works` |
| `the application to export CSV files` | `Export CSV files` |

**B2a-1 preserve (unchanged, catches over-stripping):**
| Clause after "I want" | Kept as |
|---|---|
| `files to sync automatically` | `Files to sync automatically` |
| `a fast parser` | `A fast parser` |
| `the parser to be fast` (unrecognized subject `the parser`) | `The parser to be fast` |
| `my data exported` | `My data exported` |

**B2a-2 how-it-works:**
| Spec shape | Result |
|---|---|
| prose under `## Design` | prose from the design section (unchanged path) |
| prose only under `## Overview` / `## Components` | prose from the first substantive section (new fallback) |
| headings only, no prose | headings-only body (deterministic) |
| title + requirement lines + glossary + table only | headings-only (prose rejected) |
| no headings, no prose | `extractHowItWorks` returns null |

## Mutation Plan

Each mutation must make a behavioral test fail; a type/syntax error does not count.

| Item | Mutation | Expected failing test |
|---|---|---|
| B2a-1 | Return the clause unchanged (no transform) | the transform table |
| B2a-1 | Strip any noun phrase before ` to ` (drop the closed-set check) | `files to sync automatically` / `the parser to be fast` / `the application to export CSV files` preserved |
| B2a-1 | Change the dedup/overlap input to the Action_Phrase when it changes selection | overlap/selection-unchanged test |
| B2a-2 | Remove the prose fallback | prose-only-under-Overview case |
| B2a-2 | Fallback takes the first paragraph without `isExplanatoryProse` | requirement/glossary/table-rejected case |
| B2a-2 | Drop the single-token-label check (accept one-word lines) | one-word-label-rejected case |
| B2a-2 | Drop the EARS/requirement-line check | requirement-line-rejected case |
| B2a-2 | Drop the Glossary-definition check | glossary-line-rejected case |
| B2a-2 | Let the fallback alter `HowItWorks.headings` | anchors-unchanged test |

## Notes

- No governed constants and no numeric thresholds are added. `SYSTEM_SUBJECTS` (two members) is algorithm data in `storyboard.ts`, like `GENERIC_TERMS` and `CALENDAR_TERMS`. The earlier `HOW_IT_WORKS_MIN_PROSE_CHARS` idea is removed; Explanatory_Prose is identified by structural rules alone.
- Caps and ordering are unaffected: both fixes only change the text inside existing slides.
- Fixtures are synthetic; this cycle makes no GitHub requests.

**Scope guard:** if any change is needed outside `storyboard.ts` (for example touching `ChangeCategory`, the analyzer, or `output.ts`), stop and report instead of expanding scope.

## Test-hygiene backlog (tracked, not fixed in B2a)

- **TH1. Renderer tests leave temp `.mp4` files.** `tests/*` exercising download/large-file paths write `download-test-job.mp4` and `large-file-job.mp4` into the OS tmpdir and do not remove them, so each full run leaves two stray files that are repeatedly rediscovered and cleaned by hand. Fix later by having those tests write to a per-test temp dir and clean up in `afterEach`/`afterAll`. Not addressed in B2a.

---

# Implementation Plan: Empty-Anchor Evolution Fallback (Cycle Q2)

## Overview

Reframed Q2 (from the real-repo review). For repositories with no Anchor_Terms, surface the independently-significant evolution evidence the pipeline already holds (Significant_PRs and non-patch Releases with a Change_Context), and show source-derived release context on the empty-anchor timeline. Anchored repositories stay byte-identical. Req 7.23–7.25; Properties 28–30 (and Property 10 amended). All changes in `src/server/storyboard.ts` plus tests.

Out of scope: Q1 capability ordering, B2b `perf:`, Candidate C (F2/F3/F4), Candidate D, TH1. No analyzer, GitHub-request, `ChangeCategory`, ranking, cap, patch-classification, or Change_Group change.

Branch `fix/empty-anchor-evolution` from `main`. Commit plan:
1. `docs:` specs.
2. `fix:` empty-anchor PR/release eligibility in `planEvolution` + deep-dive guard.
3. `fix:` empty-anchor release context on the timeline.

No push without approval.

## Tasks

- [ ] 43. Empty-anchor notable-change eligibility (Req 7.23, 7.24)
  - [ ] 43.1 In `planEvolution`, compute `relevantPrs` as `anchors.size === 0 ? ranked : ranked.filter((r) => isRelevant(...))`. `deepDives` still excludes "Bug Fix" and slices to remaining slots. Timeline PR entries use the same `relevantPrs` as today.
  - [ ] 43.2 In `buildEvolutionSlides`, change the release deep-dive guard to `context && (anchors.size === 0 || isRelevant(releaseTitle+context, anchors))`. Patch exclusion, ordering, `cleanReleaseNotes`, `extractChangeContext`, and the slot ceiling unchanged.
  - [ ] 43.3 Leave `selectHighlightCommits` and the 7.14 `feat`-only fallback untouched; confirm Selected_PR Change_Group blocking still applies (7.15).

- [ ] 44. Empty-anchor timeline release context (Req 7.25)
  - [ ] 44.1 In the timeline builder, when `anchors.size === 0`, append the release's `extractChangeContext(cleanReleaseNotes(body))` (truncated to `changeContextMaxWords`) to its entry as `tag — context`; releases without context stay `tag` only. When anchors exist, the entry string is unchanged. PR timeline entries are unchanged.

- [ ] 45. Validation
  - [ ] 45.1 Update existing tests only where empty-anchor fixtures intentionally gain evolution content. Anchored fixtures must be unchanged.
  - [ ] 45.2 Type-check (0 errors), full suite, build, governed-literal scan, `git diff --check`, traceability (Req 7: 1–25, Properties 1–30).
  - [ ] 45.3 Regression: Properties 1–27 pass; slide ordering, caps (`maxEvolutionItems`, `maxEvolutionSlides`, 15-slide), category ranking, patch classification, and Change_Group behavior unchanged; analyzer request-count tests unchanged (no analyzer diff).
  - [ ] 45.4 Mutation checks (below); each must fail a behavioral test.
  - [ ] 45.5 Fixture before/after on the four existing fixtures plus the empty-anchor cases below, and the real `slugify` acceptance snapshot (from captured data, no new GitHub requests). Explain every difference.
  - [ ] 45.6 Fill the verification table, clean temporary files, commit as planned.

## Test Matrix

| Case | Expectation |
|---|---|
| anchors empty + release with usable context | release deep-dive and/or timeline entry carries the source context |
| anchors empty + release with empty/unusable body | release stays `tag` only; no deep-dive from empty context; no invented text |
| anchors empty + Significant_PRs | PR deep-dives appear in rank order (non-"Bug Fix") |
| anchors empty + both PR and release evidence | PR deep-dives first, releases fill remaining slots; caps respected |
| anchors empty + no significant evidence | no notable-change slides; only the `feat`-fallback highlights, if any |
| anchors present + identical inputs | byte-identical evolution slides (Property 29) |
| patch releases | still excluded in the empty-anchor case |
| maintenance/noise PRs (bot, chore/docs/ci, deps, uncategorized, Bug Fix) | still excluded when anchors empty |
| caps | `maxEvolutionSlides`/`maxEvolutionItems`/15-slide still enforced |

## Mutation Plan

| Mutation | Expected failing test |
|---|---|
| `relevantPrs = ranked` always (ignore anchors) | anchored-invariance (Property 29) test |
| empty-anchor branch admits "Bug Fix" PRs | empty-anchor PR category test |
| empty-anchor branch admits bot/maintenance/deps PRs | empty-anchor noise-exclusion test |
| release guard drops the `isRelevant` disjunct for anchored repos (always allow) | anchored-invariance test |
| release guard ignores `context` (allow empty-context releases) | empty-body release test |
| timeline context applied when anchors exist | anchored-invariance timeline-text test |
| timeline/deep-dive context invented when `extractChangeContext` returns null | provenance (Property 30) test |
| displayed context bypasses `cleanReleaseNotes` (shows raw body/URL/hash) | provenance (Property 30) test: URL/hash absent, link text kept |
| empty-anchor branch makes commits eligible as highlights | highlight-unchanged test |

## Real `slugify` acceptance (captured data, no new requests)

Before: timeline shows bare `… · Release · v3.0.0`, no deep-dives (0 anchors suppressed everything).
After (expected): empty-anchor timeline entries carry context, e.g. `v3.0.0 — Require Node.js 20`, `v2.2.0 — Add preserveCharacters option`, `v1.1.0 — Add support for empty separator`; and/or Significant_PR deep-dives such as "Add preserveTrailingDash option" appear in rank order, within `maxEvolutionSlides`. Releases without usable notes stay `tag` only. No new GitHub requests.

Note on PR-vs-release duplication (Decision 2): slugify's PRs ("Add preserveTrailingDash option") and release notes ("Add preserveTrailingDash option") can describe the same change. Deep-dive allocation puts PRs first and releases fill remaining slots; Change_Group blocking (7.15) prevents PR-vs-commit duplication. PR-vs-release textual overlap is accepted as-is (as for anchored repos today); no PR-vs-release deduplication — not even exact-equality — is added. Observed duplication is reported, not fixed, this cycle.

## Notes

- No governed constants added. No numeric thresholds. The fallback is gated solely on `anchors.size === 0`.
- Caps unchanged; the fallback only changes which already-significant evidence passes the (removed) relevance test, never the ceilings.
- Fixtures are synthetic except the `slugify` acceptance snapshot, which uses already-captured data; this cycle makes no GitHub requests.

**Scope guard:** if any change is needed outside `storyboard.ts`, or would touch `ChangeCategory`, ranking, caps, patch classification, Change_Groups, or request behavior, stop and report instead of expanding scope.

---

# Implementation Plan: PR Deep-Dive Context Sanitation

## Overview

Narrowed real-output fix: PR deep-dive bodies pass through `extractChangeContext(pr.body)` without the URL/reference cleanup release notes get, so anchor-less repos (which now surface PR deep-dives, Q2) expose structural GitHub metadata (slugify #46 begins `Closes <URL> …`). Add a display-only PR cleaning path (`cleanPullRequestBody`) and a separate `displayContext`, keeping the relevance `context` unchanged. Req 7.26; Properties 31–33. `storyboard.ts` only.

Out of scope: rambling/wrong-sentence selection (#57), raw Unicode emoji, bare URLs embedded in prose, release/commit cleaning, Q2 semantics, B2b, Q1, Candidate C/D, TH1. No analyzer/config/type/request change, no `ChangeCategory` change.

Branch `fix/pr-deep-dive-sanitation` from `main`. Commit plan:
1. `docs:` specs.
2. `fix:` `cleanPullRequestBody` + `displayContext` + deep-dive body uses it.

No push without approval.

## Tasks

- [ ] 46. PR display-context pipeline (Req 7.26)
  - [ ] 46.1 Add `cleanPullRequestBody(body)`: remove URL-only lines, issue/PR-reference-only lines, issue-closing lines (`Close[sd]?|Fix(e[sd])?|Resolve[sd]?` + only URL/refs), and standalone commit-hash lines (reuse the conservative hash rule). Prose with embedded URLs/refs/hashes is preserved; no sentence selection.
  - [ ] 46.2 Add `displayContext` to `RankedPullRequest`, computed as `extractChangeContext(cleanPullRequestBody(pr.body))` alongside `context` in `rankSignificantPullRequests`. Leave `context` and all its consumers unchanged.
  - [ ] 46.3 In `buildEvolutionSlides`, the PR deep-dive body uses `r.displayContext` (falling back to title+dates when null, as today). Nothing else changes.

- [ ] 47. Validation
  - [ ] 47.1 Update existing tests only where a noisy PR body intentionally produces cleaner display context. Clean-body cases must be unchanged.
  - [ ] 47.2 Type-check (0 errors), full suite, build, governed-literal scan, `git diff --check`, traceability (Req 7: 1–26, Properties 1–33).
  - [ ] 47.3 Regression: Properties 1–30 pass; Significant_PR eligibility, `ChangeCategory`, ranking, anchored relevance, empty-anchor fallback, PR timeline entries, deep-dive titles, allocation/order, release, commit, Change_Group behavior, caps, and section/slide order unchanged; analyzer request-count tests unchanged (no analyzer diff).
  - [ ] 47.4 Mutation checks (below); each killed by a behavioral property/test.
  - [ ] 47.5 Fixture before/after on the four existing fixtures; selected-PR identity/order comparison; real/captured `slugify` acceptance.
  - [ ] 47.6 Fill the verification table, clean temporary files, commit as planned.

## Test Matrix

| Case | Expectation |
|---|---|
| clean ordinary PR body | `displayContext === context`; slide byte-identical |
| standalone `Closes <URL>` | closing line removed; body is the remaining prose (or title/dates) |
| standalone `Fixes <URL>` / `Resolves <URL>` | closing line removed |
| standalone `Closes #123` | removed (already by extract; still removed) |
| URL-only line | removed |
| Markdown link with useful text | visible text preserved |
| meaningful inline URL in prose (`See https://x for details`) | preserved verbatim |
| standalone commit hash line | removed |
| checklist / template `- [ ]` lines | still excluded (unchanged) |
| raw Unicode emoji `😢` in prose | preserved |
| GitHub shortcode `:tada:` | stripped by B6a in makeSlide (unchanged) |
| multi-sentence rambling (#57-like) | first-sentence behavior preserved (accepted limitation) |
| anchored PR whose context feeds relevance | relevance decision unchanged (uses `context`) |
| empty-anchor Significant_PR | selected and shown; body cleaned |
| multiple PRs | selection set/order/allocation identical before/after |

## Mutation Plan

| Mutation | Killed by |
|---|---|
| `isRelevant` uses `displayContext` | selection-invariance (Property 32) test / anchored relevance test |
| deep-dive body uses original `context` | PR sanitation (Property 31) `Closes <URL>` test |
| `cleanPullRequestBody` fails to remove `Closes <URL>` | Property 31 `Closes <URL>` test |
| remove bare URLs indiscriminately (incl. prose) | inline-URL-preserved test |
| strip arbitrary Unicode emoji | emoji-preserved test |
| alter PR ranking/allocation | selection-invariance (Property 32) test |
| route PR bodies through `cleanReleaseNotes` | prose-preserved / orphaned-`Closes` test |
| `cleanPullRequestBody` changes a clean body | clean-body invariance (Property 33) test |

## Real `slugify` acceptance (captured data where possible, no new requests)

PR #46 before: body begins `Closes https://github.com/sindresorhus/slugify/issues/37 That's actually what I already made … 😢 …`.
PR #46 after (expected): the `Closes <URL>` line is removed; the body is `extractChangeContext` of the remaining prose (`That's actually what I already made …`), which stays imperfect — accepted (no rewriting). Removed element: the closing-reference line.
PR #57 before/after: unchanged — its noise is a rambling first sentence, not structural; wrong-first-sentence limitation remains (accepted).
Selected PR identities/order must stay: `Add preserveTrailingDash option (#57)`, `Add support for empty separator (#53)`, `Add counter for multiple occurrences (#46)`. If live data shifted, use captured input for the invariance proof and state so.

## Notes

- No governed constants, no numeric thresholds. `cleanPullRequestBody` reuses the existing conservative hash rule and `scanLines`.
- Dedicated `cleanPullRequestBody`; release cleaning untouched. If unavoidable duplication makes a shared helper clearly safer, stop and report before refactoring release code.
- Fixtures are synthetic except the `slugify` acceptance, which uses captured data; no new GitHub requests.

**Scope guard:** if any change is needed outside `storyboard.ts`, or would touch `ChangeCategory`, release cleaning, Q2 semantics, ranking, caps, Change_Groups, or request behavior, stop and report.
