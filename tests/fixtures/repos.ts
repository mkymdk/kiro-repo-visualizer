/**
 * RepoAnalysisResult fixtures for the four repository shapes the storyboard
 * must handle (design.md Testing Strategy → Fixtures).
 *
 * - kiroRepo: README sections + `.kiro/specs` + releases + noisy PRs
 * - readmeOnlyRepo: README Features section, commits only
 * - thinRepo: one-line README, mixed commits (empty-anchor fallback path)
 * - hostileRepo: HTML metacharacters in every text field
 */

import type { Commit, PullRequest, Release, RepoAnalysisResult } from "../../src/types/index.js";

/** Build a commit fixture; `subject` doubles as `message`. */
export function commit(subject: string, timestamp: string, body = "", sha = subject): Commit {
  return { sha, author: "Dev", timestamp, subject, body, message: subject };
}

/** Build a merged pull request fixture. */
export function pr(
  number: number,
  title: string,
  mergedAt: string,
  opts: Partial<Pick<PullRequest, "body" | "labels" | "isBot">> = {},
): PullRequest {
  return { number, title, mergedAt, body: opts.body ?? "", labels: opts.labels ?? [], isBot: opts.isBot ?? false };
}

/** Build a release fixture. */
export function release(tagName: string, publishedAt: string, body = "", name: string | null = null): Release {
  return { tagName, publishedAt, body, name };
}

const TREE = [
  { path: "src", type: "tree" as const },
  { path: "tests", type: "tree" as const },
  { path: "README.md", type: "blob" as const, size: 900 },
  { path: "package.json", type: "blob" as const, size: 400 },
];

const KIRO_README = [
  "# Kiro Visualizer",
  "",
  "[![build](https://img.shields.io/badge/build-passing-green.svg)](https://ci.example)",
  "",
  "Kiro Visualizer turns a public GitHub repository into a short MP4 video that explains what the project does.",
  "",
  "## Features",
  "",
  "- **Storyboard generation** — Builds an ordered storyboard of slides from the README, specs, and history.",
  "- **Slide reordering**: Drag slides into a new order before rendering.",
  "- **Video rendering** - Encodes slides to H.264 MP4 with live progress.",
  "- Duration picker",
  "",
  "## How it works",
  "",
  "The analyzer fetches repository data from the GitHub API. The storyboard generator turns that data into slides. The renderer draws each slide and encodes the video.",
  "",
  "## Installation",
  "",
  "```bash",
  "# install dependencies",
  "npm install",
  "npm run dev",
  "```",
  "",
  "## License",
  "",
  "MIT",
].join("\n");

const KIRO_REQUIREMENTS = [
  "# Requirements Document",
  "",
  "### Requirement 1: Repository URL Input",
  "",
  "**User Story:** As a User, I want to submit a GitHub repository URL, so that the System can fetch it.",
  "",
  "### Requirement 2: Storyboard Preview",
  "",
  "**User Story:** As a User, I want to reorder storyboard slides, so that the video follows my narrative.",
  "",
  "### Requirement 3: Video Download",
  "",
  "**User Story:** As a User, I want to download a rendered video, so that I can share it.",
].join("\n");

const KIRO_DESIGN = [
  "# Design Document",
  "",
  "## Architecture",
  "",
  "The system has an analyzer, a storyboard generator, and a renderer. Each is a separate module.",
  "",
  "## Components and Interfaces",
  "",
  "### 1. Repository Analyzer (`src/server/analyzer.ts`)",
  "",
  "Owns all GitHub API communication.",
].join("\n");

/** Kiro-developed repository with README sections, specs, releases, and noisy PRs. */
export const kiroRepo: RepoAnalysisResult = {
  owner: "acme",
  repo: "kiro-visualizer",
  metadata: {
    description: "Turn a GitHub repository into a narrated video.",
    topics: ["video", "github", "kiro"],
    stars: 128,
    language: "TypeScript",
    license: "MIT",
  },
  directoryTree: TREE,
  readmeText: KIRO_README,
  commits: [
    commit("feat!: redesign storyboard pipeline (#15)", "2024-03-20T00:00:00Z"),
    commit("feat: add duration picker to export step (#10)", "2024-03-01T00:00:00Z"),
    commit("fix: slide reordering drops last slide", "2024-02-20T00:00:00Z"),
    commit("chore: bump deps", "2024-02-10T00:00:00Z"),
  ],
  specDocs: [
    { path: ".kiro/specs/visualizer/design.md", content: KIRO_DESIGN },
    { path: ".kiro/specs/visualizer/requirements.md", content: KIRO_REQUIREMENTS },
  ],
  pullRequests: [
    pr(10, "feat: add duration picker to export step", "2024-03-01T00:00:00Z"),
    pr(11, "Fix rendering crash on long titles", "2024-03-10T00:00:00Z", { labels: ["bug"] }),
    pr(12, "chore: update lint config", "2024-03-11T00:00:00Z"),
    pr(13, "Bump canvas from 2.11 to 2.12", "2024-03-12T00:00:00Z", { isBot: true }),
    pr(14, "docs: improve README", "2024-03-13T00:00:00Z"),
    pr(15, "feat!: redesign storyboard pipeline", "2024-03-20T00:00:00Z", {
      labels: ["breaking-change"],
      body: [
        "<!-- Please describe your change -->",
        "## Summary",
        "Replaces the single-pass generator with a staged storyboard pipeline. Also cleans up helpers.",
        "",
        "- [x] Tests added",
        "",
        "Co-authored-by: Ada <ada@example.com>",
      ].join("\n"),
    }),
    pr(16, "feat: add telemetry opt-in", "2024-03-21T00:00:00Z"),
    pr(17, "feat(deps): upgrade ffmpeg", "2024-03-22T00:00:00Z"),
  ],
  releases: [
    release("v1.1.1", "2024-04-05T00:00:00Z", "Patch: fixes a typo."),
    release("v1.1.0", "2024-04-01T00:00:00Z", "Adds the duration picker for exports."),
    release("v1.0.0", "2024-01-10T00:00:00Z", "First public release with storyboard generation and video rendering.", "1.0"),
  ],
  partialFailures: [],
};

/** Repository with a README Features section and commits only. */
export const readmeOnlyRepo: RepoAnalysisResult = {
  owner: "acme",
  repo: "tabler",
  metadata: { description: "Table utilities.", topics: [], stars: 3, language: "Go", license: null },
  directoryTree: TREE,
  readmeText: [
    "# tabler",
    "",
    "Small library for working with tabular data.",
    "",
    "## Features",
    "",
    "- **CSV export** — Export tables as CSV files.",
    "- **Filtering**: Filter rows by column value.",
  ].join("\n"),
  commits: [
    commit("refactor: simplify exporter module", "2024-05-05T00:00:00Z", "Splits the exporter into reader and writer stages.\n\nSigned-off-by: Dev <dev@example.com>"),
    commit("docs: add README badges", "2024-05-04T00:00:00Z"),
    commit("chore: bump deps", "2024-05-03T00:00:00Z"),
    commit("fix: csv export off-by-one", "2024-05-02T00:00:00Z"),
    commit("feat: add CSV export (#3)", "2024-05-01T00:00:00Z"),
    commit("Update dependencies", "2024-04-30T00:00:00Z"),
  ],
  specDocs: [],
  pullRequests: [],
  releases: [],
  partialFailures: [],
};

/** One-line README, no sections, no PRs or releases; exercises the empty-anchor fallback. */
export const thinRepo: RepoAnalysisResult = {
  owner: "acme",
  repo: "tiny",
  metadata: null,
  directoryTree: [{ path: "index.js", type: "blob", size: 100 }],
  readmeText: "# tiny\n\nA tiny tool.",
  commits: [
    commit("feat(deps): bump yargs", "2024-05-06T00:00:00Z"),
    commit("feat!: drop node 14", "2024-05-05T00:00:00Z"),
    commit("feat(cli): support --verbose flag", "2024-05-04T00:00:00Z", "Prints each step as it runs."),
    commit("fix: crash on empty input", "2024-05-03T00:00:00Z"),
    commit("Add colour support", "2024-05-02T00:00:00Z"),
    commit("feat: add json output", "2024-05-01T00:00:00Z"),
    commit("chore: release 0.2", "2024-04-30T00:00:00Z"),
    commit("docs: usage", "2024-04-29T00:00:00Z"),
  ],
  specDocs: [],
  pullRequests: [],
  releases: [],
  partialFailures: [],
};

/** Hostile text inserted into every field. Survives Markdown/HTML stripping. */
export const HOSTILE = `a < b && "c" > 'd'`;

/** Repository whose every text field contains HTML metacharacters. */
export const hostileRepo: RepoAnalysisResult = {
  owner: "acme",
  repo: "hostile",
  metadata: {
    description: `Desc ${HOSTILE}`,
    topics: [`topic ${HOSTILE}`],
    stars: 1,
    language: `Lang ${HOSTILE}`,
    license: `Lic ${HOSTILE}`,
  },
  directoryTree: [
    { path: `dir ${HOSTILE}`, type: "tree" },
    { path: `file ${HOSTILE}`, type: "blob", size: 1 },
  ],
  readmeText: [
    "# hostile",
    "",
    `Intro rendering ${HOSTILE}.`,
    "",
    "## Capabilities",
    "",
    `- Render slides ${HOSTILE}`,
    "",
    "## Installation",
    "",
    "```",
    `npm install ${HOSTILE}`,
    "```",
    "",
    "## How it works",
    "",
    `The renderer draws ${HOSTILE}.`,
    "",
    "## Features",
    "",
    `- **Renderer ${HOSTILE}** — Draws slides ${HOSTILE}.`,
    `- Exporter ${HOSTILE}`,
  ].join("\n"),
  commits: [commit(`feat: renderer ${HOSTILE}`, "2024-01-03T00:00:00Z", `Renderer body ${HOSTILE}.`)],
  specDocs: [{ path: ".kiro/specs/h/design.md", content: `# Design ${HOSTILE}\n\n## Architecture\n\nRenderer ${HOSTILE}.` }],
  pullRequests: [
    pr(1, `feat: renderer ${HOSTILE}`, "2024-01-01T00:00:00Z", { body: `Renderer context ${HOSTILE}.` }),
    pr(2, `feat: exporter ${HOSTILE}`, "2024-01-02T00:00:00Z"),
  ],
  releases: [release(`v1.0.0`, "2024-01-04T00:00:00Z", `Renderer notes ${HOSTILE}.`, `Name ${HOSTILE}`)],
  partialFailures: [],
};

/** All four fixtures by name. */
export const ALL_FIXTURES: Record<string, RepoAnalysisResult> = {
  kiroRepo,
  readmeOnlyRepo,
  thinRepo,
  hostileRepo,
};
