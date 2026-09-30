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

/** Heading text with leading emoji/punctuation and trailing colon removed, for matching. */
function headingKey(heading: string): string {
  return heading.replace(/^[^A-Za-z0-9]+/, "").replace(/[:\s]+$/, "");
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
 * @returns A {@link Slide} with a new UUID and HTML-escaped `title`, `body`,
 *   and `previewSummary` (capped at `SLIDE_CONFIG.previewMaxWords` words).
 */
function makeSlide(type: SlideType, title: string, body: string, preview?: string): Slide {
  const plainPreview = (preview ?? body).replace(/^[•\s]+/gm, "").replace(/\s+/g, " ");
  return {
    id: randomUUID(),
    type,
    title: htmlEscape(title),
    body: htmlEscape(body),
    previewSummary: htmlEscape(truncateToWords(plainPreview, SLIDE_CONFIG.previewMaxWords)),
  };
}

// ---------------------------------------------------------------------------
// Act 1 — What is this repository?
// ---------------------------------------------------------------------------

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
  let paragraph = readmeText
    ? truncateToWords(firstParagraph(readmeText), SLIDE_CONFIG.introMaxWords)
    : "";
  if (paragraph && description && normalize(paragraph) === normalize(description)) {
    paragraph = "";
  }

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

/** A spec user story: `As a …, I want …, so that …`. */
const USER_STORY_RE = /\bas an? [^,]+,\s*I want (?:to )?(.+?)(?:,?\s+so that\b.*)?$/i;

/**
 * Extract Capabilities: README capabilities section first, spec user stories second.
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
        if (m) raw.push(capitalize(m[1]!.trim().replace(/[.,;]+$/, "")));
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
 * @param capabilities - Extracted Capabilities (non-empty).
 * @returns A `"capabilities"` {@link Slide}.
 */
export function buildCapabilitiesSlide(capabilities: string[]): Slide {
  return makeSlide("capabilities", "What you can do", capabilities.map((c) => `• ${c}`).join("\n"));
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

/** README headings that introduce run instructions. */
const RUN_HEADING_RE = /^(installation|getting started|setup|usage|quick start)\b/i;

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

  const rawSteps =
    sawFence && codeLines.some((s) => s.trim().length > 0)
      ? codeLines.filter((s) => s.trim().length > 0)
      : section.lines
          .filter((l) => !l.inFence && l.text.trim().length > 0)
          .map((l) => l.text.trim());

  const steps = rawSteps
    .slice(0, SLIDE_CONFIG.runMaxSteps)
    .map((s) => truncateToWords(s, SLIDE_CONFIG.runMaxWordsPerStep));
  if (steps.length === 0) return null;

  return makeSlide("run", `How to run: ${section.heading}`, steps.join("\n"));
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
 * Tokenize text into relevance terms.
 *
 * @param text - Any text.
 * @returns Lowercase alphanumeric tokens of at least
 *   `SLIDE_CONFIG.relevanceMinTermLength` characters, excluding {@link GENERIC_TERMS}.
 */
export function relevanceTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= SLIDE_CONFIG.relevanceMinTermLength && !GENERIC_TERMS.has(t));
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
    if (conv[2] === "!") return "Breaking Change";
    const type = conv[1]!.toLowerCase();
    if (type === "feat") return "Feature";
    if (type === "fix") return "Bug Fix";
    if (type === "refactor") return "Refactor";
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
  if (labels.has("refactor")) return "Refactor";
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
  /** Change_Context of the body, or null. */
  context: string | null;
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
    ranked.push({ pr, category, context: extractChangeContext(pr.body) });
  }
  return ranked.sort(
    (a, b) =>
      CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category] ||
      (a.pr.mergedAt < b.pr.mergedAt ? 1 : a.pr.mergedAt > b.pr.mergedAt ? -1 : 0),
  );
}

/**
 * Decide whether a release is a Patch_Release (`X.Y.Z` / `vX.Y.Z`, Z > 0).
 *
 * @param release - A release.
 * @returns True for patch releases.
 */
export function isPatchRelease(release: Release): boolean {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(release.tagName);
  return m !== null && Number(m[3]) > 0;
}

/** Display title of a release. */
function releaseTitle(release: Release): string {
  return release.name?.trim() || release.tagName;
}

/** PR numbers referenced by a commit subject (`(#N)` or `Merge pull request #N`). */
function referencedPullRequests(subject: string): number[] {
  const refs: number[] = [];
  for (const m of subject.matchAll(/\(#(\d+)\)/g)) refs.push(Number(m[1]));
  const merge = /^Merge pull request #(\d+)/i.exec(subject);
  if (merge) refs.push(Number(merge[1]));
  return refs;
}

/** Conventional `feat` type, the only commits allowed in the empty-anchor fallback. */
const FEAT_COMMIT_RE = /^feat(\([^)]*\))?!?:/i;

/** Keyword pattern for relevance-path Engineering_Highlights (Req 7.9). */
const HIGHLIGHT_RE = /feat|fix|refactor|add|implement|redesign/i;

/**
 * Select Engineering_Highlight commits.
 *
 * With Anchor_Terms: keyword match, category ≠ Bug Fix, relevant, not a
 * presented-PR reference, up to `SLIDE_CONFIG.maxHighlights`, commit order
 * (Req 7.9). Without Anchor_Terms: only conventional `feat` commits without
 * dependency wording, most recent first, up to
 * `SLIDE_CONFIG.maxFallbackHighlights` (Req 7.14).
 *
 * @param commits - Commit history.
 * @param anchors - Anchor_Term set.
 * @param presentedPrNumbers - PR numbers already shown in the storyboard.
 * @returns Selected commits with their category and context.
 */
export function selectHighlightCommits(
  commits: Commit[],
  anchors: ReadonlySet<string>,
  presentedPrNumbers: ReadonlySet<number>,
): { commit: Commit; category: ChangeCategory; context: string | null }[] {
  const notPresented = (c: Commit): boolean =>
    !referencedPullRequests(c.subject).some((n) => presentedPrNumbers.has(n));

  if (anchors.size === 0) {
    return [...commits]
      .filter((c) => FEAT_COMMIT_RE.test(c.subject))
      .filter((c) => !DEPENDENCY_WORD_RE.test(c.subject))
      .filter(notPresented)
      .sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0))
      .slice(0, SLIDE_CONFIG.maxFallbackHighlights)
      .map((commit) => ({
        commit,
        category: categoryFromTitle(commit.subject) ?? "Feature",
        context: extractChangeContext(commit.body),
      }));
  }

  const out: { commit: Commit; category: ChangeCategory; context: string | null }[] = [];
  for (const commit of commits) {
    if (!HIGHLIGHT_RE.test(commit.subject) || !notPresented(commit)) continue;
    const category = categoryFromTitle(commit.subject);
    if (!category || category === "Bug Fix") continue;
    const context = extractChangeContext(commit.body);
    if (!isRelevant(`${commit.subject} ${context ?? ""}`, anchors)) continue;
    out.push({ commit, category, context });
    if (out.length >= SLIDE_CONFIG.maxHighlights) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Act 6 — How has it evolved? (allocation)
// ---------------------------------------------------------------------------

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
export function buildEvolutionSlides(result: RepoAnalysisResult, anchors: ReadonlySet<string>): Slide[] {
  const slides: Slide[] = [];
  let remaining = SLIDE_CONFIG.maxEvolutionSlides;
  const presented = new Set<number>();

  const ranked = rankSignificantPullRequests(result.pullRequests);
  const relevantPrs = ranked.filter((r) => isRelevant(`${r.pr.title} ${r.context ?? ""}`, anchors));
  const milestoneReleases = result.releases
    .filter((r) => !isPatchRelease(r))
    .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : 0));

  // Timeline: newest milestone releases first, then top relevant PRs; shown oldest → newest.
  type Entry = { date: string; label: string; title: string; prNumber?: number };
  const entries: Entry[] = [
    ...milestoneReleases.map((r): Entry => ({ date: r.publishedAt, label: "Release", title: releaseTitle(r) })),
    ...relevantPrs.map((r): Entry => ({ date: r.pr.mergedAt, label: r.category, title: r.pr.title, prNumber: r.pr.number })),
  ]
    .slice(0, SLIDE_CONFIG.maxEvolutionItems)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  if (entries.length >= SLIDE_CONFIG.minEvolutionItems && remaining > 0) {
    slides.push(
      makeSlide(
        "evolution",
        "How it evolved",
        entries.map((e) => `${isoDate(e.date)} · ${e.label} · ${e.title}`).join("\n"),
      ),
    );
    for (const e of entries) if (e.prNumber !== undefined) presented.add(e.prNumber);
    remaining--;
  }

  for (const r of relevantPrs.filter((x) => x.category !== "Bug Fix")) {
    if (remaining <= 0) break;
    const lines = [...(r.context ? [r.context, ""] : []), `Merged ${isoDate(r.pr.mergedAt)}`];
    slides.push(makeSlide("change", `${r.category} · ${r.pr.title} (#${r.pr.number})`, lines.join("\n")));
    presented.add(r.pr.number);
    remaining--;
  }

  for (const release of milestoneReleases) {
    if (remaining <= 0) break;
    const context = extractChangeContext(release.body);
    if (!context || !isRelevant(`${releaseTitle(release)} ${context}`, anchors)) continue;
    slides.push(
      makeSlide(
        "change",
        `Release · ${releaseTitle(release)}`,
        [context, "", `Published ${isoDate(release.publishedAt)}`].join("\n"),
      ),
    );
    remaining--;
  }

  for (const h of selectHighlightCommits(result.commits, anchors, presented)) {
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
 * @returns An ordered array of {@link Slide} objects with UUID `id`s.
 * @throws {@link ApiError} With code `insufficient_content` if fewer than
 *   `SLIDE_CONFIG.minSlides` slides can be generated.
 */
export function generateStoryboard(result: RepoAnalysisResult): Slide[] {
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
  slides.push(...buildEvolutionSlides(result, anchors));
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
