/**
 * Storyboard generator — pure slide-assembly module with no I/O.
 *
 * Transforms a `RepoAnalysisResult` into an ordered `Slide[]`. Every piece
 * of keyword matching, slide ordering, and count enforcement lives here and
 * nowhere else.
 */

import { randomUUID } from "crypto";
import { SLIDE_CONFIG } from "../config/output.js";
import {
  ApiError,
  Commit,
  DirectoryNode,
  RepoAnalysisResult,
  Slide,
  SlideType,
  SpecDocument,
} from "../types/index.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Escape special HTML characters to prevent XSS when body text is rendered.
 *
 * @param text - Raw untrusted string (e.g. from GitHub API).
 * @returns The same string with `&`, `<`, `>`, `"`, and `'` replaced by
 *   HTML entities.
 */
export function htmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Truncate a string to at most `maxWords` whitespace-delimited words.
 *
 * @param text - The source string to truncate.
 * @param maxWords - Maximum number of words to keep.
 * @returns The truncated string. A trailing `"…"` is appended only when
 *   truncation actually occurs.
 */
export function truncateToWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text.trim();
  return words.slice(0, maxWords).join(" ") + "…";
}

/**
 * Build a slide object from its component parts.
 *
 * @param type - The {@link SlideType} discriminant for this slide.
 * @param title - Short slide title (not HTML-escaped here; callers escape).
 * @param body - HTML-escaped body text.
 * @param previewSummary - Plain-text summary already truncated to word limit.
 * @returns A complete {@link Slide} with a freshly generated UUID `id`.
 */
function makeSlide(
  type: SlideType,
  title: string,
  body: string,
  previewSummary: string,
): Slide {
  return { id: randomUUID(), type, title, body, previewSummary };
}

// ---------------------------------------------------------------------------
// Slide builders
// ---------------------------------------------------------------------------

/**
 * Build the introduction slide from the repository README.
 *
 * @param repo - The repository name used as a fallback title.
 * @param readmeText - Raw README content, or `null` if unavailable.
 * @returns An `"intro"` {@link Slide}.
 */
export function buildIntroSlide(
  repo: string,
  readmeText: string | null,
): Slide {
  const safeRepo = htmlEscape(repo);
  const title = `Introduction: ${safeRepo}`;

  if (!readmeText || readmeText.trim().length === 0) {
    const body = htmlEscape(`No README found for ${repo}.`);
    return makeSlide("intro", title, body, truncateToWords(body, SLIDE_CONFIG.previewMaxWords));
  }

  const truncated = truncateToWords(readmeText, SLIDE_CONFIG.introMaxWords);
  const body = htmlEscape(truncated);
  const preview = truncateToWords(truncated, SLIDE_CONFIG.previewMaxWords);
  return makeSlide("intro", title, body, htmlEscape(preview));
}

/**
 * Build the architecture overview slide from the repository directory tree.
 *
 * Renders the top-level directory as an ASCII tree showing immediate children
 * of the root only (depth-1 entries).
 *
 * @param repo - Repository name for the slide title.
 * @param directoryTree - Flat {@link DirectoryNode} array from the analyzer.
 * @returns An `"architecture"` {@link Slide}.
 */
export function buildArchitectureSlide(
  repo: string,
  directoryTree: DirectoryNode[],
): Slide {
  const safeRepo = htmlEscape(repo);
  const title = `Architecture: ${safeRepo}`;

  // Collect top-level entries (no "/" in path = depth 1)
  const topLevel = directoryTree
    .filter((n) => !n.path.includes("/"))
    .sort((a, b) => {
      // directories first, then alphabetical
      if (a.type === b.type) return a.path.localeCompare(b.path);
      return a.type === "tree" ? -1 : 1;
    });

  if (topLevel.length === 0) {
    const body = htmlEscape("No directory structure available.");
    return makeSlide("architecture", title, body, truncateToWords(body, SLIDE_CONFIG.previewMaxWords));
  }

  const lines: string[] = [`${repo}/`];
  topLevel.forEach((node, i) => {
    const isLast = i === topLevel.length - 1;
    const prefix = isLast ? "└── " : "├── ";
    const suffix = node.type === "tree" ? "/" : "";
    lines.push(`${prefix}${node.path}${suffix}`);
  });

  const treeText = lines.join("\n");
  const body = htmlEscape(treeText);
  const preview = truncateToWords(treeText, SLIDE_CONFIG.previewMaxWords);
  return makeSlide("architecture", title, body, htmlEscape(preview));
}

/** Regex for commit messages that indicate an engineering highlight. */
const HIGHLIGHT_RE = /feat|fix|refactor|add|implement|redesign/i;

/**
 * Build up to `SLIDE_CONFIG.maxHighlights` engineering highlight slides.
 *
 * A commit qualifies when its message matches the keyword pattern
 * `feat|fix|refactor|add|implement|redesign` (case-insensitive).
 *
 * @param commits - Commit records from the analyzer.
 * @returns An array of zero or more `"highlight"` {@link Slide} objects,
 *   capped at `SLIDE_CONFIG.maxHighlights`.
 */
export function buildHighlightSlides(commits: Commit[]): Slide[] {
  return commits
    .filter((c) => HIGHLIGHT_RE.test(c.message))
    .slice(0, SLIDE_CONFIG.maxHighlights)
    .map((c) => {
      const safeMessage = htmlEscape(c.message);
      const safeAuthor = htmlEscape(c.author);
      const safeDate = htmlEscape(c.timestamp.slice(0, 10));
      const body = `${safeMessage}\n\nAuthor: ${safeAuthor}\nDate: ${safeDate}`;
      const preview = truncateToWords(c.message, SLIDE_CONFIG.previewMaxWords);
      return makeSlide(
        "highlight",
        `Highlight: ${safeMessage.slice(0, 60)}`,
        body,
        htmlEscape(preview),
      );
    });
}

/**
 * Build the spec documentation slide from `.kiro` spec documents.
 *
 * Extracts up to `SLIDE_CONFIG.specMaxHeadings` Markdown headings and
 * up to `SLIDE_CONFIG.specMaxSentences` sentences from sections whose
 * headings contain "design", "architecture", or "decision" (case-insensitive).
 *
 * @param specDocs - Spec documents from the analyzer.
 * @returns A `"spec"` {@link Slide}, or `null` if no spec docs exist.
 */
export function buildSpecSlide(specDocs: SpecDocument[]): Slide | null {
  if (specDocs.length === 0) return null;

  const allHeadings: string[] = [];
  const relevantSentences: string[] = [];

  for (const doc of specDocs) {
    const lines = doc.content.split("\n");
    let inRelevantSection = false;
    let sentenceBuffer = "";

    for (const line of lines) {
      const headingMatch = /^#{1,6}\s+(.+)/.exec(line);
      if (headingMatch) {
        const heading = headingMatch[1].trim();
        if (allHeadings.length < SLIDE_CONFIG.specMaxHeadings) {
          allHeadings.push(heading);
        }
        inRelevantSection =
          /design|architecture|decision/i.test(heading);
        continue;
      }

      if (
        inRelevantSection &&
        relevantSentences.length < SLIDE_CONFIG.specMaxSentences
      ) {
        sentenceBuffer += " " + line.trim();
        // Split on sentence boundaries
        const sentences = sentenceBuffer.match(/[^.!?]+[.!?]+/g) ?? [];
        for (const sentence of sentences) {
          if (
            relevantSentences.length < SLIDE_CONFIG.specMaxSentences &&
            sentence.trim().length > 0
          ) {
            relevantSentences.push(sentence.trim());
          }
        }
        // Keep the non-terminated tail for next iteration
        const lastSentenceEnd = sentenceBuffer.search(/[^.!?]*$/);
        if (lastSentenceEnd > 0) {
          sentenceBuffer = sentenceBuffer.slice(lastSentenceEnd);
        } else {
          sentenceBuffer = "";
        }
      }
    }
  }

  const headingLines = allHeadings
    .map((h) => `• ${htmlEscape(h)}`)
    .join("\n");
  const sentenceLines = relevantSentences
    .map((s) => htmlEscape(s))
    .join(" ");

  const body =
    `Headings:\n${headingLines}` +
    (sentenceLines ? `\n\nExcerpts:\n${sentenceLines}` : "");

  const plainPreview =
    allHeadings.slice(0, 3).join("; ") +
    (relevantSentences.length > 0 ? " — " + relevantSentences[0] : "");
  const preview = truncateToWords(plainPreview, SLIDE_CONFIG.previewMaxWords);

  return makeSlide("spec", "Spec Documentation", body, htmlEscape(preview));
}

/**
 * Build the conclusion slide with the repository name and GitHub URL.
 *
 * @param owner - Repository owner login.
 * @param repo - Repository name.
 * @returns A `"conclusion"` {@link Slide}.
 */
export function buildConclusionSlide(owner: string, repo: string): Slide {
  const safeOwner = htmlEscape(owner);
  const safeRepo = htmlEscape(repo);
  const url = `https://github.com/${safeOwner}/${safeRepo}`;
  const body = `Repository: ${safeOwner}/${safeRepo}\nURL: ${url}`;
  const preview = truncateToWords(
    `Explore ${repo} on GitHub: ${url}`,
    SLIDE_CONFIG.previewMaxWords,
  );
  return makeSlide("conclusion", `Conclusion: ${safeRepo}`, body, preview);
}

/**
 * Generate a plain-text preview summary for a slide body, capped at
 * `SLIDE_CONFIG.previewMaxWords` words.
 *
 * @param body - The HTML-escaped slide body string.
 * @returns A truncated plain-text summary.
 */
export function generatePreviewSummary(body: string): string {
  // Strip HTML entities back to readable text for the preview
  const plain = body
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return truncateToWords(plain, SLIDE_CONFIG.previewMaxWords);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Generate an ordered storyboard from a repository analysis result.
 *
 * Assembles slides in the canonical order:
 * intro → architecture → highlights → spec (if present) → conclusion.
 *
 * Trims highlight slides from the end if the total exceeds
 * `SLIDE_CONFIG.maxSlides`. Throws if the resulting count is below
 * `SLIDE_CONFIG.minSlides`.
 *
 * @param result - The {@link RepoAnalysisResult} from the repository analyzer.
 * @returns An ordered array of {@link Slide} objects with stable UUID `id`s.
 * @throws {@link ApiError} With code `insufficient_content` if the assembled
 *   slide count is less than `SLIDE_CONFIG.minSlides`.
 */
export function generateStoryboard(result: RepoAnalysisResult): Slide[] {
  const { owner, repo, readmeText, directoryTree, commits, specDocs } = result;

  const introSlide = buildIntroSlide(repo, readmeText);
  const archSlide = buildArchitectureSlide(repo, directoryTree);
  const highlightSlides = buildHighlightSlides(commits);
  const specSlide = buildSpecSlide(specDocs);
  const conclusionSlide = buildConclusionSlide(owner, repo);

  // Assemble in canonical order
  const slides: Slide[] = [introSlide, archSlide];

  // Determine how many highlight slides can fit within maxSlides
  const fixedCount = 2 + (specSlide ? 1 : 0) + 1; // intro + arch + (spec?) + conclusion
  const maxHighlightsAllowed = SLIDE_CONFIG.maxSlides - fixedCount;
  slides.push(...highlightSlides.slice(0, Math.max(0, maxHighlightsAllowed)));

  if (specSlide) slides.push(specSlide);
  slides.push(conclusionSlide);

  if (slides.length < SLIDE_CONFIG.minSlides) {
    throw new ApiError(
      "insufficient_content",
      `Repository does not contain enough content to generate a storyboard (minimum ${SLIDE_CONFIG.minSlides} slides required, got ${slides.length}).`,
    );
  }

  return slides;
}
