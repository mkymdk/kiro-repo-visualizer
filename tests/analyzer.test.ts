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
    body: null,
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
  afterEach(() => vi.unstubAllGlobals());

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
  afterEach(() => vi.unstubAllGlobals());

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
  afterEach(() => vi.unstubAllGlobals());

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
// fetchSpecDocs
// ---------------------------------------------------------------------------

describe("fetchSpecDocs", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns empty array on 404 (.kiro directory absent)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse("Not Found", 404)));
    const result = await fetchSpecDocs("owner", "repo");
    expect(result).toEqual([]);
  });

  it("fetches each file and returns SpecDocument[]", async () => {
    const listing = [
      {
        type: "file",
        path: ".kiro/design.md",
        size: 500,
        download_url: "https://raw.githubusercontent.com/owner/repo/main/.kiro/design.md",
      },
    ];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResponse(listing))           // directory listing
      .mockResolvedValueOnce(mockResponse("# Design Doc"));   // file content
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchSpecDocs("owner", "repo");
    expect(result).toHaveLength(1);
    expect(result[0]?.content).toBe("# Design Doc");
  });

  it("skips files > 1 MB", async () => {
    const listing = [
      {
        type: "file",
        path: ".kiro/huge.md",
        size: 2 * 1024 * 1024, // 2 MB — exceeds limit
        download_url: "https://raw.githubusercontent.com/owner/repo/main/.kiro/huge.md",
      },
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(listing)));
    const result = await fetchSpecDocs("owner", "repo");
    expect(result).toEqual([]);
  });

  it("skips files whose download_url targets a disallowed host", async () => {
    const listing = [
      {
        type: "file",
        path: ".kiro/evil.md",
        size: 100,
        download_url: "https://evil.example.com/file.md",
      },
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(listing)));
    const result = await fetchSpecDocs("owner", "repo");
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// analyzeRepository — integration of all steps
// ---------------------------------------------------------------------------

describe("analyzeRepository", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("throws invalid_url for a non-GitHub URL", async () => {
    await expect(analyzeRepository("https://gitlab.com/o/r")).rejects.toThrow(
      expect.objectContaining({ code: "invalid_url" }),
    );
  });

  it("throws repo_not_found when the tree step returns 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse("Not Found", 404)));
    await expect(analyzeRepository("https://github.com/owner/repo")).rejects.toThrow(
      expect.objectContaining({ code: "repo_not_found" }),
    );
  });

  it("returns partial result when one step fails", async () => {
    // Step 1 (tree): success
    // Step 2 (readme): 404 → null (not a failure)
    // Step 3 (commits): network error → partial failure
    // Step 4 (specDocs): 404 → [] (not a failure)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResponse({ tree: BASE_TREE }))    // tree
      .mockResolvedValueOnce(mockResponse("", 404))                // readme → null
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))            // commits → fail
      .mockResolvedValueOnce(mockResponse("[]", 404));             // specDocs → []
    vi.stubGlobal("fetch", fetchMock);
    const result = await analyzeRepository("https://github.com/owner/repo");
    expect(result.partialFailures).toContain("commits");
    expect(result.directoryTree.length).toBeGreaterThan(0);
  });

  it("propagates rate_limit_exceeded immediately", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(mockResponse("Too Many Requests", 429)),
    );
    await expect(analyzeRepository("https://github.com/owner/repo")).rejects.toThrow(
      expect.objectContaining({ code: "rate_limit_exceeded" }),
    );
  });

  it("returns a RepoAnalysisResult with all fields on full success", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResponse({ tree: BASE_TREE }))  // tree
      .mockResolvedValueOnce(mockResponse("# README"))           // readme
      .mockResolvedValueOnce(mockResponse(BASE_COMMITS))         // commits
      .mockResolvedValueOnce(mockResponse("Not Found", 404));    // specDocs
    vi.stubGlobal("fetch", fetchMock);
    const result = await analyzeRepository("https://github.com/owner/repo");
    expect(result.owner).toBe("owner");
    expect(result.repo).toBe("repo");
    expect(result.readmeText).toBe("# README");
    expect(result.commits).toHaveLength(1);
    expect(result.specDocs).toEqual([]);
    expect(result.partialFailures).toEqual([]);
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
  afterEach(() => vi.unstubAllGlobals());

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
