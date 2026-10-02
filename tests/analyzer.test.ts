/**
 * Unit tests for src/server/analyzer.ts
 *
 * All GitHub network calls are mocked at the global `fetch` boundary.
 * No real outbound requests are made.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  validateAndExtractTokens,
  safeFetch,
  fetchDirectoryTree,
  fetchReadme,
  fetchCommits,
  fetchSpecDocs,
  fetchMetadata,
  fetchPullRequests,
  fetchReleases,
  selectSpecPaths,
  fetchSelectedPrCommits,
  MAX_SELECTED_PR_LOOKUPS,
  analyzeRepository,
  computeRateLimitWaitSeconds,
  formatRateLimitMessage,
} from "../src/server/analyzer.js";
import { ApiError } from "../src/types/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Response-like object for mocking. */
function mockResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  const responseHeaders = new Headers(headers);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: responseHeaders,
    text: async () => bodyStr,
    json: async () => JSON.parse(bodyStr),
    // Simulate a readable stream for readCappedBody
    get body() {
      const encoder = new TextEncoder();
      const bytes = encoder.encode(bodyStr);
      let done = false;
      return {
        getReader: () => ({
          read: async () => {
            if (done) return { done: true, value: undefined };
            done = true;
            return { done: false, value: bytes };
          },
          releaseLock: () => {},
        }),
      } as unknown as ReadableStream;
    },
  } as unknown as Response;
}

const BASE_TREE = [
  { path: "src", type: "tree" },
  { path: "src/index.ts", type: "blob", size: 1024 },
  { path: "README.md", type: "blob", size: 512 },
];

const BASE_COMMITS = [
  {
    sha: "abc123",
    commit: { author: { name: "Alice", date: "2024-01-01T00:00:00Z" }, message: "feat: add login" },
    author: { login: "alice" },
  },
];

// ---------------------------------------------------------------------------
// validateAndExtractTokens
// ---------------------------------------------------------------------------

describe("validateAndExtractTokens", () => {
  it("extracts owner and repo from a valid URL", () => {
    const result = validateAndExtractTokens("https://github.com/owner/repo");
    expect(result).toEqual({ owner: "owner", repo: "repo" });
  });

  it("accepts hyphens and underscores in owner/repo", () => {
    const result = validateAndExtractTokens("https://github.com/my-org/my_repo");
    expect(result).toEqual({ owner: "my-org", repo: "my_repo" });
  });

  it("throws invalid_url for http:// scheme", () => {
    expect(() => validateAndExtractTokens("http://github.com/owner/repo")).toThrow(
      expect.objectContaining({ code: "invalid_url" }),
    );
  });

  it("throws invalid_url for trailing slash", () => {
    expect(() => validateAndExtractTokens("https://github.com/owner/repo/")).toThrow(
      expect.objectContaining({ code: "invalid_url" }),
    );
  });

  it("throws invalid_url for extra path segments", () => {
    expect(() =>
      validateAndExtractTokens("https://github.com/owner/repo/tree/main"),
    ).toThrow(expect.objectContaining({ code: "invalid_url" }));
  });

  it("throws invalid_url for query string", () => {
    expect(() =>
      validateAndExtractTokens("https://github.com/owner/repo?tab=readme"),
    ).toThrow(expect.objectContaining({ code: "invalid_url" }));
  });

  it("throws invalid_url when owner exceeds 100 chars", () => {
    const long = "a".repeat(101);
    expect(() =>
      validateAndExtractTokens(`https://github.com/${long}/repo`),
    ).toThrow(expect.objectContaining({ code: "invalid_url" }));
  });

  it("throws invalid_url for non-GitHub host", () => {
    expect(() =>
      validateAndExtractTokens("https://gitlab.com/owner/repo"),
    ).toThrow(expect.objectContaining({ code: "invalid_url" }));
  });
});

// ---------------------------------------------------------------------------
// safeFetch — host allowlist
// ---------------------------------------------------------------------------

describe("safeFetch host allowlist", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse("{}")));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("allows api.github.com", async () => {
    await expect(safeFetch("https://api.github.com/repos/o/r")).resolves.toBeDefined();
  });

  it("allows raw.githubusercontent.com", async () => {
    await expect(
      safeFetch("https://raw.githubusercontent.com/o/r/main/README.md"),
    ).resolves.toBeDefined();
  });

  it("rejects localhost", async () => {
    await expect(safeFetch("https://localhost/evil")).rejects.toThrow(
      expect.objectContaining({ code: "invalid_url" }),
    );
  });

  it("rejects an internal IP", async () => {
    await expect(safeFetch("https://192.168.1.1/evil")).rejects.toThrow(
      expect.objectContaining({ code: "invalid_url" }),
    );
  });

  it("rejects a metadata endpoint", async () => {
    await expect(safeFetch("https://169.254.169.254/latest/meta-data/")).rejects.toThrow(
      expect.objectContaining({ code: "invalid_url" }),
    );
  });
});

// ---------------------------------------------------------------------------
// safeFetch — timeout
// ---------------------------------------------------------------------------

describe("safeFetch timeout", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("throws request_timeout when fetch is aborted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" })),
    );
    await expect(safeFetch("https://api.github.com/repos/o/r")).rejects.toThrow(
      expect.objectContaining({ code: "request_timeout" }),
    );
  });

  it("throws network_error for generic fetch failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await expect(safeFetch("https://api.github.com/repos/o/r")).rejects.toThrow(
      expect.objectContaining({ code: "network_error" }),
    );
  });
});

// ---------------------------------------------------------------------------
// fetchDirectoryTree
// ---------------------------------------------------------------------------

describe("fetchDirectoryTree", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns DirectoryNode[] filtered to <= 3 path levels", async () => {
    const tree = [
      { path: "src", type: "tree" },
      { path: "src/server", type: "tree" },
      { path: "src/server/index.ts", type: "blob", size: 100 },
      { path: "src/server/deep/nested.ts", type: "blob", size: 50 }, // 4 levels — excluded
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse({ tree })));
    const result = await fetchDirectoryTree("owner", "repo");
    expect(result.some((n) => n.path === "src/server/deep/nested.ts")).toBe(false);
    expect(result.some((n) => n.path === "src/server/index.ts")).toBe(true);
  });

  it("throws repo_not_found on 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse("Not Found", 404)));
    await expect(fetchDirectoryTree("owner", "repo")).rejects.toThrow(
      expect.objectContaining({ code: "repo_not_found" }),
    );
  });

  it("throws repo_not_found on 403", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse("Forbidden", 403)));
    await expect(fetchDirectoryTree("owner", "repo")).rejects.toThrow(
      expect.objectContaining({ code: "repo_not_found" }),
    );
  });

  it("throws rate_limit_exceeded on 429", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(mockResponse("Rate limited", 429)),
    );
    await expect(fetchDirectoryTree("owner", "repo")).rejects.toThrow(
      expect.objectContaining({ code: "rate_limit_exceeded" }),
    );
  });

  it("throws rate_limit_exceeded on 403 with X-RateLimit-Remaining: 0", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse("Forbidden", 403, { "X-RateLimit-Remaining": "0" }),
      ),
    );
    await expect(fetchDirectoryTree("owner", "repo")).rejects.toThrow(
      expect.objectContaining({ code: "rate_limit_exceeded" }),
    );
  });
});

// ---------------------------------------------------------------------------
// fetchReadme
// ---------------------------------------------------------------------------

describe("fetchReadme", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns readme text on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse("# Hello World")));
    const result = await fetchReadme("owner", "repo");
    expect(result).toBe("# Hello World");
  });

  it("returns null on 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse("Not Found", 404)));
    const result = await fetchReadme("owner", "repo");
    expect(result).toBeNull();
  });

  it("throws repo_not_found on 403 without rate-limit header", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse("Forbidden", 403)));
    await expect(fetchReadme("owner", "repo")).rejects.toThrow(
      expect.objectContaining({ code: "repo_not_found" }),
    );
  });
});

// ---------------------------------------------------------------------------
// fetchCommits
// ---------------------------------------------------------------------------

describe("fetchCommits", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps GitHub commit shape to Commit[]", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(BASE_COMMITS)));
    const result = await fetchCommits("owner", "repo");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      sha: "abc123",
      author: "Alice",
      message: "feat: add login",
    });
  });

  it("uses only the first line of multi-line commit messages", async () => {
    const commits = [
      {
        sha: "def456",
        commit: {
          author: { name: "Bob", date: "2024-01-02T00:00:00Z" },
          message: "fix: bug\n\nDetailed description here.",
        },
        author: { login: "bob" },
      },
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(commits)));
    const result = await fetchCommits("owner", "repo");
    expect(result[0]?.message).toBe("fix: bug");
  });

  it("throws repo_not_found on 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse("Not Found", 404)));
    await expect(fetchCommits("owner", "repo")).rejects.toThrow(
      expect.objectContaining({ code: "repo_not_found" }),
    );
  });
});

// ---------------------------------------------------------------------------
// URL-routed fetch mock for multi-step tests
// ---------------------------------------------------------------------------

type Route = Response | Error | ((url: string) => Response | Error);

/**
 * Build a fetch mock that answers by URL path. Longest matching key wins;
 * unmatched URLs return 404.
 */
function routedFetch(routes: Record<string, Route>) {
  return vi.fn(async (input: string | URL): Promise<Response> => {
    const url = String(input);
    const path = new URL(url).pathname + new URL(url).search;
    const key = Object.keys(routes)
      .filter((k) => path.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (key === undefined) return mockResponse("Not Found", 404);
    const route = routes[key]!;
    const value = typeof route === "function" ? route(url) : route;
    if (value instanceof Error) throw value;
    return value;
  });
}

const R = "/repos/owner/repo";

/** Routes for a fully successful analysis; override individual entries per test. */
function happyRoutes(): Record<string, Route> {
  return {
    [R]: mockResponse({ description: "Desc", topics: ["t"], stargazers_count: 5, language: "TS", license: { spdx_id: "MIT" } }),
    [`${R}/git/trees/HEAD`]: mockResponse({ tree: BASE_TREE }),
    [`${R}/readme`]: mockResponse("# README"),
    [`${R}/commits`]: mockResponse(BASE_COMMITS),
    [`${R}/pulls`]: mockResponse([]),
    [`${R}/releases`]: mockResponse([]),
  };
}

// ---------------------------------------------------------------------------
// fetchMetadata
// ---------------------------------------------------------------------------

describe("fetchMetadata", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps description, topics, stars, language, and license", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse({
      description: "A tool", topics: ["a", "b"], stargazers_count: 42, language: "Go",
      license: { spdx_id: "Apache-2.0", name: "Apache License 2.0" },
    })));
    expect(await fetchMetadata("owner", "repo")).toEqual({
      description: "A tool", topics: ["a", "b"], stars: 42, language: "Go", license: "Apache-2.0",
    });
  });

  it("uses the license name when spdx_id is NOASSERTION, and nulls missing fields", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse({
      description: null, license: { spdx_id: "NOASSERTION", name: "Custom" },
    })));
    expect(await fetchMetadata("owner", "repo")).toEqual({
      description: null, topics: [], stars: null, language: null, license: "Custom",
    });
  });

  it("throws repo_not_found on 404 and on a non-rate-limit 403", async () => {
    for (const status of [404, 403]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse("x", status)));
      await expect(fetchMetadata("owner", "repo")).rejects.toThrow(
        expect.objectContaining({ code: "repo_not_found" }),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// fetchCommits — subject and body
// ---------------------------------------------------------------------------

describe("fetchCommits subject/body mapping", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("splits the message into subject and body with leading blank lines trimmed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse([{
      sha: "s1",
      commit: { author: { name: "A", date: "2024-01-01T00:00:00Z" }, message: "feat: x\n\n\nWhy it matters.\nSigned-off-by: A <a@x>\n" },
    }])));
    const [c] = await fetchCommits("owner", "repo");
    expect(c?.subject).toBe("feat: x");
    expect(c?.message).toBe("feat: x");
    expect(c?.body).toBe("Why it matters.\nSigned-off-by: A <a@x>");
  });

  it("uses an empty body for single-line messages", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(BASE_COMMITS)));
    const [c] = await fetchCommits("owner", "repo");
    expect(c?.body).toBe("");
  });
});

// ---------------------------------------------------------------------------
// fetchPullRequests / fetchReleases
// ---------------------------------------------------------------------------

describe("fetchPullRequests", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps merged PRs only and maps labels, isBot, and a capped body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse([
      { number: 1, title: "feat: a", body: "x".repeat(20_000), merged_at: "2024-01-01T00:00:00Z",
        labels: [{ name: "Enhancement" }], user: { login: "alice", type: "User" } },
      { number: 2, title: "closed unmerged", merged_at: null, labels: [], user: { type: "User" } },
      { number: 3, title: "Bump x", merged_at: "2024-01-02T00:00:00Z", labels: [], user: { login: "dependabot[bot]", type: "User" } },
      { number: 4, title: "y", merged_at: "2024-01-03T00:00:00Z", body: null, labels: [], user: { login: "ci", type: "Bot" } },
    ])));
    const prs = await fetchPullRequests("owner", "repo");
    expect(prs.map((p) => p.number)).toEqual([1, 3, 4]);
    expect(prs[0]?.labels).toEqual(["enhancement"]);
    expect(prs[0]?.body.length).toBe(10_000);
    expect(prs[0]?.isBot).toBe(false);
    expect(prs[1]?.isBot).toBe(true);
    expect(prs[2]?.isBot).toBe(true);
    expect(prs[2]?.body).toBe("");
  });

  it("returns [] on 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse("x", 404)));
    expect(await fetchPullRequests("owner", "repo")).toEqual([]);
  });

  it("throws network_error on 500", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse("x", 500)));
    await expect(fetchPullRequests("owner", "repo")).rejects.toThrow(
      expect.objectContaining({ code: "network_error" }),
    );
  });
});

describe("fetchReleases", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("drops drafts and unpublished releases", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse([
      { tag_name: "v2.0.0", name: "Two", draft: true, published_at: null, body: "" },
      { tag_name: "v1.0.0", name: "", draft: false, published_at: "2024-01-01T00:00:00Z", body: "Notes" },
    ])));
    expect(await fetchReleases("owner", "repo")).toEqual([
      { tagName: "v1.0.0", name: null, publishedAt: "2024-01-01T00:00:00Z", body: "Notes" },
    ]);
  });

  it("returns [] on 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse("x", 404)));
    expect(await fetchReleases("owner", "repo")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// selectSpecPaths / fetchSpecDocs
// ---------------------------------------------------------------------------

describe("selectSpecPaths", () => {
  const blob = (path: string, size = 100): { path: string; type: "blob"; size: number } => ({ path, type: "blob", size });

  it("finds Markdown files at any depth under .kiro/specs/ only", () => {
    const paths = selectSpecPaths([
      blob(".kiro/specs/a/requirements.md"),
      blob(".kiro/specs/a/deep/notes.md"),
      blob(".kiro/steering/code-style.md"),
      blob(".kiro/hooks/h.json"),
      blob(".kiro/specs/a/tasks.txt"),
      blob("docs/specs/x.md"),
    ]);
    expect(paths).toEqual([".kiro/specs/a/requirements.md", ".kiro/specs/a/deep/notes.md"]);
  });

  it("puts requirements.md and design.md first, then ascending path, capped at 6", () => {
    const paths = selectSpecPaths([
      blob(".kiro/specs/z/tasks.md"),
      blob(".kiro/specs/b/design.md"),
      blob(".kiro/specs/a/tasks.md"),
      blob(".kiro/specs/a/requirements.md"),
      blob(".kiro/specs/a/design.md"),
      blob(".kiro/specs/c/extra.md"),
      blob(".kiro/specs/d/extra.md"),
      blob(".kiro/specs/e/extra.md"),
    ]);
    expect(paths).toEqual([
      ".kiro/specs/a/design.md",
      ".kiro/specs/a/requirements.md",
      ".kiro/specs/b/design.md",
      ".kiro/specs/a/tasks.md",
      ".kiro/specs/c/extra.md",
      ".kiro/specs/d/extra.md",
    ]);
  });

  it("skips files over 1 MB and rejects traversal, empty, and backslash segments", () => {
    const paths = selectSpecPaths([
      blob(".kiro/specs/a/huge.md", 2 * 1024 * 1024),
      blob(".kiro/specs/../../etc/passwd.md"),
      blob(".kiro/specs/./a.md"),
      blob(".kiro/specs//a.md"),
      blob(".kiro/specs/a\\b.md"),
      blob(".kiro/specs/ok.md"),
    ]);
    expect(paths).toEqual([".kiro/specs/ok.md"]);
  });
});

describe("fetchSpecDocs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches each path from the contents endpoint with per-segment encoding", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse("# Doc"));
    vi.stubGlobal("fetch", fetchMock);
    const docs = await fetchSpecDocs("owner", "repo", [".kiro/specs/my spec/design.md"]);
    expect(docs).toEqual([{ path: ".kiro/specs/my spec/design.md", content: "# Doc" }]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://api.github.com/repos/owner/repo/contents/.kiro/specs/my%20spec/design.md",
    );
  });

  it("re-validates paths and skips invalid ones without fetching", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse("# Doc"));
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchSpecDocs("owner", "repo", [".kiro/specs/../../x.md", "README.md"])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips a file that fails but propagates rate limits", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(mockResponse("x", 500))
      .mockResolvedValueOnce(mockResponse("# B")));
    expect(await fetchSpecDocs("owner", "repo", [".kiro/specs/a.md", ".kiro/specs/b.md"])).toEqual([
      { path: ".kiro/specs/b.md", content: "# B" },
    ]);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse("x", 429)));
    await expect(fetchSpecDocs("owner", "repo", [".kiro/specs/a.md"])).rejects.toThrow(
      expect.objectContaining({ code: "rate_limit_exceeded" }),
    );
  });
});

// ---------------------------------------------------------------------------
// analyzeRepository — integration of all steps
// ---------------------------------------------------------------------------

describe("analyzeRepository", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws invalid_url for a non-GitHub URL", async () => {
    await expect(analyzeRepository("https://gitlab.com/o/r")).rejects.toThrow(
      expect.objectContaining({ code: "invalid_url" }),
    );
  });

  it("uses the metadata step as the repo_not_found source", async () => {
    vi.stubGlobal("fetch", routedFetch({ ...happyRoutes(), [R]: mockResponse("Not Found", 404) }));
    await expect(analyzeRepository("https://github.com/owner/repo")).rejects.toThrow(
      expect.objectContaining({ code: "repo_not_found" }),
    );
  });

  it("throws repo_not_found when every endpoint returns 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse("Not Found", 404)));
    await expect(analyzeRepository("https://github.com/owner/repo")).rejects.toThrow(
      expect.objectContaining({ code: "repo_not_found" }),
    );
  });

  it("returns a full result on success, with empty sources not recorded as failures", async () => {
    vi.stubGlobal("fetch", routedFetch(happyRoutes()));
    const result = await analyzeRepository("https://github.com/owner/repo");
    expect(result.metadata?.description).toBe("Desc");
    expect(result.readmeText).toBe("# README");
    expect(result.commits).toHaveLength(1);
    expect(result.specDocs).toEqual([]);
    expect(result.pullRequests).toEqual([]);
    expect(result.releases).toEqual([]);
    expect(result.partialFailures).toEqual([]);
  });

  it("treats 404 for pulls and releases as empty, not as partial failures", async () => {
    const routes = happyRoutes();
    delete routes[`${R}/pulls`];
    delete routes[`${R}/releases`];
    vi.stubGlobal("fetch", routedFetch(routes));
    const result = await analyzeRepository("https://github.com/owner/repo");
    expect(result.pullRequests).toEqual([]);
    expect(result.releases).toEqual([]);
    expect(result.partialFailures).toEqual([]);
  });

  it("fetches 4-level-deep spec files discovered in the unfiltered tree", async () => {
    const tree = [
      ...BASE_TREE,
      { path: ".kiro", type: "tree" },
      { path: ".kiro/specs/app/requirements.md", type: "blob", size: 10 },
      { path: ".kiro/steering/style.md", type: "blob", size: 10 },
    ];
    vi.stubGlobal("fetch", routedFetch({
      ...happyRoutes(),
      [`${R}/git/trees/HEAD`]: mockResponse({ tree }),
      [`${R}/contents/.kiro/specs/app/requirements.md`]: mockResponse("# Reqs"),
    }));
    const result = await analyzeRepository("https://github.com/owner/repo");
    expect(result.specDocs).toEqual([{ path: ".kiro/specs/app/requirements.md", content: "# Reqs" }]);
    expect(result.directoryTree.some((n) => n.path.startsWith(".kiro/specs/app/"))).toBe(false);
  });

  it("records a failing step and continues with the rest", async () => {
    vi.stubGlobal("fetch", routedFetch({
      ...happyRoutes(),
      [`${R}/commits`]: new Error("ECONNREFUSED"),
      [`${R}/pulls`]: mockResponse("boom", 500),
    }));
    const result = await analyzeRepository("https://github.com/owner/repo");
    expect(result.partialFailures).toEqual(expect.arrayContaining(["commits", "pullRequests"]));
    expect(result.partialFailures).not.toContain("releases");
    expect(result.readmeText).toBe("# README");
  });

  it("records both directoryTree and specDocs when the tree step fails", async () => {
    vi.stubGlobal("fetch", routedFetch({ ...happyRoutes(), [`${R}/git/trees/HEAD`]: mockResponse("boom", 500) }));
    const result = await analyzeRepository("https://github.com/owner/repo");
    expect(result.partialFailures).toEqual(expect.arrayContaining(["directoryTree", "specDocs"]));
    expect(result.directoryTree).toEqual([]);
    expect(result.metadata).not.toBeNull();
  });

  it("propagates rate_limit_exceeded from any step", async () => {
    vi.stubGlobal("fetch", routedFetch({ ...happyRoutes(), [`${R}/releases`]: mockResponse("x", 429) }));
    await expect(analyzeRepository("https://github.com/owner/repo")).rejects.toThrow(
      expect.objectContaining({ code: "rate_limit_exceeded" }),
    );
  });

  it("only contacts api.github.com", async () => {
    const fetchMock = routedFetch(happyRoutes());
    vi.stubGlobal("fetch", fetchMock);
    await analyzeRepository("https://github.com/owner/repo");
    for (const [url] of fetchMock.mock.calls) expect(new URL(String(url)).hostname).toBe("api.github.com");
  });
});

// ---------------------------------------------------------------------------
// computeRateLimitWaitSeconds
// ---------------------------------------------------------------------------

describe("computeRateLimitWaitSeconds", () => {
  it("prefers Retry-After (delta seconds) when present", () => {
    const res = mockResponse("", 429, { "Retry-After": "42" });
    expect(computeRateLimitWaitSeconds(res, 1_000_000)).toBe(42);
  });

  it("rounds Retry-After up to whole seconds", () => {
    const res = mockResponse("", 429, { "Retry-After": "10.2" });
    expect(computeRateLimitWaitSeconds(res, 1_000_000)).toBe(11);
  });

  it("falls back to X-RateLimit-Reset when Retry-After is absent", () => {
    // now = 1000s; reset = 1600s → wait 600s
    const nowMs = 1000 * 1000;
    const res = mockResponse("", 403, {
      "X-RateLimit-Remaining": "0",
      "X-RateLimit-Reset": "1600",
    });
    expect(computeRateLimitWaitSeconds(res, nowMs)).toBe(600);
  });

  it("prefers Retry-After over X-RateLimit-Reset when both present", () => {
    const res = mockResponse("", 429, {
      "Retry-After": "30",
      "X-RateLimit-Reset": "9999999999",
    });
    expect(computeRateLimitWaitSeconds(res, 0)).toBe(30);
  });

  it("returns null when neither header is present", () => {
    const res = mockResponse("", 429, {});
    expect(computeRateLimitWaitSeconds(res, 0)).toBeNull();
  });

  it("returns null when X-RateLimit-Reset is in the past", () => {
    const nowMs = 2000 * 1000; // now = 2000s
    const res = mockResponse("", 403, {
      "X-RateLimit-Remaining": "0",
      "X-RateLimit-Reset": "1000", // already passed
    });
    expect(computeRateLimitWaitSeconds(res, nowMs)).toBeNull();
  });

  it("ignores non-numeric header values", () => {
    const res = mockResponse("", 429, { "Retry-After": "soon" });
    expect(computeRateLimitWaitSeconds(res, 0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// formatRateLimitMessage
// ---------------------------------------------------------------------------

describe("formatRateLimitMessage", () => {
  it("formats a short wait in seconds", () => {
    expect(formatRateLimitMessage(42)).toContain("42 seconds");
  });

  it("uses singular 'second' for a 1-second wait", () => {
    expect(formatRateLimitMessage(1)).toContain("1 second.");
  });

  it("formats a long wait in minutes", () => {
    // 600s → 10 minutes
    expect(formatRateLimitMessage(600)).toContain("10 minutes");
  });

  it("rounds minutes up", () => {
    // 2520s = 42 minutes exactly
    expect(formatRateLimitMessage(2520)).toContain("42 minutes");
    // 130s → ceil(130/60) = 3 minutes
    expect(formatRateLimitMessage(130)).toContain("3 minutes");
  });

  it("falls back to a generic message when wait is null", () => {
    const msg = formatRateLimitMessage(null);
    expect(msg).toContain("try again later");
    expect(msg).not.toMatch(/\d+\s*(second|minute)/);
  });

  it("never promises a specific number in the null fallback", () => {
    expect(formatRateLimitMessage(null)).not.toMatch(/\d/);
  });
});

// ---------------------------------------------------------------------------
// throwIfRateLimited integration — message reflects headers
// ---------------------------------------------------------------------------

describe("rate-limit message reflects response headers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetchDirectoryTree surfaces a minutes-based message from X-RateLimit-Reset", async () => {
    const futureReset = Math.floor(Date.now() / 1000) + 600; // ~10 min out
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse("Forbidden", 403, {
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": String(futureReset),
        }),
      ),
    );
    await expect(fetchDirectoryTree("o", "r")).rejects.toThrow(
      expect.objectContaining({
        code: "rate_limit_exceeded",
        message: expect.stringContaining("minute"),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// parents / mergeCommitSha mapping (Req 2.4, 2.8)
// ---------------------------------------------------------------------------

describe("commit parents and PR merge commit mapping", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps parents[].sha, defaulting to []", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse([
      { sha: "m", commit: { author: { name: "A", date: "t" }, message: "merge" }, parents: [{ sha: "p1" }, { sha: "p2" }] },
      { sha: "r", commit: { author: { name: "A", date: "t" }, message: "root" } },
    ])));
    const [m, r] = await fetchCommits("owner", "repo");
    expect(m?.parents).toEqual(["p1", "p2"]);
    expect(r?.parents).toEqual([]);
  });

  it("maps merge_commit_sha, defaulting to null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse([
      { number: 1, title: "a", merged_at: "t", merge_commit_sha: "abc", labels: [], user: { type: "User" } },
      { number: 2, title: "b", merged_at: "t", labels: [], user: { type: "User" } },
    ])));
    const prs = await fetchPullRequests("owner", "repo");
    expect(prs.map((p) => p.mergeCommitSha)).toEqual(["abc", null]);
  });

  it("analysis steps 1–7 still make the same requests (no PR-commit lookups)", async () => {
    const fetchMock = routedFetch(happyRoutes());
    vi.stubGlobal("fetch", fetchMock);
    await analyzeRepository("https://github.com/owner/repo");
    const paths = fetchMock.mock.calls.map(([u]) => new URL(String(u)).pathname).sort();
    expect(paths).toEqual([R, `${R}/commits`, `${R}/git/trees/HEAD`, `${R}/pulls`, `${R}/readme`, `${R}/releases`].sort());
    expect(paths.some((p) => /\/pulls\/\d+\/commits$/.test(p))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fetchSelectedPrCommits — lazy, bounded, fail-safe (Req 2.11, 2.12; Property 17)
// ---------------------------------------------------------------------------

describe("fetchSelectedPrCommits", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const prCommits = (n: number): Response => mockResponse([{ sha: `${n}-a` }, { sha: `${n}-b` }]);
  const okFetch = () =>
    vi.fn(async (u: string | URL): Promise<Response> => prCommits(Number(/\/pulls\/(\d+)\/commits/.exec(String(u))![1])));

  it("makes 0 requests for an empty list", async () => {
    const f = okFetch();
    vi.stubGlobal("fetch", f);
    expect(await fetchSelectedPrCommits("owner", "repo", [])).toEqual({});
    expect(f).not.toHaveBeenCalled();
  });

  it.each([1, 2, 3])("makes at most N requests for N numbers (N = %i)", async (n) => {
    const f = okFetch();
    vi.stubGlobal("fetch", f);
    const nums = Array.from({ length: n }, (_, i) => i + 1);
    const ev = await fetchSelectedPrCommits("owner", "repo", nums);
    expect(f.mock.calls.length).toBeLessThanOrEqual(n);
    expect(Object.keys(ev).map(Number).sort()).toEqual(nums);
  });

  it(`caps lookups at MAX_SELECTED_PR_LOOKUPS (${MAX_SELECTED_PR_LOOKUPS})`, async () => {
    const f = okFetch();
    vi.stubGlobal("fetch", f);
    await fetchSelectedPrCommits("owner", "repo", [1, 2, 3, 4, 5]);
    expect(f).toHaveBeenCalledTimes(MAX_SELECTED_PR_LOOKUPS);
  });

  it("fetches duplicates once and drops invalid numbers before building any URL", async () => {
    const f = okFetch();
    vi.stubGlobal("fetch", f);
    await fetchSelectedPrCommits("owner", "repo", [7, 7, 0, -1, 1.5, Number.NaN, 2 ** 60]);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("uses the exact endpoint and only api.github.com", async () => {
    const f = okFetch();
    vi.stubGlobal("fetch", f);
    const ev = await fetchSelectedPrCommits("owner", "repo", [42]);
    expect(String(f.mock.calls[0]![0])).toBe("https://api.github.com/repos/owner/repo/pulls/42/commits?per_page=100");
    expect(ev).toEqual({ 42: ["42-a", "42-b"] });
  });

  it.each([
    ["timeout", (): Response | Error => Object.assign(new Error("aborted"), { name: "AbortError" })],
    ["500", (): Response | Error => mockResponse("boom", 500)],
    ["429", (): Response | Error => mockResponse("slow down", 429)],
    ["malformed JSON", (): Response | Error => mockResponse("{not json")],
    ["redirect", (): Response | Error => mockResponse("", 302)],
  ])("a %s for one PR omits only that PR and never throws", async (_label, failure) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async (u: string | URL) => {
      const n = Number(/\/pulls\/(\d+)\/commits/.exec(String(u))![1]);
      if (n === 2) {
        const v = failure();
        if (v instanceof Error) throw v;
        return v;
      }
      return prCommits(n);
    }));
    const ev = await fetchSelectedPrCommits("owner", "repo", [1, 2, 3]);
    expect(Object.keys(ev).map(Number).sort()).toEqual([1, 3]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
