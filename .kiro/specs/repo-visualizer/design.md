# Design Document

## Overview

The GitHub Repository Visualizer is a single-page web application with a Node.js/TypeScript backend API. A user submits a public GitHub repository URL; the system fetches repository data via the GitHub REST API, synthesizes a storyboard of slides, lets the user preview and reorder them, then renders and downloads an MP4 video.

The storyboard explains the **current repository first** and its history second. It follows a fixed narrative:

**What is this repository? → What can I do with it? → How do I run it? → How does it work? → What are its key features? → How has it evolved?**

Releases, pull requests, and commits are supporting evidence for the last act only. They are admitted only when they help explain how the repository reached its current capabilities or architecture, and every slide cap is a ceiling, not a target.

All content is produced by deterministic extraction from repository data (README, metadata, specs, releases, PRs, commits). The system does not generate or infer text, and it uses no generative model, which would require an outbound host outside the allowlist.

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
- Run seven extraction steps; skip and record failures rather than aborting (Property 4)
- Normalize responses into domain types. The analyzer does not rank, filter for relevance, or build slides; that is the storyboard's job.

**Extraction steps:**

| # | Step (`partialFailures` name) | Endpoint | Output | Empty, not a failure |
|---|---|---|---|---|
| 1 | Repository metadata (`metadata`) | `GET /repos/{owner}/{repo}` | `RepoMetadata` | — |
| 2 | Directory tree (`directoryTree`) | `GET /repos/{owner}/{repo}/git/trees/HEAD?recursive=1` | `DirectoryNode[]` (≤ 3 levels) plus the unfiltered blob list, used internally by step 5 | — |
| 3 | README (`readme`) | `GET /repos/{owner}/{repo}/readme` (raw, ≤ 1 MB) | `string \| null` | 404 → `null` |
| 4 | Commits (`commits`) | `GET /repos/{owner}/{repo}/commits?per_page=50` | `Commit[]` with `subject` and `body` | `[]` |
| 5 | Spec docs (`specDocs`) | `GET /repos/{owner}/{repo}/contents/{path}` (raw) per selected file | `SpecDocument[]` (≤ 6) | no `.kiro/specs/` → `[]` |
| 6 | Pull requests (`pullRequests`) | `GET /repos/{owner}/{repo}/pulls?state=closed&sort=updated&direction=desc&per_page=50` | `PullRequest[]` (merged only) | 404 or `[]` → `[]` |
| 7 | Releases (`releases`) | `GET /repos/{owner}/{repo}/releases?per_page=10` | `Release[]` (non-draft only) | 404 or `[]` → `[]` |

**Scheduling:** Steps 1, 2, 3, 4, 6, and 7 run concurrently via `Promise.allSettled`. Step 5 starts when step 2 resolves because it selects files from the unfiltered tree. Spec files sit four levels deep (`.kiro/specs/<name>/requirements.md`), below the 3-level cut applied to `directoryTree`. If step 2 fails, step 5 is skipped and both names are recorded in `partialFailures`.

**Accessibility check (Req 1.4):** The metadata response is the authoritative accessibility signal. A 404, or a 403 that is not a rate-limit response, raises `repo_not_found`. This replaces the current inference from the tree step.

**Spec file selection (Req 2.3):**
1. From the unfiltered tree, keep blobs whose path matches `^\.kiro/specs/.+\.md$` (case-insensitive extension), whose `size` ≤ 1 MB, and whose path contains no `.` or `..` segment.
2. Sort: basename `requirements.md` or `design.md` first, then all others; ties broken by ascending path.
3. Take the first `MAX_SPEC_FILES` (6), an analyzer module constant alongside `MAX_README_BYTES`.
4. Fetch each file with every path segment passed through `encodeURIComponent`, and assert the host before fetching (Security Constraint 7).

**Normalization:**
- **Commit:** `subject` is the first line. `body` is the remainder with leading blank lines trimmed; trailer removal happens in the storyboard's Change_Context extraction. `message` is kept as an alias of `subject` for existing callers.
- **PullRequest:** only items with `merged_at` set. `labels` are lowercased names. `isBot` is true when `user.type === "Bot"` or the login ends in `[bot]`. `body` is capped at `MAX_CHANGE_BODY_CHARS` (10 000), since only its first sentence is used.
- **Release:** drafts are dropped. `body` is capped at `MAX_CHANGE_BODY_CHARS`.
- **RepoMetadata:** `description`, `topics`, `stargazers_count`, `language`, and `license.spdx_id` (or `license.name`), each nullable.

**Request budget:** 6 fixed requests plus up to 6 spec files, so ≤ 12 per uncached analysis (previously ~4 plus top-level `.kiro` files). Unauthenticated, that allows roughly 5 uncached analyses per hour per IP; the analysis cache and `GITHUB_PERSONAL_ACCESS_TOKEN` mitigate this.

**Return type:**
```typescript
interface RepoAnalysisResult {
  owner: string;
  repo: string;
  metadata: RepoMetadata | null;
  directoryTree: DirectoryNode[];
  readmeText: string | null;
  commits: Commit[];
  specDocs: SpecDocument[];
  pullRequests: PullRequest[];
  releases: Release[];
  partialFailures: string[];   // names of steps that were skipped
}
```

**Error handling:** Throws typed `ApiError` instances (`invalid_url`, `repo_not_found`, `rate_limit_exceeded`, `request_timeout`, `network_error`). A rate-limit response from any step aborts the analysis, as today. The route handler catches these and returns the structured JSON error response.

---

### 3. Storyboard Generator (`src/server/storyboard.ts`)

Transforms a `RepoAnalysisResult` into an ordered `Slide[]`. Pure function, no I/O. All section matching, relevance filtering, ranking, allocation, ordering, and count enforcement live here. The module grows substantially, but it stays one module to preserve the ownership rule.

Generation runs in five stages.

#### Stage 1: Section extraction (README first, specs as fallback)

Shared helpers:
- `findSection(markdown, headingPattern)` returns the first heading in document order whose trimmed text matches the pattern, with its body up to the next heading of the same or higher level. This generalizes the existing run-instructions extractor.
- `firstSentences(text, n)` splits text into sentences.
- `listItems(section)` extracts `-`, `*`, and `1.` list items.
- `toPlainText(md)` reduces links and images to their text and strips emphasis and code-span markers.

| Slide (`type`) | Primary source | Fallback | Bounds | Omitted when |
|---|---|---|---|---|
| Overview (`intro`) | Repo name + `metadata.description` + `metadata.topics` + first README prose paragraph (skips heading, badge/image, HTML, and blank lines) | Name + "No description available." | `introMaxWords` | never |
| Capabilities (`capabilities`) | README section `Capabilities \| What it does \| What you can do \| Use Cases` → list items, else sentences | Spec user stories: the `I want …` clause of `As a …, I want …, so that …` lines (a leading `**User Story:**` is stripped), document order | `capabilitiesMaxItems`, `capabilityMaxWords` | no source, or overlap > `capabilitiesMaxOverlapRatio` (see below) |
| Run (`run`) | README section `Installation \| Getting Started \| Setup \| Usage \| Quick Start` (unchanged) | — | `runMaxSteps`, `runMaxWordsPerStep` | no match |
| Architecture (`architecture`) | Top-level tree, directories first (unchanged) | Placeholder text | — | never |
| How it works (`howItWorks`) | README section `How it works \| Architecture \| Design` → heading + sentences | Spec docs, `design.md` preferred: title, headings, sentences from design/architecture/decision sections (existing spec-slide logic) | `specMaxHeadings`, `specMaxSentences` | no source |
| Key features (`feature`) | README section `Features \| Key Features \| Highlights` → list items parsed as `**Name** — desc`, `**Name**: desc`, `Name: desc`, or `Name - desc` | design.md `…Components…` section subheadings + first sentence; then `Requirement N: Title` headings (name only) | `maxFeatureSlides`, `featureMaxWords` | no source |

"Usage" belongs to the Run slide only and is never a capabilities heading.

**Key_Feature slides (Req 6.9):** Features that have a description get one slide each, in document order. Features without one are listed on a single summary slide ("Key features") placed after them. The total is capped at `maxFeatureSlides`. When described features already fill the cap, the summary is dropped. Name-only items never get individual slides, so 20 requirement titles produce one summary slide, not five thin ones.

**Capabilities/Features overlap (Req 5.5):** Normalize both lists (lowercase, strip punctuation, collapse whitespace). A Capability matches when its normalized text contains, or is contained in, a normalized Key_Feature name or description. If `matches / capabilities > capabilitiesMaxOverlapRatio`, the Capabilities slide is omitted, but its items still feed the anchor terms.

#### Stage 2: Anchor terms

`buildAnchorTerms(capabilities, features, howItWorksHeadings): Set<string>`
- Tokenize on non-alphanumerics, lowercase, and keep tokens with length ≥ `relevanceMinTermLength`.
- Drop tokens in `GENERIC_TERMS`, a fixed module-level list of words that would make everything "relevant". It includes common English function words (`with`, `from`, `that`, `this`, `into`, `your`, `using`, `when`, `what`, `which`), change verbs (`added`, `adds`, `update`, `updates`, `change`, `changes`, `improve`, `implement`, `implementation`, `refactor`, `redesign`, `support`, `supports`, `allow`, `allows`, `make`, `makes`), and structural nouns (`feature`, `features`, `system`, `user`, `users`, `architecture`, `design`, `overview`, `usage`, `works`, `project`, `repository`).
- Match rule: `a === b || a.startsWith(b) || b.startsWith(a)`, so "render" matches "renderer".

`isRelevant(text, anchors)` tokenizes `text` the same way and returns true on any match.

Anchor terms come only from current-state content. Commits, PRs, and releases never contribute anchors or current-state slide content (Req 3.13).

**Empty anchor set (thin or commit-only repositories, Req 7.14):** When the README and specs yield no capability, feature, or how-it-works terms, no PR or release can be relevant, so there are no relevant PR timeline entries and no deep dives. Non-patch releases can still appear on the timeline, since they don't need relevance. The relevance-based commit path (7.9) is replaced by a narrow fallback: only commits whose subject starts with a conventional `feat` type (`feat:`, `feat(scope):`, `feat!:`, `feat(scope)!:`) qualify, minus dependency wording and already-presented PR references, capped at `maxFallbackHighlights`. Keyword substring matches (`add`, `implement`, …), `fix`, `docs`, `chore`, and every other type are excluded. The fallback shows that the repository evolved; it never feeds Capabilities, Key_Features, or anchors.

#### Stage 3: Evolution candidates

`extractChangeContext(text)` removes HTML comments (multi-line), task-list lines (`- [ ]`, `- [x]`), heading lines, fenced code blocks, and trailer lines (`^[A-Za-z][A-Za-z-]*: .+$`). It applies `toPlainText`, takes the first sentence, and truncates to `changeContextMaxWords`. It returns `null` when nothing remains.

| Candidate | Eligibility | Category | Order |
|---|---|---|---|
| Significant_PR (7.1) | `!isBot`; title not `^(chore\|docs\|ci\|style\|test\|build)(\(.+\))?!?:`; no `bump\|deps\|dependency\|dependencies`; category assignable | labels → conventional prefix → first keyword (7.2) | Breaking Change > Feature > Bug Fix > Refactor, then newest merge |
| Timeline PR (7.4) | Significant_PR ∧ relevant (title or context) | as above | rank |
| Deep-dive PR (7.5) | Timeline PR ∧ category ≠ Bug Fix | as above | rank |
| Timeline release (7.4) | not a Patch_Release (`^v?\d+\.\d+\.(\d+)` with group > 0) | "Release" | newest first |
| Deep-dive release (7.6) | timeline release ∧ Change_Context ≠ null ∧ relevant | "Release" | newest first |
| Engineering_Highlight (7.9, anchors ≠ ∅) | subject keyword match ∧ category ≠ Bug Fix ∧ relevant ∧ no `(#N)`/`Merge pull request #N` for a presented PR | keyword mapping | commit order |
| Fallback highlight (7.14, anchors = ∅) | subject matches `^feat(\([^)]*\))?!?:` ∧ no `bump\|deps\|dependency\|dependencies` ∧ no presented-PR reference | "Feature" | most recent first, ≤ `maxFallbackHighlights` |

Bug-fix PRs can appear as one-line timeline entries when relevant, but never consume a deep-dive slide. Bug-fix commits are never used.

#### Stage 4: Evolution allocation (ceiling, not target)

```
remaining = maxEvolutionSlides
timeline  = (eligible releases newest-first, then timeline PRs by rank)
              .slice(0, maxEvolutionItems).sortBy(date asc)
if timeline.length >= minEvolutionItems: emit Evolution_Timeline; remaining -= 1
for pr of deepDivePRs      while remaining > 0: emit change(pr);      remaining -= 1
for rel of deepDiveReleases while remaining > 0: emit change(rel);    remaining -= 1
highlights = anchors.size > 0
  ? relevantHighlights
  : fallbackHighlights.slice(0, maxFallbackHighlights)
for c of highlights         while remaining > 0: emit highlight(c);   remaining -= 1
```

Allocation stops when candidates run out. Nothing is repeated or padded (Req 3.12, 7.13). When neither releases nor PRs qualify, there is no timeline (7.8) and commit highlights are the only evolution content.

#### Stage 5: Ordering, trimming, validation

- Order (Req 3.1, 5.11): `intro → capabilities? → run? → architecture → howItWorks? → feature* → evolution? → change* → highlight* → conclusion`.
- Worst case is 6 + 5 + 4 = 15, so trimming (Req 3.4) never fires on generated storyboards. It is kept as a guard in this order: highlights, then changes (lowest rank first), then timeline, then features (last first).
- `slides.length < minSlides` → `ApiError("insufficient_content")`. With intro, architecture, and conclusion always present, this remains a guard.
- Conclusion: name, URL, and when metadata exists, stars, language, and license.

**Escaping (Req 3.11):** `makeSlide(type, title, body, preview)` takes **raw** strings and HTML-escapes all three fields itself. Builders stop escaping individually. This removes the double-escape risk and fixes the current unescaped conclusion `previewSummary`. Owner and repo are regex-constrained, so it isn't exploitable today, but it would fail a per-slide-type escaping test.

**Slide titles and bodies (content copy, not governed constants):**

| Type | Title | Body |
|---|---|---|
| `intro` | `{repo}` | description · topics · paragraph |
| `capabilities` | `What you can do` | bullet list |
| `run` | `How to run: {heading}` | steps (unchanged) |
| `architecture` | `Architecture: {repo}` | tree (unchanged) |
| `howItWorks` | `How it works` | heading(s) + sentences |
| `feature` | `Feature: {name}` / `Key features` | description / name list |
| `evolution` | `How it evolved` | `YYYY-MM-DD · {label} · {title}` lines |
| `change` | `{category} · {PR title} (#N)` or `Release · {name}` | context + `Merged YYYY-MM-DD` / `Published YYYY-MM-DD` |
| `highlight` | `{category} · {subject}` | context? + author + date |
| `conclusion` | `Conclusion: {repo}` | name, URL, stars/language/license |

`previewSummary` for every type is derived from the plain-text body, capped at `previewMaxWords`.

**Return type:**
```typescript
interface Slide {
  id: string;             // stable UUID for reorder/remove operations
  type: SlideType;
  title: string;          // HTML-escaped
  body: string;           // HTML-escaped, may contain newlines
  previewSummary: string; // HTML-escaped, ≤ previewMaxWords words
}
```

---

### 4. Storyboard Preview Component (`src/components/StoryboardPreview.tsx`)

Displays the generated slides with drag-to-reorder and per-slide remove controls. No changes: it renders `title` and `previewSummary` and does not branch on `type`.

**Behaviour:**
- Renders each slide as a card showing `slide.title` and `slide.previewSummary`
- Drag-and-drop reordering via `@dnd-kit/core`
- Remove button on each card; guarded: if current slide count equals `SLIDE_CONFIG.minSlides`, the remove button is disabled with a tooltip explaining the minimum
- "Export Video" button becomes active only when at least one slide is present
- Slide state is held in React component state; only the final ordered array is sent to the render API

---

### 5. Video Renderer (`src/server/renderer.ts`)

Converts a `Slide[]` into an MP4 file. Runs on the server.

**Technology:** [`canvas`](https://www.npmjs.com/package/canvas) (node-canvas) for frame rasterisation + [`fluent-ffmpeg`](https://www.npmjs.com/package/fluent-ffmpeg) for encoding. ffmpeg must be available in the runtime environment.

**Rendering pipeline:**
1. For each slide, lay out text (below), render `VIDEO_CONFIG.fps` frames × `secondsPerSlide` onto a `VIDEO_CONFIG.width × VIDEO_CONFIG.height` canvas, producing a PNG frame sequence
2. Pipe the frame sequence to ffmpeg with codec `libx264`, container `mp4`, frame rate `VIDEO_CONFIG.fps`
3. Calculate `secondsPerSlide` = `clamp(totalDuration / slideCount, minPerSlide, maxPerSlide)` where `totalDuration` is derived to keep output within `VIDEO_CONFIG.minDurationSeconds`–`VIDEO_CONFIG.maxDurationSeconds`
4. Write output to a temp file at `os.tmpdir()/{renderJobId}.mp4`

**Text layout (Req 4.15, 4.16):** This replaces today's `line.slice(0, 100)`, which cuts mid-word and ignores the actual glyph width.
- Layout values move from inline literals into a module-level `LAYOUT` constant: margins, title and body fonts, line heights, title top, and divider gap. These are presentation details, not spec constants, so they stay out of `output.ts`.
- `wrapText(text, maxWidth, measure): string[]` is a pure function. `measure` is injected as `(s) => ctx.measureText(s).width` in production and as a fake in tests. It splits on `\n` to preserve explicit breaks and blank lines, wraps greedily at spaces, and breaks a word by characters only when the word alone exceeds `maxWidth`.
- `fitLines(lines, maxLines, maxWidth, measure): string[]` keeps the lines that fit. If any are dropped, it trims the last kept line until `line + "…"` fits.
- The title wraps to at most `LAYOUT.titleMaxLines` (2) with the same ellipsis rule. The divider and body start are positioned from the actual title height.
- `maxWidth = VIDEO_CONFIG.width − 2 × LAYOUT.margin`. Body `maxLines` is derived from the space between the body top and `VIDEO_CONFIG.height − LAYOUT.margin`.
- HTML-entity decoding, currently duplicated for title and body, moves into one `decodeHtmlEntities` helper.

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

No route changes are needed for the storyboard redesign. `partialFailures` can now also contain `metadata`, `pullRequests`, and `releases`; `AnalysisProgress` lists these names as it does today.

---

### 7. Config Module (`src/config/output.ts`)

The single source of truth for all output constants. No other file may declare inline numeric or string literals for these values.

Exports `VIDEO_CONFIG` and `SLIDE_CONFIG` as frozen `const` objects. See `output-constants.md` for the full definition. The storyboard redesign adds `capabilitiesMaxItems`, `capabilityMaxWords`, `capabilitiesMaxOverlapRatio`, `maxFeatureSlides`, `featureMaxWords`, `maxEvolutionSlides`, `maxEvolutionItems`, `minEvolutionItems`, `changeContextMaxWords`, `relevanceMinTermLength`, and `maxFallbackHighlights`, and lowers `introMaxWords` to 120. Per output-constants.md §2.4, all `max*` slide values are ceilings.

---

## Data Models

```typescript
// Core domain types — src/types/index.ts

interface Commit {
  sha: string;
  author: string;
  timestamp: string;       // ISO 8601
  subject: string;         // first line of the message
  body: string;            // remainder, leading blank lines trimmed; "" when absent
  message: string;         // alias of subject, kept for existing callers
}

interface PullRequest {
  number: number;
  title: string;
  body: string;            // "" when absent; capped at MAX_CHANGE_BODY_CHARS
  labels: string[];        // lowercased label names
  mergedAt: string;        // ISO 8601; only merged PRs are retained
  isBot: boolean;
}

interface Release {
  name: string | null;
  tagName: string;
  publishedAt: string;     // ISO 8601
  body: string;            // release notes; "" when absent
}

interface RepoMetadata {
  description: string | null;
  topics: string[];
  stars: number | null;
  language: string | null;
  license: string | null;
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
  metadata: RepoMetadata | null;
  directoryTree: DirectoryNode[];
  readmeText: string | null;
  commits: Commit[];
  specDocs: SpecDocument[];
  pullRequests: PullRequest[];
  releases: Release[];
  partialFailures: string[];
}

type SlideType =
  | "intro"
  | "capabilities"
  | "run"
  | "architecture"
  | "howItWorks"          // replaces "spec"; now sourced from README or specs
  | "feature"
  | "evolution"
  | "change"
  | "highlight"
  | "conclusion";

type ChangeCategory = "Breaking Change" | "Feature" | "Bug Fix" | "Refactor";

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
  sizeWarning: boolean;
  completedAtMs: number | null;
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

`"spec"` is renamed to `"howItWorks"`. It is referenced only in `storyboard.ts` and `types/index.ts`; no frontend code branches on slide type.

---

## Security Constraints

These are enforced in code, not just documented:

1. **URL allowlist** — `RepositoryAnalyzer` validates the raw user URL against the regex before any network call; `owner` and `repo` tokens are extracted and used for all downstream URL construction. The raw URL string is never forwarded.
2. **Host allowlist** — every constructed URL is parsed and its `hostname` asserted against `{ api.github.com, raw.githubusercontent.com }` before fetch is called. The new metadata, pulls, releases, and spec-content requests all target `api.github.com`.
3. **No automatic redirects** — `fetch` calls use `redirect: "manual"`; any 3xx response is treated as an error.
4. **Path confinement** — temp file paths for rendered videos are built as `path.resolve(os.tmpdir(), sanitizedJobId + ".mp4")` and asserted to remain within `os.tmpdir()`.
5. **Response size cap** — all GitHub API response bodies are streamed and truncated at 10 MB. PR and release bodies are additionally capped at `MAX_CHANGE_BODY_CHARS` after parsing.
6. **Content escaping** — all text from GitHub (README, descriptions, topics, spec docs, commit messages, PR titles and bodies, labels, release names and notes, file names) is HTML-escaped centrally in `makeSlide` before it reaches any slide field (Req 3.11, Property 11).
7. **Spec path validation** — spec file paths come from the GitHub tree response and are untrusted. Each must match `^\.kiro/specs/.+\.md$`, contain no `.`, `..`, or empty segment, and is URL-encoded per segment before being placed in a `contents` URL. Paths are never used for local filesystem access.
8. **No execution** — README code blocks, PR bodies, and release notes are treated as text only. Nothing from the repository is executed or evaluated.

---

## Correctness Properties

### Property 1: URL Validation Is Server-Authoritative

For any URL submitted by a client, `RepositoryAnalyzer` re-validates it against the allowlist regex server-side before making any network call. Client-side validation is a UX optimisation only and is never trusted as the authority.

**Validates: Requirements 1.2, 1.4**

### Property 2: Output Constants Are Immutable at Runtime

For all render jobs and storyboard generation, `VIDEO_CONFIG` and `SLIDE_CONFIG` values exported from `src/config/output.ts` remain unchanged throughout execution. No module may mutate these objects or declare inline literals for governed values.

**Validates: Requirements 3.2, 4.1, 4.5**

### Property 3: Slide Ordering Invariant

For every generated storyboard before any user reordering, slide types appear in the order: overview → capabilities (if present) → run (if present) → architecture → how-it-works (if present) → key features → evolution timeline (if present) → notable changes → engineering highlights → conclusion. The run slide immediately follows capabilities when present, otherwise the overview.

**Validates: Requirements 3.1, 5.11**

### Property 4: Partial Extraction Does Not Abort the Pipeline

If any extraction step fails for a non-rate-limit reason, the remaining steps proceed and the result is returned with that step's name in `partialFailures`. If the tree step fails, the spec step is also recorded. A source that is legitimately empty (no PRs, no releases, no `.kiro/specs/`) yields an empty array and is never recorded as a failure.

**Validates: Requirements 2.6, 2.10**

### Property 5: Render Job Isolation

Each render job writes its output to a unique temp file path derived from a UUID. Concurrent render jobs cannot overwrite each other's output files.

**Validates: Requirements 4.7, 4.8**

### Property 6: Cancellation Is Time-Bounded

Calling `abort()` on an active render job guarantees that the ffmpeg process is terminated and the partial output file is deleted within `VIDEO_CONFIG.cancelTimeoutSeconds` (3 seconds) of the cancellation request.

**Validates: Requirements 4.8**

### Property 8: Content Is Never Fabricated

Every text fragment in a generated slide is either a substring (after plain-text reduction and truncation) of extracted repository data, or one of the fixed labels and templates listed in the Stage 5 table. Sections without a source produce no slides. A PR, release, or commit without a Change_Context produces a slide with no context line.

**Validates: Requirements 3.9, 5.2, 5.6, 6.4, 6.8, 7.7, 7.11, 7.12**

### Property 9: Slide Caps Are Ceilings

Feature slides never exceed `maxFeatureSlides`, evolution slides never exceed `maxEvolutionSlides`, and the total never exceeds `maxSlides`. Adding ineligible candidates to the input never changes the output's evolution slides. Ineligible candidates include bot PRs, `chore:`/`docs:` PRs, dependency bumps, patch releases, irrelevant PRs, and bug-fix commits. No slide's content duplicates another slide of the same type.

**Validates: Requirements 3.3, 3.12, 6.9, 7.1, 7.13**

### Property 10: Evolution Is Anchored to the Current Repository

When the anchor set is non-empty, every notable-change and engineering-highlight slide refers to an item whose title or Change_Context matches at least one Anchor_Term, and none has Change_Category "Bug Fix". When the anchor set is empty, there are no notable-change slides, and engineering-highlight slides are limited to `feat`-typed commits (no dependency wording), at most `maxFallbackHighlights` of them.

**Validates: Requirements 7.5, 7.6, 7.9, 7.13, 7.14**

### Property 11: Extracted Text Is Escaped for Every Slide Type

For an analysis fixture whose every text field contains `<`, `>`, `&`, `"`, and `'`, no slide of any type has a `title`, `body`, or `previewSummary` containing an unescaped occurrence of those characters originating from the input.

**Validates: Requirement 3.11**

### Property 12: Capabilities Are Not Redundant

The capabilities slide is present only when a capabilities source exists and the overlap ratio with Key_Features is ≤ `capabilitiesMaxOverlapRatio`.

**Validates: Requirements 5.3, 5.4, 5.5, 5.6**

### Property 13: Text Stays Within Slide Bounds

For every rendered slide, each line's measured width is ≤ `VIDEO_CONFIG.width − 2 × LAYOUT.margin`, no line falls below the bottom margin, explicit line breaks are preserved, and when content was dropped the last rendered body line ends with `…`.

**Validates: Requirements 4.15, 4.16**

### Property 14: History Never Defines Current Capabilities

The overview, capabilities, run, how-it-works, and feature slides, and the anchor set, are identical for two analyses that differ only in `commits`, `pullRequests`, and `releases`.

**Validates: Requirements 3.13, 7.14**

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
     ├─ repo_not_found      → HTTP 404, inline error below input   (from metadata step)
     ├─ rate_limit_exceeded → HTTP 429, banner: computed wait from headers
     ├─ request_timeout     → HTTP 504, inline error, retry prompt
     ├─ network_error       → HTTP 502, inline error, retry prompt
     └─ partial_data        → HTTP 200, warning banner listing skipped steps, continue
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

Missing optional content (no releases, no PRs, no features section) is not an error at any layer. It only shapes which slides are produced.

---

## Testing Strategy

### Fixtures

`tests/fixtures/` holds `RepoAnalysisResult` fixtures that represent the three repository shapes the storyboard must handle:
- **Kiro repo:** README with Features, How it works, and Installation sections; `.kiro/specs` requirements and design; releases; labeled PRs including bot, docs, bump, and bug-fix noise
- **README-only repo:** README with Features section, no specs, no releases, no PRs; commits only (normal relevance path)
- **Thin repo:** one-line README, no sections, no PRs or releases; mixed commits including `feat:`, `fix:`, `chore:`, and `Add …` subjects (empty-anchor fallback path)

Plus a hostile fixture whose every text field contains HTML metacharacters.

### Unit Tests

- **`tests/analyzer.test.ts`** — URL validation; metadata step as the `repo_not_found` source; commit subject/body mapping; PR mapping (merged-only, `isBot`, lowercased labels, body cap); release mapping (drafts dropped); 404 and `[]` for PRs, releases, and specs are empty results, not partial failures; spec selection (4-level paths found, requirements/design priority, path-ordered ties, cap of 6, > 1 MB skipped, invalid paths rejected, segments encoded); spec step recorded when tree fails; timeout and rate-limit paths.
- **`tests/storyboard.test.ts`** — per-section extraction and README → spec fallback for capabilities, how-it-works, and features; overview paragraph skips badges and headings and truncates at `introMaxWords`; "Usage" never feeds capabilities; overlap omission at, above, and below the ratio; described vs. name-only features and the summary slide under the cap; anchor tokenization, `GENERIC_TERMS` exclusion, and prefix matching; Significant_PR filters and category precedence; ranking; patch-release detection; timeline minimum, cap, and chronology; deep-dive exclusion of Bug Fix; release deep dives only when PR deep dives fall short; commit fallback, PR-reference dedup, and bug-fix exclusion; empty-anchor fallback (`feat:`/`feat(scope)!:` accepted; `fix:`, `docs:`, `chore:`, `feat(deps):`, `Add …`, and substring-only matches rejected; `maxFallbackHighlights` ceiling; no timeline from commits); history-invariance of current-state slides (Property 14); Change_Context stripping (comments, checklists, headings, trailers, code fences); ordering (Property 3); ceiling metamorphic tests (Property 9); anchoring (Property 10); escaping for every slide type (Property 11); existing run-slide tests with the new position.
- **`tests/renderer.test.ts`** — `wrapText` with a fake `measure` (explicit breaks, blank lines, long-word breaking, exact-fit lines); `fitLines` ellipsis behaviour; title max lines; existing duration, abort, and sweep tests unchanged.

### Integration Tests

- Full happy-path flow for each fixture shape: analysis (mocked at the fetch boundary) → storyboard → render (mocked renderer) → download.
- Partial-data path: PR or release step fails; storyboard still generates, evolution falls back.
- Error propagation: each `ApiError` code maps to the correct HTTP status and response shape.

### What Not to Test Here

- GitHub API behaviour (mocked at the HTTP client boundary in all tests).
- ffmpeg encoding correctness (tested via acceptance tests on a known slide fixture).
- Subjective quality of extracted text. Tests assert selection rules and bounds, not prose quality.

---

## Project Structure

```
kiro-repo-visualizer/
├── src/
│   ├── config/
│   │   └── output.ts              # VIDEO_CONFIG, SLIDE_CONFIG (sole source of constants)
│   ├── types/
│   │   └── index.ts               # Commit, PullRequest, Release, RepoMetadata, Slide, RenderJob, ApiError, etc.
│   ├── server/
│   │   ├── index.ts               # Express app entry point
│   │   ├── routes.ts              # Route definitions and top-level error handler
│   │   ├── cache.ts               # Analysis TTL cache
│   │   ├── analyzer.ts            # RepositoryAnalyzer (7 extraction steps)
│   │   ├── storyboard.ts          # StoryboardGenerator (5 stages)
│   │   └── renderer.ts            # VideoRenderer (canvas + ffmpeg, text layout)
│   ├── components/
│   │   ├── UrlInput.tsx           # Step 1 — URL form
│   │   ├── AnalysisProgress.tsx   # Step 2 — loading/partial-data state
│   │   ├── StoryboardPreview.tsx  # Step 3 — slide preview, reorder, remove
│   │   └── VideoExport.tsx        # Step 4 — progress bar, download, cancel
│   ├── hooks/
│   │   └── useRenderJob.ts        # React hook wrapping the SSE render stream
│   └── App.tsx                    # Top-level step router
├── tests/
│   ├── fixtures/                  # RepoAnalysisResult fixtures (Kiro, README-only, thin, hostile)
│   ├── analyzer.test.ts
│   ├── storyboard.test.ts
│   ├── renderer.test.ts
│   ├── integration.test.ts
│   ├── cache.test.ts
│   └── config.test.ts
├── .kiro/
│   ├── steering/
│   └── hooks/
└── package.json
```
