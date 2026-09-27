import React, { useState } from "react";
import { RepoAnalysisResult, Slide } from "./types/index";
import { UrlInput } from "./components/UrlInput";
import { AnalysisProgress } from "./components/AnalysisProgress";
import { StoryboardPreview } from "./components/StoryboardPreview";
import { VideoExport } from "./components/VideoExport";

// ---------------------------------------------------------------------------
// Step type
// ---------------------------------------------------------------------------

type Step = "input" | "analysis" | "storyboard" | "export";

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

/**
 * Top-level step router.
 *
 * Manages the four-step user flow:
 *   input → analysis → storyboard → export
 *
 * Shared state (`repoResult`, `slides`) is lifted here and passed down as
 * props. The `onBack` callback from VideoExport returns to "storyboard" with
 * slide order preserved.
 */
function App(): React.ReactElement {
  const [step, setStep] = useState<Step>("input");
  const [repoResult, setRepoResult] = useState<RepoAnalysisResult | null>(null);
  const [slides, setSlides] = useState<Slide[]>([]);
  const [isFetchingStoryboard, setIsFetchingStoryboard] = useState<boolean>(false);
  const [storyboardError, setStoryboardError] = useState<string>("");

  // Step 1 → Step 2: URL input succeeds; fetch storyboard while showing progress
  const handleAnalysisSuccess = async (result: RepoAnalysisResult): Promise<void> => {
    setRepoResult(result);
    setStep("analysis");
    setIsFetchingStoryboard(true);
    setStoryboardError("");

    try {
      const encodedUrl = encodeURIComponent(`https://github.com/${result.owner}/${result.repo}`);
      const res = await fetch(`/api/storyboard?url=${encodedUrl}`);
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(data.message ?? "Failed to generate storyboard.");
      }
      const fetchedSlides = (await res.json()) as Slide[];
      setSlides(fetchedSlides);
    } catch (err: unknown) {
      setStoryboardError(err instanceof Error ? err.message : "An error occurred.");
    } finally {
      setIsFetchingStoryboard(false);
    }
  };

  // Step 2 → Step 3: analysis/storyboard complete
  const handleContinue = (): void => {
    if (!isFetchingStoryboard) {
      setStep("storyboard");
    }
  };

  // Step 3 → Step 4: user clicks "Export Video" with their ordered slides
  const handleExport = (orderedSlides: Slide[]): void => {
    setSlides(orderedSlides);
    setStep("export");
  };

  // Step 4 → Step 3: "Retry" or "Back" from VideoExport
  const handleBack = (): void => {
    setStep("storyboard");
  };

  // ---------------------------------------------------------------------------
  // Step indicator
  // ---------------------------------------------------------------------------
  const stepNumber: Record<Step, number> = {
    input: 1,
    analysis: 2,
    storyboard: 3,
    export: 4,
  };

  return (
    <main aria-label="GitHub Repository Visualizer">
      <p aria-live="polite" style={{ fontWeight: "bold", marginBottom: "1rem" }}>
        Step {stepNumber[step]} of 4
      </p>

      {step === "input" && (
        <UrlInput onSuccess={handleAnalysisSuccess} />
      )}

      {step === "analysis" && (
        <>
          {storyboardError && (
            <p role="alert" style={{ color: "red" }}>{storyboardError}</p>
          )}
          <AnalysisProgress
            isLoading={isFetchingStoryboard}
            partialFailures={repoResult?.partialFailures ?? []}
            onContinue={handleContinue}
          />
        </>
      )}

      {step === "storyboard" && (
        <StoryboardPreview
          initialSlides={slides}
          onExport={handleExport}
        />
      )}

      {step === "export" && (
        <VideoExport
          slides={slides}
          onBack={handleBack}
        />
      )}
    </main>
  );
}

export default App;
