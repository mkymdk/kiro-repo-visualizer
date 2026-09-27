---
inclusion: fileMatch
fileMatchPattern: "**/*.{ts,tsx,js,jsx,py,go,java}"
---

# API Error Handling & Input Validation Standards

## Scope

These rules apply to every file that:
- Accepts a repository URL as input (query param, request body, path param, or form field)
- Makes any outbound HTTP request (GitHub API, webhooks, or any third-party endpoint)
- Handles or re-throws errors originating from network calls or URL parsing

---

## 1. Structured Error Response Format

All error responses — whether from validation failures, network errors, timeouts, or unexpected exceptions — **must** return a JSON object with this shape:

```json
{
  "error": "<error_code>",
  "message": "<human-readable explanation>"
}
```

**Never** return raw exceptions, stack traces, or unformatted error strings to the client.

### Standard Error Codes

| `error` code          | When to use                                                      |
|-----------------------|------------------------------------------------------------------|
| `invalid_url`         | URL fails format validation (not a valid GitHub repo URL)        |
| `repo_not_found`      | Repository does not exist or is not publicly accessible          |
| `rate_limit_exceeded` | GitHub API returned a 429 / rate-limit response                  |
| `request_timeout`     | Outbound HTTP request did not complete within the 10s limit      |
| `network_error`       | Generic network failure (DNS, connection refused, etc.)          |
| `partial_data`        | Some extraction steps failed; response includes what was fetched |
| `internal_error`      | Unexpected server-side failure (use as a last resort)            |

---

## 2. Repository URL Validation

Before making **any** external request, validate the URL against this rule:

- Must match: `https://github.com/{owner}/{repo}`
- `{owner}` and `{repo}`: alphanumeric characters, hyphens, or underscores only; 1–100 characters each
- No trailing slashes, query strings, or path segments beyond `{owner}/{repo}`

**Correct pattern (regex):**
```
^https://github\.com/[a-zA-Z0-9_-]{1,100}/[a-zA-Z0-9_-]{1,100}$
```

If validation fails, return immediately with HTTP 400:
```json
{
  "error": "invalid_url",
  "message": "Repository URL must match https://github.com/{owner}/{repo} where owner and repo contain only alphanumeric characters, hyphens, or underscores (1–100 characters each)."
}
```

Do **not** proceed to network calls if format validation fails.

---

## 3. Outbound HTTP Request Rules

### 3.1 Timeout

Every outbound HTTP request — including GitHub API calls — **must** enforce a **10-second timeout**. A request that exceeds this limit must be cancelled and must return:

```json
{
  "error": "request_timeout",
  "message": "The request to the external service timed out. Please try again."
}
```

Never let a hanging request block a response indefinitely.

### 3.2 GitHub Rate Limit Handling

When the GitHub API returns HTTP 429 or a `X-RateLimit-Remaining: 0` header, return HTTP 429:

```json
{
  "error": "rate_limit_exceeded",
  "message": "GitHub API rate limit reached. Please retry after 60 seconds."
}
```

### 3.3 Repository Not Accessible

When the GitHub API returns HTTP 404 or 403 for a repository lookup, return HTTP 404:

```json
{
  "error": "repo_not_found",
  "message": "The repository could not be found or is not publicly accessible. Please check the URL and try again."
}
```

### 3.4 Generic Network Failures

All other network-level failures (DNS resolution, connection refused, TLS errors, unexpected HTTP 5xx from GitHub) must be caught and returned as HTTP 502:

```json
{
  "error": "network_error",
  "message": "A network error occurred while contacting the external service. Please try again."
}
```

---

## 4. Partial Data Extraction

When multiple extraction steps run (directory structure, README, commits, `.kiro` docs) and one or more steps fail individually:

- **Do not** abort the entire request.
- **Continue** with the remaining steps.
- Return HTTP 200 with a `partial_data` warning alongside whatever was successfully retrieved:

```json
{
  "error": "partial_data",
  "message": "Some data could not be retrieved. Results may be incomplete.",
  "data": { ... }
}
```

---

## 5. No Unhandled Exceptions

Every function that performs I/O, network calls, or URL parsing **must** wrap its logic in structured error handling (try/catch, Result types, or equivalent for the language in use).

- **Do not** propagate raw exceptions to API response handlers.
- **Do not** return HTTP 500 with a stack trace body.
- If an unexpected error slips through, a top-level error handler must catch it and respond with HTTP 500:

```json
{
  "error": "internal_error",
  "message": "An unexpected error occurred. Please try again later."
}
```

Log the full exception server-side (with stack trace) for debugging, but never include it in the response body.

---

## 6. Examples

### ✅ Correct — validated, timeout-enforced, structured error

```typescript
async function fetchRepository(url: string): Promise<RepoData> {
  const GITHUB_URL_RE = /^https:\/\/github\.com\/[a-zA-Z0-9_-]{1,100}\/[a-zA-Z0-9_-]{1,100}$/;
  if (!GITHUB_URL_RE.test(url)) {
    throw new ApiError("invalid_url", "Repository URL must match https://github.com/{owner}/{repo}.");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(apiUrl, { signal: controller.signal });
    if (response.status === 404 || response.status === 403) {
      throw new ApiError("repo_not_found", "The repository could not be found or is not publicly accessible.");
    }
    if (response.status === 429) {
      throw new ApiError("rate_limit_exceeded", "GitHub API rate limit reached. Please retry after 60 seconds.");
    }
    return await response.json();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err.name === "AbortError") {
      throw new ApiError("request_timeout", "The request to the external service timed out. Please try again.");
    }
    throw new ApiError("network_error", "A network error occurred while contacting the external service.");
  } finally {
    clearTimeout(timeoutId);
  }
}
```

### ❌ Incorrect — raw exception, no timeout, no structure

```typescript
// Never do this
async function fetchRepository(url: string) {
  const response = await fetch(`https://api.github.com/repos/${url}`);
  return response.json(); // throws or leaks raw HTTP errors to the caller
}
```
