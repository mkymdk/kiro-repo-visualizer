/**
 * Client-side cancellation helpers from `useRenderJob` (Req 4.19, 4.21; Property 18).
 *
 * The project has no DOM testing library, so the hook's decision logic is
 * extracted into pure exported helpers and tested here in the node environment.
 */

import { describe, it, expect, vi } from "vitest";
import { cancelRenderJob, canCancel, streamOutcome } from "../src/hooks/useRenderJob.js";

describe("cancelRenderJob", () => {
  it("sends DELETE for the active job before closing the progress stream", async () => {
    const order: string[] = [];
    const controller = new AbortController();
    controller.signal.addEventListener("abort", () => order.push("abort"));
    const fetchImpl = vi.fn(async (url: string, init?: { method?: string }) => {
      order.push(`${init?.method} ${url}`);
    });
    await cancelRenderJob("job-1", controller, fetchImpl);
    expect(order).toEqual(["DELETE /api/render/job-1", "abort"]);
  });

  it("still closes the stream when DELETE fails", async () => {
    const controller = new AbortController();
    await cancelRenderJob("job-1", controller, async () => {
      throw new Error("offline");
    });
    expect(controller.signal.aborted).toBe(true);
  });

  it("sends no DELETE before the job ID is known", async () => {
    const fetchImpl = vi.fn(async () => {});
    const controller = new AbortController();
    await cancelRenderJob(null, controller, fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(controller.signal.aborted).toBe(true);
  });
});

describe("canCancel (Cancel button enablement)", () => {
  it("is enabled only while rendering with a known job ID", () => {
    expect(canCancel("rendering", null)).toBe(false);
    expect(canCancel("rendering", "job-1")).toBe(true);
    for (const s of ["idle", "pending", "complete", "failed", "cancelled"] as const) expect(canCancel(s, "job-1")).toBe(false);
  });
});

describe("streamOutcome", () => {
  it("treats a quiet stream end (no 100, no error) as cancelled, not failed", () => {
    expect(streamOutcome(false, false)).toBe("cancelled");
    expect(streamOutcome(true, false)).toBe("complete");
    expect(streamOutcome(false, true)).toBe("failed");
  });
});
