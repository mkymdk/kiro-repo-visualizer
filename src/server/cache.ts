/**
 * Bounded, time-to-live (TTL) cache for repository analysis results.
 *
 * This module holds successful `RepoAnalysisResult` values so that repeated
 * analyses of the same repository within the TTL window do not re-hit the
 * GitHub API. It is pure in-memory state with no I/O and no network access,
 * so it does not affect any design.md security constraint.
 *
 * Keys are the validated, lowercased `owner/repo` tokens — never the raw
 * user-submitted URL.
 */

import { RepoAnalysisResult } from "../types/index.js";

/** Time-to-live for a cached analysis result, in milliseconds (15 minutes). */
export const ANALYSIS_CACHE_TTL_MS = 15 * 60 * 1000;

/** Maximum number of entries retained before the oldest is evicted. */
export const ANALYSIS_CACHE_MAX_ENTRIES = 100;

/** Internal wrapper pairing a cached value with its insertion timestamp. */
interface CacheEntry {
  /** The cached analysis result. */
  value: RepoAnalysisResult;
  /** Epoch milliseconds at which this entry was stored. */
  storedAtMs: number;
}

/**
 * A bounded TTL cache keyed by validated `owner/repo`.
 *
 * Insertion-ordered: when the cache is full, the oldest inserted entry is
 * evicted. Entries older than the TTL are treated as absent and removed on
 * access.
 */
export class AnalysisCache {
  private readonly store: Map<string, CacheEntry> = new Map();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  /**
   * Construct a new analysis cache.
   *
   * @param ttlMs - Entry time-to-live in milliseconds. Defaults to
   *   {@link ANALYSIS_CACHE_TTL_MS}.
   * @param maxEntries - Maximum entries before oldest-eviction. Defaults to
   *   {@link ANALYSIS_CACHE_MAX_ENTRIES}.
   */
  constructor(
    ttlMs: number = ANALYSIS_CACHE_TTL_MS,
    maxEntries: number = ANALYSIS_CACHE_MAX_ENTRIES,
  ) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  /**
   * Build the canonical cache key from owner/repo tokens.
   *
   * @param owner - Validated GitHub owner login.
   * @param repo - Validated GitHub repository name.
   * @returns A lowercased `owner/repo` key.
   */
  static keyFor(owner: string, repo: string): string {
    return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
  }

  /**
   * Retrieve a cached analysis result if present and not expired.
   *
   * @param key - The `owner/repo` key produced by {@link AnalysisCache.keyFor}.
   * @param nowMs - Current time in epoch milliseconds. Defaults to `Date.now()`;
   *   injectable for deterministic testing.
   * @returns The cached {@link RepoAnalysisResult}, or `null` on miss/expiry.
   *
   * @remarks
   * Expired entries are deleted as a side effect of this lookup.
   */
  get(key: string, nowMs: number = Date.now()): RepoAnalysisResult | null {
    const entry = this.store.get(key);
    if (!entry) {
      return null;
    }
    if (nowMs - entry.storedAtMs >= this.ttlMs) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  /**
   * Store an analysis result, evicting the oldest entry if the cache is full.
   *
   * @param key - The `owner/repo` key produced by {@link AnalysisCache.keyFor}.
   * @param value - The analysis result to cache.
   * @param nowMs - Current time in epoch milliseconds. Defaults to `Date.now()`;
   *   injectable for deterministic testing.
   *
   * @remarks
   * Mutates internal cache state. Callers are responsible for not caching
   * error or partial results.
   */
  set(key: string, value: RepoAnalysisResult, nowMs: number = Date.now()): void {
    // Refresh insertion order: delete then re-set so this key is newest.
    this.store.delete(key);

    if (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      }
    }

    this.store.set(key, { value, storedAtMs: nowMs });
  }

  /**
   * Current number of stored entries (including any not-yet-purged expired
   * entries).
   *
   * @returns The entry count.
   */
  get size(): number {
    return this.store.size;
  }

  /**
   * Remove all entries. Primarily for test isolation.
   */
  clear(): void {
    this.store.clear();
  }
}

/** Module-level singleton cache used by the route handlers. */
export const analysisCache = new AnalysisCache();
