/**
 * Skills MR-1 import helpers (spec §3, §7 musts 1). Pure, node-free functions
 * shared by the import/review surfaces (MR-3/4) and, later, the `read_skill`
 * tool (MR-5). This module deliberately has ZERO node/server imports (only the
 * equally-pure consult-handoff grammar and the page's words for a skill's size
 * and kinds), so the web UI can bundle it directly.
 *
 * Nothing here executes a skill or touches the filesystem — these are the
 * text-level checks the trust-moment review screen runs on a candidate body.
 */

import { neutralizeBlockContent } from "./consult-handoff.js";
import { SKILL_LIMITS, skillTooBigLine, type SkillFileKind, type SkillTooBig } from "../../web-ui/src/skill-source-copy.js";

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
 *   long VS run encodes arbitrary hidden bytes and renders as nothing. One U+FE0E
 *   or U+FE0F in a sequence Unicode defines, as in "⚠️", is ordinary text and
 *   `scanInvisibleUnicode` leaves it out (`isOrdinaryVariationSelector`).
 */
function rangeInvisibleCategory(codePoint: number): InvisibleUnicodeCategory | undefined {
	if (codePoint >= 0xe0000 && codePoint <= 0xe007f) return "invisible"; // Tag block
	if (isVariationSelector(codePoint)) return "invisible";
	return undefined;
}

/** Variation Selectors (U+FE00–U+FE0F) and their Supplement (U+E0100–U+E01EF). */
function isVariationSelector(codePoint: number): boolean {
	return (codePoint >= 0xfe00 && codePoint <= 0xfe0f) || (codePoint >= 0xe0100 && codePoint <= 0xe01ef);
}

/**
 * The characters Unicode gives a text and an emoji style, each as a [first, last] range:
 * every base of emoji-variation-sequences.txt, Unicode 18.0.0 (371 code points). A base a
 * later version adds is reported until this table is copied again.
 */
const VARIATION_BASES: ReadonlyArray<readonly [number, number]> = [
	[0x0023, 0x0023], [0x002a, 0x002a], [0x0030, 0x0039], [0x00a9, 0x00a9], [0x00ae, 0x00ae], [0x203c, 0x203c],
	[0x2049, 0x2049], [0x2122, 0x2122], [0x2139, 0x2139], [0x2194, 0x2199], [0x21a9, 0x21aa], [0x231a, 0x231b],
	[0x2328, 0x2328], [0x23cf, 0x23cf], [0x23e9, 0x23f3], [0x23f8, 0x23fa], [0x24c2, 0x24c2], [0x25aa, 0x25ab],
	[0x25b6, 0x25b6], [0x25c0, 0x25c0], [0x25fb, 0x25fe], [0x2600, 0x2604], [0x260e, 0x260e], [0x2611, 0x2611],
	[0x2614, 0x2615], [0x2618, 0x2618], [0x261d, 0x261d], [0x2620, 0x2620], [0x2622, 0x2623], [0x2626, 0x2626],
	[0x262a, 0x262a], [0x262e, 0x262f], [0x2638, 0x263a], [0x2640, 0x2640], [0x2642, 0x2642], [0x2648, 0x2653],
	[0x265f, 0x2660], [0x2663, 0x2663], [0x2665, 0x2666], [0x2668, 0x2668], [0x267b, 0x267b], [0x267e, 0x267f],
	[0x2692, 0x2697], [0x2699, 0x2699], [0x269b, 0x269c], [0x26a0, 0x26a1], [0x26a7, 0x26a7], [0x26aa, 0x26ab],
	[0x26b0, 0x26b1], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26c8, 0x26c8], [0x26ce, 0x26cf], [0x26d1, 0x26d1],
	[0x26d3, 0x26d4], [0x26e9, 0x26ea], [0x26f0, 0x26f5], [0x26f7, 0x26fa], [0x26fd, 0x26fd], [0x2702, 0x2702],
	[0x2705, 0x2705], [0x2708, 0x270d], [0x270f, 0x270f], [0x2712, 0x2712], [0x2714, 0x2714], [0x2716, 0x2716],
	[0x271d, 0x271d], [0x2721, 0x2721], [0x2728, 0x2728], [0x2733, 0x2734], [0x2744, 0x2744], [0x2747, 0x2747],
	[0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2763, 0x2764], [0x2795, 0x2797],
	[0x27a1, 0x27a1], [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2934, 0x2935], [0x2b05, 0x2b07], [0x2b1b, 0x2b1c],
	[0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x3030, 0x3030], [0x303d, 0x303d], [0x3297, 0x3297], [0x3299, 0x3299],
	[0x1f004, 0x1f004], [0x1f170, 0x1f171], [0x1f17e, 0x1f17f], [0x1f202, 0x1f202], [0x1f21a, 0x1f21a],
	[0x1f22f, 0x1f22f], [0x1f237, 0x1f237], [0x1f30d, 0x1f30f], [0x1f315, 0x1f315], [0x1f31c, 0x1f31c],
	[0x1f321, 0x1f321], [0x1f324, 0x1f32c], [0x1f336, 0x1f336], [0x1f378, 0x1f378], [0x1f37d, 0x1f37d],
	[0x1f393, 0x1f393], [0x1f396, 0x1f397], [0x1f399, 0x1f39b], [0x1f39e, 0x1f39f], [0x1f3a7, 0x1f3a7],
	[0x1f3ac, 0x1f3ae], [0x1f3c2, 0x1f3c2], [0x1f3c4, 0x1f3c4], [0x1f3c6, 0x1f3c6], [0x1f3ca, 0x1f3ce],
	[0x1f3d4, 0x1f3e0], [0x1f3ed, 0x1f3ed], [0x1f3f3, 0x1f3f3], [0x1f3f5, 0x1f3f5], [0x1f3f7, 0x1f3f7],
	[0x1f408, 0x1f408], [0x1f415, 0x1f415], [0x1f41f, 0x1f41f], [0x1f426, 0x1f426], [0x1f43f, 0x1f43f],
	[0x1f441, 0x1f442], [0x1f446, 0x1f449], [0x1f44d, 0x1f44e], [0x1f453, 0x1f453], [0x1f46a, 0x1f46a],
	[0x1f47d, 0x1f47d], [0x1f4a3, 0x1f4a3], [0x1f4b0, 0x1f4b0], [0x1f4b3, 0x1f4b3], [0x1f4bb, 0x1f4bb],
	[0x1f4bf, 0x1f4bf], [0x1f4cb, 0x1f4cb], [0x1f4da, 0x1f4da], [0x1f4df, 0x1f4df], [0x1f4e4, 0x1f4e6],
	[0x1f4ea, 0x1f4ed], [0x1f4f7, 0x1f4f7], [0x1f4f9, 0x1f4fb], [0x1f4fd, 0x1f4fd], [0x1f508, 0x1f508],
	[0x1f50d, 0x1f50d], [0x1f512, 0x1f513], [0x1f549, 0x1f54a], [0x1f550, 0x1f567], [0x1f56f, 0x1f570],
	[0x1f573, 0x1f579], [0x1f587, 0x1f587], [0x1f58a, 0x1f58d], [0x1f590, 0x1f590], [0x1f5a5, 0x1f5a5],
	[0x1f5a8, 0x1f5a8], [0x1f5b1, 0x1f5b2], [0x1f5bc, 0x1f5bc], [0x1f5c2, 0x1f5c4], [0x1f5d1, 0x1f5d3],
	[0x1f5dc, 0x1f5de], [0x1f5e1, 0x1f5e1], [0x1f5e3, 0x1f5e3], [0x1f5e8, 0x1f5e8], [0x1f5ef, 0x1f5ef],
	[0x1f5f3, 0x1f5f3], [0x1f5fa, 0x1f5fa], [0x1f610, 0x1f610], [0x1f687, 0x1f687], [0x1f68d, 0x1f68d],
	[0x1f691, 0x1f691], [0x1f694, 0x1f694], [0x1f698, 0x1f698], [0x1f6ad, 0x1f6ad], [0x1f6b2, 0x1f6b2],
	[0x1f6b9, 0x1f6ba], [0x1f6bc, 0x1f6bc], [0x1f6cb, 0x1f6cb], [0x1f6cd, 0x1f6cf], [0x1f6e0, 0x1f6e5],
	[0x1f6e9, 0x1f6e9], [0x1f6f0, 0x1f6f0], [0x1f6f3, 0x1f6f3],
];

/** The keycap bases, `#`, `*` and `0` to `9`, which take U+FE0F only before U+20E3, as in "1️⃣". */
const KEYCAP_BASES: ReadonlySet<number> = new Set([0x23, 0x2a, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39]);

const COMBINING_ENCLOSING_KEYCAP = 0x20e3;

function isVariationBase(codePoint: number): boolean {
	return VARIATION_BASES.some(([first, last]) => codePoint >= first && codePoint <= last);
}

/**
 * Whether a U+FE0E or U+FE0F is the ordinary form of a sequence Unicode defines: right
 * after a listed base, with no selector after it, and on a keycap base only U+FE0F before
 * U+20E3. Every other selector, and each one of a run, stays reported.
 */
function isOrdinaryVariationSelector(previous: number | undefined, codePoint: number, next: number | undefined): boolean {
	if (codePoint !== 0xfe0e && codePoint !== 0xfe0f) return false;
	if (previous === undefined || !isVariationBase(previous)) return false;
	if (next !== undefined && isVariationSelector(next)) return false;
	if (KEYCAP_BASES.has(previous)) return codePoint === 0xfe0f && next === COMBINING_ENCLOSING_KEYCAP;
	return true;
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
	let previous: number | undefined;
	for (let index = 0; index < source.length; ) {
		const codePoint = source.codePointAt(index)!;
		const wide = codePoint > 0xffff;
		const next = source.codePointAt(index + (wide ? 2 : 1));
		const category = INVISIBLE_UNICODE.get(codePoint) ?? rangeInvisibleCategory(codePoint);
		if (category && !isOrdinaryVariationSelector(previous, codePoint, next)) findings.push({ index, codePoint, label: labelFor(codePoint), category });
		previous = codePoint;
		index += wide ? 2 : 1;
	}
	return { count: findings.length, findings };
}

/**
 * Import-from-repo discovery filter: only a file named exactly
 * `SKILL.md` counts, so a repo's README/docs are never mistaken for skills.
 * Every folder is searched, those whose names start
 * with a dot included (`.claude/skills`, `skills/.curated`), except `.git` and
 * `node_modules`, as the leading tools search.
 */
export function isSkillManifestPath(relPath: string): boolean {
	const parts = String(relPath ?? "")
		.split(/[\\/]+/)
		.filter(Boolean);
	if (parts.length === 0) return false;
	if (parts[parts.length - 1] !== "SKILL.md") return false;
	return !parts.slice(0, -1).some((segment) => segment === "node_modules" || segment === ".git");
}

/** Keep only the true `SKILL.md` manifests from a repo file listing (see `isSkillManifestPath`). */
export function filterRepoScanSkillFiles(relPaths: readonly string[]): string[] {
	return relPaths.filter(isSkillManifestPath);
}

/** The extensions of each kind a skill's file can be; anything else is "other". */
const SKILL_FILE_KIND_EXTENSIONS: ReadonlyArray<readonly [SkillFileKind, ReadonlySet<string>]> = [
	["scripts", new Set([".py", ".sh", ".bash", ".zsh", ".js", ".mjs", ".cjs", ".ts", ".rb", ".pl", ".ps1", ".bat", ".cmd", ".php", ".rs", ".go"])],
	["documents", new Set([".md", ".markdown", ".txt", ".rst", ".pdf", ".html", ".htm", ".csv", ".json", ".yaml", ".yml", ".xml", ".toml"])],
	["templates", new Set([".docx", ".doc", ".dotx", ".xlsx", ".xls", ".xltx", ".pptx", ".ppt", ".potx", ".odt", ".ods", ".odp", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp", ".tif", ".tiff", ".ico"])],
];

/** A skill's file by its posix path inside the skill's folder, and its kind. */
export interface SkillFile {
	path: string;
	kind: SkillFileKind;
}

/** The kind of a file by its path inside the skill's folder: its SKILL.md is the instructions. */
export function skillFileKind(relPath: string): SkillFileKind {
	if (relPath === "SKILL.md") return "instructions";
	const extension = extensionOf(relPath);
	return SKILL_FILE_KIND_EXTENSIONS.find(([, extensions]) => extensions.has(extension))?.[0] ?? "other";
}

/** A file mode with any run bit: its source marks the file runnable (Windows marks none). */
export function marksRunnable(mode: number): boolean {
	return (mode & 0o111) !== 0;
}

/** How many of a file's first bytes `isSkillScript` reads: enough for every signature below, an svg's leading white space and an eot's header. */
export const SCRIPT_HEAD_BYTES = 512;

const startsWith = (head: Uint8Array, bytes: readonly number[], at = 0) => bytes.every((byte, i) => head[at + i] === byte);
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

/** First bytes of a program the computer starts by itself: Mach-O (each width and order, and universal), ELF, and Windows' PE. */
const NATIVE_PROGRAM_SIGNATURES: ReadonlyArray<readonly number[]> = [
	[0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf], [0xce, 0xfa, 0xed, 0xfe], [0xcf, 0xfa, 0xed, 0xfe], [0xca, 0xfe, 0xba, 0xbe],
	[0x7f, 0x45, 0x4c, 0x46],
	ascii("MZ"),
];

/** An svg is text that starts as XML or as `<svg`, after a byte-order mark and white space. */
function startsAsSvg(head: Uint8Array): boolean {
	const text = new TextDecoder().decode(head).replace(/^﻿/, "").trimStart().toLowerCase();
	return ["<?xml", "<svg", "<!--", "<!doctype svg"].some((start) => text.startsWith(start));
}

/**
 * A font's header has a zero 8 bytes in, where a shell script that starts
 * "true;" or "OTTO=1" has a letter: a TrueType or OpenType font's entry selector
 * is at most 15, and a web font's length is under 16 MB, so each high byte is zero.
 */
const fontHeader = (head: Uint8Array) => head[8] === 0;

/** Each picture and font extension, and whether a file's first bytes agree with it. */
const PICTURE_AND_FONT_SIGNATURES: ReadonlyMap<string, (head: Uint8Array) => boolean> = new Map([
	[".png", (head) => startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
	[".jpg", (head) => startsWith(head, [0xff, 0xd8, 0xff])],
	[".jpeg", (head) => startsWith(head, [0xff, 0xd8, 0xff])],
	[".gif", (head) => startsWith(head, ascii("GIF87a")) || startsWith(head, ascii("GIF89a"))],
	[".webp", (head) => startsWith(head, ascii("RIFF")) && startsWith(head, ascii("WEBP"), 8)],
	// A bitmap's 4 bytes after its size are zero; "BM=1;" isn't one.
	[".bmp", (head) => startsWith(head, ascii("BM")) && startsWith(head, [0, 0, 0, 0], 6)],
	[".ico", (head) => startsWith(head, [0x00, 0x00, 0x01, 0x00])],
	[".svg", startsAsSvg],
	[".otf", (head) => (startsWith(head, ascii("OTTO")) || startsWith(head, [0x00, 0x01, 0x00, 0x00])) && fontHeader(head)],
	[".ttf", (head) => (startsWith(head, [0x00, 0x01, 0x00, 0x00]) || startsWith(head, ascii("true")) || startsWith(head, ascii("OTTO"))) && fontHeader(head)],
	[".woff", (head) => startsWith(head, ascii("wOFF")) && fontHeader(head)],
	[".woff2", (head) => startsWith(head, ascii("wOF2")) && fontHeader(head)],
	// An embedded OpenType font keeps its "LP" mark 34 bytes in.
	[".eot", (head) => startsWith(head, [0x4c, 0x50], 34)],
]);

function extensionOf(file: string): string {
	const name = file.slice(file.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

/** A picture or font by its name whose first bytes agree with that name. */
function isPictureOrFont(file: string, head: Uint8Array): boolean {
	return PICTURE_AND_FONT_SIGNATURES.get(extensionOf(file))?.(head) === true;
}

/**
 * Whether a skill's file (its path in the skill) is a script, from its name, its
 * source's mode and its first bytes (`SCRIPT_HEAD_BYTES`): a script extension, a
 * `#!` line, a native program, or a run mark on anything but a picture or font
 * whose bytes agree with its name. The skill's own SKILL.md is its instructions.
 */
export function isSkillScript(file: string, sourceMode: number, head: Uint8Array): boolean {
	if (file === "SKILL.md") return false;
	if (skillFileKind(file) === "scripts" || startsWith(head, ascii("#!"))) return true;
	if (NATIVE_PROGRAM_SIGNATURES.some((signature) => startsWith(head, signature))) return true;
	return marksRunnable(sourceMode) && !isPictureOrFont(file, head);
}

/** Whether a skill's file keeps its run mark: a script (`isSkillScript`) its source marks runnable. */
export function keepsRunMark(file: string, sourceMode: number, head: Uint8Array): boolean {
	return marksRunnable(sourceMode) && isSkillScript(file, sourceMode, head);
}

/** The mode a skill's file (its path in the skill) is written with: the owner's alone, runnable only when it keeps its run mark (`keepsRunMark`). */
export function keptFileMode(file: string, sourceMode: number, head: Uint8Array): number {
	return keepsRunMark(file, sourceMode, head) ? 0o700 : 0o600;
}

/**
 * Every file a skill brings, with its kind, in codepoint order: the one list the
 * review and a skill's page show. A file in `scripts` (`isSkillScript`) is a
 * script, whatever its name ends in.
 */
export function skillFileList(relPaths: readonly string[], scripts: { has(path: string): boolean } = new Set()): SkillFile[] {
	return [...new Set(relPaths)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((path) => ({ path, kind: scripts.has(path) ? "scripts" : skillFileKind(path) }));
}

/** Characters that end a path in running text, a Markdown link or a command line. */
const PATH_ENDS = /[\s()[\]<>"'`,;|*=]+/;

/** The longest path `outsidePath` reads, as a run of characters or a quoted span: no one writes a longer one, and the review shows the path it finds. */
const PATH_MAX = 400;

/** Spans whose words belong together, each at most `PATH_MAX` long: code, a link's `<destination>`, and quotes. */
const QUOTED = /`([^`\n]{1,400})`|<([^<>\n]{1,400})>|"([^"\n]{1,400})"|'([^'\n]{1,400})'/g;

/** A path written from the skill-folder variable a room fills (`withSkillFolder`): it starts at the skill's own folder. */
const SKILL_FOLDER_VARIABLE = /^\$(?:\{CLAUDE_SKILL_DIR\}|CLAUDE_SKILL_DIR)\//;

/** A word that starts like a path or an option, as a command's later words do: `./x`, `../x`, `/x`, `~/x`, `-x`, `$X`. */
const PATH_OR_OPTION_START = /^[./~$-]/;

/**
 * Whether a quoted or code span is one path with a space in it (a folder's name
 * may hold one): its first word holds a "/" and none after it starts like a path
 * or an option, which a command given a path has, as in `./render.sh ../x`.
 */
function isOneSpacedPath(span: string): boolean {
	const [first, ...rest] = span.split(/\s+/);
	return rest.length > 0 && first.includes("/") && !rest.some((word) => PATH_OR_OPTION_START.test(word));
}

/**
 * The paths a skill's Markdown may write, in the order written: a quoted or code
 * span that is one path with a space (`isOneSpacedPath`) whole, and then only the
 * quoted spans inside it, as a command's quoted argument (never its words: a
 * piece of a path is no path); any other span read as text; and the text around
 * spans word by word, unless `words` is false.
 */
function* writtenPaths(text: string, words = true): Generator<string> {
	let last = 0;
	for (const match of text.matchAll(QUOTED)) {
		if (words) yield* text.slice(last, match.index).split(PATH_ENDS);
		const inner = (match[1] ?? match[2] ?? match[3] ?? match[4]).trim();
		const whole = isOneSpacedPath(inner);
		if (whole) yield inner;
		yield* writtenPaths(inner, !whole);
		last = match.index + match[0].length;
	}
	if (words) yield* text.slice(last).split(PATH_ENDS);
}

/** A path without the sentence's end after it: its last `:`, `!` or `?`, and a full stop, but never the dots of "..". */
function withoutSentenceEnd(token: string): string {
	let end = token.length;
	while (end > 0 && ":!?".includes(token[end - 1])) end -= 1;
	if (end > 1 && token[end - 1] === "." && token[end - 2] !== ".") end -= 1;
	return token.slice(0, end);
}

/** A written path without its `?` or `#` and what follows: cut at the first of them, read once. */
function withoutQueryOrFragment(written: string): string {
	const cut = written.search(/[?#]/);
	return cut < 0 ? written : written.slice(0, cut);
}

/** Whether a written path names something: its last part holds a letter or a digit and doesn't trail off in "...", so `../..` and `../modules/...` name nothing. */
function namesSomething(written: string): boolean {
	const last = withoutQueryOrFragment(written).split("/").filter((part) => part !== "").at(-1) ?? "";
	return /[\p{L}\p{N}]/u.test(last) && !last.endsWith("...");
}

/** Whether a written path, resolved from a folder `depth` folders inside the skill's, leaves the skill's folder. */
function leavesSkillFolder(written: string, depth: number): boolean {
	let rest = written;
	const fromSkillFolder = SKILL_FOLDER_VARIABLE.exec(written);
	if (fromSkillFolder) {
		rest = written.slice(fromSkillFolder[0].length);
		depth = 0;
	} else if (written.includes("://") || /^[/~\\$]/.test(written)) return false;
	for (const part of withoutQueryOrFragment(rest).split("/")) {
		if (part === "..") depth -= 1;
		else if (part !== "" && part !== ".") depth += 1;
		if (depth < 0) return true;
	}
	return false;
}

/** A line that opens or closes a fenced code block: at most three spaces, then three or more backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Markdown's text without its fenced code blocks, in one pass over its lines: a
 * backtick fence opens only when no backtick follows it on its line (else it is
 * inline code), and closes on a line of its own character, at least as long,
 * with nothing after it but spaces; one left open runs to the text's end. A command in a
 * block runs from its own folder and a sample names another project's files, so
 * neither says where the skill's own files are.
 */
function withoutFencedBlocks(text: string): string {
	const kept: string[] = [];
	let open: string | null = null;
	for (const line of text.split(/\r\n|\r|\n/)) {
		const match = FENCE.exec(line);
		const fence = match?.[1];
		if (open === null) {
			if (match && fence && !(fence[0] === "`" && line.includes("`", match[0].length))) open = fence;
			else kept.push(line);
		} else if (match && fence && fence[0] === open[0] && fence.length >= open.length && line.slice(match[0].length).trim() === "") open = null;
	}
	return kept.join("\n");
}

/** A repository's pages for people, at any depth and in any case, which are not the skill's instructions. */
const PAGES_FOR_PEOPLE: ReadonlySet<string> = new Set(["readme.md", "changelog.md", "license.md", "contributing.md", "security.md"]);

/**
 * The first relative path, as written, in a skill's Markdown files that reaches
 * above the skill's folder: one with a `../` that names something
 * (`namesSomething`) and, resolved from its own file's folder (or from the
 * skill's, after the skill-folder variable), leaves the skill's. Files are each
 * a path in the skill and its text, read in the order given; fenced code blocks,
 * the pages for people (`PAGES_FOR_PEOPLE`), addresses, absolute and home paths,
 * other variables and anything past `PATH_MAX` are left alone. Null when every
 * path stays inside.
 */
export function outsidePath(files: ReadonlyArray<{ path: string; text: string }>): string | null {
	for (const { path, text } of files) {
		if (PAGES_FOR_PEOPLE.has(path.slice(path.lastIndexOf("/") + 1).toLowerCase())) continue;
		const depth = path.split("/").length - 1;
		for (const token of writtenPaths(withoutFencedBlocks(text))) {
			if (token.length > PATH_MAX || !token.includes("../")) continue;
			const written = withoutSentenceEnd(token);
			if (namesSomething(written) && leavesSkillFolder(written, depth)) return written;
		}
	}
	return null;
}

/** True when a Mac's or Windows' disk takes the file name `name` for `target` (case, and Windows' trailing dots and spaces, ignored). */
export function nameFoldsOnto(name: string, target: string): boolean {
	return name.replace(/[. ]+$/, "").toLowerCase() === target.toLowerCase();
}

/** A skill past `SKILL_LIMITS`, with its real count or size, for the refusal's answer. */
export class SkillTooBigError extends Error {
	constructor(readonly refusal: SkillTooBig) {
		super(skillTooBigLine(refusal));
	}
}

/** The refusal for a skill of `files` files and `bytes` bytes, the count first, or null within the limit. */
export function skillOverLimit(files: number, bytes: number): SkillTooBig | null {
	if (files > SKILL_LIMITS.files) return { files };
	if (bytes > SKILL_LIMITS.bytes) return { bytes };
	return null;
}
