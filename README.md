# GitHub Repository Visualizer

A React single-page application with an Express/TypeScript backend that turns any public GitHub repository into a downloadable MP4 video.

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
├── tests/
│   ├── analyzer.test.ts           # Unit tests for analyzer (35 tests)
│   ├── storyboard.test.ts         # Unit tests for storyboard (38 tests)
│   ├── renderer.test.ts           # Unit tests for renderer (16 tests)
│   └── integration.test.ts        # Supertest integration tests (28 tests)
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
