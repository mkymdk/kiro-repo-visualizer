/**
 * Unit and property tests for src/server/storyboard.ts
 *
 * Pure module — no I/O, no mocking needed. Fixtures live in tests/fixtures/repos.ts.
 */

import { describe, it, expect } from "vitest";
import {
  htmlEscape,
  truncateToWords,
  toPlainText,
  firstSentences,
  findSection,
  firstParagraph,
  buildIntroSlide,
  extractCapabilities,
  capabilitiesOverlapFeatures,
  buildRunSlide,
  buildArchitectureSlide,
  extractHowItWorks,
  parseFeatureItem,
  extractKeyFeatures,
  buildFeatureSlides,
  buildConclusionSlide,
  relevanceTokens,
  buildAnchorTerms,
  isRelevant,
  extractChangeContext,
  categoryFromTitle,
  categorizePullRequest,
  rankSignificantPullRequests,
  isPatchRelease,
  selectHighlightCommits,
  buildEvolutionSlides,
  buildChangeGroups,
  walkWindow,
  selectDeepDivePullRequests,
  prsNeedingEvidence,
  generateStoryboard,
  KeyFeature,
} from "../src/server/storyboard.js";
import { SLIDE_CONFIG } from "../src/config/output.js";
import type { Commit, PullRequest, RepoAnalysisResult, Slide, SlideType, SpecDocument } from "../src/types/index.js";
import {
  ALL_FIXTURES,
  HOSTILE,
  commit,
  hostileRepo,
  kiroRepo,
  pr,
  readmeOnlyRepo,
  release,
  thinRepo,
} from "./fixtures/repos.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal analysis result; override per test. */
function makeResult(overrides: Partial<RepoAnalysisResult> = {}): RepoAnalysisResult {
  return {
    owner: "testowner",
    repo: "testrepo",
    metadata: null,
    directoryTree: [
      { path: "src", type: "tree" },
      { path: "README.md", type: "blob", size: 100 },
    ],
    readmeText: "# Hello\n\nThis is a test repository.",
    commits: [],
    specDocs: [],
    pullRequests: [],
    releases: [],
    partialFailures: [],
    ...overrides,
  };
}

/** Decode the storyboard's HTML escaping. */
function decode(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Slides without ids, for equality comparisons. */
function strip(slides: Slide[]): Omit<Slide, "id">[] {
  return slides.map(({ id: _id, ...rest }) => rest);
}

const EVOLUTION_TYPES: ReadonlySet<SlideType> = new Set(["evolution", "change", "highlight"]);
const CANONICAL: SlideType[] = [
  "intro", "capabilities", "run", "architecture", "howItWorks",
  "feature", "evolution", "change", "highlight", "conclusion",
];

/** Anchor terms exactly as generateStoryboard derives them. */
function anchorsFor(result: RepoAnalysisResult): Set<string> {
  const how = extractHowItWorks(result.readmeText, result.specDocs);
  return buildAnchorTerms(
    extractCapabilities(result.readmeText, result.specDocs),
    extractKeyFeatures(result.readmeText, result.specDocs).map((f) => f.name),
    how?.headings ?? [],
  );
}

// ---------------------------------------------------------------------------
// Text and Markdown helpers
// ---------------------------------------------------------------------------

describe("text helpers", () => {
  it("htmlEscape escapes & < > \" ' with & first", () => {
    expect(htmlEscape(`<a href="x">it's & more</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;it&#39;s &amp; more&lt;/a&gt;",
    );
  });

  it("truncateToWords appends an ellipsis only when truncating", () => {
    expect(truncateToWords("one two three", 3)).toBe("one two three");
    expect(truncateToWords("one two three four", 3)).toBe("one two three…");
    expect(truncateToWords("   ", 3)).toBe("");
  });

  it("toPlainText reduces links, images, emphasis, code, and tags; keeps snake_case", () => {
    expect(toPlainText("See [the docs](https://x) and ![logo](l.png) for **bold** `code` <b>tag</b> my_var"))
      .toBe("See the docs and logo for bold code tag my_var");
  });

  it("firstSentences splits on terminal punctuation followed by a capital", () => {
    expect(firstSentences("One thing. Two e.g. three! Four", 3)).toEqual(["One thing.", "Two e.g. three!", "Four"]);
  });

  it("findSection ignores headings inside fenced code blocks", () => {
    const md = "# Title\n```bash\n# Installation\n```\n## Setup\nreal";
    expect(findSection(md, /^installation\b/i)).toBeNull();
    expect(findSection(md, /^setup\b/i)?.heading).toBe("Setup");
  });

  it("findSection matches headings with a leading emoji", () => {
    expect(findSection("## ✨ Features\n- a", /^features\b/i)?.heading).toBe("✨ Features");
  });

  it("firstParagraph skips headings, badges, images, and HTML lines", () => {
    const md = [
      "# Title",
      "[![ci](https://b/ci.svg)](https://ci) [![npm](https://b/n.svg)](https://npm)",
      '<p align="center"><img src="x.png"></p>',
      "",
      "The real first paragraph",
      "continues here.",
      "",
      "Second paragraph.",
    ].join("\n");
    expect(firstParagraph(md)).toBe("The real first paragraph continues here.");
  });
});

// ---------------------------------------------------------------------------
// Overview (Req 5.1, 5.2)
// ---------------------------------------------------------------------------

describe("buildIntroSlide", () => {
  it("combines description, topics, and the first README paragraph", () => {
    const slide = buildIntroSlide("repo", "# repo\n\nDoes a thing.", {
      description: "Short desc", topics: ["a", "b"], stars: 1, language: null, license: null,
    });
    expect(slide.type).toBe("intro");
    expect(slide.title).toBe("repo");
    expect(decode(slide.body)).toBe("Short desc\n\nTopics: a, b\n\nDoes a thing.");
  });

  it(`truncates the README paragraph to SLIDE_CONFIG.introMaxWords (${SLIDE_CONFIG.introMaxWords})`, () => {
    const long = Array.from({ length: SLIDE_CONFIG.introMaxWords + 40 }, (_, i) => `w${i}`).join(" ");
    const slide = buildIntroSlide("repo", `# repo\n\n${long}`);
    const words = slide.body.split(/\s+/);
    expect(words).toHaveLength(SLIDE_CONFIG.introMaxWords);
    expect(slide.body.endsWith("…")).toBe(true);
  });

  it("does not repeat the paragraph when it equals the description", () => {
    const slide = buildIntroSlide("repo", "# repo\n\nSame text.", {
      description: "Same text.", topics: [], stars: null, language: null, license: null,
    });
    expect(decode(slide.body)).toBe("Same text.");
  });

  it("falls back to 'No description available.' when there is no description or paragraph", () => {
    expect(buildIntroSlide("repo", null).body).toBe("No description available.");
    expect(buildIntroSlide("repo", "# repo\n## Only headings").body).toBe("No description available.");
  });

  it(`previewSummary is capped at SLIDE_CONFIG.previewMaxWords (${SLIDE_CONFIG.previewMaxWords})`, () => {
    const long = Array.from({ length: 100 }, (_, i) => `w${i}`).join(" ");
    const slide = buildIntroSlide("repo", long);
    expect(slide.previewSummary.split(/\s+/).length).toBeLessThanOrEqual(SLIDE_CONFIG.previewMaxWords);
  });
});

// ---------------------------------------------------------------------------
// Capabilities (Req 5.3–5.6)
// ---------------------------------------------------------------------------

describe("extractCapabilities", () => {
  it("uses README capabilities list items first", () => {
    const md = "# x\n## What it does\n- Convert **files**\n- Merge [PDFs](u)\n";
    expect(extractCapabilities(md, [])).toEqual(["Convert files", "Merge PDFs"]);
  });

  it("falls back to sentences of a capabilities section without a list", () => {
    const md = "## Use Cases\nPlan trips. Share itineraries.";
    expect(extractCapabilities(md, [])).toEqual(["Plan trips.", "Share itineraries."]);
  });

  it("falls back to spec user stories (the 'I want' clause) in document order", () => {
    expect(extractCapabilities("# x", kiroRepo.specDocs)).toEqual([
      "Submit a GitHub repository URL",
      "Reorder storyboard slides",
      "Download a rendered video",
    ]);
  });

  it("never treats a Usage section as capabilities", () => {
    expect(extractCapabilities("## Usage\n- run the thing", [])).toEqual([]);
  });

  it(`caps items at capabilitiesMaxItems (${SLIDE_CONFIG.capabilitiesMaxItems}) and words at capabilityMaxWords (${SLIDE_CONFIG.capabilityMaxWords})`, () => {
    const longItem = Array.from({ length: SLIDE_CONFIG.capabilityMaxWords + 5 }, (_, i) => `w${i}`).join(" ");
    const items = Array.from({ length: SLIDE_CONFIG.capabilitiesMaxItems + 3 }, (_, i) => `- item ${i} ${longItem}`);
    const caps = extractCapabilities(`## Capabilities\n${items.join("\n")}`, []);
    expect(caps).toHaveLength(SLIDE_CONFIG.capabilitiesMaxItems);
    for (const c of caps) expect(c.split(/\s+/).length).toBeLessThanOrEqual(SLIDE_CONFIG.capabilityMaxWords);
  });
});

describe("capabilitiesOverlapFeatures (Property 12)", () => {
  const f = (name: string, description: string | null = null): KeyFeature => ({ name, description });

  it("is false below and at the ratio, true above it", () => {
    const features = [f("Export CSV"), f("Filter rows")];
    // 1 of 2 = 0.5 → not above the ratio
    expect(capabilitiesOverlapFeatures(["Export CSV", "Plan trips"], features)).toBe(false);
    // 2 of 3 > 0.5
    expect(capabilitiesOverlapFeatures(["Export CSV", "Filter rows", "Plan trips"], features)).toBe(true);
    // 0 of 2
    expect(capabilitiesOverlapFeatures(["Plan trips", "Share"], features)).toBe(false);
  });

  it("matches on containment in either direction, ignoring case and punctuation", () => {
    expect(capabilitiesOverlapFeatures(["export csv!"], [f("CSV", "Export CSV files quickly")])).toBe(true);
  });

  it("omits the Capabilities slide from the storyboard when redundant", () => {
    const readme = "# x\n## Capabilities\n- Export CSV\n- Filter rows\n## Features\n- **Export CSV**: writes files\n- **Filter rows**: by column";
    const types = generateStoryboard(makeResult({ readmeText: readme })).map((s) => s.type);
    expect(types).not.toContain("capabilities");
    expect(types).toContain("feature");
  });
});

// ---------------------------------------------------------------------------
// Run instructions (Req 5.7–5.11)
// ---------------------------------------------------------------------------

describe("buildRunSlide", () => {
  for (const heading of ["Installation", "Getting Started", "Setup", "Usage", "Quick Start"]) {
    it(`matches the "${heading}" heading (case-insensitive)`, () => {
      const slide = buildRunSlide(`# P\n\n## ${heading.toLowerCase()}\nRun npm start.`);
      expect(slide?.type).toBe("run");
      expect(slide?.title.toLowerCase()).toContain(heading.toLowerCase());
    });
  }

  it("returns null without a README or a matching heading", () => {
    expect(buildRunSlide(null)).toBeNull();
    expect(buildRunSlide("   ")).toBeNull();
    expect(buildRunSlide("# P\n## Overview\ntext")).toBeNull();
  });

  it("prefers the first fenced code block over prose", () => {
    const slide = buildRunSlide("## Installation\nIntro prose.\n```bash\nnpm install\nnpm run build\n```\nTrailing.");
    expect(slide?.body).toBe("npm install\nnpm run build");
  });

  it("falls back to prose lines and selects the first matching section", () => {
    const slide = buildRunSlide("## Usage\nusage-first\n## Installation\nsecond");
    expect(slide?.title).toBe("How to run: Usage");
    expect(slide?.body).toBe("usage-first");
  });

  it(`caps steps at runMaxSteps (${SLIDE_CONFIG.runMaxSteps}) and words at runMaxWordsPerStep (${SLIDE_CONFIG.runMaxWordsPerStep})`, () => {
    const lines = Array.from({ length: SLIDE_CONFIG.runMaxSteps + 4 }, (_, i) => `cmd-${i}`);
    expect(buildRunSlide(["## Setup", "```", ...lines, "```"].join("\n"))!.body.split("\n")).toHaveLength(SLIDE_CONFIG.runMaxSteps);
    const long = Array.from({ length: SLIDE_CONFIG.runMaxWordsPerStep + 5 }, (_, i) => `w${i}`).join(" ");
    const step = buildRunSlide(`## Usage\n${long}`)!.body;
    expect(step.split(/\s+/)).toHaveLength(SLIDE_CONFIG.runMaxWordsPerStep);
    expect(step.endsWith("…")).toBe(true);
  });

  it("is positioned after Capabilities when present, otherwise after the overview", () => {
    const withCaps = generateStoryboard(makeResult({ readmeText: "# x\n## What it does\n- Plan trips\n## Setup\nnpm i" }));
    expect(withCaps.map((s) => s.type).slice(0, 4)).toEqual(["intro", "capabilities", "run", "architecture"]);
    const without = generateStoryboard(makeResult({ readmeText: "# x\n## Setup\nnpm i" }));
    expect(without.map((s) => s.type).slice(0, 3)).toEqual(["intro", "run", "architecture"]);
  });
});

// ---------------------------------------------------------------------------
// Architecture and how it works (Req 6.1–6.4)
// ---------------------------------------------------------------------------

describe("buildArchitectureSlide", () => {
  it("lists top-level entries only, directories first", () => {
    const slide = buildArchitectureSlide("repo", [
      { path: "README.md", type: "blob" },
      { path: "src", type: "tree" },
      { path: "src/index.ts", type: "blob" },
    ]);
    expect(slide.body).toBe("repo/\n├── src/\n└── README.md");
  });

  it("uses placeholder text for an empty tree", () => {
    expect(buildArchitectureSlide("repo", []).body).toBe("No directory structure available.");
  });
});

describe("extractHowItWorks", () => {
  const design: SpecDocument = {
    path: ".kiro/specs/a/design.md",
    content: "# Design Doc\n## Architecture\nLayered system. Uses queues.\n## Data Models\nx",
  };
  const reqs: SpecDocument = { path: ".kiro/specs/a/requirements.md", content: "# Reqs\n## Glossary\nx" };

  it("prefers the README section when it has prose", () => {
    const how = extractHowItWorks("## How it works\nIt parses. It renders.", [design]);
    expect(how?.body).toBe("How it works\n\nIt parses. It renders.");
  });

  it("falls back to spec docs (design.md first) when the README has no section", () => {
    const how = extractHowItWorks("# x", [reqs, design]);
    expect(how?.body.split("\n")[0]).toBe("Design Doc");
    expect(how?.body).toContain("• Architecture");
    expect(how?.body).toContain("Layered system. Uses queues.");
  });

  it("falls back to specs when the README section has no prose", () => {
    const how = extractHowItWorks("## Architecture\n![diagram](d.png)", [design]);
    expect(how?.body.split("\n")[0]).toBe("Design Doc");
  });

  it(`caps headings at specMaxHeadings (${SLIDE_CONFIG.specMaxHeadings}) and sentences at specMaxSentences (${SLIDE_CONFIG.specMaxSentences})`, () => {
    const many = Array.from({ length: 8 }, (_, i) => `## Design ${i}\nSentence ${i}a. Sentence ${i}b.`).join("\n");
    const how = extractHowItWorks(null, [{ path: ".kiro/specs/x/design.md", content: many }])!;
    expect((how.body.match(/•/g) ?? []).length).toBe(SLIDE_CONFIG.specMaxHeadings);
    expect(how.body.split("\n").pop()!.split(/(?<=\.)\s/)).toHaveLength(SLIDE_CONFIG.specMaxSentences);
  });

  it("returns null without any source", () => {
    expect(extractHowItWorks("# x", [])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Key features (Req 6.5–6.9)
// ---------------------------------------------------------------------------

describe("parseFeatureItem", () => {
  it.each([
    ["**Fast** — Very quick.", "Fast", "Very quick."],
    ["**Fast**: Very quick.", "Fast", "Very quick."],
    ["**Fast** - Very quick.", "Fast", "Very quick."],
    ["Fast: Very quick.", "Fast", "Very quick."],
    ["Fast — Very quick.", "Fast", "Very quick."],
    ["Drag-and-drop reordering", "Drag-and-drop reordering", null],
    ["**Offline mode**", "Offline mode", null],
  ])("parses %j", (item, name, description) => {
    expect(parseFeatureItem(item)).toEqual({ name, description });
  });
});

describe("extractKeyFeatures / buildFeatureSlides", () => {
  it("uses README features first", () => {
    expect(extractKeyFeatures(readmeOnlyRepo.readmeText, [])).toEqual([
      { name: "CSV export", description: "Export tables as CSV files." },
      { name: "Filtering", description: "Filter rows by column value." },
    ]);
  });

  it("falls back to design Components subheadings with their first sentence", () => {
    const features = extractKeyFeatures("# x", kiroRepo.specDocs);
    expect(features).toEqual([{ name: "Repository Analyzer", description: "Owns all GitHub API communication." }]);
  });

  it("falls back to requirement titles as name-only features", () => {
    const reqsOnly = kiroRepo.specDocs.filter((d) => d.path.endsWith("requirements.md"));
    expect(extractKeyFeatures(null, reqsOnly).map((f) => f.name)).toEqual([
      "Repository URL Input",
      "Storyboard Preview",
      "Video Download",
    ]);
  });

  it("puts name-only features on a single summary slide after the individual slides", () => {
    const slides = buildFeatureSlides([
      { name: "A", description: "Does a." },
      { name: "B", description: null },
      { name: "C", description: null },
    ]);
    expect(slides.map((s) => s.title)).toEqual(["Feature: A", "Key features"]);
    expect(slides[1]!.body).toBe("• B\n• C");
  });

  it(`never exceeds maxFeatureSlides (${SLIDE_CONFIG.maxFeatureSlides}); summary is dropped when described features fill it`, () => {
    const described = Array.from({ length: 9 }, (_, i) => ({ name: `F${i}`, description: `Desc ${i}.` }));
    const slides = buildFeatureSlides([...described, { name: "N", description: null }]);
    expect(slides).toHaveLength(SLIDE_CONFIG.maxFeatureSlides);
    expect(slides.every((s) => s.title.startsWith("Feature: "))).toBe(true);
  });

  it("produces one summary slide, not many, for 20 requirement titles", () => {
    const content = Array.from({ length: 20 }, (_, i) => `### Requirement ${i + 1}: Title ${i}`).join("\n");
    const slides = buildFeatureSlides(extractKeyFeatures(null, [{ path: ".kiro/specs/a/requirements.md", content }]));
    expect(slides).toHaveLength(1);
    expect(slides[0]!.title).toBe("Key features");
  });

  it("emits no feature slides without a source", () => {
    expect(buildFeatureSlides(extractKeyFeatures("# x", []))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Relevance and Change_Context
// ---------------------------------------------------------------------------

describe("anchor terms and relevance", () => {
  it(`drops short tokens (< ${SLIDE_CONFIG.relevanceMinTermLength}) and generic words`, () => {
    expect(relevanceTokens("Add the new Renderer feature for users with CSV")).toEqual(["renderer"]);
  });

  it("builds anchors from current-state inputs only", () => {
    expect([...buildAnchorTerms(["Export tables"], ["Filtering"], ["How it works"])].sort()).toEqual([
      "export", "filtering", "tables",
    ]);
  });

  it("matches identical tokens and prefixes in either direction", () => {
    const anchors = new Set(["render", "exporter"]);
    expect(isRelevant("improve rendering speed", anchors)).toBe(true);
    expect(isRelevant("export to disk", anchors)).toBe(true);
    expect(isRelevant("update telemetry", anchors)).toBe(false);
    expect(isRelevant("anything", new Set())).toBe(false);
  });
});

describe("extractChangeContext", () => {
  it("strips comments, headings, checklists, trailers, and code fences", () => {
    const body = [
      "<!-- template\nmulti-line -->",
      "## Summary",
      "- [x] Tests added",
      "```",
      "code();",
      "```",
      "Adds streaming output. Also other things.",
      "",
      "Co-authored-by: A <a@x>",
      "Signed-off-by: B <b@x>",
      "Closes #12",
    ].join("\n");
    expect(extractChangeContext(body)).toBe("Adds streaming output.");
  });

  it("keeps prose lines that merely contain a colon", () => {
    expect(extractChangeContext("Note: this adds retries.")).toBe("Note: this adds retries.");
  });

  it(`truncates to changeContextMaxWords (${SLIDE_CONFIG.changeContextMaxWords})`, () => {
    const long = Array.from({ length: 50 }, (_, i) => `w${i}`).join(" ");
    const ctx = extractChangeContext(long)!;
    expect(ctx.split(/\s+/)).toHaveLength(SLIDE_CONFIG.changeContextMaxWords);
  });

  it("returns null for template-only bodies", () => {
    expect(extractChangeContext("<!-- describe -->\n## Checklist\n- [ ] done\n**Description**")).toBeNull();
    expect(extractChangeContext("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Classification (Req 7.1–7.3)
// ---------------------------------------------------------------------------

describe("categorization", () => {
  it("uses labels, then conventional prefix, then the earliest keyword", () => {
    expect(categorizePullRequest(pr(1, "feat: x", "t", { labels: ["bug"] }))).toBe("Bug Fix");
    expect(categorizePullRequest(pr(1, "fix: x", "t", { labels: ["breaking"] }))).toBe("Breaking Change");
    expect(categorizePullRequest(pr(1, "refactor(core)!: x", "t"))).toBe("Breaking Change");
    expect(categorizePullRequest(pr(1, "fix: add guard", "t"))).toBe("Bug Fix");
    expect(categorizePullRequest(pr(1, "Refactor then add cache", "t"))).toBe("Refactor");
    expect(categorizePullRequest(pr(1, "perf: add cache", "t"))).toBe("Feature");
    expect(categorizePullRequest(pr(1, "Tidy up", "t"))).toBeNull();
    expect(categoryFromTitle("Implement login")).toBe("Feature");
  });

  it("excludes bots, maintenance types, dependency wording, and uncategorizable PRs", () => {
    const ranked = rankSignificantPullRequests([
      pr(1, "feat: bot thing", "2024-01-01", { isBot: true }),
      pr(2, "chore: x", "2024-01-01"),
      pr(3, "docs(readme): add section", "2024-01-01"),
      pr(4, "Bump lodash", "2024-01-01", { labels: ["feature"] }),
      pr(5, "feat: update dependencies", "2024-01-01"),
      pr(6, "Tidy up", "2024-01-01"),
      pr(7, "feat: real", "2024-01-01"),
    ]);
    expect(ranked.map((r) => r.pr.number)).toEqual([7]);
  });

  it("ranks by category then newest merge", () => {
    const ranked = rankSignificantPullRequests([
      pr(1, "refactor: a", "2024-05-01"),
      pr(2, "fix: b", "2024-05-01"),
      pr(3, "feat: c", "2024-01-01"),
      pr(4, "feat: d", "2024-03-01"),
      pr(5, "feat!: e", "2023-01-01"),
    ]);
    expect(ranked.map((r) => r.pr.number)).toEqual([5, 4, 3, 2, 1]);
  });

  it("detects patch releases", () => {
    expect(isPatchRelease(release("v1.2.3", "t"))).toBe(true);
    expect(isPatchRelease(release("1.2.0", "t"))).toBe(false);
    expect(isPatchRelease(release("v2.0.0-rc.1", "t"))).toBe(false);
    expect(isPatchRelease(release("2024-05", "t"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Evolution allocation (Req 7.4–7.14)
// ---------------------------------------------------------------------------

describe("buildEvolutionSlides", () => {
  const anchors = new Set(["export", "filter"]);
  const base = makeResult();

  it(`needs at least minEvolutionItems (${SLIDE_CONFIG.minEvolutionItems}) entries for a timeline`, () => {
    const one = buildEvolutionSlides({ ...base, releases: [release("v1.0.0", "2024-01-01T00:00:00Z")] }, anchors);
    expect(one.some((s) => s.type === "evolution")).toBe(false);
    const two = buildEvolutionSlides(
      { ...base, releases: [release("v1.0.0", "2024-01-01T00:00:00Z"), release("v2.0.0", "2024-06-01T00:00:00Z")] },
      anchors,
    );
    expect(two.filter((s) => s.type === "evolution")).toHaveLength(1);
  });

  it(`lists at most maxEvolutionItems (${SLIDE_CONFIG.maxEvolutionItems}) entries, releases first, shown oldest → newest`, () => {
    const releases = Array.from({ length: 5 }, (_, i) => release(`v${i + 1}.0.0`, `2024-0${i + 1}-01T00:00:00Z`));
    const prs = Array.from({ length: 10 }, (_, i) => pr(i + 1, `feat: export v${i}`, `2023-0${(i % 9) + 1}-15T00:00:00Z`));
    const [timeline] = buildEvolutionSlides({ ...base, releases, pullRequests: prs }, anchors);
    const lines = decode(timeline!.body).split("\n");
    expect(lines).toHaveLength(SLIDE_CONFIG.maxEvolutionItems);
    expect(lines.filter((l) => l.includes("· Release ·"))).toHaveLength(5);
    expect([...lines].sort()).toEqual(lines);
  });

  it("excludes patch releases from the timeline and from deep dives", () => {
    const slides = buildEvolutionSlides(
      { ...base, releases: [release("v1.0.1", "2024-01-01T00:00:00Z", "Export fix."), release("v1.0.2", "2024-02-01T00:00:00Z", "Export fix.")] },
      anchors,
    );
    expect(slides).toEqual([]);
  });

  it("shows relevant bug-fix PRs on the timeline but never as deep dives", () => {
    const slides = buildEvolutionSlides(
      { ...base, pullRequests: [pr(1, "fix: export crash", "2024-01-01T00:00:00Z"), pr(2, "fix: filter crash", "2024-02-01T00:00:00Z")] },
      anchors,
    );
    expect(slides.map((s) => s.type)).toEqual(["evolution"]);
    expect(decode(slides[0]!.body)).toContain("Bug Fix · fix: export crash");
  });

  it("uses release deep dives only when PR deep dives fall short, and only with relevant notes", () => {
    const releases = [
      release("v2.0.0", "2024-06-01T00:00:00Z", "Adds export to PDF."),
      release("v1.0.0", "2024-01-01T00:00:00Z", "Initial telemetry release."),
    ];
    const withoutPrs = buildEvolutionSlides({ ...base, releases }, anchors);
    expect(withoutPrs.filter((s) => s.type === "change").map((s) => s.title)).toEqual(["Release · v2.0.0"]);

    const prs = [1, 2, 3].map((n) => pr(n, `feat: export ${n}`, `2024-0${n}-01T00:00:00Z`));
    const withPrs = buildEvolutionSlides({ ...base, releases, pullRequests: prs }, anchors);
    expect(withPrs.filter((s) => s.type === "change").every((s) => !s.title.startsWith("Release"))).toBe(true);
  });

  it("omits the context line when a PR body has no Change_Context", () => {
    const slides = buildEvolutionSlides({ ...base, pullRequests: [pr(9, "feat: export", "2024-01-01T00:00:00Z", { body: "<!-- x -->" })] }, anchors);
    expect(slides.find((s) => s.type === "change")!.body).toBe("Merged 2024-01-01");
  });

  it(`never exceeds maxEvolutionSlides (${SLIDE_CONFIG.maxEvolutionSlides})`, () => {
    const prs = Array.from({ length: 30 }, (_, i) => pr(i, `feat: export ${i}`, `2024-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`));
    const commits = Array.from({ length: 20 }, (_, i) => commit(`feat: filter ${i}`, "2024-01-01T00:00:00Z"));
    expect(buildEvolutionSlides({ ...base, pullRequests: prs, commits }, anchors).length).toBe(SLIDE_CONFIG.maxEvolutionSlides);
  });
});

/** Select highlights with groups built from the given commits (and PRs). */
function sel(commits: Commit[], anchors: ReadonlySet<string>, blocked: ReadonlySet<string> = new Set(), prs: PullRequest[] = []) {
  return selectHighlightCommits(commits, anchors, buildChangeGroups(commits, prs), blocked);
}

describe("selectHighlightCommits", () => {
  const anchors = new Set(["export"]);

  it("relevant path: keyword + relevant + not Bug Fix + not blocked + not a merge commit, in commit order", () => {
    const picked = sel(
      [
        commit("feat: export pdf (#4)", "2024-01-05", "", "a5", ["a4"]),
        commit("fix: export crash", "2024-01-04", "", "a4", ["a3"]),
        commit("feat: telemetry", "2024-01-03", "", "a3", ["a2"]),
        commit("refactor: exporter", "2024-01-02", "", "a2", ["a1"]),
        commit("feat: export merge wrapper", "2024-01-01", "", "a1", ["x", "y"]),
      ],
      anchors,
      new Set(["a5"]),
    );
    expect(picked.map((p) => p.commit.subject)).toEqual(["refactor: exporter"]);
  });

  it("does not use subject text: a (#N) suffix alone never excludes a commit", () => {
    const picked = sel([commit("feat: export pdf (#4)", "t", "", "s1")], anchors, new Set());
    expect(picked).toHaveLength(1);
  });

  it("uses the commit body's Change_Context when present", () => {
    const [h] = sel([commit("feat: export", "t", "Adds export.\n\nSigned-off-by: x")], anchors);
    expect(h?.context).toBe("Adds export.");
  });

  describe("empty-anchor fallback (Req 7.14)", () => {
    const none = new Set<string>();

    it("accepts only conventional feat commits, most recent first, capped", () => {
      const picked = sel(thinRepo.commits, none);
      expect(picked.map((p) => p.commit.subject)).toEqual(["feat!: drop node 14", "feat(cli): support --verbose flag"]);
      expect(picked.length).toBeLessThanOrEqual(SLIDE_CONFIG.maxFallbackHighlights);
    });

    it.each([
      "fix: crash",
      "docs: usage",
      "chore: release",
      "feat(deps): bump yargs",
      "feat: update dependencies",
      "Add colour support",
      "Implement feature flags",
      "refactor: core",
      "perf: faster",
      "feature: not conventional",
    ])("rejects %j", (subject) => {
      expect(sel([commit(subject, "2024-01-01")], none)).toEqual([]);
    });

    it.each(["feat: a", "feat(scope): a", "feat!: a", "feat(scope)!: a", "FEAT: a"])("accepts %j", (subject) => {
      expect(sel([commit(subject, "2024-01-01")], none)).toHaveLength(1);
    });

    it("excludes feat commits that belong to a Selected_PR (blocked), and merge commits", () => {
      expect(sel([commit("feat: a (#3)", "t", "", "s3")], none, new Set(["s3"]))).toEqual([]);
      expect(sel([commit("feat: merge", "t", "", "m", ["p", "q"])], none)).toEqual([]);
    });

    it("selects at most one fallback highlight per Change_Group; the cap counts after the group rule", () => {
      // M merges branch b2←b1 onto base r; both branch commits are feat:, one group.
      const commits = [
        commit("Merge pull request #5", "2024-01-05", "", "M", ["r", "b2"]),
        commit("feat: two", "2024-01-04", "", "b2", ["b1"]),
        commit("feat: one", "2024-01-03", "", "b1", ["r"]),
        commit("feat: base", "2024-01-02", "", "r", []),
      ];
      expect(sel(commits, none).map((p) => p.commit.sha)).toEqual(["b2", "r"]);
    });

    it("produces no timeline or deep dives from commits and stays within the evolution budget", () => {
      const slides = generateStoryboard(thinRepo);
      const evo = slides.filter((s) => EVOLUTION_TYPES.has(s.type));
      expect(evo.map((s) => s.type)).toEqual(["highlight", "highlight"]);
    });
  });
});

// ---------------------------------------------------------------------------
// Assembly and conclusion
// ---------------------------------------------------------------------------

describe("buildConclusionSlide", () => {
  it("includes stars, language, and license when metadata is available", () => {
    const slide = buildConclusionSlide("o", "r", { description: null, topics: [], stars: 0, language: "Go", license: "MIT" });
    expect(decode(slide.body)).toBe("Repository: o/r\nURL: https://github.com/o/r\nStars: 0 · Language: Go · License: MIT");
  });

  it("omits metadata facts when unavailable", () => {
    expect(buildConclusionSlide("o", "r").body).toBe("Repository: o/r\nURL: https://github.com/o/r");
  });
});

describe("generateStoryboard", () => {
  it("produces the minimal intro → architecture → conclusion storyboard for a bare repo", () => {
    expect(generateStoryboard(makeResult()).map((s) => s.type)).toEqual(["intro", "architecture", "conclusion"]);
  });

  it("gives every slide a unique v4 UUID", () => {
    const slides = generateStoryboard(kiroRepo);
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(new Set(slides.map((s) => s.id)).size).toBe(slides.length);
    for (const s of slides) expect(s.id).toMatch(UUID_RE);
  });

  it("produces the expected storyboard for the Kiro fixture", () => {
    expect(generateStoryboard(kiroRepo).map((s) => `${s.type}:${decode(s.title)}`)).toEqual([
      "intro:kiro-visualizer",
      "capabilities:What you can do",
      "run:How to run: Installation",
      "architecture:Architecture: kiro-visualizer",
      "howItWorks:How it works",
      "feature:Feature: Storyboard generation",
      "feature:Feature: Slide reordering",
      "feature:Feature: Video rendering",
      "feature:Key features",
      "evolution:How it evolved",
      "change:Breaking Change · feat!: redesign storyboard pipeline (#15)",
      "change:Feature · feat: add duration picker to export step (#10)",
      "change:Release · v1.1.0",
      "conclusion:Conclusion: kiro-visualizer",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Properties over the four fixtures
// ---------------------------------------------------------------------------

/** Add history that must never produce evolution slides. */
function withNoise(result: RepoAnalysisResult): RepoAnalysisResult {
  return {
    ...result,
    pullRequests: [
      ...result.pullRequests,
      pr(901, "feat: zebra mode", "2025-01-01T00:00:00Z"),
      pr(902, "chore: tidy zebra", "2025-01-02T00:00:00Z", { labels: ["feature"] }),
      pr(903, "docs: zebra guide", "2025-01-03T00:00:00Z"),
      pr(904, "Bump zebra-lib", "2025-01-04T00:00:00Z", { isBot: true }),
      pr(905, "feat(deps): zebra", "2025-01-05T00:00:00Z"),
    ],
    releases: [...result.releases, release("v9.9.9", "2025-02-01T00:00:00Z", "Zebra patch.")],
    commits: [
      commit("fix: zebra crash", "2025-03-01T00:00:00Z"),
      commit("docs: zebra", "2025-03-02T00:00:00Z"),
      commit("chore: bump zebra", "2025-03-03T00:00:00Z"),
      ...result.commits,
    ],
  };
}

describe.each(Object.entries(ALL_FIXTURES))("properties: %s", (_name, fixture) => {
  const slides = generateStoryboard(fixture);

  it("Property 3: slide types follow the canonical order", () => {
    const idx = slides.map((s) => CANONICAL.indexOf(s.type));
    expect(idx.every((v) => v >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(slides[0]!.type).toBe("intro");
    expect(slides[slides.length - 1]!.type).toBe("conclusion");
  });

  it("Property 8: every text fragment comes from repository data or a fixed template", () => {
    const sources = [
      fixture.owner, fixture.repo, `https://github.com/${fixture.owner}/${fixture.repo}`,
      fixture.readmeText ?? "",
      fixture.metadata?.description ?? "", ...(fixture.metadata?.topics ?? []),
      String(fixture.metadata?.stars ?? ""), fixture.metadata?.language ?? "", fixture.metadata?.license ?? "",
      ...fixture.directoryTree.map((n) => n.path),
      ...fixture.specDocs.map((d) => `${d.path} ${d.content}`),
      ...fixture.commits.flatMap((c) => [c.subject, c.body, c.author, c.timestamp]),
      ...fixture.pullRequests.flatMap((p) => [p.title, p.body, p.mergedAt]),
      ...fixture.releases.flatMap((r) => [r.name ?? "", r.tagName, r.body, r.publishedAt]),
    ];
    const norm = (s: string): string => toPlainText(s).toLowerCase();
    const corpus = sources.map(norm).join(" | ");
    const TEMPLATES = new Set([
      "no description available.", "what you can do", "how it works", "key features", "how it evolved",
      "release", "breaking change", "feature", "bug fix", "refactor",
    ]);
    const PREFIXES = /^(feature: |how to run: |architecture: |conclusion: |topics: |author: |date: |merged |published |repository: |url: |stars: |language: |license: )/i;

    for (const s of slides) {
      for (const line of `${decode(s.title)}\n${decode(s.body)}`.split("\n")) {
        const cleaned = line.replace(/^(•|├──|└──)\s*/, "");
        for (let part of cleaned.split(" · ")) {
          part = part.replace(PREFIXES, "").replace(PREFIXES, "").replace(/\s*\(#\d+\)$/, "").replace(/…$/, "").replace(/\/$/, "").trim();
          if (part === "" || TEMPLATES.has(part.toLowerCase())) continue;
          for (const piece of s.type === "intro" && /^topics: /i.test(line) ? part.split(", ") : [part]) {
            expect(corpus, `${s.type}: "${piece}"`).toContain(norm(piece));
          }
        }
      }
    }
  });

  it("Property 9: caps are ceilings and ineligible history never adds or changes evolution slides", () => {
    expect(slides.filter((s) => s.type === "feature").length).toBeLessThanOrEqual(SLIDE_CONFIG.maxFeatureSlides);
    expect(slides.filter((s) => EVOLUTION_TYPES.has(s.type)).length).toBeLessThanOrEqual(SLIDE_CONFIG.maxEvolutionSlides);
    expect(slides.length).toBeLessThanOrEqual(SLIDE_CONFIG.maxSlides);
    expect(strip(generateStoryboard(withNoise(fixture)))).toEqual(strip(slides));

    const seen = new Set<string>();
    for (const s of slides) {
      const key = `${s.type}|${s.title}|${s.body}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("Property 10: evolution is anchored to current content, or limited to the feat fallback", () => {
    const anchors = anchorsFor(fixture);
    const evo = slides.filter((s) => s.type === "change" || s.type === "highlight");
    for (const s of evo) expect(decode(s.title).startsWith("Bug Fix")).toBe(false);
    if (anchors.size > 0) {
      for (const s of evo) expect(isRelevant(`${decode(s.title)} ${decode(s.body)}`, anchors)).toBe(true);
    } else {
      expect(evo.filter((s) => s.type === "change")).toEqual([]);
      const highlights = evo.filter((s) => s.type === "highlight");
      expect(highlights.length).toBeLessThanOrEqual(SLIDE_CONFIG.maxFallbackHighlights);
      for (const h of highlights) expect(decode(h.title)).toMatch(/ · feat(\([^)]*\))?!?:/i);
    }
  });

  it("Property 12: capabilities slide only when a source exists and overlap ≤ ratio", () => {
    const caps = extractCapabilities(fixture.readmeText, fixture.specDocs);
    const features = extractKeyFeatures(fixture.readmeText, fixture.specDocs);
    const expected = caps.length > 0 && !capabilitiesOverlapFeatures(caps, features);
    expect(slides.some((s) => s.type === "capabilities")).toBe(expected);
  });

  it("Property 14: changing only commits, PRs, or releases never changes current-state slides or anchors", () => {
    const current = (x: Slide[]): Omit<Slide, "id">[] => strip(x.filter((s) => !EVOLUTION_TYPES.has(s.type)));
    for (const variant of [
      { ...fixture, commits: [], pullRequests: [], releases: [] },
      withNoise(fixture),
      { ...fixture, commits: kiroRepo.commits, pullRequests: kiroRepo.pullRequests, releases: kiroRepo.releases },
    ]) {
      expect(current(generateStoryboard(variant))).toEqual(current(slides));
      expect([...anchorsFor(variant)].sort()).toEqual([...anchorsFor(fixture)].sort());
    }
  });
});

describe("Property 11: extracted text is escaped for every slide type", () => {
  const variants = [hostileRepo, { ...hostileRepo, pullRequests: [], releases: [] }];
  const all = variants.flatMap((v) => generateStoryboard(v));

  it("covers every slide type", () => {
    expect(new Set(all.map((s) => s.type))).toEqual(new Set(CANONICAL));
  });

  it("leaves no raw < > \" ' and no bare & in any field", () => {
    for (const s of all) {
      for (const field of [s.title, s.body, s.previewSummary]) {
        expect(field, `${s.type}`).not.toMatch(/[<>"']/);
        expect(field.replace(/&(amp|lt|gt|quot|#39);/g, ""), `${s.type}`).not.toContain("&");
      }
    }
    expect(all.some((s) => decode(s.body).includes(HOSTILE))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Change_Groups and selected-PR evidence (Req 7.15–7.18, Property 15)
// ---------------------------------------------------------------------------

const DEDUP_README = [
  "# viz",
  "",
  "Turns repositories into videos.",
  "",
  "## Features",
  "",
  "- **Storyboard generation** — Builds slides.",
  "- **Video duration** — Pick a length.",
  "- **Exporter** — Writes files.",
].join("\n");

/** History shaped like this repository's PR #9: a merge commit plus three branch commits. */
function pr9History(): RepoAnalysisResult {
  const commits = [
    commit("Merge pull request #9 from x/feature/repository-focused-storyboard", "2026-10-01T00:00:00Z", "", "M9", ["r0", "f3"]),
    commit("docs: fix run slide requirement reference", "2026-10-01T00:00:00Z", "", "f3", ["f2"]),
    commit("feat: add configurable target video duration", "2026-09-30T00:00:00Z", "Lets users pick a video duration.", "f2", ["f1"]),
    commit("feat: add repository-focused storyboard generation", "2026-09-30T00:00:00Z", "Restructures the storyboard.", "f1", ["r0"]),
    commit("Lesson 1-7", "2026-09-27T00:00:00Z", "", "r0", []),
  ];
  return makeResult({
    readmeText: DEDUP_README,
    commits,
    pullRequests: [pr(9, "Feature/repository focused storyboard", "2026-10-01T00:00:00Z", { mergeCommitSha: "M9" })],
  });
}

/** Merge-commit PR whose first-parent ancestry leaves the window (long-history shape). */
function truncatedHistory(): RepoAnalysisResult {
  const commits = [
    commit("Merge pull request #42 from x/exporter", "2024-05-03T00:00:00Z", "", "M42", ["OUT1", "b2"]),
    commit("feat: exporter streams rows", "2024-05-02T00:00:00Z", "", "b2", ["b1"]),
    commit("feat: exporter writes headers", "2024-05-01T00:00:00Z", "", "b1", ["OUT2"]),
  ];
  return makeResult({
    readmeText: DEDUP_README,
    commits,
    pullRequests: [pr(42, "feat: exporter rewrite", "2024-05-03T00:00:00Z", { mergeCommitSha: "M42" })],
  });
}

const detailed = (slides: Slide[]): Slide[] => slides.filter((s) => s.type === "change" || s.type === "highlight");
const highlightTitles = (slides: Slide[]): string[] =>
  slides.filter((s) => s.type === "highlight").map((s) => decode(s.title));

describe("walkWindow", () => {
  const idx = new Map<string, string[]>([["a", ["b"]], ["b", []], ["c", ["OUT"]]]);

  it("is complete when it ends at a root", () => {
    expect(walkWindow("a", idx)).toEqual({ reached: new Set(["a", "b"]), complete: true });
  });

  it("is incomplete when it meets a parent outside the window, without inferring past it", () => {
    expect(walkWindow("c", idx)).toEqual({ reached: new Set(["c"]), complete: false });
    expect(walkWindow("OUT", idx)).toEqual({ reached: new Set(), complete: false });
  });
});

describe("buildChangeGroups (Stage 3b, Req 7.17)", () => {
  it("merge commit with in-window ancestry: merge + every provable branch commit (PR #9 shape)", () => {
    const r = pr9History();
    const g = buildChangeGroups(r.commits, r.pullRequests);
    expect(g.prMembers.get(9)).toEqual(new Set(["M9", "f1", "f2", "f3"]));
    for (const sha of ["f1", "f2", "f3"]) expect(g.groupOf.get(sha)).toBe("M9");
    expect(g.groupOf.get("r0")).toBe("r0");
    expect(g.truncatedMerges.size).toBe(0);
  });

  it("merge commit whose first-parent ancestry leaves the window: merge commit only", () => {
    const r = truncatedHistory();
    const g = buildChangeGroups(r.commits, r.pullRequests);
    expect(g.truncatedMerges).toEqual(new Set(["M42"]));
    expect(g.prMembers.get(42)).toEqual(new Set(["M42"]));
    expect(g.groupOf.get("b1")).toBe("b1");
    expect(g.groupOf.get("b2")).toBe("b2");
  });

  it("squash: the PR's single-parent merge commit alone", () => {
    const commits = [commit("Add exporter (#7)", "t", "", "s7", ["s6"]), commit("prior", "t", "", "s6", [])];
    const g = buildChangeGroups(commits, [pr(7, "Add exporter", "t", { mergeCommitSha: "s7" })]);
    expect(g.prMembers.get(7)).toEqual(new Set(["s7"]));
    expect(g.mergeCommits.size).toBe(0);
  });

  it("rebase: only the tip is linked; earlier rebased commits stay independent (Req 7.18)", () => {
    const commits = [
      commit("feat: exporter part 3", "t", "", "r3", ["r2"]),
      commit("feat: exporter part 2", "t", "", "r2", ["r1"]),
      commit("feat: exporter part 1", "t", "", "r1", []),
    ];
    const g = buildChangeGroups(commits, [pr(8, "Exporter", "t", { mergeCommitSha: "r3" })]);
    expect(g.prMembers.get(8)).toEqual(new Set(["r3"]));
    expect(new Set([g.groupOf.get("r1"), g.groupOf.get("r2"), g.groupOf.get("r3")]).size).toBe(3);
  });

  it("nested merges: every commit belongs to exactly one group, the outer merge claims first", () => {
    // Outer M2 merges branch [M1 ← (b ← r), a] ; inner M1 merged b into a.
    const commits = [
      commit("outer", "t", "", "M2", ["r", "M1"]),
      commit("inner", "t", "", "M1", ["a", "b"]),
      commit("b", "t", "", "b", ["r"]),
      commit("a", "t", "", "a", ["r"]),
      commit("root", "t", "", "r", []),
    ];
    const g = buildChangeGroups(commits, []);
    expect(g.groupOf.get("M2")).toBe("M2");
    for (const sha of ["M1", "a", "b"]) expect(g.groupOf.get(sha)).toBe("M2");
    expect(g.groupOf.get("r")).toBe("r");
    expect(g.groupOf.size).toBe(commits.length);
  });

  it("does not group a branch commit reachable only through an out-of-window commit", () => {
    const commits = [
      commit("merge", "t", "", "M", ["r", "b2"]),
      commit("b2", "t", "", "b2", ["X"]),
      commit("b1", "t", "", "b1", ["r"]),
      commit("root", "t", "", "r", []),
    ];
    const g = buildChangeGroups(commits, []);
    expect(g.groupOf.get("b2")).toBe("M");
    expect(g.groupOf.get("b1")).toBe("b1");
  });

  it("PR data unavailable: groups come from merge commits alone", () => {
    const r = pr9History();
    const g = buildChangeGroups(r.commits, []);
    expect(g.groupOf.get("f1")).toBe("M9");
    expect(g.prMembers.size).toBe(0);
  });

  it("mergeCommitSha null or outside the window: the PR has no known group", () => {
    const r = pr9History();
    const prs = [pr(1, "x", "t", { mergeCommitSha: null }), pr(2, "y", "t", { mergeCommitSha: "NOT_IN_WINDOW" })];
    const g = buildChangeGroups(r.commits, prs);
    expect(g.prMembers.has(1)).toBe(false);
    expect(g.prMembers.has(2)).toBe(false);
  });
});

describe("Selected_PRs and the lookup filter (Req 2.11, 7.15)", () => {
  it("prsNeedingEvidence keeps only truncated merge-commit Selected_PRs", () => {
    const t = truncatedHistory();
    expect(selectDeepDivePullRequests(t)).toEqual([42]);
    expect(prsNeedingEvidence(t, [42])).toEqual([42]);
  });

  it("needs no lookup for graph-proven merges, squash, rebase, unknown merge commits, or unselected PRs", () => {
    const p9 = pr9History();
    expect(selectDeepDivePullRequests(p9)).toEqual([9]);
    expect(prsNeedingEvidence(p9, [9])).toEqual([]);

    const squash = makeResult({
      readmeText: DEDUP_README,
      commits: [commit("feat: exporter (#7)", "t", "", "s7", ["OUT"])],
      pullRequests: [pr(7, "feat: exporter", "t", { mergeCommitSha: "s7" })],
    });
    expect(prsNeedingEvidence(squash, selectDeepDivePullRequests(squash))).toEqual([]);

    const unknown = makeResult({ readmeText: DEDUP_README, pullRequests: [pr(3, "feat: exporter", "t")] });
    expect(prsNeedingEvidence(unknown, selectDeepDivePullRequests(unknown))).toEqual([]);

    expect(prsNeedingEvidence(truncatedHistory(), [])).toEqual([]);
  });
});

describe("Property 15: one logical change, at most one detailed slot", () => {
  it("PR #9 shape: exactly one detailed slide for PR #9 and no highlight for its commits", () => {
    const slides = generateStoryboard(pr9History());
    expect(detailed(slides).map((s) => decode(s.title))).toEqual([
      "Feature · Feature/repository focused storyboard (#9)",
    ]);
  });

  it("truncated merge-commit PR: graph-only falls back to independent commits; evidence suppresses them", () => {
    const t = truncatedHistory();
    expect(highlightTitles(generateStoryboard(t))).toEqual([
      "Feature · feat: exporter streams rows",
      "Feature · feat: exporter writes headers",
    ]);
    const withEvidence = generateStoryboard(t, { 42: ["b1", "b2", "c0ffee-not-on-base"] });
    expect(highlightTitles(withEvidence)).toEqual([]);
    expect(detailed(withEvidence).map((s) => decode(s.title))).toEqual(["Feature · feat: exporter rewrite (#42)"]);
  });

  it("evidence never changes which PRs are selected, and empty evidence equals graph-only output", () => {
    const t = truncatedHistory();
    const changes = (x: Slide[]): string[] => x.filter((s) => s.type === "change").map((s) => s.title);
    expect(changes(generateStoryboard(t, { 42: ["b1", "b2"] }))).toEqual(changes(generateStoryboard(t)));
    expect(strip(generateStoryboard(t, {}))).toEqual(strip(generateStoryboard(t)));
  });

  it("ignores evidence for PRs that are not selected", () => {
    const t = truncatedHistory();
    expect(highlightTitles(generateStoryboard(t, { 999: ["b1", "b2"] }))).toHaveLength(2);
  });

  it("allows the same PR on the timeline and as a deep dive", () => {
    const r = { ...pr9History(), releases: [release("v1.0.0", "2026-09-28T00:00:00Z")] };
    const slides = generateStoryboard(r);
    expect(decode(slides.find((s) => s.type === "evolution")!.body)).toContain("Feature/repository focused storyboard");
    expect(detailed(slides).map((s) => decode(s.title))).toEqual([
      "Feature · Feature/repository focused storyboard (#9)",
    ]);
  });

  it("group assignment is unchanged when every commit subject and PR title is rewritten", () => {
    for (const r of [pr9History(), truncatedHistory()]) {
      const rewritten = {
        commits: r.commits.map((c) => ({ ...c, subject: `zz ${c.sha}`, message: `zz ${c.sha}` })),
        pullRequests: r.pullRequests.map((p) => ({ ...p, title: `zz ${p.number}` })),
      };
      const a = buildChangeGroups(r.commits, r.pullRequests);
      const b = buildChangeGroups(rewritten.commits, rewritten.pullRequests);
      expect(b.groupOf).toEqual(a.groupOf);
      expect(b.prMembers).toEqual(a.prMembers);
    }
  });

  it("window soundness: unknown out-of-window ancestry never adds members", () => {
    const r = pr9History();
    const base = buildChangeGroups(r.commits, r.pullRequests).prMembers.get(9)!;
    const cut = r.commits.map((c) => (c.sha === "r0" ? { ...c, parents: ["OUTSIDE"] } : c));
    const after = buildChangeGroups(cut, r.pullRequests).prMembers.get(9)!;
    for (const sha of after) expect(base.has(sha)).toBe(true);
    expect(after).toEqual(new Set(["M9"]));
  });

  it("never selects a merge commit and selects at most one highlight per group (relevant path)", () => {
    const r = pr9History();
    const g = buildChangeGroups(r.commits, []);
    const picked = selectHighlightCommits(r.commits, new Set(["storyboard", "duration"]), g, new Set());
    expect(picked.map((p) => p.commit.sha)).toHaveLength(1);
    expect(picked.some((p) => g.mergeCommits.has(p.commit.sha))).toBe(false);
  });
});
