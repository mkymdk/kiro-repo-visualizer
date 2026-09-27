/**
 * Tests for src/config/output.ts
 *
 * Validates Correctness Property 2: Output Constants Are Immutable at Runtime.
 */

import { describe, it, expect } from "vitest";
import { VIDEO_CONFIG, SLIDE_CONFIG } from "../src/config/output.js";

describe("config immutability (Property 2)", () => {
  it("VIDEO_CONFIG is frozen at runtime", () => {
    expect(Object.isFrozen(VIDEO_CONFIG)).toBe(true);
    expect(() => {
      // @ts-expect-error runtime mutation attempt
      VIDEO_CONFIG.fps = 999;
    }).toThrow(TypeError);
    expect(VIDEO_CONFIG.fps).toBe(30);
  });

  it("SLIDE_CONFIG is frozen at runtime", () => {
    expect(Object.isFrozen(SLIDE_CONFIG)).toBe(true);
    expect(() => {
      // @ts-expect-error runtime mutation attempt
      SLIDE_CONFIG.minSlides = 99;
    }).toThrow(TypeError);
    expect(SLIDE_CONFIG.minSlides).toBe(3);
  });

  it("VIDEO_CONFIG retains all spec values", () => {
    expect(VIDEO_CONFIG.width).toBe(1280);
    expect(VIDEO_CONFIG.height).toBe(720);
    expect(VIDEO_CONFIG.codec).toBe("h264");
    expect(VIDEO_CONFIG.container).toBe("mp4");
  });
});
