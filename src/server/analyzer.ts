/**
 * Repository analyzer — the sole module permitted to make GitHub API calls.
 *
 * All outbound requests are validated against the allowed host set, enforced
 * with a 10-second AbortController timeout, and capped at 10 MB body reads.
 * User-supplied URLs are never forwarded; only validated tokens are used.
 */

import {
  ApiError,
  Commit,
  DirectoryNode,
  PullRequest,
  Release,
  RepoAnalysisResult,
  RepoMetadata,
  SpecDocument,
} from "../types/index.js";

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

/** Maximum number of `.kiro/specs/` Markdown files fetched per analysis. */
const MAX_SPEC_FILES = 6;

/** Maximum characters kept from a pull request or release body. */
const MAX_CHANGE_BODY_CHARS = 10_000;

/** Spec documents must be Markdown files under `.kiro/specs/`. */
const SPEC_PATH_RE = /^\.kiro\/specs\/.+\.md$/i;

/** Spec basenames fetched before any other spec file. */
const PRIORITY_SPEC_BASENAMES = new Set<string>(["requirements.md", "design.md"]);

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
// Response helpers
// ---------------------------------------------------------------------------

/** Error thrown when a repository lookup is refused or the repository is missing. */
function repoNotFound(): ApiError {
  return new ApiError(
    "repo_not_found",
    "The repository could not be found or is not publicly accessible. Please check the URL and try again.",
  );
}

/**
 * Throw `network_error` for any non-2xx response that was not already handled.
 *
 * @param response - The response to check.
 * @throws {@link ApiError} With code `network_error` when `response.ok` is false.
 */
function throwIfNotOk(response: Response): void {
  if (!response.ok) {
    throw new ApiError(
      "network_error",
      `GitHub API returned unexpected status ${response.status}.`,
    );
  }
}

/**
 * Parse a capped response body as JSON.
 *
 * @param response - A successful response.
 * @returns The parsed JSON value.
 * @throws {@link ApiError} With code `network_error` if the body is not valid JSON.
 */
async function readJson(response: Response): Promise<unknown> {
  const text = await readCappedBody(response);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError("network_error", "GitHub API returned malformed JSON.");
  }
}

/** Narrow an unknown JSON value to a plain object record. */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Narrow an unknown JSON value to an array of records. */
function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

/** Return `value` when it is a non-empty string, otherwise null. */
function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// ---------------------------------------------------------------------------
// Extraction steps
// ---------------------------------------------------------------------------

/** Tree step output: the 3-level listing plus every blob for spec selection. */
export interface RepositoryTree {
  /** Nodes up to 3 path-separator levels deep. */
  directoryTree: DirectoryNode[];
  /** Every blob in the tree, unfiltered by depth. */
  blobs: DirectoryNode[];
}

/**
 * Fetch repository metadata (description, topics, stars, language, license).
 *
 * This is the authoritative repository-accessibility check (Req 1.4).
 *
 * @param owner - Validated GitHub owner login.
 * @param repo - Validated GitHub repository name.
 * @returns The {@link RepoMetadata} for the repository.
 * @throws {@link ApiError} With code `repo_not_found` on 404 or a non-rate-limit 403.
 * @throws {@link ApiError} With code `rate_limit_exceeded` on rate-limit response.
 * @throws {@link ApiError} With code `request_timeout` on timeout.
 * @throws {@link ApiError} With code `network_error` on other failures.
 *
 * @remarks
 * Makes one outbound HTTPS request to `api.github.com`.
 */
export async function fetchMetadata(
  owner: string,
  repo: string,
): Promise<RepoMetadata> {
  const response = await safeFetch(`https://api.github.com/repos/${owner}/${repo}`);
  throwIfRateLimited(response);
  if (response.status === 404 || response.status === 403) throw repoNotFound();
  throwIfNotOk(response);

  const data = asRecord(await readJson(response));
  const license = asRecord(data["license"]);
  return {
    description: stringOrNull(data["description"]),
    topics: Array.isArray(data["topics"])
      ? data["topics"].filter((t): t is string => typeof t === "string")
      : [],
    stars: typeof data["stargazers_count"] === "number" ? data["stargazers_count"] : null,
    language: stringOrNull(data["language"]),
    license:
      stringOrNull(license["spdx_id"]) === "NOASSERTION"
        ? stringOrNull(license["name"])
        : (stringOrNull(license["spdx_id"]) ?? stringOrNull(license["name"])),
  };
}

/**
 * Fetch the recursive git tree, returning the 3-level listing and all blobs.
 *
 * @param owner - Validated GitHub owner login.
 * @param repo - Validated GitHub repository name.
 * @returns A {@link RepositoryTree}.
 * @throws {@link ApiError} With code `repo_not_found` if the repo is inaccessible.
 * @throws {@link ApiError} With code `rate_limit_exceeded` on rate-limit response.
 * @throws {@link ApiError} With code `request_timeout` on timeout.
 * @throws {@link ApiError} With code `network_error` on other network failures.
 *
 * @remarks
 * Makes one outbound HTTPS request to `api.github.com`.
 */
export async function fetchRepositoryTree(
  owner: string,
  repo: string,
): Promise<RepositoryTree> {
  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`;
  const response = await safeFetch(url);
  throwIfRateLimited(response);
  if (response.status === 404 || response.status === 403) throw repoNotFound();
  throwIfNotOk(response);

  const data = asRecord(await readJson(response));
  const all: DirectoryNode[] = asRecordArray(data["tree"])
    .filter((item) => typeof item["path"] === "string")
    .map((item): DirectoryNode => ({
      path: item["path"] as string,
      type: item["type"] === "tree" ? "tree" : "blob",
      ...(typeof item["size"] === "number" ? { size: item["size"] } : {}),
    }));

  return {
    directoryTree: all.filter((n) => n.path.split("/").length <= 3),
    blobs: all.filter((n) => n.type === "blob"),
  };
}

/**
 * Fetch the git tree filtered to at most 3 path-separator levels deep.
 *
 * @param owner - Validated GitHub owner login.
 * @param repo - Validated GitHub repository name.
 * @returns A flat array of {@link DirectoryNode} objects.
 * @throws {@link ApiError} As for {@link fetchRepositoryTree}.
 *
 * @remarks
 * Makes one outbound HTTPS request to `api.github.com`.
 */
export async function fetchDirectoryTree(
  owner: string,
  repo: string,
): Promise<DirectoryNode[]> {
  return (await fetchRepositoryTree(owner, repo)).directoryTree;
}

/**
 * Fetch the raw text of the repository README at the root level.
 *
 * @param owner - Validated GitHub owner login.
 * @param repo - Validated GitHub repository name.
 * @returns The README text, or `null` if none exists.
 * @throws {@link ApiError} With code `repo_not_found` on a non-rate-limit 403.
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
  const response = await safeFetch(`https://api.github.com/repos/${owner}/${repo}/readme`, {
    headers: { Accept: "application/vnd.github.raw+json" },
  });
  throwIfRateLimited(response);
  if (response.status === 404) return null;
  if (response.status === 403) throw repoNotFound();
  throwIfNotOk(response);
  return await readCappedBody(response, MAX_README_BYTES);
}

/**
 * Split a full commit message into its subject and body.
 *
 * @param message - The full commit message.
 * @returns The first line as `subject`, and the remainder with leading blank
 *   lines and trailing whitespace removed as `body`.
 */
export function splitCommitMessage(message: string): { subject: string; body: string } {
  const lines = message.replace(/\r\n/g, "\n").split("\n");
  const subject = (lines[0] ?? "").trim();
  const rest = lines.slice(1);
  while (rest.length > 0 && (rest[0] ?? "").trim() === "") rest.shift();
  return { subject, body: rest.join("\n").trimEnd() };
}

/**
 * Fetch the 50 most-recent commits for a repository.
 *
 * @param owner - Validated GitHub owner login.
 * @param repo - Validated GitHub repository name.
 * @returns Up to 50 {@link Commit} records in reverse-chronological order.
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
  const response = await safeFetch(
    `https://api.github.com/repos/${owner}/${repo}/commits?per_page=50`,
  );
  throwIfRateLimited(response);
  if (response.status === 404 || response.status === 403) throw repoNotFound();
  throwIfNotOk(response);

  return asRecordArray(await readJson(response)).map((item): Commit => {
    const commit = asRecord(item["commit"]);
    const author = asRecord(commit["author"]);
    const { subject, body } = splitCommitMessage(String(commit["message"] ?? ""));
    return {
      sha: String(item["sha"] ?? ""),
      author: String(author["name"] ?? asRecord(item["author"])["login"] ?? "Unknown"),
      timestamp: String(author["date"] ?? ""),
      subject,
      body,
      message: subject,
    };
  });
}

/**
 * Choose which `.kiro/specs/` Markdown files to fetch.
 *
 * Keeps blobs matching `.kiro/specs/**\/*.md` that are at most 1 MB and whose
 * path has no empty, `.`, or `..` segment. `requirements.md` and `design.md`
 * come first, then all others; ties are ordered by ascending path. At most
 * `MAX_SPEC_FILES` paths are returned.
 *
 * @param blobs - Every blob from the repository tree (untrusted paths).
 * @returns The selected spec file paths.
 */
export function selectSpecPaths(blobs: DirectoryNode[]): string[] {
  const priority = (p: string): number =>
    PRIORITY_SPEC_BASENAMES.has((p.split("/").pop() ?? "").toLowerCase()) ? 0 : 1;

  return blobs
    .filter((b) => b.type === "blob")
    .filter((b) => SPEC_PATH_RE.test(b.path))
    .filter((b) => b.path.split("/").every((seg) => seg !== "" && seg !== "." && seg !== ".."))
    .filter((b) => !/[\0\\]/.test(b.path))
    .filter((b) => typeof b.size !== "number" || b.size <= MAX_README_BYTES)
    .map((b) => b.path)
    .sort((a, b) => priority(a) - priority(b) || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MAX_SPEC_FILES);
}

/**
 * Fetch the content of the selected spec documents.
 *
 * Each path is re-validated and URL-encoded per segment before being placed in
 * a `contents` URL. A failure on one file skips that file; rate-limit errors
 * propagate.
 *
 * @param owner - Validated GitHub owner login.
 * @param repo - Validated GitHub repository name.
 * @param paths - Paths chosen by {@link selectSpecPaths}.
 * @returns The fetched {@link SpecDocument} objects, in `paths` order.
 * @throws {@link ApiError} With code `rate_limit_exceeded` on rate-limit response.
 *
 * @remarks
 * Makes one outbound HTTPS request to `api.github.com` per path.
 */
export async function fetchSpecDocs(
  owner: string,
  repo: string,
  paths: string[],
): Promise<SpecDocument[]> {
  const docs: SpecDocument[] = [];
  for (const path of selectSpecPaths(paths.map((p) => ({ path: p, type: "blob" })))) {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    try {
      const response = await safeFetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/${encoded}`,
        { headers: { Accept: "application/vnd.github.raw+json" } },
      );
      throwIfRateLimited(response);
      if (!response.ok) continue;
      docs.push({ path, content: await readCappedBody(response, MAX_README_BYTES) });
    } catch (err: unknown) {
      if (err instanceof ApiError && err.code === "rate_limit_exceeded") throw err;
      // Skip this file on any other error; the step as a whole continues.
    }
  }
  return docs;
}

/**
 * Fetch merged pull requests among the 50 most recently updated closed PRs.
 *
 * @param owner - Validated GitHub owner login.
 * @param repo - Validated GitHub repository name.
 * @returns Merged {@link PullRequest} records; `[]` when none exist or on 404.
 * @throws {@link ApiError} With code `rate_limit_exceeded` on rate-limit response.
 * @throws {@link ApiError} With code `request_timeout` on timeout.
 * @throws {@link ApiError} With code `network_error` on other failures.
 *
 * @remarks
 * Makes one outbound HTTPS request to `api.github.com`.
 */
export async function fetchPullRequests(
  owner: string,
  repo: string,
): Promise<PullRequest[]> {
  const response = await safeFetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=50`,
  );
  throwIfRateLimited(response);
  if (response.status === 404) return [];
  throwIfNotOk(response);

  return asRecordArray(await readJson(response))
    .filter((item) => typeof item["merged_at"] === "string")
    .map((item): PullRequest => {
      const user = asRecord(item["user"]);
      const login = String(user["login"] ?? "");
      return {
        number: typeof item["number"] === "number" ? item["number"] : 0,
        title: String(item["title"] ?? ""),
        body: String(item["body"] ?? "").slice(0, MAX_CHANGE_BODY_CHARS),
        labels: asRecordArray(item["labels"])
          .map((l) => String(l["name"] ?? "").toLowerCase())
          .filter((l) => l.length > 0),
        mergedAt: item["merged_at"] as string,
        isBot: user["type"] === "Bot" || login.endsWith("[bot]"),
      };
    });
}

/**
 * Fetch published, non-draft releases among the 10 most recent.
 *
 * @param owner - Validated GitHub owner login.
 * @param repo - Validated GitHub repository name.
 * @returns {@link Release} records; `[]` when none exist or on 404.
 * @throws {@link ApiError} With code `rate_limit_exceeded` on rate-limit response.
 * @throws {@link ApiError} With code `request_timeout` on timeout.
 * @throws {@link ApiError} With code `network_error` on other failures.
 *
 * @remarks
 * Makes one outbound HTTPS request to `api.github.com`.
 */
export async function fetchReleases(
  owner: string,
  repo: string,
): Promise<Release[]> {
  const response = await safeFetch(
    `https://api.github.com/repos/${owner}/${repo}/releases?per_page=10`,
  );
  throwIfRateLimited(response);
  if (response.status === 404) return [];
  throwIfNotOk(response);

  return asRecordArray(await readJson(response))
    .filter((item) => item["draft"] !== true)
    .filter((item) => typeof item["published_at"] === "string")
    .map((item): Release => ({
      name: stringOrNull(item["name"]),
      tagName: String(item["tag_name"] ?? ""),
      publishedAt: item["published_at"] as string,
      body: String(item["body"] ?? "").slice(0, MAX_CHANGE_BODY_CHARS),
    }));
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/** Return the fulfilled value, or record `name` as a partial failure and return `fallback`. */
function settledOr<T>(
  result: PromiseSettledResult<T>,
  name: string,
  fallback: T,
  partialFailures: string[],
): T {
  if (result.status === "fulfilled") return result.value;
  partialFailures.push(name);
  return fallback;
}

/** True when a settled result rejected with the given ApiError code. */
function rejectedWith(result: PromiseSettledResult<unknown>, code: string): boolean {
  return (
    result.status === "rejected" &&
    result.reason instanceof ApiError &&
    result.reason.code === code
  );
}

/**
 * Analyse a public GitHub repository by running all extraction steps.
 *
 * Metadata, tree, README, commits, pull requests, and releases run
 * concurrently; spec documents are fetched once the tree resolves. Any step
 * that fails for a reason other than rate-limiting is recorded in
 * `partialFailures` and the remaining data is returned. Legitimately empty
 * sources are returned as empty values and are not recorded as failures.
 *
 * @param url - A raw user-submitted repository URL string.
 * @returns A {@link RepoAnalysisResult}.
 * @throws {@link ApiError} With code `invalid_url` if `url` fails validation.
 * @throws {@link ApiError} With code `repo_not_found` if the repository is inaccessible.
 * @throws {@link ApiError} With code `rate_limit_exceeded` if any step is rate-limited.
 *
 * @remarks
 * Makes up to 6 fixed requests plus one per selected spec file (at most 6),
 * all to `api.github.com`.
 */
export async function analyzeRepository(
  url: string,
): Promise<RepoAnalysisResult> {
  const { owner, repo } = validateAndExtractTokens(url);

  const treePromise = fetchRepositoryTree(owner, repo);
  const specPromise = treePromise.then((tree) =>
    fetchSpecDocs(owner, repo, selectSpecPaths(tree.blobs)),
  );

  const [metadataR, treeR, readmeR, commitsR, prsR, releasesR, specR] =
    await Promise.allSettled([
      fetchMetadata(owner, repo),
      treePromise,
      fetchReadme(owner, repo),
      fetchCommits(owner, repo),
      fetchPullRequests(owner, repo),
      fetchReleases(owner, repo),
      specPromise,
    ]);

  const all = [metadataR, treeR, readmeR, commitsR, prsR, releasesR, specR];
  const rateLimited = all.find((r) => rejectedWith(r, "rate_limit_exceeded"));
  if (rateLimited && rateLimited.status === "rejected") throw rateLimited.reason;

  // Metadata is the authoritative accessibility check; the tree is a
  // secondary signal only when metadata itself could not be retrieved.
  if (rejectedWith(metadataR, "repo_not_found")) throw repoNotFound();
  if (metadataR.status === "rejected" && rejectedWith(treeR, "repo_not_found")) {
    throw repoNotFound();
  }

  const partialFailures: string[] = [];
  const metadata = settledOr<RepoMetadata | null>(metadataR, "metadata", null, partialFailures);
  const tree = settledOr<RepositoryTree>(
    treeR,
    "directoryTree",
    { directoryTree: [], blobs: [] },
    partialFailures,
  );
  const readmeText = settledOr<string | null>(readmeR, "readme", null, partialFailures);
  const commits = settledOr<Commit[]>(commitsR, "commits", [], partialFailures);
  const specDocs = settledOr<SpecDocument[]>(specR, "specDocs", [], partialFailures);
  const pullRequests = settledOr<PullRequest[]>(prsR, "pullRequests", [], partialFailures);
  const releases = settledOr<Release[]>(releasesR, "releases", [], partialFailures);

  return {
    owner,
    repo,
    metadata,
    directoryTree: tree.directoryTree,
    readmeText,
    commits,
    specDocs,
    pullRequests,
    releases,
    partialFailures,
  };
}
