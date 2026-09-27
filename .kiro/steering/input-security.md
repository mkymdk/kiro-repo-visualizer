---
inclusion: fileMatch
fileMatchPattern: "**/*.{ts,tsx,js,jsx,py,go,java}"
---

# Input Security: URL Allowlisting, SSRF Prevention & Path Traversal Sanitization

## Scope

These rules apply to every file that:
- Receives a repository URL from any user-controlled input (request body, query param, path param, header, or form field)
- Constructs or passes a URL to an HTTP client
- Derives a file path, directory path, or shell argument from user-supplied data

These rules are **security requirements**, not style preferences. Violations must be treated as bugs.

---

## 1. URL Allowlisting — SSRF Prevention

### 1.1 Only One Permitted URL Scheme and Host

The system is permitted to make outbound HTTP requests to **exactly two hosts**:

| Allowed host              | Purpose                        |
|---------------------------|--------------------------------|
| `api.github.com`          | GitHub REST API calls          |
| `raw.githubusercontent.com` | Raw file content fetches     |

**No other host, IP address, or URL scheme is permitted.** This explicitly blocks:
- `http://` (only `https://` is allowed)
- Internal addresses: `localhost`, `127.x.x.x`, `10.x.x.x`, `172.16–31.x.x`, `192.168.x.x`
- IPv6 loopback: `::1`, `[::1]`
- Metadata endpoints: `169.254.169.254` (AWS/GCP/Azure IMDS)
- Any URL using non-HTTP schemes: `file://`, `ftp://`, `gopher://`, `data:`, `javascript:`

### 1.2 Validate the User-Submitted Repository URL Before Any Use

The raw user-submitted value must pass the allowlist regex before it is used to construct **any** downstream URL or API call:

```
^https://github\.com/[a-zA-Z0-9_-]{1,100}/[a-zA-Z0-9_-]{1,100}$
```

Extract `owner` and `repo` as separate, validated tokens from this match. Use those tokens — never the raw URL string — to build GitHub API URLs:

```
https://api.github.com/repos/{owner}/{repo}
```

**Never** interpolate the raw user-submitted URL directly into an HTTP client call.

### 1.3 Parse the Constructed URL and Re-verify the Host

After constructing any outbound URL from extracted tokens, parse it with the platform's URL parser and assert that `hostname` is in the allowed host list before the request is dispatched.

```typescript
// ✅ Correct — build from validated tokens, assert host before fetch
const ALLOWED_HOSTS = new Set(["api.github.com", "raw.githubusercontent.com"]);

function buildApiUrl(owner: string, repo: string): URL {
  const url = new URL(`https://api.github.com/repos/${owner}/${repo}`);
  if (!ALLOWED_HOSTS.has(url.hostname)) {
    throw new ApiError("invalid_url", "Request targets a disallowed host.");
  }
  return url;
}
```

```typescript
// ❌ Incorrect — raw user input passed directly to fetch
fetch(`https://api.github.com/repos/${userInput}`);
```

### 1.4 No Redirects to Unverified Hosts

The HTTP client **must not** follow redirects automatically. If a redirect is received, re-validate the `Location` header URL against the allowed host list before following it. If it targets a disallowed host, abort the request and return a `network_error`.

---

## 2. Input Sanitization — Path Traversal Prevention

### 2.1 File Paths Must Never Be Derived Directly From User Input

File system paths used for reading, writing, or listing files must be constructed from a **hardcoded base directory** joined with sanitized path segments. They must never incorporate a raw URL, owner name, repo name, or any other user-supplied string without sanitization.

### 2.2 Sanitize Path Segments Before Use

Before appending any user-derived value to a file path:

1. Strip all leading and trailing whitespace.
2. Remove or reject any segment containing `..`, `.`, or null bytes (`\0`).
3. Remove all characters outside `[a-zA-Z0-9_\-.]`.
4. After joining, resolve the absolute path and assert it is still within the expected base directory.

```typescript
// ✅ Correct — sanitized segment, confined to base dir
import path from "path";

const BASE_DIR = path.resolve("/app/data/repos");

function safeRepoPath(owner: string, repo: string): string {
  const safeOwner = owner.replace(/[^a-zA-Z0-9_-]/g, "");
  const safeRepo  = repo.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safeOwner || !safeRepo) {
    throw new ApiError("invalid_url", "Owner or repository name is invalid.");
  }
  const resolved = path.resolve(BASE_DIR, safeOwner, safeRepo);
  if (!resolved.startsWith(BASE_DIR + path.sep)) {
    throw new ApiError("invalid_url", "Path traversal detected.");
  }
  return resolved;
}
```

```typescript
// ❌ Incorrect — user input written directly into a path
const filePath = `/app/data/repos/${req.body.owner}/${req.body.repo}`;
```

### 2.3 No Shell Interpolation of User Input

User-supplied values (owner, repo, URL, or any derivative) **must never** be passed to shell execution functions (`exec`, `spawn` with `shell: true`, `subprocess.run` with `shell=True`, `os.system`, etc.) as interpolated strings.

If a shell command is required, pass arguments as an **array** (never a concatenated string) with `shell: false` / `shell` disabled.

```typescript
// ✅ Correct — array args, shell disabled
import { spawn } from "child_process";
spawn("git", ["clone", "--", validatedRepoUrl, safeLocalPath], { shell: false });

// ❌ Incorrect — interpolated shell string
exec(`git clone ${userInput}`);
```

---

## 3. Response Content Handling

### 3.1 Treat All API Response Content as Untrusted

Content retrieved from GitHub (README text, commit messages, file names, directory listings) must be treated as untrusted data:

- **HTML-encode** or **escape** it before rendering in any web UI context.
- **Do not** evaluate it as code or pass it to `eval`, `Function()`, `dangerouslySetInnerHTML` (without sanitization), or equivalent.
- File names and paths returned by the GitHub API must be sanitized (rule 2.2) before use in any local file system operation.

### 3.2 Limit Response Body Size

Cap the response body read from any outbound request at **10 MB**. Abort and discard responses that exceed this limit to prevent memory exhaustion from unexpectedly large payloads.

---

## 4. Enforcement Checklist

When writing or reviewing any function that touches user-submitted URLs or derived data, verify all of the following before marking the code complete:

- [ ] User-submitted URL is validated against the allowlist regex before any use
- [ ] `owner` and `repo` are extracted as separate tokens; the raw URL string is not forwarded
- [ ] Constructed URLs are parsed and the `hostname` is asserted against the allowed host set
- [ ] HTTP client has redirects disabled or redirect targets are re-validated
- [ ] File paths are built from a hardcoded base dir + sanitized segments, and are resolved + confined
- [ ] No user input is interpolated into shell command strings
- [ ] API response content is escaped before rendering; not evaluated as code
- [ ] Response body reads are capped at 10 MB
