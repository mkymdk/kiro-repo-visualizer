import React, { FormEvent, useId, useRef, useState } from "react";
import { ApiErrorCode, RepoAnalysisResult } from "../types/index";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface UrlInputProps {
  /** Called with the analysis result when the API returns successfully. */
  onSuccess: (result: RepoAnalysisResult) => void;
}

// ---------------------------------------------------------------------------
// Client-side validation — mirrors the server-side allowlist regex.
// The server re-validates authoritatively; this is a UX optimisation only.
// ---------------------------------------------------------------------------
const GITHUB_URL_RE =
  /^https:\/\/github\.com\/[a-zA-Z0-9_-]{1,100}\/[a-zA-Z0-9_-]{1,100}$/;

// Static fallback messages. Note: `rate_limit_exceeded` is intentionally
// omitted here — the server computes an accurate wait time and sends it in
// the response `message`, which the client prefers for that code.
const ERROR_MESSAGES: Partial<Record<ApiErrorCode, string>> = {
  invalid_url:
    "Please enter a valid GitHub repository URL (https://github.com/owner/repo).",
  repo_not_found:
    "Repository not found or not publicly accessible. Please check the URL.",
  request_timeout:
    "The request timed out. Please check your connection and try again.",
  network_error:
    "A network error occurred. Please check your connection and try again.",
  internal_error: "An unexpected server error occurred. Please try again.",
};

/** Codes for which the server-provided message is preferred over static text. */
const SERVER_MESSAGE_CODES: ReadonlySet<ApiErrorCode> = new Set<ApiErrorCode>([
  "rate_limit_exceeded",
]);

/** Generic fallback used only when the server sends no message for a code. */
const GENERIC_RATE_LIMIT_MESSAGE =
  "GitHub API rate limit reached. Please try again later.";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * URL input form for Step 1 of the repository visualizer flow.
 *
 * Performs client-side format pre-validation before calling the API, then
 * maps API error codes to user-facing inline messages.
 */
export function UrlInput({ onSuccess }: UrlInputProps): React.ReactElement {
  const [url, setUrl] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [warning, setWarning] = useState<string>("");
  const [isLoading, setIsLoading] = useState<boolean>(false);

  const errorId = useId();
  const warningId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setError("");
    setWarning("");

    // Client-side pre-validation — never trusted server-side
    if (!GITHUB_URL_RE.test(url.trim())) {
      setError(ERROR_MESSAGES.invalid_url ?? "Invalid URL.");
      inputRef.current?.focus();
      return;
    }

    setIsLoading(true);

    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });

      const data: unknown = await response.json();

      if (!response.ok) {
        const errorData = data as { error?: ApiErrorCode; message?: string };
        const code = errorData.error;
        let msg: string;
        if (code && SERVER_MESSAGE_CODES.has(code)) {
          // Prefer the server's dynamic message (accurate rate-limit wait).
          msg = errorData.message ?? GENERIC_RATE_LIMIT_MESSAGE;
        } else {
          msg =
            (code && ERROR_MESSAGES[code]) ??
            errorData.message ??
            "An unexpected error occurred.";
        }
        setError(msg);
        inputRef.current?.focus();
        return;
      }

      const result = data as RepoAnalysisResult;

      // Warn the user if some data extraction steps were skipped
      if (result.partialFailures.length > 0) {
        setWarning(
          `Some data could not be retrieved: ${result.partialFailures.join(", ")}. Results may be incomplete.`,
        );
      }

      onSuccess(result);
    } catch {
      setError(ERROR_MESSAGES.network_error ?? "A network error occurred.");
      inputRef.current?.focus();
    } finally {
      setIsLoading(false);
    }
  };

  const describedBy = [
    error ? errorId : "",
    warning ? warningId : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <section>
      <h1>GitHub Repository Visualizer</h1>
      <p>Enter a public GitHub repository URL to generate a video storyboard.</p>

      <form onSubmit={handleSubmit} aria-busy={isLoading} noValidate>
        <div>
          <label htmlFor="repo-url">Repository URL</label>
          <input
            id="repo-url"
            ref={inputRef}
            type="url"
            value={url}
            maxLength={2048}
            placeholder="https://github.com/owner/repo"
            onChange={(e) => setUrl(e.target.value)}
            aria-describedby={describedBy || undefined}
            aria-invalid={error ? "true" : undefined}
            disabled={isLoading}
            required
          />
        </div>

        {error && (
          <p id={errorId} role="alert" aria-live="assertive" style={{ color: "red" }}>
            {error}
          </p>
        )}

        {warning && (
          <p id={warningId} role="status" aria-live="polite" style={{ color: "orange" }}>
            {warning}
          </p>
        )}

        <button type="submit" disabled={isLoading}>
          {isLoading ? "Analyzing…" : "Analyze Repository"}
        </button>
      </form>
    </section>
  );
}

export default UrlInput;
