/**
 * Storyboard pipeline — sequences analysis, deep-dive selection, the lazy
 * selected-PR lookup, and storyboard generation (design.md §6a).
 *
 * This module only orchestrates. GitHub access stays in `analyzer.ts`, slide
 * logic stays in `storyboard.ts`, and `routes.ts` stays a transport boundary.
 */

import { analyzeRepository, fetchSelectedPrCommits, validateAndExtractTokens } from "./analyzer.js";
import { analysisCache, AnalysisCache } from "./cache.js";
import { generateStoryboard, prsNeedingEvidence, selectDeepDivePullRequests } from "./storyboard.js";
import type { RepoAnalysisResult, Slide } from "../types/index.js";

/**
 * Build the storyboard for a repository URL.
 *
 * 1. Validate the URL and derive the token-based cache key.
 * 2. Use the cached analysis, or analyze and cache it when complete.
 * 3. If the analysis already carries PR_Commit_Evidence, skip to step 7.
 * 4. Choose Selected_PRs (never reads evidence).
 * 5. Keep only Selected_PRs whose membership the graph can't prove.
 * 6. Fetch their commits (≤ 3 requests, never throws) and store the evidence
 *    on the analysis, so a cached entry keeps it.
 * 7. Generate the storyboard with the evidence.
 *
 * @param url - Raw user-submitted repository URL.
 * @returns The ordered slides.
 * @throws {@link ApiError} With code `invalid_url`, `repo_not_found`,
 *   `rate_limit_exceeded`, `request_timeout`, or `network_error` from the
 *   analysis, or `insufficient_content` from storyboard generation. The
 *   selected-PR lookup never throws.
 *
 * @remarks
 * Makes up to 12 GitHub requests on a cache miss, plus up to 3 selected-PR
 * lookups the first time a storyboard is built for an analysis. A cache hit
 * whose evidence has already been gathered makes none. Mutates the cached
 * analysis by setting `prCommitEvidence`.
 */
export async function buildStoryboardForUrl(url: string): Promise<Slide[]> {
  const { owner, repo } = validateAndExtractTokens(url);
  const cacheKey = AnalysisCache.keyFor(owner, repo);

  let analysis: RepoAnalysisResult | null = analysisCache.get(cacheKey);
  if (!analysis) {
    analysis = await analyzeRepository(url);
    if (analysis.partialFailures.length === 0) analysisCache.set(cacheKey, analysis);
  }

  if (analysis.prCommitEvidence === undefined) {
    const needed = prsNeedingEvidence(analysis, selectDeepDivePullRequests(analysis));
    analysis.prCommitEvidence =
      needed.length > 0 ? await fetchSelectedPrCommits(analysis.owner, analysis.repo, needed) : {};
  }

  return generateStoryboard(analysis, analysis.prCommitEvidence);
}
