---
inclusion: fileMatch
fileMatchPattern: "**/*.{ts,tsx,js,jsx,py,go,java}"
---

# Code Style: Type Annotations & Documentation

## Scope

These rules apply to every backend file that defines functions, methods, or classes. They cover:
- Function and method signatures (parameters and return types)
- Docstrings and inline documentation
- Class and interface definitions
- Module-level exports intended for use by other modules

Frontend UI components are in scope for type annotations but exempt from the docstring requirement when the component name and prop types are self-explanatory.

---

## 1. Type Annotations Are Mandatory

Every function and method parameter and every return value **must** carry an explicit type annotation. Inferred types are not sufficient for public or exported functions — state the type explicitly.

### TypeScript / JavaScript

```typescript
// ✅ Correct — all params and return type annotated
async function analyzeRepository(url: string, timeout: number = 10): Promise<RepoAnalysisResult> { ... }

// ❌ Incorrect — missing return type, param type inferred
async function analyzeRepository(url, timeout = 10) { ... }

// ❌ Incorrect — return type missing even though params are typed
function buildStoryboard(data: RepoData) { ... }
```

Rules:
- Use `unknown` instead of `any`. If `any` is truly unavoidable, add a `// eslint-disable-next-line @typescript-eslint/no-explicit-any` comment with a one-line justification.
- Prefer named interfaces or type aliases over inline object literals in signatures: `RepoAnalysisResult` rather than `{ owner: string; repo: string; commits: Commit[] }`.
- `void` is a valid return type for functions with no return value; do not omit it.
- Async functions must return `Promise<T>` — not just `T`.

### Python

```python
# ✅ Correct — all params and return type annotated
def analyze_repository(url: str, timeout: int = 10) -> RepoAnalysisResult:
    ...

# ❌ Incorrect — no annotations
def analyze_repository(url, timeout=10):
    ...

# ❌ Incorrect — params annotated but return type missing
def analyze_repository(url: str, timeout: int = 10):
    ...
```

Rules:
- Use types from the `typing` module for generics (`List`, `Dict`, `Optional`, `Union`, `Tuple`) in Python < 3.10; use built-in generics (`list[str]`, `dict[str, int]`) in Python ≥ 3.10.
- Use `Optional[T]` (or `T | None`) for parameters that may be `None`.
- Never use bare `object` or unparameterised `dict`/`list` as a return type.
- Functions that raise and never return must be annotated `-> NoReturn`.

---

## 2. Docstrings Are Mandatory on All Public Functions and Methods

Every public (exported / non-underscore-prefixed) function, method, and class **must** have a docstring. Private helpers (prefixed with `_` in Python, or unexported in TypeScript) should have docstrings when their behaviour is non-obvious.

### Required Docstring Sections

A complete docstring must cover:

| Section | Required when |
|---|---|
| **Summary** (one line) | Always |
| **Args / Parameters** | Function has ≥ 1 parameter |
| **Returns** | Function returns a non-`None`/non-`void` value |
| **Raises / Throws** | Function raises exceptions or rejects a Promise |
| **Side effects** | Function performs I/O, mutates shared state, or makes network calls |

If a section does not apply (e.g. a function has no parameters), omit that section entirely — do not write "None".

### Python — Google-style docstrings

```python
async def analyze_repository(url: str, timeout: int = 10) -> RepoAnalysisResult:
    """Fetch and parse the public GitHub repository at the given URL.

    Validates the URL format, calls the GitHub REST API to retrieve directory
    structure, README content, and commit history, then returns a structured
    analysis result.

    Args:
        url: A fully-qualified GitHub repository URL in the form
            ``https://github.com/{owner}/{repo}``.
        timeout: Maximum seconds to wait for each GitHub API response.
            Defaults to 10.

    Returns:
        A ``RepoAnalysisResult`` containing directory structure, README text,
        commit history, and any extracted spec documentation.

    Raises:
        ApiError: With code ``invalid_url`` if ``url`` fails format validation.
        ApiError: With code ``repo_not_found`` if the repository is not
            publicly accessible.
        ApiError: With code ``rate_limit_exceeded`` if the GitHub API rate
            limit is reached.
        ApiError: With code ``request_timeout`` if a request exceeds
            ``timeout`` seconds.

    Side effects:
        Makes up to 4 outbound HTTPS requests to ``api.github.com``.
    """
```

### TypeScript — TSDoc-style docstrings

```typescript
/**
 * Fetch and parse the public GitHub repository at the given URL.
 *
 * Validates the URL format, calls the GitHub REST API to retrieve directory
 * structure, README content, and commit history, then returns a structured
 * analysis result.
 *
 * @param url - A fully-qualified GitHub repository URL in the form
 *   `https://github.com/{owner}/{repo}`.
 * @param timeout - Maximum milliseconds to wait for each GitHub API response.
 *   Defaults to 10000.
 * @returns A {@link RepoAnalysisResult} containing directory structure, README
 *   text, commit history, and any extracted spec documentation.
 * @throws {@link ApiError} With code `invalid_url` if `url` fails format validation.
 * @throws {@link ApiError} With code `request_timeout` if a request exceeds `timeout` ms.
 *
 * @remarks
 * Makes up to 4 outbound HTTPS requests to `api.github.com`.
 */
async function analyzeRepository(
  url: string,
  timeout: number = 10_000,
): Promise<RepoAnalysisResult> { ... }
```

---

## 3. Named Types Over Primitives in Domain Interfaces

Define named interfaces or dataclasses for every non-trivial domain object. Do not use anonymous objects or raw primitives where a named type communicates intent.

```typescript
// ✅ Correct — named types
interface Commit {
  sha: string;
  author: string;
  timestamp: string; // ISO 8601
  message: string;
}

interface RepoAnalysisResult {
  owner: string;
  repo: string;
  directoryTree: DirectoryNode[];
  readmeText: string | null;
  commits: Commit[];
  specDocs: SpecDocument[];
}
```

```typescript
// ❌ Incorrect — anonymous shapes, raw tuples
function getCommits(url: string): Promise<{ sha: string; msg: string }[]> { ... }
```

---

## 4. One Responsibility Per Function

Functions should do one thing. If a docstring summary requires "and" to describe what a function does, split it.

```python
# ❌ Too broad — validates AND fetches AND parses
async def process_repository(url: str) -> RepoAnalysisResult: ...

# ✅ Separated responsibilities
def validate_repository_url(url: str) -> tuple[str, str]: ...          # returns (owner, repo)
async def fetch_repository_metadata(owner: str, repo: str) -> RepoMetadata: ...
def parse_commit_history(raw: list[dict]) -> list[Commit]: ...
```

---

## 5. Default Parameter Values

- Default values for timeouts, limits, and counts **must** reference the constants from `src/config/output.ts` (or the language-equivalent config module) — never inline literals. See `output-constants.md`.
- Default values must not be mutable objects (Python: use `None` + guard, not `def f(items=[])`).

```python
# ✅ Correct — default from config, mutable default avoided
from src.config.output import VIDEO_CONFIG

def render_video(
    slides: list[Slide],
    fps: int = VIDEO_CONFIG["fps"],
    output_path: str | None = None,
) -> VideoFile: ...
```

---

## 6. Checklist

When writing or reviewing any function, verify:

- [ ] Every parameter has an explicit type annotation
- [ ] The return type is explicitly annotated (including `void` / `None` / `Promise<void>`)
- [ ] A docstring is present with Summary, Args, Returns, Raises, and Side effects sections (as applicable)
- [ ] Domain objects use named interfaces or dataclasses — not anonymous shapes
- [ ] The function summary does not need "and" to describe what it does
- [ ] Default numeric values reference config constants, not inline literals
