/**
 * Storyboard generator — pure slide-assembly module with no I/O.
 *
 * Transforms a `RepoAnalysisResult` into an ordered `Slide[]` that explains
 * the repository in six acts: what it is, what users can do with it, how to
 * run it, how it works, its key features, and how it has evolved.
 *
 * Current-state slides and Anchor_Terms are derived only from the README,
 * repository metadata, spec documents, and directory tree. Releases, pull
 * requests, and commits feed the evolution act only, are relevance-gated, and
 * never pad the storyboard. Every section matching, relevance, ranking,
 * allocation, ordering, and count rule lives here and nowhere else.
 */

import { randomUUID } from "crypto";
import { SLIDE_CONFIG } from "../config/output.js";
import {
  ApiError,
  ChangeCategory,
  Commit,
  DirectoryNode,
  PrCommitEvidence,
  PullRequest,
  Release,
  RepoAnalysisResult,
  RepoMetadata,
  Slide,
  SlideType,
  SpecDocument,
} from "../types/index.js";

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/**
 * Escape special HTML characters to prevent XSS when slide text is rendered.
 *
 * @param text - Raw untrusted string (e.g. from GitHub API).
 * @returns The string with `&`, `<`, `>`, `"`, and `'` replaced by entities.
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
 * @returns The trimmed string; a trailing `"…"` is appended only when
 *   truncation actually occurs.
 */
export function truncateToWords(text: string, maxWords: number): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";
  const words = trimmed.split(/\s+/);
  if (words.length <= maxWords) return trimmed;
  return words.slice(0, maxWords).join(" ") + "…";
}

/**
 * Reduce inline Markdown and HTML to plain text.
 *
 * Images and links become their text, emphasis/code markers are removed, HTML
 * tags are stripped, and whitespace is collapsed.
 *
 * @param md - A Markdown fragment.
 * @returns Plain text.
 */
export function toPlainText(md: string): string {
  return md
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
    .replace(/<\/?[a-zA-Z][^<>]*>/g, " ")
    .replace(/(\*\*|__)(\S(?:.*?\S)?)\1/g, "$2")
    .replace(/(^|[\s(])\*(\S(?:.*?\S)?)\*(?=[\s).,!?:;]|$)/g, "$1$2")
    .replace(/(^|[\s(])_(\S(?:.*?\S)?)_(?=[\s).,!?:;]|$)/g, "$1$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Split plain text into sentences and return the first `n`.
 *
 * A sentence ends at `.`, `!`, or `?` followed by whitespace and an
 * uppercase letter, digit, or opening quote/bracket; a trailing fragment
 * without terminal punctuation counts as a sentence.
 *
 * @param text - Plain text.
 * @param n - Maximum sentences to return.
 * @returns Up to `n` non-empty trimmed sentences.
 */
export function firstSentences(text: string, n: number): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\[`])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, n);
}

/** Normalize text for overlap comparison: lowercase, punctuation → space, collapsed. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * A GitHub-style emoji shortcode (`:muscle:`, `:+1:`), not directly adjacent to
 * a letter, digit, or colon so that times (`10:30:45`), IPv6 addresses
 * (`2001:db8::1`), and `std::vector` are left intact. The name must contain a
 * letter, or be exactly `+1` / `-1`.
 */
const EMOJI_SHORTCODE_RE = /(?<![A-Za-z0-9:]):(?:[a-z0-9_+-]*[a-z][a-z0-9_+-]*|\+1|-1):(?![A-Za-z0-9:])/g;

/**
 * Remove GitHub-style Emoji_Shortcodes from prose text (B6a, Req 3.14).
 *
 * @param text - Any prose text; may contain newlines.
 * @returns The text with shortcodes removed, whitespace collapsed per line,
 *   and line breaks preserved. Non-shortcode colon syntax is left unchanged.
 */
export function stripEmojiShortcodes(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(EMOJI_SHORTCODE_RE, "").replace(/[ \t]{2,}/g, " ").replace(/[ \t]+$/g, "").replace(/^[ \t]+/g, ""))
    .join("\n");
}

/** ISO 8601 timestamp → `YYYY-MM-DD`. */
function isoDate(timestamp: string): string {
  return timestamp.slice(0, 10);
}

/** Uppercase the first character of a string. */
function capitalize(text: string): string {
  return text.length > 0 ? text[0]!.toUpperCase() + text.slice(1) : text;
}

// ---------------------------------------------------------------------------
// Markdown structure helpers
// ---------------------------------------------------------------------------

/** One Markdown line annotated with fence and heading information. */
interface ScannedLine {
  /** The raw line. */
  text: string;
  /** True when the line is a fence delimiter or inside a fenced code block. */
  inFence: boolean;
  /** Heading level (1–6) when the line is a heading outside a fence. */
  headingLevel: number | null;
  /** Plain-text heading content when the line is a heading. */
  headingText: string | null;
}

/** A Markdown section: its heading and the lines up to the next same-or-higher heading. */
export interface MarkdownSection {
  /** Plain-text heading. */
  heading: string;
  /** Heading level. */
  level: number;
  /** Scanned lines of the section body. */
  lines: ScannedLine[];
}

/**
 * Annotate Markdown lines with fence state and heading levels.
 *
 * @param md - Markdown document.
 * @returns One {@link ScannedLine} per input line.
 */
function scanLines(md: string): ScannedLine[] {
  const out: ScannedLine[] = [];
  let inFence = false;
  for (const text of md.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s{0,3}(```|~~~)/.test(text)) {
      out.push({ text, inFence: true, headingLevel: null, headingText: null });
      inFence = !inFence;
      continue;
    }
    const heading = inFence ? null : /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(text);
    out.push({
      text,
      inFence,
      headingLevel: heading ? heading[1]!.length : null,
      headingText: heading ? toPlainText(heading[2]!) : null,
    });
  }
  return out;
}

/** Heading text with leading shortcodes/emoji/punctuation and trailing colon removed, for matching. */
function headingKey(heading: string): string {
  return stripEmojiShortcodes(heading).replace(/^[^A-Za-z0-9]+/, "").replace(/[:\s]+$/, "");
}

/**
 * Find the first section, in document order, whose heading matches `pattern`.
 *
 * Headings inside fenced code blocks are ignored. The section body runs to the
 * next heading of the same or higher level.
 *
 * @param md - Markdown document.
 * @param pattern - Pattern tested against the normalized heading text.
 * @returns The matching {@link MarkdownSection}, or null.
 */
export function findSection(md: string, pattern: RegExp): MarkdownSection | null {
  const lines = scanLines(md);
  const start = lines.findIndex(
    (l) => l.headingText !== null && pattern.test(headingKey(l.headingText)),
  );
  if (start === -1) return null;
  const level = lines[start]!.headingLevel!;
  const body: ScannedLine[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.headingLevel !== null && l.headingLevel <= level) break;
    body.push(l);
  }
  return { heading: lines[start]!.headingText!, level, lines: body };
}

/** Regex for a top-level list item (`-`, `*`, `+`, or `1.` / `1)`). */
const LIST_ITEM_RE = /^\s{0,3}(?:[-*+]|\d+[.)])\s+(.*)$/;

/**
 * Extract top-level list items from section lines, joining continuation lines.
 *
 * @param lines - Section body lines.
 * @returns Raw Markdown text of each list item.
 */
export function listItems(lines: ScannedLine[]): string[] {
  const items: string[] = [];
  let current: string | null = null;
  for (const l of lines) {
    if (l.inFence || l.headingLevel !== null) {
      if (current !== null) items.push(current);
      current = null;
      continue;
    }
    const m = LIST_ITEM_RE.exec(l.text);
    if (m) {
      if (current !== null) items.push(current);
      current = m[1]!;
    } else if (current !== null && /^\s{2,}\S/.test(l.text) && !/^\s*[-*+]\s/.test(l.text)) {
      current += " " + l.text.trim();
    } else if (l.text.trim() === "" || current !== null) {
      if (current !== null) items.push(current);
      current = null;
    }
  }
  if (current !== null) items.push(current);
  return items.filter((i) => i.trim().length > 0);
}

/** True when a line is a prose line (not blank, heading, list, table, rule, fence, HTML, or badge). */
function isProseLine(l: ScannedLine): boolean {
  const t = l.text.trim();
  if (t === "" || l.inFence || l.headingLevel !== null) return false;
  if (LIST_ITEM_RE.test(l.text)) return false;
  if (t.startsWith("|") || t.startsWith("<")) return false;
  if (/^([-*_=]\s*){3,}$/.test(t)) return false;
  if (/^>\s*\[!\w+\]/.test(t)) return false;
  if (/^\*\*[^*]+\*\*:?$/.test(t)) return false;
  // Badge / image-only lines: nothing remains once images and empty links go.
  const withoutImages = t
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[\s*\]\([^)]*\)/g, "")
    .trim();
  return withoutImages.length > 0;
}

/** Plain text of a prose line, with any blockquote marker removed. */
function proseText(l: ScannedLine): string {
  return toPlainText(l.text.trim().replace(/^>\s?/, ""));
}

/**
 * Collect the plain text of all prose lines in a section, in order.
 *
 * @param lines - Section body lines.
 * @returns Joined plain text.
 */
function sectionProse(lines: ScannedLine[]): string {
  return lines.filter(isProseLine).map(proseText).join(" ").trim();
}

/** EARS/requirement lead-ins and spec bookkeeping lines (B2a-2). */
const REQUIREMENT_LINE_RE = /^(the system shall\b|when |if |while |requirement\s+\d+\s*:|user story\s*:)/i;

/** Glossary definition line: a bold or backticked term immediately followed by a colon (B2a-2). */
const GLOSSARY_LINE_RE = /^(\*\*[^*]+\*\*|`[^`]+`)\s*:/;

/**
 * Decide whether a line is Explanatory_Prose (B2a-2, Req 6.3): a prose line that
 * is not an EARS/requirement statement, not a Glossary definition, and not a
 * single-token label. Structural rules only; no numeric length threshold.
 *
 * @param l - A scanned line.
 * @returns True when the line is eligible explanatory prose.
 */
function isExplanatoryProse(l: ScannedLine): boolean {
  if (!isProseLine(l)) return false;
  const raw = l.text.trim().replace(/^>\s?/, "");
  if (REQUIREMENT_LINE_RE.test(raw) || GLOSSARY_LINE_RE.test(raw)) return false;
  const plain = proseText(l);
  // Reject single-token labels (fewer than two words); keep genuine sentences.
  return /\S\s+\S/.test(plain);
}

/**
 * Return the first run of consecutive Explanatory_Prose lines across the given
 * documents, scanning each document's lines in order (B2a-2). Used only as the
 * how-it-works fallback when preferred sections yield no prose.
 *
 * @param docs - Spec documents, already in `designFirst` order.
 * @returns Joined plain text of the first eligible paragraph, or "".
 */
function specExplanatoryProse(docs: SpecDocument[]): string {
  for (const doc of docs) {
    const run: ScannedLine[] = [];
    for (const l of scanLines(doc.content)) {
      if (isExplanatoryProse(l)) {
        run.push(l);
      } else if (run.length > 0) {
        break;
      }
    }
    if (run.length > 0) return run.map(proseText).join(" ").trim();
  }
  return "";
}

/**
 * Return the first prose paragraph of a Markdown document.
 *
 * @param md - Markdown document.
 * @returns Plain text of the first run of consecutive prose lines, or "".
 */
export function firstParagraph(md: string): string {
  const parts: string[] = [];
  for (const l of scanLines(md)) {
    if (isProseLine(l)) {
      parts.push(proseText(l));
    } else if (parts.length > 0) {
      break;
    }
  }
  return parts.join(" ").trim();
}

// ---------------------------------------------------------------------------
// Slide construction
// ---------------------------------------------------------------------------

/**
 * Build a slide from raw (unescaped) text, escaping every field centrally.
 *
 * @param type - The {@link SlideType}.
 * @param title - Raw title text.
 * @param body - Raw body text; may contain newlines.
 * @param preview - Optional raw preview text; derived from `body` when omitted.
 * @param literalBody - When true, the body is literal content (e.g. fenced-code
 *   Run steps) that is escaped but not shortcode-stripped, so commands and
 *   examples are preserved verbatim (B6a). Defaults to false.
 * @returns A {@link Slide} with a new UUID and HTML-escaped `title`, `body`,
 *   and `previewSummary` (capped at `SLIDE_CONFIG.previewMaxWords` words), with
 *   Emoji_Shortcodes removed from prose fields.
 */
function makeSlide(type: SlideType, title: string, body: string, preview?: string, literalBody = false): Slide {
  const cleanTitle = stripEmojiShortcodes(title);
  const cleanBody = literalBody
    ? body
    : body
        .split("\n")
        .map((line) => ({ original: line, stripped: stripEmojiShortcodes(line) }))
        // Drop a line only when stripping a shortcode emptied a previously non-empty line.
        .filter(({ original, stripped }) => {
          const hadContent = original.trim() !== "" && original.trim() !== "•";
          const nowEmpty = stripped.trim() === "" || stripped.trim() === "•";
          return !(hadContent && nowEmpty);
        })
        .map(({ stripped }) => stripped)
        .join("\n");
  const previewSource = preview !== undefined ? stripEmojiShortcodes(preview) : cleanBody;
  const plainPreview = previewSource.replace(/^[•\s]+/gm, "").replace(/\s+/g, " ");
  return {
    id: randomUUID(),
    type,
    title: htmlEscape(cleanTitle),
    body: htmlEscape(cleanBody),
    previewSummary: htmlEscape(truncateToWords(plainPreview, SLIDE_CONFIG.previewMaxWords)),
  };
}

// ---------------------------------------------------------------------------
// Act 1 — What is this repository?
// ---------------------------------------------------------------------------

/**
 * Normalized comparison key for overview deduplication (B6b, Req 5.12).
 *
 * Strips Emoji_Shortcodes and inline Markdown, removes an exact leading
 * repository name followed by structural punctuation (`:`, `-`, `–`, `—`, `,`),
 * then applies {@link normalize}. No wording transform (such as a leading
 * "is") is performed.
 *
 * @param text - A sentence or description.
 * @param repo - Repository name.
 * @returns The comparison key.
 */
function overviewKey(text: string, repo: string): string {
  const plain = stripEmojiShortcodes(toPlainText(text));
  const prefix = new RegExp(`^\\s*${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:\\-–—,]\\s*`, "i");
  return normalize(plain.replace(prefix, ""));
}

/**
 * Drop README paragraph sentences that duplicate the repository description
 * (B6b, Req 5.12). Uses deterministic normalized-equality comparison only; a
 * sentence that adds meaningful words is kept.
 *
 * @param paragraph - The first README prose paragraph (untruncated).
 * @param description - The repository description.
 * @param repo - Repository name.
 * @returns The paragraph with duplicate sentences removed; "" when none remain.
 */
function dedupeParagraph(paragraph: string, description: string, repo: string): string {
  if (!paragraph) return "";
  const dupKeys = new Set<string>([
    overviewKey(description, repo),
    ...firstSentences(description, Number.MAX_SAFE_INTEGER).map((s) => overviewKey(s, repo)),
  ]);
  dupKeys.delete("");
  const kept = firstSentences(paragraph, Number.MAX_SAFE_INTEGER).filter(
    (s) => !dupKeys.has(overviewKey(s, repo)),
  );
  return kept.join(" ").trim();
}

/**
 * Build the overview slide.
 *
 * @param repo - Repository name (slide title).
 * @param readmeText - Raw README, or null.
 * @param metadata - Repository metadata, or null.
 * @returns An `"intro"` {@link Slide} with description, topics, and the first
 *   README prose paragraph (≤ `SLIDE_CONFIG.introMaxWords` words), or a
 *   "No description available." statement when neither is present.
 */
export function buildIntroSlide(
  repo: string,
  readmeText: string | null,
  metadata: RepoMetadata | null = null,
): Slide {
  const description = metadata?.description?.trim() ?? "";
  const rawParagraph = readmeText ? firstParagraph(readmeText) : "";
  const deduped = description ? dedupeParagraph(rawParagraph, description, repo) : rawParagraph;
  const paragraph = truncateToWords(deduped, SLIDE_CONFIG.introMaxWords);

  const lines: string[] = [];
  if (description) lines.push(description);
  if (metadata && metadata.topics.length > 0) lines.push(`Topics: ${metadata.topics.join(", ")}`);
  if (paragraph) lines.push(paragraph);
  if (!description && !paragraph) lines.push("No description available.");

  return makeSlide("intro", repo, lines.join("\n\n"));
}

// ---------------------------------------------------------------------------
// Act 2 — What can I do with it?
// ---------------------------------------------------------------------------

/** README headings that introduce a capabilities section. "Usage" belongs to Run only. */
const CAPABILITIES_HEADING_RE = /^(capabilities|what it does|what you can do|use cases)\b/i;

/**
 * A spec user story: `As a …, I want …, so that …`. Capture group 1 is the raw
 * "I want" clause, including any leading `to`/`System_Subject`, so the
 * Action_Phrase transform (B2a-1) and the selection key can be derived
 * separately.
 */
const USER_STORY_RE = /\bas an? [^,]+,\s*I want (.+?)(?:,?\s+so that\b.*)?$/i;

/**
 * Grammatical subjects that denote the software itself in a user story's
 * "I want <subject> to <action>" form (B2a-1, Req 5.13). Deliberately a
 * conservative, evidence-based set; not extended by matching arbitrary noun
 * phrases. Algorithm data, not a governed constant.
 */
const SYSTEM_SUBJECTS: readonly string[] = ["the system", "the video"];

/**
 * Reduce a user story's "I want" clause to its Action_Phrase (B2a-1, Req 5.13).
 *
 * Recognizes exactly two grammar shapes: a leading `to <action>`, or a leading
 * {@link SYSTEM_SUBJECTS} subject followed by ` to <action>`. Any other clause
 * (plain noun phrase, unrecognized subject before `to`, or no `to`) is returned
 * unchanged. No rewording, synonym substitution, tense change, or generation.
 *
 * @param clause - The raw "I want" clause (text after "I want", before "so that").
 * @returns The display Action_Phrase, capitalized with a trailing sentence mark removed.
 */
export function userStoryActionPhrase(clause: string): string {
  const trimmed = clause.trim();
  const lower = trimmed.toLowerCase();
  let action = trimmed;
  if (lower.startsWith("to ")) {
    action = trimmed.slice(3);
  } else {
    for (const subject of SYSTEM_SUBJECTS) {
      if (lower.startsWith(subject + " to ")) {
        action = trimmed.slice(subject.length + 4);
        break;
      }
    }
  }
  return capitalize(action.trim().replace(/[.,;]+$/, ""));
}

/**
 * Extract Capabilities: README capabilities section first, spec user stories second.
 *
 * The returned strings are the selection-stable Capability texts used for
 * deduplication, the Capabilities-versus-Key_Feature overlap check (Req 5.5),
 * and Anchor_Terms. For spec user stories, the leading `to` is removed exactly
 * as before; the Action_Phrase display transform (B2a-1) is applied only when
 * the slide is built, so improved wording never changes selection, order,
 * overlap, or anchors.
 *
 * @param readmeText - Raw README, or null.
 * @param specDocs - Spec documents.
 * @returns Up to `SLIDE_CONFIG.capabilitiesMaxItems` Capabilities, each
 *   truncated to `SLIDE_CONFIG.capabilityMaxWords` words.
 */
export function extractCapabilities(readmeText: string | null, specDocs: SpecDocument[]): string[] {
  let raw: string[] = [];
  const section = readmeText ? findSection(readmeText, CAPABILITIES_HEADING_RE) : null;
  if (section) {
    const items = listItems(section.lines).map(toPlainText);
    raw = items.length > 0 ? items : firstSentences(sectionProse(section.lines), SLIDE_CONFIG.capabilitiesMaxItems);
  }
  if (raw.length === 0) {
    for (const doc of specDocs) {
      for (const l of scanLines(doc.content)) {
        if (l.inFence) continue;
        const text = toPlainText(l.text).replace(/^User Story:\s*/i, "");
        const m = USER_STORY_RE.exec(text);
        if (m) raw.push(capitalize(m[1]!.trim().replace(/^to\s+/i, "").replace(/[.,;]+$/, "")));
      }
    }
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const key = normalize(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(truncateToWords(item, SLIDE_CONFIG.capabilityMaxWords));
    if (out.length >= SLIDE_CONFIG.capabilitiesMaxItems) break;
  }
  return out;
}

/**
 * Build the Capabilities slide.
 *
 * Applies the Action_Phrase display transform (B2a-1) to each Capability. The
 * transform only strips a leading `to`/`System_Subject` prefix, so README-sourced
 * Capabilities are unchanged and only spec-story wording improves. This is a
 * display-only step: selection, order, dedup, overlap, and anchors were already
 * decided from the untransformed text.
 *
 * @param capabilities - Extracted Capabilities (non-empty).
 * @returns A `"capabilities"` {@link Slide}.
 */
export function buildCapabilitiesSlide(capabilities: string[]): Slide {
  const display = capabilities.map((c) => userStoryActionPhrase(c));
  return makeSlide("capabilities", "What you can do", display.map((c) => `• ${c}`).join("\n"));
}

/**
 * Decide whether Capabilities substantially duplicate the Key_Features.
 *
 * A Capability matches when its normalized text contains, or is contained in,
 * the normalized name or description of any Key_Feature.
 *
 * @param capabilities - Extracted Capabilities.
 * @param features - Extracted Key_Features.
 * @returns True when the matching fraction exceeds
 *   `SLIDE_CONFIG.capabilitiesMaxOverlapRatio`.
 */
export function capabilitiesOverlapFeatures(capabilities: string[], features: KeyFeature[]): boolean {
  if (capabilities.length === 0 || features.length === 0) return false;
  const featureTexts = features
    .flatMap((f) => [f.name, f.description ?? ""])
    .map(normalize)
    .filter((t) => t.length > 0);
  const matches = capabilities.filter((c) => {
    const nc = normalize(c);
    return nc.length > 0 && featureTexts.some((f) => nc.includes(f) || f.includes(nc));
  }).length;
  return matches / capabilities.length > SLIDE_CONFIG.capabilitiesMaxOverlapRatio;
}

// ---------------------------------------------------------------------------
// Act 3 — How do I run it?
// ---------------------------------------------------------------------------

/** README headings that introduce run instructions (B4, Req 5.7). */
const RUN_HEADING_RE = /^(install|installation|getting started|setup|usage|quick start|examples?)\b/i;

/**
 * Build the "how to run this repository" slide from README content.
 *
 * Uses the first matching section; prefers the first fenced code block's
 * lines, otherwise non-blank prose lines. At most `SLIDE_CONFIG.runMaxSteps`
 * steps, each truncated to `SLIDE_CONFIG.runMaxWordsPerStep` words.
 *
 * @param readmeText - Raw README content, or `null`.
 * @returns A `"run"` {@link Slide}, or `null` when no section matches.
 */
export function buildRunSlide(readmeText: string | null): Slide | null {
  if (!readmeText || readmeText.trim().length === 0) return null;
  const section = findSection(readmeText, RUN_HEADING_RE);
  if (!section) return null;

  const codeLines: string[] = [];
  let inFirstFence = false;
  let sawFence = false;
  for (const l of section.lines) {
    if (/^\s{0,3}(```|~~~)/.test(l.text)) {
      if (sawFence && inFirstFence) break;
      sawFence = true;
      inFirstFence = true;
      continue;
    }
    if (inFirstFence) codeLines.push(l.text);
  }

  const fromCode = sawFence && codeLines.some((s) => s.trim().length > 0);
  const rawSteps = fromCode
    ? codeLines.filter((s) => s.trim().length > 0)
    : section.lines
        .filter((l) => !l.inFence && l.text.trim().length > 0)
        .map((l) => l.text.trim());

  const steps = rawSteps
    .slice(0, SLIDE_CONFIG.runMaxSteps)
    .map((s) => truncateToWords(s, SLIDE_CONFIG.runMaxWordsPerStep));
  if (steps.length === 0) return null;

  // Code-block steps are literal commands/examples: escape but never shortcode-strip them (B6a).
  return makeSlide("run", `How to run: ${section.heading}`, steps.join("\n"), undefined, fromCode);
}

// ---------------------------------------------------------------------------
// Act 4 — How does it work?
// ---------------------------------------------------------------------------

/**
 * Build the architecture overview slide from the top-level directory tree.
 *
 * @param repo - Repository name.
 * @param directoryTree - Directory nodes from the analyzer.
 * @returns An `"architecture"` {@link Slide} listing directories before files.
 */
export function buildArchitectureSlide(repo: string, directoryTree: DirectoryNode[]): Slide {
  const title = `Architecture: ${repo}`;
  const topLevel = directoryTree
    .filter((n) => !n.path.includes("/"))
    .sort((a, b) => {
      if (a.type === b.type) return a.path.localeCompare(b.path);
      return a.type === "tree" ? -1 : 1;
    });

  if (topLevel.length === 0) {
    return makeSlide("architecture", title, "No directory structure available.");
  }

  const lines = [`${repo}/`];
  topLevel.forEach((node, i) => {
    const prefix = i === topLevel.length - 1 ? "└── " : "├── ";
    lines.push(`${prefix}${node.path}${node.type === "tree" ? "/" : ""}`);
  });
  return makeSlide("architecture", title, lines.join("\n"));
}

/** README headings that introduce a how-it-works section. */
const HOW_IT_WORKS_HEADING_RE = /^(how it works|architecture|design)\b/i;

/** Spec headings whose sections supply how-it-works sentences. */
const DESIGN_SECTION_RE = /design|architecture|decision/i;

/** Result of how-it-works extraction: the slide content plus headings for anchors. */
export interface HowItWorks {
  /** Raw slide body. */
  body: string;
  /** Headings contributing Anchor_Terms. */
  headings: string[];
}

/** Order spec documents so `design.md` files come first, preserving relative order. */
function designFirst(specDocs: SpecDocument[]): SpecDocument[] {
  const isDesign = (d: SpecDocument): boolean => /(^|\/)design\.md$/i.test(d.path);
  return [...specDocs.filter(isDesign), ...specDocs.filter((d) => !isDesign(d))];
}

/**
 * Extract how-it-works content: README section first, spec documents second.
 *
 * @param readmeText - Raw README, or null.
 * @param specDocs - Spec documents.
 * @returns A {@link HowItWorks}, or null when no source provides content.
 */
export function extractHowItWorks(readmeText: string | null, specDocs: SpecDocument[]): HowItWorks | null {
  const section = readmeText ? findSection(readmeText, HOW_IT_WORKS_HEADING_RE) : null;
  if (section) {
    const sentences = firstSentences(sectionProse(section.lines), SLIDE_CONFIG.specMaxSentences);
    if (sentences.length > 0) {
      const subheadings = section.lines
        .filter((l) => l.headingText !== null)
        .map((l) => l.headingText!);
      return {
        body: [section.heading, "", sentences.join(" ")].join("\n"),
        headings: [section.heading, ...subheadings],
      };
    }
  }

  if (specDocs.length === 0) return null;
  const docs = designFirst(specDocs);
  const primary = scanLines(docs[0]!.content);
  const docTitle =
    primary.find((l) => l.headingLevel === 1)?.headingText ??
    docs[0]!.path.split("/").slice(-2).join("/");

  const headings: string[] = [];
  const sentences: string[] = [];
  for (const doc of docs) {
    const lines = scanLines(doc.content);
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      if (l.headingText === null || l.headingLevel === 1) continue;
      if (headings.length < SLIDE_CONFIG.specMaxHeadings) headings.push(l.headingText);
      if (sentences.length < SLIDE_CONFIG.specMaxSentences && DESIGN_SECTION_RE.test(l.headingText)) {
        const body: ScannedLine[] = [];
        for (let j = i + 1; j < lines.length && lines[j]!.headingLevel === null; j++) body.push(lines[j]!);
        for (const s of firstSentences(sectionProse(body), SLIDE_CONFIG.specMaxSentences)) {
          if (sentences.length < SLIDE_CONFIG.specMaxSentences) sentences.push(s);
        }
      }
    }
  }

  // Fallback (B2a-2, Req 6.3): when no design/architecture/decision section
  // supplied prose, use the first substantive Explanatory_Prose paragraph in
  // designFirst/document order. Headings and anchors are left unchanged.
  if (sentences.length === 0) {
    for (const s of firstSentences(specExplanatoryProse(docs), SLIDE_CONFIG.specMaxSentences)) {
      if (sentences.length < SLIDE_CONFIG.specMaxSentences) sentences.push(s);
    }
  }

  if (headings.length === 0 && sentences.length === 0) return null;

  const parts = [docTitle];
  if (headings.length > 0) parts.push("", ...headings.map((h) => `• ${h}`));
  if (sentences.length > 0) parts.push("", sentences.join(" "));
  return { body: parts.join("\n"), headings };
}

/**
 * Build the how-it-works slide.
 *
 * @param howItWorks - Extracted content.
 * @returns A `"howItWorks"` {@link Slide}.
 */
export function buildHowItWorksSlide(howItWorks: HowItWorks): Slide {
  return makeSlide("howItWorks", "How it works", howItWorks.body);
}

// ---------------------------------------------------------------------------
// Act 5 — What are its key features?
// ---------------------------------------------------------------------------

/** An extracted Key_Feature. */
export interface KeyFeature {
  /** Feature name (plain text). */
  name: string;
  /** Feature description (plain text, truncated), or null when absent. */
  description: string | null;
}

/** README headings that introduce a features section. */
const FEATURES_HEADING_RE = /^(features|key features|highlights)\b/i;

/**
 * Split a features list item into name and description.
 *
 * Supports `**Name** — desc`, `**Name**: desc`, `**Name** - desc`, and plain
 * `Name: desc` / `Name — desc` / `Name - desc`. Without a separator, the whole
 * item is the name.
 *
 * @param item - Raw Markdown list item text.
 * @returns A {@link KeyFeature}.
 */
export function parseFeatureItem(item: string): KeyFeature {
  const bold = /^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*(?:[:—–-]\s*|\.\s+)?(.*)$/.exec(item);
  let name: string;
  let desc: string;
  if (bold) {
    name = bold[1]!.replace(/[:.]\s*$/, "");
    desc = bold[2]!;
  } else {
    const plain = toPlainText(item);
    const sep = /(:\s+|\s+[—–-]\s+)/.exec(plain);
    if (sep && sep.index > 0) {
      name = plain.slice(0, sep.index);
      desc = plain.slice(sep.index + sep[0].length);
    } else {
      name = plain;
      desc = "";
    }
  }
  const description = truncateToWords(toPlainText(desc), SLIDE_CONFIG.featureMaxWords);
  return { name: toPlainText(name), description: description.length > 0 ? description : null };
}

/** Strip a leading number and trailing parenthetical from a component heading. */
function componentName(heading: string): string {
  return heading.replace(/^\d+[.)]\s*/, "").replace(/\s*\([^)]*\)\s*$/, "").trim();
}

/**
 * Extract Key_Features: README features section, then design Components
 * subheadings, then requirement titles (names only).
 *
 * @param readmeText - Raw README, or null.
 * @param specDocs - Spec documents.
 * @returns Extracted {@link KeyFeature} records in document order.
 */
export function extractKeyFeatures(readmeText: string | null, specDocs: SpecDocument[]): KeyFeature[] {
  const section = readmeText ? findSection(readmeText, FEATURES_HEADING_RE) : null;
  if (section) {
    const items = listItems(section.lines).map(parseFeatureItem).filter((f) => f.name.length > 0);
    if (items.length > 0) return items;
  }

  for (const doc of designFirst(specDocs).filter((d) => /(^|\/)design\.md$/i.test(d.path))) {
    const components = findSection(doc.content, /components/i);
    if (!components) continue;
    const features: KeyFeature[] = [];
    let current: KeyFeature | null = null;
    let prose: ScannedLine[] = [];
    const flush = (): void => {
      if (current) {
        const sentence = firstSentences(sectionProse(prose), 1)[0] ?? "";
        const description = truncateToWords(sentence, SLIDE_CONFIG.featureMaxWords);
        features.push({ name: current.name, description: description || null });
      }
    };
    for (const l of components.lines) {
      if (l.headingText !== null && l.headingLevel === components.level + 1) {
        flush();
        current = { name: componentName(l.headingText), description: null };
        prose = [];
      } else if (current && l.headingLevel === null) {
        prose.push(l);
      }
    }
    flush();
    const named = features.filter((f) => f.name.length > 0);
    if (named.length > 0) return named;
  }

  const titles: KeyFeature[] = [];
  for (const doc of specDocs) {
    for (const l of scanLines(doc.content)) {
      const m = l.headingText ? /^Requirement\s+\d+\s*:\s*(.+)$/i.exec(l.headingText) : null;
      if (m) titles.push({ name: m[1]!.trim(), description: null });
    }
  }
  return titles;
}

/**
 * Build Key_Feature slides: one per described feature, then a single summary
 * slide for name-only features, never exceeding `SLIDE_CONFIG.maxFeatureSlides`.
 *
 * @param features - Extracted Key_Features.
 * @returns Zero or more `"feature"` {@link Slide} objects.
 */
export function buildFeatureSlides(features: KeyFeature[]): Slide[] {
  const described = features.filter((f) => f.description !== null);
  const nameOnly = features.filter((f) => f.description === null);
  const slides = described
    .slice(0, SLIDE_CONFIG.maxFeatureSlides)
    .map((f) => makeSlide("feature", `Feature: ${f.name}`, f.description!));
  if (nameOnly.length > 0 && slides.length < SLIDE_CONFIG.maxFeatureSlides) {
    slides.push(makeSlide("feature", "Key features", nameOnly.map((f) => `• ${f.name}`).join("\n")));
  }
  return slides;
}

// ---------------------------------------------------------------------------
// Conclusion
// ---------------------------------------------------------------------------

/**
 * Build the conclusion slide.
 *
 * @param owner - Repository owner login.
 * @param repo - Repository name.
 * @param metadata - Repository metadata, or null.
 * @returns A `"conclusion"` {@link Slide} with name, URL, and — when
 *   available — stars, language, and license.
 */
export function buildConclusionSlide(owner: string, repo: string, metadata: RepoMetadata | null = null): Slide {
  const url = `https://github.com/${owner}/${repo}`;
  const lines = [`Repository: ${owner}/${repo}`, `URL: ${url}`];
  const facts: string[] = [];
  if (metadata?.stars !== null && metadata?.stars !== undefined) facts.push(`Stars: ${metadata.stars}`);
  if (metadata?.language) facts.push(`Language: ${metadata.language}`);
  if (metadata?.license) facts.push(`License: ${metadata.license}`);
  if (facts.length > 0) lines.push(facts.join(" · "));
  return makeSlide("conclusion", `Conclusion: ${repo}`, lines.join("\n"), `Explore ${repo} on GitHub: ${url}`);
}

// ---------------------------------------------------------------------------
// Act 6 — How has it evolved? (relevance)
// ---------------------------------------------------------------------------

/**
 * Words that never act as Anchor_Terms or relevance evidence: function words,
 * change verbs, and structural nouns that would make every change "relevant".
 * Algorithm data per design.md Stage 2, not a governed constant.
 */
export const GENERIC_TERMS: ReadonlySet<string> = new Set([
  // function words
  "with", "from", "that", "this", "into", "your", "using", "when", "what", "which",
  "they", "them", "then", "than", "have", "will", "also", "more", "each", "only",
  "some", "such", "other", "about", "over", "under", "after", "before", "where",
  // change verbs
  "added", "adds", "adding", "update", "updates", "updated", "change", "changes",
  "changed", "improve", "improves", "improved", "implement", "implements",
  "implemented", "implementation", "refactor", "refactored", "redesign",
  "redesigned", "support", "supports", "allow", "allows", "make", "makes",
  "remove", "removes", "removed", "rename", "renamed", "move", "moved",
  // structural nouns
  "feature", "features", "system", "user", "users", "architecture", "design",
  "overview", "usage", "works", "project", "repository", "component", "components",
  "interface", "interfaces", "properties", "strategy", "handling", "error",
  "errors", "testing", "test", "tests", "model", "models", "data", "constraints",
  "structure", "notes", "section", "details", "introduction", "summary",
  "getting", "started", "quick", "start", "install", "installation", "setup",
  "license", "contributing", "requirement", "requirements", "documentation",
]);

/**
 * English month names and common abbreviations treated as calendar noise (B5).
 * Algorithm data per design.md, not a governed constant.
 */
export const CALENDAR_TERMS: ReadonlySet<string> = new Set([
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
]);

/**
 * Decide whether a token is a Calendar_Term (B5, Req 7.22): a four-digit year
 * from 1900–2099, or an English month name/abbreviation. Mixed alphanumeric
 * tokens are never calendar terms because they are not pure digits or letters.
 *
 * @param token - A lowercase relevance token.
 * @returns True when the token is calendar noise.
 */
export function isCalendarTerm(token: string): boolean {
  if (/^(19|20)\d{2}$/.test(token)) return true;
  return CALENDAR_TERMS.has(token);
}

/**
 * Tokenize text into relevance terms.
 *
 * @param text - Any text.
 * @returns Lowercase alphanumeric tokens of at least
 *   `SLIDE_CONFIG.relevanceMinTermLength` characters, excluding
 *   {@link GENERIC_TERMS} and Calendar_Terms ({@link isCalendarTerm}).
 */
export function relevanceTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(
      (t) =>
        t.length >= SLIDE_CONFIG.relevanceMinTermLength &&
        !GENERIC_TERMS.has(t) &&
        !isCalendarTerm(t),
    );
}

/**
 * Build the Anchor_Term set from current-state content only.
 *
 * @param capabilities - Extracted Capabilities.
 * @param featureNames - Extracted Key_Feature names.
 * @param howItWorksHeadings - Headings from the how-it-works source.
 * @returns The Anchor_Term set.
 */
export function buildAnchorTerms(
  capabilities: string[],
  featureNames: string[],
  howItWorksHeadings: string[],
): Set<string> {
  return new Set([...capabilities, ...featureNames, ...howItWorksHeadings].flatMap(relevanceTokens));
}

/**
 * Decide whether text is a Relevant_Change.
 *
 * @param text - Title and/or Change_Context of a candidate.
 * @param anchors - Anchor_Term set.
 * @returns True when any token equals, or is a prefix of / prefixed by, an anchor.
 */
export function isRelevant(text: string, anchors: ReadonlySet<string>): boolean {
  if (anchors.size === 0) return false;
  return relevanceTokens(text).some((t) => {
    if (anchors.has(t)) return true;
    for (const a of anchors) if (a.startsWith(t) || t.startsWith(a)) return true;
    return false;
  });
}

/** Git trailer lines (`Co-authored-by:`, `Signed-off-by:`, `Fixes:` …). */
const TRAILER_RE = /^(?:[A-Za-z]+(?:-[A-Za-z]+)+|Fixes|Closes|Resolves|Refs?|Cc|Bug|Issue):\s+\S/i;

/**
 * Extract the Change_Context of a PR body, release notes, or commit body.
 *
 * Removes HTML comments, fenced code, task-list lines, headings, trailers,
 * issue-closing lines, and bold-only label lines; returns the first sentence
 * of the remaining text truncated to `SLIDE_CONFIG.changeContextMaxWords` words.
 *
 * @param text - Raw body text.
 * @returns The Change_Context, or null when nothing meaningful remains.
 */
export function extractChangeContext(text: string): string | null {
  const withoutComments = text.replace(/<!--[\s\S]*?-->/g, "");
  const kept: string[] = [];
  for (const l of scanLines(withoutComments)) {
    const t = l.text.trim();
    if (t === "" || l.inFence || l.headingLevel !== null) continue;
    if (/^[-*+]\s+\[[ xX]\]/.test(t)) continue;
    if (TRAILER_RE.test(t)) continue;
    if (/^(close[sd]?|fix(e[sd])?|resolve[sd]?)\s+#\d+\.?$/i.test(t)) continue;
    if (/^\*\*[^*]+\*\*:?$/.test(t)) continue;
    if (/^([-*_=]\s*){3,}$/.test(t)) continue;
    kept.push(t.replace(/^(?:[-*+]|\d+[.)])\s+/, "").replace(/^>\s?/, ""));
  }
  const sentence = firstSentences(toPlainText(kept.join(" ")), 1)[0];
  return sentence ? truncateToWords(sentence, SLIDE_CONFIG.changeContextMaxWords) : null;
}

/** A line that is only a URL (optionally an autolink `<url>`). */
const URL_ONLY_RE = /^<?https?:\/\/\S+>?$/i;

/** A single issue/PR reference token: `#12`, `owner/repo#12`, or `GH-12`. */
const REFERENCE_TOKEN = "(?:[A-Za-z0-9_.\\/-]*#\\d+|GH-\\d+)";

/** A line that is only one or more issue/PR references (comma/space separated). */
const REFERENCE_ONLY_RE = new RegExp(`^${REFERENCE_TOKEN}(?:[\\s,]+${REFERENCE_TOKEN})*$`);

/** An issue-closing line: a close/fix/resolve keyword followed only by URLs and/or references. */
const CLOSING_REFERENCE_RE = new RegExp(
  `^(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\b[:\\s]*` +
    `(?:https?:\\/\\/\\S+|<https?:\\/\\/[^>\\s]+>|${REFERENCE_TOKEN})` +
    `(?:[\\s,]+(?:https?:\\/\\/\\S+|<https?:\\/\\/[^>\\s]+>|${REFERENCE_TOKEN}))*\\.?$`,
  "i",
);

/** A line that is only a standalone commit hash (7–40 hex with a digit and an a–f letter). */
const HASH_ONLY_RE = /^(?=[0-9a-fA-F]*[0-9])(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{7,40}$/;

/**
 * Remove structural GitHub metadata lines from a Pull_Request body before
 * Change_Context extraction (B PR-sanitation, Req 7.26). Display-only: this is
 * never applied to the relevance Change_Context.
 *
 * Removes a line only when its sole meaningful content is a URL, an issue/PR
 * reference, an issue-closing clause (`Closes <URL>` / `Fixes #NN`), or a
 * standalone commit hash. Prose that embeds a URL, reference, or hash is left
 * untouched, and no sentence is reordered, scored, or rewritten.
 *
 * @param body - Raw Pull_Request body.
 * @returns The body with structural-metadata lines removed; other lines verbatim.
 */
export function cleanPullRequestBody(body: string): string {
  const out: string[] = [];
  for (const l of scanLines(body)) {
    if (l.inFence || l.headingLevel !== null) {
      out.push(l.text);
      continue;
    }
    const plain = toPlainText(l.text.trim().replace(/^>\s?/, ""));
    if (
      plain !== "" &&
      (URL_ONLY_RE.test(plain) ||
        REFERENCE_ONLY_RE.test(plain) ||
        CLOSING_REFERENCE_RE.test(plain) ||
        HASH_ONLY_RE.test(plain))
    ) {
      continue; // drop the structural-metadata line
    }
    out.push(l.text);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Act 6 — How has it evolved? (classification)
// ---------------------------------------------------------------------------

/** Rank order of Change_Categories (lower is more significant). */
const CATEGORY_RANK: Record<ChangeCategory, number> = {
  "Breaking Change": 0,
  Feature: 1,
  "Bug Fix": 2,
  Refactor: 3,
};

/** Conventional-commit prefix: `type(scope)!:`. */
const CONVENTIONAL_RE = /^(\w+)(?:\([^)]*\))?(!)?:/;

/**
 * Recognized conventional-commit types and their Change_Category. `perf` maps
 * to `Refactor` (B2b). The `!` breaking marker promotes only these recognized
 * types; an unknown type with `!` is not treated as Breaking (Req 7.2).
 */
const CONVENTIONAL_TYPE_CATEGORIES: Readonly<Record<string, ChangeCategory>> = {
  feat: "Feature",
  fix: "Bug Fix",
  refactor: "Refactor",
  perf: "Refactor",
};

/** Keyword → category mapping, used by earliest match in the title. */
const KEYWORD_CATEGORIES: ReadonlyArray<[string, ChangeCategory]> = [
  ["feat", "Feature"],
  ["add", "Feature"],
  ["implement", "Feature"],
  ["fix", "Bug Fix"],
  ["refactor", "Refactor"],
  ["redesign", "Refactor"],
];

/**
 * Assign a Change_Category from a title or commit subject (Req 7.2, prefix + keywords).
 *
 * @param title - PR title or commit subject.
 * @returns The category, or null when none applies.
 */
export function categoryFromTitle(title: string): ChangeCategory | null {
  const conv = CONVENTIONAL_RE.exec(title);
  if (conv) {
    const type = conv[1]!.toLowerCase();
    const category = CONVENTIONAL_TYPE_CATEGORIES[type];
    if (category) {
      // The `!` breaking marker promotes only a recognized conventional type;
      // an unknown `type!:` falls through to keyword matching (B2b, Req 7.2).
      return conv[2] === "!" ? "Breaking Change" : category;
    }
  }
  const lower = title.toLowerCase();
  let best: { index: number; category: ChangeCategory } | null = null;
  for (const [keyword, category] of KEYWORD_CATEGORIES) {
    const index = lower.indexOf(keyword);
    if (index !== -1 && (best === null || index < best.index)) best = { index, category };
  }
  return best?.category ?? null;
}

/**
 * Assign a Change_Category to a pull request: labels, then prefix, then keywords.
 *
 * @param pr - A pull request.
 * @returns The category, or null when none applies.
 */
export function categorizePullRequest(pr: PullRequest): ChangeCategory | null {
  const labels = new Set(pr.labels);
  if (labels.has("breaking-change") || labels.has("breaking")) return "Breaking Change";
  if (labels.has("feature") || labels.has("enhancement")) return "Feature";
  if (labels.has("bug")) return "Bug Fix";
  if (labels.has("refactor") || labels.has("performance") || labels.has("perf")) return "Refactor";
  return categoryFromTitle(pr.title);
}

/** Non-significant conventional-commit types. */
const MAINTENANCE_TYPE_RE = /^(chore|docs|ci|style|test|build)(\([^)]*\))?!?:/i;

/** Dependency / version-bump wording. */
const DEPENDENCY_WORD_RE = /\b(bump|deps|dependency|dependencies)\b/i;

/** A Significant_PR with its derived attributes. */
export interface RankedPullRequest {
  /** The pull request. */
  pr: PullRequest;
  /** Assigned Change_Category. */
  category: ChangeCategory;
  /** Change_Context of the body, or null. Used for relevance, ranking, timeline — never display. */
  context: string | null;
  /**
   * PR_Display_Context: Change_Context after PR-specific structural cleanup
   * ({@link cleanPullRequestBody}), used only for the deep-dive slide body
   * (Req 7.26). Equals {@link RankedPullRequest.context} for clean bodies.
   */
  displayContext: string | null;
}

/**
 * Select Significant_PRs (Req 7.1) and rank them (Req 7.3).
 *
 * @param pullRequests - Merged pull requests.
 * @returns Ranked significant pull requests.
 */
export function rankSignificantPullRequests(pullRequests: PullRequest[]): RankedPullRequest[] {
  const ranked: RankedPullRequest[] = [];
  for (const pr of pullRequests) {
    if (pr.isBot || MAINTENANCE_TYPE_RE.test(pr.title) || DEPENDENCY_WORD_RE.test(pr.title)) continue;
    const category = categorizePullRequest(pr);
    if (!category) continue;
    ranked.push({
      pr,
      category,
      context: extractChangeContext(pr.body),
      displayContext: extractChangeContext(cleanPullRequestBody(pr.body)),
    });
  }
  return ranked.sort(
    (a, b) =>
      CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category] ||
      (a.pr.mergedAt < b.pr.mergedAt ? 1 : a.pr.mergedAt > b.pr.mergedAt ? -1 : 0),
  );
}

/** A parsed semantic version core with optional prerelease/build. */
export interface SemanticVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
  build: string | null;
}

/**
 * SemVer core/prerelease/build, anchored, applied after the tag-boundary strip.
 * Numeric identifiers reject leading zeros; prerelease identifiers are
 * unrestricted ASCII alphanumerics/hyphens (no label vocabulary).
 */
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/**
 * Tag boundaries where a version core may begin, each requiring a following
 * digit so the boundary never consumes a version's own prerelease hyphen:
 *   - the start of the tag, optionally with `v`/`V`;
 *   - a `/`, `@`, or `_` separator, optionally with `v`/`V`;
 *   - any `-`, `_`, `/`, `@` separator that is followed by `v`/`V`.
 * A bare `-` separator is deliberately not a boundary: it cannot be told apart
 * from a prerelease hyphen, so `node-1.2.3-compat` is rejected while
 * `release-v1.2.3` (the `-` is followed by `v`) is accepted.
 */
const TAG_BOUNDARY_RE = /(?:^[vV]?|[/@_][vV]?|[-_/@][vV])(?=\d)/g;

/**
 * Parse a release tag into a Semantic_Version_Tag (B1, Req 7.19).
 *
 * Tries each permitted version boundary (start of tag, or after `-`, `_`, `/`,
 * `@`, with an optional `v`/`V`) and validates the complete SemVer
 * core/prerelease/build anchored to the end of the tag, with no trailing text
 * and no prerelease-label allowlist.
 *
 * @param tag - A release tag.
 * @returns The parsed {@link SemanticVersion}, or null when the tag is not a
 *   Semantic_Version_Tag.
 */
export function parseSemanticVersionTag(tag: string): SemanticVersion | null {
  const trimmed = tag.trim();
  for (const boundary of trimmed.matchAll(TAG_BOUNDARY_RE)) {
    const candidate = trimmed.slice(boundary.index + boundary[0].length);
    const m = SEMVER_RE.exec(candidate);
    if (m) {
      return {
        major: Number(m[1]),
        minor: Number(m[2]),
        patch: Number(m[3]),
        prerelease: m[4] ?? null,
        build: m[5] ?? null,
      };
    }
  }
  return null;
}

/**
 * Decide whether a release is a Patch_Release: its tag is a
 * Semantic_Version_Tag whose core patch component is greater than 0 (B1).
 * Prerelease and build suffixes do not affect the decision.
 *
 * @param release - A release.
 * @returns True for patch releases.
 */
export function isPatchRelease(release: Release): boolean {
  const parsed = parseSemanticVersionTag(release.tagName);
  return parsed !== null && parsed.patch > 0;
}

/** Release-note sections whose bodies are maintenance noise (B2). */
const RELEASE_NOISE_SECTIONS = new Set(["new contributors", "contributors", "full changelog", "checksums"]);

/**
 * Remove maintenance noise from release notes before Change_Context extraction
 * (B2, Req 7.20): drops changelog/contributor sections, converts Markdown links
 * to their text, and strips URLs, generated attributions, standalone commit
 * hashes, and parenthesized issue/PR reference lists. Prose is preferred; when
 * only list items remain, the first cleaned item is kept.
 *
 * @param body - Raw release notes.
 * @returns Cleaned text suitable for {@link extractChangeContext}; "" when
 *   nothing meaningful remains.
 */
export function cleanReleaseNotes(body: string): string {
  const prose: string[] = [];
  const items: string[] = [];
  let skipUntilLevel: number | null = null;

  for (const l of scanLines(body)) {
    if (l.headingLevel !== null) {
      if (skipUntilLevel !== null && l.headingLevel <= skipUntilLevel) skipUntilLevel = null;
      const key = headingKey(l.headingText ?? "").toLowerCase();
      if (skipUntilLevel === null && RELEASE_NOISE_SECTIONS.has(key)) skipUntilLevel = l.headingLevel;
      continue;
    }
    if (skipUntilLevel !== null || l.inFence) continue;
    const t = l.text.trim();
    if (t === "") continue;
    if (/^full changelog\b/i.test(toPlainText(t))) continue;

    const isItem = LIST_ITEM_RE.test(l.text);
    const cleaned = cleanReleaseLine(l.text);
    if (!cleaned) continue;
    if (isItem) items.push(cleaned);
    else prose.push(cleaned);
  }

  if (prose.length > 0) return prose.join(" ");
  return items.length > 0 ? items[0]! : "";
}

/** Remove link/url/hash/reference noise from one release-note line (B2). */
function cleanReleaseLine(raw: string): string {
  let t = raw.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/^>\s?/, "");
  // Markdown + reference links → their text.
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");
  // Generated attribution: "by @login" with optional "in <url-or-#ref>".
  t = t.replace(/\bby\s+@[A-Za-z0-9-]+(?:\s+in\s+\S+)?\s*$/i, "");
  // Autolinks and bare URLs, with an immediately preceding in/at/see/via.
  t = t.replace(/\b(?:in|at|see|via)\s+<https?:\/\/[^>\s]+>/gi, "").replace(/<https?:\/\/[^>\s]+>/g, "");
  t = t.replace(/\b(?:in|at|see|via)\s+https?:\/\/\S+/gi, "").replace(/https?:\/\/\S+/g, "");
  // Standalone commit hashes (7–40 hex with at least one digit and one a–f letter).
  const HASH = "(?=[0-9a-fA-F]*[0-9])(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{7,40}";
  t = t.replace(new RegExp("`" + HASH + "`", "g"), ""); // backticked
  t = t.replace(new RegExp("\\(" + HASH + "\\)", "g"), ""); // parenthesized
  t = t.replace(new RegExp("(?<![0-9A-Za-z])" + HASH + "(?![0-9A-Za-z])", "g"), ""); // bare word
  // Parenthesized reference lists: (#12), (#12, #13), (owner/repo#12), (GH-12).
  t = t.replace(/\((?:[A-Za-z0-9_./-]*#\d+|GH-\d+)(?:\s*,\s*(?:[A-Za-z0-9_./-]*#\d+|GH-\d+))*\)/g, "");
  // Tidy leftovers.
  t = t.replace(/\(\s*\)|\[\s*\]/g, "").replace(/\s{2,}/g, " ").replace(/^[\s,:–—-]+|[\s,:–—-]+$/g, "").trim();
  return /[A-Za-z]/.test(t) ? t : "";
}

/** Display title of a release, with Emoji_Shortcodes removed before the tag fallback. */
function releaseTitle(release: Release): string {
  const name = stripEmojiShortcodes(release.name ?? "").trim();
  return name || release.tagName;
}

// ---------------------------------------------------------------------------
// Act 6 — How has it evolved? (Change_Groups, Req 7.15–7.18)
// ---------------------------------------------------------------------------

/** Result of walking parent links inside the fetched commit window. */
export interface WindowWalk {
  /** Window commits reached, including the start commit. */
  reached: Set<string>;
  /** False when the walk met a parent SHA outside the window (or started outside it). */
  complete: boolean;
}

/**
 * Walk parent links through commits in the window only.
 *
 * @param start - SHA to start from.
 * @param parentsOf - Window index `sha → parents`.
 * @returns The reached window commits and whether the ancestry was fully inside the window.
 */
export function walkWindow(start: string, parentsOf: ReadonlyMap<string, string[]>): WindowWalk {
  const reached = new Set<string>();
  let complete = true;
  const stack = [start];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (reached.has(sha)) continue;
    const parents = parentsOf.get(sha);
    if (parents === undefined) {
      complete = false;
      continue;
    }
    reached.add(sha);
    stack.push(...parents);
  }
  return { reached, complete };
}

/** Change_Groups and PR membership derived from the commit graph alone. */
export interface ChangeGroups {
  /** Partition of every window commit into a group id (one group per commit). */
  groupOf: Map<string, string>;
  /** Window commits with two or more parents. */
  mergeCommits: Set<string>;
  /** Merge commits whose first-parent ancestry leaves the window. */
  truncatedMerges: Set<string>;
  /** Graph-proven member commits per PR number (PRs with a known merge commit only). */
  prMembers: Map<number, Set<string>>;
}

/**
 * Build Change_Groups from commit parents and PR merge commits (design Stage 3b).
 *
 * Never reads commit messages, dates, or listing order. A merge commit's group
 * contains its branch commits only when its first-parent ancestry is fully
 * inside the window; otherwise it contains the merge commit alone. Nested
 * merges are processed descendants-first, using reachable-commit counts
 * (a descendant always reaches strictly more), with SHA as a deterministic
 * tie-break; a commit keeps its first assignment.
 *
 * @param commits - The fetched commit window.
 * @param pullRequests - Merged pull requests.
 * @returns The {@link ChangeGroups}.
 */
export function buildChangeGroups(commits: Commit[], pullRequests: PullRequest[]): ChangeGroups {
  const parentsOf = new Map(commits.map((c) => [c.sha, c.parents]));
  const mergeCommits = new Set(commits.filter((c) => c.parents.length >= 2).map((c) => c.sha));
  const truncatedMerges = new Set<string>();
  const ownMembers = new Map<string, Set<string>>();

  for (const m of mergeCommits) {
    const parents = parentsOf.get(m)!;
    const first = walkWindow(parents[0]!, parentsOf);
    const members = new Set<string>([m]);
    if (first.complete) {
      for (const sha of walkWindow(parents[1]!, parentsOf).reached) {
        if (!first.reached.has(sha)) members.add(sha);
      }
    } else {
      truncatedMerges.add(m);
    }
    ownMembers.set(m, members);
  }

  const reachCount = new Map([...mergeCommits].map((m) => [m, walkWindow(m, parentsOf).reached.size]));
  const order = [...mergeCommits].sort(
    (a, b) => reachCount.get(b)! - reachCount.get(a)! || (a < b ? -1 : a > b ? 1 : 0),
  );
  const groupOf = new Map<string, string>();
  for (const m of order) {
    if (groupOf.has(m)) continue;
    for (const sha of ownMembers.get(m)!) if (!groupOf.has(sha)) groupOf.set(sha, m);
  }
  for (const c of commits) if (!groupOf.has(c.sha)) groupOf.set(c.sha, c.sha);

  const prMembers = new Map<number, Set<string>>();
  for (const pr of pullRequests) {
    const sha = pr.mergeCommitSha;
    if (!sha || !parentsOf.has(sha)) continue;
    prMembers.set(pr.number, ownMembers.get(sha) ?? new Set([sha]));
  }
  return { groupOf, mergeCommits, truncatedMerges, prMembers };
}

/** Conventional `feat` type, the only commits allowed in the empty-anchor fallback. */
const FEAT_COMMIT_RE = /^feat(\([^)]*\))?!?:/i;

/** Conventional `docs` type (`docs:`, `docs(scope):`, `docs!:`, `docs(scope)!:`), case-insensitive. */
const DOCS_COMMIT_RE = /^\s*docs(\([^)]*\))?!?:/i;

/**
 * Decide whether a commit subject is documentation-only (B3, Req 7.21).
 *
 * @param subject - A commit subject line.
 * @returns True for the conventional `docs` type at the start of the subject.
 */
export function isDocsCommit(subject: string): boolean {
  return DOCS_COMMIT_RE.test(subject);
}

/** Keyword pattern for relevance-path Engineering_Highlights (Req 7.9). */
const HIGHLIGHT_RE = /feat|fix|refactor|perf|add|implement|redesign/i;

/**
 * Select Engineering_Highlight commits.
 *
 * With Anchor_Terms: keyword match, category ≠ Bug Fix, relevant, up to
 * `SLIDE_CONFIG.maxHighlights`, commit order (Req 7.9). Without Anchor_Terms:
 * only conventional `feat` commits without dependency wording, most recent
 * first, up to `SLIDE_CONFIG.maxFallbackHighlights` (Req 7.14).
 * On both paths (Req 7.15): merge commits and `blocked` commits are never
 * candidates, and at most one commit per Change_Group is selected; the
 * fallback cap counts after this rule.
 *
 * @param commits - Commit history.
 * @param anchors - Anchor_Term set.
 * @param groups - Change_Groups from {@link buildChangeGroups}.
 * @param blocked - Commits belonging to Selected_PRs (graph members and exact evidence).
 * @returns Selected commits with their category and context.
 */
export function selectHighlightCommits(
  commits: Commit[],
  anchors: ReadonlySet<string>,
  groups: ChangeGroups,
  blocked: ReadonlySet<string>,
): { commit: Commit; category: ChangeCategory; context: string | null }[] {
  const usedGroups = new Set<string>();
  const take = (c: Commit): boolean => {
    if (groups.mergeCommits.has(c.sha) || blocked.has(c.sha)) return false;
    const g = groups.groupOf.get(c.sha) ?? c.sha;
    if (usedGroups.has(g)) return false;
    usedGroups.add(g);
    return true;
  };

  if (anchors.size === 0) {
    const out: { commit: Commit; category: ChangeCategory; context: string | null }[] = [];
    const ordered = [...commits]
      .filter((c) => FEAT_COMMIT_RE.test(c.subject))
      .filter((c) => !DEPENDENCY_WORD_RE.test(c.subject))
      .filter((c) => !isDocsCommit(c.subject))
      .sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
    for (const commit of ordered) {
      if (out.length >= SLIDE_CONFIG.maxFallbackHighlights) break;
      if (!take(commit)) continue;
      out.push({
        commit,
        category: categoryFromTitle(commit.subject) ?? "Feature",
        context: extractChangeContext(commit.body),
      });
    }
    return out;
  }

  const out: { commit: Commit; category: ChangeCategory; context: string | null }[] = [];
  for (const commit of commits) {
    if (isDocsCommit(commit.subject)) continue;
    if (!HIGHLIGHT_RE.test(commit.subject)) continue;
    const category = categoryFromTitle(commit.subject);
    if (!category || category === "Bug Fix") continue;
    const context = extractChangeContext(commit.body);
    if (!isRelevant(`${commit.subject} ${context ?? ""}`, anchors)) continue;
    if (!take(commit)) continue;
    out.push({ commit, category, context });
    if (out.length >= SLIDE_CONFIG.maxHighlights) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Act 6 — How has it evolved? (allocation)
// ---------------------------------------------------------------------------

/** One Evolution_Timeline line. */
interface TimelineEntry {
  date: string;
  label: string;
  title: string;
}

/** Evidence-independent evolution plan: timeline and Selected_PRs. */
interface EvolutionPlan {
  /** Timeline entries (oldest first), empty when below `minEvolutionItems`. */
  timeline: TimelineEntry[];
  /** Selected_PRs in rank order (Req 7.5). */
  deepDives: RankedPullRequest[];
  /** Non-patch releases, newest first. */
  milestoneReleases: Release[];
}

/**
 * Plan the timeline and choose Selected_PRs. Never reads PR_Commit_Evidence,
 * so the choice is identical with or without lookup results (Req 7.15).
 *
 * @param result - The analysis result.
 * @param anchors - Anchor_Term set.
 * @returns The {@link EvolutionPlan}.
 */
function planEvolution(result: RepoAnalysisResult, anchors: ReadonlySet<string>): EvolutionPlan {
  // Empty_Anchor_Evolution_Fallback (Req 7.23, 7.24): when no Anchor_Term exists,
  // the relevance test is unsatisfiable, so use the already-filtered Significant_PRs
  // directly. All upstream significance gates (bot, maintenance type, dependency,
  // category) and ranking are preserved by rankSignificantPullRequests. When
  // anchors exist, behavior is identical to before.
  const emptyAnchors = anchors.size === 0;
  const ranked = rankSignificantPullRequests(result.pullRequests);
  const relevantPrs = emptyAnchors
    ? ranked
    : ranked.filter((r) => isRelevant(`${r.pr.title} ${r.context ?? ""}`, anchors));
  const milestoneReleases = result.releases
    .filter((r) => !isPatchRelease(r))
    .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : 0));

  // Timeline: newest milestone releases first, then top relevant PRs; shown oldest → newest.
  // In the empty-anchor case only, a release entry carries its source-derived
  // Change_Context as "tag — context" (Req 7.25); anchored timelines are unchanged.
  const entries: TimelineEntry[] = [
    ...milestoneReleases.map((r): TimelineEntry => ({ date: r.publishedAt, label: "Release", title: timelineReleaseTitle(r, emptyAnchors) })),
    ...relevantPrs.map((r): TimelineEntry => ({ date: r.pr.mergedAt, label: r.category, title: r.pr.title })),
  ]
    .slice(0, SLIDE_CONFIG.maxEvolutionItems)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const timeline = entries.length >= SLIDE_CONFIG.minEvolutionItems ? entries : [];

  const slots = SLIDE_CONFIG.maxEvolutionSlides - (timeline.length > 0 ? 1 : 0);
  const deepDives = relevantPrs.filter((x) => x.category !== "Bug Fix").slice(0, Math.max(0, slots));
  return { timeline, deepDives, milestoneReleases };
}

/**
 * Timeline title for a release. In the empty-anchor case, appends the
 * source-derived Change_Context as `tag — context` when the existing
 * `cleanReleaseNotes`/`extractChangeContext` pipeline yields one (Req 7.25);
 * otherwise, and whenever anchors exist, returns the plain release title.
 *
 * @param release - A non-patch release.
 * @param emptyAnchors - True when no Anchor_Term exists.
 * @returns The timeline entry title.
 */
function timelineReleaseTitle(release: Release, emptyAnchors: boolean): string {
  const title = releaseTitle(release);
  if (!emptyAnchors) return title;
  const context = extractChangeContext(cleanReleaseNotes(release.body));
  return context ? `${title} — ${context}` : title;
}

/** Anchor_Terms exactly as {@link generateStoryboard} derives them (current-state content only). */
function anchorsForResult(result: RepoAnalysisResult): Set<string> {
  const capabilities = extractCapabilities(result.readmeText, result.specDocs);
  const features = extractKeyFeatures(result.readmeText, result.specDocs);
  const howItWorks = extractHowItWorks(result.readmeText, result.specDocs);
  return buildAnchorTerms(capabilities, features.map((f) => f.name), howItWorks?.headings ?? []);
}

/**
 * Choose the Selected_PRs (PRs that receive deep-dive slides). Pure and
 * evidence-independent; used by the storyboard pipeline before any lookup.
 *
 * @param result - The analysis result.
 * @returns Selected PR numbers in rank order.
 */
export function selectDeepDivePullRequests(result: RepoAnalysisResult): number[] {
  return planEvolution(result, anchorsForResult(result)).deepDives.map((r) => r.pr.number);
}

/**
 * Keep only Selected_PRs whose membership the graph can't prove: merge-commit
 * PRs whose merge commit is in the window but whose first-parent ancestry
 * leaves it. Squash, rebase, graph-proven merges, and PRs with an unknown
 * merge commit need no lookup (Req 2.11).
 *
 * @param result - The analysis result.
 * @param selected - Selected PR numbers.
 * @returns PR numbers that need exact evidence.
 */
export function prsNeedingEvidence(result: RepoAnalysisResult, selected: number[]): number[] {
  const groups = buildChangeGroups(result.commits, result.pullRequests);
  const bySha = new Map(result.pullRequests.map((p) => [p.number, p.mergeCommitSha]));
  return selected.filter((n) => {
    const sha = bySha.get(n);
    return typeof sha === "string" && groups.truncatedMerges.has(sha);
  });
}

/**
 * Allocate evolution slides within `SLIDE_CONFIG.maxEvolutionSlides`.
 *
 * Order: Evolution_Timeline (only with ≥ `minEvolutionItems` eligible entries),
 * PR deep dives (relevant, not Bug Fix), release deep dives (non-patch,
 * relevant notes), then Engineering_Highlights. Allocation stops when
 * candidates run out — the budget is a ceiling, never a target.
 *
 * @param result - The analysis result.
 * @param anchors - Anchor_Term set derived from current-state content.
 * @returns Evolution slides in storyboard order.
 */
export function buildEvolutionSlides(
  result: RepoAnalysisResult,
  anchors: ReadonlySet<string>,
  evidence: PrCommitEvidence = {},
): Slide[] {
  const slides: Slide[] = [];
  const plan = planEvolution(result, anchors);
  let remaining = SLIDE_CONFIG.maxEvolutionSlides;

  if (plan.timeline.length > 0) {
    slides.push(
      makeSlide(
        "evolution",
        "How it evolved",
        plan.timeline.map((e) => `${isoDate(e.date)} · ${e.label} · ${e.title}`).join("\n"),
      ),
    );
    remaining--;
  }

  // Selected_PR deep dives block their graph members and their exact evidence (Req 7.15).
  const groups = buildChangeGroups(result.commits, result.pullRequests);
  const windowShas = new Set(result.commits.map((c) => c.sha));
  const blocked = new Set<string>();
  for (const r of plan.deepDives) {
    // Display-only PR_Display_Context (Req 7.26); relevance/selection used r.context.
    const lines = [...(r.displayContext ? [r.displayContext, ""] : []), `Merged ${isoDate(r.pr.mergedAt)}`];
    slides.push(makeSlide("change", `${r.category} · ${r.pr.title} (#${r.pr.number})`, lines.join("\n")));
    for (const sha of groups.prMembers.get(r.pr.number) ?? []) blocked.add(sha);
    for (const sha of evidence[r.pr.number] ?? []) if (windowShas.has(sha)) blocked.add(sha);
    remaining--;
  }
  const { milestoneReleases } = plan;

  for (const release of milestoneReleases) {
    if (remaining <= 0) break;
    const context = extractChangeContext(cleanReleaseNotes(release.body));
    // Empty_Anchor_Evolution_Fallback (Req 7.23): with no anchors, a non-patch
    // release with a Change_Context is eligible; the relevance test is skipped.
    if (!context || !(anchors.size === 0 || isRelevant(`${releaseTitle(release)} ${context}`, anchors))) continue;
    slides.push(
      makeSlide(
        "change",
        `Release · ${releaseTitle(release)}`,
        [context, "", `Published ${isoDate(release.publishedAt)}`].join("\n"),
      ),
    );
    remaining--;
  }

  for (const h of selectHighlightCommits(result.commits, anchors, groups, blocked)) {
    if (remaining <= 0) break;
    const lines = [
      ...(h.context ? [h.context, ""] : []),
      `Author: ${h.commit.author}`,
      `Date: ${isoDate(h.commit.timestamp)}`,
    ];
    slides.push(makeSlide("highlight", `${h.category} · ${h.commit.subject}`, lines.join("\n")));
    remaining--;
  }

  return slides;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** Slide types in canonical storyboard order (Req 3.1). */
const TYPE_ORDER: readonly SlideType[] = [
  "intro",
  "capabilities",
  "run",
  "architecture",
  "howItWorks",
  "feature",
  "evolution",
  "change",
  "highlight",
  "conclusion",
];

/** Types removed, in this order, when a storyboard exceeds `maxSlides` (Req 3.4). */
const TRIM_ORDER: readonly SlideType[] = ["highlight", "change", "evolution", "feature"];

/**
 * Trim a storyboard to `SLIDE_CONFIG.maxSlides` by removing optional slides
 * from the end of each trimmable type, in {@link TRIM_ORDER}.
 *
 * @param slides - Ordered slides.
 * @returns The trimmed slides. Core slides are never removed.
 */
function trimToMax(slides: Slide[]): Slide[] {
  const out = [...slides];
  for (const type of TRIM_ORDER) {
    while (out.length > SLIDE_CONFIG.maxSlides) {
      const idx = out.map((s) => s.type).lastIndexOf(type);
      if (idx === -1) break;
      out.splice(idx, 1);
    }
  }
  return out;
}

/**
 * Generate an ordered storyboard from a repository analysis result.
 *
 * Order: overview → capabilities? → run? → architecture → how-it-works? →
 * features → evolution timeline? → notable changes → highlights → conclusion.
 * Current-state slides and Anchor_Terms use only README, metadata, specs, and
 * the tree; history is used only for evolution slides.
 *
 * @param result - The {@link RepoAnalysisResult} from the analyzer.
 * @param evidence - Optional PR_Commit_Evidence for Selected_PRs. It only adds
 *   suppression of duplicate commit highlights; without it the output equals
 *   graph-only grouping.
 * @returns An ordered array of {@link Slide} objects with UUID `id`s.
 * @throws {@link ApiError} With code `insufficient_content` if fewer than
 *   `SLIDE_CONFIG.minSlides` slides can be generated.
 */
export function generateStoryboard(result: RepoAnalysisResult, evidence: PrCommitEvidence = {}): Slide[] {
  const { owner, repo, readmeText, directoryTree, specDocs, metadata } = result;

  const capabilities = extractCapabilities(readmeText, specDocs);
  const features = extractKeyFeatures(readmeText, specDocs);
  const howItWorks = extractHowItWorks(readmeText, specDocs);
  const anchors = buildAnchorTerms(
    capabilities,
    features.map((f) => f.name),
    howItWorks?.headings ?? [],
  );

  const slides: Slide[] = [buildIntroSlide(repo, readmeText, metadata)];
  if (capabilities.length > 0 && !capabilitiesOverlapFeatures(capabilities, features)) {
    slides.push(buildCapabilitiesSlide(capabilities));
  }
  const run = buildRunSlide(readmeText);
  if (run) slides.push(run);
  slides.push(buildArchitectureSlide(repo, directoryTree));
  if (howItWorks) slides.push(buildHowItWorksSlide(howItWorks));
  slides.push(...buildFeatureSlides(features));
  slides.push(...buildEvolutionSlides(result, anchors, evidence));
  slides.push(buildConclusionSlide(owner, repo, metadata));

  const ordered = slides
    .map((s, i) => ({ s, i }))
    .sort((a, b) => TYPE_ORDER.indexOf(a.s.type) - TYPE_ORDER.indexOf(b.s.type) || a.i - b.i)
    .map((x) => x.s);
  const final = trimToMax(ordered);

  if (final.length < SLIDE_CONFIG.minSlides) {
    throw new ApiError(
      "insufficient_content",
      `Repository does not contain enough content to generate a storyboard (minimum ${SLIDE_CONFIG.minSlides} slides required, got ${final.length}).`,
    );
  }
  return final;
}
