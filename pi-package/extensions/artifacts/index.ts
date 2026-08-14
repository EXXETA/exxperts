/**
 * Local artifact tools for exxperts.
 *
 * Approval-gated local artifact writes (.md/.html/.svg) plus safe list/read inspection under the
 * default ~/.exxperts/app/artifacts root and explicitly approved local destination roots.
 * Includes a narrow deterministic HTML deck helper. No auto-open, preview, PDF,
 * PPTX, or export behaviour.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import JSZip from "jszip";
import type { ExtensionAPI } from "@exxeta/exxperts-runtime";
import { productAppStatePath } from "../../product-state-paths.js";

const ALLOWED_EXTENSIONS = new Set([".md", ".html", ".svg"]);
export const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_READ_BYTES = 180_000;
// Per-file write caps (validation-rejected, never truncated). SVG is capped
// everywhere; HTML/MD caps apply inside a pre-approved write scope, where no
// human sees the content before it lands on disk.
export const MAX_SVG_ARTIFACT_BYTES = 1_000_000;
export const MAX_SCOPED_HTML_ARTIFACT_BYTES = 5_000_000;
export const MAX_SCOPED_MD_ARTIFACT_BYTES = 1_000_000;
const MAX_APPROVAL_PREVIEW_BYTES = 180_000;
const MAX_PPTX_BYTES = 25 * 1024 * 1024;
const MAX_PPTX_SLIDES = 50;
const MAX_PPTX_OUTPUT_CHARS = 120_000;
const PPTX_SUMMARY_MAX_SLIDES = 12;
const PPTX_SUMMARY_MAX_SLIDE_TEXT = 260;
const PPTX_SUMMARY_MAX_NOTES = 180;
const PPTX_SUMMARY_MAX_WARNINGS = 12;
const PPTX_SUMMARY_MAX_ASSET_TYPES = 8;
const PPTX_SUMMARY_MAX_ASSET_SAMPLES = 10;
const PPTX_EXTRACT_VERSION = "artifact-inspect-pptx-v1";
const STYLE_PROFILE_MAX_ITEMS = 16;
const STYLE_PROFILE_MAX_LAYOUTS = 20;
const STYLE_PROFILE_MAX_MEDIA = 40;
const STYLE_PROFILE_MAX_REGIONS = 8;

type ArtifactDestination = { name: string; path: string; connectedAt?: string };
type ArtifactDestinationsConfig = { destinations?: ArtifactDestination[]; lastUsed?: string };

type DeckSlide = {
	title: string;
	keyMessage?: string;
	bullets?: string[];
	speakerNote?: string;
	visualIdea?: string;
};

type DeckSpecSlideType = "title" | "section" | "content" | "bullets";

type DeckSpecSlide = {
	id: string;
	type: DeckSpecSlideType;
	title: string;
	keyMessage?: string;
	bullets?: string[];
	speakerNote?: string;
	visualIdea?: string;
};

type DeckSpecDesign = {
	source?: "auto" | "preset" | "reference_html" | "reference_markdown" | "reference_pptx";
	preset?: "exxperts_bw" | "consulting" | "executive" | "technical" | "minimal";
	referenceId?: string;
	density?: "low" | "medium" | "high";
};

export type PptxInspectionSlide = {
	index: number;
	slideId?: string;
	entry?: string;
	text?: string;
	speakerNotes?: string;
	styleHints?: { fonts?: string[]; colors?: string[] };
};

export type PptxInspectionDetails = {
	metadata?: { relativePath?: string; path?: string };
	slideCount?: number;
	slides?: PptxInspectionSlide[];
	warnings?: string[];
};

export type DeckStyleProfile = {
	sourceType: "pptx" | "html";
	sourceLabel: string;
	slideSize?: { width?: number; height?: number; unit?: string };
	colors: {
		backgrounds: Array<{ value: string; count: number }>;
		text: Array<{ value: string; count: number }>;
		accents: Array<{ value: string; count: number }>;
	};
	fonts: Array<{ family: string; count: number }>;
	fontSizes: Array<{ value: number; unit: "pt" | "pptx-hundredth-pt" | "px"; count: number }>;
	// Role-mapped fonts measured by the size they're used at: heading = the font on the largest (title)
	// runs, body = the font on the smaller runs. Avoids picking a generic body font for headings just
	// because it's the most frequent. Undefined when run-level font/size pairs could not be measured.
	roleFonts?: { heading?: string; body?: string };
	layouts: Array<{
		slideNumber?: number;
		kind: "title" | "content" | "section" | "unknown";
		background?: string;
		textBoxCount?: number;
		imageCount?: number;
		roughRegions?: string[];
		fonts?: string[];
		titleFontSizePt?: number;
		titleRegion?: string;
		density?: "sparse" | "medium" | "dense";
		shapeHints?: string[];
		notes?: string[];
	}>;
	media: Array<{
		path: string;
		contentType?: string;
		extension?: string;
		bytes?: number;
		likelyLogo?: boolean;
	}>;
	caveats: string[];
};

export type DeckSpecV1 = {
	version: "1.0";
	artifactType: "deck";
	title: string;
	subtitle?: string;
	audience?: string;
	design?: DeckSpecDesign;
	slides: DeckSpecSlide[];
};

type SlideLayoutKind = "section" | "statement" | "two-column" | "content" | "decision" | "options" | "evidence" | "storyboard";

type DeckQualityWarning = {
	code:
		| "deck_many_slides"
		| "deck_title_long"
		| "slide_missing_key_message"
		| "slide_many_bullets"
		| "slide_bullet_long"
		| "slide_title_generic"
		| "slide_duplicate_bullet"
		| "deck_repeated_key_message"
		| "deck_missing_recommendation"
		| "deck_missing_decision_ask"
		| "filename_generic"
		| "filename_not_kebab_case"
		| "filename_long_base";
	message: string;
	slide?: number;
};

export type DeckSpecValidationIssue = {
	code: string;
	message: string;
	slide?: number;
};

export type DeckSpecValidationResult = {
	errors: DeckSpecValidationIssue[];
	warnings: DeckSpecValidationIssue[];
};

type HtmlDeckInput = {
	filename: string;
	destination?: string;
	folder?: string;
	title: string;
	subtitle?: string;
	audience?: string;
	footer?: string;
	slides: DeckSlide[];
};

type ArtifactTarget = {
	destination: ArtifactDestination;
	root: string;
	relativePath: string;
	fullPath: string;
	extension: string;
};

export function artifactRoot(): string {
	return productAppStatePath("artifacts");
}

function configPath(): string {
	return productAppStatePath("artifact-destinations.json");
}

function defaultDestination(): ArtifactDestination {
	return { name: "default", path: artifactRoot() };
}

function expandHome(value: string): string {
	const raw = String(value || "").trim();
	if (raw === "~") return os.homedir();
	if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
	return raw;
}

function normaliseRoot(value: string): string {
	const expanded = expandHome(value);
	if (!expanded || expanded.includes("\0")) throw new Error("Destination path is required and must not contain invalid characters.");
	return path.resolve(expanded);
}

function destinationName(value: string): string {
	const name = String(value || "").trim().toLowerCase();
	if (!name) throw new Error("Destination name is required.");
	if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) throw new Error("Destination name must use only letters, numbers, dots, underscores, or dashes.");
	if (name === "default") throw new Error("Destination name 'default' is reserved for ~/.exxperts/app/artifacts.");
	return name;
}

function assertConnectableRoot(root: string) {
	const home = path.resolve(os.homedir());
	if (root === path.parse(root).root) throw new Error("Cannot connect the filesystem root as an artifact destination.");
	if (root === home) throw new Error("Cannot connect the whole home folder as an artifact destination. Choose a narrower folder such as ~/Desktop/Artifacts.");
	if (!(root === home || root.startsWith(home + path.sep))) throw new Error("V1 artifact destinations must be inside your home folder.");
	if (!fs.existsSync(root)) throw new Error(`Destination folder does not exist: ${root}`);
	if (!fs.statSync(root).isDirectory()) throw new Error(`Destination is not a folder: ${root}`);
}

function readConfig(): ArtifactDestinationsConfig {
	try {
		const raw = fs.readFileSync(configPath(), "utf-8");
		const parsed = JSON.parse(raw) as ArtifactDestinationsConfig;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
		return {};
	}
}

function writeConfig(config: ArtifactDestinationsConfig) {
	fs.mkdirSync(path.dirname(configPath()), { recursive: true, mode: 0o700 });
	fs.writeFileSync(configPath(), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

function configuredDestinations(): ArtifactDestination[] {
	const seen = new Set<string>(["default"]);
	const out = [defaultDestination()];
	for (const dest of readConfig().destinations ?? []) {
		try {
			const name = destinationName(dest.name);
			const root = normaliseRoot(dest.path);
			if (seen.has(name)) continue;
			seen.add(name);
			out.push({ name, path: root, connectedAt: dest.connectedAt });
		} catch {
			// Ignore malformed config entries; connect/disconnect can repair them.
		}
	}
	return out;
}

function resolveDestination(name?: string): ArtifactDestination {
	const requested = String(name || "default").trim().toLowerCase();
	const dest = configuredDestinations().find((d) => d.name === requested);
	if (!dest) throw new Error(`Artifact destination is not connected: ${requested}. Use artifact_destinations to list approved roots or artifact_connect_destination to connect one.`);
	return { ...dest, path: normaliseRoot(dest.path) };
}

function validateRelativeParts(value: string, label: string, allowEmpty = false): string[] {
	const raw = String(value || "").trim();
	if (!raw && allowEmpty) return [];
	if (!raw) throw new Error(`${label} is required.`);
	if (path.isAbsolute(raw)) throw new Error(`${label} must be relative, not absolute.`);
	if (raw.includes("\\")) throw new Error(`${label} must use forward slashes only.`);
	if (raw.includes("\0")) throw new Error(`${label} contains an invalid character.`);
	const parts = raw.split("/").filter(Boolean);
	if (!parts.length && !allowEmpty) throw new Error(`${label} is required.`);
	for (const part of parts) {
		if (part === "." || part === ".." || part.includes("..")) throw new Error(`${label} must not contain '..'.`);
		if (!SAFE_SEGMENT.test(part)) throw new Error(`Unsafe ${label.toLowerCase()} segment: ${part}`);
	}
	return parts;
}

export function validateArtifactPath(filename: string, destination = "default", folder?: string, allowedExtensions: ReadonlySet<string> = ALLOWED_EXTENSIONS): ArtifactTarget {
	const dest = resolveDestination(destination);
	const root = path.resolve(dest.path);
	const parts = [...validateRelativeParts(folder || "", "Artifact folder", true), ...validateRelativeParts(filename, "Artifact filename")];
	// Artifact relative paths are forward-slash canonical on every platform (input is
	// validated to forward slashes above); only fullPath below is OS-native.
	const relativePath = parts.join("/");
	const extension = path.extname(relativePath).toLowerCase();
	if (!allowedExtensions.has(extension)) throw new Error(`Unsupported artifact extension: ${extension || "(none)"}.`);
	const fullPath = path.resolve(root, relativePath);
	if (fullPath !== root && !fullPath.startsWith(root + path.sep)) throw new Error("Artifact path escapes the approved destination folder.");
	return { destination: dest, root, relativePath, fullPath, extension };
}

// ── Pre-approved write scope (specialist delegation) ────────────────────────────────────────────
// A headless specialist session cannot answer ctx.ui.confirm, so the user's
// delegation approval doubles as a write grant for exactly one task-private
// folder. The grant never widens approval semantics anywhere else: writes
// outside the scope still require interactive approval (and therefore fail
// headless), and scoped writes are validation-rejected against hard caps.

export interface ArtifactsPreApprovedWriteScope {
	/** Destination name the grant is confined to (normally "default"). */
	destination: string;
	/** Store-relative folder (forward-slash), e.g. "tasks/tsk-abc123". */
	folder: string;
	/** Maximum number of files that may exist under the folder. */
	maxArtifacts: number;
	/** Maximum total bytes under the folder after the write. */
	maxTotalBytes: number;
	/** Per-file byte caps by extension; unlisted extensions use the scoped defaults. */
	perFileBytesByExtension?: Record<string, number>;
	/**
	 * When set, writes inside the scope are validation-REJECTED for any other
	 * extension (defense-in-depth under the template's outputExtensions — the
	 * store-wide ALLOWED_EXTENSIONS floor still applies first).
	 */
	allowedExtensions?: string[];
	/**
	 * Top-level subfolders of the scope that the SERVER manages (e.g. "inputs",
	 * where ingest-on-iterate stages workspace copies). Their contents do not
	 * count against maxArtifacts/maxTotalBytes — they are not the model's
	 * output — and, to keep that exclusion from becoming a cap bypass, writes
	 * targeting them are validation-rejected.
	 */
	reservedSubfolders?: string[];
}

/**
 * Read confinement for delegated (specialist) sessions: the session may read
 * and list ONLY its own task folder plus the exact input artifacts its brief
 * declared — "no access beyond your brief", the read-side mirror of the
 * pre-approved write scope. Absent scope = unconfined (normal room sessions).
 */
export interface ArtifactsReadScope {
	/** Destination name reads are confined to (normally "default"). */
	destination: string;
	/** Store-relative folders (forward-slash) readable in full, e.g. ["tasks/tsk-abc123"]. */
	folders: string[];
	/** Exact store-relative file paths additionally readable (declared input artifacts). */
	paths: string[];
}

export function isWithinArtifactsReadScope(destinationName: string, relativePath: string, scope: ArtifactsReadScope): boolean {
	if (destinationName !== String(scope.destination).trim().toLowerCase()) return false;
	for (const folder of scope.folders) {
		const clean = String(folder ?? "").replace(/\/+$/, "");
		if (clean && relativePath.startsWith(clean + "/")) return true;
	}
	return scope.paths.includes(relativePath);
}

export interface ArtifactsExtensionOptions {
	preApprovedWriteScope?: ArtifactsPreApprovedWriteScope;
	readScope?: ArtifactsReadScope;
}

function scopedPerFileCap(extension: string, scope: ArtifactsPreApprovedWriteScope): number {
	const explicit = scope.perFileBytesByExtension?.[extension];
	if (typeof explicit === "number" && explicit > 0) return explicit;
	if (extension === ".svg") return MAX_SVG_ARTIFACT_BYTES;
	if (extension === ".html") return MAX_SCOPED_HTML_ARTIFACT_BYTES;
	return MAX_SCOPED_MD_ARTIFACT_BYTES;
}

export function isWithinPreApprovedWriteScope(target: ArtifactTarget, scope: ArtifactsPreApprovedWriteScope): boolean {
	if (target.destination.name !== String(scope.destination).trim().toLowerCase()) return false;
	const folder = scope.folder.replace(/\/+$/, "");
	if (!folder) return false;
	return target.relativePath.startsWith(folder + "/");
}

function walkScopeFiles(scopeRoot: string, reservedSubfolders?: string[]): { count: number; totalBytes: number } {
	let count = 0;
	let totalBytes = 0;
	const reserved = new Set(reservedSubfolders ?? []);
	const walk = (dir: string, atRoot: boolean) => {
		if (!fs.existsSync(dir)) return;
		for (const name of fs.readdirSync(dir)) {
			// Dot-entries (e.g. server-written .thumbs previews) never count against
			// the model's caps — SAFE_SEGMENT already makes them unwritable by tools.
			if (name.startsWith(".")) continue;
			// Server-managed staging folders (ingested iterate inputs) are not the
			// model's output; counting them would let pre-filled inputs exhaust the
			// task's budget before the first artifact_write.
			if (atRoot && reserved.has(name)) continue;
			const file = path.join(dir, name);
			const stat = fs.lstatSync(file);
			if (stat.isDirectory()) walk(file, false);
			else if (stat.isFile()) { count += 1; totalBytes += stat.size; }
		}
	};
	walk(scopeRoot, true);
	return { count, totalBytes };
}

export type PreApprovedWriteDecision =
	| { granted: false; rejected?: undefined }
	| { granted: true; rejected?: undefined }
	| { granted: false; rejected: string };

/**
 * granted=true  → write proceeds without interactive approval.
 * granted=false → caller falls through to normal interactive approval.
 * rejected      → hard validation failure (cap exceeded inside the scope); the
 *                 caller must error out and must NOT fall through to approval.
 */
export function preApprovedWriteDecision(target: ArtifactTarget, contentBytes: number, scope: ArtifactsPreApprovedWriteScope | undefined): PreApprovedWriteDecision {
	if (!scope) return { granted: false };
	if (!isWithinPreApprovedWriteScope(target, scope)) return { granted: false };
	if (scope.allowedExtensions && !scope.allowedExtensions.includes(target.extension)) {
		return { granted: false, rejected: `This task's template only writes ${scope.allowedExtensions.join(", ")} artifacts (got ${target.extension}).` };
	}
	const scopeFolder = scope.folder.replace(/\/+$/, "");
	const insideScope = target.relativePath.slice(scopeFolder.length + 1);
	const reservedHit = (scope.reservedSubfolders ?? []).find((name) => insideScope === name || insideScope.startsWith(`${name}/`));
	if (reservedHit) {
		return { granted: false, rejected: `The ${reservedHit}/ folder is reserved for this task's input files — write outputs directly into ${scopeFolder}/.` };
	}
	const perFileCap = scopedPerFileCap(target.extension, scope);
	if (contentBytes > perFileCap) {
		return { granted: false, rejected: `Artifact exceeds the ${target.extension} size cap for this task (${contentBytes} > ${perFileCap} bytes).` };
	}
	const scopeRoot = path.resolve(target.root, ...scope.folder.split("/").filter(Boolean));
	const existing = walkScopeFiles(scopeRoot, scope.reservedSubfolders);
	const replacedBytes = fs.existsSync(target.fullPath) ? fs.lstatSync(target.fullPath).size : null;
	if (replacedBytes === null && existing.count >= scope.maxArtifacts) {
		return { granted: false, rejected: `Task artifact limit reached (${scope.maxArtifacts} files).` };
	}
	const projectedTotal = existing.totalBytes - (replacedBytes ?? 0) + contentBytes;
	if (projectedTotal > scope.maxTotalBytes) {
		return { granted: false, rejected: `Task artifact storage limit reached (${projectedTotal} > ${scope.maxTotalBytes} bytes).` };
	}
	return { granted: true };
}

function relPath(root: string, fullPath: string) {
	return path.relative(root, fullPath).split(path.sep).join("/");
}

function htmlEscape(value: unknown): string {
	return String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function nonEmpty(value: unknown): string {
	return String(value ?? "").trim();
}

function normaliseQualityText(value: unknown): string {
	return String(value ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.replace(/\s+/g, " ");
}

function normaliseSlides(slides: unknown): DeckSlide[] {
	if (!Array.isArray(slides) || slides.length === 0) throw new Error("At least one slide is required.");
	return slides.map((slide, index) => {
		const raw = (slide && typeof slide === "object" ? slide : {}) as Record<string, unknown>;
		const title = nonEmpty(raw.title);
		if (!title) throw new Error(`Slide ${index + 1} title is required.`);
		const bullets = Array.isArray(raw.bullets)
			? raw.bullets.map((b) => nonEmpty(b)).filter(Boolean)
			: [];
		return {
			title,
			keyMessage: nonEmpty(raw.keyMessage) || undefined,
			bullets,
			speakerNote: nonEmpty(raw.speakerNote) || undefined,
			visualIdea: nonEmpty(raw.visualIdea) || undefined,
		};
	});
}

function inferDeckSpecSlideType(slide: DeckSlide, index: number): DeckSpecSlideType {
	const bulletCount = slide.bullets?.length ?? 0;
	if (index === 0 && !slide.keyMessage && bulletCount <= 1) return "title";
	if (!slide.keyMessage && bulletCount === 0 && !slide.speakerNote && !slide.visualIdea) return "section";
	if (bulletCount >= 2) return "bullets";
	return "content";
}

export function normaliseDeckSpecV1(input: Pick<HtmlDeckInput, "title" | "subtitle" | "audience" | "slides">): DeckSpecV1 {
	const title = nonEmpty(input.title);
	if (!title) throw new Error("Deck title is required.");
	const subtitle = nonEmpty(input.subtitle);
	const audience = nonEmpty(input.audience);
	const slides = normaliseSlides(input.slides);
	return {
		version: "1.0",
		artifactType: "deck",
		title,
		subtitle: subtitle || undefined,
		audience: audience || undefined,
		slides: slides.map((slide, index) => ({
			id: `slide-${index + 1}`,
			type: inferDeckSpecSlideType(slide, index),
			...slide,
		})),
	};
}

export function validateDeckSpecV1(deck: DeckSpecV1): DeckSpecValidationResult {
	const errors: DeckSpecValidationIssue[] = [];
	const warnings: DeckQualityWarning[] = [];
	const supportedTypes = new Set<DeckSpecSlideType>(["title", "section", "content", "bullets"]);

	if (deck.version !== "1.0") {
		errors.push({ code: "deck_version_invalid", message: "DeckSpec version must be '1.0'." });
	}
	if (deck.artifactType !== "deck") {
		errors.push({ code: "deck_artifact_type_invalid", message: "DeckSpec artifactType must be 'deck'." });
	}
	if (!nonEmpty(deck.title)) {
		errors.push({ code: "deck_title_required", message: "Deck title is required." });
	}
	if (!Array.isArray(deck.slides) || deck.slides.length === 0) {
		errors.push({ code: "deck_slides_required", message: "At least one slide is required." });
		return { errors, warnings };
	}

	if (deck.title.length > 120) {
		warnings.push({ code: "deck_title_long", message: "Deck title is very long; consider shortening it." });
	}
	if (deck.slides.length > 15) {
		warnings.push({ code: "deck_many_slides", message: "Deck has many slides; consider tightening the narrative." });
	}

	const genericSlideTitles = new Set([
		"overview",
		"introduction",
		"summary",
		"key points",
		"next steps",
		"conclusion",
		"agenda",
		"background",
		"context",
	]);
	const recommendationSignals = ["recommend", "recommendation", "recommended", "we should", "propose", "proposal"];
	const decisionSignals = ["decision", "decide", "ask", "approve", "approval", "next 30 days", "next steps"];
	const executiveSignals = ["executive", "exec", "leadership", "management", "internal", "product review", "review"];
	const repeatedKeyMessageSlides = new Map<string, number[]>();

	const deckContext = [deck.title, deck.subtitle, deck.audience].map((v) => normaliseQualityText(v)).filter(Boolean).join(" ");
	const likelyExecutiveReviewDeck = executiveSignals.some((signal) => deckContext.includes(signal))
		|| (deck.slides.length === 5 && nonEmpty(deck.audience).length > 0);
	let hasRecommendationSignal = false;
	let hasDecisionSignal = false;

	const seenSlideIds = new Set<string>();
	for (let i = 0; i < deck.slides.length; i += 1) {
		const slide = deck.slides[i];
		const slideNumber = i + 1;
		const slideId = nonEmpty(slide.id);
		if (!slideId) {
			errors.push({ code: "slide_id_required", slide: slideNumber, message: `Slide ${slideNumber} id is required.` });
		} else if (seenSlideIds.has(slideId)) {
			errors.push({ code: "slide_id_duplicate", slide: slideNumber, message: `Slide ${slideNumber} id '${slideId}' is duplicated.` });
		} else {
			seenSlideIds.add(slideId);
		}

		if (!supportedTypes.has(slide.type)) {
			errors.push({ code: "slide_type_unsupported", slide: slideNumber, message: `Slide ${slideNumber} type '${String(slide.type)}' is not supported.` });
		}
		if (!nonEmpty(slide.title)) {
			errors.push({ code: "slide_title_required", slide: slideNumber, message: `Slide ${slideNumber} title is required.` });
		}

		const bulletCount = slide.bullets?.length ?? 0;
		const titleOnly = !slide.keyMessage && bulletCount === 0 && !slide.speakerNote && !slide.visualIdea;
		const normalisedTitle = normaliseQualityText(slide.title);
		const normalisedKeyMessage = normaliseQualityText(slide.keyMessage);
		if (slide.type !== "title" && slide.type !== "section" && genericSlideTitles.has(normalisedTitle)) {
			warnings.push({ code: "slide_title_generic", slide: slideNumber, message: `Slide ${slideNumber} title is generic; make it more specific.` });
		}
		if (normalisedKeyMessage) {
			const seenSlides = repeatedKeyMessageSlides.get(normalisedKeyMessage) ?? [];
			seenSlides.push(slideNumber);
			repeatedKeyMessageSlides.set(normalisedKeyMessage, seenSlides);
		}
		if (recommendationSignals.some((signal) => normalisedTitle.includes(signal) || normalisedKeyMessage.includes(signal))) {
			hasRecommendationSignal = true;
		}
		if (decisionSignals.some((signal) => normalisedTitle.includes(signal) || normalisedKeyMessage.includes(signal))) {
			hasDecisionSignal = true;
		}
		if ((slide.type === "content" || slide.type === "bullets") && !slide.keyMessage) {
			warnings.push({ code: "slide_missing_key_message", slide: slideNumber, message: `Slide ${slideNumber} has no key message.` });
		} else if (!slide.keyMessage && !titleOnly && slide.type !== "title" && slide.type !== "section") {
			warnings.push({ code: "slide_missing_key_message", slide: slideNumber, message: `Slide ${slideNumber} has no key message.` });
		}
		if (bulletCount > 5) {
			warnings.push({ code: "slide_many_bullets", slide: slideNumber, message: `Slide ${slideNumber} has more than 5 bullets.` });
		}
		const normalisedBullets = new Set<string>();
		let hasDuplicateBullet = false;
		let hasLongBulletWarning = false;
		for (const bullet of slide.bullets ?? []) {
			if (!hasLongBulletWarning && bullet.length > 140) {
				hasLongBulletWarning = true;
				warnings.push({ code: "slide_bullet_long", slide: slideNumber, message: `Slide ${slideNumber} has a very long bullet.` });
			}
			const normalisedBullet = normaliseQualityText(bullet);
			if (!normalisedBullet) continue;
			if (normalisedBullets.has(normalisedBullet)) hasDuplicateBullet = true;
			normalisedBullets.add(normalisedBullet);
		}
		if (hasDuplicateBullet) {
			warnings.push({ code: "slide_duplicate_bullet", slide: slideNumber, message: `Slide ${slideNumber} contains duplicate bullets.` });
		}
	}

	for (const slidesWithMessage of repeatedKeyMessageSlides.values()) {
		if (slidesWithMessage.length >= 2) {
			warnings.push({
				code: "deck_repeated_key_message",
				message: `Repeated key message found on slides ${slidesWithMessage.join(", ")}.`,
			});
		}
	}

	if (likelyExecutiveReviewDeck && !hasRecommendationSignal) {
		warnings.push({
			code: "deck_missing_recommendation",
			message: "Deck likely needs a recommendation; none found in slide titles or key messages.",
		});
	}
	if (likelyExecutiveReviewDeck && !hasDecisionSignal) {
		warnings.push({
			code: "deck_missing_decision_ask",
			message: "Deck likely needs a decision/ask; none found in slide titles or key messages.",
		});
	}

	return { errors, warnings };
}

export function renderHtmlDeckFromSpec(deck: DeckSpecV1, options?: { footer?: string }): string {
	const footer = nonEmpty(options?.footer);
	const meta = [deck.subtitle || "", deck.audience ? `Audience: ${deck.audience}` : ""].filter(Boolean).join(" · ");
	const deckTitle = htmlEscape(deck.title);
	const deckFooter = footer || deck.title;
	const deckContext = normaliseQualityText([deck.title, deck.subtitle, deck.audience].filter(Boolean).join(" "));
	const recommendationSignals = ["recommend", "proposal", "propose", "we should", "preferred option"];
	const decisionSignals = ["decision", "ask", "approve", "approval", "next step", "next 30 days"];
	const optionsSignals = ["option", "trade off", "trade-off", "alternative", "compare", "vs", "choice"];
	const evidenceSignals = ["evidence", "current state", "baseline", "metric", "fact", "status", "today", "as is", "finding"];
	const storyboardSignals = ["visual", "storyboard", "journey", "wireframe", "mockup", "sketch"];

	const pickLayout = (slide: DeckSpecSlide, index: number): SlideLayoutKind => {
		const bulletCount = slide.bullets?.length ?? 0;
		const hasOnlyTitle = !slide.keyMessage && bulletCount === 0 && !slide.speakerNote && !slide.visualIdea;
		if (hasOnlyTitle) return "section";
		const slideContext = normaliseQualityText([slide.title, slide.keyMessage, slide.visualIdea].filter(Boolean).join(" "));
		const decisionLike = decisionSignals.some((s) => slideContext.includes(s));
		const recommendationLike = recommendationSignals.some((s) => slideContext.includes(s));
		const optionsLike = optionsSignals.some((s) => slideContext.includes(s));
		const evidenceLike = evidenceSignals.some((s) => slideContext.includes(s));
		const storyboardLike = storyboardSignals.some((s) => slideContext.includes(s)) || Boolean(slide.visualIdea);
		if (decisionLike || recommendationLike || (index >= deck.slides.length - 1 && deckContext.includes("executive"))) return "decision";
		if (optionsLike) return "options";
		if (evidenceLike) return "evidence";
		if (storyboardLike && bulletCount <= 4) return "storyboard";
		if (bulletCount <= 1 && slide.keyMessage) return "statement";
		if (bulletCount >= 4 || index % 3 === 2) return "two-column";
		return "content";
	};

	const slideSections = deck.slides.map((slide, index) => {
		const layout = pickLayout(slide, index);
		const bullets = slide.bullets?.length
			? `\n\t\t\t<ul>\n${slide.bullets.map((bullet) => `\t\t\t\t<li>${htmlEscape(bullet)}</li>`).join("\n")}\n\t\t\t</ul>`
			: "";
		const note = slide.speakerNote ? `\n\t\t\t<p class="note"><strong>Speaker note:</strong> ${htmlEscape(slide.speakerNote)}</p>` : "";
		const visual = slide.visualIdea ? `\n\t\t\t<p class="visual"><strong>Visual idea:</strong> ${htmlEscape(slide.visualIdea)}</p>` : "";
		return [
			`\t\t<section class="slide layout-${layout}">`,
			`\t\t\t<div class="kicker">${htmlEscape(deck.title)} · ${index + 1}/${deck.slides.length}</div>`,
			`\t\t\t<h2>${htmlEscape(slide.title)}</h2>`,
			slide.keyMessage ? `\t\t\t<p class="message">${htmlEscape(slide.keyMessage)}</p>` : undefined,
			bullets || undefined,
			note || undefined,
			visual || undefined,
			`\t\t\t<div class="footer">${htmlEscape(deckFooter)}</div>`,
			`\t\t</section>`,
		].filter(Boolean).join("\n");
	}).join("\n\n");

	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>${deckTitle}</title>
	<style>
		:root { color-scheme: dark; }
		* { box-sizing: border-box; }
		/* Fonts are not embedded. If Bandeins/Sen are unavailable locally, browser fallbacks render the exxperts-inspired black/white layout honestly without claiming exact UI typography. */
		body { margin: 0; overflow-x: hidden; background: #000; color: #fff; font-family: "Sen", Arial, Helvetica, sans-serif; }
		main { width: 100%; max-width: 100%; overflow-x: hidden; }
		.deck-title, .slide { position: relative; width: 100%; max-width: 100%; min-height: 100vh; min-height: 100svh; padding: clamp(32px, 7vh, 84px) clamp(24px, 7vw, 104px); display: flex; flex-direction: column; justify-content: center; border-bottom: 1px solid #fff; overflow-wrap: anywhere; }
		.deck-title { background: linear-gradient(180deg, #000 0%, #050505 100%); }
		.deck-title::before { content: ""; position: absolute; inset: clamp(14px, 2vw, 28px); border: 2px solid #fff; pointer-events: none; }
		.slide::after { content: ""; position: absolute; inset: clamp(14px, 2vw, 28px); border: 1px solid #fff; pointer-events: none; }
		.layout-section { justify-content: center; text-align: center; }
		.layout-section h2 { font-size: clamp(40px, 7vw, 96px); margin-bottom: 14px; }
		.layout-statement { justify-content: center; }
		.layout-statement .message { font-size: clamp(28px, 3.4vw, 44px); max-width: 36ch; }
		.layout-two-column, .layout-options { display: grid; grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr); column-gap: clamp(28px, 6vw, 96px); align-content: center; }
		.layout-two-column .kicker, .layout-two-column h2, .layout-two-column .message, .layout-options .kicker, .layout-options h2, .layout-options .message { grid-column: 1; }
		.layout-two-column ul, .layout-two-column .note, .layout-two-column .visual, .layout-options ul, .layout-options .note, .layout-options .visual { grid-column: 2; }
		.layout-two-column .footer, .layout-options .footer { grid-column: 1 / -1; }
		.layout-content, .layout-evidence { justify-content: flex-start; }
		.layout-decision { justify-content: center; border-bottom-width: 2px; }
		.layout-decision .message { max-width: 34ch; font-size: clamp(30px, 3.8vw, 48px); }
		.layout-evidence ul { columns: 2; column-gap: 2.2em; max-width: 95%; }
		.layout-storyboard .visual { border: 1px solid #fff; padding: 14px 16px; }
		h1 { font-family: "Bandeins Sans", "Bandeins", "Sen", Arial, Helvetica, sans-serif; font-size: clamp(44px, 8vw, 120px); line-height: 0.9; margin: 0 0 28px; max-width: 100%; overflow-wrap: anywhere; letter-spacing: -0.02em; }
		h2 { font-family: "Bandeins Sans", "Bandeins", "Sen", Arial, Helvetica, sans-serif; font-size: clamp(30px, 5.2vw, 74px); line-height: 0.98; margin: 0 0 22px; max-width: 100%; overflow-wrap: anywhere; }
		p, li { font-size: clamp(18px, 2vw, 30px); line-height: 1.32; overflow-wrap: anywhere; }
		ul { max-width: 100%; margin: 14px 0 0; padding-left: 1.2em; }
		li { margin: 0 0 0.38em; break-inside: avoid; }
		.kicker { text-transform: uppercase; letter-spacing: 0.16em; font-size: 13px; margin-bottom: 24px; }
		.meta, .message { max-width: 48ch; font-size: clamp(22px, 2.6vw, 36px); }
		.note, .visual { max-width: 90ch; font-size: clamp(16px, 1.4vw, 22px); margin-top: 20px; }
		.footer { margin-top: auto; padding-top: 48px; font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; overflow-wrap: anywhere; }
		@media (max-width: 900px) { .layout-two-column, .layout-options { display: flex; } .layout-evidence ul { columns: 1; } }
		@media (max-width: 700px) { .deck-title, .slide { min-height: auto; padding: 32px 22px; } .slide::after, .deck-title::before { display: none; } .layout-section h2 { font-size: clamp(32px, 10vw, 58px); } }
	</style>
</head>
<body>
	<main>
		<section class="deck-title">
			<div class="kicker">HTML slide deck</div>
			<h1>${deckTitle}</h1>${meta ? `\n\t\t\t<p class="meta">${htmlEscape(meta)}</p>` : ""}
			<div class="footer">${htmlEscape(deckFooter)}</div>
		</section>

${slideSections}
	</main>
</body>
</html>`;
}

export function renderHtmlDeck(input: HtmlDeckInput): string {
	const deck = normaliseDeckSpecV1(input);
	return renderHtmlDeckFromSpec(deck, { footer: input.footer });
}

export function validateRenderedHtmlDeck(deckSpec: DeckSpecV1, html: string): DeckSpecValidationResult {
	const errors: DeckSpecValidationIssue[] = [];
	const warnings: DeckSpecValidationIssue[] = [];
	const text = String(html ?? "");
	const trimmed = text.trim();

	if (!trimmed) errors.push({ code: "render_html_empty", message: "Rendered HTML is empty." });
	if (!/<!doctype html>/i.test(text)) errors.push({ code: "render_doctype_missing", message: "Rendered HTML must include <!doctype html>." });
	if (!/<\/html\s*>/i.test(text)) errors.push({ code: "render_html_close_missing", message: "Rendered HTML must include a closing </html> tag." });
	if (/<script\b/i.test(text)) errors.push({ code: "render_script_tag_found", message: "Rendered HTML contains a <script> tag, which is not allowed." });
	if (/\bsrc\s*=\s*/i.test(text)) errors.push({ code: "render_external_src_found", message: "Rendered HTML contains src= references, which are not allowed." });
	if (/https?:\/\//i.test(text)) errors.push({ code: "render_external_url_found", message: "Rendered HTML contains external http(s) references, which are not allowed." });
	if (/@import/i.test(text)) errors.push({ code: "render_css_import_found", message: "Rendered HTML contains @import, which is not allowed." });

	const renderedContentSlides = (text.match(/<section\s+class="slide\s+layout-[^"]*"/gi) ?? []).length;
	const expectedSlides = Array.isArray(deckSpec.slides) ? deckSpec.slides.length : 0;
	if (renderedContentSlides !== expectedSlides) {
		errors.push({
			code: "render_slide_count_mismatch",
			message: `Rendered content slide count (${renderedContentSlides}) does not match DeckSpec slides (${expectedSlides}).`,
		});
	}

	if (!text.includes("Fonts are not embedded.")) {
		warnings.push({
			code: "render_font_honesty_comment_missing",
			message: "Rendered HTML is missing the font honesty comment ('Fonts are not embedded.').",
		});
	}

	return { errors, warnings };
}

function listArtifacts(root: string, limit = 200): Array<{ path: string; bytes: number; modified: string }> {
	const out: Array<{ path: string; bytes: number; modified: string }> = [];
	const visit = (dir: string) => {
		if (out.length >= limit) return;
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			if (out.length >= limit) break;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) visit(full);
			else if (entry.isFile() && ALLOWED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
				const stat = fs.statSync(full);
				out.push({ path: relPath(root, full), bytes: stat.size, modified: stat.mtime.toISOString() });
			}
		}
	};
	visit(root);
	return out;
}

function xmlText(input: string): string {
	return input
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function extractTagText(xml: string, tag: string): string[] {
	const out: string[] = [];
	const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "g");
	let m: RegExpExecArray | null;
	while ((m = re.exec(xml))) {
		const text = xmlText(m[1]);
		if (text) out.push(text);
	}
	return out;
}

function parseRelationships(xml: string): Array<{ id: string; type: string; target: string; external: boolean }> {
	const out: Array<{ id: string; type: string; target: string; external: boolean }> = [];
	const re = /<Relationship\b([^>]+?)\/?>(?:<\/Relationship>)?/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(xml))) {
		const attrs = m[1];
		const id = /\bId="([^"]+)"/.exec(attrs)?.[1] ?? "";
		const type = /\bType="([^"]+)"/.exec(attrs)?.[1] ?? "";
		const target = /\bTarget="([^"]+)"/.exec(attrs)?.[1] ?? "";
		const external = /\bTargetMode="External"/.test(attrs);
		if (id && type && target) out.push({ id, type, target, external });
	}
	return out;
}

function limitText(value: string, maxChars: number): { text: string; truncated: boolean } {
	if (value.length <= maxChars) return { text: value, truncated: false };
	return { text: value.slice(0, maxChars), truncated: true };
}

function xmlAttr(attrs: string, name: string): string | undefined {
	return new RegExp(`\\b${name}="([^"]+)"`).exec(attrs)?.[1];
}

function normaliseColorValue(value: string | undefined): string {
	const raw = nonEmpty(value);
	if (!raw) return "";
	if (/^[0-9a-f]{6}$/i.test(raw)) return `#${raw.toUpperCase()}`;
	return raw;
}

function incrementCounter(map: Map<string, number>, value: string | undefined) {
	const clean = normaliseColorValue(value);
	if (!clean) return;
	map.set(clean, (map.get(clean) ?? 0) + 1);
}

function topCounterItems(map: Map<string, number>, maxItems = STYLE_PROFILE_MAX_ITEMS): Array<{ value: string; count: number }> {
	return Array.from(map.entries())
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, maxItems)
		.map(([value, count]) => ({ value, count }));
}

function topFontItems(map: Map<string, number>, maxItems = STYLE_PROFILE_MAX_ITEMS): Array<{ family: string; count: number }> {
	return Array.from(map.entries())
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, maxItems)
		.map(([family, count]) => ({ family, count }));
}

function topFontSizeItems(map: Map<string, number>, unit: "pt" | "pptx-hundredth-pt" | "px", maxItems = STYLE_PROFILE_MAX_ITEMS): Array<{ value: number; unit: "pt" | "pptx-hundredth-pt" | "px"; count: number }> {
	return Array.from(map.entries())
		.map(([value, count]) => ({ value: Number(value), unit, count }))
		.filter((item) => Number.isFinite(item.value))
		.sort((a, b) => b.count - a.count || a.value - b.value)
		.slice(0, maxItems);
}

function inferPptxRegion(x?: number, y?: number, cx?: number, cy?: number, slideWidth?: number, slideHeight?: number): string {
	if (!slideWidth || !slideHeight || x === undefined || y === undefined) return "unknown";
	const centerX = x + (cx ?? 0) / 2;
	const centerY = y + (cy ?? 0) / 2;
	const horizontal = centerX < slideWidth * 0.34 ? "left" : centerX > slideWidth * 0.66 ? "right" : "center";
	const vertical = centerY < slideHeight * 0.34 ? "top" : centerY > slideHeight * 0.66 ? "bottom" : "middle";
	return `${vertical}-${horizontal}`;
}

function parseShapeBox(chunk: string): { x?: number; y?: number; cx?: number; cy?: number } {
	const offAttrs = /<a:off\b([^>]*)>/i.exec(chunk)?.[1] || "";
	const extAttrs = /<a:ext\b([^>]*)>/i.exec(chunk)?.[1] || "";
	const x = Number(xmlAttr(offAttrs, "x"));
	const y = Number(xmlAttr(offAttrs, "y"));
	const cx = Number(xmlAttr(extAttrs, "cx"));
	const cy = Number(xmlAttr(extAttrs, "cy"));
	return {
		x: Number.isFinite(x) ? x : undefined,
		y: Number.isFinite(y) ? y : undefined,
		cx: Number.isFinite(cx) ? cx : undefined,
		cy: Number.isFinite(cy) ? cy : undefined,
	};
}

function shapeSolidFillChunk(chunk: string): string | undefined {
	return /<(?:a:)?solidFill[\s\S]*?<\/(?:a:)?solidFill>/i.exec(chunk)?.[0];
}

// Raw fill colour value (srgbClr hex or schemeClr token like "bg1"/"tx1"/"accent1") of a shape's
// first solid fill (its <p:spPr> fill), before theme resolution.
function shapeSolidFillRawColor(chunk: string): string | undefined {
	const fillChunk = shapeSolidFillChunk(chunk);
	if (!fillChunk) return undefined;
	return /(?:srgbClr|schemeClr)\b[^>]*\bval="([^"]+)"/i.exec(fillChunk)?.[1];
}

// True only when a shape carries real rendered text (a non-empty <a:t> run). PowerPoint paints
// full-bleed backgrounds as auto-shapes that still contain an EMPTY <p:txBody> placeholder, so the
// presence of <p:txBody> alone must not disqualify a shape from being a background.
function shapeHasVisibleText(chunk: string): boolean {
	for (const m of chunk.matchAll(/<a:t>([\s\S]*?)<\/a:t>/gi)) {
		if (nonEmpty(m[1])) return true;
	}
	return false;
}

// Theme colour scheme: maps theme names (dk1/lt1/dk2/lt2/accent1..6/hlink/folHlink) to RRGGBB hex,
// reading either srgbClr val or sysClr lastClr.
function parseThemeColorScheme(themeXml: string): Map<string, string> {
	const map = new Map<string, string>();
	const block = /<a:clrScheme\b[\s\S]*?<\/a:clrScheme>/i.exec(themeXml)?.[0] || "";
	for (const m of block.matchAll(/<a:(dk1|lt1|dk2|lt2|accent[1-6]|hlink|folHlink)>([\s\S]*?)<\/a:\1>/gi)) {
		const inner = m[2];
		const srgb = /<a:srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})"/i.exec(inner)?.[1];
		const sys = /<a:sysClr\b[^>]*\blastClr="([0-9A-Fa-f]{6})"/i.exec(inner)?.[1];
		const hex = srgb || sys;
		if (hex) map.set(m[1].toLowerCase(), hex.toUpperCase());
	}
	return map;
}

// Slide master <p:clrMap> maps the placeholder slots bg1/tx1/bg2/tx2 (and accents) to theme names.
function parseSlideMasterClrMap(masterXml: string): Map<string, string> {
	const map = new Map<string, string>();
	const attrs = /<p:clrMap\b([^>]*?)\/?>/i.exec(masterXml)?.[1] || "";
	for (const key of ["bg1", "tx1", "bg2", "tx2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"]) {
		const v = new RegExp(`\\b${key}="([^"]+)"`).exec(attrs)?.[1];
		if (v) map.set(key, v.toLowerCase());
	}
	return map;
}

// Resolve a schemeClr token to a concrete #RRGGBB using clrMap (bg1→tx1→… slot mapping) then the
// theme scheme. Returns "" when it cannot resolve to a concrete colour (e.g. phClr/window).
function resolveSchemeColorToHex(val: string, theme: Map<string, string>, clrMap: Map<string, string>): string {
	const name = nonEmpty(val).toLowerCase();
	if (!name) return "";
	let target = clrMap.get(name) ?? name;
	if (!clrMap.has(name)) {
		if (name === "bg1") target = "lt1";
		else if (name === "tx1") target = "dk1";
		else if (name === "bg2") target = "lt2";
		else if (name === "tx2") target = "dk2";
	}
	const hex = theme.get(target);
	return hex ? `#${hex}` : "";
}

// Resolve any fill colour value (srgbClr hex or schemeClr token) to a concrete #RRGGBB, or "".
function resolveFillColorToHex(rawVal: string | undefined, theme: Map<string, string>, clrMap: Map<string, string>): string {
	const raw = nonEmpty(rawVal);
	if (!raw) return "";
	if (/^#?[0-9a-f]{6}$/i.test(raw)) return `#${raw.replace(/^#/, "").toUpperCase()}`;
	return resolveSchemeColorToHex(raw, theme, clrMap);
}

// A full-bleed shape sits at ~the slide origin and spans ~the whole slide. PowerPoint decks
// commonly paint their visible background as such a shape rather than a slide-level <p:bg>.
function isFullBleedShape(box: { x?: number; y?: number; cx?: number; cy?: number }, slideWidth?: number, slideHeight?: number, tolerance = 0.04): boolean {
	if (!slideWidth || !slideHeight) return false;
	if (box.x === undefined || box.y === undefined || box.cx === undefined || box.cy === undefined) return false;
	const tolX = slideWidth * tolerance;
	const tolY = slideHeight * tolerance;
	const nearOrigin = box.x <= tolX && box.y <= tolY;
	const coversWidth = box.x + box.cx >= slideWidth - tolX;
	const coversHeight = box.y + box.cy >= slideHeight - tolY;
	return nearOrigin && coversWidth && coversHeight;
}

// Bounded geometry hints for a non-full-bleed, non-text shape: wide/short → horizontal divider,
// tall/thin → vertical divider, large solid area → block, line-only (no solid fill) → outline.
function inferNonTextShapeHints(chunk: string, box: { x?: number; y?: number; cx?: number; cy?: number }, slideWidth?: number, slideHeight?: number): string[] {
	const hints: string[] = [];
	if (!slideWidth || !slideHeight || box.cx === undefined || box.cy === undefined) return hints;
	if (isFullBleedShape(box, slideWidth, slideHeight)) return hints; // counted as background elsewhere
	const wRatio = box.cx / slideWidth;
	const hRatio = box.cy / slideHeight;
	const hasSolidFill = !!shapeSolidFillChunk(chunk);
	const hasLineFill = /<a:ln\b[\s\S]*?<a:solidFill/i.test(chunk);
	if (wRatio >= 0.5 && hRatio <= 0.06) hints.push("horizontal-divider");
	else if (hRatio >= 0.5 && wRatio <= 0.06) hints.push("vertical-divider");
	else if (wRatio >= 0.4 && hRatio >= 0.25 && hasSolidFill) hints.push("large-block");
	if (!hasSolidFill && hasLineFill) hints.push("outline-rectangle");
	return hints;
}

function likelyLogoFromPathAndSize(mediaPath: string, bytes?: number): boolean {
	const lower = mediaPath.toLowerCase();
	if (/logo|brand|wordmark|mark/.test(lower)) return true;
	return typeof bytes === "number" && bytes > 0 && bytes <= 150_000 && /\.(png|svg|jpg|jpeg|webp)$/i.test(lower);
}

function mediaContentType(extension: string): string | undefined {
	const ext = extension.toLowerCase();
	if (ext === ".png") return "image/png";
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".gif") return "image/gif";
	if (ext === ".svg") return "image/svg+xml";
	if (ext === ".webp") return "image/webp";
	if (ext === ".mp4") return "video/mp4";
	if (ext === ".mov") return "video/quicktime";
	if (ext === ".mp3") return "audio/mpeg";
	return undefined;
}

function buildHtmlStyleProfile(html: string, sourceLabel: string): DeckStyleProfile {
	const caveats = [
		"HTML inspection is static and approximate; CSS cascade, browser layout, scripts, external fonts/assets, and media rendering are not executed.",
		"Only bounded style metadata is returned; full HTML/CSS is not duplicated in the style profile.",
	];
	const cssText = Array.from(String(html || "").matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)).map((m) => m[1]).join("\n");
	const styleAttrs = Array.from(String(html || "").matchAll(/\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)).map((m) => m[1] || m[2] || "").join("\n");
	const combined = `${cssText}\n${styleAttrs}`;
	const backgrounds = new Map<string, number>();
	const text = new Map<string, number>();
	const accents = new Map<string, number>();
	const fonts = new Map<string, number>();
	const fontSizes = new Map<string, number>();

	for (const m of combined.matchAll(/(?:background(?:-color)?|background)\s*:\s*([^;}{]+)/gi)) {
		const value = m[1];
		for (const color of value.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|\b(?:black|white|red|blue|green|yellow|orange|purple|grey|gray)\b/gi) ?? []) incrementCounter(backgrounds, color);
	}
	for (const m of combined.matchAll(/(?:^|[;\s{])color\s*:\s*([^;}{]+)/gi)) {
		const color = (m[1].match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|\b(?:black|white|red|blue|green|yellow|orange|purple|grey|gray)\b/i) ?? [])[0];
		incrementCounter(text, color);
	}
	for (const m of combined.matchAll(/(?:border(?:-color)?|outline|box-shadow)\s*:\s*([^;}{]+)/gi)) {
		for (const color of m[1].match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|\b(?:black|white|red|blue|green|yellow|orange|purple|grey|gray)\b/gi) ?? []) incrementCounter(accents, color);
	}
	for (const m of combined.matchAll(/font-family\s*:\s*([^;}{]+)/gi)) {
		for (const family of m[1].split(",").map((part) => nonEmpty(part.replace(/["']/g, ""))).filter(Boolean).slice(0, 8)) {
			fonts.set(family, (fonts.get(family) ?? 0) + 1);
		}
	}
	for (const m of combined.matchAll(/font-size\s*:\s*([0-9.]+)px/gi)) {
		const key = String(Math.round(Number(m[1]) * 10) / 10);
		fontSizes.set(key, (fontSizes.get(key) ?? 0) + 1);
	}

	const sectionMatches = Array.from(String(html || "").matchAll(/<(section|article|div)\b([^>]*)>/gi));
	const classCounts = new Map<string, number>();
	for (const m of sectionMatches) {
		const classMatch = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(m[2]);
		const classes = classMatch?.[1] || classMatch?.[2] || "";
		for (const cls of classes.split(/\s+/).map(nonEmpty).filter(Boolean)) classCounts.set(cls, (classCounts.get(cls) ?? 0) + 1);
	}
	const slideLike = sectionMatches.filter((m) => /\b(slide|section|page|cover)\b/i.test(m[2])).slice(0, STYLE_PROFILE_MAX_LAYOUTS);
	const layouts = (slideLike.length ? slideLike : sectionMatches.slice(0, Math.min(8, STYLE_PROFILE_MAX_LAYOUTS))).map((m, i) => {
		const attrs = m[2];
		const cls = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs)?.[1] || "";
		const lower = cls.toLowerCase();
		const kind = i === 0 || /cover|title/.test(lower) ? "title" : /section|divider/.test(lower) ? "section" : /slide|content|layout/.test(lower) ? "content" : "unknown";
		return { slideNumber: i + 1, kind: kind as "title" | "content" | "section" | "unknown", roughRegions: cls ? cls.split(/\s+/).slice(0, 4) : undefined, notes: cls ? [`classes: ${cls.split(/\s+/).slice(0, 6).join(", ")}`] : undefined };
	});
	const recurring = Array.from(classCounts.entries()).filter(([, count]) => count >= 2).sort((a, b) => b[1] - a[1]).slice(0, 8);
	if (recurring.length) caveats.push(`Recurring classes/layout hints: ${recurring.map(([cls, count]) => `${cls}×${count}`).join(", ")}.`);
	const media = Array.from(String(html || "").matchAll(/<(img|video|audio)\b([^>]*)>/gi)).slice(0, STYLE_PROFILE_MAX_MEDIA).map((m) => {
		const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(m[2])?.[1] || "";
		const ext = path.extname(src.split(/[?#]/)[0]).toLowerCase() || undefined;
		return { path: src || `<${m[1]}>`, extension: ext, contentType: ext ? mediaContentType(ext) : undefined, likelyLogo: /logo|brand|wordmark|mark/i.test(src) };
	});
	return {
		sourceType: "html",
		sourceLabel,
		colors: { backgrounds: topCounterItems(backgrounds), text: topCounterItems(text), accents: topCounterItems(accents) },
		fonts: topFontItems(fonts),
		fontSizes: topFontSizeItems(fontSizes, "px"),
		layouts,
		media,
		caveats,
	};
}

function formatStyleProfileSummary(profile: DeckStyleProfile): string {
	const lines: string[] = [];
	lines.push(`Reference style profile: ${profile.sourceType} ${profile.sourceLabel}`);
	if (profile.slideSize?.width || profile.slideSize?.height) lines.push(`Slide size: ${profile.slideSize.width ?? "?"} × ${profile.slideSize.height ?? "?"} ${profile.slideSize.unit ?? ""}`.trim());
	lines.push(`Background colors: ${profile.colors.backgrounds.slice(0, 6).map((c) => `${c.value}×${c.count}`).join(", ") || "n/a"}`);
	lines.push(`Text colors: ${profile.colors.text.slice(0, 6).map((c) => `${c.value}×${c.count}`).join(", ") || "n/a"}`);
	lines.push(`Accent colors: ${profile.colors.accents.slice(0, 6).map((c) => `${c.value}×${c.count}`).join(", ") || "n/a"}`);
	lines.push(`Fonts: ${profile.fonts.slice(0, 6).map((f) => `${f.family}×${f.count}`).join(", ") || "n/a"}`);
	lines.push(`Font sizes: ${profile.fontSizes.slice(0, 6).map((f) => `${f.value}${f.unit === "pptx-hundredth-pt" ? "/100pt" : f.unit}×${f.count}`).join(", ") || "n/a"}`);
	if (profile.layouts.length) lines.push(`Layout hints: ${profile.layouts.slice(0, 6).map((l) => `${l.slideNumber ? `slide ${l.slideNumber} ` : ""}${l.kind}${l.roughRegions?.length ? ` (${l.roughRegions.join("/")})` : ""}`).join("; ")}`);
	if (profile.media.length) lines.push(`Media/logos: ${profile.media.length} media item(s), ${profile.media.filter((m) => m.likelyLogo).length} possible logo(s)`);
	lines.push("Caveats:");
	for (const caveat of profile.caveats.slice(0, 6)) lines.push(`- ${caveat}`);
	return lines.join("\n");
}

async function buildPptxStyleProfile(input: {
	target: ArtifactTarget;
	stat: fs.Stats;
	byName: Map<string, any>;
	entries: any[];
	orderedSlidePaths: string[];
	slideAssetUsage: Array<{ slide: number; relationshipId: string; type: string; target: string; external: boolean }>;
}): Promise<DeckStyleProfile> {
	const { target, stat, byName, entries, orderedSlidePaths, slideAssetUsage } = input;
	const caveats = [
		"PPTX style inspection is approximate ZIP/XML metadata extraction; master/theme inheritance, exact PowerPoint rendering, and font availability are not resolved.",
		"Coordinates use raw PPTX EMUs when available; regions are rough buckets, not pixel-perfect layout.",
	];
	const sourceLabel = `${target.destination.name}/${target.relativePath.split(path.sep).join("/")}`;
	const presentationXml = byName.get("ppt/presentation.xml") ? await byName.get("ppt/presentation.xml")!.async("string") : "";
	let slideSize: DeckStyleProfile["slideSize"] | undefined;
	const sldSzAttrs = /<p:sldSz\b([^>]*)>/i.exec(presentationXml)?.[1] || /<p14:sldSz\b([^>]*)>/i.exec(presentationXml)?.[1];
	if (sldSzAttrs) {
		const width = Number(xmlAttr(sldSzAttrs, "cx"));
		const height = Number(xmlAttr(sldSzAttrs, "cy"));
		slideSize = { width: Number.isFinite(width) ? width : undefined, height: Number.isFinite(height) ? height : undefined, unit: "emu" };
	}

	const backgrounds = new Map<string, number>();
	const textColors = new Map<string, number>();
	const accents = new Map<string, number>();
	const fonts = new Map<string, number>();
	const fontSizes = new Map<string, number>();
	const layouts: DeckStyleProfile["layouts"] = [];
	// Run-level (size, font) pairs, to map heading/body fonts by the size they're actually used at.
	const runFontSizes: Array<{ sz: number; font: string }> = [];

	const themeEntries = entries.filter((e) => /^ppt\/theme\/theme\d+\.xml$/i.test(e.name)).slice(0, 4);
	let themeColorScheme = new Map<string, string>();
	for (const entry of themeEntries) {
		const xml = await entry.async("string");
		if (themeColorScheme.size === 0) themeColorScheme = parseThemeColorScheme(xml);
		for (const m of xml.matchAll(/<(?:a:)?(?:accent\d+|hlink|folHlink|dk\d|lt\d)>[\s\S]*?<(?:a:)?srgbClr\b[^>]*\bval="([^"]+)"/gi)) incrementCounter(accents, m[1]);
		for (const m of xml.matchAll(/<(?:a:)?(?:latin|ea|cs)\b[^>]*\btypeface="([^"]+)"/gi)) {
			const family = nonEmpty(m[1]);
			if (family && !family.startsWith("+")) fonts.set(family, (fonts.get(family) ?? 0) + 1);
		}
	}
	const masterEntry = entries.find((e) => /^ppt\/slideMasters\/slideMaster\d+\.xml$/i.test(e.name));
	const clrMap = masterEntry ? parseSlideMasterClrMap(await masterEntry.async("string")) : new Map<string, string>();

	for (let i = 0; i < orderedSlidePaths.length && layouts.length < STYLE_PROFILE_MAX_LAYOUTS; i += 1) {
		const slidePath = orderedSlidePaths[i];
		const entry = byName.get(slidePath);
		if (!entry) continue;
		const xml = await entry.async("string");
		const shapeMatches: RegExpMatchArray[] = Array.from(xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/gi));

		// Detect full-bleed background shapes: a <p:sp> with a solid fill that carries no rendered
		// text, sized to ~the whole slide. Such shapes commonly hold an EMPTY <p:txBody> placeholder,
		// so we disqualify only shapes with visible text, and we resolve schemeClr fills to concrete
		// theme colours. Their fill is the visible slide background, not a text colour.
		let visibleBackground: string | undefined;
		for (const shape of shapeMatches) {
			const chunk = shape[0];
			if (shapeHasVisibleText(chunk)) continue;
			const fill = resolveFillColorToHex(shapeSolidFillRawColor(chunk), themeColorScheme, clrMap);
			if (!fill) continue;
			if (!isFullBleedShape(parseShapeBox(chunk), slideSize?.width, slideSize?.height)) continue;
			incrementCounter(backgrounds, fill);
			if (!visibleBackground) visibleBackground = fill;
		}

		// Slide-level <p:bg>/<p:bgRef> background, with schemeClr (bg1/tx1/…) resolved to theme hex.
		const bgChunk = /<p:bg[\s\S]*?<\/p:bg>/i.exec(xml)?.[0] || "";
		const bgColor = resolveFillColorToHex(/(?:srgbClr|schemeClr)\b[^>]*\bval="([^"]+)"/i.exec(bgChunk)?.[1], themeColorScheme, clrMap);
		if (bgColor) incrementCounter(backgrounds, bgColor);
		const slideBackground = visibleBackground || bgColor || undefined;

		// Text colours come only from text bodies/runs (schemeClr resolved to theme hex). Decorative
		// non-text shape fills (full-bleed backgrounds, accent rectangles, dividers) are deliberately
		// excluded so they cannot pollute the text palette.
		for (const tb of xml.matchAll(/<p:txBody\b[\s\S]*?<\/p:txBody>/gi)) {
			for (const m of tb[0].matchAll(/<(?:a:)?solidFill[\s\S]*?<\/(?:a:)?solidFill>/gi)) {
				const color = resolveFillColorToHex(/(?:srgbClr|schemeClr)\b[^>]*\bval="([^"]+)"/i.exec(m[0])?.[1], themeColorScheme, clrMap);
				if (color) incrementCounter(textColors, color);
			}
		}
		const slideFonts: string[] = [];
		for (const m of xml.matchAll(/\btypeface="([^"]+)"/g)) {
			const family = nonEmpty(m[1]);
			if (family && !family.startsWith("+")) {
				fonts.set(family, (fonts.get(family) ?? 0) + 1);
				if (!slideFonts.includes(family) && slideFonts.length < 4) slideFonts.push(family);
			}
		}
		let slideMaxSz = 0;
		for (const m of xml.matchAll(/\bsz="(\d+)"/g)) {
			fontSizes.set(m[1], (fontSizes.get(m[1]) ?? 0) + 1);
			const n = Number(m[1]);
			if (Number.isFinite(n) && n > slideMaxSz) slideMaxSz = n;
		}
		// Pair each run's size with its explicit font (so we can tell the title font from the body font).
		for (const rpr of xml.matchAll(/<a:rPr\b([^>]*)>([\s\S]*?)<\/a:rPr>/g)) {
			const sz = Number(/\bsz="(\d+)"/.exec(rpr[1])?.[1]);
			const font = nonEmpty(/<a:latin\b[^>]*\btypeface="([^"]+)"/.exec(rpr[2])?.[1] ?? "");
			if (Number.isFinite(sz) && sz > 0 && font && !font.startsWith("+")) runFontSizes.push({ sz, font });
		}

		const textBoxRegions: string[] = [];
		let titleRegion: string | undefined;
		let titleRegionScore = -1;
		for (const shape of shapeMatches) {
			const chunk = shape[0];
			if (!/<p:txBody\b/i.test(chunk)) continue;
			const box = parseShapeBox(chunk);
			const region = inferPptxRegion(box.x, box.y, box.cx, box.cy, slideSize?.width, slideSize?.height);
			if (region && !textBoxRegions.includes(region) && textBoxRegions.length < STYLE_PROFILE_MAX_REGIONS) textBoxRegions.push(region);
			// Title-like region: the text box holding the largest font run on the slide.
			const boxMaxSz = Math.max(0, ...Array.from(chunk.matchAll(/\bsz="(\d+)"/g)).map((mm) => Number(mm[1])).filter((n) => Number.isFinite(n)));
			if (region && region !== "unknown" && boxMaxSz > titleRegionScore) {
				titleRegionScore = boxMaxSz;
				titleRegion = region;
			}
		}

		const shapeHints: string[] = [];
		if (visibleBackground) shapeHints.push("full-bleed-background");
		for (const shape of shapeMatches) {
			const chunk = shape[0];
			if (shapeHasVisibleText(chunk)) continue;
			for (const hint of inferNonTextShapeHints(chunk, parseShapeBox(chunk), slideSize?.width, slideSize?.height)) {
				if (!shapeHints.includes(hint) && shapeHints.length < 6) shapeHints.push(hint);
			}
		}

		const imageCount = slideAssetUsage.filter((usage) => usage.slide === i + 1 && /\/image$/i.test(usage.type)).length;
		const text = extractTagText(xml, "a:t").join(" ");
		const kind: "title" | "content" | "section" | "unknown" = i === 0 ? "title" : text.length < 80 && shapeMatches.length <= 2 ? "section" : shapeMatches.length > 0 ? "content" : "unknown";
		const textBoxCount = textBoxRegions.length || shapeMatches.filter((shape) => /<p:txBody\b/i.test(shape[0])).length;
		const density: "sparse" | "medium" | "dense" = textBoxCount >= 5 ? "dense" : textBoxCount >= 3 ? "medium" : "sparse";
		layouts.push({
			slideNumber: i + 1,
			kind,
			background: slideBackground,
			textBoxCount,
			imageCount,
			roughRegions: textBoxRegions,
			fonts: slideFonts.length ? slideFonts : undefined,
			titleFontSizePt: slideMaxSz > 0 ? Math.round(slideMaxSz / 100) : undefined,
			titleRegion,
			density,
			shapeHints: shapeHints.length ? shapeHints : undefined,
			notes: [`text length: ${text.length}`, `shape count: ${shapeMatches.length}`],
		});
	}
	if (orderedSlidePaths.length > layouts.length) caveats.push(`Layout profile truncated to ${layouts.length} slide(s).`);

	const media = entries.filter((e) => /^ppt\/media\//i.test(e.name)).slice(0, STYLE_PROFILE_MAX_MEDIA).map((e) => {
		const extension = path.extname(e.name).toLowerCase() || undefined;
		const bytes = Number((e as any)?._data?.uncompressedSize ?? (e as any)?.uncompressedSize ?? 0) || undefined;
		return { path: e.name, contentType: extension ? mediaContentType(extension) : undefined, extension, bytes, likelyLogo: likelyLogoFromPathAndSize(e.name, bytes) };
	});
	const allMediaCount = entries.filter((e) => /^ppt\/media\//i.test(e.name)).length;
	if (allMediaCount > media.length) caveats.push(`Media inventory truncated to ${media.length} of ${allMediaCount} item(s).`);
	if (stat.size > MAX_PPTX_BYTES / 2) caveats.push("Large PPTX: profile remains bounded and may omit lower-frequency style details.");

	// Map heading/body fonts by the size they're used at: heading = the dominant font among the
	// largest (title) runs, body = the dominant font among the smaller runs.
	let roleFonts: DeckStyleProfile["roleFonts"];
	if (runFontSizes.length) {
		const sortedSz = runFontSizes.map((r) => r.sz).sort((a, b) => b - a);
		const threshold = sortedSz[Math.floor(sortedSz.length * 0.33)] ?? sortedSz[0];
		const mode = (rows: Array<{ font: string }>): string | undefined => {
			const c = new Map<string, number>();
			for (const r of rows) c.set(r.font, (c.get(r.font) ?? 0) + 1);
			let best: string | undefined, n = -1;
			for (const [f, k] of c) if (k > n) { n = k; best = f; }
			return best;
		};
		const large = runFontSizes.filter((r) => r.sz >= threshold);
		const small = runFontSizes.filter((r) => r.sz < threshold);
		const heading = mode(large.length ? large : runFontSizes);
		const body = mode(small.length ? small : runFontSizes);
		roleFonts = { heading, body: body && body !== heading ? body : (mode(small.filter((r) => r.font !== heading)) ?? body) };
	}

	return {
		sourceType: "pptx",
		sourceLabel,
		slideSize,
		colors: { backgrounds: topCounterItems(backgrounds), text: topCounterItems(textColors), accents: topCounterItems(accents) },
		fonts: topFontItems(fonts),
		fontSizes: topFontSizeItems(fontSizes, "pptx-hundredth-pt"),
		roleFonts,
		layouts,
		media,
		caveats,
	};
}

async function inspectPptxFile(target: ArtifactTarget, stat: fs.Stats) {
	const warnings: string[] = [];
	const buf = fs.readFileSync(target.fullPath);
	if (buf.byteLength > MAX_PPTX_BYTES) throw new Error(`PPTX exceeds max size (${MAX_PPTX_BYTES} bytes).`);
	const zip = await JSZip.loadAsync(buf);
	const entries = Object.values(zip.files).filter((f) => !f.dir);
	const byName = new Map(entries.map((f) => [f.name, f]));
	const hasMacros = entries.some((e) => /(^|\/)vbaProject\.bin$/i.test(e.name));
	if (hasMacros) warnings.push("Macro project detected (vbaProject.bin). Macros were not executed.");
	if (entries.some((e) => /(^|\/)(embeddings|oleObject|activeX)\//i.test(e.name))) warnings.push("Embedded/OLE/ActiveX entries detected. Content was not executed or unpacked.");

	const presentationXml = byName.get("ppt/presentation.xml") ? await byName.get("ppt/presentation.xml")!.async("string") : "";
	if (!presentationXml) warnings.push("presentation.xml missing; slide order may be incomplete.");
	const presRelsXml = byName.get("ppt/_rels/presentation.xml.rels") ? await byName.get("ppt/_rels/presentation.xml.rels")!.async("string") : "";
	const presRels = parseRelationships(presRelsXml);
	const presRidToTarget = new Map(presRels.map((r) => [r.id, r.target]));
	for (const rel of presRels.filter((r) => r.external)) warnings.push(`External relationship detected in presentation rels: ${rel.target}`);

	const sldIdRe = /<p:sldId\b[^>]*\br:id="([^"]+)"[^>]*>/g;
	const orderedSlidePaths: string[] = [];
	let m: RegExpExecArray | null;
	while ((m = sldIdRe.exec(presentationXml))) {
		const rid = m[1];
		const targetRel = presRidToTarget.get(rid);
		if (!targetRel) continue;
		const norm = path.posix.normalize(path.posix.join("ppt", targetRel.replace(/^\/+/, "")));
		orderedSlidePaths.push(norm);
	}
	if (!orderedSlidePaths.length) {
		for (const name of entries.map((e) => e.name).filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n)).sort()) orderedSlidePaths.push(name);
	}

	const slides: Array<{ index: number; entry: string; slideId: string; text: string; speakerNotes?: string; styleHints: { fonts: string[]; colors: string[] } }> = [];
	const slideAssetUsage: Array<{ slide: number; relationshipId: string; type: string; target: string; external: boolean }> = [];
	let skippedSlides = 0;
	for (let i = 0; i < orderedSlidePaths.length; i += 1) {
		if (i >= MAX_PPTX_SLIDES) { skippedSlides = orderedSlidePaths.length - i; break; }
		const slidePath = orderedSlidePaths[i];
		const entry = byName.get(slidePath);
		if (!entry) continue;
		const xml = await entry.async("string");
		const text = extractTagText(xml, "a:t").join(" ");
		const fonts = Array.from(new Set(Array.from(xml.matchAll(/typeface="([^"]+)"/g)).map((x) => x[1]).filter(Boolean))).slice(0, 20);
		const colors = Array.from(new Set(Array.from(xml.matchAll(/(?:srgbClr|schemeClr)\s+[^>]*?val="([^"]+)"/g)).map((x) => x[1]).filter(Boolean))).slice(0, 20);
		const slideFile = path.posix.basename(slidePath);
		const relPath = `ppt/slides/_rels/${slideFile}.rels`;
		const relEntry = byName.get(relPath);
		let speakerNotes = "";
		if (relEntry) {
			const relsXml = await relEntry.async("string");
			const rels = parseRelationships(relsXml);
			for (const rel of rels) {
				if (rel.external) warnings.push(`External relationship detected on ${slideFile}: ${rel.target}`);
				slideAssetUsage.push({ slide: i + 1, relationshipId: rel.id, type: rel.type, target: rel.target, external: rel.external });
				if (/\/notesSlide$/.test(rel.type)) {
					const notesPath = path.posix.normalize(path.posix.join("ppt/slides", rel.target));
					const notesEntry = byName.get(notesPath);
					if (notesEntry) {
						const notesXml = await notesEntry.async("string");
						speakerNotes = extractTagText(notesXml, "a:t").join(" ");
					}
				}
			}
		}
		slides.push({ index: i + 1, entry: slidePath, slideId: path.posix.basename(slidePath, ".xml"), text, speakerNotes: speakerNotes || undefined, styleHints: { fonts, colors } });
	}
	if (skippedSlides > 0) warnings.push(`Skipped ${skippedSlides} slide(s) due to inspection cap (${MAX_PPTX_SLIDES}).`);

	const assetInventory = entries.map((e) => ({
		name: e.name,
		type: path.extname(e.name).toLowerCase() || "(none)",
		size: undefined as number | undefined,
	})).slice(0, 400);
	if (entries.length > assetInventory.length) warnings.push(`Asset inventory truncated to ${assetInventory.length} entries.`);

	const styleProfile = await buildPptxStyleProfile({ target, stat, byName, entries, orderedSlidePaths, slideAssetUsage });

	const details = {
		metadata: {
			destination: target.destination.name,
			relativePath: target.relativePath.split(path.sep).join("/"),
			path: target.fullPath,
			size: stat.size,
			modified: stat.mtime.toISOString(),
			extractionVersion: PPTX_EXTRACT_VERSION,
		},
		slideCount: orderedSlidePaths.length,
		slides,
		assetInventory,
		slideAssetUsage,
		styleProfile,
		warnings,
	};
	const serialised = JSON.stringify(details);
	const limited = limitText(serialised, MAX_PPTX_OUTPUT_CHARS);
	if (limited.truncated) {
		warnings.push(`Inspection output truncated at ${MAX_PPTX_OUTPUT_CHARS} chars.`);
		const compact = {
			...details,
			slides: details.slides.map((s) => ({ ...s, text: limitText(s.text, 500).text, speakerNotes: s.speakerNotes ? limitText(s.speakerNotes, 500).text : undefined })),
			assetInventory: details.assetInventory.slice(0, 150),
			slideAssetUsage: details.slideAssetUsage.slice(0, 200),
			styleProfile: details.styleProfile,
			warnings,
		};
		return compact;
	}
	return details;
}

async function approve(ctx: any, title: string, detail: string) {
	if (!ctx.hasUI) return false;
	return await ctx.ui.confirm(title, detail);
}

function targetDetail(target: ArtifactTarget, exists: boolean, reason?: string): string[] {
	return [
		`Destination: ${target.destination.name}`,
		`Folder: ${target.root}`,
		`Path: ${target.fullPath}`,
		`File: ${target.relativePath.split(path.sep).join("/")}`,
		`Overwrite: ${exists ? "yes, existing file will be replaced if approved" : "no, new file"}`,
		reason ? `Reason: ${reason}` : undefined,
	].filter(Boolean) as string[];
}

function approvalPreviewContent(body: string): string {
	const content = String(body ?? "");
	const buf = Buffer.from(content, "utf-8");
	if (buf.byteLength <= MAX_APPROVAL_PREVIEW_BYTES) return content;
	return buf.subarray(0, MAX_APPROVAL_PREVIEW_BYTES).toString("utf-8") + "\n\n[preview truncated]";
}

// Collect element ids declared in the HTML so fragment links can be checked against real targets.
function collectElementIds(html: string): Set<string> {
	const ids = new Set<string>();
	const matches = html.match(/\bid\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi) ?? [];
	for (const match of matches) {
		const eqIndex = match.indexOf("=");
		let value = match.slice(eqIndex + 1).trim();
		if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1).trim();
		}
		if (value) ids.add(value);
	}
	return ids;
}

// Shared href/src policy for safe self-contained HTML. `src` is never allowed (it can reach the
// network/filesystem). `href` is allowed ONLY as a same-document fragment link (e.g. href="#slide-2"):
// static deck navigation that cannot reach the network, the filesystem, or trigger script. Every
// other href — external/local schemes (http(s)/file/data/mailto/tel/javascript), root or relative
// paths, drive paths, or an empty href — is rejected. With validateFragmentTargets, each fragment
// must point at an element id present in the HTML so authored decks cannot ship dead nav links.
function assertSafeHrefSrcAttributes(html: string, errorPrefix: string, options?: { validateFragmentTargets?: boolean }): void {
	const attrMatches = html.match(/\b(?:src|href)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi) ?? [];
	let ids: Set<string> | null = null;
	for (const match of attrMatches) {
		const eqIndex = match.indexOf("=");
		const attr = match.slice(0, eqIndex).trim().toLowerCase();
		let value = match.slice(eqIndex + 1).trim();
		if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1).trim();
		}
		if (attr !== "href") throw new Error(`${errorPrefix}: src attributes are not allowed (no external, local, or data: assets — draw content inline with SVG/CSS or describe it in text instead of embedding images).`);
		if (!value) throw new Error(`${errorPrefix}: empty href attribute is not allowed.`);
		if (!value.startsWith("#")) throw new Error(`${errorPrefix}: only same-document fragment links (href="#some-id") are allowed; '${value}' is not — link to an element id inside the document or drop the link.`);
		const fragment = value.slice(1);
		if (!fragment) throw new Error(`${errorPrefix}: empty fragment href ("#") is not allowed.`);
		if (!/^[A-Za-z][\w-]*$/.test(fragment)) throw new Error(`${errorPrefix}: fragment href '${value}' is not a simple same-document element id.`);
		if (options?.validateFragmentTargets) {
			if (!ids) ids = collectElementIds(html);
			if (!ids.has(fragment)) throw new Error(`${errorPrefix}: fragment link '${value}' points to a missing element id.`);
		}
	}
}

export function validateRawHtmlArtifactContent(body: string): void {
	const text = String(body ?? "");
	if (/<script\b/i.test(text)) throw new Error("Unsafe HTML is blocked: <script> tags are not allowed — the page must be fully static (it is displayed with scripts disabled).");
	if (/\bon[a-z0-9_-]+\s*=/i.test(text)) throw new Error("Unsafe HTML is blocked: inline event handlers (for example onclick=, onload=) are not allowed — remove them; the page must work without scripts.");
	if (/https?:\/\//i.test(text)) throw new Error("Unsafe HTML is blocked: external http(s) URLs are not allowed anywhere, even as visible text — refer to sources by name instead of by URL.");
	if (/@import/i.test(text)) throw new Error("Unsafe HTML is blocked: CSS @import is not allowed — put all styles in an inline <style> block.");
	if (/<\s*(iframe|object|embed)\b/i.test(text)) throw new Error("Unsafe HTML is blocked: iframe/object/embed tags are not allowed — the document must be fully self-contained.");
	// Same-document fragment links (href="#id") are allowed for static navigation; src and every
	// other href scheme/path remain blocked.
	assertSafeHrefSrcAttributes(text, "Unsafe HTML is blocked");
}

// The namespace/DTD URIs every legitimate SVG may carry. They are substituted
// out before the external-URL scan so the blanket https?:// rejection cannot
// block valid SVG, while any OTHER URL (fetchable or not) still rejects. The
// substitution placeholder contains no scheme, so it can never mask a real URL.
const SVG_ALLOWED_DECLARATION_URIS = [
	"http://www.w3.org/2000/svg",
	"http://www.w3.org/1999/xlink",
	"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd",
];

// Write-time floor for .svg mirroring validateRawHtmlArtifactContent (hardening
// 2026-07-17, amends the earlier "consumption-side only" posture): the in-app
// surfaces (<img>, CSP-sandboxed route) never execute SVG script, but an
// EXPORTED file leaves those protections behind, so the file itself must honor
// what the specialist prompt promises. Fragment hrefs (<use href="#id">) and
// url(#gradient) fills stay allowed — they are how real SVG is written.
export function validateRawSvgArtifactContent(body: string): void {
	const text = String(body ?? "");
	if (/<script\b/i.test(text)) throw new Error("Unsafe SVG is blocked: <script> tags are not allowed — the SVG must be fully static.");
	if (/\bon[a-z0-9_-]+\s*=/i.test(text)) throw new Error("Unsafe SVG is blocked: inline event handlers (for example onclick=, onload=) are not allowed — remove them; the SVG must be fully static.");
	if (/<\s*foreignObject\b/i.test(text)) throw new Error("Unsafe SVG is blocked: <foreignObject> is not allowed — draw with native SVG shapes and <text> elements instead.");
	if (/<\s*(iframe|object|embed)\b/i.test(text)) throw new Error("Unsafe SVG is blocked: iframe/object/embed tags are not allowed — the SVG must be fully self-contained.");
	let scan = text;
	for (const uri of SVG_ALLOWED_DECLARATION_URIS) scan = scan.split(uri).join("[ns]");
	if (/https?:\/\//i.test(scan)) throw new Error("Unsafe SVG is blocked: external http(s) URLs are not allowed anywhere, even in visible text — refer to sources by name instead of by URL.");
	if (/@import/i.test(scan)) throw new Error("Unsafe SVG is blocked: CSS @import is not allowed — put all styles inline.");
	assertSafeHrefSrcAttributes(scan, "Unsafe SVG is blocked");
}

function formatDeckWarningSummary(warnings: DeckSpecValidationIssue[]): string {
	if (!warnings.length) return "";
	const maxItems = 3;
	const shown = warnings.slice(0, maxItems).map((warning) => {
		const prefix = typeof warning.slide === "number" ? `Slide ${warning.slide}: ` : "";
		return `${prefix}${warning.message}`.trim();
	});
	const remaining = warnings.length - shown.length;
	return `Warnings: ${shown.join("; ")}${remaining > 0 ? `; and ${remaining} more` : ""}`;
}

function compactExcerpt(value: string | undefined, maxChars: number): string {
	const text = nonEmpty(value);
	if (!text) return "";
	const limited = limitText(text, maxChars);
	return limited.truncated ? `${limited.text} [truncated]` : limited.text;
}

function slideTitleFromText(text: string, fallbackIndex: number): string {
	const excerpt = compactExcerpt(text, 80);
	if (!excerpt) return `Slide ${fallbackIndex}`;
	return excerpt;
}

function formatInspectPptxSummary(target: ArtifactTarget, details: any): string {
	const lines: string[] = [];
	const destination = details?.metadata?.destination ?? target.destination.name;
	const relative = details?.metadata?.relativePath ?? target.relativePath.split(path.sep).join("/");
	const slideCount = Number(details?.slideCount ?? 0);
	lines.push(`Inspected PPTX: ${destination}/${relative}`);
	lines.push(`Slides: ${slideCount}`);

	const warnings: string[] = Array.isArray(details?.warnings) ? details.warnings : [];
	if (warnings.length) {
		lines.push("Warnings:");
		for (const warning of warnings.slice(0, PPTX_SUMMARY_MAX_WARNINGS)) lines.push(`- ${warning}`);
		if (warnings.length > PPTX_SUMMARY_MAX_WARNINGS) lines.push(`- [truncated] ${warnings.length - PPTX_SUMMARY_MAX_WARNINGS} more warning(s)`);
	} else {
		lines.push("Warnings: none");
	}

	const slides = Array.isArray(details?.slides) ? details.slides : [];
	if (slides.length) {
		lines.push("");
		lines.push("Per-slide summary:");
		for (const slide of slides.slice(0, PPTX_SUMMARY_MAX_SLIDES)) {
			const idx = Number(slide?.index ?? 0);
			const title = slideTitleFromText(slide?.text ?? "", idx || 1);
			const text = compactExcerpt(slide?.text, PPTX_SUMMARY_MAX_SLIDE_TEXT);
			const notes = compactExcerpt(slide?.speakerNotes, PPTX_SUMMARY_MAX_NOTES);
			const fonts = Array.isArray(slide?.styleHints?.fonts) ? slide.styleHints.fonts.slice(0, 4) : [];
			const colors = Array.isArray(slide?.styleHints?.colors) ? slide.styleHints.colors.slice(0, 4) : [];
			lines.push(`- Slide ${idx || "?"}: ${title}`);
			if (text) lines.push(`  Text: ${text}`);
			if (notes) lines.push(`  Notes: ${notes}`);
			if (fonts.length || colors.length) lines.push(`  Style: fonts=${fonts.join(", ") || "n/a"}; colors=${colors.join(", ") || "n/a"}`);
		}
		if (slides.length > PPTX_SUMMARY_MAX_SLIDES) lines.push(`- [truncated] ${slides.length - PPTX_SUMMARY_MAX_SLIDES} more slide(s)`);
	}

	const styleProfile = details?.styleProfile as DeckStyleProfile | undefined;
	if (styleProfile) {
		lines.push("");
		lines.push("Style profile (bounded, approximate):");
		if (styleProfile.slideSize?.width || styleProfile.slideSize?.height) lines.push(`Slide size: ${styleProfile.slideSize.width ?? "?"} × ${styleProfile.slideSize.height ?? "?"} ${styleProfile.slideSize.unit ?? ""}`.trim());
		const backgroundColors = styleProfile.colors.backgrounds.slice(0, 5).map((c) => `${c.value}×${c.count}`).join(", ");
		const textColors = styleProfile.colors.text.slice(0, 5).map((c) => `${c.value}×${c.count}`).join(", ");
		const fonts = styleProfile.fonts.slice(0, 5).map((f) => `${f.family}×${f.count}`).join(", ");
		const fontSizes = styleProfile.fontSizes.slice(0, 5).map((f) => `${f.value}${f.unit === "pptx-hundredth-pt" ? "/100pt" : f.unit}×${f.count}`).join(", ");
		lines.push(`Background colors: ${backgroundColors || "n/a"}`);
		lines.push(`Text colors: ${textColors || "n/a"}`);
		lines.push(`Fonts: ${fonts || "n/a"}`);
		lines.push(`Font sizes: ${fontSizes || "n/a"}`);
		if (styleProfile.layouts.length) lines.push(`Layout hints: ${styleProfile.layouts.slice(0, 5).map((l) => `slide ${l.slideNumber ?? "?"} ${l.kind} (${(l.roughRegions ?? []).join("/") || "regions n/a"})`).join("; ")}`);
		if (styleProfile.media.length) lines.push(`Media/logos: ${styleProfile.media.length} media item(s), ${styleProfile.media.filter((m) => m.likelyLogo).length} possible logo(s)`);
	}

	const assetInventory = Array.isArray(details?.assetInventory) ? details.assetInventory : [];
	const countsByType = new Map<string, number>();
	for (const asset of assetInventory) {
		const type = String(asset?.type || "(none)");
		countsByType.set(type, (countsByType.get(type) ?? 0) + 1);
	}
	const typeCounts = Array.from(countsByType.entries()).sort((a, b) => b[1] - a[1]);
	lines.push("");
	lines.push(`Asset inventory: ${assetInventory.length} item(s)`);
	if (typeCounts.length) {
		const shownTypes = typeCounts.slice(0, PPTX_SUMMARY_MAX_ASSET_TYPES).map(([type, count]) => `${type}: ${count}`);
		lines.push(`By type: ${shownTypes.join(", ")}`);
		if (typeCounts.length > PPTX_SUMMARY_MAX_ASSET_TYPES) lines.push(`[truncated] ${typeCounts.length - PPTX_SUMMARY_MAX_ASSET_TYPES} more asset type(s)`);
	}
	const sampleAssets = assetInventory.slice(0, PPTX_SUMMARY_MAX_ASSET_SAMPLES).map((asset: any) => String(asset?.name || ""));
	if (sampleAssets.length) {
		lines.push("Sample assets:");
		for (const asset of sampleAssets) lines.push(`- ${asset}`);
		if (assetInventory.length > PPTX_SUMMARY_MAX_ASSET_SAMPLES) lines.push(`- [truncated] ${assetInventory.length - PPTX_SUMMARY_MAX_ASSET_SAMPLES} more asset(s)`);
	}

	return lines.join("\n");
}

function suggestKebabBase(base: string): string {
	const lowered = base
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-");
	return lowered || "example-topic";
}

export type RenderedSlideImage = { slideNumber: number; pngBase64: string; bytes: number };

// ── HTML visual feedback loop (Playwright/Chromium, optional) ─────────────────────────────────────
// Decks are HTML, so they render locally and the model can SEE its own output and revise it.
// Playwright is an optional capability: the npm package may be present (it is a root dependency) but
// the Chromium browser binary is a separate download. Both are feature-detected; when either is
// missing the tool returns a clear install hint and the model falls back to authoring without eyes.
const HTML_PREVIEW_MAX_RENDER_SLIDES = 12;
const HTML_PREVIEW_SLIDE_W = 1280;
const HTML_PREVIEW_SLIDE_H = 720;
const HTML_PREVIEW_MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const HTML_PREVIEW_RENDER_TIMEOUT_MS = 30_000;

export type HtmlRenderAvailability = { available: boolean; playwright: boolean; browser: boolean; missing: string[]; installHint: string };

// Lazily resolve Playwright's chromium without importing it at module load, so the extension loads
// fine when Playwright is not installed.
async function loadPlaywrightChromium(): Promise<any | null> {
	try {
		const mod: any = await import("playwright");
		return mod?.chromium ?? mod?.default?.chromium ?? null;
	} catch {
		return null;
	}
}

export async function htmlRenderAvailability(): Promise<HtmlRenderAvailability> {
	const installHint = "Enable visual HTML preview by installing Playwright and a Chromium browser: `npm i playwright` then `npx playwright install chromium`.";
	const chromium = await loadPlaywrightChromium();
	if (!chromium) return { available: false, playwright: false, browser: false, missing: ["playwright"], installHint };
	let browser = false;
	try {
		const p = typeof chromium.executablePath === "function" ? chromium.executablePath() : "";
		browser = !!p && fs.existsSync(p);
	} catch { browser = false; }
	const missing: string[] = [];
	if (!browser) missing.push("a Chromium browser (run: npx playwright install chromium)");
	return { available: browser, playwright: true, browser, missing, installHint };
}

// Render self-contained deck HTML to per-slide PNGs offline (all network blocked). Each
// <section class="slide"> is framed to the fixed slide box and screenshotted. Always closes the
// browser; writes no file. The HTML must already have passed the self-contained safety check.
export async function renderDeckHtmlToSlideImages(html: string, options?: { maxSlides?: number }): Promise<{ images: RenderedSlideImage[]; rendererUsed: string }> {
	const chromium = await loadPlaywrightChromium();
	if (!chromium) throw new Error("Cannot render HTML slides: Playwright is not installed.");
	const maxSlides = Math.max(1, Math.min(HTML_PREVIEW_MAX_RENDER_SLIDES, options?.maxSlides ?? HTML_PREVIEW_MAX_RENDER_SLIDES));
	const browser = await chromium.launch({ headless: true });
	try {
		// javaScriptEnabled:false — this page renders MODEL-AUTHORED HTML in server-side
		// Chromium; a static screenshot never needs the page's own scripts, so they are
		// off wholesale rather than relying on the write-time blocklist alone. Locator
		// evaluate/screenshot below still work: they run over CDP, not as page scripts.
		const page = await browser.newPage({ viewport: { width: HTML_PREVIEW_SLIDE_W, height: HTML_PREVIEW_SLIDE_H }, deviceScaleFactor: 2, javaScriptEnabled: false });
		// Defense in depth: block all network. Safe deck HTML is fully self-contained, so nothing
		// legitimate is lost, and a missed external reference cannot reach out.
		await page.route("**/*", (route: any) => route.abort());
		await page.setContent(html, { waitUntil: "load", timeout: HTML_PREVIEW_RENDER_TIMEOUT_MS });
		const slides = page.locator("section.slide");
		const count = Math.min(await slides.count(), maxSlides);
		const images: RenderedSlideImage[] = [];
		for (let i = 0; i < count; i++) {
			const el = slides.nth(i);
			await el.evaluate((node: any, dims: { w: number; h: number }) => {
				node.style.width = dims.w + "px";
				node.style.height = dims.h + "px";
				node.scrollIntoView();
			}, { w: HTML_PREVIEW_SLIDE_W, h: HTML_PREVIEW_SLIDE_H });
			const buf: Buffer = await el.screenshot({ type: "png" });
			if (buf.byteLength > HTML_PREVIEW_MAX_IMAGE_BYTES) continue; // skip oversized frames rather than bloat the payload
			images.push({ slideNumber: i + 1, pngBase64: buf.toString("base64"), bytes: buf.byteLength });
		}
		if (images.length === 0) throw new Error("Rendering produced no usable slide images (no <section class=\"slide\"> found or all frames over the size cap).");
		return { images, rendererUsed: "playwright-chromium" };
	} finally {
		try { await browser.close(); } catch { /* best-effort cleanup */ }
	}
}

// Generic single-frame HTML→PNG preview (visuals V4 card thumbnails): the
// deck renderer above frames <section class="slide"> elements, but chart/
// document artifacts have no slide structure, so this screenshots the page
// itself. Same doctrine: network fully blocked, fixed viewport, size-capped.
export async function renderHtmlToPreviewImage(html: string): Promise<{ pngBase64: string; bytes: number } | null> {
	const chromium = await loadPlaywrightChromium();
	if (!chromium) return null;
	const browser = await chromium.launch({ headless: true });
	try {
		// Same doctrine as the deck renderer: model-authored HTML, so page scripts are
		// disabled outright — a preview screenshot never needs them.
		const page = await browser.newPage({ viewport: { width: HTML_PREVIEW_SLIDE_W, height: HTML_PREVIEW_SLIDE_H }, deviceScaleFactor: 2, javaScriptEnabled: false });
		await page.route("**/*", (route: any) => route.abort());
		await page.setContent(html, { waitUntil: "load", timeout: HTML_PREVIEW_RENDER_TIMEOUT_MS });
		const buf: Buffer = await page.screenshot({ type: "png" });
		if (buf.byteLength > HTML_PREVIEW_MAX_IMAGE_BYTES) return null;
		return { pngBase64: buf.toString("base64"), bytes: buf.byteLength };
	} finally {
		try { await browser.close(); } catch { /* best-effort cleanup */ }
	}
}

function evaluateDeckFilenameWarnings(filename: string): DeckSpecValidationIssue[] {
	const ext = path.extname(filename);
	const base = path.basename(filename, ext);
	const lowerBase = base.toLowerCase();
	const warnings: DeckSpecValidationIssue[] = [];
	const genericBases = new Set(["deck", "slides", "presentation", "output"]);
	const kebabCase = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

	if (genericBases.has(lowerBase)) {
		warnings.push({
			code: "filename_generic",
			message: "Filename is generic; consider a topic-specific kebab-case name.",
		});
	}

	if (!kebabCase.test(base)) {
		warnings.push({
			code: "filename_not_kebab_case",
			message: `Filename is safe but not lowercase kebab-case; consider '${suggestKebabBase(base)}.html'.`,
		});
	}

	if (base.length > 48) {
		warnings.push({
			code: "filename_long_base",
			message: "Filename base is long; consider a shorter kebab-case name.",
		});
	}

	return warnings;
}

/**
 * Parameterized factory. The default export stays the zero-option extension
 * every existing session uses; a specialist session passes a pre-approved
 * write scope so its delegation approval covers writes to one task folder.
 */
export function createArtifactsExtension(options: ArtifactsExtensionOptions = {}) {
	return (pi: ExtensionAPI) => registerArtifactTools(pi, options);
}

export default createArtifactsExtension();

function registerArtifactTools(pi: ExtensionAPI, options: ArtifactsExtensionOptions) {
	pi.registerTool({
		name: "artifact_destinations",
		label: "List artifact destinations",
		description: "List approved local artifact output destinations. The default destination is always ~/.exxperts/app/artifacts/.",
		promptSnippet: "Use `artifact_destinations` to see approved artifact output roots before saving somewhere outside the default artifact folder.",
		parameters: Type.Object({}),
		async execute() {
			try {
				const destinations = configuredDestinations();
				const text = destinations.map((d) => `- ${d.name}: ${d.path}${d.name === "default" ? " (built-in safe default)" : ""}`).join("\n");
				return { content: [{ type: "text", text }], details: { configPath: configPath(), destinations } };
			} catch (e) {
				return { content: [{ type: "text", text: (e as Error).message }], details: undefined, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "artifact_connect_destination",
		label: "Connect artifact destination",
		description: "Approve and save a local output folder as an artifact destination. V1 destinations must be existing folders inside the home directory.",
		promptSnippet: "Use `artifact_connect_destination` only when the user explicitly asks to save artifacts to a new local folder such as Desktop. It requires approval before the folder is added to ~/.exxperts/app/artifact-destinations.json.",
		parameters: Type.Object({
			name: Type.String({ description: "Short destination name, e.g. desktop or client-demo." }),
			path: Type.String({ description: "Existing local folder path inside the home directory, e.g. ~/Desktop." }),
			reason: Type.Optional(Type.String({ description: "Why this destination should be connected." })),
		}),
		async execute(_id, { name, path: destPath, reason }, _signal, _onUpdate, ctx) {
			try {
				const safeName = destinationName(name);
				const root = normaliseRoot(destPath);
				assertConnectableRoot(root);
				const existing = configuredDestinations().find((d) => d.name === safeName);
				const ok = await approve(ctx, existing ? "Update artifact destination?" : "Connect artifact destination?", [
					`Destination: ${safeName}`,
					`Folder: ${root}`,
					reason ? `Reason: ${reason}` : undefined,
					"",
					"Future artifact writes can target this approved root, but each durable file write will still require approval.",
				].filter(Boolean).join("\n"));
				if (!ok) return { content: [{ type: "text", text: "Artifact destination not connected; user approval missing or declined." }], details: { saved: false, destination: safeName, path: root }, isError: !ctx.hasUI };

				const config = readConfig();
				const destinations = (config.destinations ?? []).filter((d) => String(d.name).toLowerCase() !== safeName);
				destinations.push({ name: safeName, path: root, connectedAt: new Date().toISOString() });
				writeConfig({ ...config, destinations, lastUsed: safeName });
				ctx.ui.notify(`Connected artifact destination: ${safeName} → ${root}`, "info");
				return { content: [{ type: "text", text: `Connected artifact destination '${safeName}': ${root}` }], details: { saved: true, destination: safeName, path: root } };
			} catch (e) {
				return { content: [{ type: "text", text: (e as Error).message }], details: { saved: false }, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "artifact_disconnect_destination",
		label: "Disconnect artifact destination",
		description: "Remove an approved artifact output destination. Does not delete any files.",
		promptSnippet: "Use `artifact_disconnect_destination` when the user asks to remove an approved artifact output root. It requires approval and never deletes artifact files.",
		parameters: Type.Object({
			name: Type.String({ description: "Connected destination name to remove. Cannot be default." }),
			reason: Type.Optional(Type.String({ description: "Why this destination should be disconnected." })),
		}),
		async execute(_id, { name, reason }, _signal, _onUpdate, ctx) {
			try {
				const safeName = destinationName(name);
				const existing = configuredDestinations().find((d) => d.name === safeName);
				if (!existing) throw new Error(`Artifact destination is not connected: ${safeName}`);
				const ok = await approve(ctx, "Disconnect artifact destination?", [
					`Destination: ${safeName}`,
					`Folder: ${existing.path}`,
					reason ? `Reason: ${reason}` : undefined,
					"",
					"This removes the approved destination only. It does not delete files.",
				].filter(Boolean).join("\n"));
				if (!ok) return { content: [{ type: "text", text: "Artifact destination not disconnected; user approval missing or declined." }], details: { saved: false, destination: safeName }, isError: !ctx.hasUI };
				const config = readConfig();
				writeConfig({ ...config, destinations: (config.destinations ?? []).filter((d) => String(d.name).toLowerCase() !== safeName), lastUsed: config.lastUsed === safeName ? undefined : config.lastUsed });
				ctx.ui.notify(`Disconnected artifact destination: ${safeName}`, "info");
				return { content: [{ type: "text", text: `Disconnected artifact destination '${safeName}'. Files were not deleted.` }], details: { saved: true, destination: safeName } };
			} catch (e) {
				return { content: [{ type: "text", text: (e as Error).message }], details: { saved: false }, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "artifact_list",
		label: "List artifacts",
		description: "List saved local Markdown/HTML artifacts under an approved artifact destination. Does not open files.",
		promptSnippet: "Use `artifact_list` to show saved local `.md` and `.html` artifacts under the default or another approved artifact destination.",
		parameters: Type.Object({
			destination: Type.Optional(Type.String({ description: "Approved destination name. Default: default (~/.exxperts/app/artifacts)." })),
			limit: Type.Optional(Type.Number({ description: "Maximum artifacts to list. Default 200." })),
		}),
		async execute(_id, { destination, limit = 200 }) {
			try {
				const dest = resolveDestination(destination);
				const scope = options.readScope;
				if (scope && dest.name !== String(scope.destination).trim().toLowerCase()) {
					throw new Error(`This session can only list artifacts under the "${scope.destination}" destination.`);
				}
				fs.mkdirSync(dest.path, { recursive: true, mode: 0o700 });
				let artifacts = listArtifacts(dest.path, Math.min(Math.max(Number(limit) || 200, 1), 1000));
				// Read scope (specialist sessions): only the own task folder + declared
				// input artifacts are visible — other tasks' outputs never enumerate.
				if (scope) artifacts = artifacts.filter((a) => isWithinArtifactsReadScope(dest.name, a.path, scope));
				const text = artifacts.length
					? artifacts.map((a) => `- ${a.path} (${a.bytes} bytes, modified ${a.modified})`).join("\n")
					: `No Markdown/HTML artifacts found under ${dest.path}.`;
				return { content: [{ type: "text", text }], details: { destination: dest.name, root: dest.path, artifacts } };
			} catch (e) {
				return { content: [{ type: "text", text: (e as Error).message }], details: undefined, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "artifact_read",
		label: "Read artifact",
		description: "Read a saved local Markdown or HTML artifact under an approved destination. Returns raw content and does not execute HTML.",
		promptSnippet: "Use `artifact_read` to inspect a saved local `.md` or `.html` artifact. It returns raw content only; it does not open or execute HTML.",
		parameters: Type.Object({
			filename: Type.String({ description: "Relative artifact filename ending in .md or .html." }),
			destination: Type.Optional(Type.String({ description: "Approved destination name. Default: default (~/.exxperts/app/artifacts)." })),
			folder: Type.Optional(Type.String({ description: "Optional relative folder inside the destination." })),
			offset: Type.Optional(Type.Number({ description: "Byte offset to start reading from. Default 0. Large files are returned in slices; when truncated, the appended notice names the exact offset to pass on the next call." })),
		}),
		async execute(_id, { filename, destination, folder, offset }) {
			try {
				const startOffset = offset === undefined ? 0 : Number(offset);
				if (!Number.isInteger(startOffset) || startOffset < 0) throw new Error("offset must be a non-negative integer.");
				const target = validateArtifactPath(filename, destination, folder);
				// Read scope (specialist sessions): reject before the existence check so
				// the error never leaks whether an out-of-scope artifact exists.
				if (options.readScope && !isWithinArtifactsReadScope(target.destination.name, target.relativePath, options.readScope)) {
					throw new Error(`Artifact is outside this session's read scope: ${target.relativePath}`);
				}
				if (!fs.existsSync(target.fullPath)) throw new Error(`Artifact not found: ${target.relativePath}`);
				if (!fs.statSync(target.fullPath).isFile()) throw new Error(`Not a file: ${target.relativePath}`);
				const buf = fs.readFileSync(target.fullPath);
				// Slice bytes then toString, same as the single-read path — a slice
				// boundary can split a multi-byte char; byte offsets keep continuation
				// deterministic (the split char resolves across the two slices).
				const nextOffset = startOffset + MAX_READ_BYTES;
				const truncated = buf.byteLength > nextOffset;
				const text = buf.subarray(startOffset, nextOffset).toString("utf-8")
					+ (truncated ? `\n\n[truncated — file is ${buf.byteLength} bytes; call artifact_read again with offset=${nextOffset} to continue]` : "");
				const styleProfile = target.extension === ".html"
					? buildHtmlStyleProfile(text, `${target.destination.name}/${target.relativePath.split(path.sep).join("/")}`)
					: undefined;
				return { content: [{ type: "text", text }], details: { destination: target.destination.name, path: target.fullPath, relativePath: target.relativePath, truncated, styleProfile } };
			} catch (e) {
				return { content: [{ type: "text", text: (e as Error).message }], details: undefined, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "artifact_inspect_reference_style",
		label: "Inspect reference style",
		description: "Read-only bounded style inspection for pasted HTML or approved local HTML artifacts. Returns approximate colors, fonts, layout hints, media metadata, and caveats; does not execute HTML or write files.",
		promptSnippet: "Use `artifact_inspect_reference_style` for pasted HTML references or approved `.html` artifacts when the user asks to inspect/reference visible style. It returns bounded approximate style metadata only.",
		parameters: Type.Object({
			html: Type.Optional(Type.String({ description: "Pasted HTML content to inspect. Use this only when the user already provided/pasted it." })),
			filename: Type.Optional(Type.String({ description: "Approved relative .html artifact filename to inspect when html is not provided." })),
			destination: Type.Optional(Type.String({ description: "Approved destination name. Default: default (~/.exxperts/app/artifacts)." })),
			folder: Type.Optional(Type.String({ description: "Optional relative folder inside the destination." })),
		}),
		async execute(_id, { html, filename, destination, folder }) {
			try {
				const pasted = nonEmpty(html);
				let sourceLabel = "pasted-html";
				let body = pasted;
				let truncated = false;
				if (!body) {
					const target = validateArtifactPath(nonEmpty(filename), destination, folder, new Set([".html"]));
					if (target.extension !== ".html") throw new Error("Only .html is supported by artifact_inspect_reference_style path reads.");
					if (!fs.existsSync(target.fullPath)) throw new Error(`Artifact not found: ${target.relativePath}`);
					if (!fs.statSync(target.fullPath).isFile()) throw new Error(`Not a file: ${target.relativePath}`);
					const buf = fs.readFileSync(target.fullPath);
					truncated = buf.byteLength > MAX_READ_BYTES;
					body = buf.subarray(0, MAX_READ_BYTES).toString("utf-8");
					sourceLabel = `${target.destination.name}/${target.relativePath.split(path.sep).join("/")}`;
				} else if (Buffer.byteLength(body, "utf-8") > MAX_READ_BYTES) {
					const buf = Buffer.from(body, "utf-8");
					body = buf.subarray(0, MAX_READ_BYTES).toString("utf-8");
					truncated = true;
				}
				if (!body) throw new Error("Provide pasted html or an approved .html filename.");
				const styleProfile = buildHtmlStyleProfile(body, sourceLabel);
				if (truncated) styleProfile.caveats.push(`Input truncated at ${MAX_READ_BYTES} bytes before style inspection.`);
				return {
					content: [{ type: "text", text: formatStyleProfileSummary(styleProfile) }],
					details: { styleProfile, truncated },
				};
			} catch (e) {
				return { content: [{ type: "text", text: (e as Error).message }], details: undefined, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "artifact_inspect_pptx",
		label: "Inspect PPTX artifact",
		description: "Read-only PPTX inspection under approved artifact destinations. Parses PPTX ZIP metadata, slide text/notes, simple style hints, asset inventory metadata, and safety warnings.",
		promptSnippet: "Use `artifact_inspect_pptx` to inspect an approved local .pptx artifact safely without writing files. It only supports .pptx paths under approved artifact destinations.",
		parameters: Type.Object({
			filename: Type.String({ description: "Relative artifact filename ending in .pptx." }),
			destination: Type.Optional(Type.String({ description: "Approved destination name. Default: default (~/.exxperts/app/artifacts)." })),
			folder: Type.Optional(Type.String({ description: "Optional relative folder inside the destination." })),
		}),
		async execute(_id, { filename, destination, folder }) {
			try {
				const target = validateArtifactPath(filename, destination, folder, new Set([".pptx"]));
				if (target.extension !== ".pptx") throw new Error("Only .pptx is supported by artifact_inspect_pptx.");
				if (!fs.existsSync(target.fullPath)) throw new Error(`Artifact not found: ${target.relativePath}`);
				const stat = fs.statSync(target.fullPath);
				if (!stat.isFile()) throw new Error(`Not a file: ${target.relativePath}`);
				const details = await inspectPptxFile(target, stat);
				return {
					content: [{ type: "text", text: formatInspectPptxSummary(target, details) }],
					details,
				};
			} catch (e) {
				return { content: [{ type: "text", text: (e as Error).message }], details: undefined, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "artifact_write_html_deck",
		label: "Write HTML deck artifact",
		description: [
			"Create or replace a deterministic local HTML slide deck from structured slide data after user approval.",
			"Writes are restricted to the default artifact folder or an explicitly connected artifact destination.",
			"The generated HTML is self-contained with inline CSS only, no scripts, no external assets, no external font loading, and no auto-open/export behaviour.",
		].join(" "),
		promptSnippet:
			"Prefer `artifact_write_html_deck` for slide-deck creation once the user has answered the brief or approved defaults: use it when the user says make/create slides, create the deck, save the deck, save it as a slide deck, asks for an HTML/local deck, or asks to save a deck without explicitly requesting Markdown. Pass structured slide data, not raw HTML. It requires approval and writes only `.html` under the default or an approved artifact destination. The template is self-contained and exxperts-inspired with varied section layouts; if it references Bandeins/Sen, those fonts are not embedded and render only when locally available, with CSS fallbacks.",
		parameters: Type.Object({
			filename: Type.String({ description: "Relative artifact filename ending in .html." }),
			destination: Type.Optional(Type.String({ description: "Approved destination name. Default: default (~/.exxperts/app/artifacts)." })),
			folder: Type.Optional(Type.String({ description: "Optional relative folder inside the destination." })),
			title: Type.String({ description: "Deck title." }),
			subtitle: Type.Optional(Type.String({ description: "Optional deck subtitle." })),
			audience: Type.Optional(Type.String({ description: "Optional target audience." })),
			footer: Type.Optional(Type.String({ description: "Optional footer text shown on each slide." })),
			slides: Type.Array(Type.Object({
				title: Type.String({ description: "Slide title." }),
				keyMessage: Type.Optional(Type.String({ description: "One sentence main message for the slide." })),
				bullets: Type.Optional(Type.Array(Type.String(), { description: "Concise slide bullets." })),
				speakerNote: Type.Optional(Type.String({ description: "Optional speaker note." })),
				visualIdea: Type.Optional(Type.String({ description: "Optional visual idea." })),
			}), { description: "Ordered slide data. One HTML section is generated per slide." }),
			reason: Type.Optional(Type.String({ description: "Why this deck artifact should be saved." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				const target = validateArtifactPath(params.filename, params.destination, params.folder);
				if (target.extension !== ".html") throw new Error("HTML deck artifacts must use a .html filename.");
				const deckSpec = normaliseDeckSpecV1(params as HtmlDeckInput);
				const preValidation = validateDeckSpecV1(deckSpec);
				if (preValidation.errors.length > 0) {
					return {
						content: [{ type: "text", text: `Deck validation failed: ${preValidation.errors.map((e) => e.message).join(" ")}` }],
						details: { saved: false, validation: preValidation },
						isError: true,
					};
				}
				const body = renderHtmlDeckFromSpec(deckSpec, { footer: params.footer });
				const postValidation = validateRenderedHtmlDeck(deckSpec, body);
				if (postValidation.errors.length > 0) {
					return {
						content: [{ type: "text", text: `Rendered HTML deck validation failed: ${postValidation.errors.map((e) => e.message).join(" ")}` }],
						details: { saved: false, validation: postValidation },
						isError: true,
					};
				}
				const filenameWarnings = evaluateDeckFilenameWarnings(target.relativePath);
				const warnings = [...preValidation.warnings, ...postValidation.warnings, ...filenameWarnings];
				const grant = preApprovedWriteDecision(target, Buffer.byteLength(body.trimEnd() + "\n", "utf-8"), options.preApprovedWriteScope);
				if (grant.rejected) throw new Error(grant.rejected);

				const exists = fs.existsSync(target.fullPath);
				const warningSummary = formatDeckWarningSummary(warnings);
				const ok = grant.granted ? true : await approve(
					ctx,
					exists ? "Replace local HTML deck?" : "Create local HTML deck?",
					[
						...targetDetail(target, exists, params.reason),
						`Title: ${nonEmpty(params.title)}`,
						`Slides: ${Array.isArray(params.slides) ? params.slides.length : 0}`,
						warningSummary ? "" : undefined,
						warningSummary || undefined,
						"",
						"Generated HTML preview:",
						approvalPreviewContent(body),
					].filter(Boolean).join("\n"),
				);
				if (!ok) {
					return {
						content: [{ type: "text", text: "HTML deck artifact not saved; user approval missing or declined." }],
						details: { saved: false, path: target.fullPath, destination: target.destination.name },
						isError: !ctx.hasUI,
					};
				}

				fs.mkdirSync(path.dirname(target.fullPath), { recursive: true, mode: 0o700 });
				fs.writeFileSync(target.fullPath, body.trimEnd() + "\n", { mode: 0o600 });
				ctx.ui.notify(`Saved HTML deck artifact: ${target.fullPath}`, "info");
				const baseText = `${exists ? "Replaced" : "Created"} local HTML deck artifact: ${target.fullPath}`;
				return {
					content: [{ type: "text", text: warningSummary ? `${baseText}\n${warningSummary}` : baseText }],
					details: { saved: true, destination: target.destination.name, path: target.fullPath, relativePath: target.relativePath, replaced: exists, slides: deckSpec.slides.length, warnings },
				};
			} catch (e) {
				return { content: [{ type: "text", text: (e as Error).message }], details: { saved: false }, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "artifact_write",
		label: "Write artifact",
		description: [
			"Create or replace a local Markdown, HTML, or SVG artifact after user approval.",
			"Writes are restricted to the default artifact folder or an explicitly connected artifact destination.",
			"Pass raw final content; this tool does not auto-open, export, convert, or template artifacts.",
		].join(" "),
		promptSnippet:
			"Use `artifact_write` when the user explicitly asks to SAVE content as a local file: a non-deck Markdown/HTML artifact, a Markdown deck/outline, or a raw `.html` matching an accessible HTML reference deck/template's CSS/layout closely. For generic saved slide decks prefer `artifact_write_html_deck`. CREATING a designed visual deliverable (chart, diagram, deck, one-pager) is different from saving: when specialist delegation (`delegate_task`) is available, propose that instead of authoring the file here. Requires approval; writes only .md/.html/.svg under the default or an approved artifact destination.",
		parameters: Type.Object({
			filename: Type.String({ description: "Relative artifact filename ending in .md, .html, or .svg." }),
			destination: Type.Optional(Type.String({ description: "Approved destination name. Default: default (~/.exxperts/app/artifacts)." })),
			folder: Type.Optional(Type.String({ description: "Optional relative folder inside the destination." })),
			content: Type.String({ description: "Raw Markdown, HTML, or SVG content to save." }),
			reason: Type.Optional(Type.String({ description: "Why this artifact should be saved." })),
		}),
		async execute(_id, { filename, destination, folder, content, reason }, _signal, _onUpdate, ctx) {
			try {
				const target = validateArtifactPath(filename, destination, folder);
				const body = String(content ?? "");
				if (!body.trim()) throw new Error("Artifact content is empty.");
				if (target.extension === ".html") validateRawHtmlArtifactContent(body);
				if (target.extension === ".svg") validateRawSvgArtifactContent(body);
				const contentBytes = Buffer.byteLength(body.trimEnd() + "\n", "utf-8");
				if (target.extension === ".svg" && contentBytes > MAX_SVG_ARTIFACT_BYTES) {
					throw new Error(`SVG artifacts are capped at ${MAX_SVG_ARTIFACT_BYTES} bytes (got ${contentBytes}).`);
				}
				const grant = preApprovedWriteDecision(target, contentBytes, options.preApprovedWriteScope);
				if (grant.rejected) throw new Error(grant.rejected);

				const exists = fs.existsSync(target.fullPath);
				const ok = grant.granted ? true : await approve(
					ctx,
					exists ? "Replace local artifact?" : "Create local artifact?",
					[
						...targetDetail(target, exists, reason),
						"",
						"Content preview:",
						approvalPreviewContent(body),
					].join("\n"),
				);
				if (!ok) {
					return {
						content: [{ type: "text", text: "Artifact not saved; user approval missing or declined." }],
						details: { saved: false, path: target.fullPath, destination: target.destination.name },
						isError: !ctx.hasUI,
					};
				}

				fs.mkdirSync(path.dirname(target.fullPath), { recursive: true, mode: 0o700 });
				fs.writeFileSync(target.fullPath, body.trimEnd() + "\n", { mode: 0o600 });
				ctx.ui.notify(`Saved artifact: ${target.fullPath}`, "info");
				return {
					content: [{ type: "text", text: `${exists ? "Replaced" : "Created"} local artifact: ${target.fullPath}` }],
					details: { saved: true, destination: target.destination.name, path: target.fullPath, relativePath: target.relativePath, replaced: exists },
				};
			} catch (e) {
				return { content: [{ type: "text", text: (e as Error).message }], details: { saved: false }, isError: true };
			}
		},
	});
}
