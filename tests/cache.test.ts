/**
 * Unit tests for src/server/cache.ts — the bounded TTL analysis cache.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  AnalysisCache,
  ANALYSIS_CACHE_TTL_MS,
  ANALYSIS_CACHE_MAX_ENTRIES,
} from "../src/server/cache.js";
import { RepoAnalysisResult } from "../src/types/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(owner: string, repo: string): RepoAnalysisResult {
  return {
    owner,
    repo,
    directoryTree: [{ path: "src", type: "tree" }],
    readmeText: "# readme",
    commits: [],
    specDocs: [],
    partialFailures: [],
  };
}

// ---------------------------------------------------------------------------
// keyFor
// ---------------------------------------------------------------------------

describe("AnalysisCache.keyFor", () => {
  it("lowercases owner and repo", () => {
    expect(AnalysisCache.keyFor("SindreSorhus", "Slugify")).toBe("sindresorhus/slugify");
  });

  it("produces the same key regardless of input casing", () => {
    expect(AnalysisCache.keyFor("OcToCat", "Hello-World")).toBe(
      AnalysisCache.keyFor("octocat", "hello-world"),
    );
  });
});

// ---------------------------------------------------------------------------
// hit / miss
// ---------------------------------------------------------------------------

describe("AnalysisCache get/set", () => {
  let cache: AnalysisCache;

  beforeEach(() => {
    cache = new AnalysisCache();
  });

  it("returns null on a miss", () => {
    expect(cache.get("octocat/hello-world")).toBeNull();
  });

  it("returns the stored value on a hit within TTL", () => {
    const key = AnalysisCache.keyFor("octocat", "hello-world");
    const value = makeResult("octocat", "hello-world");
    cache.set(key, value, 1_000);
    expect(cache.get(key, 2_000)).toBe(value);
  });

  it("keys are token-derived, not raw URLs", () => {
    const key = AnalysisCache.keyFor("octocat", "hello-world");
    cache.set(key, makeResult("octocat", "hello-world"), 0);
    // A raw-URL-style key must not resolve
    expect(cache.get("https://github.com/octocat/hello-world", 0)).toBeNull();
    expect(cache.get(key, 0)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TTL expiry
// ---------------------------------------------------------------------------

describe("AnalysisCache TTL expiry", () => {
  it("returns null once the entry is older than the TTL", () => {
    const cache = new AnalysisCache(ANALYSIS_CACHE_TTL_MS);
    const key = AnalysisCache.keyFor("o", "r");
    cache.set(key, makeResult("o", "r"), 0);

    // Just before expiry → hit
    expect(cache.get(key, ANALYSIS_CACHE_TTL_MS - 1)).not.toBeNull();
    // Exactly at TTL → expired (>= boundary)
    expect(cache.get(key, ANALYSIS_CACHE_TTL_MS)).toBeNull();
  });

  it("purges the expired entry on access", () => {
    const cache = new AnalysisCache(1_000);
    const key = AnalysisCache.keyFor("o", "r");
    cache.set(key, makeResult("o", "r"), 0);
    expect(cache.size).toBe(1);
    cache.get(key, 5_000); // expired access purges
    expect(cache.size).toBe(0);
  });

  it("respects a custom TTL", () => {
    const cache = new AnalysisCache(500);
    const key = AnalysisCache.keyFor("o", "r");
    cache.set(key, makeResult("o", "r"), 0);
    expect(cache.get(key, 499)).not.toBeNull();
    expect(cache.get(key, 500)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// max-size eviction
// ---------------------------------------------------------------------------

describe("AnalysisCache max-size eviction", () => {
  it("evicts the oldest entry when full", () => {
    const cache = new AnalysisCache(ANALYSIS_CACHE_TTL_MS, 3);
    cache.set("a/1", makeResult("a", "1"), 0);
    cache.set("b/2", makeResult("b", "2"), 0);
    cache.set("c/3", makeResult("c", "3"), 0);
    expect(cache.size).toBe(3);

    // Adding a 4th evicts the oldest ("a/1")
    cache.set("d/4", makeResult("d", "4"), 0);
    expect(cache.size).toBe(3);
    expect(cache.get("a/1", 0)).toBeNull();
    expect(cache.get("b/2", 0)).not.toBeNull();
    expect(cache.get("d/4", 0)).not.toBeNull();
  });

  it("re-setting an existing key refreshes its recency (not evicted first)", () => {
    const cache = new AnalysisCache(ANALYSIS_CACHE_TTL_MS, 2);
    cache.set("a/1", makeResult("a", "1"), 0);
    cache.set("b/2", makeResult("b", "2"), 0);
    // Re-set "a/1" → it becomes newest, so "b/2" is now oldest
    cache.set("a/1", makeResult("a", "1"), 0);
    cache.set("c/3", makeResult("c", "3"), 0); // evicts oldest = "b/2"
    expect(cache.get("b/2", 0)).toBeNull();
    expect(cache.get("a/1", 0)).not.toBeNull();
    expect(cache.get("c/3", 0)).not.toBeNull();
  });

  it("default max entries constant is 100", () => {
    expect(ANALYSIS_CACHE_MAX_ENTRIES).toBe(100);
  });

  it("default TTL constant is 15 minutes", () => {
    expect(ANALYSIS_CACHE_TTL_MS).toBe(15 * 60 * 1000);
  });
});
