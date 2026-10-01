/**
 * Request accounting for the storyboard pipeline (Req 2.11, 2.12; Property 17).
 *
 * Uses the real router, pipeline, analyzer, and storyboard. Only global
 * `fetch` (the GitHub boundary) is stubbed, and every request is counted.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express, { Express } from "express";
import { router, apiErrorHandler } from "../src/server/routes.js";
import { analysisCache } from "../src/server/cache.js";
import { buildStoryboardForUrl } from "../src/server/pipeline.js";
import type { Slide } from "../src/types/index.js";

const OWNER = "acme";
const REPO = "viz";
const URL_ = `https://github.com/${OWNER}/${REPO}`;
const BASE = `/repos/${OWNER}/${REPO}`;

const README = [
  "# viz",
  "",
  "Turns repositories into videos.",
  "",
  "## Features",
  "",
  "- **Exporter** — Writes files.",
  "- **Renderer** — Draws slides.",
].join("\n");

type Style = "truncated-merge" | "squash";

interface FakeRepo {
  /** One entry per merged PR. */
  prs: { number: number; style: Style }[];
  /** Number of `.kiro/specs/**` files in the tree. */
  specFiles?: number;
  /** PR numbers whose commit lookup fails with 500. */
  failLookups?: number[];
}

/** Build GitHub REST payloads for a fake repository. */
function payloads(repo: FakeRepo): Map<string, unknown> {
  const commits: unknown[] = [];
  const pulls: unknown[] = [];
  const prCommits = new Map<number, unknown>();
  for (const { number: n, style } of repo.prs) {
    const date = `2024-0${(n % 9) + 1}-01T00:00:00Z`;
    if (style === "truncated-merge") {
      commits.push({ sha: `M${n}`, parents: [{ sha: `OUT${n}` }, { sha: `b${n}` }], commit: { author: { name: "A", date }, message: `Merge pull request #${n}` } });
      commits.push({ sha: `b${n}`, parents: [{ sha: `OUTB${n}` }], commit: { author: { name: "A", date }, message: `feat: exporter stream ${n}` } });
      pulls.push({ number: n, title: `feat: exporter part ${n}`, merged_at: date, merge_commit_sha: `M${n}`, labels: [], user: { login: "dev", type: "User" } });
      prCommits.set(n, [{ sha: `b${n}` }]);
    } else {
      commits.push({ sha: `S${n}`, parents: [{ sha: `OUTS${n}` }], commit: { author: { name: "A", date }, message: `feat: exporter squash ${n} (#${n})` } });
      pulls.push({ number: n, title: `feat: exporter squash ${n}`, merged_at: date, merge_commit_sha: `S${n}`, labels: [], user: { login: "dev", type: "User" } });
      prCommits.set(n, [{ sha: `pre-squash-${n}` }]);
    }
  }
  const specs = Array.from({ length: repo.specFiles ?? 0 }, (_, i) => ({ path: `.kiro/specs/s${i}/notes.md`, type: "blob", size: 10 }));
  const map = new Map<string, unknown>([
    [BASE, { description: "Videos.", topics: [], stargazers_count: 1, language: "TS", license: null }],
    [`${BASE}/git/trees/HEAD`, { tree: [{ path: "src", type: "tree" }, ...specs] }],
    [`${BASE}/readme`, README],
    [`${BASE}/commits`, commits],
    [`${BASE}/pulls`, pulls],
    [`${BASE}/releases`, []],
  ]);
  for (const s of specs) map.set(`${BASE}/contents/${s.path}`, "# Notes");
  for (const [n, list] of prCommits) map.set(`${BASE}/pulls/${n}/commits`, list);
  return map;
}

/** Stub fetch with the fake repo; returns the request log. */
function stubGitHub(repo: FakeRepo): string[] {
  const routes = payloads(repo);
  const log: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const u = new URL(String(input));
    expect(u.hostname).toBe("api.github.com");
    log.push(u.pathname);
    const n = /\/pulls\/(\d+)\/commits$/.exec(u.pathname);
    if (n && repo.failLookups?.includes(Number(n[1]))) return new Response("boom", { status: 500 });
    if (!routes.has(u.pathname)) return new Response("Not Found", { status: 404 });
    const v = routes.get(u.pathname);
    return typeof v === "string" ? new Response(v) : new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
  }));
  return log;
}

const lookups = (log: string[]): string[] => log.filter((p) => /\/pulls\/\d+\/commits$/.test(p));
const BASELINE = 6; // metadata, tree, readme, commits, pulls, releases

function app(): Express {
  const a = express();
  a.use(express.json());
  a.use("/api", router);
  a.use(apiErrorHandler);
  return a;
}

beforeEach(() => {
  analysisCache.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("selected-PR lookups through GET /api/storyboard (Property 17)", () => {
  it("no Selected_PR: baseline requests only", async () => {
    const log = stubGitHub({ prs: [] });
    const res = await request(app()).get("/api/storyboard").query({ url: URL_ });
    expect(res.status).toBe(200);
    expect(log).toHaveLength(BASELINE);
    expect(lookups(log)).toEqual([]);
  });

  it("Selected_PRs that need no evidence (squash): 0 lookups", async () => {
    const log = stubGitHub({ prs: [{ number: 1, style: "squash" }, { number: 2, style: "squash" }] });
    const res = await request(app()).get("/api/storyboard").query({ url: URL_ });
    expect(res.status).toBe(200);
    expect((res.body as Slide[]).some((s) => s.type === "change")).toBe(true);
    expect(lookups(log)).toEqual([]);
  });

  it.each([1, 2, 3])("%i truncated merge-commit Selected_PR(s): baseline + at most N lookups", async (n) => {
    const log = stubGitHub({ prs: Array.from({ length: n }, (_, i) => ({ number: i + 1, style: "truncated-merge" as const })) });
    const res = await request(app()).get("/api/storyboard").query({ url: URL_ });
    expect(res.status).toBe(200);
    expect(lookups(log).length).toBeLessThanOrEqual(n);
    expect(lookups(log).length).toBe(n);
    expect(log.length).toBe(BASELINE + n);
    // Evidence suppresses every branch commit of the selected PRs.
    expect((res.body as Slide[]).filter((s) => s.type === "highlight")).toEqual([]);
  });

  it("never looks up unselected PRs, and never exceeds 15 requests in total", async () => {
    const log = stubGitHub({
      prs: Array.from({ length: 8 }, (_, i) => ({ number: i + 1, style: "truncated-merge" as const })),
      specFiles: 9,
    });
    const res = await request(app()).get("/api/storyboard").query({ url: URL_ });
    expect(res.status).toBe(200);
    expect(lookups(log)).toHaveLength(3);
    expect(log.length).toBe(BASELINE + 6 + 3);
    expect(log.length).toBeLessThanOrEqual(15);
    const selectedNumbers = (res.body as Slide[])
      .filter((s) => s.type === "change")
      .map((s) => Number(/\(#(\d+)\)$/.exec(s.title)![1]));
    expect(lookups(log).map((p) => Number(/pulls\/(\d+)\//.exec(p)![1])).sort()).toEqual([...selectedNumbers].sort());
  });

  it("a cached storyboard request makes 0 GitHub requests", async () => {
    const log = stubGitHub({ prs: [{ number: 1, style: "truncated-merge" }, { number: 2, style: "truncated-merge" }] });
    const first = await request(app()).get("/api/storyboard").query({ url: URL_ });
    const before = log.length;
    const second = await request(app()).get("/api/storyboard").query({ url: URL_ });
    expect(second.status).toBe(200);
    expect(log.length).toBe(before);
    const titles = (x: Slide[]): string[] => x.map((s) => s.title);
    expect(titles(second.body as Slide[])).toEqual(titles(first.body as Slide[]));
  });

  it("an /api/analyze cache entry is reused; the storyboard adds only the lookups", async () => {
    const log = stubGitHub({ prs: [{ number: 1, style: "truncated-merge" }] });
    await request(app()).post("/api/analyze").send({ url: URL_ });
    expect(log).toHaveLength(BASELINE);
    await request(app()).get("/api/storyboard").query({ url: URL_ });
    expect(log).toHaveLength(BASELINE + 1);
  });

  it("a failing lookup still returns 200 and falls back to graph-only grouping", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = stubGitHub({ prs: [{ number: 1, style: "truncated-merge" }], failLookups: [1] });
    const res = await request(app()).get("/api/storyboard").query({ url: URL_ });
    expect(res.status).toBe(200);
    expect(lookups(log)).toHaveLength(1);
    // Without evidence, the truncated PR's branch commit is not provably its member.
    expect((res.body as Slide[]).filter((s) => s.type === "highlight").map((s) => s.title)).toEqual([
      "Feature · feat: exporter stream 1",
    ]);
  });

  it("buildStoryboardForUrl propagates analysis errors unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Not Found", { status: 404 })));
    await expect(buildStoryboardForUrl(URL_)).rejects.toMatchObject({ code: "repo_not_found" });
    await expect(buildStoryboardForUrl("https://gitlab.com/a/b")).rejects.toMatchObject({ code: "invalid_url" });
  });
});
