---
inclusion: fileMatch
fileMatchPattern: "**/*.{ts,tsx,js,jsx,py,go,java}"
---

# Output Constants: Video & Slide Configuration

## Scope

These rules apply to every file that:
- Renders video frames or encodes a video file
- Calculates or enforces video duration or frame counts
- Generates, counts, validates, or previews storyboard slides
- Configures any media pipeline (encoder settings, canvas dimensions, frame rate)

All approved output constants live in **one config module**. No other file may declare or inline these values.

---

## 1. Canonical Config Module

The single source of truth for all output constants is:

```
src/config/output.ts        (TypeScript / JavaScript projects)
src/config/output.py        (Python projects)
src/config/output.go        (Go projects)
src/config/output.java      (Java projects)
```

Create this file if it does not yet exist. Every other module that needs these values must import from it.

### 1.1 Required TypeScript / JavaScript Definition

```typescript
// src/config/output.ts

export const VIDEO_CONFIG = {
  /** Output frame width in pixels */
  width: 1280,
  /** Output frame height in pixels */
  height: 720,
  /** Frames per second */
  fps: 30,
  /** Video codec identifier */
  codec: "h264",
  /** Container format */
  container: "mp4",
  /** Minimum video duration in seconds */
  minDurationSeconds: 30,
  /** Maximum video duration in seconds */
  maxDurationSeconds: 300, // 5 minutes
  /** Maximum downloadable file size in bytes before warning the user */
  maxFileSizeBytes: 200 * 1024 * 1024, // 200 MB
  /** Progress indicator update interval in milliseconds */
  progressIntervalMs: 2_000,
  /** Milliseconds after render completion before download is offered */
  downloadReadyMs: 5_000,
  /** Maximum time in seconds to honour a cancellation request */
  cancelTimeoutSeconds: 3,
} as const;

export const SLIDE_CONFIG = {
  /** Minimum number of slides in a storyboard */
  minSlides: 3,
  /** Maximum number of slides in a storyboard */
  maxSlides: 15,
  /** Maximum words shown in each slide preview summary */
  previewMaxWords: 50,
  /** Maximum words extracted from README for the introduction slide */
  introMaxWords: 300,
  /** Maximum section headings listed on a spec documentation slide */
  specMaxHeadings: 5,
  /** Maximum sentences extracted per spec section on a spec documentation slide */
  specMaxSentences: 3,
  /** Maximum Engineering Highlights extracted from commit history */
  maxHighlights: 10,
} as const;

export type VideoConfig = typeof VIDEO_CONFIG;
export type SlideConfig = typeof SLIDE_CONFIG;
```

### 1.2 Required Python Definition

```python
# src/config/output.py

VIDEO_CONFIG = {
    "width": 1280,
    "height": 720,
    "fps": 30,
    "codec": "h264",
    "container": "mp4",
    "min_duration_seconds": 30,
    "max_duration_seconds": 300,       # 5 minutes
    "max_file_size_bytes": 200 * 1024 * 1024,  # 200 MB
    "progress_interval_ms": 2_000,
    "download_ready_ms": 5_000,
    "cancel_timeout_seconds": 3,
}

SLIDE_CONFIG = {
    "min_slides": 3,
    "max_slides": 15,
    "preview_max_words": 50,
    "intro_max_words": 300,
    "spec_max_headings": 5,
    "spec_max_sentences": 3,
    "max_highlights": 10,
}
```

---

## 2. Usage Rules

### 2.1 Always Import — Never Inline

Any constant governed by this file **must** be referenced via an import from the config module. Inline literals for these values are forbidden.

```typescript
// ✅ Correct
import { VIDEO_CONFIG, SLIDE_CONFIG } from "@/config/output";

function validateSlideCount(count: number): boolean {
  return count >= SLIDE_CONFIG.minSlides && count <= SLIDE_CONFIG.maxSlides;
}

function buildEncoder() {
  return {
    width:  VIDEO_CONFIG.width,
    height: VIDEO_CONFIG.height,
    fps:    VIDEO_CONFIG.fps,
    codec:  VIDEO_CONFIG.codec,
  };
}
```

```typescript
// ❌ Incorrect — literal values scattered across modules
function validateSlideCount(count: number): boolean {
  return count >= 3 && count <= 15;   // forbidden
}

function buildEncoder() {
  return { width: 1280, height: 720, fps: 30, codec: "h264" };  // forbidden
}
```

### 2.2 Governed Constants

The following values are **only** permitted to appear as literals inside `src/config/output.ts` (or its language equivalent). They must be imported everywhere else:

| Constant | Value |
|---|---|
| Frame width | `1280` px |
| Frame height | `720` px |
| Frame rate | `30` fps |
| Video codec | `"h264"` |
| Container format | `"mp4"` |
| Minimum video duration | `30` seconds |
| Maximum video duration | `300` seconds (5 min) |
| Maximum file size warning threshold | `200` MB |
| Progress update interval | `2000` ms |
| Download ready deadline | `5000` ms |
| Cancellation deadline | `3` seconds |
| Minimum slide count | `3` |
| Maximum slide count | `15` |
| Slide preview word limit | `50` words |
| Introduction slide word limit | `300` words |
| Spec slide max headings | `5` |
| Spec slide max sentences | `3` |
| Max Engineering Highlights | `10` |

### 2.3 Changing a Constant

To change any value in this table:

1. Update it in `src/config/output.ts` only.
2. Do **not** patch call sites — they reference the constant by name and will pick up the change automatically.
3. If a requirements change drives the update, update `requirements.md` first, then the config module.

---

## 3. Derived Values

Some values used in the rendering pipeline are derived from the base constants. Compute them from the config — do not hardcode the result.

```typescript
// ✅ Correct — derived at runtime from config
import { VIDEO_CONFIG } from "@/config/output";

const minFrameCount = VIDEO_CONFIG.minDurationSeconds * VIDEO_CONFIG.fps; // 900
const maxFrameCount = VIDEO_CONFIG.maxDurationSeconds * VIDEO_CONFIG.fps; // 9000
const resolution    = `${VIDEO_CONFIG.width}x${VIDEO_CONFIG.height}`;     // "1280x720"
```

```typescript
// ❌ Incorrect — derived value hardcoded
const minFrameCount = 900;
const resolution = "1280x720";
```

---

## 4. Config Module Constraints

- The config module must be **pure data** — no side effects, no I/O, no imports from application code.
- All exported objects must use `as const` (TypeScript) or be treated as immutable (other languages). Do not mutate config values at runtime.
- Do not read these values from environment variables or runtime config files. They are specification constants that must not vary between environments.
