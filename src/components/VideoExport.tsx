import React, { useRef, useState } from "react";
import { VIDEO_CONFIG } from "../config/output";
import { Slide } from "../types/index";
import { canCancel, useRenderJob } from "../hooks/useRenderJob";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface VideoExportProps {
  /** The slides to render into a video. */
  slides: Slide[];
  /** Called when the user wants to go back to the storyboard preview. */
  onBack: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Step 4 — renders the video, shows progress, and offers a download link.
 */
export function VideoExport({ slides, onBack }: VideoExportProps): React.ReactElement {
  // The user selects a Target_Duration before rendering starts (Req 4.10).
  // Default to the midpoint of the allowed range, clamped to bounds.
  const defaultDuration = Math.round(
    (VIDEO_CONFIG.minDurationSeconds + VIDEO_CONFIG.maxDurationSeconds) / 2,
  );
  const [targetDuration, setTargetDuration] = useState<number>(defaultDuration);
  const [hasStarted, setHasStarted] = useState<boolean>(false);

  // Rendering only begins once the user commits: until then we pass an empty
  // slide array so the hook does not fire.
  const { percent, jobId, status, error, cancel } = useRenderJob(
    hasStarted ? slides : [],
    targetDuration,
  );
  const [confirmLargeDownload, setConfirmLargeDownload] = useState<boolean>(false);
  const downloadRef = useRef<HTMLAnchorElement>(null);

  const isRendering = status === "rendering";
  const isComplete = status === "complete";
  const isFailed = status === "failed";
  const isCancelled = status === "cancelled";

  const handleDownload = async (): Promise<void> => {
    if (!jobId) return;

    // Fetch Content-Length to check file size before downloading
    try {
      const headRes = await fetch(`/api/download/${jobId}`, { method: "HEAD" });
      const contentLength = headRes.headers.get("Content-Length");
      const sizeWarning = headRes.headers.get("X-File-Size-Warning") === "true";

      if (sizeWarning || (contentLength && parseInt(contentLength, 10) > VIDEO_CONFIG.maxFileSizeBytes)) {
        if (!confirmLargeDownload) {
          const sizeMB = contentLength
            ? (parseInt(contentLength, 10) / (1024 * 1024)).toFixed(1)
            : "unknown";
          const confirmed = window.confirm(
            `This video is ${sizeMB} MB — larger than usual. Download anyway?`,
          );
          if (!confirmed) return;
          setConfirmLargeDownload(true);
        }
      }
    } catch {
      // If HEAD fails, proceed with the download anyway
    }

    // Trigger browser download via anchor click
    if (downloadRef.current) {
      downloadRef.current.href = `/api/download/${jobId}`;
      downloadRef.current.click();
    }
  };

  return (
    <section aria-label="Video export">
      <h2>Export Video</h2>

      {!hasStarted && (
        <div>
          <label htmlFor="target-duration">
            Video duration (seconds):
          </label>
          <input
            id="target-duration"
            type="range"
            min={VIDEO_CONFIG.minDurationSeconds}
            max={VIDEO_CONFIG.maxDurationSeconds}
            step={1}
            value={targetDuration}
            onChange={(e) => setTargetDuration(Number(e.target.value))}
            aria-describedby="target-duration-value"
          />
          <output id="target-duration-value" htmlFor="target-duration">
            {targetDuration}s (allowed {VIDEO_CONFIG.minDurationSeconds}–
            {VIDEO_CONFIG.maxDurationSeconds}s)
          </output>
          <div>
            <button
              type="button"
              onClick={() => setHasStarted(true)}
              disabled={slides.length === 0}
            >
              Start Rendering
            </button>
          </div>
        </div>
      )}

      {hasStarted && (
        <>
          <progress
            value={percent}
            max={100}
            aria-label="Video rendering progress"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            style={{ width: "100%" }}
          />
          <p aria-live="polite">
            {isRendering && `Rendering… ${percent}%`}
            {isComplete && "Rendering complete!"}
            {isFailed && "Rendering failed."}
            {isCancelled && "Rendering cancelled."}
            {status === "idle" && "Preparing…"}
          </p>
        </>
      )}

      {isRendering && (
        <button
          type="button"
          onClick={cancel}
          disabled={!canCancel(status, jobId)}
          title={jobId ? undefined : "Cancel becomes available once the render job has started."}
        >
          Cancel
        </button>
      )}

      {isComplete && jobId && (
        <>
          <button type="button" onClick={handleDownload}>
            Download MP4
          </button>
          {/* Hidden anchor for programmatic download */}
          {/* eslint-disable-next-line jsx-a11y/anchor-has-content */}
          <a
            ref={downloadRef}
            download="repository-video.mp4"
            style={{ display: "none" }}
          />
        </>
      )}

      {(isFailed || isCancelled) && (
        <>
          {isFailed && error && <p role="alert" style={{ color: "red" }}>{error}</p>}
          <button type="button" onClick={onBack}>
            {isFailed ? "Retry" : "Back to Storyboard"}
          </button>
        </>
      )}
    </section>
  );
}

export default VideoExport;
