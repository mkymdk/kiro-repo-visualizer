/**
 * Express API routes for the GitHub Repository Visualizer.
 *
 * This module owns HTTP routing and error mapping only. All business logic
 * is delegated to the appropriate domain module:
 *   - analyzeRepository  → src/server/analyzer.ts
 *   - generateStoryboard → src/server/storyboard.ts
 *   - videoRenderer      → src/server/renderer.ts
 */

import { Router, Request, Response, NextFunction } from "express";
import fs from "fs";
import { analyzeRepository } from "./analyzer.js";
import { generateStoryboard } from "./storyboard.js";
import { videoRenderer } from "./renderer.js";
import { ApiError, ApiErrorCode, RepoAnalysisResult, Slide } from "../types/index.js";

// ---------------------------------------------------------------------------
// Error code → HTTP status map
// ---------------------------------------------------------------------------

const HTTP_STATUS: Record<ApiErrorCode, number> = {
  invalid_url: 400,
  repo_not_found: 404,
  rate_limit_exceeded: 429,
  request_timeout: 504,
  network_error: 502,
  partial_data: 200,
  insufficient_content: 422,
  internal_error: 500,
};

// ---------------------------------------------------------------------------
// Module-level analysis cache (keyed by repo URL)
// ---------------------------------------------------------------------------

/** In-memory cache of analysis results, keyed by repository URL. */
const analysisCache = new Map<string, RepoAnalysisResult>();

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const router = Router();

// ---------------------------------------------------------------------------
// POST /api/analyze
// ---------------------------------------------------------------------------

/**
 * Validate a GitHub repository URL, run all extraction steps, cache the
 * result, and return it as JSON.
 *
 * @remarks
 * Responds with `partial_data` warning in the body when some extraction
 * steps failed but others succeeded.
 */
router.post(
  "/analyze",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { url } = req.body as { url?: unknown };
      if (typeof url !== "string" || url.trim().length === 0) {
        res.status(400).json({
          error: "invalid_url",
          message: "A repository URL string is required in the request body.",
        });
        return;
      }

      const result = await analyzeRepository(url.trim());
      analysisCache.set(url.trim(), result);

      if (result.partialFailures.length > 0) {
        res.status(200).json({
          error: "partial_data",
          message: "Some data could not be retrieved. Results may be incomplete.",
          ...result,
        });
      } else {
        res.status(200).json(result);
      }
    } catch (err: unknown) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/storyboard
// ---------------------------------------------------------------------------

/**
 * Look up the cached analysis result for a URL and generate a storyboard.
 *
 * @remarks
 * Requires the `url` query parameter matching a previously analysed URL.
 */
router.get(
  "/storyboard",
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      const { url } = req.query as { url?: string };
      if (!url) {
        res.status(400).json({
          error: "invalid_url",
          message: "A `url` query parameter is required.",
        });
        return;
      }

      const cached = analysisCache.get(url);
      if (!cached) {
        res.status(404).json({
          error: "repo_not_found",
          message: "No analysis found for this URL. Call POST /api/analyze first.",
        });
        return;
      }

      const slides = generateStoryboard(cached);
      res.status(200).json(slides);
    } catch (err: unknown) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/render  (SSE)
// ---------------------------------------------------------------------------

/**
 * Start a video render job for the provided slides.
 *
 * Opens a Server-Sent Events stream. Emits `data: {"percent": N}` events
 * during encoding and `data: {"percent": 100, "jobId": "<id>"}` on completion.
 *
 * @remarks
 * The SSE connection stays open until rendering completes or fails.
 */
router.post(
  "/render",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { slides } = req.body as { slides?: unknown };

      if (!Array.isArray(slides) || slides.length === 0) {
        res.status(422).json({
          error: "insufficient_content",
          message: "A non-empty `slides` array is required.",
        });
        return;
      }

      // Set SSE headers before writing any data
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      const onProgress = (percent: number): void => {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ percent })}\n\n`);
        }
      };

      const job = await videoRenderer.start(slides as Slide[], onProgress);

      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({ percent: 100, jobId: job.id })}\n\n`,
        );
        res.end();
      }
    } catch (err: unknown) {
      if (!res.writableEnded) {
        const message =
          err instanceof Error ? err.message : "Render failed.";
        res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
        res.end();
      }
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// DELETE /api/render/:jobId
// ---------------------------------------------------------------------------

/**
 * Cancel an in-progress render job and delete the partial output file.
 */
router.delete(
  "/render/:jobId",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { jobId } = req.params;
      if (!jobId) {
        res.status(400).json({ error: "invalid_url", message: "Missing jobId." });
        return;
      }

      const job = videoRenderer.jobs.get(jobId);
      if (!job) {
        res.status(404).json({
          error: "repo_not_found",
          message: `Render job ${jobId} not found.`,
        });
        return;
      }

      await videoRenderer.abort(jobId);
      res.status(204).end();
    } catch (err: unknown) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/download/:jobId
// ---------------------------------------------------------------------------

/**
 * Stream the completed MP4 file to the client.
 *
 * Sets `X-File-Size-Warning: true` when the file exceeds the configured
 * maximum. Deletes the temp file after the response stream closes.
 */
router.get(
  "/download/:jobId",
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      const { jobId } = req.params;
      const job = videoRenderer.jobs.get(jobId ?? "");

      if (!job) {
        res.status(404).json({
          error: "repo_not_found",
          message: `Render job ${jobId} not found.`,
        });
        return;
      }

      if (job.status !== "complete" || !job.outputPath) {
        res.status(409).json({
          error: "internal_error",
          message: "Render job is not yet complete.",
        });
        return;
      }

      if (!fs.existsSync(job.outputPath)) {
        res.status(404).json({
          error: "internal_error",
          message: "Output file not found.",
        });
        return;
      }

      const stat = fs.statSync(job.outputPath);
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="repository-video.mp4"`,
      );
      res.setHeader("Content-Length", String(stat.size));
      if (job.sizeWarning) {
        res.setHeader("X-File-Size-Warning", "true");
      }

      const outputPath = job.outputPath;
      const stream = fs.createReadStream(outputPath);
      stream.pipe(res);

      res.on("finish", () => {
        try {
          if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
          }
        } catch {
          // Best-effort cleanup
        }
      });
    } catch (err: unknown) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Top-level error handler
// ---------------------------------------------------------------------------

/**
 * Map ApiError instances to structured JSON responses. Unrecognised errors
 * become HTTP 500 with code `internal_error`.
 *
 * @remarks
 * Must be registered with four parameters so Express identifies it as an
 * error-handling middleware.
 */
export function apiErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ApiError) {
    const status = HTTP_STATUS[err.code] ?? 500;
    res.status(status).json({ error: err.code, message: err.message });
    return;
  }

  console.error("[unhandled error]", err);
  res.status(500).json({
    error: "internal_error",
    message: "An unexpected error occurred. Please try again later.",
  });
}
