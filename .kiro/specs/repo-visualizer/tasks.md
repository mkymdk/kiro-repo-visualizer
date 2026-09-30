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

- **Feature A — "How to run this repository" slide** (Requirements 3.9–3.13). A new `"run"` slide type extracted from the already-fetched README section (Installation / Getting Started / Setup / Usage / Quick Start), assembled purely in `storyboard.ts`, positioned after architecture and before highlights. No new GitHub calls, no repository code execution.
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
