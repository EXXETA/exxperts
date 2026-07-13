/**
 * Skills MR-1 import helpers (spec §3, §7 musts 1). Pure, node-free functions
 * shared by the import/review surfaces (MR-3/4) and, later, the `read_skill`
 * tool (MR-5). This module deliberately has ZERO node/server imports (only the
 * equally-pure consult-handoff grammar), so the web UI can bundle it directly.
 *
 * Nothing here executes a skill or touches the filesystem — these are the
 * text-level checks the trust-moment review screen runs on a candidate body.
 */

import { neutralizeBlockContent } from "./consult-handoff.js";

/**
 * A skill body is injected into the room as text. Beyond the two structural
 * forges the consult defang already closes (envelope-marker fences +
 * `**must-keep**` durability signal), a skill body can also carry a literal
 * `</skill>`-style tag closer that would terminate the `read_skill` provenance
 * wrapper (MR-5) early and let forged text escape the "adopted instructions, not
 * the room's own knowledge" framing. We break the bracket the same way the
 * consult defang breaks marker brackets: keep the words, remove `<`/`>` so the
 * token can no longer act as a real tag.
 */
const SKILL_TAG_LIKE = /<\s*\/?\s*skill\b[^>]*>/gi;

/**
 * Neutralize an untrusted skill body for injection. Reuses the consult defang
 * VERBATIM (via the exported `neutralizeBlockContent`, so there is one source of
 * truth for the marker + must-keep rules and consult behavior is unchanged) and
 * layers on the skill-tag-closer escape. Pure — safe to run in the browser.
 */
export function defangSkillBody(text: string): string {
	return neutralizeBlockContent(String(text ?? "")).replace(SKILL_TAG_LIKE, (tag) => tag.replace(/[<>]/g, ""));
}

export type InvisibleUnicodeCategory = "zero-width" | "bidi" | "invisible";

export interface InvisibleUnicodeFinding {
	/** UTF-16 code-unit offset of the character within the scanned string. */
	index: number;
	/** The offending code point (e.g. 0x200b). */
	codePoint: number;
	/** `U+200B`-style label for display. */
	label: string;
	category: InvisibleUnicodeCategory;
}

export interface InvisibleUnicodeScan {
	/** Total number of flagged characters. */
	count: number;
	findings: InvisibleUnicodeFinding[];
}

/**
 * Zero-width, bidi-control and other invisible/format characters that have no
 * business in a skill body and are the classic vehicle for hidden-instruction
 * poisoning (inspection §2.3). The review screen surfaces these; it does not
 * silently strip them, so the user sees exactly what they are adopting.
 */
const INVISIBLE_UNICODE: ReadonlyMap<number, InvisibleUnicodeCategory> = new Map([
	// Zero-width and format joiners.
	[0x00ad, "invisible"], // SOFT HYPHEN
	[0x180e, "zero-width"], // MONGOLIAN VOWEL SEPARATOR
	[0x200b, "zero-width"], // ZERO WIDTH SPACE
	[0x200c, "zero-width"], // ZERO WIDTH NON-JOINER
	[0x200d, "zero-width"], // ZERO WIDTH JOINER
	[0x2060, "zero-width"], // WORD JOINER
	[0x2061, "invisible"], // FUNCTION APPLICATION
	[0x2062, "invisible"], // INVISIBLE TIMES
	[0x2063, "invisible"], // INVISIBLE SEPARATOR
	[0x2064, "invisible"], // INVISIBLE PLUS
	[0xfeff, "zero-width"], // ZERO WIDTH NO-BREAK SPACE / BOM
	// Filler characters that render as blank.
	[0x115f, "invisible"], // HANGUL CHOSEONG FILLER
	[0x1160, "invisible"], // HANGUL JUNGSEONG FILLER
	[0x3164, "invisible"], // HANGUL FILLER
	[0xffa0, "invisible"], // HALFWIDTH HANGUL FILLER
	[0x2800, "invisible"], // BRAILLE PATTERN BLANK (renders empty)
	// Line/paragraph separators that act like invisible newlines.
	[0x2028, "invisible"], // LINE SEPARATOR
	[0x2029, "invisible"], // PARAGRAPH SEPARATOR
	// Interlinear annotation controls (hidden-text channel).
	[0xfff9, "invisible"], // INTERLINEAR ANNOTATION ANCHOR
	[0xfffa, "invisible"], // INTERLINEAR ANNOTATION SEPARATOR
	[0xfffb, "invisible"], // INTERLINEAR ANNOTATION TERMINATOR
	// Bidirectional control characters.
	[0x061c, "bidi"], // ARABIC LETTER MARK
	[0x200e, "bidi"], // LEFT-TO-RIGHT MARK
	[0x200f, "bidi"], // RIGHT-TO-LEFT MARK
	[0x202a, "bidi"], // LEFT-TO-RIGHT EMBEDDING
	[0x202b, "bidi"], // RIGHT-TO-LEFT EMBEDDING
	[0x202c, "bidi"], // POP DIRECTIONAL FORMATTING
	[0x202d, "bidi"], // LEFT-TO-RIGHT OVERRIDE
	[0x202e, "bidi"], // RIGHT-TO-LEFT OVERRIDE
	[0x2066, "bidi"], // LEFT-TO-RIGHT ISOLATE
	[0x2067, "bidi"], // RIGHT-TO-LEFT ISOLATE
	[0x2068, "bidi"], // FIRST STRONG ISOLATE
	[0x2069, "bidi"], // POP DIRECTIONAL ISOLATE
]);

/**
 * Range-based invisible/format code points that don't fit a flat lookup:
 * - Unicode Tag block (U+E0000–U+E007F): the classic instruction-smuggling channel.
 * - Variation Selectors (U+FE00–U+FE0F) and Variation Selectors Supplement
 *   (U+E0100–U+E01EF): the popular byte-in-an-emoji steganography channel — a
 *   long VS run encodes arbitrary hidden bytes and renders as nothing.
 */
function rangeInvisibleCategory(codePoint: number): InvisibleUnicodeCategory | undefined {
	if (codePoint >= 0xe0000 && codePoint <= 0xe007f) return "invisible"; // Tag block
	if (codePoint >= 0xfe00 && codePoint <= 0xfe0f) return "invisible"; // Variation Selectors
	if (codePoint >= 0xe0100 && codePoint <= 0xe01ef) return "invisible"; // Variation Selectors Supplement
	return undefined;
}

function labelFor(codePoint: number): string {
	return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * Scan a skill body for zero-width/bidi/invisible characters, returning each
 * flagged character's position, code point and category. Positions are UTF-16
 * code-unit offsets (what the review screen highlights against the raw text).
 */
export function scanInvisibleUnicode(text: string): InvisibleUnicodeScan {
	const findings: InvisibleUnicodeFinding[] = [];
	const source = String(text ?? "");
	for (let index = 0; index < source.length; ) {
		const codePoint = source.codePointAt(index)!;
		const wide = codePoint > 0xffff;
		const category = INVISIBLE_UNICODE.get(codePoint) ?? rangeInvisibleCategory(codePoint);
		if (category) findings.push({ index, codePoint, label: labelFor(codePoint), category });
		index += wide ? 2 : 1;
	}
	return { count: findings.length, findings };
}

/**
 * Import-from-repo discovery filter (spec §3): the Pi loader's discovery rules
 * MINUS the root-`.md`-as-skill rule (`runtime/packages/agent/src/harness/skills.ts:133`).
 * Only a file named exactly `SKILL.md`, and not under a dotdir or `node_modules`
 * (dirs the loader also skips), counts — so a repo's README/docs are never
 * mistaken for skills (inspection §2.1 caveat).
 */
export function isSkillManifestPath(relPath: string): boolean {
	const parts = String(relPath ?? "")
		.split(/[\\/]+/)
		.filter(Boolean);
	if (parts.length === 0) return false;
	if (parts[parts.length - 1] !== "SKILL.md") return false;
	return !parts.slice(0, -1).some((segment) => segment === "node_modules" || segment.startsWith("."));
}

/** Keep only the true `SKILL.md` manifests from a repo file listing (see `isSkillManifestPath`). */
export function filterRepoScanSkillFiles(relPaths: readonly string[]): string[] {
	return relPaths.filter(isSkillManifestPath);
}
