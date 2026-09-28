/**
 * Repository analyzer — the sole module permitted to make GitHub API calls.
 *
 * All outbound requests are validated against the allowed host set, enforced
 * with a 10-second AbortController timeout, and capped at 10 MB body reads.
 * User-supplied URLs are never forwarded; only validated tokens are used.
 */

import { ApiError, Commit, DirectoryNode, RepoAnalysisResult, SpecDocument } from "../types/index.js";

// ---------------------------------------------------------------------------
// Module-level security constants
// ---------------------------------------------------------------------------

/**
 * Allowlist regex for user-submitted GitHub repository URLs.
 * Matches exactly `https://github.com/{owner}/{repo}` with no trailing
 * slashes, query strings, or extra path segments.
 */
const GITHUB_URL_RE =
  /^https:\/\/github\.com\/([a-zA-Z0-9_-]{1,100})\/([a-zA-Z0-9_-]{1,100})$/;

/**
 * The only hostnames this module is permitted to contact.
 * Any constructed URL whose hostname is not in this set is rejected.
 */
const ALLOWED_HOSTS = new Set<string>([
  "api.github.com",
  "raw.githubusercontent.com",
]);

/** Maximum response body size in bytes (10 MB). */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** Maximum README size in bytes (1 MB). */
const MAX_README_BYTES = 1 * 1024 * 1024;

/** Outbound request timeout in milliseconds (10 s). */
const FETCH_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Validate a user-submitted GitHub repository URL and extract owner/repo tokens.
 *
 * @param url - The raw user-submitted repository URL string.
 * @returns An object containing the validated `owner` and `repo` tokens.
 * @throws {@link ApiError} With code `invalid_url` if the URL does not match
 *   the allowlist regex.
 */
export function validateAndExtractTokens(
  url: string,
): { owner: string; repo: string } {
  const match = GITHUB_URL_RE.exec(url);
  if (!match) {
    throw new ApiError(
      "invalid_url",
      "Repository URL must match https://github.com/{owner}/{repo} where owner and repo contain only alphanumeric characters, hyphens, or underscores (1–100 characters each).",
    );
  }
  return { owner: match[1], repo: match[2] };
}

/**
 * Assert that a constructed URL targets only an allowed host, then fetch it
 * with a 10-second timeout and manual redirect handling.
 *
 * @param urlString - The fully constructed URL string to fetch.
 * @param options - Optional additional `RequestInit` options (merged last).
 * @returns The raw `Response` object from `fetch`.
 * @throws {@link ApiError} With code `invalid_url` if the URL hostname is not
 *   in the allowed host set.
 * @throws {@link ApiError} With code `request_timeout` if the request does not
 *   complete within 10 seconds.
 * @throws {@link ApiError} With code `network_error` for all other fetch failures.
 *
 * @remarks
 * Makes one outbound HTTPS request. Response body is not read here; callers
 * are responsible for capping body reads at `MAX_BODY_BYTES`.
 */
export async function safeFetch(
  urlString: string,
  options: RequestInit = {},
): Promise<Response> {
  const parsed = new URL(urlString);
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new ApiError(
      "invalid_url",
      `Request targets a disallowed host: ${parsed.hostname}`,
    );
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {
      "User-Agent": "kiro-repo-visualizer/1.0",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (process.env["GITHUB_PERSONAL_ACCESS_TOKEN"]) {
      headers["Authorization"] =
        `Bearer ${process.env["GITHUB_PERSONAL_ACCESS_TOKEN"]}`;
    }
    // Merge caller-provided headers, allowing overrides (e.g. raw Accept)
    const mergedHeaders = { ...headers, ...(options.headers as Record<string, string> | undefined ?? {}) };

    const response = await fetch(urlString, {
      ...options,
      headers: mergedHeaders,
      redirect: "manual",
      signal: controller.signal,
    });

    // Treat 3xx redirects as errors — never follow automatically
    if (response.status >= 300 && response.status < 400) {
      throw new ApiError(
        "network_error",
        "Unexpected redirect encountered; request aborted.",
      );
    }

    return response;
  } catch (err: unknown) {
    if (err instanceof ApiError) throw err;
    const name = err instanceof Error ? err.name : "";
    if (name === "AbortError") {
      throw new ApiError(
        "request_timeout",
        "The request to the external service timed out. Please try again.",
      );
    }
    throw new ApiError(
      "network_error",
      "A network error occurred while contacting the external service. Please try again.",
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Read a response body, enforcing a byte cap to prevent memory exhaustion.
 *
 * @param response - The `Response` object whose body will be read.
 * @param maxBytes - Maximum number of bytes to read before truncating.
 * @returns The response body as a UTF-8 string, truncated at `maxBytes`.
 * @throws {@link ApiError} With code `network_error` if body streaming fails.
 */
async function readCappedBody(
  response: Response,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return await response.text();
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        // Truncate at the cap — discard the rest
        chunks.push(value.slice(0, value.byteLength - (totalBytes - maxBytes)));
        break;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(chunks.reduce((acc, c) => acc + c.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

/**
 * Compute how many seconds a client should wait before retrying, based on
 * GitHub's rate-limit response headers.
 *
 * Prefers the `Retry-After` header (delta seconds) when present, otherwise
 * falls back to `X-RateLimit-Reset` (an epoch-seconds timestamp) relative to
 * the current time.
 *
 * @param response - The rate-limited response to inspect.
 * @param nowMs - The current time in milliseconds since the epoch. Defaults
 *   to `Date.now()`; injectable for deterministic testing.
 * @returns The number of whole seconds to wait, or `null` if neither header
 *   yields a usable positive value.
 */
export function computeRateLimitWaitSeconds(
  response: Response,
  nowMs: number = Date.now(),
): number | null {
  const retryAfter = response.headers.get("Retry-After");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.ceil(seconds);
    }
  }

  const reset = response.headers.get("X-RateLimit-Reset");
  if (reset !== null) {
    const resetEpoch = Number(reset);
    if (Number.isFinite(resetEpoch) && resetEpoch > 0) {
      const waitSeconds = Math.ceil(resetEpoch - nowMs / 1000);
      if (waitSeconds > 0) {
        return waitSeconds;
      }
    }
  }

  return null;
}

/**
 * Format a human-readable rate-limit message from a computed wait time.
 *
 * @param waitSeconds - Whole seconds to wait, or `null` if unknown.
 * @returns A user-facing message. When `waitSeconds` is null, the message
 *   avoids promising a specific duration.
 */
export function formatRateLimitMessage(waitSeconds: number | null): string {
  if (waitSeconds === null) {
    return "GitHub API rate limit reached. Please try again later.";
  }
  if (waitSeconds < 90) {
    return `GitHub API rate limit reached. Please retry in about ${waitSeconds} second${waitSeconds === 1 ? "" : "s"}.`;
  }
  const minutes = Math.ceil(waitSeconds / 60);
  return `GitHub API rate limit reached. Please retry in about ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

/**
 * Detect GitHub rate-limit responses and throw the appropriate ApiError.
 *
 * @param response - The response to inspect for rate-limit signals.
 * @throws {@link ApiError} With code `rate_limit_exceeded` if the response
 *   is HTTP 429 or carries `X-RateLimit-Remaining: 0`. The error message
 *   reflects the real wait time derived from `Retry-After` /
 *   `X-RateLimit-Reset` when available.
 */
function throwIfRateLimited(response: Response): void {
  const remaining = response.headers.get("X-RateLimit-Remaining");
  if (
    response.status === 429 ||
    (response.status === 403 && remaining === "0")
  ) {
    const waitSeconds = computeRateLimitWaitSeconds(response);
    throw new ApiError(
      "rate_limit_exceeded",
      formatRateLimitMessage(waitSeconds),
    );
  }
}

// ---------------------------------------------------------------------------
// Extraction steps
// ---------------------------------------------------------------------------

/**
 * Fetch the recursive git tree for a repository, filtered to at most 3
 * path-separator levels deep.
 *
 * @param owner - Validated GitHub owner login.
 * @param repo - Validated GitHub repository name.
 * @returns A flat array of {@link DirectoryNode} objects.
 * @throws {@link ApiError} With code `repo_not_found` if the repo is inaccessible.
 * @throws {@link ApiError} With code `rate_limit_exceeded` on rate-limit response.
 * @throws {@link ApiError} With code `request_timeout` on timeout.
 * @throws {@link ApiError} With code `network_error` on other network failures.
 *
 * @remarks
 * Makes one outbound HTTPS request to `api.github.com`.
 */
export async function fetchDirectoryTree(
  owner: string,
  repo: string,
): Promise<DirectoryNode[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`;
  const response = await safeFetch(url);

  throwIfRateLimited(response);

  if (response.status === 404 || response.status === 403) {
    throw new ApiError(
      "repo_not_found",
      "The repository could not be found or is not publicly accessible. Please check the URL and try again.",
    );
  }
  if (!response.ok) {
    throw new ApiError(
      "network_error",
      `GitHub API returned unexpected status ${response.status}.`,
    );
  }

  const body = await readCappedBody(response);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = JSON.parse(body) as { tree: any[] };

  // Filter to at most 3 path-separator levels (i.e. depth <= 3)
  const nodes: DirectoryNode[] = (data.tree ?? [])
    .filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (item: any) =>
        typeof item.path === "string" &&
        item.path.split("/").length <= 3,
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((item: any): DirectoryNode => ({
      path: item.path as string,
      type: item.type === "tree" ? "tree" : "blob",
      ...(typeof item.size === "number" ? { size: item.size } : {}),
    }));

  return nodes;
}

/**
 * Fetch the raw text of the repository README at the root level.
 *
 * @param owner - Validated GitHub owner login.
 * @param repo - Validated GitHub repository name.
 * @returns The README text string, or `null` if none exists or the request
 *   returns 404.
 * @throws {@link ApiError} With code `rate_limit_exceeded` on rate-limit response.
 * @throws {@link ApiError} With code `request_timeout` on timeout.
 * @throws {@link ApiError} With code `network_error` on other network failures.
 *
 * @remarks
 * Makes one outbound HTTPS request to `api.github.com`.
 */
export async function fetchReadme(
  owner: string,
  repo: string,
): Promise<string | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/readme`;
  const response = await safeFetch(url, {
    headers: { Accept: "application/vnd.github.raw+json" },
  });

  throwIfRateLimited(response);

  if (response.status === 404) {
    return null;
  }
  if (response.status === 403) {
    throw new ApiError(
      "repo_not_found",
      "The repository could not be found or is not publicly accessible. Please check the URL and try again.",
    );
  }
  if (!response.ok) {
    throw new ApiError(
      "network_error",
      `GitHub API returned unexpected status ${response.status}.`,
    );
  }

  return await readCappedBody(response, MAX_README_BYTES);
}

/**
 * Fetch the 50 most-recent commits for a repository.
 *
 * @param owner - Validated GitHub owner login.
 * @param repo - Validated GitHub repository name.
 * @returns An array of up to 50 {@link Commit} records in reverse-chronological order.
 * @throws {@link ApiError} With code `repo_not_found` if the repo is inaccessible.
 * @throws {@link ApiError} With code `rate_limit_exceeded` on rate-limit response.
 * @throws {@link ApiError} With code `request_timeout` on timeout.
 * @throws {@link ApiError} With code `network_error` on other network failures.
 *
 * @remarks
 * Makes one outbound HTTPS request to `api.github.com`.
 */
export async function fetchCommits(
  owner: string,
  repo: string,
): Promise<Commit[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/commits?per_page=50`;
  const response = await safeFetch(url);

  throwIfRateLimited(response);

  if (response.status === 404 || response.status === 403) {
    throw new ApiError(
      "repo_not_found",
      "The repository could not be found or is not publicly accessible. Please check the URL and try again.",
    );
  }
  if (!response.ok) {
    throw new ApiError(
      "network_error",
      `GitHub API returned unexpected status ${response.status}.`,
    );
  }

  const body = await readCappedBody(response);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items = JSON.parse(body) as any[];

  return items.map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (item: any): Commit => ({
      sha: String(item.sha ?? ""),
      author: String(
        item.commit?.author?.name ?? item.author?.login ?? "Unknown",
      ),
      timestamp: String(item.commit?.author?.date ?? ""),
      message: String(item.commit?.message ?? "").split("\n")[0] ?? "",
    }),
  );
}

/**
 * Fetch spec documents from the `.kiro` directory of a repository.
 *
 * Each file whose `download_url` resolves to an allowed host is fetched
 * individually; files exceeding 1 MB are skipped silently.
 *
 * @param owner - Validated GitHub owner login.
 * @param repo - Validated GitHub repository name.
 * @returns An array of {@link SpecDocument} objects. Returns an empty array
 *   if the `.kiro` directory does not exist (404).
 * @throws {@link ApiError} With code `rate_limit_exceeded` on rate-limit response.
 * @throws {@link ApiError} With code `request_timeout` on timeout.
 * @throws {@link ApiError} With code `network_error` on other network failures.
 *
 * @remarks
 * Makes one directory-listing request plus one request per spec file found.
 * All requests target `api.github.com` or `raw.githubusercontent.com`.
 */
export async function fetchSpecDocs(
  owner: string,
  repo: string,
): Promise<SpecDocument[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/.kiro`;
  const response = await safeFetch(url);

  throwIfRateLimited(response);

  if (response.status === 404) {
    return [];
  }
  if (response.status === 403) {
    throw new ApiError(
      "repo_not_found",
      "The repository could not be found or is not publicly accessible. Please check the URL and try again.",
    );
  }
  if (!response.ok) {
    throw new ApiError(
      "network_error",
      `GitHub API returned unexpected status ${response.status}.`,
    );
  }

  const body = await readCappedBody(response);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entries = JSON.parse(body) as any[];

  const docs: SpecDocument[] = [];
  for (const entry of entries) {
    if (entry.type !== "file") continue;
    if (typeof entry.size === "number" && entry.size > MAX_README_BYTES) continue;

    const downloadUrl: string | undefined = entry.download_url;
    if (!downloadUrl) continue;

    try {
      // Assert the download URL targets an allowed host before fetching
      const parsed = new URL(downloadUrl);
      if (!ALLOWED_HOSTS.has(parsed.hostname)) continue;

      const fileResponse = await safeFetch(downloadUrl, {
        headers: { Accept: "application/vnd.github.raw+json" },
      });
      throwIfRateLimited(fileResponse);
      if (!fileResponse.ok) continue;

      const content = await readCappedBody(fileResponse, MAX_README_BYTES);
      docs.push({ path: String(entry.path ?? ""), content });
    } catch (err: unknown) {
      // Skip this file on any per-file error; don't abort the whole step
      if (err instanceof ApiError && err.code === "rate_limit_exceeded") {
        throw err; // rate-limit errors propagate
      }
    }
  }

  return docs;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Analyse a public GitHub repository by running all four extraction steps.
 *
 * Steps run concurrently via `Promise.allSettled`. Any step that fails for
 * a reason other than rate-limiting is recorded in `partialFailures` and the
 * remaining data is returned. If the URL is invalid or the repo is
 * inaccessible, an `ApiError` is thrown immediately without running the steps.
 *
 * @param url - A raw user-submitted repository URL string.
 * @returns A {@link RepoAnalysisResult} containing all successfully fetched
 *   data and the names of any steps that were skipped.
 * @throws {@link ApiError} With code `invalid_url` if `url` fails format
 *   validation.
 * @throws {@link ApiError} With code `rate_limit_exceeded` if any extraction
 *   step hits the GitHub rate limit.
 *
 * @remarks
 * Makes up to 4+ outbound HTTPS requests to `api.github.com` and
 * `raw.githubusercontent.com`.
 */
export async function analyzeRepository(
  url: string,
): Promise<RepoAnalysisResult> {
  const { owner, repo } = validateAndExtractTokens(url);

  const [treeResult, readmeResult, commitsResult, specDocsResult] =
    await Promise.allSettled([
      fetchDirectoryTree(owner, repo),
      fetchReadme(owner, repo),
      fetchCommits(owner, repo),
      fetchSpecDocs(owner, repo),
    ]);

  // Re-throw rate-limit errors immediately — they affect every step
  for (const result of [treeResult, readmeResult, commitsResult, specDocsResult]) {
    if (
      result.status === "rejected" &&
      result.reason instanceof ApiError &&
      result.reason.code === "rate_limit_exceeded"
    ) {
      throw result.reason;
    }
  }

  // If the repo is inaccessible the tree step will fail with repo_not_found
  if (
    treeResult.status === "rejected" &&
    treeResult.reason instanceof ApiError &&
    treeResult.reason.code === "repo_not_found"
  ) {
    throw treeResult.reason;
  }

  const partialFailures: string[] = [];

  const directoryTree =
    treeResult.status === "fulfilled"
      ? treeResult.value
      : (partialFailures.push("directoryTree"), []);

  const readmeText =
    readmeResult.status === "fulfilled"
      ? readmeResult.value
      : (partialFailures.push("readme"), null);

  const commits =
    commitsResult.status === "fulfilled"
      ? commitsResult.value
      : (partialFailures.push("commits"), []);

  const specDocs =
    specDocsResult.status === "fulfilled"
      ? specDocsResult.value
      : (partialFailures.push("specDocs"), []);

  return {
    owner,
    repo,
    directoryTree,
    readmeText,
    commits,
    specDocs,
    partialFailures,
  };
}
