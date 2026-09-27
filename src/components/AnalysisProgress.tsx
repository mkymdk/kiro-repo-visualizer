import React from "react";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface AnalysisProgressProps {
  /** Whether the analysis API call is still in flight. */
  isLoading: boolean;
  /**
   * Names of extraction steps that were skipped due to partial failures.
   * An empty array means all steps succeeded.
   */
  partialFailures: string[];
  /** Called when the user clicks "Continue" after analysis completes. */
  onContinue: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Step 2 — displays analysis progress and any partial-failure warnings.
 */
export function AnalysisProgress({
  isLoading,
  partialFailures,
  onContinue,
}: AnalysisProgressProps): React.ReactElement {
  return (
    <section aria-label="Analysis progress">
      {isLoading && (
        <div aria-live="polite" aria-busy="true">
          <span aria-hidden="true">⏳</span>
          {" "}Analyzing repository…
        </div>
      )}

      {!isLoading && partialFailures.length > 0 && (
        <div role="alert" style={{ color: "orange" }}>
          <strong>Warning:</strong> The following steps could not be completed
          and were skipped:{" "}
          <ul>
            {partialFailures.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ul>
          Results may be incomplete.
        </div>
      )}

      {!isLoading && (
        <button type="button" onClick={onContinue}>
          Continue
        </button>
      )}
    </section>
  );
}

export default AnalysisProgress;
