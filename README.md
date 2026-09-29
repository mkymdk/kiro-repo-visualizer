# GitHub Repository Visualizer

The GitHub Repository Visualizer turns any public GitHub repository into a narrated, downloadable MP4 video. A React single-page frontend drives a four-step flow — URL input, analysis, storyboard preview, and export — while an Express/TypeScript backend handles all GitHub communication, storyboard generation, and video rendering. It was built end to end with Kiro, using specs, steering, hooks, property-based testing, powers, MCP, and a custom agent.

---

## Prerequisites

| Dependency | Version | Notes |
|---|---|---|
| Node.js | ≥ 18 (tested on 24) | Required |
| npm | ≥ 9 | Required |
| ffmpeg | Bundled via `@ffmpeg-installer/ffmpeg` | No system install needed |

> **Docker note:** if you run the app inside Docker, no additional setup is required for ffmpeg — `@ffmpeg-installer/ffmpeg` bundles a static binary appropriate for the runtime platform.

---

## Setup

```bash
# 1. Install dependencies
npm install

# 2. (Optional) Set your GitHub Personal Access Token to increase API rate limits
export GITHUB_PERSONAL_ACCESS_TOKEN=ghp_your_token_here

# 3. Start both the Vite dev server (port 5173) and the Express API (port 3001)
npm run dev
```

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GITHUB_PERSONAL_ACCESS_TOKEN` | Optional | GitHub PAT for authenticated API calls. Without it the unauthenticated rate limit of 60 req/hr applies. Create one at https://github.com/settings/tokens — no scopes needed for public repos. |

---

## Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start Vite (port 5173) and Express (port 3001) concurrently |
| `npm run build` | Compile frontend (Vite) and backend (tsc) for production |
| `npm run server` | Start only the Express API server |
| `npm test` | Run all unit and integration tests with coverage report |

---

## Four-Step User Flow

```
Step 1 — URL Input
  Enter a public GitHub repository URL:
  https://github.com/{owner}/{repo}
        │
        ▼
Step 2 — Analysis Progress
  The API fetches repository data in parallel:
  • Directory tree  • README  • Commit history  • .kiro spec docs
  Partial failures are shown as a warning; the flow continues with
  whatever data was successfully retrieved.
        │
        ▼
Step 3 — Storyboard Preview
  Up to 15 slides are generated and displayed as cards.
  Drag to reorder. Click "Remove" to delete (minimum 3 slides enforced).
  Click "Export Video" when satisfied.
        │
        ▼
Step 4 — Video Export
  The backend renders a 1280×720 H.264/MP4 video (30–300 s).
  A progress bar updates every 2 seconds via Server-Sent Events.
  When complete, click "Download MP4".
  Files over 200 MB trigger a size-confirmation dialog first.
```

---

## Project Structure

```
kiro-repo-visualizer/
├── src/
│   ├── config/
│   │   └── output.ts              # VIDEO_CONFIG, SLIDE_CONFIG — sole source of constants
│   ├── types/
│   │   └── index.ts               # Shared domain types and ApiError class
│   ├── server/
│   │   ├── index.ts               # Express app entry point (port 3001)
│   │   ├── routes.ts              # Route definitions and error handler
│   │   ├── analyzer.ts            # All GitHub API communication
│   │   ├── storyboard.ts          # Pure slide-assembly logic
│   │   └── renderer.ts            # canvas + ffmpeg video rendering
│   ├── components/
│   │   ├── UrlInput.tsx           # Step 1 — URL form
│   │   ├── AnalysisProgress.tsx   # Step 2 — loading / partial-data state
│   │   ├── StoryboardPreview.tsx  # Step 3 — drag-to-reorder slide preview
│   │   └── VideoExport.tsx        # Step 4 — progress bar, download, cancel
│   ├── hooks/
│   │   └── useRenderJob.ts        # React hook wrapping the SSE render stream
│   └── App.tsx                    # Top-level step router
├── tests/                         # 154 tests across 6 files
│   ├── config.test.ts             # Config immutability tests (3 tests)
│   ├── cache.test.ts              # Analysis TTL cache tests (12 tests)
│   ├── analyzer.test.ts           # Unit tests for analyzer (49 tests)
│   ├── storyboard.test.ts         # Unit tests for storyboard (38 tests)
│   ├── renderer.test.ts           # Unit tests for renderer (17 tests)
│   └── integration.test.ts        # Supertest integration tests (35 tests)
└── package.json
```

---

## API Reference

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/analyze` | Body: `{ url }` — fetch repo data, return `RepoAnalysisResult` |
| `GET` | `/api/storyboard` | Query: `?url=` — generate slides from cached analysis |
| `POST` | `/api/render` | Body: `{ slides }` — start render, stream SSE progress |
| `DELETE` | `/api/render/:jobId` | Cancel an in-progress render |
| `GET` | `/api/download/:jobId` | Stream completed MP4 to browser |

All error responses follow the shape `{ "error": "<code>", "message": "..." }`.

---

## Security Notes

- Repository URLs are validated against `^https://github\.com/[a-zA-Z0-9_-]{1,100}/[a-zA-Z0-9_-]{1,100}$` both client-side (UX) and server-side (authoritative).
- All outbound HTTP requests target only `api.github.com` or `raw.githubusercontent.com`. The hostname is asserted before every `fetch` call.
- Response bodies are capped at 10 MB. Requests time out after 10 seconds.
- Render output paths are confined to `os.tmpdir()` and derived only from sanitized UUIDs.

---

## How each Kiro lesson was used

### Lesson 1 — Spec

The whole project was scoped from a spec under [`.kiro/specs/repo-visualizer/`](.kiro/specs/repo-visualizer/), which holds `requirements.md`, `design.md`, and `tasks.md`. `design.md` defined the three-tier architecture and the strict component boundaries (analyzer owns GitHub I/O, storyboard is a pure function, renderer owns ffmpeg, routes only map errors), and `tasks.md` tracked implementation as a checklist that was worked top to bottom. Every implementation decision traced back to a requirement rather than being invented ad hoc.

### Lesson 2 — Steering

Four always-on steering files in [`.kiro/steering/`](.kiro/steering/) encode the project's non-negotiable conventions. `output-constants.md` forces every resolution, fps, codec, duration, file-size, and slide-count literal to live only in `src/config/output.ts`; `input-security.md` mandates URL allowlisting, SSRF/host assertion, and path-traversal sanitization; `api-error-handling.md` fixes the `{ error, message }` response shape, the standard error codes, and the 10-second timeout; and `code-style.md` requires explicit type annotations and full docstrings on every public function. Because they are steering, these rules applied automatically to every file the agent touched.

### Lesson 3 — Hooks

Four hooks in [`.kiro/hooks/`](.kiro/hooks/) automate guardrails on save. `validate-output-config.json` re-checks that every spec constant is present whenever `src/config/output.*` is saved; `check-url-validation.json` warns if a GitHub-fetching file is missing the allowlist regex or the 10-second timeout guard; `lint-on-save.json` runs ESLint (or ruff/black) with auto-fix on every source save; and `test-on-save.json` runs the matching test file through Vitest on save. Together they caught convention drift the moment it was written rather than at review time.

### Lesson 4 — Property-Based Testing (PBT)

`design.md` defines six Correctness Properties: (1) URL validation is server-authoritative, (2) output constants are immutable at runtime, (3) the slide-ordering invariant, (4) partial extraction does not abort the pipeline, (5) render-job isolation via unique temp paths, and (6) cancellation is time-bounded. Property 2 was a real find: `as const` only provides compile-time `readonly` typing and does **not** freeze the object in the emitted JavaScript, so `VIDEO_CONFIG` and `SLIDE_CONFIG` were actually mutable at runtime. It was fixed by wrapping both exports in `Object.freeze(...)` in `src/config/output.ts`, with a regression guard added in `tests/config.test.ts` that asserts the objects are frozen and reject mutation.

### Lesson 5 — Powers

The project is packaged as a reusable power under [`.kiro/powers/repo-visualizer/`](.kiro/powers/repo-visualizer/). It bundles the four steering conventions (under `dev.kiro/steering/`), a `skills/conventions/SKILL.md` skill, and a `plugin.json` manifest, so the entire convention-and-context set can be installed into another workspace as a single unit. This turns the project's hard-won rules into something portable rather than copy-pasted.

### Lesson 6 — MCP

[`.kiro/mcp.json`](.kiro/mcp.json) configures the official GitHub MCP server (`ghcr.io/github/github-mcp-server`, `repos` toolset) so the agent can query repository data through a governed MCP boundary rather than ad-hoc calls. It reads the token from the `GITHUB_PERSONAL_ACCESS_TOKEN` environment variable and ships disabled by default, so it is opt-in and never requires a token to be checked in.

### Lesson 7 — Custom agents

[`.kiro/agents/repo-visualizer-dev.json`](.kiro/agents/repo-visualizer-dev.json) defines a `repo-visualizer-dev` implementation agent. Its prompt hardcodes the component ownership map and the eight non-negotiable rules, its `permissions` allow only `npm`/`npx`/`node`/`git` shells while denying destructive commands and gating pushes, and its `resources` preload `requirements.md`, `design.md`, and all four steering files. The agent is purpose-built to stay inside the design's boundaries instead of relying on a generic assistant.

---

## Bonus 1 — Cloud sessions

This project was developed in a Kiro Web cloud session driven by the `repo-visualizer-dev` custom agent, so the work ran against the repo in the cloud with the agent's boundaries, permissions, and preloaded spec/steering context applied throughout.

## Bonus 2 — Power packaging

The `repo-visualizer` power's [`plugin.json`](.kiro/powers/repo-visualizer/plugin.json) conforms to the full Agent Plugins v1.0.0 spec: it declares the `$schema`, `name`, `version`, `description`, `author`, `repository`, `keywords`, and `license` fields, with `repository` pointing at the real project URL. That makes the power a valid, installable plugin rather than a loose folder of files.
