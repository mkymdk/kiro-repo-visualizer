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

**Step 8: selected-PR commit lookup (lazy, Req 2.11, 2.12).** `fetchSelectedPrCommits(owner, repo, prNumbers): Promise<PrCommitEvidence>` runs after analysis, only for the PR numbers the storyboard asks for.
- Endpoint: `GET /repos/{owner}/{repo}/pulls/{pull_number}/commits?per_page=100`, one page per PR. The URL is built from validated `owner`/`repo` tokens and a PR number checked to be a positive safe integer. The host is asserted as for every request.
- At most `MAX_SELECTED_PR_LOOKUPS` (3) requests, an analyzer module constant beside `MAX_SPEC_FILES`. Extra numbers are ignored. Duplicate numbers are fetched once. An empty list makes no request.
- Each lookup is independent. Any failure for a PR (timeout, non-2xx, rate limit, malformed JSON, redirect) leaves that PR out of the result and is logged server-side. The function never throws, so a lookup can never fail analysis or storyboard generation.
- Result: `Record<prNumber, string[]>` of commit SHAs exactly as GitHub returned them. For PRs with more than 100 commits only the first page is used. That evidence is still exact, just possibly incomplete, and the graph covers the rest where it can.

**Accessibility check (Req 1.4):** The metadata response is the authoritative accessibility signal. A 404, or a 403 that is not a rate-limit response, raises `repo_not_found`. This replaces the current inference from the tree step.

**Spec file selection (Req 2.3):**
1. From the unfiltered tree, keep blobs whose path matches `^\.kiro/specs/.+\.md$` (case-insensitive extension), whose `size` ≤ 1 MB, and whose path contains no `.` or `..` segment.
2. Sort: basename `requirements.md` or `design.md` first, then all others; ties broken by ascending path.
3. Take the first `MAX_SPEC_FILES` (6), an analyzer module constant alongside `MAX_README_BYTES`.
4. Fetch each file with every path segment passed through `encodeURIComponent`, and assert the host before fetching (Security Constraint 7).

**Normalization:**
- **Commit:** `subject` is the first line. `body` is the remainder with leading blank lines trimmed; trailer removal happens in the storyboard's Change_Context extraction. `message` is kept as an alias of `subject` for existing callers. `parents` is the list of parent SHAs from the same commits response (`parents[].sha`); `[]` when absent.
- **PullRequest:** only items with `merged_at` set. `labels` are lowercased names. `isBot` is true when `user.type === "Bot"` or the login ends in `[bot]`. `body` is capped at `MAX_CHANGE_BODY_CHARS` (10 000), since only its first sentence is used. `mergeCommitSha` is `merge_commit_sha` from the same pulls response, or `null`.

PR-to-commit association uses only these two fields, which the existing commits and pulls requests already return. It adds **no requests**, so the budget stays at a maximum of 12 per uncached analysis. The analyzer only carries the raw data; grouping happens in the storyboard (Stage 3b). The `per_page=50` commit window is unchanged, and Stage 3b treats it as a hard boundary.
- **Release:** drafts are dropped. `body` is capped at `MAX_CHANGE_BODY_CHARS`.
- **RepoMetadata:** `description`, `topics`, `stargazers_count`, `language`, and `license.spdx_id` (or `license.name`), each nullable.

**Request budget:**

| Phase | Requests | When |
|---|---|---|
| Analysis (steps 1–7) | 6 fixed + up to 6 spec files = **≤ 12** | Every uncached analysis |
| Selected-PR commit lookup (step 8) | **≤ 3**, one per Selected_PR that needs it | Only during storyboard generation, only for Selected_PRs whose membership the graph can't prove |
| **Total** | **≤ 15** per uncached analysis | |

Unauthenticated (60 requests per hour), that is about 4 uncached analyses per hour per IP in the worst case. The analysis cache and `GITHUB_PERSONAL_ACCESS_TOKEN` mitigate this. A cache hit costs 0 requests, including step 8, because the evidence is cached with the analysis.

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
| Capabilities (`capabilities`) | README section `Capabilities \| What it does \| What you can do \| Use Cases` → list items, else sentences | Spec user stories: the Action_Phrase of the `I want …` clause of `As a …, I want …, so that …` lines (a leading `**User Story:**` is stripped; see Semantic/story quality, B2a-1), document order | `capabilitiesMaxItems`, `capabilityMaxWords` | no source, or overlap > `capabilitiesMaxOverlapRatio` (see below) |
| Run (`run`) | README section `Install \| Installation \| Getting Started \| Setup \| Usage \| Quick Start \| Example \| Examples` (first match in document order; see Extraction quality, B4) | — | `runMaxSteps`, `runMaxWordsPerStep` | no match |
| Architecture (`architecture`) | Top-level tree, directories first (unchanged) | Placeholder text | — | never |
| How it works (`howItWorks`) | README section `How it works \| Architecture \| Design` → heading + sentences | Spec docs, `design.md` preferred: title, headings, sentences from design/architecture/decision sections, else the first substantive Explanatory_Prose run (see Semantic/story quality, B2a-2) | `specMaxHeadings`, `specMaxSentences` | no source |
| Key features (`feature`) | README section `Features \| Key Features \| Highlights` → list items parsed as `**Name** — desc`, `**Name**: desc`, `Name: desc`, or `Name - desc` | design.md `…Components…` section subheadings + first sentence; then `Requirement N: Title` headings (name only) | `maxFeatureSlides`, `featureMaxWords` | no source |

"Usage" belongs to the Run slide only and is never a capabilities heading.

**Key_Feature slides (Req 6.9):** Features that have a description get one slide each, in document order. Features without one are listed on a single summary slide ("Key features") placed after them. The total is capped at `maxFeatureSlides`. When described features already fill the cap, the summary is dropped. Name-only items never get individual slides, so 20 requirement titles produce one summary slide, not five thin ones.

**Capabilities/Features overlap (Req 5.5):** Normalize both lists (lowercase, strip punctuation, collapse whitespace). A Capability matches when its normalized text contains, or is contained in, a normalized Key_Feature name or description. If `matches / capabilities > capabilitiesMaxOverlapRatio`, the Capabilities slide is omitted, but its items still feed the anchor terms.

#### Stage 2: Anchor terms

`buildAnchorTerms(capabilities, features, howItWorksHeadings): Set<string>`
- Tokenize on non-alphanumerics, lowercase, and keep tokens with length ≥ `relevanceMinTermLength`.
- Drop tokens in `GENERIC_TERMS`, a fixed module-level list of words that would make everything "relevant". It includes common English function words (`with`, `from`, `that`, `this`, `into`, `your`, `using`, `when`, `what`, `which`), change verbs (`added`, `adds`, `update`, `updates`, `change`, `changes`, `improve`, `implement`, `implementation`, `refactor`, `redesign`, `support`, `supports`, `allow`, `allows`, `make`, `makes`), and structural nouns (`feature`, `features`, `system`, `user`, `users`, `architecture`, `design`, `overview`, `usage`, `works`, `project`, `repository`).
- Drop Calendar_Terms (`isCalendarTerm`; see Extraction quality, B5). This list is separate from `GENERIC_TERMS`.
- Match rule: `a === b || a.startsWith(b) || b.startsWith(a)`, so "render" matches "renderer".

`isRelevant(text, anchors)` tokenizes `text` the same way and returns true on any match.

Anchor terms come only from current-state content. Commits, PRs, and releases never contribute anchors or current-state slide content (Req 3.13).

**Empty anchor set (thin or commit-only repositories, Req 7.14, 7.23–7.25):** When the README and specs yield no capability, feature, or how-it-works terms, the Anchor_Term relevance test cannot be satisfied. Rather than discard already-fetched, independently-significant evidence, the **Empty_Anchor_Evolution_Fallback** (Q2) applies for notable-change slides: Significant_PRs (non-"Bug Fix", already filtered by Req 7.1) and non-patch Releases with a Change_Context become eligible, ranked and allocated exactly as Req 7.3/7.5/7.6 define. The commit path is unchanged: the narrow `feat`-only Engineering_Highlight fallback (7.14) still applies, with no PR/release relevance borrowed into it. Non-patch releases still appear on the timeline as before, and in the empty-anchor case a release entry additionally shows its cleaned Change_Context (7.25). The fallback never feeds Capabilities, Key_Features, or anchors, and it never changes behavior when anchors exist. See "Empty-anchor evolution (Q2)" below.

#### Stage 3: Evolution candidates

`extractChangeContext(text)` removes HTML comments (multi-line), task-list lines (`- [ ]`, `- [x]`), heading lines, fenced code blocks, and trailer lines (`^[A-Za-z][A-Za-z-]*: .+$`). It applies `toPlainText`, takes the first sentence, and truncates to `changeContextMaxWords`. It returns `null` when nothing remains.

**Performance changes (B2b, Req 7.2, 7.9).** `perf` joins the recognized conventional types mapped to `Refactor`: `categoryFromTitle` returns `Refactor` for `perf:`/`perf(scope):` and `Breaking Change` for `perf!:`/`perf(scope)!:`. The `!`→Breaking rule applies **only** to a recognized conventional type (`feat`, `fix`, `refactor`, `perf`); an unknown `type!:` (e.g. `wibble!:`) is no longer promoted to Breaking by the bang alone — it falls through to keyword matching like any other title. The `performance` and `perf` PR labels map to `Refactor` on the label path, mirroring the existing `refactor` label. `HIGHLIGHT_RE` gains `perf` so conventional `perf:` commits can be Engineering_Highlights. No new `ChangeCategory`, no change to `CATEGORY_RANK` or allocation; `perf` evidence ranks exactly as `Refactor`.

| Candidate | Eligibility | Category | Order |
|---|---|---|---|
| Significant_PR (7.1) | `!isBot`; title not `^(chore\|docs\|ci\|style\|test\|build)(\(.+\))?!?:`; no `bump\|deps\|dependency\|dependencies`; category assignable | labels → conventional prefix → first keyword (7.2) | Breaking Change > Feature > Bug Fix > Refactor, then newest merge |
| Timeline PR (7.4) | Significant_PR ∧ relevant (title or context) | as above | rank |
| Deep-dive PR (7.5) | Timeline PR ∧ category ≠ Bug Fix | as above | rank |
| Timeline release (7.4) | not a Patch_Release (`^v?\d+\.\d+\.(\d+)` with group > 0) | "Release" | newest first |
| Deep-dive release (7.6) | timeline release ∧ Change_Context ≠ null ∧ relevant | "Release" | newest first |
| Engineering_Highlight (7.9, anchors ≠ ∅) | subject keyword match ∧ category ≠ Bug Fix ∧ relevant ∧ allowed by the Change_Group rule (7.15) | keyword mapping | commit order |
| Fallback highlight (7.14, anchors = ∅) | subject matches `^feat(\([^)]*\))?!?:` ∧ no `bump\|deps\|dependency\|dependencies` ∧ allowed by the Change_Group rule (7.15) | "Feature" | most recent first, ≤ `maxFallbackHighlights` |

Bug-fix PRs can appear as one-line timeline entries when relevant, but never consume a deep-dive slide. Bug-fix commits are never used.

#### Stage 3b: Change_Groups (one logical change, one detailed slot)

`buildChangeGroups(commits, pullRequests): ChangeGroups` is a pure function of graph data. It never reads commit messages, and it only groups commits it can prove belong together from the fetched window (Req 7.17).

1. Index the window: `sha → parents` for the 50 fetched commits.
2. `walk(start)` follows parent links through commits **in the window only** and returns `{ reached, complete }`. `complete` is false as soon as the walk meets a parent SHA that is not in the window. Commits with no parents (repository roots) end a walk without making it incomplete.
3. For every Merge_Commit `M` (≥ 2 parents), compute its candidate members as follows. Then assign them, processing merge commits **descendants first**: in decreasing order of the number of window commits reachable from `M` (a descendant always reaches strictly more than any merge commit it contains), with ascending SHA as a deterministic tie-break. A merge commit that an earlier (outer) merge has already claimed is skipped as a group owner. This order comes from the commit graph alone; window listing order and commit dates are never used.
   - `first = walk(parents[0])`, `branch = walk(parents[1])`
   - If `first.complete`: group = `{M} ∪ (branch.reached \ first.reached)`, minus commits already assigned.
   - Otherwise: group = `{M}` only. Non-ancestry of the first parent can't be proven, because a commit reachable from the second parent might be reached from the first parent through commits outside the window.
   - A commit keeps its first assignment, so nested merges never claim the same commit twice.
4. For every merged PR whose `mergeCommitSha` is in the window: if it is a Merge_Commit, step 3's group gets the PR number. If it is a single-parent commit (squash, or the tip of a rebase), the group is `{that commit}` with the PR number.
5. Every remaining commit is its own group.
6. A PR whose `mergeCommitSha` is `null` or outside the window has no known group (Req 7.16).

Selection rule (Req 7.15), applied in Stage 4:
- `blockedGroups` starts as the groups of the PR deep dives emitted so far.
- A commit is a highlight candidate only if it is **not** a Merge_Commit, its group is not in `blockedGroups`, and no earlier highlight used the same group.
- When a highlight is emitted, its group is added to `blockedGroups`.
- Timeline entries never add to `blockedGroups`. A PR can be both a timeline line and a deep dive.
- The old subject-based `(#N)` / `Merge pull request #N` exclusion is removed. It is not kept as a fallback.

| Merge style / situation | Graph membership (Stage 3b) | Step 8 lookup | Live evidence |
|---|---|---|---|
| Merge commit, first-parent ancestry inside the window | Merge commit + every provable branch commit | Not needed, so not requested | This repo, PR #9 → 4 commits (21 commits total) |
| Merge commit, first-parent ancestry leaves the window | Merge commit only | **Requested if selected.** Branch commits keep their SHAs on the base branch, so the returned SHAs match exactly | `rails/rails` #58882, #58883: second parent = PR head, 1/1 SHAs on base; `systemd/systemd` #43827: 4/4 SHAs on base |
| Squash | The single squashed commit (`mergeCommitSha`) | Not requested: the endpoint returns the pre-squash commits, which aren't on the base branch | `chalk/chalk` #689: 0/1 SHAs on base |
| Rebase | The last rebased commit (`mergeCommitSha`) | Not requested: rebasing rewrites SHAs, so returned SHAs don't match the base branch | Single-parent merges on `systemd/systemd` and `chalk/chalk`: 0/1 SHAs on base. A multi-commit rebase was not observed (F3) |
| PR data unavailable | Merge_Commit topology alone (steps 3 and 5) | No PR numbers, so no lookup | Pulls step failed |

**Known limitations (accepted):**
- **50-commit window, graph only.** Graph-proven membership stops at the window. Merge commits with first-parent ancestry outside it group only themselves (live: every merge commit in `rails/rails` and `kubernetes/kubernetes`). For Selected_PRs, Stage 3c closes this gap with exact GitHub evidence. For commits of PRs that aren't selected, it stays: two commits from the same unselected merge-style PR may still each get a highlight (F2).
- **Rebase merges.** Only the last rebased commit is linked to its PR. The PR-commit endpoint can't help because rebasing rewrites SHAs (Req 7.18, F3).
- Neither gap is compensated by commit-message inference, commit dates, or listing order.

#### Stage 3c: Selected PRs and exact evidence (Req 2.11, 2.12, 7.15)

The storyboard stays pure. It is generated in two passes around one lazy analyzer call:

1. `selectDeepDivePullRequests(result): number[]` (pure) runs Stage 2 anchors and the Stage 3/4 PR ranking and returns the PR numbers that get deep dives. It never reads evidence.
2. `prsNeedingEvidence(result, selected): number[]` (pure) keeps only Selected_PRs whose `mergeCommitSha` is a Merge_Commit in the window with an incomplete first-parent walk. Squash, rebase, graph-proven merges, and PRs with an unknown merge commit need no lookup.
3. The pipeline calls `fetchSelectedPrCommits` with that list. If the list is empty, there is no request.
4. `generateStoryboard(result, evidence?)` builds the slides. A commit belongs to a Selected_PR if it is in the PR's graph group **or** its SHA is in that PR's evidence. Evidence SHAs that aren't in the window are ignored, and evidence for non-selected PRs is ignored. Without evidence the result equals graph-only behavior.

Deep-dive selection never depends on evidence, so passes 1 and 4 select the same PRs. The pipeline stores the evidence with the cached analysis, so later storyboard requests in the TTL window make no lookups.
#### Stage 4: Evolution allocation (ceiling, not target)

```
remaining = maxEvolutionSlides
timeline  = (eligible releases newest-first, then timeline PRs by rank)
              .slice(0, maxEvolutionItems).sortBy(date asc)
if timeline.length >= minEvolutionItems: emit Evolution_Timeline; remaining -= 1
groups  = buildChangeGroups(commits, pullRequests)
blocked = {}
for pr of deepDivePRs      while remaining > 0: emit change(pr);      blocked += group(pr) ∪ evidence(pr); remaining -= 1
for rel of deepDiveReleases while remaining > 0: emit change(rel);    remaining -= 1
candidates = commits where not merge commit and group ∉ blocked and sha ∉ blocked
highlights = anchors.size > 0
  ? relevantHighlights(candidates)
  : fallbackHighlights(candidates)
for c of highlights         while remaining > 0 and group(c) ∉ blocked:
                              emit highlight(c); blocked += group(c); remaining -= 1
```

`maxFallbackHighlights` still caps the fallback path, and it counts after the group rule is applied.

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

#### Extraction quality (Req 3.14, 5.7, 5.12, 7.19–7.22)

Six narrow fixes, all inside `storyboard.ts`. Each policy is its own small pure helper with its own tests; there is no shared `sanitizeText()`. The analyzer, `pipeline.ts`, routes, and GitHub request counts are unchanged.

| Item | Helper (new or changed) | Called from | Stage |
|---|---|---|---|
| B1 | `parseSemanticVersionTag(tag)` (new), `isPatchRelease` (changed) | `planEvolution` | release classification |
| B2 | `cleanReleaseNotes(body)` (new) | release loop in `buildEvolutionSlides` → `extractChangeContext` | before Change_Context |
| B3 | `isDocsCommit(subject)` (new) | `selectHighlightCommits`, before `take()` | highlight eligibility |
| B4 | `RUN_HEADING_RE` (changed), `headingKey` (changed) | `buildRunSlide` → `findSection` | heading match |
| B5 | `isCalendarTerm(token)` (new) | `relevanceTokens` | relevance tokenization |
| B6a | `stripEmojiShortcodes(text)` (new) | `makeSlide`, `headingKey`, `releaseTitle`, B6b | slide output |
| B6b | `overviewKey(text, repo)` (new), `dedupeParagraph(paragraph, description, repo)` (new) | `buildIntroSlide` | overview assembly |

**B1. Patch-release classification (Req 7.19, Glossary Semantic_Version_Tag / Patch_Release).**
- *Current failure:* `isPatchRelease` matches `^v?(\d+)\.(\d+)\.(\d+)` at the start of the tag only, so `release-v1.2.3` and `yargs-parser-v20.2.9` count as milestones, while `1.2.3.4` and `2024.01.15` count as patches. Classification lives only in `storyboard.ts`; the analyzer drops drafts and nothing else, and `Release` has no `prerelease` field.
- *Rule:* `parseSemanticVersionTag(tag)` returns `{ major, minor, patch, prerelease, build } | null` in four conservative steps, with no prerelease-label vocabulary:
  1. **Boundary:** strip an optional prefix that ends in a separator, then an optional `v`/`V`, using `^(?:.*[-_/@])?[vV]?` anchored at the start. What remains is the version candidate.
  2. **Core:** the candidate must begin with `X.Y.Z`, each of `X`, `Y`, `Z` being `0|[1-9]\d*` (no leading zeros).
  3. **Prerelease/build:** any text after the core must be a complete SemVer suffix — an optional `-` prerelease (dot-separated identifiers of `[0-9A-Za-z-]`, numeric identifiers without leading zeros) and an optional `+` build (dot-separated identifiers of `[0-9A-Za-z-]`) — and nothing else. The whole candidate is anchored with `$`.
  4. **Trailing text:** because step 3 is anchored, any disallowed trailing text (`node-1.2.3-compat`, `support-1.2.3x`, `1.2.3.4`) fails the parse.

  Full pattern after the boundary strip: `^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$`. `isPatchRelease(release)` is `parseSemanticVersionTag(release.tagName) !== null && parsed.patch > 0`; only the core patch component decides exclusion.
- *Prerelease:* decided by the core, so `v1.2.3-rc.1` and `v1.2.3-api` are patches (excluded), while `v2.0.0-beta.1` and `v1.2.0-rc.1` are not (kept). Build metadata never affects the decision.
- *False-positive protection:* the version must sit at the permitted boundary and the suffix is fully anchored, so `node-1.2.3-compat`, `support-1.2.3x`, `1.2.3.4`, and `2024.01.15` (leading-zero component) are not semantic versions and stay eligible. Names and notes are never inspected. No SemVer dependency is added; the project has none and this parser needs none.
- *Fallback:* a tag that doesn't parse is a milestone release (eligible), as a non-semver tag is today.
- *Accepted limit:* a calendar-style version with no leading zeros (`2024.1.15`) satisfies the tag shape and is classified as a version; see Accepted limitations.

**B2. Release-note cleanup (Req 7.20).**
- *Current failure:* release deep dives use `extractChangeContext(release.body)`, which keeps list items (marker removed) and joins every kept line. GitHub-generated notes (`* Add x by @u in https://…/pull/12`) therefore become one run-on sentence full of URLs, `@user in` attributions, hashes, and `(#12)` references, cut at `changeContextMaxWords`.
- *Rule:* `cleanReleaseNotes(body): string` runs before `extractChangeContext`, line by line over `scanLines` output, in this order:
  1. Skip the bodies of sections whose `headingKey` is `New Contributors`, `Contributors`, `Full Changelog`, or `Checksums` (case-insensitive), up to the next heading of the same or higher level. Skip any line whose plain text starts with `Full Changelog`.
  2. Replace Markdown links `[text](url)` and reference links with their text.
  3. Remove the GitHub attribution suffix `by @login` with an optional following `in <url-or-#ref>` at the end of a line.
  4. Remove autolinks `<https://…>` and bare `https?://\S+` URLs, together with an immediately preceding `in`, `at`, `see`, or `via`.
  5. Remove standalone commit hashes: whole words of 7–40 hex characters containing at least one digit and at least one letter `a–f`, including a wrapping pair of backticks or parentheses.
  6. Remove parenthesized reference lists: `(#12)`, `(#12, #13)`, `(owner/repo#12)`, `(GH-12)`.
  7. Drop empty `()`/`[]`, collapse whitespace, trim leading/trailing `-`, `:`, `,`, and drop lines with no letters left.
  8. If any remaining line is prose (not a list item), keep prose lines only; otherwise keep only the first remaining list item.
- *False-positive protection:* inline references in prose (`Fixes a crash introduced in #123.`), versions, numbers, `@mentions` outside the generated suffix, and identifiers such as `sha256` or `0x1f2e3d4c` are kept. Hex-only English words (`deadbeef`, `cafe`) lack a digit and are kept. Only release notes are cleaned; PR and commit bodies keep today's `extractChangeContext` behavior.
- *Fallback:* when nothing remains, the release has no Change_Context, so no release deep dive is generated (Req 7.6). The timeline entry (title only) is unaffected.

**B3. Documentation-only commits (Req 7.21).**
- *Current failure:* on the relevance path, `HIGHLIGHT_RE` matches substrings anywhere, and `categoryFromTitle("docs: add guide")` falls through to the keyword `add` → Feature, so `docs:` commits fill highlight slots. `docs!:` becomes Breaking Change. The empty-anchor fallback already accepts only `feat`.
- *Rule:* `isDocsCommit(subject)` is `/^\s*docs(\([^)]*\))?!?:/i`. `selectHighlightCommits` rejects such commits on both paths **before** `take()`, so a docs commit never claims its Change_Group.
- *False-positive protection:* only the conventional `docs` type at the start of the subject. `feat: generate docs site`, `Add docs command`, `docsite: …`, and `doc: …` are not docs commits. PR and release eligibility (Req 7.1) are unchanged, and a PR is never affected by the type of its commits.
- *Fallback:* none needed; other commits fill the slot.

**B4. Run headings (Req 5.7, Glossary Run_Instructions).**
- *Current failure:* `RUN_HEADING_RE` is `^(installation|getting started|setup|usage|quick start)\b`, so `Install`, `Example`, and `Examples` are missed. `headingKey` strips leading emoji and punctuation but not a leading shortcode, so `:package: Installation` fails.
- *Rule:* `RUN_HEADING_RE = /^(install|installation|getting started|setup|usage|quick start|examples?)\b/i`, tested against the existing normalized `headingKey`, which becomes `stripEmojiShortcodes` → strip leading non-alphanumerics → strip trailing colon/space. Heading text is already plain text (`toPlainText` removes `**`, links, and code).
- *Eligible content (unchanged rule, Req 5.8):* the section body runs to the next heading of the same or higher level, so subsections are included. The first fenced code block's non-blank lines are preferred; otherwise the non-blank, non-fence lines. Capped at `runMaxSteps` and `runMaxWordsPerStep`.
- *Selection:* the first matching section in document order (Req 5.9, unchanged).
- *False-positive protection:* whole-word prefix match only, so `Installing`, `Instance`, and `Exampleapp` don't match. Other `findSection` callers share `headingKey`; the shortcode strip only adds matches for shortcode-prefixed headings.
- *Fallback:* no match → no Run slide (Req 5.10).

**B5. Calendar terms (Req 7.22, Glossary Calendar_Term).**
- *Current failure:* `relevanceTokens` keeps any token of ≥ `relevanceMinTermLength` characters, so `2024`, `january`, `march`, and `sept` become anchors or relevance evidence, and prefix matching lets `2024` match `20240115`.
- *Rule:* `isCalendarTerm(token)` is true for `/^(19|20)\d{2}$/` and for `CALENDAR_TERMS`: `january … december`, plus `jan, feb, mar, apr, may, jun, jul, aug, sep, sept, oct, nov, dec`. Abbreviations shorter than `relevanceMinTermLength` are listed anyway, so the rule does not depend on that constant. `relevanceTokens` drops these tokens, which covers anchors and candidates in one place. `GENERIC_TERMS` is unchanged and kept separate.
- *False-positive protection:* tokens are alphanumeric runs, so `http2`, `es2022`, `v2024`, `1080p`, `ipv6`, and `base64` survive. Numbers outside 1900–2099 (`8080`, `3000`) survive. Known limit: `2048` or `2049` written standalone is treated as a year.
- *Fallback:* if every token is a calendar term, the text has no relevance evidence, the same as generic-only text today.

**B6a. Emoji shortcodes (Req 3.14, Glossary Emoji_Shortcode).**
- *Current failure:* no emoji handling exists. `:muscle:` reaches titles, bodies, and previews verbatim.
- *Rule (strip, no mapping):* `stripEmojiShortcodes(text)` removes every match of `(?<![A-Za-z0-9:]):(?:[a-z0-9_+-]*[a-z][a-z0-9_+-]*|\+1|-1):(?![A-Za-z0-9:])`, collapses the spaces left behind on each line, and keeps line breaks.
  - **Code-block exception:** stripping is not applied centrally in `makeSlide` to literal fenced-code content, because that would modify commands and examples. `buildRunSlide` instead marks whether each step came from a fenced code block; code-block steps are passed to `makeSlide` as already-literal lines that `makeSlide` does not re-strip, while the Run title and prose-fallback steps are stripped. Concretely, `makeSlide` gains an optional `literalBody` flag (default false); when set, the body is escaped but not shortcode-stripped. All other slide types strip title, body (dropping lines left empty or only a `•` marker), and preview before escaping.
  - It is also applied in `headingKey` (B4), in `releaseTitle` before the tag fallback (so a name that is only `:rocket:` falls back to the tag), and inside B6b's comparison key.
- *Why strip:* no emoji facility exists, mapping would need a table or dependency, and Unicode emoji may not render on the canvas.
- *False-positive protection:* the lookarounds keep `10:30:45`, `2001:db8::1`, `a:b:c`, and `std::vector` unchanged, and uppercase `:Note:` is not a shortcode.
- *Fallback:* a title emptied by stripping keeps its fixed prefix (for example `Feature:`). No text is ever substituted.

**B6b. Overview duplicates (Req 5.12).**
- *Current failure:* `buildIntroSlide` drops the README paragraph only when `normalize(paragraph) === normalize(description)`, comparing the already-truncated paragraph. A paragraph that repeats the description as its first sentence, prefixes it with the repository name, or differs only by a shortcode is shown twice.
- *Rule:* `overviewKey(text, repo)` takes `stripEmojiShortcodes(toPlainText(text))`, removes an exact leading repository name (case-insensitive, literal) only when it is immediately followed by structural punctuation `:`, `-`, `–`, `—`, or `,`, and then applies `normalize`. There is no `is` lead-in and no other wording transform, so `chalk is a styling library` keeps the word `is`, and `chalk makes …` keeps its first word. `dedupeParagraph` splits the untruncated paragraph with the existing sentence splitter and drops each sentence whose key equals the key of the whole description or of any description sentence. The remaining sentences are joined and then truncated to `introMaxWords`. An empty result omits the paragraph.
- *Why no threshold:* exact equality of normalized sentences covers case, punctuation, Markdown, whitespace, shortcodes, and a `repo:`-style lead-in without a tuning constant. No edit distance, token-overlap threshold, embeddings, LLM similarity, or fuzzy matching is used. The bias is intentionally toward false negatives (keeping a sentence) rather than collapsing distinct statements.
- *False-positive protection:* a sentence must equal a description sentence in full. A sentence that adds meaningful words is kept, so `chalk is a styling library` and a bare `A styling library` description are not collapsed (accepted limit).
- *Fallback:* without a description or paragraph, the existing overview rules apply (Req 5.1, 5.2).

**Accepted limitations (this cycle).**
- B1: a calendar-style tag with no leading zeros that otherwise satisfies the tag shape (for example `2024.1.15`) is classified as a semantic version, and as a patch when its third component is above 0.
- B5: a standalone numeric token in the configured year range (1900–2099), such as `2048` or `2049`, is treated as calendar noise even when it is a meaningful technical value. Numbers outside that range and mixed alphanumeric terms (`es2022`, `http2`, `1080p`) stay eligible. No generic numeric classification is introduced.
- B6b: deduplication is deterministic normalized equality only. Two sentences that differ by meaningful words are both kept, so `chalk is a styling library` is not collapsed into a bare `A styling library` description. This false-negative bias is intentional.

#### Empty-anchor evolution (Q2, Req 7.23–7.25)

*Problem (from the real-repo review):* for a repository with **no Anchor_Terms** (no README capabilities/features/how-it-works, no specs — common for small libraries like `slugify`), `planEvolution`/`buildEvolutionSlides` discard evidence they already hold. The pipeline computes everything correctly, then the Anchor_Term relevance test rejects it:
- `relevantPrs = ranked.filter((r) => isRelevant(…, anchors))` → with empty `anchors`, `isRelevant` returns false for every PR (its first line is `if (anchors.size === 0) return false`), so all Significant_PRs are dropped;
- the release deep-dive loop requires `isRelevant(title+context, anchors)` → every release is skipped;
- the timeline shows releases as `date · Release · tag` with no body, so `slugify` reads as bare `Release · vX` lines.

Observed `slugify` data: all non-patch releases have usable cleaned context (`v3.0.0` → "Require Node.js 20", `v2.2.0` → "Add preserveCharacters option", `v1.1.0` → "Add support for empty separator"), and 16 PRs rank as Significant — all currently suppressed.

*Why not `anchors.size === 0 ⇒ isRelevant true`:* `isRelevant` is also used to build `relevantPrs` for the **timeline** and could be reused elsewhere; flipping it globally would admit arbitrary evidence and couple unrelated consumers. The fallback is local to evolution planning only.

*Design:* introduce the eligibility explicitly in `planEvolution`, keyed on `anchors.size === 0`:
- `relevantPrs` becomes: if anchors exist, `ranked.filter(isRelevant)` (unchanged); else `ranked` as-is (already filtered by `rankSignificantPullRequests`: not bot, not `MAINTENANCE_TYPE_RE` i.e. `chore|docs|ci|style|test|build`, not `DEPENDENCY_WORD_RE`, and has a non-null Change_Category). `deepDives` still drops "Bug Fix" and still slices to the remaining-slot count — unchanged downstream.
- the release deep-dive loop's guard becomes `context && (anchors.size === 0 || isRelevant(title+context, anchors))`. Patch exclusion, newest-first ordering, `cleanReleaseNotes`, `extractChangeContext`, and the slot ceiling are untouched.
- the timeline builder, in the empty-anchor case only, appends the release's cleaned Change_Context to its entry text: `tag — <context>` (truncated to `changeContextMaxWords`), computed from the already-available `release.body`. Releases without context stay `tag` only. When anchors exist, the timeline string is byte-identical to today.
- the commit path (`selectHighlightCommits`) is **not touched**: the `feat`-only empty-anchor fallback (7.14) is unchanged, and Selected_PRs still block their Change_Group members (7.15), so a PR deep-dive and a commit highlight can't duplicate the same change.

*Anchored-repository invariance:* every change is inside an `anchors.size === 0` branch (or an `|| anchors.size === 0` disjunct that is false when anchors exist). For `anchors.size > 0`, `relevantPrs`, the deep-dive guard, the timeline string, highlight selection, allocation, caps, and Change_Groups are evaluated by the identical expressions as before. This is asserted as Property 29, not just observed on a fixture.

*PR-vs-release duplication:* handled by existing structure — PR deep dives are allocated first, releases fill remaining slots, and Change_Group membership (7.15) prevents a Selected_PR's commits from also becoming highlights. **No PR-vs-release deduplication is added, not even exact-equality:** a PR and a release are structurally different evidence, and equal display text is not proof of the same Change_Group. A release and a PR describing the same change may both appear (as they can today for anchored repos). If real output later shows harmful duplication, it is recorded as a separate quality issue.

*Timeline context presentation (Decision 3):* implemented locally by changing only the release timeline entry's **title string** produced inside `storyboard.ts` (the `TimelineEntry.title` becomes `tag — context` in the empty-anchor case). The shared `TimelineEntry`/`Slide` types are **not** expanded with a separate context field. If a type or any other production file turns out to be required, stop and report before expanding scope.

*Context provenance (Property 30):* the displayed release context is exactly `extractChangeContext(cleanReleaseNotes(release.body))` truncated to `changeContextMaxWords`. It is not required to be a literal substring of the raw body, since that pipeline intentionally transforms source text (links reduce to link text; URLs/references/hashes are removed). No context is generated or rewritten outside that pipeline.

*No new requests, no new constants:* all inputs (`releases`, `pullRequests`, `commits`) are already fetched; `changeContextMaxWords` is the existing governed cap. Expected production change: `storyboard.ts` only (`planEvolution`, the release loop and timeline builder in `buildEvolutionSlides`).

#### PR deep-dive context sanitation (Req 7.26)

*Problem (from the real-repo review):* PR deep-dive bodies pass through `extractChangeContext(pr.body)` without the URL/reference cleanup that release notes receive via `cleanReleaseNotes`. On anchor-less repos (which now surface PR deep-dives, Q2), this exposes structural GitHub metadata — slugify PR #46's body begins `Closes https://…/issues/37 …`.

*Two representations (the regression boundary):* `RankedPullRequest.context = extractChangeContext(pr.body)` is computed once in `rankSignificantPullRequests` and is used **both** for relevance (`isRelevant(title + context, anchors)` in `planEvolution`) **and** for the deep-dive body. Sanitizing it in place would change relevance for anchored repos. So we add a **second** field used for display only:
- `context` (unchanged): relevance, significance, ranking, category, timeline eligibility, Change_Group, allocation — all keep using it.
- `displayContext = extractChangeContext(cleanPullRequestBody(pr.body))`: used only as the deep-dive body (the `change` slide for a PR).

`displayContext` is computed in the same place as `context` so no call site changes selection. The deep-dive loop reads `r.displayContext` instead of `r.context`; nothing else changes.

*`cleanPullRequestBody(body)` — structural only, no prose rewriting:* operates line by line over `scanLines` output (so fenced-code and HTML-comment handling matches `extractChangeContext`'s later pass), removing a line **only** when its sole meaningful content is structural metadata:
- a URL-only line (`^<url>$` after trimming, including an autolink `<url>`);
- an issue/PR-reference-only line (`^#\d+$`, `^owner/repo#\d+$`, `^GH-\d+$`, or a comma-separated list of these);
- an issue-closing line: `^(close[sd]?|fix(e[sd])?|resolve[sd]?)\b` followed only by a URL and/or issue/PR references (this is the slugify #46 case; `extractChangeContext` already drops `Closes #NN` but not `Closes <URL>`);
- a standalone commit-hash line, using the same conservative hash rule as `cleanReleaseLine` (7–40 hex with at least one digit and one `a–f` letter).

Lines that are prose keep their URLs/references/hashes intact (so `See https://x for details` and `Fixes a bug introduced in #123.` are untouched). Markdown links keep their visible text through the existing `toPlainText` in `extractChangeContext`. The function does **not** reorder, score, or select sentences; after cleanup, `extractChangeContext` runs exactly as today (first sentence, truncation).

*Why not `cleanReleaseNotes`:* it is section/bullet-oriented and, on PR prose, orphaned the `Closes` keyword and still kept the rambling sentence — strictly worse. PR bodies get their own narrow cleaner. Release cleaning is untouched; if substantial unavoidable duplication appears, stop and report before refactoring release code.

*Clean-body invariance:* when `cleanPullRequestBody(body)` removes no targeted line, its output equals the input and `displayContext === context`, so the PR deep-dive slide is byte-identical to today. An anchored repo whose PR bodies are clean is therefore unchanged; an anchored repo with a genuinely noisy PR body gets the display fix while its relevance/selection (which use `context`) stay identical.

*Out of scope (accepted limitations):* rambling / wrong-first-sentence selection (slugify #57) — no sentence scoring, no "prefer last/`Adds`/`This PR`", no semantic/LLM summary; raw Unicode emoji — preserved, only recognized `:shortcode:` emoji are stripped (B6a, in `makeSlide`); bare URLs embedded in prose — preserved.

*No new requests, no new constants, `storyboard.ts` only:* `pr.body` is already fetched; the new field and helper live in `storyboard.ts`.

#### Semantic/story quality (Cycle B2a, Req 5.4, 5.13, 6.3, 6.10)

Two narrow fixes, both inside `storyboard.ts`. No analyzer, config, GitHub-request, classification, ordering, slide-cap, or Change_Group change.

| Item | Helper (new or changed) | Called from | Stage |
|---|---|---|---|
| B2a-1 | `userStoryActionPhrase(clause)` (new) | `extractCapabilities` (spec-story branch only) | Stage 1 capabilities |
| B2a-2 | `isExplanatoryProse(line)` (new), `specExplanatoryProse(docs)` (new) | `extractHowItWorks` spec fallback | Stage 1 how-it-works |

**B2a-1. Capability phrasing (Req 5.4, 5.13).**
- *Current failure:* `extractCapabilities` captures the raw "I want" clause via `USER_STORY_RE` and only strips a leading `to`. A story like "As a User, I want the System to automatically analyze a repository, so that …" yields `The System to automatically analyze a repository`, which reads as a fragment. All seven user stories in `requirements.md`, and two of three in the kiro fixture, use this `I want <subject> to …` form.
- *Grammar (closed, no noun-phrase guessing):* `userStoryActionPhrase(clause)` receives the text already captured by `USER_STORY_RE` (everything after "I want", before "so that"). It recognizes exactly two shapes:
  1. a leading `to ` → the remainder is the Action_Phrase (today's behavior, kept);
  2. a leading `System_Subject` followed by ` to ` → the remainder after that `to` is the Action_Phrase. `SYSTEM_SUBJECTS` is a conservative, evidence-based set with exactly two members: `the system` and `the video`, matched case-insensitively at the very start, immediately followed by ` to `. (`the application`, `the app`, `the tool`, `the service`, `the website` are deliberately excluded — no current fixture or spec uses them.)

  Any other clause (plain noun phrase, unrecognized subject such as `the application`/`the parser` before `to`, or no `to`) is returned unchanged. The result is capitalized and loses a trailing `.`/`,`/`;`, exactly as now.
- *Why a closed subject set, not "noun phrase before to":* stripping any text before `to` changes meaning — "I want files to sync" would wrongly become "sync". The closed set only removes grammatical subjects that denote the software, so the phrase stays an accurate capability.
- *Where normalization happens relative to dedup/overlap:* the transform is applied to **display text only**, inside the spec-story branch, before the existing dedup loop. To keep selection identical, the dedup key and the overlap comparison must be unaffected by the wording change. Chosen approach (option 3): the spec-story branch keeps both the raw clause and the Action_Phrase; dedup continues to key on `normalize(rawClause)` and `capabilitiesOverlapFeatures` continues to receive the same list it does today in terms of selection, while the stored/displayed string is the Action_Phrase. In practice the simplest implementation that preserves this is to compute the Action_Phrase and use it for display and truncation, but dedup on the normalized Action_Phrase only if that provably cannot change which items survive; the design mandates proving this with a test (Property 26's overlap case) and, if it cannot be shown, keying dedup on the raw clause. README-sourced capabilities are untouched.
- *False-positive protection:* only the two grammar shapes transform; the subject must be the whole lead-in before ` to `. "I want files to sync automatically" is a plain clause (no leading `to`, no recognized subject) and is kept verbatim.
- *Fallback:* ambiguous or unrecognized clauses are preserved unchanged.

**B2a-2. Spec how-it-works prose (Req 6.3, 6.10).**
- *Current failure:* the spec fallback only pulls sentences from sections whose heading matches `design|architecture|decision`. Specs whose explanatory content lives under "Overview", "Components", or "Data Flow" (as in this repository's own `design.md`) match no such heading, so `sentences` stays empty and the slide is headings-only.
- *Preferred path (unchanged order):* (1) README how-it-works section prose; (2) spec sections matching `design|architecture|decision`; (3) new deterministic fallback.
- *Fallback rule:* when (1) and (2) yield no sentences, `specExplanatoryProse(designFirst(specDocs))` scans documents in the existing `designFirst` order and, within each, lines in document order, and returns the first run of consecutive Explanatory_Prose lines. `isExplanatoryProse(line)` builds on the existing `isProseLine` (which already rejects headings, lists, tables, fences, HTML, badges, and blank lines) and additionally rejects, after reducing the line to plain text:
  - requirement/EARS lines: `/^(the system shall|when |if |while )/i`, or a `^Requirement \d+:` / `^User Story:` lead-in;
  - Glossary definition lines: a bold or backticked term immediately followed by a colon (`/^\*\*[^*]+\*\*\s*:/` or `` /^`[^`]+`\s*:/ ``);
  - single-token labels: plain text with no internal whitespace (fewer than two words).

  The matched run is passed through the existing `firstSentences(sectionProse(...), specMaxSentences)`.
- *Why not "first paragraph in the file":* the first lines are usually the title and front matter; the rule skips to the first substantive paragraph instead, using the same classifier the overview slide already relies on.
- *No numeric threshold:* the earlier draft proposed a `HOW_IT_WORKS_MIN_PROSE_CHARS` floor; it is **removed**. "Substantive" is decided structurally — a line survives only if it is prose, is not an EARS/requirement/glossary line, and is more than one word. No character count and therefore no new constant (governed or otherwise).
- *Headings and anchors unchanged:* the fallback only fills the sentence portion. The heading list, `HowItWorks.headings`, and therefore the Anchor_Terms are byte-identical to today.
- *Fallback of the fallback:* if no document contains Explanatory_Prose, the slide stays headings-only (Req 6.10). If there are no headings and no prose, `extractHowItWorks` returns null as now.

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
3. Calculate `secondsPerSlide` by distributing a `targetDurationSeconds` across the slides. `calculateSecondsPerSlide(slideCount, targetDurationSeconds?)` accepts an optional caller-supplied Target_Duration; when omitted it derives a default from the slide count. The provided value is asserted to lie within `VIDEO_CONFIG.minDurationSeconds`–`VIDEO_CONFIG.maxDurationSeconds` (the route rejects out-of-range values with `invalid_input` before rendering starts), and each slide is floored at 1 second so the total matches the target to within one second per slide of rounding
4. Write output to a temp file at `os.tmpdir()/{renderJobId}.mp4`

**Text layout (Req 4.15, 4.16):** This replaces today's `line.slice(0, 100)`, which cuts mid-word and ignores the actual glyph width.
- Layout values move from inline literals into a module-level `LAYOUT` constant: margins, title and body fonts, line heights, title top, and divider gap. These are presentation details, not spec constants, so they stay out of `output.ts`.
- `wrapText(text, maxWidth, measure): string[]` is a pure function. `measure` is injected as `(s) => ctx.measureText(s).width` in production and as a fake in tests. It splits on `\n` to preserve explicit breaks and blank lines, wraps greedily at spaces, and breaks a word by characters only when the word alone exceeds `maxWidth`.
- `fitLines(lines, maxLines, maxWidth, measure): string[]` keeps the lines that fit. If any are dropped, it trims the last kept line until `line + "…"` fits.
- The title wraps to at most `LAYOUT.titleMaxLines` (2) with the same ellipsis rule. The divider and body start are positioned from the actual title height.
- `maxWidth = VIDEO_CONFIG.width − 2 × LAYOUT.margin`. Body `maxLines` is derived from the space between the body top and `VIDEO_CONFIG.height − LAYOUT.margin`.
- HTML-entity decoding, currently duplicated for title and body, moves into one `decodeHtmlEntities` helper.

**Progress reporting (Req 4.3, 4.17, 4.18):** The render route uses Server-Sent Events (SSE). A timer guarantees the cadence, and ffmpeg only supplies values.

- `ProgressTracker` (renderer module, exported for tests) holds the current estimate and emits it:
  - `update(fraction)` stores a new value. The percentage is `min(99, max(previous, round(fraction × 100)))`, so it never decreases and never reaches 100 before completion. It does not emit.
  - `start()` emits the current value immediately, then every `HEARTBEAT_MS` from a `setInterval`.
  - `stop()` clears the interval and turns every later `update`/emit into a no-op. It is idempotent.
- `HEARTBEAT_MS = VIDEO_CONFIG.progressIntervalMs / 2` (1 000 ms), a value derived from the governed constant. Emitting every half interval means one late timer tick still keeps the gap under 2 s. Every tick emits, even when the value hasn't changed, so the cadence never depends on progress being made.
- Phases share one 0–99 scale: frame preparation covers the first `FRAME_PHASE_WEIGHT` (0.1), and encoding covers the rest based on ffmpeg's `frames` count. Both are renderer-module constants (presentation detail, not spec constants).
- Frame preparation yields to the event loop (`await setImmediate`) after each slide, so the timer can fire while frames are drawn. Today the drawing loop blocks the event loop.
- `start()` wraps the whole job in `try/finally { tracker.stop() }`, so the timer is cleared on success, failure and cancellation. The renderer no longer calls `onProgress(100)`. The route sends the single terminal event, `{"percent":100,"jobId":…}`.
- The route adds a `closed` flag, set on completion, on error, and on `res.on("close")` (client disconnect). The `onProgress` sink checks it before every write.
- `VideoRenderer` keeps each active job's tracker in its active-render record. Cancellation (below) stops it as its first step.

The route's error branch is the one rewritten by the unmerged `fix/render-sse-double-error-handling` (`b07c4b4`). This work builds on that change. It does not rewrite the same lines independently.

**Job lifecycle and cancellation (Req 4.7, 4.8, 4.18–4.22):**

State machine. A guarded transition is the only way to change `job.status`:

```
pending ──start──▶ rendering ──▶ complete
   │                   ├──────▶ failed
   └──────cancel───────┴──────▶ cancelled
```

- `transition(job, from: Set<Status>, to)` is a compare-and-set. It changes the status only when the current status is in `from`, and returns whether it did. Allowed transitions: `pending→rendering`, `pending→cancelled`, and `rendering→{complete, failed, cancelled}`.
- Terminal states (`complete`, `failed`, `cancelled`) have no outgoing transitions. A late ffmpeg `end` after cancellation finds `cancelled` and its `rendering→complete` attempt fails, so it can't resurrect the job. The outcome never depends on callback ordering.
- Cancellation is reserved first: `rendering→cancelled` happens at the start of cancellation, so completion can no longer win while the encoder is still being stopped.

Renderer API:
- `createJob(): RenderJob` creates and registers a `pending` job and returns it. No rendering work happens yet.
- `run(jobId, slides, onProgress, targetDurationSeconds?): Promise<RenderJob>` performs `pending→rendering` and renders. It resolves with the job when the job ends `complete` or `cancelled`, and rejects with `ApiError("internal_error")` only when the job ends `failed`. If the job was cancelled while pending, it resolves immediately without doing any work.
- `start(slides, onProgress, targetDurationSeconds?)` stays as a thin `createJob` + `run` wrapper for existing callers.
- `cancel(jobId): Promise<void>` is the single cancellation implementation, used by `DELETE`, client disconnect, and any internal path. It is idempotent: concurrent callers share one in-flight cancellation promise, and terminal jobs return immediately with no change. `abort(jobId)` remains an alias.
- Each running job has an active-render record `{ tracker, controller: AbortController, command | null, exited: Promise<void>, cancelling: Promise<void> | null }`. It is removed when the job settles.

Cancellation sequence, started immediately (there is no wait before signalling):
1. Compare-and-set `pending|rendering → cancelled`. If that fails, the job is already terminal or another caller won: return the in-flight promise, or resolve.
2. Stop the progress tracker; no further progress is emitted.
3. `controller.abort()`. The frame-preparation loop checks `signal.aborted` after each slide and stops, and frame writes stop.
4. If an ffmpeg command is active, send `SIGTERM` (`command.kill("SIGTERM")`).
5. Wait for **confirmed process exit**: the child process's own `exit` event (observed on `command.ffmpegProc`, captured at fluent-ffmpeg's `start` event), or, if no child was ever spawned, fluent-ffmpeg's `error`/`end`. Sending a signal is never treated as exit. If the command has been run but the child hasn't spawned yet, the signal is sent as soon as `start` fires.
6. If it hasn't exited after `KILL_GRACE_MS`, send `SIGKILL`.
7. Wait for confirmed exit again, up to the deadline `T`.
8. Delete the partial output file (best-effort; a missing file is fine).
9. Settle the cancellation: resolve if exit was confirmed (or no encoder ever ran), otherwise reject as below.
The status stays `cancelled` throughout, and the active record is removed once cancellation settles.

Timing. Let `T = VIDEO_CONFIG.cancelTimeoutSeconds × 1000`, measured from the cancellation request:
- `KILL_GRACE_MS = T / 2` (1,500 ms), a renderer-module constant derived from the governed value.
- `SIGKILL` is sent at the latest at `T/2`, so the forced kill and the file deletion both fit inside `T`.
- Req 4.8 is satisfied only when exit is confirmed within `T` (or no encoder was running). A resolved promise, a `cancelled` status, or a deleted file is not enough on its own.
- **Exceptional path:** if exit isn't confirmed by `T`, the job stays `cancelled` (no new state) and can never become complete or downloadable, and the partial file is still deleted. `cancel()` then **rejects** with `ApiError("internal_error")` describing a cancellation-termination failure, which is logged. `DELETE` maps it to a 500; the disconnect path logs it.
- One observer stays attached to the surviving child so a late exit is still recorded and the listener is then removed. No ffmpeg process or listener is left unobserved after `cancel()` settles.
- If `SIGTERM` exits ffmpeg first, `SIGKILL` is never sent.

Failure path (Req 4.7, previously unmet): `rendering→failed`, then the partial output is deleted. Failure does **not** signal or wait for the encoder; it only runs after ffmpeg has already reported its error. If the unlink fails, the original render error stays the reported failure, the cleanup error is logged, and there is no second transition. Completion keeps its output. Only the low-level file-removal helper is shared with cancellation.

**File size check:** After encoding completes, if file size exceeds `VIDEO_CONFIG.maxFileSizeBytes` (200 MB), the download response includes a `X-File-Size-Warning` header and the frontend prompts for confirmation before triggering the browser download.

---

### 6. API Routes (`src/server/routes.ts`)

| Method | Path | Handler | Description |
|---|---|---|---|
| `POST` | `/api/analyze` | `RepositoryAnalyzer` | Validate URL, fetch repo data |
| `GET` | `/api/storyboard` | `StoryboardGenerator` | Generate slides from cached analysis |
| `POST` | `/api/render` | `VideoRenderer` | Start render job, return SSE stream. Body: `{ slides: Slide[], targetDurationSeconds?: number }` |
| `DELETE` | `/api/render/:jobId` | `VideoRenderer.cancel` | Cancel a render. Idempotent: 204 for every existing job, 404 for an unknown job |
| `GET` | `/api/download/:jobId` | file stream | Stream completed MP4 to browser |

All routes apply a top-level error handler that maps `ApiError` codes to HTTP status codes and returns the standard `{ "error": "...", "message": "..." }` JSON shape.

The `POST /api/render` handler validates the optional `targetDurationSeconds` **before** switching the response into SSE mode. When present, it must be a finite number within `VIDEO_CONFIG.minDurationSeconds`–`VIDEO_CONFIG.maxDurationSeconds`; otherwise the handler returns a standard `HTTP 400 { "error": "invalid_input", "message": "..." }` JSON response and does not open the SSE stream. When absent, the renderer derives the default duration from the slide count.

**Render stream lifecycle (Req 4.17–4.21):**
1. After validation, the handler calls `createJob()`, opens the SSE stream, and writes `{"jobId":…,"percent":0}` as the **first** event, before any frame work. Then it calls `run()`.
2. Heartbeat events follow: monotonic, at most 99.
3. Outcome:
   - `run()` resolves `complete`: one terminal `{"percent":100,"jobId":…}` event, then the stream ends.
   - Resolves `cancelled`: the stream ends with no 100 and no error event.
   - Rejects (`failed`): one error event, then the stream ends.
4. `res.on("close")` sets `closed`, so no write happens after a close. If the job is still `pending` or `rendering`, it also calls `cancel(jobId)`, the same path as `DELETE`. If the job is already terminal, nothing changes; this covers completion winning just before the close.

**`DELETE /api/render/:jobId`:**
- Unknown job: 404, unchanged.
- Pending or rendering: `await cancel(jobId)`, then 204 once the cancellation contract is met.
- Cancelled, failed, or complete: 204, no change. A complete job's MP4 is **not** deleted.

**`GET`/`HEAD /api/download/:jobId`** stays as it is: only `complete` jobs are served. Pending, rendering, failed and cancelled jobs get 409 (Req 4.20).

`partialFailures` can now also contain `metadata`, `pullRequests`, and `releases`; `AnalysisProgress` lists these names as it does today.

`GET /api/storyboard` is a transport boundary only. It reads and type-checks the `url` query parameter, calls `buildStoryboardForUrl(url)`, and returns the slides or passes the error to the top-level handler. It does not call the analyzer, the storyboard, or the cache directly.

### 6a. Storyboard Pipeline (`src/server/pipeline.ts`)

A small orchestration module, the only place where the analysis, selection, lookup and generation steps are sequenced. It holds no GitHub access (that stays in `analyzer.ts`) and no slide logic (that stays in `storyboard.ts`).

`buildStoryboardForUrl(url): Promise<Slide[]>`:
1. Validate the URL and derive the cache key from `owner`/`repo` tokens (`validateAndExtractTokens`, `AnalysisCache.keyFor`).
2. Use the cached analysis if present, otherwise run `analyzeRepository(url)` and cache it if it is complete, as before.
3. If the cached entry already holds `prCommitEvidence`, go straight to step 7: a cache hit makes no GitHub request.
4. `selectDeepDivePullRequests(result)`, which never reads evidence.
5. `prsNeedingEvidence(result, selected)` keeps only truncated merge-commit Selected_PRs.
6. `fetchSelectedPrCommits(owner, repo, numbers)`, which makes ≤ 3 requests and never throws. Store the evidence on the analysis object, so a cached entry keeps it.
7. `generateStoryboard(result, evidence)`.

Errors from steps 1–2 (`invalid_url`, `repo_not_found`, rate limit, …) propagate unchanged, so the route's error mapping is unchanged. Step 6 can't fail the pipeline, and step 7's `insufficient_content` propagates as today. The `/api/analyze` route keeps its current behavior and makes no lookups.

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
  parents: string[];       // parent SHAs; length ≥ 2 marks a Merge_Commit
}

interface PullRequest {
  number: number;
  title: string;
  body: string;            // "" when absent; capped at MAX_CHANGE_BODY_CHARS
  labels: string[];        // lowercased label names
  mergedAt: string;        // ISO 8601; only merged PRs are retained
  isBot: boolean;
  mergeCommitSha: string | null; // merge_commit_sha; links the PR to its Change_Group
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
  | "invalid_input"
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
8. **PR number validation** — the PR numbers used in step 8 come from GitHub's pulls response and are untrusted. Each must be a positive safe integer before it is placed in a URL; anything else is dropped without a request.
9. **No execution** — README code blocks, PR bodies, and release notes are treated as text only. Nothing from the repository is executed or evaluated.

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

### Property 6: Cancellation Terminates Rendering Within the Timeout

For a job cancelled while pending or rendering:
- the active ffmpeg process receives `SIGTERM`, and receives `SIGKILL` only if it hasn't exited by `KILL_GRACE_MS`;
- the process's **exit is observed** (a signal being sent is not evidence) within `VIDEO_CONFIG.cancelTimeoutSeconds`. A pending job whose encoder never started satisfies this vacuously. A run where exit isn't confirmed by the deadline fails this property, even though the job stays `cancelled`. `cancel()` returning, the status being `cancelled`, or the partial file being deleted is never on its own evidence that this property holds; the termination failure is logged;
- frame preparation stops at the next slide boundary;
- the partial output file no longer exists;
- the final status is `cancelled`;
- `cancel()` resolves within `VIDEO_CONFIG.cancelTimeoutSeconds` after confirmed exit, or rejects with a cancellation-termination failure if exit isn't confirmed;
- a later ffmpeg `end` or `error` never changes the status;
- the job's download is rejected.

A failed job's partial output is also deleted, without signalling the encoder. A cleanup error never replaces the original failure.

**Validates: Requirements 4.7, 4.8, 4.20**

### Property 7: Target Duration Is Range-Bounded

Every render job accepted by `POST /api/render` has a Target_Duration within the inclusive range `[VIDEO_CONFIG.minDurationSeconds, VIDEO_CONFIG.maxDurationSeconds]`: an explicit value outside that range (or a non-numeric value) is rejected with `invalid_input` (HTTP 400) before rendering begins, and an absent value is replaced by a default derived from the slide count and clamped to the same range. The produced video's total duration equals the Target_Duration to within one second per slide of rounding, with each slide floored at 1 second.

**Validates: Requirements 4.10, 4.11, 4.12, 4.13, 4.14**

### Property 8: Content Is Never Fabricated

Every text fragment in a generated slide is either a substring (after plain-text reduction and truncation) of extracted repository data, or one of the fixed labels and templates listed in the Stage 5 table. Sections without a source produce no slides. A PR, release, or commit without a Change_Context produces a slide with no context line.

**Validates: Requirements 3.9, 5.2, 5.6, 6.4, 6.8, 7.7, 7.11, 7.12**

### Property 9: Slide Caps Are Ceilings

Feature slides never exceed `maxFeatureSlides`, evolution slides never exceed `maxEvolutionSlides`, and the total never exceeds `maxSlides`. Adding ineligible candidates to the input never changes the output's evolution slides. Ineligible candidates include bot PRs, `chore:`/`docs:` PRs, dependency bumps, patch releases, irrelevant PRs, and bug-fix commits. No slide's content duplicates another slide of the same type.

**Validates: Requirements 3.3, 3.12, 6.9, 7.1, 7.13**

### Property 10: Evolution Is Anchored to the Current Repository

When the anchor set is non-empty, every notable-change and engineering-highlight slide refers to an item whose title or Change_Context matches at least one Anchor_Term, and none has Change_Category "Bug Fix". When the anchor set is empty, notable-change slides are produced only through the Empty_Anchor_Evolution_Fallback (Property 28) — Significant_PRs (non-"Bug Fix") and non-patch Releases with a Change_Context — and engineering-highlight slides remain limited to `feat`-typed commits (no dependency wording), at most `maxFallbackHighlights` of them.

**Validates: Requirements 7.5, 7.6, 7.9, 7.13, 7.14, 7.23**

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

### Property 15: One Logical Change, At Most One Detailed Slot

For every generated storyboard, no two Detailed_Evolution_Slides (notable-change or Engineering_Highlight) refer to the same Change_Group. No Engineering_Highlight refers to a Merge_Commit or to a commit in the Change_Group of a Pull_Request that has a notable-change slide. Change_Groups are determined only from `parents` and `mergeCommitSha`, so rewriting every commit subject and PR title leaves the group assignment unchanged. Groups are sound with respect to the window: every non-merge member of a Merge_Commit's group is reachable from its second parent inside the window, and the group has non-merge members only when the first parent's ancestry is fully inside the window. Adding commits outside the window to the input never adds a member to a group. For a Selected_PR, every window commit whose SHA GitHub reported for that PR is also excluded from highlights. Without evidence, the result is identical to graph-only grouping. Selected_PRs are the same with or without evidence. Evolution_Timeline entries are exempt: a Pull_Request may appear on the timeline and as a notable-change slide.

**Validates: Requirements 2.11, 2.12, 7.9, 7.14, 7.15, 7.16, 7.17, 7.18**

### Property 16: Progress Cadence Is Independent of the Encoder

During a render, consecutive progress events are at most `VIDEO_CONFIG.progressIntervalMs` apart for any ffmpeg reporting pattern, including none at all, a single report, or reports landing just before the boundary. This holds during frame preparation as well as encoding. Reported percentages never decrease and stay ≤ 99 until the single terminal event at 100. No event is sent after completion, failure, cancellation, or client disconnect, and no progress timer remains active once the render settles.

**Validates: Requirements 4.3, 4.17, 4.18**

### Property 17: Selected-PR Lookups Are Lazy and Bounded

For any analysis, the number of PR-commit requests equals the number of distinct Selected_PRs that need evidence, capped at 3, and is 0 when no Selected_PR needs evidence. No PR-commit request is made for a Pull_Request that is not a Selected_PR. Total GitHub requests for one uncached analysis plus its first storyboard never exceed 15, and a cached storyboard request makes none. A failed lookup never changes the HTTP outcome of analysis or storyboard generation.

**Validates: Requirements 2.11, 2.12**

### Property 18: Render Job Lifecycle Has One Outcome

- **Job ID first:** the first SSE event of every render carries the job ID, with percent 0, before any frame work.
- **One outcome:** each job reaches exactly one terminal state and never leaves it, whatever the interleaving of completion, failure, `DELETE` and client disconnect.
- **Disconnect while active:** a disconnect while pending or rendering goes through the same `cancel()` path as `DELETE`.
- **Disconnect after terminal:** a disconnect after a terminal state changes nothing.
- **Idempotent DELETE:** `DELETE` on a terminal job returns 204 with no change and keeps a complete job's file. Repeated or concurrent cancellations give the same result as one.
- **No late events:** after cancellation or disconnect, no progress, error, or 100 event is written.

**Validates: Requirements 4.17, 4.18, 4.19, 4.20, 4.21, 4.22**

### Property 19: Patch Releases Are Classified by Their Semantic Version

For any tag built as `prefix + sep + [v|V] + X.Y.Z + [-label[.n]] + [+build]` with `sep ∈ {-, _, /, @}` or no prefix, `isPatchRelease` is true exactly when `Z > 0`. Tags whose version doesn't end the tag, has four components or leading zeros, or carries an unrecognized suffix are never patch releases. Patch releases never appear on the timeline or as release deep dives.

**Validates: Requirements 7.4, 7.6, 7.19**

### Property 20: Release Context Carries No Maintenance Noise

For release notes mixing prose, changelog bullets, URLs, Markdown links, commit hashes, attributions, and reference lists, the release Change_Context contains no URL, no Markdown link syntax, no standalone hash, no parenthesized reference list, no generated `by @user in` attribution, and no bullet joined to another bullet. Every word of the context comes from the notes (Property 8), and when prose exists the context is its first sentence.

**Validates: Requirements 7.6, 7.20**

### Property 21: Documentation Commits Never Become Highlights

No commit whose subject starts with `docs`, `docs(scope)`, `docs!`, or `docs(scope)!` followed by `:`, in any letter case, is an Engineering_Highlight on either path, and such a commit never prevents another commit in its Change_Group from being selected. Non-docs subjects that merely mention docs keep their previous eligibility.

**Validates: Requirements 7.9, 7.14, 7.21**

### Property 22: Run Headings Are Recognized After Normalization

For each Run_Instructions keyword and any combination of letter case, Markdown emphasis, leading emoji or shortcode, and trailing colon, a section with at least one non-blank line produces a Run slide titled with that heading, and the earliest matching section in document order wins. Words that only start with a keyword (`Installing`, `Instance`) do not match.

**Validates: Requirements 5.7, 5.8, 5.9, 5.10**

### Property 23: Calendar Terms Are Never Relevance Evidence

Adding or removing Calendar_Terms in any capability, feature, heading, PR, release, or commit text never changes the Anchor_Term set or any relevance decision, while tokens with mixed letters and digits and non-year numbers are preserved.

**Validates: Requirements 7.22**

### Property 24: Shortcode Noise Is Removed From Prose but Literal Code Is Preserved

For any analysis result whose text fields contain Emoji_Shortcodes, no generated prose, slide title, label, or non-code preview text contains a raw shortcode, while literal content copied from a fenced code block (Run steps taken from a code block) is byte-for-byte preserved, including shortcode-like text. Times, IPv6 addresses, and colon-separated identifiers in prose are unchanged. The property is tested on both sides: a shortcode in prose is removed, and a `:rocket:`-containing command inside a code block survives.

**Validates: Requirements 3.14**

### Property 25: The Overview Does Not Repeat the Description

The overview's README paragraph never contains a sentence whose normalized form equals the normalized description or one of its sentences, and every README sentence that is not such a duplicate is kept (subject to the word cap).

**Validates: Requirements 5.1, 5.12**

### Property 26: Capability Phrasing Is a Deterministic, Conservative Grammar Transform

For capabilities sourced from spec user stories:
- "I want to <action>", "I want the System to <action>", and "I want the video to <action>" yield exactly "<action>" (capitalized, trailing sentence punctuation removed);
- any other "I want" clause — a plain noun phrase ("a fast parser"), an unrecognized subject before "to" ("the application to export CSV files", "the parser to be fast"), an object clause ("files to sync automatically"), or a clause without "to" — is preserved verbatim;
- the transform never substitutes words, changes tense, or deletes an arbitrary noun phrase before "to";
- for the same analysis result, the set of selected user stories, their order, dedup, and the Capabilities-versus-Key_Feature overlap outcome are identical to the pre-B2a behavior; only the displayed/truncated text differs. This is demonstrated with a case where using the transformed display text as the dedup/overlap key would change the result, proving selection keys on the raw clause.

Negative cases explicitly cover `the application` (not in the two-member set) and object clauses that must not be stripped.

**Validates: Requirements 5.4, 5.5, 5.13**

### Property 27: Spec How-it-works Includes Prose When the Spec Has Any

For the spec-based how-it-works fallback:
- WHEN the Spec_Documentation contains eligible Explanatory_Prose (whether or not it sits under a design/architecture/decision heading), the extracted slide body includes at least one prose sentence that is a substring of the source spec, and is not heading-only;
- preferred design/architecture/decision prose still wins when present; Overview/Components-style prose is reached only through the new fallback;
- requirement/EARS lines, Glossary definitions, table rows, and fenced-code lines are never selected;
- WHEN the Spec_Documentation contains headings but no eligible Explanatory_Prose, the result is the deterministic headings-only body, with no invented text;
- WHEN there are neither headings nor prose, extraction returns null;
- every sentence in the result is a substring of the source corpus (source-derived, not generated; Property 8 still holds);
- the heading list and the derived Anchor_Terms are byte-identical to the pre-B2a behavior.

**Validates: Requirements 6.2, 6.3, 6.10**

### Property 28: Empty-Anchor Evolution Uses Independently-Significant Evidence

When the anchor set is empty:
- a Significant_PR whose Change_Category is not "Bug Fix" is eligible for a notable-change slide, and a non-patch Release with a Change_Context is eligible, in the same rank order and under the same `maxEvolutionSlides`/`maxEvolutionItems` ceilings as the anchored path;
- no evidence that fails an existing significance/quality filter becomes eligible: bot PRs, `chore|docs|ci|style|test|build` PRs, dependency-bump PRs, uncategorized PRs, "Bug Fix" PRs, patch releases, and releases without a Change_Context are all still excluded;
- no commit becomes an Engineering_Highlight except through the unchanged `feat`-only rule (Property 10); Selected_PRs still block their Change_Group commits (no PR/commit duplication of one change).

**Validates: Requirements 7.23**

### Property 29: Anchored Repositories Are Unaffected by the Fallback

For any analysis whose anchor set is non-empty, the set, order, categories, Change_Contexts, and rendered text of all evolution slides (timeline, notable-change, and highlight), the deep-dive allocation, and the Change_Groups are identical with and without the Empty_Anchor_Evolution_Fallback present. The fallback is reachable only when `anchors.size === 0`.

**Validates: Requirements 7.24**

### Property 30: Empty-Anchor Release Context Comes From the Approved Extraction Pipeline

In the empty-anchor case, any Change_Context shown for a Release — on its timeline entry or on a release deep-dive — is **exactly** the result of the deterministic pipeline `release.body → cleanReleaseNotes → extractChangeContext`, truncated to `changeContextMaxWords`. The displayed context is not required to be a literal substring of the raw body, because that pipeline intentionally transforms source text (Markdown links reduce to their visible link text; URLs, references, and commit hashes are removed). No context is generated, inferred, or separately rewritten. Specifically:
- Markdown link syntax may disappear while the visible link text survives;
- URLs, `(#NN)` references, and commit hashes removed by `cleanReleaseNotes` never reappear in the displayed context;
- the displayed context equals the extraction-pipeline result for the same body;
- empty or unusable release notes produce no context (tag-only entry, no deep-dive);
- patch releases remain excluded;
- adding context does not change the set or order of timeline release entries.

**Validates: Requirements 7.20, 7.25**

### Property 31: PR Deep-Dive Context Is Structurally Sanitized

The body of a PR notable-change slide is exactly `extractChangeContext(cleanPullRequestBody(pr.body))` (then existing display processing). It never contains a URL-only, reference-only, closing-reference (`Closes <URL>` / `Closes #NN`), or standalone-hash line that `cleanPullRequestBody` targets. A URL, reference, or hash embedded in ordinary prose is preserved, and Markdown link text survives. No prose is reordered, scored, or rewritten. When the cleanup yields no usable prose, the slide falls back to title and dates (Req 7.7).

**Validates: Requirements 7.7, 7.26**

### Property 32: PR Display Sanitation Does Not Change Selection

For identical analyzer input, adding PR display sanitation leaves unchanged: the set and order of selected Significant_PRs, their categories, every `isRelevant` decision (anchored and empty-anchor), the Evolution_Timeline entries and text, PR deep-dive titles, the deep-dive slot allocation, and all Change_Groups. Relevance, ranking, and allocation use the unmodified `context`; only the deep-dive body (`displayContext`) may differ.

**Validates: Requirements 7.5, 7.26**

### Property 33: Clean PR Bodies Are Byte-Identical

When `cleanPullRequestBody(pr.body)` removes no targeted structural line, `displayContext` equals `context` and the PR deep-dive slide is byte-identical to the pre-sanitation output. Anchored repositories whose PR bodies carry no targeted noise are therefore unchanged, and their relevance/selection is unchanged regardless.

**Validates: Requirements 7.26**

### Property 34: Performance Changes Are Classified as Refactor, Honoring the Breaking Marker

`perf:` and `perf(scope):` titles (and `performance`/`perf` labels) are categorized as `Refactor`; `perf!:` and `perf(scope)!:` are `Breaking Change`. The `!`→Breaking rule fires only for a recognized conventional type (`feat`, `fix`, `refactor`, `perf`): an unknown `type!:` is not promoted to Breaking by the bang alone. A conventional `perf:` commit is eligible as an Engineering_Highlight. The existing Breaking Change / Feature / Bug Fix / Refactor classifications, `CATEGORY_RANK`, and allocation are unchanged, and no new category is introduced.

**Validates: Requirements 7.2, 7.9**

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
          POST /api/render  (target duration validated pre-SSE)
               │
               ├─ invalid_input       → HTTP 400 JSON, no SSE stream opened
               │                        (Target_Duration out of range or non-numeric)
               ├─ insufficient_content → HTTP 422 JSON (empty slides array)
               │
               ▼  (validation passed → SSE stream opens)
               ├─ SSE percent updates → progress bar
               ├─ render failure      → error banner + retry button
               └─ cancel / disconnect → cancel(jobId): 204, stream ends without 100 or error
```

The `invalid_input` code (HTTP 400) is distinct from `insufficient_content` (HTTP 422): the former signals a malformed or out-of-range render parameter (Target_Duration), the latter signals that the repository cannot produce the minimum slide count. Both are validated before the SSE stream is opened so the error path never rides the SSE channel.

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

- **`tests/analyzer.test.ts`** — URL validation; metadata step as the `repo_not_found` source; commit subject/body mapping; PR mapping (merged-only, `isBot`, lowercased labels, body cap); release mapping (drafts dropped); 404 and `[]` for PRs, releases, and specs are empty results, not partial failures; spec selection (4-level paths found, requirements/design priority, path-ordered ties, cap of 6, > 1 MB skipped, invalid paths rejected, segments encoded); spec step recorded when tree fails; timeout and rate-limit paths; `parents`/`mergeCommitSha` mapping; `fetchSelectedPrCommits`: no request for `[]`, ≤ N requests for N numbers, cap of 3, duplicates fetched once, non-integer numbers dropped, per-PR failure (timeout, 500, 429, malformed, redirect) omitted without throwing, host and URL shape asserted.
- **`tests/storyboard.test.ts`** — per-section extraction and README → spec fallback for capabilities, how-it-works, and features; overview paragraph skips badges and headings and truncates at `introMaxWords`; "Usage" never feeds capabilities; overlap omission at, above, and below the ratio; described vs. name-only features and the summary slide under the cap; anchor tokenization, `GENERIC_TERMS` exclusion, and prefix matching; Significant_PR filters and category precedence; ranking; patch-release detection; timeline minimum, cap, and chronology; deep-dive exclusion of Bug Fix; release deep dives only when PR deep dives fall short; commit fallback, PR-reference dedup, and bug-fix exclusion; empty-anchor fallback (`feat:`/`feat(scope)!:` accepted; `fix:`, `docs:`, `chore:`, `feat(deps):`, `Add …`, and substring-only matches rejected; `maxFallbackHighlights` ceiling; no timeline from commits); history-invariance of current-state slides (Property 14); Change_Context stripping (comments, checklists, headings, trailers, code fences); ordering (Property 3); ceiling metamorphic tests (Property 9); anchoring (Property 10); escaping for every slide type (Property 11); existing run-slide tests with the new position.
- **`tests/renderer.test.ts`** — `wrapText` with a fake `measure` (explicit breaks, blank lines, long-word breaking, exact-fit lines); `fitLines` ellipsis behaviour; title max lines; existing duration, abort, and sweep tests unchanged.
- **`tests/routes.test.ts`** — target-duration validation; render SSE sink: exactly one terminal `percent: 100` event with `jobId`, no writes after completion, error, or client disconnect.
- **`tests/progress.test.ts`** — `ProgressTracker` and `VideoRenderer.start` under `vi.useFakeTimers()`, with `fluent-ffmpeg` mocked as a scripted event emitter. Covers: the cadence bound for no reports, a single report, reports just before the boundary, bursts, and a long silent encode; events during frame preparation; monotonic values; ≤ 99 before completion; timers cleared on success, ffmpeg error, and frame-write error (`vi.getTimerCount() === 0`). No wall-clock sleeps.
- **`tests/cancellation.test.ts`** — `VideoRenderer` lifecycle under fake timers with a scripted ffmpeg whose `kill(signal)` is recorded and whose exit is scripted.
  - Cancellation: `SIGTERM` sent; `SIGKILL` only when `SIGTERM` doesn't exit, and before the deadline; frame loop stops mid-way; partial file deleted; resolves within the timeout; `cancelled` survives a late `end` or `error`.
  - Races: concurrent `cancel()` calls share one cleanup; `DELETE` and disconnect nearly simultaneous; `end` during cancellation; `error` after `SIGTERM`/`SIGKILL`; completion just before close.
  - Idempotency: terminal-job cancel is a no-op and keeps a complete job's file.
  - Failure: the failed path deletes partial output.
  - Cleanup: no timers left.
  - Route and hook: job ID first, quiet stream end on cancel, disconnect → `cancel()`, repeated `DELETE` → 204, download of cancelled/failed → 409, UI Cancel sends `DELETE` while rendering.
- **Change_Group tests (in `tests/storyboard.test.ts`)** — `buildChangeGroups` for merge-commit, squash, rebase-tip, nested-merge, missing-`mergeCommitSha`, PR-data-unavailable, and truncated-window histories; `prsNeedingEvidence` returns only truncated merge-commit Selected_PRs (never squash, rebase, or graph-proven merges); evidence excludes matching window commits, evidence SHAs outside the window and evidence for non-selected PRs are ignored, missing evidence equals graph-only output, and selection is independent of evidence (first-parent walk leaves the window → merge commit only; branch commit reachable only through an out-of-window commit → not grouped; root commit → walk still complete); Property 15 on a fixture that mirrors this repository's PR #9 history; message-rewrite invariance; timeline + deep dive for the same PR allowed; fallback path also limited to one highlight per group.

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
│   │   ├── analyzer.ts            # RepositoryAnalyzer (7 extraction steps + selected-PR lookup)
│   │   ├── pipeline.ts            # Storyboard pipeline: analysis → selection → lookup → generation
│   │   ├── storyboard.ts          # StoryboardGenerator (5 stages)
│   │   └── renderer.ts            # VideoRenderer (canvas + ffmpeg, text layout)
│   ├── components/
│   │   ├── UrlInput.tsx           # Step 1 — URL form
│   │   ├── AnalysisProgress.tsx   # Step 2 — loading/partial-data state
│   │   ├── StoryboardPreview.tsx  # Step 3 — slide preview, reorder, remove
│   │   └── VideoExport.tsx        # Step 4 — duration, progress bar, download, cancel
│   ├── hooks/
│   │   └── useRenderJob.ts        # React hook wrapping the SSE render stream
│   └── App.tsx                    # Top-level step router
├── tests/
│   ├── fixtures/                  # RepoAnalysisResult fixtures (Kiro, README-only, thin, hostile)
│   ├── analyzer.test.ts
│   ├── storyboard.test.ts
│   ├── renderer.test.ts
│   ├── routes.test.ts
│   ├── integration.test.ts
│   ├── cache.test.ts
│   └── config.test.ts
├── .kiro/
│   ├── steering/
│   └── hooks/
└── package.json
```
