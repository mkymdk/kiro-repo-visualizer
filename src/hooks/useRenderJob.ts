import { useCallback, useEffect, useRef, useState } from "react";
import { RenderJobStatus, Slide } from "../types/index";

// ---------------------------------------------------------------------------
// Hook state type
// ---------------------------------------------------------------------------

export interface RenderJobState {
  /** Current render progress (0–100). */
  percent: number;
  /** Server-assigned job UUID, available once the render starts. */
  jobId: string | null;
  /** Lifecycle status of the render job. */
  status: RenderJobStatus | "idle";
  /** Human-readable error message, if status is "failed". */
  error: string | null;
  /** Call to cancel an in-progress render. */
  cancel: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * React hook that opens a Server-Sent Events connection to `POST /api/render`,
 * streams progress updates, and exposes cancellation.
 *
 * @param slides - The ordered slide array to render; the hook fires when
 *   this is a non-empty array. Pass an empty array to skip rendering.
 * @param targetDurationSeconds - Optional target total video duration in
 *   seconds, forwarded in the render request body. When omitted, the server
 *   derives a default from the slide count.
 * @returns A {@link RenderJobState} object with percent, jobId, status,
 *   error, and a cancel function.
 */
export function useRenderJob(
  slides: Slide[],
  targetDurationSeconds?: number,
): RenderJobState {
  const [percent, setPercent] = useState<number>(0);
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<RenderJobStatus | "idle">("idle");
  const [error, setError] = useState<string | null>(null);

  // Keep a ref to the jobId so the cancel callback always sees the latest value
  const jobIdRef = useRef<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (slides.length === 0) return;

    let cancelled = false;
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setStatus("rendering");
    setPercent(0);
    setJobId(null);
    setError(null);

    (async () => {
      try {
        const response = await fetch("/api/render", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            targetDurationSeconds !== undefined
              ? { slides, targetDurationSeconds }
              : { slides },
          ),
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          const errorData = (await response.json().catch(() => ({}))) as {
            message?: string;
          };
          throw new Error(errorData.message ?? "Render request failed.");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done || cancelled) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const payload = JSON.parse(line.slice(6)) as {
                percent?: number;
                jobId?: string;
              };
              if (typeof payload.percent === "number") {
                setPercent(payload.percent);
              }
              if (payload.jobId) {
                setJobId(payload.jobId);
                jobIdRef.current = payload.jobId;
              }
              if (payload.percent === 100) {
                setStatus("complete");
              }
            } catch {
              // Malformed SSE line — skip
            }
          }
        }
      } catch (err: unknown) {
        if (cancelled) return;
        const msg =
          err instanceof Error ? err.message : "Unknown error during render.";
        setError(msg);
        setStatus("failed");
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slides, targetDurationSeconds]);

  const cancel = useCallback(async (): Promise<void> => {
    const id = jobIdRef.current;
    abortControllerRef.current?.abort();
    setStatus("cancelled");

    if (id) {
      try {
        await fetch(`/api/render/${id}`, { method: "DELETE" });
      } catch {
        // Best-effort cancel
      }
    }
  }, []);

  return { percent, jobId, status, error, cancel };
}
