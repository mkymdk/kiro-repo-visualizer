import React, { useRef, useState } from "react";
import { VIDEO_CONFIG } from "../config/output";
import { Slide } from "../types/index";
import { useRenderJob } from "../hooks/useRenderJob";

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
  const { percent, jobId, status, error, cancel } = useRenderJob(slides);
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

      {isRendering && (
        <button
          type="button"
          onClick={cancel}
          disabled={isCancelled}
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
