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
import * as crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import JSZip from "jszip";
import PptxGenJS from "pptxgenjs";
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
const PPTX_DRAFT_REPORT_MAX_SUMMARY = 6;
const PPTX_DRAFT_REPORT_MAX_ISSUES = 8;
const PPTX_DRAFT_REPORT_MAX_PREVIEW_SLIDES = 10;
const PPTX_DRAFT_REPORT_MAX_TITLE = 100;
const PPTX_DRAFT_REPORT_MAX_KEY_MESSAGE = 140;
const PPTX_WORKBENCH_TTL_MS = 6 * 60 * 60 * 1000;
const PPTX_WORKBENCH_MAX_SUMMARY_ISSUES = 6;
const PPTX_WORKBENCH_UPDATE_MAX_SLIDE_CHANGES = 8;
const PPTX_WORKBENCH_UPDATE_MAX_CODES = 8;
const PPTX_WORKBENCH_HTML_PREVIEW_MAX_CHARS = 16_000;
const REFERENCE_PREVIEW_MAX_HTML_BYTES = 200_000;
const REFERENCE_CONTEXT_MAX_LAYOUT_SLIDES = 8;
const REFERENCE_CONTEXT_MAX_FONTS = 6;
const RENDER_PLAN_MAX_ELEMENTS_PER_SLIDE = 24;
const RENDER_PLAN_MIN_FONT_PT = 8;
const RENDER_PLAN_MAX_FONT_PT = 96;
const RENDER_PLAN_SAFE_FONT_FALLBACKS = ["Arial", "Helvetica", "Georgia", "Times New Roman", "Courier New", "Verdana", "Tahoma", "sans-serif", "serif", "monospace"];
const PPTX_WORKBENCH_REPAIR_MAX_ISSUES = 8;
const PPTX_WORKBENCH_ASSIST_MAX_BULLETS = 6;
const PPTX_WORKBENCH_ASSIST_MAX_TEXT = 220;
const BLANK_WORKBENCH_MIN_SLIDES = 3;
const BLANK_WORKBENCH_MAX_SLIDES = 15;
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

export type DeckSpecDraftIntent = {
	contentUse?: "reuse_all" | "reuse_selected" | "summarize" | "inspiration_only";
	styleUse?: "reuse_theme" | "reuse_layout_patterns" | "inspiration_only" | "ignore";
	notesUse?: "reuse" | "summarize" | "ignore";
};

export type DeckSpecDraftSlide = DeckSpecSlide & {
	source?: { slideIndex: number; slideId?: string; entry?: string };
	speakerNotes?: string;
};

export type DeckSpecDraftFromPptxInspection = Omit<DeckSpecV1, "slides"> & {
	design: NonNullable<DeckSpecV1["design"]>;
	intent: Required<DeckSpecDraftIntent> & { styleFidelity: "best_effort" | "ignored" };
	slides: DeckSpecDraftSlide[];
	warnings: DeckSpecValidationIssue[];
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

export type DeckSpecDraftValidationReport = {
	ready: boolean;
	errors: DeckSpecValidationIssue[];
	warnings: DeckSpecValidationIssue[];
	summary: string[];
};

export type PrepareDeckSpecDraftOptions = {
	requireReady?: boolean;
};

// The only supported workbench origin is a scratch deck built from the user's own
// grilled content. Reference PPTX/HTML files are attached as style-only evidence
// (see attachDeckWorkbenchFormatReference); their content is never imported.
type DeckWorkbenchReuseIntent = "scratch";

type WorkbenchRepairTarget = {
	id: string;
	severity: "warning" | "error" | "blocking";
	slideId?: string;
	slideIndex?: number;
	field?: "title" | "keyMessage" | "bullets" | "speakerNotes" | "design" | "intent" | "structure";
	category: "deterministic-fixable" | "suggestion-needed" | "user-required";
	deterministicAction?: {
		type: "trim_whitespace" | "remove_empty_bullets" | "dedupe_same_slide_bullets";
		safe: true;
	};
	suggestedAssistAction?: {
		type: "suggest_title" | "suggest_key_message" | "suggest_decision_ask" | "suggest_warning_repair";
		scopeRequired: true;
	};
	why: string;
};

type DeckWorkbenchAssistField = "title" | "keyMessage" | "bullets" | "speakerNotes" | "visualIdea";
type DeckWorkbenchAssistAction = "rewrite_bullets" | "suggest_key_message" | "critique_slide" | "suggest_repair_target";

type DeckWorkbenchAssistDetails = {
	assistContextVersion: string;
	workbenchId: string;
	affectedScope: {
		slideIndex: number;
		slideId: string;
		sourceSlideId?: string;
		field: DeckWorkbenchAssistField;
	};
	assistAction: DeckWorkbenchAssistAction;
	selectedContent: string | string[];
	slideContext: {
		title: string;
		keyMessage: string;
		bullets: string[];
		speakerNotes: string;
	};
	deckContext: {
		title: string;
		subtitle: string;
		audience: string;
		goal: string;
		reuseIntent: DeckWorkbenchReuseIntent;
	};
	validationContextUsed: {
		ready: boolean;
		summary: string[];
		relevantTargets: Array<{ id: string; category: WorkbenchRepairTarget["category"]; field: WorkbenchRepairTarget["field"]; severity: WorkbenchRepairTarget["severity"] }>;
		repairTargetId?: string;
	};
	constraints: string[];
	noMutation: true;
	caveat: string;
	error?: { code: string; message: string };
};

type DeckWorkbenchRepairDetails = {
	workbenchId: string;
	apply: boolean;
	proposedChanges: Array<Record<string, unknown>>;
	appliedChanges: Array<Record<string, unknown>>;
	skippedIssues: Array<{ code: string; slide?: number; message: string }>;
	preValidation: ReturnType<typeof summarizeDeckWorkbenchValidation>;
	postValidation: ReturnType<typeof summarizeDeckWorkbenchValidation>;
	caveat: string;
};

export type DeckWorkbenchUiRepairResult = DeckWorkbenchRepairDetails & {
	snapshot: DeckWorkbenchUiSnapshot;
};

type DeckWorkbenchFormatReference = {
	sourceType: "pptx" | "html";
	sourceLabel: string;
	evidenceStatus: "approximate_style_evidence_available";
};

type DeckWorkbenchState = {
	id: string;
	createdAt: string;
	updatedAt: string;
	source: {
		kind: "reference_pptx" | "scratch";
		destination?: string;
		relativePath?: string;
		path?: string;
		title?: string;
		audience?: string;
		goal?: string;
		size?: number;
		modified?: string;
		slideCount: number;
		extractionVersion?: string;
	};
	formatReference?: DeckWorkbenchFormatReference;
	referenceStyleProfile?: DeckStyleProfile;
	reuseIntent: DeckWorkbenchReuseIntent;
	intent: Required<DeckSpecDraftIntent>;
	draft: DeckSpecDraftFromPptxInspection;
	validation: DeckSpecDraftValidationReport;
};

const deckWorkbenchStore = new Map<string, DeckWorkbenchState>();

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

function walkScopeFiles(scopeRoot: string): { count: number; totalBytes: number } {
	let count = 0;
	let totalBytes = 0;
	const walk = (dir: string) => {
		if (!fs.existsSync(dir)) return;
		for (const name of fs.readdirSync(dir)) {
			// Dot-entries (e.g. server-written .thumbs previews) never count against
			// the model's caps — SAFE_SEGMENT already makes them unwritable by tools.
			if (name.startsWith(".")) continue;
			const file = path.join(dir, name);
			const stat = fs.lstatSync(file);
			if (stat.isDirectory()) walk(file);
			else if (stat.isFile()) { count += 1; totalBytes += stat.size; }
		}
	};
	walk(scopeRoot);
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
	const perFileCap = scopedPerFileCap(target.extension, scope);
	if (contentBytes > perFileCap) {
		return { granted: false, rejected: `Artifact exceeds the ${target.extension} size cap for this task (${contentBytes} > ${perFileCap} bytes).` };
	}
	const scopeRoot = path.resolve(target.root, ...scope.folder.split("/").filter(Boolean));
	const existing = walkScopeFiles(scopeRoot);
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

export type ResolvedPastedPptxPath =
	| { approved: true; destination: string; folder: string; filename: string }
	| { approved: false; needsConnection: true; suggestedRoot: string; suggestedName: string; filename: string };

export function resolvePastedPptxPath(inputPath: string): ResolvedPastedPptxPath {
	const rawInput = String(inputPath ?? "").trim();
	if (!rawInput) throw new Error("Paste an absolute local .pptx path.");
	const expandedInput = expandHome(rawInput);
	if (!path.extname(expandedInput).toLowerCase().endsWith(".pptx")) throw new Error("Only .pptx files are supported.");
	if (!path.isAbsolute(expandedInput)) {
		throw new Error("Relative paths are not supported here. Use Destination/Folder/Deck file fields for approved references.");
	}
	const fullPath = path.resolve(expandedInput);
	const filename = path.basename(fullPath);
	for (const destination of configuredDestinations()) {
		const root = path.resolve(destination.path);
		if (fullPath !== root && !fullPath.startsWith(root + path.sep)) continue;
		const relative = path.relative(root, fullPath);
		const folderRaw = path.dirname(relative);
		const folder = folderRaw === "." ? "" : folderRaw.split(path.sep).join("/");
		return {
			approved: true,
			destination: destination.name,
			folder,
			filename,
		};
	}
	const suggestedRoot = path.dirname(fullPath);
	const suggestedName = suggestDestinationNameFromPath(suggestedRoot);
	return {
		approved: false,
		needsConnection: true,
		suggestedRoot,
		suggestedName,
		filename,
	};
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
		if (attr !== "href") throw new Error(`${errorPrefix}: src attribute detected (external/local assets are not allowed).`);
		if (!value) throw new Error(`${errorPrefix}: empty href attribute is not allowed.`);
		if (!value.startsWith("#")) throw new Error(`${errorPrefix}: only same-document fragment links (href="#id") are allowed; '${value}' is not.`);
		const fragment = value.slice(1);
		if (!fragment) throw new Error(`${errorPrefix}: empty fragment href ("#") is not allowed.`);
		if (!/^[A-Za-z][\w-]*$/.test(fragment)) throw new Error(`${errorPrefix}: fragment href '${value}' is not a simple same-document element id.`);
		if (options?.validateFragmentTargets) {
			if (!ids) ids = collectElementIds(html);
			if (!ids.has(fragment)) throw new Error(`${errorPrefix}: fragment link '${value}' points to a missing element id.`);
		}
	}
}

function validateRawHtmlArtifactContent(body: string): void {
	const text = String(body ?? "");
	if (/<script\b/i.test(text)) throw new Error("Unsafe HTML is blocked: <script> tags are not allowed.");
	if (/\bon[a-z0-9_-]+\s*=/i.test(text)) throw new Error("Unsafe HTML is blocked: inline event handlers (for example onclick=, onload=) are not allowed.");
	if (/https?:\/\//i.test(text)) throw new Error("Unsafe HTML is blocked: external http(s) URLs are not allowed.");
	if (/@import/i.test(text)) throw new Error("Unsafe HTML is blocked: CSS @import is not allowed.");
	if (/<\s*(iframe|object|embed)\b/i.test(text)) throw new Error("Unsafe HTML is blocked: iframe/object/embed tags are not allowed.");
	// Same-document fragment links (href="#id") are allowed for static navigation; src and every
	// other href scheme/path remain blocked.
	assertSafeHrefSrcAttributes(text, "Unsafe HTML is blocked");
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

function suggestDestinationNameFromPath(folderPath: string): string {
	const baseName = path.basename(folderPath).toLowerCase();
	const candidate = baseName.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return candidate || "artifact-destination";
}

function formatDeckDraftReportIssueList(items: DeckSpecValidationIssue[], maxItems: number): string[] {
	const lines = items.slice(0, maxItems).map((item) => {
		const prefix = typeof item.slide === "number" ? `slide ${item.slide}: ` : "";
		return `- ${item.code}: ${prefix}${item.message}`;
	});
	if (items.length > maxItems) lines.push(`- [truncated] ${items.length - maxItems} more issue(s)`);
	return lines;
}

function getDeckWorkbenchOrError(workbenchId: string): DeckWorkbenchState {
	const id = nonEmpty(workbenchId);
	if (!id) throw new Error("workbenchId is required.");
	const state = deckWorkbenchStore.get(id);
	if (!state) throw new Error(`Deck workbench not found: ${id}.`);
	const ageMs = Date.now() - Date.parse(state.updatedAt || state.createdAt);
	if (Number.isFinite(ageMs) && ageMs > PPTX_WORKBENCH_TTL_MS) {
		deckWorkbenchStore.delete(id);
		throw new Error(`Deck workbench expired: ${id}. Create a new workbench from the source PPTX.`);
	}
	return state;
}

function formatDeckWorkbenchSummary(state: DeckWorkbenchState): string {
	const lines: string[] = [];
	lines.push("Deck workbench: ready");
	if (state.source.kind === "scratch") {
		lines.push(`Source: scratch plan (${state.source.title || state.draft.title || "Untitled"})`);
	} else {
		lines.push(`Source: ${state.source.destination}/${state.source.relativePath}`);
	}
	lines.push(`Slides: ${state.source.slideCount}; Draft slides: ${Array.isArray(state.draft.slides) ? state.draft.slides.length : 0}`);
	lines.push(`Readiness: ready=${state.validation.ready ? "true" : "false"}`);
	if (state.validation.errors.length) lines.push(`Errors: ${state.validation.errors.slice(0, PPTX_WORKBENCH_MAX_SUMMARY_ISSUES).map((e) => e.code).join(", ")}`);
	if (state.validation.warnings.length) lines.push(`Warnings: ${state.validation.warnings.slice(0, PPTX_WORKBENCH_MAX_SUMMARY_ISSUES).map((w) => w.code).join(", ")}`);
	lines.push(state.source.kind === "scratch"
		? "Caveat: Scratch workbench is transient/session-only; no file is written and no PPTX output/export is performed."
		: "Caveat: PPTX is inspection-only reference input; no PPTX output/export/rendering is performed.");
	return lines.join("\n");
}

export type CreateDeckWorkbenchFromApprovedPptxResult = {
	workbenchId: string;
	snapshot: DeckWorkbenchUiSnapshot;
	validation: {
		ready: boolean;
		summary: string[];
		errorCount: number;
		warningCount: number;
		repairTargetCount: number;
	};
	caveat: string;
};

export type AttachDeckWorkbenchFormatReferenceInput = {
	workbenchId: string;
	filename: string;
	destination?: string;
	folder?: string;
};

export type AttachDeckWorkbenchFormatReferenceResult = {
	workbenchId: string;
	snapshot: DeckWorkbenchUiSnapshot;
	validation: {
		ready: boolean;
		summary: string[];
		errorCount: number;
		warningCount: number;
		repairTargetCount: number;
	};
	caveat: string;
};

export type CanonicalDeckStructurePreset = "executive" | "consulting" | "technical" | "minimal";
export type DeckStructurePresetAlias = "executive_review" | "executive-review" | "strategy" | "consulting_deck" | "technical_review";

export type CreateBlankDeckWorkbenchInput = {
	title: string;
	subtitle?: string;
	audience?: string;
	goal?: string;
	slideCount?: number;
	structurePreset?: CanonicalDeckStructurePreset | DeckStructurePresetAlias;
	slides?: Array<{
		title: string;
		keyMessage?: string;
		bullets?: string[];
		speakerNotes?: string;
		visualIdea?: string;
	}>;
};

export function normaliseDeckStructurePreset(input: unknown): CanonicalDeckStructurePreset {
	const raw = nonEmpty(input);
	if (!raw) return "executive";
	const normalised = raw.toLowerCase();
	if (["executive", "consulting", "technical", "minimal"].includes(normalised)) return normalised as CanonicalDeckStructurePreset;
	if (normalised === "executive_review" || normalised === "executive-review") return "executive";
	if (normalised === "strategy" || normalised === "consulting_deck") return "consulting";
	if (normalised === "technical_review") return "technical";
	throw new Error("structurePreset must be one of: executive, consulting, technical, minimal.");
}

function createBlankWorkbenchSlides(input: {
	title: string;
	audience?: string;
	goal?: string;
	slideCount: number;
	structurePreset: CanonicalDeckStructurePreset;
}): DeckSpecDraftSlide[] {
	const planByPreset: Record<CanonicalDeckStructurePreset, Array<{ title: string; keyMessage: string; bullets: string[] }>> = {
		executive: [
			{ title: "Decision context & tension", keyMessage: "Frame the decision and why now.", bullets: ["Current context and trigger", "What happens if we wait", "Decision needed in this meeting"] },
			{ title: "Evidence & current state", keyMessage: "Show facts that support the decision pressure.", bullets: ["Baseline performance snapshot", "Key constraints and dependencies", "Signals from stakeholders/customers"] },
			{ title: "Options & trade-offs", keyMessage: "Compare realistic paths and trade-offs.", bullets: ["Option A (benefits/risks)", "Option B (benefits/risks)", "Cost, speed, and risk comparison"] },
			{ title: "Recommendation", keyMessage: "State the preferred path and why.", bullets: ["Recommended option", "Rationale linked to goal", "Mitigations for top risks"] },
			{ title: "Decision ask & next steps", keyMessage: "Make the ask explicit and define immediate follow-up.", bullets: ["Decision requested today", "Next 30-day execution steps", "Owner and checkpoint timing"] },
		],
		consulting: [
			{ title: "Situation", keyMessage: "Define the client situation and scope.", bullets: ["Context and business need", "In-scope / out-of-scope", "Objective for this deck"] },
			{ title: "Diagnosis", keyMessage: "Summarize core findings and root causes.", bullets: ["What analysis shows", "Root-cause hypotheses", "Impact if unchanged"] },
			{ title: "Strategic options", keyMessage: "Present options with clear implications.", bullets: ["Option 1", "Option 2", "Trade-offs and constraints"] },
			{ title: "Proposed approach", keyMessage: "Outline recommended approach and value.", bullets: ["Recommended route", "Expected business impact", "Delivery principles"] },
			{ title: "Delivery plan", keyMessage: "Define phases, owners, and next commitments.", bullets: ["Phase plan", "Roles and ownership", "Immediate next actions"] },
		],
		technical: [
			{ title: "Problem & target outcome", keyMessage: "Clarify technical problem and desired outcome.", bullets: ["Current pain points", "Target architecture/outcome", "Success criteria"] },
			{ title: "Current architecture", keyMessage: "Show baseline system and constraints.", bullets: ["Current components", "Bottlenecks and risks", "Non-functional constraints"] },
			{ title: "Options", keyMessage: "Compare implementation options.", bullets: ["Option A design", "Option B design", "Complexity, risk, timeline"] },
			{ title: "Recommended design", keyMessage: "State selected design and rationale.", bullets: ["Chosen architecture", "Why this option", "Risk controls"] },
			{ title: "Execution plan", keyMessage: "Translate design into delivery steps.", bullets: ["Implementation phases", "Dependencies", "Validation and rollout steps"] },
		],
		minimal: [
			{ title: "Context", keyMessage: "Set context for the audience.", bullets: ["Why this matters", "Current status"] },
			{ title: "Key points", keyMessage: "Highlight the most important facts.", bullets: ["Point 1", "Point 2", "Point 3"] },
			{ title: "Recommendation", keyMessage: "State recommendation clearly.", bullets: ["Preferred direction", "Why now"] },
			{ title: "Next steps", keyMessage: "Define immediate actions.", bullets: ["Action 1", "Action 2", "Owner"] },
			{ title: "Decision ask", keyMessage: "Close with explicit ask.", bullets: ["Decision requested", "Decision timeline"] },
		],
	};
	const base = planByPreset[input.structurePreset] ?? planByPreset.executive;
	const selected = Array.from({ length: input.slideCount }, (_v, i) => base[i % base.length]);
	return selected.map((entry, index) => ({
		id: `scratch-slide-${index + 1}`,
		type: index === 0 ? "title" : "bullets",
		title: index === 0 ? `${entry.title}` : entry.title,
		keyMessage: entry.keyMessage,
		bullets: entry.bullets,
		speakerNotes: input.goal ? `Goal: ${input.goal}` : undefined,
		visualIdea: `Simple storyboard visual for: ${entry.title}`,
	}));
}

export function createBlankDeckWorkbench(input: CreateBlankDeckWorkbenchInput): CreateDeckWorkbenchFromApprovedPptxResult {
	const title = nonEmpty(input.title);
	if (!title) throw new Error("title is required.");
	const subtitle = nonEmpty(input.subtitle) || undefined;
	const audience = nonEmpty(input.audience) || undefined;
	const goal = nonEmpty(input.goal) || undefined;
	const preset = normaliseDeckStructurePreset(input.structurePreset);
	const providedSlides = Array.isArray(input.slides) ? input.slides : [];
	const hasProvidedSlides = providedSlides.length > 0;
	const rawSlideCount = hasProvidedSlides
		? providedSlides.length
		: (Number.isInteger(input.slideCount) ? Number(input.slideCount) : 5);
	const slideCount = Math.max(BLANK_WORKBENCH_MIN_SLIDES, Math.min(BLANK_WORKBENCH_MAX_SLIDES, rawSlideCount || 5));
	if (hasProvidedSlides && providedSlides.length !== slideCount) {
		throw new Error(`slides length must be between ${BLANK_WORKBENCH_MIN_SLIDES} and ${BLANK_WORKBENCH_MAX_SLIDES}.`);
	}

	const normalisedProvidedSlides: DeckSpecDraftSlide[] = hasProvidedSlides
		? providedSlides.map((slide, index) => {
			const slideTitle = nonEmpty(slide?.title);
			if (!slideTitle) throw new Error(`Slide ${index + 1} title is required.`);
			const bullets = Array.isArray(slide?.bullets)
				? slide.bullets.map((bullet) => nonEmpty(bullet)).filter(Boolean)
				: [];
			return {
				id: `scratch-slide-${index + 1}`,
				type: bullets.length >= 2 ? "bullets" : "content",
				title: slideTitle,
				keyMessage: nonEmpty(slide?.keyMessage) || undefined,
				bullets,
				speakerNotes: nonEmpty(slide?.speakerNotes) || undefined,
				visualIdea: nonEmpty(slide?.visualIdea) || undefined,
			};
		})
		: [];

	const now = new Date().toISOString();
	const workbenchId = `wb_${crypto.randomUUID()}`;
	const draft: DeckSpecDraftFromPptxInspection = {
		version: "1.0",
		artifactType: "deck",
		title,
		subtitle,
		audience,
		design: { source: "preset", preset, density: "medium" },
		intent: { contentUse: "reuse_all", styleUse: "reuse_layout_patterns", notesUse: "ignore", styleFidelity: "ignored" },
		slides: hasProvidedSlides ? normalisedProvidedSlides : createBlankWorkbenchSlides({ title, audience, goal, slideCount, structurePreset: preset }),
		warnings: [],
	};
	const validation = validateDeckSpecDraftForWorkbench(draft);
	const state: DeckWorkbenchState = {
		id: workbenchId,
		createdAt: now,
		updatedAt: now,
		source: {
			kind: "scratch",
			title,
			audience,
			goal,
			slideCount,
			modified: now,
		},
		reuseIntent: "scratch",
		intent: draft.intent,
		draft,
		validation,
	};
	deckWorkbenchStore.set(workbenchId, state);
	const snapshot = getDeckWorkbenchUiSnapshot(workbenchId, 1, validation);
	return {
		workbenchId,
		snapshot,
		validation: {
			ready: snapshot.validation.ready,
			summary: snapshot.validation.summary,
			errorCount: snapshot.validation.errorCount,
			warningCount: snapshot.validation.warningCount,
			repairTargetCount: snapshot.validation.repairTargetCount,
		},
		caveat: "Scratch workbench created as transient/session-only state. No file is written.",
	};
}

// Attach approved PPTX style evidence to an existing content-only workbench. This is read/inspect
// only: it extracts a bounded style profile and stores it on transient state. It never writes
// files, never requests approval, and never seeds, replaces, or mutates slide content.
export async function attachDeckWorkbenchFormatReference(input: AttachDeckWorkbenchFormatReferenceInput): Promise<AttachDeckWorkbenchFormatReferenceResult> {
	const state = getDeckWorkbenchOrError(input.workbenchId);
	const target = validateArtifactPath(input.filename, input.destination, input.folder, new Set([".pptx"]));
	if (target.extension !== ".pptx") throw new Error("Only .pptx is supported.");
	if (!fs.existsSync(target.fullPath)) throw new Error(`Artifact not found: ${target.relativePath}`);
	const stat = fs.statSync(target.fullPath);
	if (!stat.isFile()) throw new Error(`Not a file: ${target.relativePath}`);

	const inspection = await inspectPptxFile(target, stat);
	if (!inspection?.styleProfile) throw new Error("Reference style profile could not be extracted from the approved .pptx.");
	state.formatReference = {
		sourceType: inspection.styleProfile.sourceType,
		sourceLabel: inspection.styleProfile.sourceLabel,
		evidenceStatus: "approximate_style_evidence_available",
	};
	state.referenceStyleProfile = inspection.styleProfile;
	state.updatedAt = new Date().toISOString();
	deckWorkbenchStore.set(state.id, state);
	const snapshot = getDeckWorkbenchUiSnapshot(state.id, 1);
	return {
		workbenchId: state.id,
		snapshot,
		validation: {
			ready: snapshot.validation.ready,
			summary: snapshot.validation.summary,
			errorCount: snapshot.validation.errorCount,
			warningCount: snapshot.validation.warningCount,
			repairTargetCount: snapshot.validation.repairTargetCount,
		},
		caveat: "Format reference attached as approximate style evidence only; workbench content/slide count remains unchanged.",
	};
}

export type DeckWorkbenchUiSnapshot = {
	workbenchId: string;
	createdAt?: string;
	updatedAt?: string;
	source?: {
		destination?: string;
		relativePath?: string;
		path?: string;
		filename?: string;
	};
	formatReference?: DeckWorkbenchFormatReference;
	reuseIntent: DeckWorkbenchReuseIntent;
	deckTitle: string;
	deckSubtitle?: string;
	validation: {
		ready: boolean;
		summary: string[];
		errorCount: number;
		warningCount: number;
		repairTargetCount: number;
	};
	slideCount: number;
	slides: Array<{ index: number; id: string; title: string; keyMessage?: string; bullets: string[]; speakerNotes?: string; visualIdea?: string }>;
	selectedSlide: {
		index: number;
		id: string;
		title: string;
		keyMessage?: string;
		bullets: string[];
		speakerNotes?: string;
		visualIdea?: string;
	};
};

export function getDeckWorkbenchUiSnapshot(
	workbenchId: string,
	slideIndex?: number,
	validationOverride?: DeckSpecDraftValidationReport,
): DeckWorkbenchUiSnapshot {
	const state = getDeckWorkbenchOrError(workbenchId);
	const validation = validationOverride ?? state.validation;
	const slides = Array.isArray(state.draft.slides) ? state.draft.slides : [];
	const selectedIndex = Number.isInteger(slideIndex) && (slideIndex as number) >= 1 && (slideIndex as number) <= slides.length
		? (slideIndex as number)
		: 1;
	const selected = slides[selectedIndex - 1] ?? { id: "slide-1", title: "Slide 1", keyMessage: "", bullets: [], speakerNotes: "", visualIdea: "" };
	const repairTargets = buildWorkbenchRepairTargets(state.draft, validation);
	return {
		workbenchId: state.id,
		createdAt: state.createdAt,
		updatedAt: state.updatedAt,
		source: {
			destination: state.source.destination,
			relativePath: state.source.relativePath,
			path: state.source.path,
			filename: path.basename(state.source.relativePath || state.source.path || state.source.title || ""),
		},
		formatReference: state.formatReference,
		reuseIntent: state.reuseIntent,
		deckTitle: state.draft.title || "",
		deckSubtitle: state.draft.subtitle,
		validation: {
			ready: validation.ready,
			summary: validation.summary.slice(0, PPTX_WORKBENCH_MAX_SUMMARY_ISSUES),
			errorCount: validation.errors.length,
			warningCount: validation.warnings.length,
			repairTargetCount: repairTargets.length,
		},
		slideCount: slides.length,
		slides: slides.map((slide, idx) => ({
			index: idx + 1,
			id: slide.id,
			title: slide.title || `Slide ${idx + 1}`,
			keyMessage: slide.keyMessage,
			bullets: Array.isArray(slide.bullets) ? slide.bullets : [],
			speakerNotes: slide.speakerNotes,
			visualIdea: slide.visualIdea,
		})),
		selectedSlide: {
			index: selectedIndex,
			id: selected.id,
			title: selected.title || "Slide 1",
			keyMessage: selected.keyMessage,
			bullets: Array.isArray(selected.bullets) ? selected.bullets : [],
			speakerNotes: selected.speakerNotes,
			visualIdea: selected.visualIdea,
		},
	};
}

export function previewDeckWorkbenchHtmlForUi(input: {
	workbenchId: string;
	footer?: string;
	selectedSlideIndex?: number;
	maxPreviewChars?: number;
}): DeckWorkbenchUiPreview {
	const state = getDeckWorkbenchOrError(input.workbenchId);
	const validation = validateDeckSpecDraftForWorkbench(state.draft);
	const ready = Boolean(validation.ready);

	if (!ready) {
		return {
			workbenchId: state.id,
			ready,
			validation: {
				summary: validation.summary.slice(0, PPTX_DRAFT_REPORT_MAX_SUMMARY),
				errors: validation.errors.slice(0, PPTX_WORKBENCH_MAX_SUMMARY_ISSUES),
				warnings: validation.warnings.slice(0, PPTX_WORKBENCH_MAX_SUMMARY_ISSUES),
			},
			renderedValidation: { errors: [], warnings: [] },
			htmlPreview: "",
			htmlPreviewTruncated: false,
			htmlBytes: 0,
			slideCount: Array.isArray(state.draft.slides) ? state.draft.slides.length : 0,
			caveat: "HTML preview only; no file write and no PPTX output/export performed.",
			snapshot: getDeckWorkbenchUiSnapshot(state.id, input.selectedSlideIndex, validation),
		};
	}

	const prepared = prepareDeckSpecDraftForHtmlRendering(state.draft);
	const html = renderHtmlDeckFromSpec(prepared, { footer: nonEmpty(input.footer) || undefined });
	const renderedValidation = validateRenderedHtmlDeck(prepared, html);
	const htmlBytes = Buffer.byteLength(html, "utf-8");
	const preview = Number.isFinite(input.maxPreviewChars) && (input.maxPreviewChars as number) > 0
		? limitText(html, Math.floor(input.maxPreviewChars as number))
		: { text: html, truncated: false };
	return {
		workbenchId: state.id,
		ready,
		validation: {
			summary: validation.summary.slice(0, PPTX_DRAFT_REPORT_MAX_SUMMARY),
			errors: validation.errors.slice(0, PPTX_WORKBENCH_MAX_SUMMARY_ISSUES),
			warnings: validation.warnings.slice(0, PPTX_WORKBENCH_MAX_SUMMARY_ISSUES),
		},
		renderedValidation: {
			errors: renderedValidation.errors.slice(0, PPTX_WORKBENCH_MAX_SUMMARY_ISSUES),
			warnings: renderedValidation.warnings.slice(0, PPTX_WORKBENCH_MAX_SUMMARY_ISSUES),
		},
		htmlPreview: preview.text,
		htmlPreviewTruncated: preview.truncated,
		htmlBytes,
		slideCount: prepared.slides.length,
		caveat: "HTML preview only; no file write and no PPTX output/export performed.",
		snapshot: getDeckWorkbenchUiSnapshot(state.id, input.selectedSlideIndex, validation),
	};
}

function sanitiseReferenceHexColor(value: string | undefined, fallback: string): string {
	const raw = nonEmpty(value).replace(/^#/, "");
	if (/^[0-9a-fA-F]{3}$/.test(raw) || /^[0-9a-fA-F]{6}$/.test(raw) || /^[0-9a-fA-F]{8}$/.test(raw)) return `#${raw.toUpperCase()}`;
	return fallback;
}

function pickReferenceColor(items: Array<{ value: string; count: number }>, fallback: string): string {
	for (const item of items) {
		const safe = sanitiseReferenceHexColor(item.value, "");
		if (safe) return safe;
	}
	return sanitiseReferenceHexColor(fallback, "#000000") || "#000000";
}

function referenceHexLuminance(hex: string): number {
	const raw = hex.replace(/^#/, "");
	if (!/^[0-9a-fA-F]{6}$/.test(raw)) return 0;
	const r = parseInt(raw.slice(0, 2), 16) / 255;
	const g = parseInt(raw.slice(2, 4), 16) / 255;
	const b = parseInt(raw.slice(4, 6), 16) / 255;
	const linear = [r, g, b].map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
	return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function pickReferencePalette(profile: DeckStyleProfile): { bg: string; fg: string; accent: string } {
	const backgroundCandidates = profile.colors.backgrounds.map((item) => ({ color: sanitiseReferenceHexColor(item.value, ""), count: item.count })).filter((item) => item.color);
	const textCandidates = profile.colors.text.map((item) => ({ color: sanitiseReferenceHexColor(item.value, ""), count: item.count })).filter((item) => item.color);
	const bg = (backgroundCandidates[0]?.color || pickReferenceColor(profile.colors.backgrounds, "#111111")).toUpperCase();
	const bgLum = referenceHexLuminance(bg);
	let fg = (textCandidates[0]?.color || (bgLum < 0.45 ? "#FFFFFF" : "#111111")).toUpperCase();
	const contrast = Math.abs(referenceHexLuminance(fg) - bgLum);
	if (contrast < 0.35) fg = bgLum < 0.45 ? "#FFFFFF" : "#111111";

	const visiblePalette = new Set<string>([bg, fg]);
	for (const item of [...backgroundCandidates, ...textCandidates].slice(0, 8)) visiblePalette.add(item.color.toUpperCase());
	const accentCandidate = profile.colors.accents
		.map((item) => sanitiseReferenceHexColor(item.value, "").toUpperCase())
		.find((color) => color && visiblePalette.has(color));
	const accent = accentCandidate || fg;
	return { bg, fg, accent };
}

// A reference-style preview must be grounded in an explicit reference, never a generic default.
// We require both a real (hex) background and a real text colour extracted from the reference;
// otherwise the preview is reported as unavailable instead of rendering the #111111 fallback.
function hasUsableReferenceStylePalette(profile: DeckStyleProfile): boolean {
	const hasBackground = profile.colors.backgrounds.some((item) => sanitiseReferenceHexColor(item.value, "") !== "");
	const hasText = profile.colors.text.some((item) => sanitiseReferenceHexColor(item.value, "") !== "");
	return hasBackground && hasText;
}

function pickReferenceFont(profile: DeckStyleProfile): string {
	const fallback = "Arial, Helvetica, sans-serif";
	const familyRaw = nonEmpty(profile.fonts[0]?.family).replace(/["']/g, "");
	const family = familyRaw.replace(/[^A-Za-z0-9 ._-]/g, "").trim().replace(/\s+/g, " ");
	if (!family) return fallback;
	return `"${htmlEscape(family)}", ${fallback}`;
}

function pickReferenceDensity(profile: DeckStyleProfile): "low" | "medium" | "high" {
	const avgTextBoxes = profile.layouts.length
		? profile.layouts.reduce((sum, layout) => sum + (layout.textBoxCount ?? 0), 0) / profile.layouts.length
		: 0;
	if (avgTextBoxes >= 4.5) return "high";
	if (avgTextBoxes >= 2.5) return "medium";
	return "low";
}

function pickReferenceFontSizesPx(profile: DeckStyleProfile): { titlePx: number; bodyPx: number } {
	const fromPt = profile.fontSizes
		.filter((item) => item.unit === "pt" || item.unit === "pptx-hundredth-pt")
		.map((item) => item.unit === "pptx-hundredth-pt" ? item.value / 100 : item.value)
		.filter((value) => Number.isFinite(value) && value > 0)
		.sort((a, b) => b - a);
	const fromPx = profile.fontSizes
		.filter((item) => item.unit === "px")
		.map((item) => item.value)
		.filter((value) => Number.isFinite(value) && value > 0)
		.sort((a, b) => b - a);
	const titlePt = fromPt[0] ?? 36;
	const bodyPt = fromPt[Math.min(2, fromPt.length - 1)] ?? 20;
	const titlePx = fromPx[0] ?? Math.round(titlePt * 1.3333);
	const bodyPx = fromPx[Math.min(2, fromPx.length - 1)] ?? Math.round(bodyPt * 1.3333);
	return {
		titlePx: Math.max(28, Math.min(86, titlePx)),
		bodyPx: Math.max(16, Math.min(34, bodyPx)),
	};
}

function renderDeckWorkbenchReferenceHtml(deck: DeckSpecV1, profile: DeckStyleProfile, footer?: string): string {
	const { bg, fg, accent } = pickReferencePalette(profile);
	const fontFamily = pickReferenceFont(profile);
	const density = pickReferenceDensity(profile);
	const size = pickReferenceFontSizesPx(profile);
	const footerText = nonEmpty(footer) || deck.title;
	const pad = density === "high" ? "36px" : density === "medium" ? "52px" : "70px";
	const gap = density === "high" ? "14px" : density === "medium" ? "20px" : "28px";
	const caveat = "Approximate reference-style preview only. Not exact PPTX fidelity. No PPTX export/output.";
	const slides = deck.slides.map((slide, i) => {
		const bullets = (slide.bullets ?? []).length
			? `<ul>${(slide.bullets ?? []).map((bullet) => `<li>${htmlEscape(bullet)}</li>`).join("")}</ul>`
			: "";
		return `
		<section class="slide">
			<div class="kicker">Reference-style preview · ${i + 1}/${deck.slides.length}</div>
			<h2>${htmlEscape(slide.title)}</h2>
			${slide.keyMessage ? `<p class="message">${htmlEscape(slide.keyMessage)}</p>` : ""}
			${bullets}
			${slide.speakerNote ? `<p class="note"><strong>Speaker note:</strong> ${htmlEscape(slide.speakerNote)}</p>` : ""}
			${slide.visualIdea ? `<p class="note"><strong>Visual idea:</strong> ${htmlEscape(slide.visualIdea)}</p>` : ""}
			<div class="footer">${htmlEscape(footerText)}</div>
		</section>`;
	}).join("\n");
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>${htmlEscape(deck.title)} · reference-style preview</title>
	<style>
		* { box-sizing: border-box; }
		body { margin: 0; background: ${bg}; color: ${fg}; font-family: ${fontFamily}; }
		main { width: 100%; }
		.slide { min-height: 100vh; padding: ${pad}; display: flex; flex-direction: column; gap: ${gap}; border-bottom: 2px solid ${accent}; }
		.kicker { color: ${accent}; letter-spacing: 0.1em; text-transform: uppercase; font-size: 12px; }
		h2 { margin: 0; font-size: clamp(${Math.max(26, size.titlePx - 10)}px, 5.5vw, ${size.titlePx}px); line-height: 1.05; }
		.message { margin: 0; font-size: clamp(${Math.max(16, size.bodyPx - 4)}px, 2.8vw, ${size.bodyPx}px); max-width: 44ch; }
		ul { margin: 0; padding-left: 1.15em; max-width: 50ch; }
		li { margin: 0 0 0.35em; font-size: clamp(${Math.max(14, size.bodyPx - 6)}px, 2.4vw, ${Math.max(18, size.bodyPx - 2)}px); }
		.note { margin: 0; opacity: 0.9; font-size: clamp(13px, 1.6vw, 18px); max-width: 65ch; }
		.footer { margin-top: auto; opacity: 0.85; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; }
		.caveat { position: sticky; bottom: 0; width: 100%; background: ${bg}; color: ${accent}; border-top: 1px solid ${accent}; padding: 10px 14px; font-size: 12px; }
	</style>
</head>
<body>
	<main>${slides}
	</main>
	<div class="caveat">${htmlEscape(caveat)}</div>
</body>
</html>`;
}

export function previewDeckWorkbenchReferenceHtmlForUi(input: {
	workbenchId: string;
	footer?: string;
	selectedSlideIndex?: number;
	maxPreviewChars?: number;
}): DeckWorkbenchUiPreview {
	const state = getDeckWorkbenchOrError(input.workbenchId);
	const validation = validateDeckSpecDraftForWorkbench(state.draft);
	if (!state.referenceStyleProfile || !state.formatReference) throw new Error("Reference-style preview requires retained reference style evidence.");
	const structurallyRenderable = validation.errors.length === 0;
	if (!structurallyRenderable) throw new Error("Workbench is not structurally renderable for reference-style HTML preview.");
	if (!hasUsableReferenceStylePalette(state.referenceStyleProfile)) {
		throw new Error("Reference-style preview unavailable: the reference did not yield a usable background/text palette. Attach a PPTX reference with explicit colors instead of relying on a generic default style.");
	}
	const prepared = prepareDeckSpecDraftForHtmlRendering(state.draft, { requireReady: false });
	const html = renderDeckWorkbenchReferenceHtml(prepared, state.referenceStyleProfile, nonEmpty(input.footer) || undefined);
	assertSafeSelfContainedDeckHtml(html, prepared.slides.length);
	const htmlBytes = Buffer.byteLength(html, "utf-8");
	const preview = Number.isFinite(input.maxPreviewChars) && (input.maxPreviewChars as number) > 0
		? limitText(html, Math.floor(input.maxPreviewChars as number))
		: { text: html, truncated: false };
	return {
		workbenchId: state.id,
		ready: structurallyRenderable,
		validation: {
			summary: validation.summary.slice(0, PPTX_DRAFT_REPORT_MAX_SUMMARY),
			errors: validation.errors.slice(0, PPTX_WORKBENCH_MAX_SUMMARY_ISSUES),
			warnings: validation.warnings.slice(0, PPTX_WORKBENCH_MAX_SUMMARY_ISSUES),
		},
		renderedValidation: { errors: [], warnings: [] },
		htmlPreview: preview.text,
		htmlPreviewTruncated: preview.truncated,
		htmlBytes,
		slideCount: prepared.slides.length,
		caveat: "Approximate reference-style preview only; no exact PPTX fidelity, no file write, and no PPTX output/export.",
		snapshot: getDeckWorkbenchUiSnapshot(state.id, input.selectedSlideIndex, validation),
	};
}

// Shared safe self-contained deck HTML assertion. Reused by the deterministic reference renderer
// preview and the model-generated reference-style preview. Throws on the first violation so unsafe
// or structurally-wrong HTML is rejected (never silently rendered).
function assertSafeSelfContainedDeckHtml(html: string, expectedSlideCount: number): void {
	if (/<script\b/i.test(html)) throw new Error("Reference-style preview safety check failed: script tag detected.");
	if (/\bon[a-z0-9_-]+\s*=/i.test(html)) throw new Error("Reference-style preview safety check failed: inline event handler detected (for example onclick=, onload=, onerror=).");
	if (/<iframe\b/i.test(html)) throw new Error("Reference-style preview safety check failed: iframe tag detected.");
	if (/@import/i.test(html)) throw new Error("Reference-style preview safety check failed: @import detected.");
	if (/https?:\/\//i.test(html)) throw new Error("Reference-style preview safety check failed: external URL detected.");
	if (/\burl\s*\(/i.test(html)) throw new Error("Reference-style preview safety check failed: url() detected.");
	if (/\bfile\s*:/i.test(html)) throw new Error("Reference-style preview safety check failed: file: detected.");
	if (/\bdata\s*:/i.test(html)) throw new Error("Reference-style preview safety check failed: data: detected.");
	// Allow only same-document fragment links (href="#slide-2") for static deck navigation; reject
	// src and every external/local/actionable href. Fragment targets must exist as element ids.
	assertSafeHrefSrcAttributes(html, "Reference-style preview safety check failed", { validateFragmentTargets: true });
	const renderedSlides = (html.match(/<section\s+class="slide"/gi) ?? []).length;
	if (renderedSlides !== expectedSlideCount) throw new Error(`Reference-style preview safety check failed: expected ${expectedSlideCount} <section class="slide"> block(s), found ${renderedSlides}.`);
}

const REFERENCE_HTML_CONTRACT: string[] = [
	"Return one complete, self-contained <!doctype html> document ending in </html>, with inline <style> only.",
	'Render exactly one <section class="slide"> per workbench slide, in order; do not add, drop, merge, or reorder slides.',
	"Render only the provided workbench slide content; do not invent, summarise, or restyle the words.",
	"No <script>, no <iframe>, no @import, no url(), no external http(s) URLs, no src= attributes, and no data:/file: references. The only href allowed is a same-document fragment link for static navigation (e.g. href=\"#slide-2\" pointing at a section id present in the document); every other href (external/local/actionable scheme, root/relative path, or empty) is rejected.",
	"Paste recommendedFontStack verbatim into CSS and apply it to ALL text selectors (html, body, .slide, h1, h2, h3, p, li, .kicker, .footer), not only body. Name the extracted reference fonts by family first, then safe fallbacks (e.g. font-family: \"Bandeins Strange\", \"Sen\", Arial, sans-serif). Do not embed fonts, do not use @font-face, and do not load remote/local font files.",
	"Use layoutEvidence to vary slide compositions (background, title scale/region, density, dividers/blocks/shape motifs, image/logo presence) instead of one generic template; approximate the reference's visible style only.",
	'Include a short visible caveat (or HTML comment) that this is an approximate reference-style preview — not exact PPTX fidelity and not a PPTX export — and the line: "Fonts are referenced by name only and render if installed locally; no fonts are embedded."',
	`Keep the whole document under ${REFERENCE_PREVIEW_MAX_HTML_BYTES} bytes; tighten markup rather than truncating.`,
];

// Sanitise an extracted font family name for safe use in a CSS font-family value.
function sanitiseReferenceFontName(family: string): string {
	return nonEmpty(family).replace(/["']/g, "").replace(/[^A-Za-z0-9 ._-]/g, "").trim().replace(/\s+/g, " ");
}

// Build a CSS font-family stack: extracted local reference font names first, then safe fallbacks.
function buildReferenceFontStack(fontNames: string[]): string {
	const named = fontNames
		.map(sanitiseReferenceFontName)
		.filter(Boolean)
		.slice(0, 3)
		.map((name) => `"${name}"`);
	return [...named, "Arial", "Helvetica", "sans-serif"].join(", ");
}

// Extracted reference font family names, deduped/sanitised and bounded. Shared by the context tool
// (to recommend a stack) and the preview tool (to check the model actually used them).
function referenceFontNamesFromProfile(profile: DeckStyleProfile): string[] {
	// Role fonts first (so heading/body are always allowed and surfaced), then frequency order.
	const role = [profile.roleFonts?.heading, profile.roleFonts?.body].map((f) => sanitiseReferenceFontName(f ?? "")).filter(Boolean);
	const freq = profile.fonts.map((f) => sanitiseReferenceFontName(f.family)).filter(Boolean);
	return Array.from(new Set([...role, ...freq])).slice(0, REFERENCE_CONTEXT_MAX_FONTS);
}

// Heading/body font roles: prefer the size-measured roleFonts (heading = font used at title sizes);
// fall back to frequency order only when run-level pairing was unavailable (e.g. HTML references).
function pickRoleFonts(profile: DeckStyleProfile): { heading: string; body: string } {
	const names = referenceFontNamesFromProfile(profile);
	const heading = sanitiseReferenceFontName(profile.roleFonts?.heading || names[0] || "Arial") || "Arial";
	const bodyCandidate = profile.roleFonts?.body
		|| names.find((n) => n.toLowerCase() !== heading.toLowerCase())
		|| names[1] || names[0] || "Arial";
	const body = sanitiseReferenceFontName(bodyCandidate) || "Arial";
	return { heading, body };
}

// Explicit CSS authoring guidance so the model applies the local font stack broadly (not only on
// body) and understands why a named font may not render locally.
function buildReferenceCssGuidance(referenceFonts: string[], recommendedFontStack: string): string[] {
	const lines = [
		`Apply the font stack to every text selector, not only body: html, body, .slide, h1, h2, h3, p, li, .kicker, .footer { font-family: ${recommendedFontStack}; }`,
	];
	if (referenceFonts[0]) lines.push(`Use the first extracted display font "${referenceFonts[0]}" first in the stack for large headings (h1/h2/title).`);
	if (referenceFonts[1]) lines.push(`Use the second extracted body font "${referenceFonts[1]}" for body copy (p/li) if a separate body face reads better.`);
	lines.push("Include the CSS comment: /* Fonts are referenced by family name and render only if installed locally; no fonts are embedded. */");
	return lines;
}

export type ReferenceLayoutEvidence = {
	slideNumber?: number;
	kind: "title" | "content" | "section" | "unknown";
	background?: string;
	titleFontSizePt?: number;
	titleRegion?: string;
	fonts?: string[];
	textBoxCount?: number;
	roughRegions?: string[];
	density?: "sparse" | "medium" | "dense";
	shapeHints?: string[];
	imageCount?: number;
};

export type DeckWorkbenchReferenceHtmlContext = {
	workbenchId: string;
	slideCount: number;
	referenceSourceLabel: string;
	styleProfileSummary: string;
	referenceFonts: string[];
	recommendedFontStack: string;
	cssGuidance: string[];
	fontDebuggingNote: string;
	layoutEvidence: ReferenceLayoutEvidence[];
	slides: DeckWorkbenchUiSnapshot["slides"];
	htmlContract: string[];
	caveat: string;
};

// Step 1 of the two-step model-generated reference-style preview flow. Read-only: returns the
// retained attached style evidence plus current workbench content and the strict HTML contract so
// the model can author bespoke safe HTML before calling the preview tool. No mutation, no writes.
export function getDeckWorkbenchReferenceHtmlContext(input: { workbenchId: string }): DeckWorkbenchReferenceHtmlContext {
	const state = getDeckWorkbenchOrError(input.workbenchId);
	if (!state.referenceStyleProfile || !state.formatReference) {
		throw new Error("Reference-style context requires an attached formatting reference. Attach an approved PPTX with artifact_deck_workbench_attach_format_reference first.");
	}
	const validation = validateDeckSpecDraftForWorkbench(state.draft);
	if (validation.errors.length > 0) {
		throw new Error("Workbench is not structurally renderable yet; resolve content issues before generating a reference-style preview.");
	}
	if (!hasUsableReferenceStylePalette(state.referenceStyleProfile)) {
		throw new Error("Reference-style preview unavailable: the attached reference did not yield a usable background/text palette. Attach a PPTX reference with explicit colors instead of relying on a generic default style.");
	}
	const snapshot = getDeckWorkbenchUiSnapshot(state.id, undefined, validation);
	const profile = state.referenceStyleProfile;
	const referenceFonts = referenceFontNamesFromProfile(profile);
	const recommendedFontStack = buildReferenceFontStack(referenceFonts);
	const layoutEvidence: ReferenceLayoutEvidence[] = profile.layouts.slice(0, REFERENCE_CONTEXT_MAX_LAYOUT_SLIDES).map((l) => ({
		slideNumber: l.slideNumber,
		kind: l.kind,
		background: l.background,
		titleFontSizePt: l.titleFontSizePt,
		titleRegion: l.titleRegion,
		fonts: l.fonts,
		textBoxCount: l.textBoxCount,
		roughRegions: l.roughRegions,
		density: l.density,
		shapeHints: l.shapeHints,
		imageCount: l.imageCount,
	}));
	return {
		workbenchId: state.id,
		slideCount: snapshot.slideCount,
		referenceSourceLabel: state.formatReference.sourceLabel,
		styleProfileSummary: formatStyleProfileSummary(profile),
		referenceFonts,
		recommendedFontStack,
		cssGuidance: buildReferenceCssGuidance(referenceFonts, recommendedFontStack),
		fontDebuggingNote: "If a named font does not render in the preview it is almost certainly not installed locally, or the locally installed family name differs from the PPTX family name (e.g. a weight/variant suffix). Fonts are not embedded; install the family locally to see exact typography, otherwise the fallbacks apply.",
		layoutEvidence,
		slides: snapshot.slides,
		htmlContract: REFERENCE_HTML_CONTRACT,
		caveat: "Read-only context for reference-style HTML generation; no mutation, no file write, no PPTX export. Style matching is approximate, not exact PPTX fidelity. Fonts are named only and render if installed locally; nothing is embedded.",
	};
}

// Step 2: validate model-generated self-contained HTML and echo it back as a non-persistent RHS
// preview. Read-only: no mutation, no writes. Rejects unsafe/incomplete/oversized HTML instead of
// truncating, and requires one <section class="slide"> per workbench slide.
export function previewDeckWorkbenchReferenceHtmlDraftForUi(input: {
	workbenchId: string;
	html: string;
	footer?: string;
	selectedSlideIndex?: number;
}): DeckWorkbenchUiPreview {
	const state = getDeckWorkbenchOrError(input.workbenchId);
	if (!state.referenceStyleProfile || !state.formatReference) {
		throw new Error("Reference-style preview requires an attached formatting reference. Attach an approved PPTX with artifact_deck_workbench_attach_format_reference first.");
	}
	const validation = validateDeckSpecDraftForWorkbench(state.draft);
	if (validation.errors.length > 0) {
		throw new Error("Workbench is not structurally renderable for reference-style HTML preview.");
	}
	if (!hasUsableReferenceStylePalette(state.referenceStyleProfile)) {
		throw new Error("Reference-style preview unavailable: the attached reference did not yield a usable background/text palette. Attach a PPTX reference with explicit colors instead of relying on a generic default style.");
	}
	const prepared = prepareDeckSpecDraftForHtmlRendering(state.draft, { requireReady: false });
	const html = String(input.html ?? "");
	if (!html.trim()) throw new Error("Reference-style preview requires non-empty model-generated HTML.");
	const htmlBytes = Buffer.byteLength(html, "utf-8");
	if (htmlBytes > REFERENCE_PREVIEW_MAX_HTML_BYTES) {
		throw new Error(`Reference-style preview HTML is ${htmlBytes} bytes, over the ${REFERENCE_PREVIEW_MAX_HTML_BYTES}-byte limit; tighten the markup instead of truncating.`);
	}
	if (!/<!doctype html>/i.test(html)) throw new Error("Reference-style preview HTML must include <!doctype html>.");
	if (!/<\/html\s*>/i.test(html)) throw new Error("Reference-style preview HTML must include a closing </html> tag.");
	assertSafeSelfContainedDeckHtml(html, prepared.slides.length);

	// Soft check (does not block the preview): if the reference extracted local fonts but none of
	// their names appear in the submitted HTML, the model likely ignored recommendedFontStack.
	const renderedWarnings: DeckSpecValidationIssue[] = [];
	const referenceFonts = referenceFontNamesFromProfile(state.referenceStyleProfile);
	if (referenceFonts.length > 0) {
		const haystack = html.toLowerCase();
		const usedAnyReferenceFont = referenceFonts.some((name) => haystack.includes(name.toLowerCase()));
		if (!usedAnyReferenceFont) {
			renderedWarnings.push({
				code: "reference_fonts_not_used",
				message: `None of the extracted reference fonts (${referenceFonts.join(", ")}) appear in the submitted HTML. Paste the recommendedFontStack verbatim into the CSS font-family (applied across html, body, .slide, headings, p, li) so local fonts can render; regenerate once.`,
			});
		}
	}
	return {
		workbenchId: state.id,
		ready: true,
		validation: {
			summary: validation.summary.slice(0, PPTX_DRAFT_REPORT_MAX_SUMMARY),
			errors: validation.errors.slice(0, PPTX_WORKBENCH_MAX_SUMMARY_ISSUES),
			warnings: validation.warnings.slice(0, PPTX_WORKBENCH_MAX_SUMMARY_ISSUES),
		},
		renderedValidation: { errors: [], warnings: renderedWarnings },
		htmlPreview: html,
		htmlPreviewTruncated: false,
		htmlBytes,
		slideCount: prepared.slides.length,
		caveat: "Approximate model-generated reference-style preview only; not exact PPTX fidelity, no file write, and no PPTX output/export.",
		snapshot: getDeckWorkbenchUiSnapshot(state.id, input.selectedSlideIndex, validation),
	};
}

// Model-authored (no-reference) self-contained HTML preview. Mirrors the reference-style draft
// preview but has NO attached-reference requirement, no palette requirement, and no
// reference_fonts_not_used warning: the model authors the HTML from the approved workbench content
// using its own design judgement. Read-only: no mutation, no writes. Rejects unsafe/incomplete/
// oversized HTML instead of truncating, and requires one <section class="slide"> per workbench slide.
export function previewDeckWorkbenchAuthoredHtmlDraftForUi(input: {
	workbenchId: string;
	html: string;
	footer?: string;
	selectedSlideIndex?: number;
}): DeckWorkbenchUiPreview {
	const state = getDeckWorkbenchOrError(input.workbenchId);
	const validation = validateDeckSpecDraftForWorkbench(state.draft);
	if (validation.errors.length > 0) {
		throw new Error("Workbench is not structurally renderable for model-authored HTML preview; resolve the content issues first.");
	}
	const prepared = prepareDeckSpecDraftForHtmlRendering(state.draft, { requireReady: false });
	const html = String(input.html ?? "");
	if (!html.trim()) throw new Error("Model-authored HTML preview requires non-empty HTML.");
	const htmlBytes = Buffer.byteLength(html, "utf-8");
	if (htmlBytes > REFERENCE_PREVIEW_MAX_HTML_BYTES) {
		throw new Error(`Model-authored HTML preview is ${htmlBytes} bytes, over the ${REFERENCE_PREVIEW_MAX_HTML_BYTES}-byte limit; tighten the markup instead of truncating.`);
	}
	if (!/<!doctype html>/i.test(html)) throw new Error("Model-authored HTML preview must include <!doctype html>.");
	if (!/<\/html\s*>/i.test(html)) throw new Error("Model-authored HTML preview must include a closing </html> tag.");
	assertSafeSelfContainedDeckHtml(html, prepared.slides.length);
	return {
		workbenchId: state.id,
		ready: true,
		validation: {
			summary: validation.summary.slice(0, PPTX_DRAFT_REPORT_MAX_SUMMARY),
			errors: validation.errors.slice(0, PPTX_WORKBENCH_MAX_SUMMARY_ISSUES),
			warnings: validation.warnings.slice(0, PPTX_WORKBENCH_MAX_SUMMARY_ISSUES),
		},
		renderedValidation: { errors: [], warnings: [] },
		htmlPreview: html,
		htmlPreviewTruncated: false,
		htmlBytes,
		slideCount: prepared.slides.length,
		caveat: "Model-authored self-contained HTML preview; no file write, no PPTX export.",
		snapshot: getDeckWorkbenchUiSnapshot(state.id, input.selectedSlideIndex, validation),
	};
}

// ── Render-plan contract (Slice A.1: validation only — content-by-reference, no generation/write) ─
// The model authors a constrained DeckRenderPlanV1 from the approved workbench. Text is referenced
// (content.ref), never written, so the model cannot rewrite or invent words. Validation returns a
// sanitised normalizedPlan with the exact workbench text resolved; future generators must consume
// only that normalized plan, never the raw model JSON. Unknown fields are errors. The schema has no
// field that can express an external asset, macro, script, raw OOXML, url, or file path. No PPTX
// generation, no file write.

const RENDER_PLAN_TEXT_ELEMENT_TYPES = new Set(["title", "heading", "body", "bullets", "kicker", "footer", "note-caption"]);
const RENDER_PLAN_SHAPE_ELEMENT_TYPES = new Set(["divider", "block", "outline-rect"]);
const RENDER_PLAN_CONTENT_REFS = new Set(["title", "keyMessage", "bullets", "speakerNotes", "visualIdea", "slideNumber"]);

export type DeckRenderPlanContentRef = "title" | "keyMessage" | "bullets" | "speakerNotes" | "visualIdea" | "slideNumber";

export type DeckRenderPlanTextElement = {
	type: "title" | "heading" | "body" | "bullets" | "kicker" | "footer" | "note-caption";
	content: { ref: DeckRenderPlanContentRef };
	font: "heading" | "body";
	fontSizePt: number;
	color: string;
	align?: "left" | "center" | "right";
	x: number; y: number; w: number; h: number;
};

export type DeckRenderPlanShapeElement = {
	type: "divider" | "block" | "outline-rect";
	orientation?: "horizontal" | "vertical";
	fill?: string;
	line?: string;
	weightPt?: number;
	x: number; y: number; w: number; h: number;
};

export type DeckRenderPlanElement = DeckRenderPlanTextElement | DeckRenderPlanShapeElement;

export type DeckRenderPlanSlide = {
	sourceSlideId: string;
	background?: string;
	// A slide provides EITHER a high-level layout archetype (the engine composes designed,
	// well-typeset elements) OR hand-authored elements. Prefer layout for quality/consistency.
	layout?: DeckRenderPlanLayout;
	elements?: DeckRenderPlanElement[];
	includeSpeakerNotes?: boolean;
};

export type DeckRenderPlanLayout = "cover" | "section" | "statement" | "content" | "quote";

export type DeckRenderPlanV1 = {
	version: "1.0";
	palette: { background: string; text: string; accent?: string };
	fonts: { heading: string; body: string };
	slides: DeckRenderPlanSlide[];
};

// Sanitised, generator-ready plan: exact workbench text resolved; only validated fields retained.
export type NormalizedRenderTextElement = {
	type: DeckRenderPlanTextElement["type"];
	ref: DeckRenderPlanContentRef;
	text?: string;
	items?: string[];
	font: "heading" | "body";
	fontSizePt: number;
	color: string;
	align: "left" | "center" | "right";
	x: number; y: number; w: number; h: number;
};

export type NormalizedRenderShapeElement = {
	type: DeckRenderPlanShapeElement["type"];
	orientation?: "horizontal" | "vertical";
	fill?: string;
	line?: string;
	weightPt?: number;
	x: number; y: number; w: number; h: number;
};

export type NormalizedRenderElement = NormalizedRenderTextElement | NormalizedRenderShapeElement;

export type NormalizedRenderSlide = {
	sourceSlideId: string;
	background?: string;
	elements: NormalizedRenderElement[];
	speakerNotes?: string;
};

export type NormalizedDeckRenderPlan = {
	version: "1.0";
	palette: { background: string; text: string; accent?: string };
	fonts: { heading: string; body: string };
	slides: NormalizedRenderSlide[];
};

export type DeckRenderPlanValidationResult = {
	workbenchId: string;
	ready: boolean;
	slideCount: number;
	errors: DeckSpecValidationIssue[];
	warnings: DeckSpecValidationIssue[];
	allowed: { colors: string[]; fonts: string[]; textTypes: string[]; shapeTypes: string[]; contentRefs: string[]; layouts: string[] };
	normalizedPlan?: NormalizedDeckRenderPlan;
	caveat: string;
};

function isPlainHex6(value: unknown): value is string {
	return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

function looksUnsafeText(value: string): boolean {
	return /<\s*\/?\s*[a-z]|https?:\/\/|url\s*\(|@import|\bdata:|\bfile:|javascript:|\bsrc\s*=|\bhref\s*=/i.test(value);
}

// ── Designed layout engine ───────────────────────────────────────────────────────────────────────
// The model picks a layout archetype per slide (no coordinates, no font sizes). The engine composes
// well-typeset, consistently-aligned elements deterministically — large titles, a real type scale
// derived from the reference, generous margins, an accent rule, and properly spaced body copy. The
// composed elements are plain DeckRenderPlanElement objects that flow through the SAME validation and
// normalization as hand-authored ones, so safety (content-by-ref, allowed colors/fonts) is preserved.
const RENDER_PLAN_LAYOUTS = new Set<DeckRenderPlanLayout>(["cover", "section", "statement", "content", "quote"]);

// Shared grid: a single content column with generous, consistent side margins.
const LAYOUT_MARGIN_X = 0.07;
const LAYOUT_CONTENT_W = 0.86;

type ArchetypeContent = { hasTitle: boolean; hasSubtitle: boolean; hasBullets: boolean };
// Title/subtitle/body point sizes extracted and role-mapped from the reference deck.
type ReferenceTypeScale = { titlePt: number; subtitlePt: number; bodyPt: number; coverTitlePt: number };
type ArchetypeStyle = { text: string; accent: string; scale: ReferenceTypeScale; useDivider: boolean };

function clampInt(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, Math.round(value)));
}

// Normalise the reference's extracted font sizes to points (count = how often that size appears).
function referenceFontSizesPt(profile: DeckStyleProfile): Array<{ pt: number; count: number }> {
	return profile.fontSizes
		.map((f) => {
			const pt = f.unit === "pptx-hundredth-pt" ? f.value / 100 : f.unit === "px" ? f.value * 0.75 : f.value;
			return { pt, count: f.count > 0 ? f.count : 1 };
		})
		.filter((f) => Number.isFinite(f.pt) && f.pt >= 6 && f.pt <= 200);
}

function median(nums: number[]): number {
	if (!nums.length) return 0;
	const a = [...nums].sort((x, y) => x - y);
	const m = Math.floor(a.length / 2);
	return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// Map the reference's real font sizes to title/subtitle/body roles so generated decks mirror the
// reference's sizing. Content-slide titles use the TYPICAL (median) content title — never the max, and
// never the cover/title-page size (its outsized title would inflate every slide). The cover keeps its
// own larger size. Body prefers the most frequent smaller size; subtitle sits between.
function extractReferenceTypeScale(profile: DeckStyleProfile): ReferenceTypeScale {
	const sizes = referenceFontSizesPt(profile);
	const allDesc = sizes.map((s) => s.pt).sort((a, b) => b - a);
	const titlesOf = (ls: DeckStyleProfile["layouts"]) => ls.map((l) => l.titleFontSizePt).filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0);
	const contentTitles = titlesOf(profile.layouts.filter((l) => l.kind !== "title"));
	const coverTitles = titlesOf(profile.layouts.filter((l) => l.kind === "title"));
	const anyTitles = titlesOf(profile.layouts);
	const titleRaw = contentTitles.length ? median(contentTitles) : (anyTitles.length ? median(anyTitles) : 40);
	const coverRaw = coverTitles.length ? Math.max(...coverTitles) : titleRaw * 1.6;
	const bodyCandidates = sizes.filter((s) => s.pt <= titleRaw * 0.7);
	const bodyRaw = bodyCandidates.length
		? bodyCandidates.slice().sort((a, b) => b.count - a.count || b.pt - a.pt)[0].pt
		: (allDesc.length ? allDesc[allDesc.length - 1] : 16);
	const between = allDesc.filter((p) => p < titleRaw && p > bodyRaw);
	const subtitleRaw = between.length ? median(between) : (titleRaw + bodyRaw) / 2;
	const bodyPt = clampInt(bodyRaw, 12, 22);
	const subtitlePt = clampInt(subtitleRaw, bodyPt + 2, 34);
	const titlePt = clampInt(titleRaw, subtitlePt + 4, 48);
	const coverTitlePt = clampInt(coverRaw, titlePt + 4, 96);
	return { titlePt, subtitlePt, bodyPt, coverTitlePt };
}

// Derive the per-archetype heading sizes from the reference's role scale, keeping good proportions.
// Content-slide titles use the reference's own title size; cover/section read larger; subtitle and
// body come straight from the reference.
function archetypeTypeScale(scale: ReferenceTypeScale) {
	const t = scale.titlePt;
	return {
		cover: clampInt(scale.coverTitlePt, 40, 96),
		section: clampInt(t * 1.2, 32, 64),
		statement: clampInt(t * 0.95, 26, 52),
		quote: clampInt(t, 28, 52),
		contentTitle: clampInt(t, 22, 48),
		subtitle: scale.subtitlePt,
		body: scale.bodyPt,
	};
}

function mkText(type: DeckRenderPlanTextElement["type"], ref: DeckRenderPlanContentRef, font: "heading" | "body", pt: number, color: string, y: number, h: number, align: "left" | "center" | "right" = "left"): DeckRenderPlanTextElement {
	return { type, content: { ref }, font, fontSizePt: pt, color, align, x: LAYOUT_MARGIN_X, y, w: LAYOUT_CONTENT_W, h };
}

function mkAccentRule(color: string, y: number, w = 0.16, h = 0.008): DeckRenderPlanShapeElement {
	return { type: "divider", orientation: "horizontal", fill: color, x: LAYOUT_MARGIN_X, y, w, h };
}

// Workhorse content layout: title, accent rule, optional subtitle lead, then a spaced body block.
function composeContentLayout(c: ArchetypeContent, st: ArchetypeStyle): DeckRenderPlanElement[] {
	const s = archetypeTypeScale(st.scale);
	const els: DeckRenderPlanElement[] = [];
	let top = 0.10;
	if (c.hasTitle) {
		els.push(mkText("title", "title", "heading", s.contentTitle, st.text, 0.08, 0.16));
		if (st.useDivider) els.push(mkAccentRule(st.accent, 0.265, LAYOUT_CONTENT_W, 0.006));
		top = 0.32;
	}
	if (c.hasSubtitle) {
		els.push(mkText("heading", "keyMessage", "body", s.subtitle, st.text, top, 0.12));
		top += 0.16;
	}
	if (c.hasBullets) {
		els.push(mkText("bullets", "bullets", "body", s.body, st.text, top, Math.max(0.2, 0.92 - top)));
	}
	if (els.length === 0 && st.useDivider) els.push(mkAccentRule(st.accent, 0.5));
	return els;
}

function composeCoverLayout(c: ArchetypeContent, st: ArchetypeStyle): DeckRenderPlanElement[] {
	const s = archetypeTypeScale(st.scale);
	const els: DeckRenderPlanElement[] = [];
	if (c.hasTitle) {
		els.push(mkText("title", "title", "heading", s.cover, st.text, 0.30, 0.28));
		if (st.useDivider) els.push(mkAccentRule(st.accent, 0.60, 0.16, 0.008));
	}
	if (c.hasSubtitle) els.push(mkText("heading", "keyMessage", "body", s.subtitle, st.text, c.hasTitle ? 0.64 : 0.42, 0.14));
	if (els.length === 0 && st.useDivider) els.push(mkAccentRule(st.accent, 0.5));
	return els;
}

function composeSectionLayout(c: ArchetypeContent, st: ArchetypeStyle): DeckRenderPlanElement[] {
	const s = archetypeTypeScale(st.scale);
	const els: DeckRenderPlanElement[] = [];
	if (st.useDivider) els.push(mkAccentRule(st.accent, 0.34, 0.16, 0.008));
	if (c.hasTitle) els.push(mkText("title", "title", "heading", s.section, st.text, 0.38, 0.26));
	if (c.hasSubtitle) els.push(mkText("heading", "keyMessage", "body", s.subtitle, st.text, 0.66, 0.12));
	return els;
}

function composeStatementLayout(c: ArchetypeContent, st: ArchetypeStyle): DeckRenderPlanElement[] {
	const s = archetypeTypeScale(st.scale);
	const els: DeckRenderPlanElement[] = [];
	if (st.useDivider) els.push(mkAccentRule(st.accent, 0.30, 0.12, 0.008));
	if (c.hasTitle && c.hasSubtitle) {
		els.push(mkText("kicker", "title", "body", s.subtitle, st.text, 0.16, 0.12));
		els.push(mkText("heading", "keyMessage", "heading", s.statement, st.text, 0.36, 0.34));
	} else if (c.hasSubtitle) {
		els.push(mkText("heading", "keyMessage", "heading", s.statement, st.text, 0.33, 0.34));
	} else if (c.hasTitle) {
		els.push(mkText("title", "title", "heading", s.statement, st.text, 0.33, 0.34));
	}
	return els;
}

function composeQuoteLayout(c: ArchetypeContent, st: ArchetypeStyle): DeckRenderPlanElement[] {
	const s = archetypeTypeScale(st.scale);
	const els: DeckRenderPlanElement[] = [];
	if (st.useDivider) els.push(mkAccentRule(st.accent, 0.28, 0.10, 0.010));
	if (c.hasSubtitle) {
		els.push(mkText("heading", "keyMessage", "heading", s.quote, st.text, 0.33, 0.34));
		if (c.hasTitle) els.push(mkText("footer", "title", "body", s.subtitle, st.text, 0.70, 0.10));
	} else if (c.hasTitle) {
		els.push(mkText("title", "title", "heading", s.quote, st.text, 0.33, 0.34));
	}
	return els;
}

// Compose the designed elements for a layout. Slides with bullets always use the content layout (a
// body block needs the readable, spaced treatment) regardless of the requested archetype, so present
// content is always placed and required-content-placement validation is satisfied.
function composeArchetypeElements(layout: DeckRenderPlanLayout, c: ArchetypeContent, st: ArchetypeStyle): DeckRenderPlanElement[] {
	if (c.hasBullets) return composeContentLayout(c, st);
	switch (layout) {
		case "cover": return composeCoverLayout(c, st);
		case "section": return composeSectionLayout(c, st);
		case "statement": return composeStatementLayout(c, st);
		case "quote": return composeQuoteLayout(c, st);
		case "content":
		default: return composeContentLayout(c, st);
	}
}

// Recommend a layout archetype for a slide from its content shape (used by the context tool/skeleton).
function recommendLayoutForSlide(content: { hasTitle: boolean; hasSubtitle: boolean; hasBullets: boolean }, index: number): DeckRenderPlanLayout {
	if (index === 0) return "cover";
	if (content.hasBullets) return "content";
	if (content.hasSubtitle && !content.hasTitle) return "statement";
	if (content.hasSubtitle) return "statement";
	if (content.hasTitle) return "section";
	return "content";
}

// Pure, read-only validation of a model-authored render plan against the current workbench content
// and the attached reference style evidence. No mutation, no writes, no generation. When the plan is
// error-free it returns a sanitised normalizedPlan with exact workbench text resolved.
export function validateDeckRenderPlan(input: { workbenchId: string; plan: unknown }): DeckRenderPlanValidationResult {
	const state = getDeckWorkbenchOrError(input.workbenchId);
	if (!state.referenceStyleProfile || !state.formatReference) {
		throw new Error("Render-plan validation requires an attached formatting reference. Attach an approved PPTX with artifact_deck_workbench_attach_format_reference first.");
	}
	const draftValidation = validateDeckSpecDraftForWorkbench(state.draft);
	if (draftValidation.errors.length > 0) {
		throw new Error("Workbench is not structurally renderable yet; resolve content issues before validating a render plan.");
	}
	if (!hasUsableReferenceStylePalette(state.referenceStyleProfile)) {
		throw new Error("Render-plan validation unavailable: the attached reference did not yield a usable background/text palette. Attach a PPTX reference with explicit colors instead of relying on a generic default style.");
	}
	const profile = state.referenceStyleProfile;
	const snapshot = getDeckWorkbenchUiSnapshot(state.id, undefined, draftValidation);

	const allowedColors = new Set<string>(["#000000", "#FFFFFF"]);
	for (const c of [...profile.colors.backgrounds, ...profile.colors.text, ...profile.colors.accents]) {
		const hex = sanitiseReferenceHexColor(c.value, "");
		if (hex) allowedColors.add(hex.toUpperCase());
	}
	const referenceFonts = referenceFontNamesFromProfile(profile);
	const allowedFontDisplay = Array.from(new Set([...referenceFonts, "Arial", "Helvetica", "sans-serif"]));
	const allowedFontsLower = new Set([...referenceFonts, ...RENDER_PLAN_SAFE_FONT_FALLBACKS].map((f) => f.toLowerCase()));

	// Reference-derived palette + type scale for the designed layout engine (layout slides).
	const pickedPalette = pickReadablePalette(profile);
	const layoutTextColor = pickedPalette.text.toUpperCase();
	const layoutAccentColor = (pickedPalette.accent ?? pickedPalette.text).toUpperCase();
	const layoutTypeScale = extractReferenceTypeScale(profile);
	const layoutUseDivider = profile.layouts.some((l) => (l.shapeHints ?? []).some((h) => /divider|rule|underline|hairline|\bline\b/i.test(String(h))));

	const errors: DeckSpecValidationIssue[] = [];
	const warnings: DeckSpecValidationIssue[] = [];
	const err = (code: string, message: string, slide?: number) => errors.push({ code, message, slide });
	const warn = (code: string, message: string, slide?: number) => warnings.push({ code, message, slide });

	const normalizedSlides: NormalizedRenderSlide[] = [];
	let normalizedPalette: NormalizedDeckRenderPlan["palette"] | undefined;
	let normalizedFonts: NormalizedDeckRenderPlan["fonts"] | undefined;

	const result = (): DeckRenderPlanValidationResult => {
		const ready = errors.length === 0;
		return {
			workbenchId: state.id,
			ready,
			slideCount: snapshot.slides.length,
			errors: errors.slice(0, 40),
			warnings: warnings.slice(0, 40),
			allowed: {
				colors: Array.from(allowedColors),
				fonts: allowedFontDisplay,
				textTypes: Array.from(RENDER_PLAN_TEXT_ELEMENT_TYPES),
				shapeTypes: Array.from(RENDER_PLAN_SHAPE_ELEMENT_TYPES),
				contentRefs: Array.from(RENDER_PLAN_CONTENT_REFS),
				layouts: Array.from(RENDER_PLAN_LAYOUTS),
			},
			normalizedPlan: ready && normalizedPalette && normalizedFonts
				? { version: "1.0", palette: normalizedPalette, fonts: normalizedFonts, slides: normalizedSlides }
				: undefined,
			caveat: "Render-plan validation only: content is referenced (never rewritten) and the normalizedPlan resolves exact workbench text. No file write, no PPTX generation, and no PPTX output/export.",
		};
	};

	const checkUnknownKeys = (obj: Record<string, unknown>, allowed: string[], label: string, slide?: number) => {
		for (const k of Object.keys(obj)) if (!allowed.includes(k)) err("plan_unknown_field", `${label}: unknown field '${k}' is not allowed.`, slide);
	};
	const normColor = (value: unknown, label: string, required: boolean, slide?: number): string | undefined => {
		if (value === undefined || value === null) { if (required) err("plan_color_required", `${label} is required.`, slide); return undefined; }
		if (!isPlainHex6(value)) { err("plan_color_invalid", `${label} must be a #RRGGBB hex colour.`, slide); return undefined; }
		const up = value.toUpperCase();
		if (!allowedColors.has(up)) { err("plan_color_not_allowed", `${label} '${up}' is not in the allowed reference palette (${Array.from(allowedColors).join(", ")}).`, slide); return undefined; }
		return up;
	};
	const checkGeom = (el: Record<string, unknown>, slide: number, idx: number): boolean => {
		for (const key of ["x", "y", "w", "h"]) {
			const v = el[key];
			if (typeof v !== "number" || !Number.isFinite(v)) { err("plan_geometry_invalid", `Slide ${slide} element ${idx}: ${key} must be a number.`, slide); return false; }
		}
		const x = el.x as number, y = el.y as number, w = el.w as number, h = el.h as number;
		if (x < 0 || y < 0 || w <= 0 || h <= 0 || x > 1 || y > 1 || w > 1 || h > 1 || x + w > 1.02 || y + h > 1.02) {
			err("plan_geometry_out_of_bounds", `Slide ${slide} element ${idx}: geometry must be 0..1 fractions that stay on the slide.`, slide);
			return false;
		}
		return true;
	};

	const plan = input.plan;
	if (!plan || typeof plan !== "object" || Array.isArray(plan)) { err("plan_invalid", "Render plan must be a JSON object."); return result(); }
	const p = plan as Record<string, unknown>;
	checkUnknownKeys(p, ["version", "palette", "fonts", "slides"], "Top level");
	if (p.version !== "1.0") err("plan_version_invalid", "Render plan version must be '1.0'.");

	const palette = p.palette && typeof p.palette === "object" && !Array.isArray(p.palette) ? (p.palette as Record<string, unknown>) : null;
	if (!palette) err("plan_palette_required", "palette is required."); else {
		checkUnknownKeys(palette, ["background", "text", "accent"], "palette");
		const bg = normColor(palette.background, "palette.background", true);
		const tx = normColor(palette.text, "palette.text", true);
		const ac = palette.accent !== undefined ? normColor(palette.accent, "palette.accent", false) : undefined;
		if (bg && tx) normalizedPalette = { background: bg, text: tx, ...(ac ? { accent: ac } : {}) };
	}

	const fontsObj = p.fonts && typeof p.fonts === "object" && !Array.isArray(p.fonts) ? (p.fonts as Record<string, unknown>) : null;
	if (!fontsObj) err("plan_fonts_required", "fonts is required."); else {
		checkUnknownKeys(fontsObj, ["heading", "body"], "fonts");
		const resolved: Record<string, string> = {};
		for (const role of ["heading", "body"] as const) {
			const v = fontsObj[role];
			if (typeof v !== "string" || !v.trim()) { err("plan_font_required", `fonts.${role} is required.`); continue; }
			if (looksUnsafeText(v)) { err("plan_unsafe_string", `fonts.${role} contains a disallowed token.`); continue; }
			if (!allowedFontsLower.has(sanitiseReferenceFontName(v).toLowerCase())) { err("plan_font_not_allowed", `fonts.${role} '${v}' is not an extracted reference font or safe fallback (${allowedFontDisplay.join(", ")}).`); continue; }
			resolved[role] = sanitiseReferenceFontName(v);
		}
		if (resolved.heading && resolved.body) normalizedFonts = { heading: resolved.heading, body: resolved.body };
	}

	const slides = Array.isArray(p.slides) ? p.slides : null;
	if (!slides) { err("plan_slides_required", "slides must be an array."); return result(); }
	if (slides.length !== snapshot.slides.length) {
		err("plan_slide_count_mismatch", `Render plan has ${slides.length} slide(s) but the workbench has ${snapshot.slides.length} (one output slide per workbench slide, same order).`);
	}
	const seenSourceIds = new Set<string>();
	const total = snapshot.slides.length;
	for (let i = 0; i < slides.length; i += 1) {
		const n = i + 1;
		const rawSlide = slides[i];
		if (!rawSlide || typeof rawSlide !== "object" || Array.isArray(rawSlide)) { err("plan_slide_invalid", `Slide ${n} must be an object.`, n); continue; }
		const s = rawSlide as Record<string, unknown>;
		checkUnknownKeys(s, ["sourceSlideId", "background", "layout", "elements", "includeSpeakerNotes"], `Slide ${n}`, n);
		const wbSlide = snapshot.slides[i];
		const srcId = typeof s.sourceSlideId === "string" ? s.sourceSlideId : "";
		if (srcId && looksUnsafeText(srcId)) err("plan_unsafe_string", `Slide ${n} sourceSlideId contains a disallowed token.`, n);
		if (!wbSlide) err("plan_extra_slide", `Slide ${n} has no matching workbench slide.`, n);
		else if (srcId !== wbSlide.id) err("plan_slide_id_mismatch", `Slide ${n} sourceSlideId '${srcId || "(missing)"}' must equal workbench slide id '${wbSlide.id}' in the same order.`, n);
		if (srcId) { if (seenSourceIds.has(srcId)) err("plan_slide_id_duplicate", `Slide ${n} sourceSlideId '${srcId}' is duplicated.`, n); seenSourceIds.add(srcId); }
		const normBg = s.background !== undefined ? normColor(s.background, `Slide ${n} background`, false, n) : undefined;
		const includeNotes = s.includeSpeakerNotes === true;
		if (s.includeSpeakerNotes !== undefined && typeof s.includeSpeakerNotes !== "boolean") err("plan_notes_flag_invalid", `Slide ${n} includeSpeakerNotes must be a boolean.`, n);
		if (includeNotes && !(wbSlide && nonEmpty(wbSlide.speakerNotes))) err("plan_notes_absent", `Slide ${n} includeSpeakerNotes is set but the workbench slide has no speaker notes.`, n);

		// A slide provides EITHER a layout archetype (engine composes designed elements) OR elements.
		let layoutName: DeckRenderPlanLayout | undefined;
		if (s.layout !== undefined) {
			if (typeof s.layout !== "string" || !RENDER_PLAN_LAYOUTS.has(s.layout as DeckRenderPlanLayout)) {
				err("plan_layout_invalid", `Slide ${n}: layout must be one of ${Array.from(RENDER_PLAN_LAYOUTS).join("/")}.`, n);
			} else {
				layoutName = s.layout as DeckRenderPlanLayout;
			}
			if (Array.isArray(s.elements) && s.elements.length > 0) {
				err("plan_layout_with_elements", `Slide ${n}: provide either layout or elements, not both.`, n);
			}
		} else if (s.elements === undefined) {
			err("plan_layout_or_elements_required", `Slide ${n}: provide a layout (recommended) or an elements array.`, n);
		}
		const composedElements = layoutName && wbSlide
			? composeArchetypeElements(layoutName, {
				hasTitle: !!nonEmpty(wbSlide.title),
				hasSubtitle: !!nonEmpty(wbSlide.keyMessage),
				hasBullets: (wbSlide.bullets ?? []).filter(Boolean).length > 0,
			}, { text: layoutTextColor, accent: layoutAccentColor, scale: layoutTypeScale, useDivider: layoutUseDivider })
			: null;
		const elements = composedElements ?? (Array.isArray(s.elements) ? s.elements : null);
		const normalizedElements: NormalizedRenderElement[] = [];
		const placedRefs = new Set<string>();
		if (!elements) { if (!layoutName) err("plan_elements_required", `Slide ${n} elements must be an array.`, n); }
		else {
			if (elements.length === 0) err("plan_slide_empty", `Slide ${n} has no elements.`, n);
			if (elements.length > RENDER_PLAN_MAX_ELEMENTS_PER_SLIDE) err("plan_too_many_elements", `Slide ${n} has ${elements.length} elements (max ${RENDER_PLAN_MAX_ELEMENTS_PER_SLIDE}).`, n);
			for (let j = 0; j < elements.length; j += 1) {
				const idx = j + 1;
				const rawEl = elements[j];
				if (!rawEl || typeof rawEl !== "object" || Array.isArray(rawEl)) { err("plan_element_invalid", `Slide ${n} element ${idx} must be an object.`, n); continue; }
				const el = rawEl as Record<string, unknown>;
				const type = typeof el.type === "string" ? el.type : "";
				const isText = RENDER_PLAN_TEXT_ELEMENT_TYPES.has(type);
				const isShape = RENDER_PLAN_SHAPE_ELEMENT_TYPES.has(type);
				if (!isText && !isShape) { err("plan_element_type_invalid", `Slide ${n} element ${idx}: type '${type}' is not an allowed text or shape type.`, n); continue; }
				if (isText) checkUnknownKeys(el, ["type", "content", "font", "fontSizePt", "color", "align", "x", "y", "w", "h"], `Slide ${n} element ${idx}`, n);
				else checkUnknownKeys(el, ["type", "orientation", "fill", "line", "weightPt", "x", "y", "w", "h"], `Slide ${n} element ${idx}`, n);
				const geomOk = checkGeom(el, n, idx);

				if (isText) {
					const fontOk = el.font === "heading" || el.font === "body";
					if (!fontOk) err("plan_font_role_invalid", `Slide ${n} element ${idx}: font must be 'heading' or 'body'.`, n);
					const sizeOk = typeof el.fontSizePt === "number" && Number.isInteger(el.fontSizePt) && el.fontSizePt >= RENDER_PLAN_MIN_FONT_PT && el.fontSizePt <= RENDER_PLAN_MAX_FONT_PT;
					if (!sizeOk) err("plan_font_size_invalid", `Slide ${n} element ${idx}: fontSizePt must be an integer ${RENDER_PLAN_MIN_FONT_PT}..${RENDER_PLAN_MAX_FONT_PT}.`, n);
					const color = normColor(el.color, `Slide ${n} element ${idx} color`, true, n);
					const alignRaw = el.align;
					if (alignRaw !== undefined && !["left", "center", "right"].includes(alignRaw as string)) err("plan_align_invalid", `Slide ${n} element ${idx}: align must be left/center/right.`, n);
					const align: "left" | "center" | "right" = alignRaw === "center" || alignRaw === "right" ? alignRaw : "left";

					const contentObj = el.content && typeof el.content === "object" && !Array.isArray(el.content) ? (el.content as Record<string, unknown>) : null;
					let ref: DeckRenderPlanContentRef | undefined;
					if (!contentObj) err("plan_content_required", `Slide ${n} element ${idx}: content.ref is required (text is referenced, not written).`, n);
					else {
						checkUnknownKeys(contentObj, ["ref"], `Slide ${n} element ${idx} content`, n);
						const r = contentObj.ref;
						if (typeof r !== "string" || !RENDER_PLAN_CONTENT_REFS.has(r)) err("plan_content_ref_invalid", `Slide ${n} element ${idx}: content.ref must be one of ${Array.from(RENDER_PLAN_CONTENT_REFS).join("/")}.`, n);
						else ref = r as DeckRenderPlanContentRef;
					}

					// Resolve the exact workbench text for this ref (never the model's words).
					let resolvedText: string | undefined;
					let resolvedItems: string[] | undefined;
					if (ref && wbSlide) {
						const isBulletsType = type === "bullets";
						if ((ref === "bullets") !== isBulletsType) {
							err("plan_content_ref_type_mismatch", `Slide ${n} element ${idx}: content.ref 'bullets' must use type 'bullets' and vice versa.`, n);
						} else if (ref === "bullets") {
							const bullets = (wbSlide.bullets ?? []).filter(Boolean);
							if (!bullets.length) err("plan_content_ref_empty", `Slide ${n} element ${idx}: content.ref 'bullets' but the workbench slide has no bullets.`, n);
							else resolvedItems = bullets;
						} else if (ref === "slideNumber") {
							resolvedText = `${n} / ${total}`;
						} else {
							const map: Record<string, string | undefined> = { title: wbSlide.title, keyMessage: wbSlide.keyMessage, speakerNotes: wbSlide.speakerNotes, visualIdea: wbSlide.visualIdea };
							const value = nonEmpty(map[ref]);
							if (!value) err("plan_content_ref_empty", `Slide ${n} element ${idx}: content.ref '${ref}' but the workbench slide has no ${ref}.`, n);
							else resolvedText = value;
						}
					}
					if (ref) placedRefs.add(ref);
					if (geomOk && fontOk && sizeOk && color && ref && (resolvedText !== undefined || resolvedItems !== undefined)) {
						normalizedElements.push({
							type: type as DeckRenderPlanTextElement["type"],
							ref,
							...(resolvedItems ? { items: resolvedItems } : { text: resolvedText }),
							font: el.font as "heading" | "body",
							fontSizePt: el.fontSizePt as number,
							color,
							align,
							x: el.x as number, y: el.y as number, w: el.w as number, h: el.h as number,
						});
					}
				} else {
					const fill = el.fill !== undefined ? normColor(el.fill, `Slide ${n} element ${idx} fill`, false, n) : undefined;
					const line = el.line !== undefined ? normColor(el.line, `Slide ${n} element ${idx} line`, false, n) : undefined;
					let orientation: "horizontal" | "vertical" | undefined;
					if (type === "divider" && el.orientation !== undefined) {
						if (el.orientation !== "horizontal" && el.orientation !== "vertical") err("plan_orientation_invalid", `Slide ${n} element ${idx}: divider orientation must be horizontal/vertical.`, n);
						else orientation = el.orientation;
					}
					let weightPt: number | undefined;
					if (el.weightPt !== undefined) {
						if (typeof el.weightPt !== "number" || el.weightPt <= 0 || el.weightPt > 12) err("plan_weight_invalid", `Slide ${n} element ${idx}: weightPt must be a number 0..12.`, n);
						else weightPt = el.weightPt;
					}
					if (geomOk) {
						normalizedElements.push({
							type: type as DeckRenderPlanShapeElement["type"],
							...(orientation ? { orientation } : {}),
							...(fill ? { fill } : {}),
							...(line ? { line } : {}),
							...(weightPt !== undefined ? { weightPt } : {}),
							x: el.x as number, y: el.y as number, w: el.w as number, h: el.h as number,
						});
					}
				}
			}
		}

		// Required content placement is now an error (write-ready semantics).
		if (wbSlide) {
			if (nonEmpty(wbSlide.title) && !placedRefs.has("title")) err("plan_title_not_placed", `Slide ${n}: the slide title must be placed via a content.ref 'title' element.`, n);
			if ((wbSlide.bullets ?? []).filter(Boolean).length && !placedRefs.has("bullets")) err("plan_bullets_not_placed", `Slide ${n}: the slide has bullets that must be placed via a content.ref 'bullets' element.`, n);
			if (nonEmpty(wbSlide.keyMessage) && !placedRefs.has("keyMessage")) err("plan_key_message_not_placed", `Slide ${n}: the slide keyMessage must be placed via a content.ref 'keyMessage' element.`, n);
		}

		normalizedSlides.push({
			sourceSlideId: wbSlide ? wbSlide.id : srcId,
			...(normBg ? { background: normBg } : {}),
			elements: normalizedElements,
			...(includeNotes && wbSlide && nonEmpty(wbSlide.speakerNotes) ? { speakerNotes: nonEmpty(wbSlide.speakerNotes) } : {}),
		});
	}

	return result();
}

// ── Slice C.2: render-plan authoring context (read-only; mirrors the reference-HTML context flow) ─
// Gives the model the exact slide ids, per-slide content availability, allowed values, reference
// style evidence, and a conservative-but-valid DeckRenderPlanV1 skeleton so it never has to guess
// sourceSlideId values or allowed enums. No mutation, no generation, no write, no approval.

// First usable extracted hex for each palette role (same source validateDeckRenderPlan allows).
function pickReferencePaletteHexes(profile: DeckStyleProfile): { background?: string; text?: string; accent?: string } {
	const firstHex = (items: Array<{ value: string }>): string | undefined => {
		for (const it of items) {
			const hex = sanitiseReferenceHexColor(it.value, "");
			if (hex) return hex.toUpperCase();
		}
		return undefined;
	};
	return {
		background: firstHex(profile.colors.backgrounds),
		text: firstHex(profile.colors.text),
		accent: firstHex(profile.colors.accents),
	};
}

// WCAG relative luminance + contrast ratio, used to guarantee readable text on the chosen background.
function hexRelLuminance(hex: string): number {
	const h = hex.replace(/^#/, "");
	if (h.length < 6) return 0;
	const ch = (i: number) => {
		const c = parseInt(h.slice(i, i + 2), 16) / 255;
		return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
	};
	return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4);
}
function hexContrastRatio(a: string, b: string): number {
	const la = hexRelLuminance(a), lb = hexRelLuminance(b);
	const hi = Math.max(la, lb), lo = Math.min(la, lb);
	return (hi + 0.05) / (lo + 0.05);
}

// Choose a background plus a text colour that actually CONTRASTS with it. Extracted text colours can be
// dominated by, e.g., a dark cover's white titles, which would be invisible on a light content
// background — so we pick the highest-contrast text candidate (extracted colours, then black/white).
function pickReadablePalette(profile: DeckStyleProfile): { background: string; text: string; accent?: string } {
	const picked = pickReferencePaletteHexes(profile);
	const background = (picked.background ?? "#000000").toUpperCase();
	const candidates = [
		...profile.colors.text.map((c) => sanitiseReferenceHexColor(c.value, "")).filter(Boolean).map((h) => h.toUpperCase()),
		"#000000", "#FFFFFF",
	];
	let text = "#FFFFFF", best = -1;
	for (const c of candidates) {
		const r = hexContrastRatio(c, background);
		if (r > best) { best = r; text = c; }
	}
	const accentRaw = picked.accent?.toUpperCase();
	const accent = accentRaw && accentRaw !== text && accentRaw !== background && hexContrastRatio(accentRaw, background) >= 1.8 ? accentRaw : undefined;
	return { background, text, accent };
}

// Authoring-only content view of a workbench slide. Carries the real workbench words so the model
// can make layout/hierarchy decisions; the authored render plan must still place text via content
// refs (the validator rejects raw text), so these strings never enter the plan or any output.
export type SlideContentPacket = {
	slideNumber: number;
	sourceSlideId: string;
	title?: string;
	keyMessage?: string;
	subtitleLike?: string;
	bullets: string[];
	bodyItems: string[];
	speakerNotesAvailable: boolean;
	visualIdea?: string;
	recommendedLayout: DeckRenderPlanLayout;
};

// A concise, safe layout pattern distilled from the attached reference's layoutEvidence. Hints only —
// no asset references, no exact coordinates beyond rough regions already in the evidence.
export type LayoutRecipe = {
	name: string;
	basedOnReferenceSlides: number[];
	background?: string;
	titleRegion?: string;
	titleScale?: "large" | "medium" | "small";
	density?: "sparse" | "medium" | "dense";
	motifs: string[];
	roughRegions: string[];
	hint: string;
};

export type DeckWorkbenchRenderPlanContext = {
	workbenchId: string;
	slideCount: number;
	slideIds: string[];
	referenceSourceLabel: string;
	styleProfileSummary: string;
	palette: { background: string; text: string; accent?: string };
	fonts: { heading: string; body: string };
	referenceFonts: string[];
	typeScale: ReferenceTypeScale;
	allowed: { colors: string[]; fonts: string[]; textTypes: string[]; shapeTypes: string[]; contentRefs: string[]; layouts: string[] };
	layoutEvidence: ReferenceLayoutEvidence[];
	layoutRecipes: LayoutRecipe[];
	authoringGuidance: string[];
	slides: Array<{
		slideNumber: number;
		sourceSlideId: string;
		available: { title: boolean; keyMessage: boolean; bullets: boolean; speakerNotes: boolean; visualIdea: boolean; slideNumber: boolean };
	}>;
	slideContentPackets: SlideContentPacket[];
	skeleton: DeckRenderPlanV1;
	skeletonValidates: boolean;
	skeletonErrors: DeckSpecValidationIssue[];
	caveat: string;
};

// Distil reference layoutEvidence into a small set of named, reusable layout recipes. Safe hints
// only (background tone, title region/scale, density, divider/block motifs, rough regions).
function buildLayoutRecipes(layoutEvidence: ReferenceLayoutEvidence[]): LayoutRecipe[] {
	const titleScaleOf = (pt?: number): "large" | "medium" | "small" | undefined => {
		if (typeof pt !== "number" || !Number.isFinite(pt)) return undefined;
		if (pt >= 40) return "large";
		if (pt >= 28) return "medium";
		return "small";
	};
	const motifsOf = (l: ReferenceLayoutEvidence): string[] => {
		const m = new Set<string>();
		for (const h of l.shapeHints ?? []) {
			const t = String(h).toLowerCase();
			if (t.includes("divider")) m.add("divider");
			if (t.includes("block")) m.add("block");
			if (t.includes("outline")) m.add("outline-rect");
		}
		return Array.from(m);
	};
	const classify = (l: ReferenceLayoutEvidence): { name: string; hint: string } => {
		const motifs = motifsOf(l);
		const sparse = l.density === "sparse" || (typeof l.textBoxCount === "number" && l.textBoxCount <= 2);
		if (l.kind === "title") {
			return { name: "full-bleed title slide", hint: "Full-bleed background with a large title in the upper-left; optional small subtitle (keyMessage) below. Minimal body." };
		}
		if (l.kind === "section") {
			return { name: "section slide", hint: "Sparse section divider: large centered or upper-left title, generous negative space, no bullets." };
		}
		if (motifs.includes("divider") && (motifs.includes("block") || (l.textBoxCount ?? 0) >= 2)) {
			return { name: "divider-led two-block slide", hint: "Title, a horizontal divider beneath it, then two stacked content blocks (keyMessage as emphasis, bullets as body)." };
		}
		if (sparse) {
			return { name: "sparse C-level statement slide", hint: "One large statement (keyMessage) dominating the slide, small title/kicker above, lots of whitespace, few or no bullets." };
		}
		return { name: "content slide", hint: "Title, optional keyMessage as a subtitle-like lead, then bullets as the body block." };
	};

	const byName = new Map<string, LayoutRecipe>();
	for (const l of layoutEvidence) {
		const { name, hint } = classify(l);
		const existing = byName.get(name);
		const motifs = motifsOf(l);
		if (existing) {
			if (typeof l.slideNumber === "number") existing.basedOnReferenceSlides.push(l.slideNumber);
			for (const mo of motifs) if (!existing.motifs.includes(mo)) existing.motifs.push(mo);
			for (const r of l.roughRegions ?? []) if (existing.roughRegions.length < 6 && !existing.roughRegions.includes(r)) existing.roughRegions.push(r);
		} else {
			byName.set(name, {
				name,
				basedOnReferenceSlides: typeof l.slideNumber === "number" ? [l.slideNumber] : [],
				background: l.background,
				titleRegion: l.titleRegion,
				titleScale: titleScaleOf(l.titleFontSizePt),
				density: l.density,
				motifs,
				roughRegions: (l.roughRegions ?? []).slice(0, 6),
				hint,
			});
		}
	}
	return Array.from(byName.values()).slice(0, 6);
}

export function getDeckWorkbenchRenderPlanContext(input: { workbenchId: string }): DeckWorkbenchRenderPlanContext {
	const state = getDeckWorkbenchOrError(input.workbenchId);
	if (!state.referenceStyleProfile || !state.formatReference) {
		throw new Error("Render-plan context requires an attached formatting reference. Attach an approved PPTX with artifact_deck_workbench_attach_format_reference first.");
	}
	const draftValidation = validateDeckSpecDraftForWorkbench(state.draft);
	if (draftValidation.errors.length > 0) {
		throw new Error("Workbench is not structurally renderable yet; resolve content issues before requesting a render-plan context.");
	}
	if (!hasUsableReferenceStylePalette(state.referenceStyleProfile)) {
		throw new Error("Render-plan context unavailable: the attached reference did not yield a usable background/text palette. Attach a PPTX reference with explicit colors instead of relying on a generic default style.");
	}
	const profile = state.referenceStyleProfile;
	const snapshot = getDeckWorkbenchUiSnapshot(state.id, undefined, draftValidation);

	// Allowed palette (same construction as validateDeckRenderPlan) and primary reference hexes.
	const allowedColors = new Set<string>(["#000000", "#FFFFFF"]);
	for (const c of [...profile.colors.backgrounds, ...profile.colors.text, ...profile.colors.accents]) {
		const hex = sanitiseReferenceHexColor(c.value, "");
		if (hex) allowedColors.add(hex.toUpperCase());
	}
	const picked = pickReadablePalette(profile);
	const background = picked.background;
	const text = picked.text;
	const accent = picked.accent;

	const referenceFonts = referenceFontNamesFromProfile(profile);
	const allowedFontDisplay = Array.from(new Set([...referenceFonts, "Arial", "Helvetica", "sans-serif"]));
	const { heading: headingFont, body: bodyFont } = pickRoleFonts(profile);

	const layoutEvidence: ReferenceLayoutEvidence[] = profile.layouts.slice(0, REFERENCE_CONTEXT_MAX_LAYOUT_SLIDES).map((l) => ({
		slideNumber: l.slideNumber,
		kind: l.kind,
		background: l.background,
		titleFontSizePt: l.titleFontSizePt,
		titleRegion: l.titleRegion,
		fonts: l.fonts,
		textBoxCount: l.textBoxCount,
		roughRegions: l.roughRegions,
		density: l.density,
		shapeHints: l.shapeHints,
		imageCount: l.imageCount,
	}));

	// Layout-based skeleton: one slide per workbench slide with the exact sourceSlideId and a
	// recommended layout archetype. The designed engine composes well-typeset elements, so the
	// skeleton itself is already a good deck — the model can ship it or swap layout names per slide.
	const planSlides: DeckRenderPlanSlide[] = snapshot.slides.map((wb, i) => {
		const hasTitle = !!nonEmpty(wb.title);
		const hasKey = !!nonEmpty(wb.keyMessage);
		const hasBullets = (wb.bullets ?? []).filter(Boolean).length > 0;
		const layout = recommendLayoutForSlide({ hasTitle, hasSubtitle: hasKey, hasBullets }, i);
		return { sourceSlideId: wb.id, layout };
	});

	const skeleton: DeckRenderPlanV1 = {
		version: "1.0",
		palette: { background, text, ...(accent ? { accent } : {}) },
		fonts: { heading: headingFont, body: bodyFont },
		slides: planSlides,
	};

	// Validate the skeleton as-is so the model knows whether it can use it directly or what to fill.
	const skeletonValidation = validateDeckRenderPlan({ workbenchId: state.id, plan: skeleton });

	// Authoring-only content packets (real text, for layout decisions) and reference layout recipes.
	const slideContentPackets: SlideContentPacket[] = snapshot.slides.map((s, i) => {
		const bullets = (s.bullets ?? []).filter(Boolean);
		const keyMessage = nonEmpty(s.keyMessage) || undefined;
		return {
			slideNumber: i + 1,
			sourceSlideId: s.id,
			title: nonEmpty(s.title) || undefined,
			keyMessage,
			subtitleLike: keyMessage,
			bullets,
			bodyItems: bullets,
			speakerNotesAvailable: !!nonEmpty(s.speakerNotes),
			visualIdea: nonEmpty(s.visualIdea) || undefined,
			recommendedLayout: recommendLayoutForSlide({ hasTitle: !!nonEmpty(s.title), hasSubtitle: !!nonEmpty(s.keyMessage), hasBullets: bullets.length > 0 }, i),
		};
	});
	const layoutRecipes = buildLayoutRecipes(layoutEvidence);

	const authoringGuidance = [
		"Author each slide as { sourceSlideId, layout } — pick a layout archetype per slide and let the engine handle all geometry, type scale, spacing and alignment. Do NOT hand-place x/y/w/h or pick font sizes; that is what makes output look amateurish.",
		`Allowed layouts: ${Array.from(RENDER_PLAN_LAYOUTS).join(", ")}. Use 'cover' for the opening/title slide, 'section' for dividers, 'statement' for a single big message, 'content' for bulleted slides, 'quote' for a pull-quote.`,
		"Each slideContentPacket includes a recommendedLayout; start from it and only change a layout when another archetype fits the slide's role better. Aim for variety across the deck, not the same layout everywhere.",
		"The engine derives a large-title type scale, generous margins, an accent rule and spaced body copy from the reference — this is how it reaches reference-style quality without you guessing coordinates.",
		"keyMessage is treated as the subtitle/lead; bullets become the body block. Use only reference colors and fonts (palette/fonts).",
		"Place all text via content refs only; slideContentPackets text is for your layout decisions and must never be pasted as raw text into the plan.",
		"Preserve exactly one render-plan slide per workbench slide, in order, with the exact sourceSlideId.",
		"Hand-authored elements are still allowed for special cases, but prefer layouts. This is approximate reference-style composition, not exact PPTX fidelity.",
	];

	return {
		workbenchId: state.id,
		slideCount: snapshot.slides.length,
		slideIds: snapshot.slides.map((s) => s.id),
		referenceSourceLabel: state.formatReference.sourceLabel,
		styleProfileSummary: formatStyleProfileSummary(profile),
		palette: { background, text, ...(accent ? { accent } : {}) },
		fonts: { heading: headingFont, body: bodyFont },
		referenceFonts,
		typeScale: extractReferenceTypeScale(profile),
		allowed: {
			colors: Array.from(allowedColors),
			fonts: allowedFontDisplay,
			textTypes: Array.from(RENDER_PLAN_TEXT_ELEMENT_TYPES),
			shapeTypes: Array.from(RENDER_PLAN_SHAPE_ELEMENT_TYPES),
			contentRefs: Array.from(RENDER_PLAN_CONTENT_REFS),
			layouts: Array.from(RENDER_PLAN_LAYOUTS),
		},
		layoutEvidence,
		layoutRecipes,
		authoringGuidance,
		slideContentPackets,
		slides: snapshot.slides.map((s, i) => ({
			slideNumber: i + 1,
			sourceSlideId: s.id,
			available: {
				title: !!nonEmpty(s.title),
				keyMessage: !!nonEmpty(s.keyMessage),
				bullets: (s.bullets ?? []).filter(Boolean).length > 0,
				speakerNotes: !!nonEmpty(s.speakerNotes),
				visualIdea: !!nonEmpty(s.visualIdea),
				slideNumber: true,
			},
		})),
		skeleton,
		skeletonValidates: skeletonValidation.ready,
		skeletonErrors: skeletonValidation.errors.slice(0, 40),
		caveat: "Read-only authoring context: the skeleton references content (never rewrites it). Validate any plan with artifact_deck_workbench_validate_render_plan before preview or write. No file write, no PPTX generation, and no PPTX output/export.",
	};
}

// ── Slice B: deterministic normalizedPlan → in-memory PPTX (no write, no export, no approval) ─────
// Generation consumes ONLY the sanitised normalizedPlan returned by validateDeckRenderPlan — never
// the raw model JSON. It builds a .pptx in memory with pptxgenjs (named fonts only, no embedding;
// no images/assets/macros), returns the buffer + a bounded summary, and writes nothing to disk.

const PPTX_GEN_SLIDE_W_INCHES = 13.333;
const PPTX_GEN_SLIDE_H_INCHES = 7.5;

export type GeneratedPptxSummary = {
	workbenchId: string;
	slideCount: number;
	elementCount: number;
	fonts: { heading: string; body: string };
	palette: { background: string; text: string; accent?: string };
	notesIncluded: number;
	bytes: number;
	warnings: string[];
	caveat: string;
};

function hexNoHash(value: string): string {
	return value.replace(/^#/, "").toUpperCase();
}

// Pure: validate → require ready + normalizedPlan → build PPTX in memory. Returns the buffer and a
// bounded summary. Never writes the buffer anywhere. Throws if the plan is not generation-ready.
export async function renderDeckRenderPlanToPptxBuffer(input: { workbenchId: string; plan: unknown }, options?: { maxBytes?: number }): Promise<{ buffer: Buffer; summary: GeneratedPptxSummary }> {
	const maxBytes = Number.isFinite(options?.maxBytes) && (options?.maxBytes as number) > 0 ? (options?.maxBytes as number) : MAX_PPTX_BYTES;
	const validation = validateDeckRenderPlan(input);
	if (!validation.ready || !validation.normalizedPlan) {
		const codes = validation.errors.slice(0, 8).map((e) => e.code).join(", ");
		throw new Error(`Render plan is not ready for PPTX generation${codes ? `: ${codes}` : ""}. Fix validation errors first; generation consumes only a ready normalizedPlan.`);
	}
	const plan = validation.normalizedPlan;
	const warnings: string[] = [];
	const W = PPTX_GEN_SLIDE_W_INCHES;
	const H = PPTX_GEN_SLIDE_H_INCHES;
	const headingFont = plan.fonts.heading;
	const bodyFont = plan.fonts.body;

	const pptx = new PptxGenJS();
	pptx.layout = "LAYOUT_WIDE";

	let elementCount = 0;
	let notesIncluded = 0;
	for (const s of plan.slides) {
		const slide = pptx.addSlide();
		const slideBg = hexNoHash(s.background ?? plan.palette.background);
		slide.background = { color: slideBg };
		for (const el of s.elements) {
			const x = Math.max(0, Math.min(W, el.x * W));
			const y = Math.max(0, Math.min(H, el.y * H));
			const w = Math.max(0.1, Math.min(W - x, el.w * W));
			const h = Math.max(0.1, Math.min(H - y, el.h * H));
			if ("ref" in el) {
				const t = el as NormalizedRenderTextElement;
				const fontFace = t.font === "heading" ? headingFont : bodyFont;
				const isHeadingType = t.type === "title" || t.type === "heading";
				// Headings sit at the top of their box; standalone body/quote text centers vertically.
				const valign: "top" | "middle" = t.items && t.items.length ? "top" : (isHeadingType ? "top" : "middle");
				const common = { x, y, w, h, fontFace, fontSize: t.fontSizePt, color: hexNoHash(t.color), align: t.align, valign, margin: 0, wrap: true };
				if (t.items && t.items.length) {
					// Real bullet spacing/leading so body copy reads like a designed slide, not a wall of text.
					slide.addText(
						t.items.map((it) => ({ text: it, options: { bullet: { indent: 18 }, breakLine: true } })),
						{ ...common, lineSpacingMultiple: 1.25, paraSpaceAfter: 8 },
					);
				} else if (typeof t.text === "string") {
					slide.addText(t.text, { ...common, bold: isHeadingType, lineSpacingMultiple: isHeadingType ? 1.05 : 1.15 });
				}
				elementCount += 1;
			} else {
				const sh = el as NormalizedRenderShapeElement;
				if (sh.type === "outline-rect") {
					slide.addShape(pptx.ShapeType.rect, { x, y, w, h, fill: { color: slideBg }, line: { color: hexNoHash(sh.line ?? plan.palette.text), width: sh.weightPt ?? 1 } });
				} else {
					// divider + block: solid fill (divider is just a thin filled rectangle)
					slide.addShape(pptx.ShapeType.rect, { x, y, w, h, fill: { color: hexNoHash(sh.fill ?? sh.line ?? plan.palette.text) } });
				}
				elementCount += 1;
			}
		}
		if (s.speakerNotes) {
			try { slide.addNotes(s.speakerNotes); notesIncluded += 1; }
			catch { warnings.push("Speaker notes could not be attached on a slide; skipped."); }
		}
	}

	const out = await pptx.write({ outputType: "nodebuffer" });
	const buffer = Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer);
	if (buffer.byteLength > maxBytes) {
		throw new Error(`Generated PPTX is ${buffer.byteLength} bytes, over the ${maxBytes}-byte limit; reduce slide/element count instead of generating an oversized deck.`);
	}
	return {
		buffer,
		summary: {
			workbenchId: validation.workbenchId,
			slideCount: plan.slides.length,
			elementCount,
			fonts: { heading: headingFont, body: bodyFont },
			palette: plan.palette,
			notesIncluded,
			bytes: buffer.byteLength,
			warnings,
			caveat: "In-memory approximate reference-style PPTX built from the validated normalizedPlan; named fonts only (not embedded), no exact PPTX fidelity, no file written, and no PPTX export.",
		},
	};
}

export type GeneratedPptxInspection = {
	valid: boolean;
	slideCount: number;
	checks: {
		validZip: boolean;
		slideCountMatches: boolean;
		slideXmlPresent: boolean;
		noMacros: boolean;
		noOle: boolean;
		noExternalRefs: boolean;
		noEmbeddedFonts: boolean;
	};
	issues: string[];
};

// Read the generated bytes back with JSZip to assert the file is safe and well-formed. Does not
// return the bytes; the caller discards the buffer.
export async function inspectGeneratedPptxBuffer(buffer: Buffer, expectedSlides: number): Promise<GeneratedPptxInspection> {
	const failClosed = (issue: string): GeneratedPptxInspection => ({
		valid: false,
		slideCount: 0,
		checks: { validZip: false, slideCountMatches: false, slideXmlPresent: false, noMacros: false, noOle: false, noExternalRefs: false, noEmbeddedFonts: false },
		issues: [issue],
	});
	let zip: JSZip;
	try { zip = await JSZip.loadAsync(buffer); } catch { return failClosed("Generated bytes are not a valid zip/PPTX."); }
	// Only consider actual files; PPTX writers commonly emit empty placeholder directory entries
	// (e.g. ppt/embeddings/, ppt/media/) that contain nothing.
	const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
	const slideXmls = names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n));
	const slideCount = slideXmls.length;
	const noMacros = !names.some((n) => /vbaProject\.bin$/i.test(n));
	const noOle = !names.some((n) => /oleObject|\/embeddings\/.+|activeX/i.test(n));
	let noEmbeddedFonts = !names.some((n) => /^ppt\/fonts\/.+/i.test(n));
	const presName = names.find((n) => /^ppt\/presentation\.xml$/i.test(n));
	if (presName) { const pxml = await zip.files[presName].async("string"); if (/embeddedFont/i.test(pxml)) noEmbeddedFonts = false; }
	let noExternalRefs = true;
	for (const n of names.filter((m) => /\.rels$/i.test(m))) {
		const xml = await zip.files[n].async("string");
		if (/TargetMode="External"/i.test(xml) || /Target="(https?:|file:|data:|ftp:)/i.test(xml)) { noExternalRefs = false; break; }
	}
	const slideXmlPresent = slideCount > 0;
	const slideCountMatches = slideCount === expectedSlides;
	const issues: string[] = [];
	if (!slideCountMatches) issues.push(`Generated slide count ${slideCount} does not match expected ${expectedSlides}.`);
	if (!slideXmlPresent) issues.push("No slide XML present.");
	if (!noMacros) issues.push("Macro project (vbaProject.bin) present.");
	if (!noOle) issues.push("OLE/embedded/ActiveX object present.");
	if (!noExternalRefs) issues.push("External relationship reference present.");
	if (!noEmbeddedFonts) issues.push("Embedded font present.");
	const checks = { validZip: true, slideCountMatches, slideXmlPresent, noMacros, noOle, noExternalRefs, noEmbeddedFonts };
	const valid = slideCountMatches && slideXmlPresent && noMacros && noOle && noExternalRefs && noEmbeddedFonts;
	return { valid, slideCount, checks, issues };
}

// ── Visual render-and-critique loop ──────────────────────────────────────────────────────────────
// Render the generated .pptx to per-slide PNG images so a vision-capable model can actually LOOK at
// the output, critique it (overflow, clipping, weak hierarchy/contrast), revise the render plan, and
// regenerate — the same way a person iterates on a deck. Uses a local headless LibreOffice to convert
// .pptx → PDF, then a PDF rasteriser (pdftoppm, or `sips`/`magick` as fallbacks) to per-page PNGs.
// Everything happens in a private temp dir that is removed afterwards. No durable artifact is written
// and no network is used. If no renderer is installed, it fails with a clear, actionable message.

const PPTX_PREVIEW_MAX_RENDER_SLIDES = 12;
const PPTX_PREVIEW_RENDER_DPI = 110;
const PPTX_PREVIEW_MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const PPTX_PREVIEW_RENDER_TIMEOUT_MS = 60_000;

type RenderToolPaths = { soffice?: string; pdftoppm?: string; sips?: string; magick?: string };

function which(cmd: string): string | undefined {
	try {
		if (process.platform === "win32") {
			const out = execFileSync("where.exe", [cmd], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
			const first = out.split(/\r?\n/)[0]?.trim();
			return first || undefined;
		}
		const out = execFileSync("/usr/bin/which", [cmd], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
		return out || undefined;
	} catch {
		return undefined;
	}
}

// Locate a headless LibreOffice and a PDF rasteriser without assuming a shell or PATH layout.
function detectPptxRenderTooling(): RenderToolPaths {
	const sofficeCandidates = ["soffice", "libreoffice"];
	let soffice: string | undefined;
	for (const c of sofficeCandidates) { soffice = which(c); if (soffice) break; }
	if (!soffice) {
		if (process.platform === "win32") {
			const winCandidates = [
				path.join(process.env.ProgramFiles ?? "C:\\Program Files", "LibreOffice", "program", "soffice.exe"),
				path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "LibreOffice", "program", "soffice.exe"),
			];
			for (const candidate of winCandidates) {
				if (fs.existsSync(candidate)) { soffice = candidate; break; }
			}
		} else {
			const mac = "/Applications/LibreOffice.app/Contents/MacOS/soffice";
			if (fs.existsSync(mac)) soffice = mac;
		}
	}
	return { soffice, pdftoppm: which("pdftoppm"), sips: which("sips"), magick: which("magick") };
}

export type PptxRenderAvailability = { available: boolean; soffice: boolean; rasteriser: "pdftoppm" | "sips" | "magick" | null; missing: string[]; installHint: string };

export function pptxRenderAvailability(): PptxRenderAvailability {
	const t = detectPptxRenderTooling();
	const rasteriser: PptxRenderAvailability["rasteriser"] = t.pdftoppm ? "pdftoppm" : t.sips ? "sips" : t.magick ? "magick" : null;
	const missing: string[] = [];
	if (!t.soffice) missing.push("LibreOffice (soffice)");
	if (!rasteriser) missing.push("a PDF rasteriser (pdftoppm/poppler, sips, or magick)");
	const installHint = process.platform === "win32"
		? "Install a headless renderer to enable visual preview: `winget install TheDocumentFoundation.LibreOffice` and Poppler for Windows (provides pdftoppm; e.g. `choco install poppler`) or ImageMagick (`winget install ImageMagick.ImageMagick`)."
		: "Install a headless renderer to enable visual preview: `brew install --cask libreoffice` and `brew install poppler` (provides pdftoppm). On Linux: `apt-get install libreoffice poppler-utils`.";
	return { available: !!t.soffice && !!rasteriser, soffice: !!t.soffice, rasteriser, missing, installHint };
}

export type RenderedSlideImage = { slideNumber: number; pngBase64: string; bytes: number };

// Render a generated .pptx buffer to per-slide PNGs in a private temp dir; always cleans up.
export function renderPptxBufferToSlideImages(buffer: Buffer, options?: { maxSlides?: number; dpi?: number }): { images: RenderedSlideImage[]; rendererUsed: string } {
	const tools = detectPptxRenderTooling();
	const avail = pptxRenderAvailability();
	if (!avail.available) {
		throw new Error(`Cannot render slides to images: missing ${avail.missing.join(" and ")}. ${avail.installHint}`);
	}
	const maxSlides = Math.max(1, Math.min(PPTX_PREVIEW_MAX_RENDER_SLIDES, options?.maxSlides ?? PPTX_PREVIEW_MAX_RENDER_SLIDES));
	const dpi = options?.dpi ?? PPTX_PREVIEW_RENDER_DPI;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-pptx-render-"));
	const profileDir = path.join(dir, "lo-profile");
	const pptxPath = path.join(dir, "deck.pptx");
	try {
		fs.writeFileSync(pptxPath, buffer, { mode: 0o600 });
		// 1) .pptx → .pdf via headless LibreOffice (isolated user profile so we never touch a real one).
		execFileSync(tools.soffice!, [
			"--headless", "--norestore", "--nodefault", "--nologo",
			`-env:UserInstallation=${pathToFileURL(profileDir).href}`,
			"--convert-to", "pdf", "--outdir", dir, pptxPath,
		], { stdio: ["ignore", "ignore", "ignore"], timeout: PPTX_PREVIEW_RENDER_TIMEOUT_MS });
		const pdfPath = path.join(dir, "deck.pdf");
		if (!fs.existsSync(pdfPath)) throw new Error("LibreOffice did not produce a PDF from the generated .pptx.");

		// 2) .pdf → per-page .png via the available rasteriser.
		const outPrefix = path.join(dir, "slide");
		let rendererUsed: string;
		if (tools.pdftoppm) {
			execFileSync(tools.pdftoppm, ["-png", "-r", String(dpi), pdfPath, outPrefix], { stdio: ["ignore", "ignore", "ignore"], timeout: PPTX_PREVIEW_RENDER_TIMEOUT_MS });
			rendererUsed = "libreoffice+pdftoppm";
		} else if (tools.magick) {
			execFileSync(tools.magick, ["-density", String(dpi), pdfPath, "-quality", "85", `${outPrefix}-%d.png`], { stdio: ["ignore", "ignore", "ignore"], timeout: PPTX_PREVIEW_RENDER_TIMEOUT_MS });
			rendererUsed = "libreoffice+magick";
		} else {
			// sips converts only the first page of a PDF; acceptable as a last-resort single-slide preview.
			execFileSync(tools.sips!, ["-s", "format", "png", pdfPath, "--out", `${outPrefix}-1.png`], { stdio: ["ignore", "ignore", "ignore"], timeout: PPTX_PREVIEW_RENDER_TIMEOUT_MS });
			rendererUsed = "libreoffice+sips(first slide only)";
		}

		// Collect the produced PNGs in page order.
		const pngs = fs.readdirSync(dir)
			.filter((f) => /^slide.*\.png$/i.test(f))
			.map((f) => ({ f, n: Number((f.match(/(\d+)\.png$/i) || [])[1] ?? 0) }))
			.sort((a, b) => a.n - b.n)
			.slice(0, maxSlides);
		const images: RenderedSlideImage[] = [];
		pngs.forEach((p, i) => {
			const data = fs.readFileSync(path.join(dir, p.f));
			if (data.byteLength > PPTX_PREVIEW_MAX_IMAGE_BYTES) return; // skip oversized frames rather than bloat the payload
			images.push({ slideNumber: p.n || i + 1, pngBase64: data.toString("base64"), bytes: data.byteLength });
		});
		if (images.length === 0) throw new Error("Rendering produced no usable slide images (frames missing or over size cap).");
		return { images, rendererUsed };
	} finally {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
	}
}

// ── HTML reference-style visual feedback loop (Playwright/Chromium, optional) ─────────────────────
// Unlike the PPTX path, HTML can be rendered locally so the model can SEE its own output and revise.
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

// ── Slice C: approval-gated durable .pptx write ──────────────────────────────────────────────────
// Shared, write-free preparation step: validate → generate in memory (size-capped) → inspect →
// fail closed. Returns the exact bytes that will be written only when inspection passes; otherwise
// returns ok:false and the caller must NOT prompt for approval or write anything. The
// forceInspectionInvalidForTest seam lets tests assert the fail-closed-before-approval path without
// needing a generator that can emit an unsafe file.
export type DeckRenderPlanPptxWritePrep =
	| { ok: true; buffer: Buffer; summary: GeneratedPptxSummary; inspection: GeneratedPptxInspection }
	| { ok: false; stage: "generate" | "inspect"; message: string; summary?: GeneratedPptxSummary; inspection?: GeneratedPptxInspection };

export async function prepareDeckRenderPlanPptxForWrite(
	input: { workbenchId: string; plan: unknown },
	options?: { maxBytes?: number; forceInspectionInvalidForTest?: boolean },
): Promise<DeckRenderPlanPptxWritePrep> {
	let generated: { buffer: Buffer; summary: GeneratedPptxSummary };
	try {
		generated = await renderDeckRenderPlanToPptxBuffer(input, { maxBytes: options?.maxBytes });
	} catch (e) {
		return { ok: false, stage: "generate", message: (e as Error).message };
	}
	let inspection = await inspectGeneratedPptxBuffer(generated.buffer, generated.summary.slideCount);
	if (options?.forceInspectionInvalidForTest) {
		inspection = { ...inspection, valid: false, issues: [...inspection.issues, "forced inspection failure (test seam)"] };
	}
	if (!inspection.valid) {
		return {
			ok: false,
			stage: "inspect",
			message: `Generated PPTX failed safety inspection and was rejected: ${inspection.issues.join("; ") || "unknown inspection failure"}. Nothing was written.`,
			summary: generated.summary,
			inspection,
		};
	}
	return { ok: true, buffer: generated.buffer, summary: generated.summary, inspection };
}

export function updateDeckWorkbenchSelectedSlide(input: {
	workbenchId: string;
	slideIndex: number;
	title: string;
	keyMessage?: string;
	bullets: string[];
	speakerNotes?: string;
	visualIdea?: string;
}): DeckWorkbenchUiSnapshot {
	const state = getDeckWorkbenchOrError(input.workbenchId);
	if (!Number.isInteger(input.slideIndex) || input.slideIndex < 1) throw new Error("slideIndex must be a positive integer.");
	const draft = cloneDeckWorkbenchDraft(state.draft);
	const slide = draft.slides[input.slideIndex - 1];
	if (!slide) throw new Error(`Slide ${input.slideIndex} not found.`);

	const nextTitle = nonEmpty(input.title);
	if (!nextTitle) throw new Error("Slide title is required and must not be empty.");
	slide.title = nextTitle;
	slide.keyMessage = nonEmpty(input.keyMessage) || undefined;
	slide.bullets = (Array.isArray(input.bullets) ? input.bullets : []).map((bullet) => nonEmpty(bullet)).filter(Boolean);
	slide.speakerNotes = nonEmpty(input.speakerNotes) || undefined;
	slide.visualIdea = nonEmpty(input.visualIdea) || undefined;

	state.draft = draft;
	state.validation = validateDeckSpecDraftForWorkbench(draft);
	state.updatedAt = new Date().toISOString();
	deckWorkbenchStore.set(state.id, state);
	return getDeckWorkbenchUiSnapshot(state.id, input.slideIndex);
}

// Generate a unique, stable slide id consistent with createBlankDeckWorkbench's scratch ids while
// guaranteeing it does not collide with any id already present in the draft.
function nextWorkbenchSlideId(draft: DeckSpecDraftFromPptxInspection): string {
	const existing = new Set((Array.isArray(draft.slides) ? draft.slides : []).map((s) => s.id));
	let id = `scratch-slide-${crypto.randomUUID()}`;
	while (existing.has(id)) id = `scratch-slide-${crypto.randomUUID()}`;
	return id;
}

export function updateDeckWorkbenchDeckMeta(input: {
	workbenchId: string;
	title: string;
	subtitle?: string;
	selectedSlideIndex?: number;
}): DeckWorkbenchUiSnapshot {
	const state = getDeckWorkbenchOrError(input.workbenchId);
	const nextTitle = nonEmpty(input.title);
	if (!nextTitle) throw new Error("Deck title is required and must not be empty.");
	const draft = cloneDeckWorkbenchDraft(state.draft);
	draft.title = nextTitle;
	draft.subtitle = nonEmpty(input.subtitle) || undefined;

	state.draft = draft;
	state.validation = validateDeckSpecDraftForWorkbench(draft);
	state.updatedAt = new Date().toISOString();
	deckWorkbenchStore.set(state.id, state);
	return getDeckWorkbenchUiSnapshot(state.id, input.selectedSlideIndex ?? 1);
}

export function addDeckWorkbenchSlide(input: {
	workbenchId: string;
	afterIndex?: number;
}): DeckWorkbenchUiSnapshot {
	const state = getDeckWorkbenchOrError(input.workbenchId);
	const draft = cloneDeckWorkbenchDraft(state.draft);
	const slides = Array.isArray(draft.slides) ? draft.slides : (draft.slides = []);
	if (slides.length >= BLANK_WORKBENCH_MAX_SLIDES) {
		throw new Error(`Cannot add slide: a deck cannot have more than ${BLANK_WORKBENCH_MAX_SLIDES} slides.`);
	}
	const newSlide: DeckSpecDraftSlide = {
		id: nextWorkbenchSlideId(draft),
		type: "content",
		title: "New slide",
		bullets: [],
	};
	const afterIndex = Number.isInteger(input.afterIndex) ? Number(input.afterIndex) : slides.length;
	const insertAt = Math.max(0, Math.min(slides.length, afterIndex));
	slides.splice(insertAt, 0, newSlide);

	state.draft = draft;
	state.validation = validateDeckSpecDraftForWorkbench(draft);
	state.updatedAt = new Date().toISOString();
	deckWorkbenchStore.set(state.id, state);
	return getDeckWorkbenchUiSnapshot(state.id, insertAt + 1);
}

export function deleteDeckWorkbenchSlide(input: {
	workbenchId: string;
	slideIndex: number;
}): DeckWorkbenchUiSnapshot {
	const state = getDeckWorkbenchOrError(input.workbenchId);
	if (!Number.isInteger(input.slideIndex) || input.slideIndex < 1) throw new Error("slideIndex must be a positive integer.");
	const draft = cloneDeckWorkbenchDraft(state.draft);
	const slides = Array.isArray(draft.slides) ? draft.slides : [];
	if (input.slideIndex > slides.length) throw new Error(`Slide ${input.slideIndex} not found.`);
	if (slides.length <= BLANK_WORKBENCH_MIN_SLIDES) {
		throw new Error(`Cannot delete slide: a deck must have at least ${BLANK_WORKBENCH_MIN_SLIDES} slides.`);
	}
	slides.splice(input.slideIndex - 1, 1);

	state.draft = draft;
	state.validation = validateDeckSpecDraftForWorkbench(draft);
	state.updatedAt = new Date().toISOString();
	deckWorkbenchStore.set(state.id, state);
	const clampedSelection = Math.max(1, Math.min(slides.length, input.slideIndex));
	return getDeckWorkbenchUiSnapshot(state.id, clampedSelection);
}

export function reorderDeckWorkbenchSlide(input: {
	workbenchId: string;
	fromIndex: number;
	toIndex: number;
}): DeckWorkbenchUiSnapshot {
	const state = getDeckWorkbenchOrError(input.workbenchId);
	const draft = cloneDeckWorkbenchDraft(state.draft);
	const slides = Array.isArray(draft.slides) ? draft.slides : [];
	if (!Number.isInteger(input.fromIndex) || input.fromIndex < 1 || input.fromIndex > slides.length) {
		throw new Error("fromIndex must be a valid slide index.");
	}
	if (!Number.isInteger(input.toIndex) || input.toIndex < 1 || input.toIndex > slides.length) {
		throw new Error("toIndex must be a valid slide index.");
	}
	const [moved] = slides.splice(input.fromIndex - 1, 1);
	slides.splice(input.toIndex - 1, 0, moved);

	state.draft = draft;
	state.validation = validateDeckSpecDraftForWorkbench(draft);
	state.updatedAt = new Date().toISOString();
	deckWorkbenchStore.set(state.id, state);
	return getDeckWorkbenchUiSnapshot(state.id, input.toIndex);
}

export type DeckWorkbenchUiValidation = {
	workbenchId: string;
	ready: boolean;
	summary: string[];
	errors: DeckSpecValidationIssue[];
	warnings: DeckSpecValidationIssue[];
	repairTargets: WorkbenchRepairTarget[];
	repairTargetCounts: {
		total: number;
		byCategory: Record<WorkbenchRepairTarget["category"], number>;
		byField: Record<string, number>;
	};
	snapshot: DeckWorkbenchUiSnapshot;
};

export function validateDeckWorkbenchForUi(input: { workbenchId: string; selectedSlideIndex?: number }): DeckWorkbenchUiValidation {
	const state = getDeckWorkbenchOrError(input.workbenchId);
	const validation = validateDeckSpecDraftForWorkbench(state.draft);
	const repairTargets = buildWorkbenchRepairTargets(state.draft, validation);
	const byCategory: Record<WorkbenchRepairTarget["category"], number> = {
		"deterministic-fixable": 0,
		"suggestion-needed": 0,
		"user-required": 0,
	};
	const byField: Record<string, number> = {};
	for (const target of repairTargets) {
		byCategory[target.category] += 1;
		const field = target.field ?? "unscoped";
		byField[field] = (byField[field] ?? 0) + 1;
	}

	return {
		workbenchId: state.id,
		ready: validation.ready,
		summary: validation.summary.slice(0, PPTX_DRAFT_REPORT_MAX_SUMMARY),
		errors: validation.errors.slice(0, PPTX_WORKBENCH_MAX_SUMMARY_ISSUES),
		warnings: validation.warnings.slice(0, PPTX_WORKBENCH_MAX_SUMMARY_ISSUES),
		repairTargets: repairTargets.slice(0, PPTX_WORKBENCH_MAX_SUMMARY_ISSUES),
		repairTargetCounts: {
			total: repairTargets.length,
			byCategory,
			byField,
		},
		snapshot: getDeckWorkbenchUiSnapshot(state.id, input.selectedSlideIndex, validation),
	};
}

export type DeckWorkbenchUiPreview = {
	workbenchId: string;
	ready: boolean;
	validation: { summary: string[]; errors: DeckSpecValidationIssue[]; warnings: DeckSpecValidationIssue[] };
	renderedValidation: { errors: DeckSpecValidationIssue[]; warnings: DeckSpecValidationIssue[] };
	htmlPreview: string;
	htmlPreviewTruncated: boolean;
	htmlBytes: number;
	slideCount: number;
	caveat: string;
	snapshot?: DeckWorkbenchUiSnapshot;
};

type DeckWorkbenchPreviewHtmlDetails = DeckWorkbenchUiPreview & {
	source: { kind: "reference_pptx" | "scratch"; destination?: string; relativePath?: string; title?: string; slideCount: number; extractionVersion?: string };
};

function formatDeckWorkbenchPreviewHtmlReport(details: DeckWorkbenchPreviewHtmlDetails): string {
	const lines: string[] = [];
	lines.push(`Deck workbench HTML preview: ${details.workbenchId}`);
	lines.push(`Source: ${details.source.kind === "scratch"
		? `scratch plan (${details.source.title || "Untitled"})`
		: `${details.source.destination}/${details.source.relativePath}`}`);
	lines.push(`Readiness: ready=${details.ready ? "true" : "false"}`);
	lines.push(`Slides: source=${details.source.slideCount}; rendered=${details.slideCount}`);
	const validationCodes = [
		...details.validation.errors.map((e) => e.code),
		...details.validation.warnings.map((w) => w.code),
	];
	const renderedCodes = [
		...details.renderedValidation.errors.map((e) => e.code),
		...details.renderedValidation.warnings.map((w) => w.code),
	];
	lines.push(`Validation codes: ${validationCodes.length ? validationCodes.slice(0, 12).join(", ") : "none"}`);
	lines.push(`Rendered validation codes: ${renderedCodes.length ? renderedCodes.slice(0, 12).join(", ") : "none"}`);
	lines.push(`HTML bytes: ${details.htmlBytes}; preview truncated: ${details.htmlPreviewTruncated ? "yes" : "no"}`);
	lines.push("Caveat: HTML preview only; no file write and no PPTX output/export performed.");
	return lines.join("\n");
}

function buildWorkbenchRepairTargets(
	draft: DeckSpecV1 | DeckSpecDraftFromPptxInspection,
	validation: DeckSpecDraftValidationReport,
): WorkbenchRepairTarget[] {
	const targets: WorkbenchRepairTarget[] = [];
	const slides = Array.isArray(draft?.slides) ? draft.slides as DeckSpecDraftSlide[] : [];
	const push = (target: WorkbenchRepairTarget) => {
		if (!targets.some((existing) => existing.id === target.id)) targets.push(target);
	};

	for (let i = 0; i < slides.length; i += 1) {
		const slide = slides[i];
		const bullets = Array.isArray(slide.bullets) ? slide.bullets : [];
		let hasWhitespaceOnly = false;
		let hasTrimCleanup = false;
		const seen = new Set<string>();
		let hasDuplicates = false;
		for (const bullet of bullets) {
			const raw = String(bullet ?? "");
			const clean = raw.replace(/\s+/g, " ").trim();
			if (!clean) {
				hasWhitespaceOnly = true;
				continue;
			}
			if (clean !== raw) hasTrimCleanup = true;
			const normalized = normaliseQualityText(clean);
			if (normalized && seen.has(normalized)) hasDuplicates = true;
			if (normalized) seen.add(normalized);
		}
		if (hasWhitespaceOnly) {
			push({
				id: `slide-${i + 1}-bullets-remove-empty`,
				severity: "warning",
				slideId: slide.id,
				slideIndex: i + 1,
				field: "bullets",
				category: "deterministic-fixable",
				deterministicAction: { type: "remove_empty_bullets", safe: true },
				why: `Slide ${i + 1} has empty/whitespace-only bullets.`,
			});
		}
		if (hasTrimCleanup) {
			push({
				id: `slide-${i + 1}-bullets-trim-whitespace`,
				severity: "warning",
				slideId: slide.id,
				slideIndex: i + 1,
				field: "bullets",
				category: "deterministic-fixable",
				deterministicAction: { type: "trim_whitespace", safe: true },
				why: `Slide ${i + 1} bullets need whitespace normalization.`,
			});
		}
		if (hasDuplicates) {
			push({
				id: `slide-${i + 1}-bullets-dedupe`,
				severity: "warning",
				slideId: slide.id,
				slideIndex: i + 1,
				field: "bullets",
				category: "deterministic-fixable",
				deterministicAction: { type: "dedupe_same_slide_bullets", safe: true },
				why: `Slide ${i + 1} has duplicate bullets.`,
			});
		}
	}

	for (const issue of validation.warnings) {
		if (issue.code === "slide_title_generic") {
			push({ id: `warn-${issue.code}-${issue.slide ?? "deck"}`, severity: "warning", slideIndex: issue.slide, field: "title", category: "suggestion-needed", suggestedAssistAction: { type: "suggest_title", scopeRequired: true }, why: issue.message });
		} else if (issue.code === "slide_missing_key_message") {
			push({ id: `warn-${issue.code}-${issue.slide ?? "deck"}`, severity: "warning", slideIndex: issue.slide, field: "keyMessage", category: "suggestion-needed", suggestedAssistAction: { type: "suggest_key_message", scopeRequired: true }, why: issue.message });
		} else if (issue.code === "deck_repeated_key_message") {
			push({ id: `warn-${issue.code}`, severity: "warning", field: "keyMessage", category: "suggestion-needed", suggestedAssistAction: { type: "suggest_key_message", scopeRequired: true }, why: issue.message });
		} else if (issue.code === "deck_missing_recommendation" || issue.code === "deck_missing_decision_ask") {
			push({ id: `warn-${issue.code}`, severity: "warning", field: "keyMessage", category: "suggestion-needed", suggestedAssistAction: { type: "suggest_decision_ask", scopeRequired: true }, why: issue.message });
		} else if (issue.code === "draft_requires_review") {
			push({ id: `blocking-${issue.code}`, severity: "blocking", field: "intent", category: "user-required", why: issue.message });
		}
	}

	for (const issue of validation.errors) {
		push({
			id: `error-${issue.code}-${issue.slide ?? "deck"}`,
			severity: "blocking",
			slideIndex: issue.slide,
			field: "structure",
			category: "user-required",
			why: issue.message,
		});
	}

	const needsIntent = (draft as DeckSpecV1)?.design?.source === "reference_pptx" && !(draft as DeckSpecDraftFromPptxInspection)?.intent;
	if (needsIntent) {
		push({
			id: "blocking-missing-intent",
			severity: "blocking",
			field: "intent",
			category: "user-required",
			why: "Missing reuse intent for PPTX-derived draft.",
		});
	}

	return targets;
}

function summarizeDeckWorkbenchValidation(report: DeckSpecDraftValidationReport) {
	return {
		ready: report.ready,
		summary: report.summary.slice(0, PPTX_DRAFT_REPORT_MAX_SUMMARY),
		errors: report.errors.slice(0, PPTX_WORKBENCH_MAX_SUMMARY_ISSUES),
		warnings: report.warnings.slice(0, PPTX_WORKBENCH_MAX_SUMMARY_ISSUES),
	};
}

function mapWorkbenchSkippedIssues(report: DeckSpecDraftValidationReport) {
	const deterministicCodes = new Set(["slide_duplicate_bullet"]);
	return report.warnings
		.filter((issue) => !deterministicCodes.has(issue.code))
		.slice(0, PPTX_WORKBENCH_REPAIR_MAX_ISSUES)
		.map((issue) => ({
			code: issue.code,
			slide: issue.slide,
			message: `${issue.message} Needs user or scoped LLM field edits later.`,
		}));
}

function cleanupSlideBullets(slide: DeckSpecDraftSlide) {
	const before = Array.isArray(slide.bullets) ? slide.bullets : [];
	const next: string[] = [];
	const seen = new Set<string>();
	let trimmedOrCollapsed = 0;
	let removedEmpty = 0;
	let deduped = 0;

	for (const bullet of before) {
		const clean = String(bullet ?? "").replace(/\s+/g, " ").trim();
		if (!clean) {
			removedEmpty += 1;
			continue;
		}
		if (clean !== bullet) trimmedOrCollapsed += 1;
		const normalized = normaliseQualityText(clean);
		if (normalized && seen.has(normalized)) {
			deduped += 1;
			continue;
		}
		if (normalized) seen.add(normalized);
		next.push(clean);
	}

	const changed = JSON.stringify(before) !== JSON.stringify(next);
	return {
		changed,
		before,
		after: next,
		trimmedOrCollapsed,
		removedEmpty,
		deduped,
	};
}

function cloneDeckWorkbenchDraft(draft: DeckSpecDraftFromPptxInspection): DeckSpecDraftFromPptxInspection {
	return JSON.parse(JSON.stringify(draft)) as DeckSpecDraftFromPptxInspection;
}

export function repairDeckWorkbenchForUi(input: { workbenchId: string; apply?: boolean; selectedSlideIndex?: number }): DeckWorkbenchUiRepairResult {
	const state = getDeckWorkbenchOrError(input.workbenchId);
	const apply = Boolean(input.apply);
	const preValidation = validateDeckSpecDraftForWorkbench(state.draft);
	const workingDraft = cloneDeckWorkbenchDraft(state.draft);
	const plannedChanges: Array<Record<string, unknown>> = [];

	for (let i = 0; i < workingDraft.slides.length; i += 1) {
		const slide = workingDraft.slides[i];
		const cleanup = cleanupSlideBullets(slide);
		if (!cleanup.changed) continue;
		slide.bullets = cleanup.after.length ? cleanup.after : undefined;
		plannedChanges.push({
			slide: i + 1,
			slideId: slide.id,
			actions: {
				trimmedWhitespace: cleanup.trimmedOrCollapsed,
				removedEmpty: cleanup.removedEmpty,
				removedDuplicates: cleanup.deduped,
			},
			beforeBulletCount: cleanup.before.length,
			afterBulletCount: cleanup.after.length,
		});
	}

	const skippedIssues = mapWorkbenchSkippedIssues(preValidation);
	if (!apply) {
		return {
			workbenchId: state.id,
			apply: false,
			proposedChanges: plannedChanges,
			appliedChanges: [],
			skippedIssues,
			preValidation: summarizeDeckWorkbenchValidation(preValidation),
			postValidation: summarizeDeckWorkbenchValidation(preValidation),
			caveat: "Preview only; no mutation. Workbench remains transient in-memory only.",
			snapshot: getDeckWorkbenchUiSnapshot(state.id, input.selectedSlideIndex, preValidation),
		};
	}

	if (plannedChanges.length > 0) {
		state.draft = workingDraft;
		state.updatedAt = new Date().toISOString();
	}
	const postValidation = validateDeckSpecDraftForWorkbench(state.draft);
	state.validation = postValidation;
	deckWorkbenchStore.set(state.id, state);

	return {
		workbenchId: state.id,
		apply: true,
		proposedChanges: [],
		appliedChanges: plannedChanges,
		skippedIssues,
		preValidation: summarizeDeckWorkbenchValidation(preValidation),
		postValidation: summarizeDeckWorkbenchValidation(postValidation),
		caveat: "Applied changes are transient in-memory only. No persistence, no file writes, no approval prompts.",
		snapshot: getDeckWorkbenchUiSnapshot(state.id, input.selectedSlideIndex, postValidation),
	};
}

function resolveWorkbenchSlideUpdateTarget(
	slides: DeckSpecDraftSlide[],
	update: { slideId?: string; slideIndex?: number },
	updatePosition: number,
): { index: number; slide: DeckSpecDraftSlide } {
	const hasId = typeof update.slideId === "string";
	const hasIndex = typeof update.slideIndex === "number";
	if (!hasId && !hasIndex) throw new Error(`Slide update ${updatePosition} must include slideId or slideIndex.`);
	const matches: Array<{ index: number; slide: DeckSpecDraftSlide }> = [];
	for (let i = 0; i < slides.length; i += 1) {
		const slide = slides[i];
		const byId = hasId && nonEmpty(update.slideId) && (slide.id === nonEmpty(update.slideId) || slide.source?.slideId === nonEmpty(update.slideId));
		const byIndex = hasIndex && Number.isInteger(update.slideIndex) && update.slideIndex === i + 1;
		if (byId || byIndex) matches.push({ index: i, slide });
	}
	if (matches.length !== 1) {
		throw new Error(`Slide update ${updatePosition} could not resolve to exactly one slide.`);
	}
	return matches[0];
}

function resolveWorkbenchAssistSlideTarget(
	slides: DeckSpecDraftSlide[],
	selection: { slideId?: string; slideIndex?: number },
): { index: number; slide: DeckSpecDraftSlide } {
	const hasId = typeof selection.slideId === "string" && Boolean(nonEmpty(selection.slideId));
	const hasIndex = typeof selection.slideIndex === "number";
	if ((hasId && hasIndex) || (!hasId && !hasIndex)) {
		throw new Error("assist_scope_invalid: Provide exactly one of slideId or slideIndex.");
	}
	if (hasIndex && (!Number.isInteger(selection.slideIndex) || (selection.slideIndex as number) < 1)) {
		throw new Error("assist_scope_invalid: slideIndex must be a positive integer.");
	}
	const matches: Array<{ index: number; slide: DeckSpecDraftSlide }> = [];
	for (let i = 0; i < slides.length; i += 1) {
		const slide = slides[i];
		const byId = hasId && (slide.id === nonEmpty(selection.slideId) || slide.source?.slideId === nonEmpty(selection.slideId));
		const byIndex = hasIndex && Number.isInteger(selection.slideIndex) && selection.slideIndex === i + 1;
		if (byId || byIndex) matches.push({ index: i, slide });
	}
	if (matches.length !== 1) throw new Error("assist_scope_not_found: Selected slide was not found in this workbench.");
	return matches[0];
}

function buildAssistFieldSelection(slide: DeckSpecDraftSlide, field: DeckWorkbenchAssistField) {
	if (field === "title") return compactExcerpt(slide.title, PPTX_WORKBENCH_ASSIST_MAX_TEXT);
	if (field === "keyMessage") return compactExcerpt(slide.keyMessage, PPTX_WORKBENCH_ASSIST_MAX_TEXT);
	if (field === "speakerNotes") return compactExcerpt(slide.speakerNotes, PPTX_WORKBENCH_ASSIST_MAX_TEXT);
	if (field === "visualIdea") return compactExcerpt(slide.visualIdea, PPTX_WORKBENCH_ASSIST_MAX_TEXT);
	return (Array.isArray(slide.bullets) ? slide.bullets : [])
		.slice(0, PPTX_WORKBENCH_ASSIST_MAX_BULLETS)
		.map((bullet) => compactExcerpt(bullet, PPTX_WORKBENCH_ASSIST_MAX_TEXT))
		.filter(Boolean);
}

export function validateDeckSpecDraftForWorkbench(
	draft: DeckSpecV1 | DeckSpecDraftFromPptxInspection,
): DeckSpecDraftValidationReport {
	const base = validateDeckSpecV1(draft as DeckSpecV1);
	const errors: DeckSpecValidationIssue[] = [...base.errors];
	const warnings: DeckSpecValidationIssue[] = [...base.warnings];
	const slides = Array.isArray(draft?.slides) ? draft.slides : [];

	if (slides.length === 0 && !errors.some((e) => e.code === "deck_slides_required")) {
		errors.push({ code: "deck_slides_required", message: "At least one slide is required." });
	}

	for (let i = 0; i < slides.length; i += 1) {
		const slide = slides[i] as DeckSpecDraftSlide;
		const slideNumber = i + 1;
		const id = nonEmpty(slide?.id);
		if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
			warnings.push({ code: "slide_id_unstable", slide: slideNumber, message: `Slide ${slideNumber} id '${id}' looks unstable (UUID-like).` });
		}
		const bulletCount = Array.isArray(slide?.bullets) ? slide.bullets.length : 0;
		const textLoad = nonEmpty(slide?.keyMessage).length + (slide?.bullets ?? []).join(" ").length;
		if (bulletCount > 7 || textLoad > 700) {
			warnings.push({ code: "slide_dense", slide: slideNumber, message: `Slide ${slideNumber} appears dense and may need simplification.` });
		}
	}

	const designSource = (draft as DeckSpecV1)?.design?.source;
	if (designSource === "reference_pptx") {
		if (!nonEmpty((draft as DeckSpecV1)?.design?.referenceId)) {
			warnings.push({ code: "pptx_source_reference_missing", message: "PPTX-derived draft is missing design.referenceId source reference." });
		}
		let missingSourceRefs = 0;
		for (const slide of slides as DeckSpecDraftSlide[]) {
			if (!slide?.source?.slideIndex && !nonEmpty(slide?.source?.slideId) && !nonEmpty(slide?.source?.entry)) missingSourceRefs += 1;
		}
		if (missingSourceRefs > 0) {
			warnings.push({ code: "pptx_slide_source_missing", message: `${missingSourceRefs} slide(s) are missing PPTX source references.` });
		}
		warnings.push({ code: "pptx_style_fidelity_caveat", message: "PPTX style fidelity is best-effort; review output before final rendering/export decisions." });
	}

	const draftIntent = (draft as DeckSpecDraftFromPptxInspection)?.intent;
	const inspirationOnly = draftIntent?.contentUse === "inspiration_only" || draftIntent?.styleUse === "inspiration_only";
	if (inspirationOnly) {
		warnings.push({
			code: "draft_requires_review",
			message: "Inspiration-only draft requires explicit user review before direct rendering.",
		});
	}

	const ready = errors.length === 0 && !inspirationOnly;
	const summary: string[] = [];
	summary.push(ready ? "Draft is ready for workbench/render flow." : "Draft is not ready for direct render flow.");
	if (errors.length) summary.push(`${errors.length} structural error(s) must be fixed.`);
	if (warnings.length) summary.push(`${warnings.length} warning(s) to review.`);
	if (designSource === "reference_pptx") summary.push("PPTX-derived draft: style/layout fidelity is best-effort.");
	if (inspirationOnly) summary.push("Inspiration-only intent set: user review required.");
	const boundedSummary = summary.slice(0, 6).map((line) => (line.length > 140 ? `${line.slice(0, 137)}...` : line));

	return { ready, errors, warnings, summary: boundedSummary };
}

export function prepareDeckSpecDraftForHtmlRendering(
	input: DeckSpecV1 | DeckSpecDraftFromPptxInspection,
	options: PrepareDeckSpecDraftOptions = {},
): DeckSpecV1 {
	const report = validateDeckSpecDraftForWorkbench(input);
	if (options.requireReady !== false && !report.ready) {
		const firstError = report.errors[0]?.message;
		const firstWarning = report.warnings[0]?.message;
		const reason = firstError || firstWarning || "Draft is not ready for direct rendering.";
		throw new Error(`DeckSpec draft is not ready for HTML rendering: ${reason}`);
	}

	const deck = input as DeckSpecV1;
	const cleanDesign = deck.design
		? {
			source: deck.design.source,
			referenceId: nonEmpty(deck.design.referenceId) || undefined,
			density: deck.design.density,
		}
		: undefined;
	const design = cleanDesign && (cleanDesign.source || cleanDesign.referenceId || cleanDesign.density) ? cleanDesign : undefined;

	const clean: DeckSpecV1 = {
		version: "1.0",
		artifactType: "deck",
		title: nonEmpty(deck.title),
		subtitle: nonEmpty(deck.subtitle) || undefined,
		audience: nonEmpty(deck.audience) || undefined,
		design: design,
		slides: (Array.isArray(deck.slides) ? deck.slides : []).map((slide) => {
			const draftSlide = slide as DeckSpecDraftSlide;
			const speakerNote = nonEmpty(slide.speakerNote) || nonEmpty(draftSlide.speakerNotes) || undefined;
			return {
				id: nonEmpty(slide.id),
				type: slide.type,
				title: nonEmpty(slide.title),
				keyMessage: nonEmpty(slide.keyMessage) || undefined,
				bullets: Array.isArray(slide.bullets) ? slide.bullets.map((b) => nonEmpty(b)).filter(Boolean) : undefined,
				speakerNote,
				visualIdea: nonEmpty(slide.visualIdea) || undefined,
			};
		}),
	};

	const validation = validateDeckSpecV1(clean);
	if (validation.errors.length > 0) {
		throw new Error(`Prepared DeckSpec is invalid: ${validation.errors.map((e) => e.message).join(" ")}`);
	}
	return clean;
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
		name: "artifact_deck_workbench_attach_format_reference",
		label: "Attach approved PPTX as workbench format reference",
		description: "Attach approved .pptx style evidence to an existing transient deck workbench without changing workbench content/slides. No writes, no approval, no PPTX output.",
		promptSnippet: "Use `artifact_deck_workbench_attach_format_reference` to attach approved PPTX style evidence to an existing workbench. This must not replace title/slides/content/slide count.",
		parameters: Type.Object({
			workbenchId: Type.String({ description: "Transient workbench id from artifact_deck_workbench_create_blank." }),
			filename: Type.String({ description: "Relative artifact filename ending in .pptx." }),
			destination: Type.Optional(Type.String({ description: "Approved destination name. Default: default (~/.exxperts/app/artifacts)." })),
			folder: Type.Optional(Type.String({ description: "Optional relative folder inside the destination." })),
		}),
		async execute(_id, { workbenchId, filename, destination, folder }) {
			try {
				const attached = await attachDeckWorkbenchFormatReference({ workbenchId, filename, destination, folder });
				return {
					content: [{ type: "text", text: `Attached format reference to workbench: ${attached.workbenchId}\nReference: ${attached.snapshot.formatReference?.sourceLabel || "n/a"}\nCaveat: content/slides unchanged; reference used only as approximate style evidence.` }],
					details: attached,
				};
			} catch (e) {
				return { content: [{ type: "text", text: (e as Error).message }], details: undefined, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "artifact_deck_workbench_reference_html_context",
		label: "Get reference-style HTML generation context",
		description: "Read-only. Return the attached PPTX style profile summary, current workbench slide content, and the strict safe-HTML contract so the model can author a bespoke reference-style HTML preview. No mutation, no writes, no PPTX output.",
		promptSnippet: "Use `artifact_deck_workbench_reference_html_context` (step 1) after content is approved and an approved PPTX is attached, to get retained style evidence + slide content + the HTML safety contract before you author reference-style HTML.",
		parameters: Type.Object({
			workbenchId: Type.String({ description: "Transient workbench id with an attached format reference." }),
		}),
		async execute(_id, { workbenchId }) {
			try {
				const context = getDeckWorkbenchReferenceHtmlContext({ workbenchId });
				const lines = [
					`Reference-style HTML context for workbench ${context.workbenchId}`,
					`Reference source: ${context.referenceSourceLabel}`,
					`Slides: ${context.slideCount}`,
					"",
					context.styleProfileSummary,
					"",
					`Reference fonts (preserve these names exactly): ${context.referenceFonts.join(", ") || "none detected"}`,
					`Recommended CSS font stack: ${context.recommendedFontStack}`,
					"CSS guidance:",
					...context.cssGuidance.map((g) => `- ${g}`),
					`Font debugging note: ${context.fontDebuggingNote}`,
					"",
					"Layout evidence (style/layout only, no slide text):",
					...context.layoutEvidence.map((l) => {
						const parts = [
							`slide ${l.slideNumber ?? "?"} [${l.kind}]`,
							l.background ? `bg ${l.background}` : "",
							l.titleFontSizePt ? `title~${l.titleFontSizePt}pt` : "",
							l.titleRegion ? `title@${l.titleRegion}` : "",
							l.density ? `density:${l.density}` : "",
							typeof l.textBoxCount === "number" ? `textboxes:${l.textBoxCount}` : "",
							l.roughRegions?.length ? `regions:${l.roughRegions.join("/")}` : "",
							l.shapeHints?.length ? `shapes:${l.shapeHints.join("/")}` : "",
							l.imageCount ? `images:${l.imageCount}` : "",
							l.fonts?.length ? `fonts:${l.fonts.join("/")}` : "",
						].filter(Boolean);
						return `- ${parts.join(" · ")}`;
					}),
					"",
					"HTML contract:",
					...context.htmlContract.map((c) => `- ${c}`),
					"",
					context.caveat,
				];
				return { content: [{ type: "text", text: lines.join("\n") }], details: context };
			} catch (e) {
				return { content: [{ type: "text", text: (e as Error).message }], details: undefined, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "artifact_deck_workbench_preview_reference_html",
		label: "Preview model-generated reference-style HTML",
		description: "Read-only. Validate model-generated self-contained reference-style HTML (one <section class=\"slide\"> per workbench slide; no scripts/iframes/external assets/url()/data:/file:/src/href) and return it as a non-persistent right-hand preview. Rejects unsafe/incomplete/oversized HTML. No mutation, no file write, no PPTX output/export.",
		promptSnippet: "Use `artifact_deck_workbench_preview_reference_html` (step 2) to preview the bespoke reference-style HTML you authored from `artifact_deck_workbench_reference_html_context`. It validates safety/structure and opens the preview on the right; it does not save or export.",
		parameters: Type.Object({
			workbenchId: Type.String({ description: "Transient workbench id with an attached format reference." }),
			html: Type.String({ description: "Complete self-contained <!doctype html> document with inline CSS and one <section class=\"slide\"> per workbench slide." }),
			footer: Type.Optional(Type.String({ description: "Optional footer label hint (the HTML itself should already contain the footer)." })),
		}),
		async execute(_id, { workbenchId, html, footer }) {
			try {
				const preview = previewDeckWorkbenchReferenceHtmlDraftForUi({ workbenchId, html, footer });
				const fontWarning = preview.renderedValidation.warnings.find((w) => w.code === "reference_fonts_not_used");
				const warningLine = fontWarning ? `\nWarning: ${fontWarning.message}` : "";
				return {
					content: [{ type: "text", text: `Reference-style HTML preview ready (${preview.slideCount} slide(s), ${preview.htmlBytes} bytes). ${preview.caveat}${warningLine}` }],
					details: preview,
				};
			} catch (e) {
				return { content: [{ type: "text", text: (e as Error).message }], details: undefined, isError: true };
			}
		},
	});

	type RenderHtmlPreviewImagesDetails = {
		rendered: boolean;
		availability?: HtmlRenderAvailability;
		rendererUsed?: string;
		slideCount?: number;
		renderedCount?: number;
		images?: Array<{ slideNumber: number; bytes: number }>;
		caveat?: string;
	};
	pi.registerTool({
		name: "artifact_deck_workbench_render_reference_html_images",
		label: "Render model-generated reference-style HTML to slide images for visual critique (no save)",
		description: "Read-only visual feedback loop for HTML decks. Validates model-generated self-contained reference-style HTML (same safety rules as artifact_deck_workbench_preview_reference_html: one <section class=\"slide\"> per workbench slide; no scripts/iframes/external assets/url()/data:/file:/src/href), then renders each slide to a PNG with a local headless Chromium (via Playwright), with all network blocked, so a vision-capable model can LOOK at the actual output, critique it (overflow/clipping, weak hierarchy/contrast, spacing, balance, and silent font fallback), revise the HTML, and re-render. Writes no durable file and exports nothing. Requires Playwright + a Chromium browser installed locally; if absent it returns a clear install hint and you should fall back to authoring without visual feedback.",
		promptSnippet: "Use `artifact_deck_workbench_render_reference_html_images` to SEE your authored reference-style HTML: it renders each slide to an image so you can visually critique and iterate (overflow, hierarchy, contrast, balance, font fallback) before previewing or saving. Needs local Playwright + Chromium; if unavailable it says so and you proceed without visual feedback. Iterate: author → render → critique → revise → re-render.",
		parameters: Type.Object({
			workbenchId: Type.String({ description: "Transient workbench id with an attached format reference." }),
			html: Type.String({ description: "Complete self-contained <!doctype html> document with inline CSS and one <section class=\"slide\"> per workbench slide (same contract as artifact_deck_workbench_preview_reference_html)." }),
			footer: Type.Optional(Type.String({ description: "Optional footer label hint (the HTML itself should already contain the footer)." })),
			maxSlides: Type.Optional(Type.Number({ description: `Optional cap on how many slides to render (1-${HTML_PREVIEW_MAX_RENDER_SLIDES}).` })),
		}),
		async execute(_id, { workbenchId, html, footer, maxSlides }) {
			const avail = await htmlRenderAvailability();
			if (!avail.available) {
				return {
					content: [{ type: "text", text: `Visual HTML slide preview is unavailable: missing ${avail.missing.join(" and ")}. ${avail.installHint} You can still author and preview reference-style HTML without visual feedback via artifact_deck_workbench_preview_reference_html.` }],
					details: { rendered: false, availability: avail } as RenderHtmlPreviewImagesDetails,
					isError: true,
				};
			}
			try {
				// Reuse the reference-style preview as the single source of safety + structure validation
				// (it throws on unsafe/incomplete/oversized HTML and resolves the expected slide count).
				const preview = previewDeckWorkbenchReferenceHtmlDraftForUi({ workbenchId, html, footer });
				const { images, rendererUsed } = await renderDeckHtmlToSlideImages(html, { maxSlides: typeof maxSlides === "number" ? maxSlides : undefined });
				const imageParts = images.map((img) => ({ type: "image" as const, data: img.pngBase64, mimeType: "image/png" }));
				const fontWarning = preview.renderedValidation.warnings.find((w) => w.code === "reference_fonts_not_used");
				const text = [
					`Rendered ${images.length} of ${preview.slideCount} slide image(s) from your reference-style HTML (${rendererUsed}). Look at the actual output and critique it: title hierarchy/size, text overflow or clipping, alignment/margins, spacing and balance (dead space), contrast, and whether the intended fonts actually rendered (a distinctive font falling back to Helvetica/Arial means it is not installed locally).`,
					"If anything looks off, revise the HTML and re-render. When it looks right, open the user-facing preview with artifact_deck_workbench_preview_reference_html and/or save.",
					fontWarning ? `Warning: ${fontWarning.message}` : "",
					preview.caveat,
				].filter(Boolean).join("\n");
				return {
					content: [{ type: "text", text }, ...imageParts],
					details: {
						rendered: true,
						rendererUsed,
						slideCount: preview.slideCount,
						renderedCount: images.length,
						images: images.map((i) => ({ slideNumber: i.slideNumber, bytes: i.bytes })),
						caveat: "Visual preview only; rendered locally for critique. Not a durable file, not an export. Approximate reference-style; fonts render only if installed locally.",
					} as RenderHtmlPreviewImagesDetails,
				};
			} catch (e) {
				return { content: [{ type: "text", text: (e as Error).message }], details: { rendered: false } as RenderHtmlPreviewImagesDetails, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "artifact_deck_workbench_preview_authored_html",
		label: "Preview model-authored self-contained HTML (no reference)",
		description: "Read-only. Validate self-contained HTML you authored directly from the approved workbench content (no formatting reference required): one <section class=\"slide\"> per workbench slide; no scripts/iframes/external assets/url()/data:/file:/src/href; <!doctype html> … </html>; within the byte cap. Returns it as a non-persistent right-hand preview. Rejects unsafe/incomplete/oversized HTML. No mutation, no file write, no PPTX output/export.",
		promptSnippet: "Use `artifact_deck_workbench_preview_authored_html` to open the right-pane preview of the self-contained HTML you authored directly from the workbench content (no reference). It validates safety/structure only; it does not save or export. Render and look first with `artifact_deck_workbench_render_authored_html_images`.",
		parameters: Type.Object({
			workbenchId: Type.String({ description: "Transient workbench id (content approved; no formatting reference required)." }),
			html: Type.String({ description: "Complete self-contained <!doctype html> document with inline CSS and one <section class=\"slide\"> per workbench slide." }),
			footer: Type.Optional(Type.String({ description: "Optional footer label hint (the HTML itself should already contain the footer)." })),
			selectedSlideIndex: Type.Optional(Type.Number({ description: "Optional 1-based slide index to keep selected in the workbench UI." })),
		}),
		async execute(_id, { workbenchId, html, footer, selectedSlideIndex }) {
			try {
				const preview = previewDeckWorkbenchAuthoredHtmlDraftForUi({ workbenchId, html, footer, selectedSlideIndex });
				return {
					content: [{ type: "text", text: `Model-authored HTML preview ready (${preview.slideCount} slide(s), ${preview.htmlBytes} bytes). ${preview.caveat}` }],
					details: preview,
				};
			} catch (e) {
				return { content: [{ type: "text", text: (e as Error).message }], details: undefined, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "artifact_deck_workbench_render_authored_html_images",
		label: "Render model-authored HTML to slide images for visual critique (no save)",
		description: "Read-only visual feedback loop for model-authored HTML decks (no formatting reference required). Validates the self-contained HTML you authored from the workbench content (same safety rules as artifact_deck_workbench_preview_authored_html: one <section class=\"slide\"> per workbench slide; no scripts/iframes/external assets/url()/data:/file:/src/href), then renders each slide to a PNG with a local headless Chromium (via Playwright), with all network blocked, so a vision-capable model can LOOK at the actual output, critique it (overflow/clipping, weak hierarchy/contrast, spacing, balance, and silent font fallback), revise the HTML, and re-render. Writes no durable file and exports nothing. Requires Playwright + a Chromium browser installed locally; if absent it returns a clear install hint and you should fall back to the deterministic artifact_write_html_deck path instead of authoring blind.",
		promptSnippet: "Use `artifact_deck_workbench_render_authored_html_images` to SEE the HTML you authored from the workbench content: it renders each slide to an image so you can visually critique and iterate (overflow, hierarchy, contrast, balance, font fallback) before previewing or saving. Needs local Playwright + Chromium; if unavailable it says so and you should fall back to the deterministic `artifact_write_html_deck` path. Iterate: author → render → critique → revise → re-render.",
		parameters: Type.Object({
			workbenchId: Type.String({ description: "Transient workbench id (content approved; no formatting reference required)." }),
			html: Type.String({ description: "Complete self-contained <!doctype html> document with inline CSS and one <section class=\"slide\"> per workbench slide (same contract as artifact_deck_workbench_preview_authored_html)." }),
			footer: Type.Optional(Type.String({ description: "Optional footer label hint (the HTML itself should already contain the footer)." })),
			maxSlides: Type.Optional(Type.Number({ description: `Optional cap on how many slides to render (1-${HTML_PREVIEW_MAX_RENDER_SLIDES}).` })),
		}),
		async execute(_id, { workbenchId, html, footer, maxSlides }) {
			const avail = await htmlRenderAvailability();
			if (!avail.available) {
				return {
					content: [{ type: "text", text: `Visual HTML slide preview is unavailable: missing ${avail.missing.join(" and ")}. ${avail.installHint} Without the renderer, do not author HTML blind — fall back to the deterministic artifact_write_html_deck path instead.` }],
					details: { rendered: false, availability: avail } as RenderHtmlPreviewImagesDetails,
					isError: true,
				};
			}
			try {
				// Reuse the no-reference authored preview as the single source of safety + structure
				// validation (it throws on unsafe/incomplete/oversized HTML and resolves the slide count).
				const preview = previewDeckWorkbenchAuthoredHtmlDraftForUi({ workbenchId, html, footer });
				const { images, rendererUsed } = await renderDeckHtmlToSlideImages(html, { maxSlides: typeof maxSlides === "number" ? maxSlides : undefined });
				const imageParts = images.map((img) => ({ type: "image" as const, data: img.pngBase64, mimeType: "image/png" }));
				const text = [
					`Rendered ${images.length} of ${preview.slideCount} slide image(s) from your model-authored HTML (${rendererUsed}). Look at the actual output and critique it: title hierarchy/size, text overflow or clipping, alignment/margins, spacing and balance (dead space), contrast, and whether the intended fonts actually rendered (a distinctive font falling back to Helvetica/Arial means it is not installed locally).`,
					"If anything looks off, revise the HTML and re-render. When it looks right, open the user-facing preview with artifact_deck_workbench_preview_authored_html and/or save.",
					preview.caveat,
				].filter(Boolean).join("\n");
				return {
					content: [{ type: "text", text }, ...imageParts],
					details: {
						rendered: true,
						rendererUsed,
						slideCount: preview.slideCount,
						renderedCount: images.length,
						images: images.map((i) => ({ slideNumber: i.slideNumber, bytes: i.bytes })),
						caveat: "Visual preview only; rendered locally for critique. Not a durable file, not an export. Model-authored self-contained HTML; fonts render only if installed locally.",
					} as RenderHtmlPreviewImagesDetails,
				};
			} catch (e) {
				return { content: [{ type: "text", text: (e as Error).message }], details: { rendered: false } as RenderHtmlPreviewImagesDetails, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "artifact_deck_workbench_render_plan_context",
		label: "Get render-plan authoring context (ids, allowed values, valid skeleton)",
		description: "Read-only. For a workbench with an attached format reference and a usable reference palette, return everything needed to author a high-fidelity DeckRenderPlanV1 without guessing: exact current slide ids in order, per-slide content availability, allowed colors/fonts/textTypes/shapeTypes/contentRefs, reference style/layout evidence, distilled layoutRecipes (named reference layout patterns), slideContentPackets (real per-slide text for layout decisions only), authoringGuidance, and a conservative-but-valid DeckRenderPlanV1 skeleton built from the exact sourceSlideIds. The skeleton is a safety starting point, not the desired final design. No mutation, no generation, no file write, no approval.",
		promptSnippet: "Use `artifact_deck_workbench_render_plan_context` FIRST when building a PPTX render plan: it returns the exact slide ids, allowed colors/fonts/shapes/content-refs, reference evidence, layoutRecipes, slideContentPackets, authoringGuidance, and a valid skeleton. Do not ship the skeleton unchanged unless the user asked for a basic export — author a bespoke plan from layoutRecipes + slideContentPackets (never invent sourceSlideId values; reference content via content.ref, never raw text), then validate with `artifact_deck_workbench_validate_render_plan` before any preview or write.",
		parameters: Type.Object({
			workbenchId: Type.String({ description: "Transient workbench id with an attached format reference and a usable reference palette." }),
		}),
		async execute(_id, { workbenchId }) {
			try {
				const context = getDeckWorkbenchRenderPlanContext({ workbenchId });
				const lines = [
					`Render-plan context: ${context.slideCount} slide(s). Slide ids (in order): ${context.slideIds.join(", ")}.`,
					`Allowed colors: ${context.allowed.colors.join(", ")}.`,
					`Allowed fonts: ${context.allowed.fonts.join(", ")}.`,
					`Allowed text types: ${context.allowed.textTypes.join(", ")}.`,
					`Type scale extracted from the reference (pt): title ${context.typeScale.titlePt}, subtitle ${context.typeScale.subtitlePt}, body ${context.typeScale.bodyPt}. The engine applies these automatically from the reference — do not override font sizes.`,
					`Allowed layouts (preferred authoring): ${context.allowed.layouts.join(", ")}.`,
					`Allowed content refs: ${context.allowed.contentRefs.join(", ")}.`,
					`Recommended layout per slide: ${context.slideContentPackets.map((p) => `${p.slideNumber}:${p.recommendedLayout}`).join(", ")}.`,
					`Layout recipes from the reference (details.layoutRecipes): ${context.layoutRecipes.map((r) => r.name).join("; ") || "none (no layout evidence)"}.`,
					"Author each slide as { sourceSlideId, layout } — the engine handles geometry/type-scale/spacing. Do NOT hand-place coordinates or font sizes.",
					"details.slideContentPackets gives the real per-slide text for layout decisions only — never paste it as raw text into the plan.",
					context.skeletonValidates
						? "details.skeleton is a ready, layout-based DeckRenderPlanV1 that already validates and renders well — ship it as-is for a basic export, or vary the per-slide layout names for a more tailored deck. Do not invent sourceSlideId values."
						: `The included skeleton needs adjustment before it validates: ${context.skeletonErrors.map((e) => e.message).slice(0, 6).join(" ")}`,
					"Use content refs, never raw text. Validate with artifact_deck_workbench_validate_render_plan before preview/write.",
					...context.authoringGuidance.slice(0, 3),
					context.caveat,
				];
				return { content: [{ type: "text", text: lines.join("\n") }], details: context };
			} catch (e) {
				return { content: [{ type: "text", text: (e as Error).message }], details: undefined, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "artifact_deck_workbench_validate_render_plan",
		label: "Validate a structured PPTX render plan",
		description: "Read-only. Validate a model-authored DeckRenderPlanV1 (JSON) against the current workbench content and the attached reference style evidence: one plan slide per workbench slide (same order/ids), text referenced (content.ref) and never written so content cannot be rewritten, required content placed (title; bullets/keyMessage when present), allowed shapes/colors/fonts only, unknown fields rejected, and no external assets/macros/scripts. Returns a sanitised normalizedPlan with exact workbench text resolved. No mutation, no file write, no PPTX generation or output/export.",
		promptSnippet: "Use `artifact_deck_workbench_validate_render_plan` to validate a structured DeckRenderPlanV1 (passed as JSON in `plan`). Text elements reference workbench content via content.ref (no raw text); it enforces 1:1 slides, required-content placement, an allow-list of shapes/colors/fonts, and rejects unknown fields. It returns a normalizedPlan but does not generate or save a PPTX.",
		parameters: Type.Object({
			workbenchId: Type.String({ description: "Transient workbench id with an attached format reference." }),
			plan: Type.String({ description: "DeckRenderPlanV1 as a JSON string: { version:'1.0', palette:{background,text,accent?}, fonts:{heading,body}, slides:[{ sourceSlideId, includeSpeakerNotes?, layout:'cover'|'section'|'statement'|'content'|'quote' }] }. PREFER per-slide `layout` (the designed engine composes well-typeset elements automatically). Advanced/manual alternative: instead of `layout`, a slide may provide background? and elements:[ { type, content:{ref:'title'|'keyMessage'|'bullets'|'speakerNotes'|'visualIdea'|'slideNumber'}, font:'heading'|'body', fontSizePt, color, align?, x,y,w,h } | { type:'divider'|'block'|'outline-rect', orientation?, fill?, line?, weightPt?, x,y,w,h } ] (provide either layout OR elements, not both). Text is referenced, not written. Use only the allowed colors/fonts/shape types/layouts reported by the context tool." }),
		}),
		async execute(_id, { workbenchId, plan }) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(String(plan ?? ""));
			} catch (e) {
				return { content: [{ type: "text", text: `Render plan is not valid JSON: ${(e as Error).message}` }], details: undefined, isError: true };
			}
			try {
				const validation = validateDeckRenderPlan({ workbenchId, plan: parsed });
				const lines = [
					`Render plan validation: ${validation.ready ? "ready" : "not ready"} (${validation.slideCount} workbench slide(s)).`,
					`Errors: ${validation.errors.length}${validation.errors.length ? " — " + validation.errors.slice(0, 6).map((e) => e.code).join(", ") : ""}`,
					`Warnings: ${validation.warnings.length}${validation.warnings.length ? " — " + validation.warnings.slice(0, 6).map((w) => w.code).join(", ") : ""}`,
					`normalizedPlan: ${validation.normalizedPlan ? "produced (future generators must consume this, not the raw plan)" : "not produced — fix the errors above"}`,
					`Allowed colors: ${validation.allowed.colors.join(", ")}`,
					`Allowed fonts: ${validation.allowed.fonts.join(", ")}`,
					`Content refs: ${validation.allowed.contentRefs.join(", ")}`,
					validation.caveat,
				];
				return { content: [{ type: "text", text: lines.join("\n") }], details: validation };
			} catch (e) {
				return { content: [{ type: "text", text: (e as Error).message }], details: undefined, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "artifact_deck_workbench_generate_reference_pptx_preview",
		label: "Generate + inspect an in-memory reference-style PPTX (no save)",
		description: "Read-only. Validate a DeckRenderPlanV1 (JSON) and, only if it is ready, build a .pptx IN MEMORY from the sanitised normalizedPlan via pptxgenjs (named fonts only, no embedding; no images/assets/macros), inspect it with JSZip, and return summary + safety metadata. The bytes are discarded — it returns no file, path, base64, or download, writes nothing, and does not export. Generation fails if validation is not ready or reference evidence/palette is missing.",
		promptSnippet: "Use `artifact_deck_workbench_generate_reference_pptx_preview` to dry-run PPTX generation from a validated DeckRenderPlanV1: it builds the deck in memory, checks it is macro/OLE/external-ref/embedded-font free, and reports a summary. It does NOT save, export, or return the file; durable .pptx save is not available yet.",
		parameters: Type.Object({
			workbenchId: Type.String({ description: "Transient workbench id with an attached format reference." }),
			plan: Type.String({ description: "DeckRenderPlanV1 as a JSON string (same shape as artifact_deck_workbench_validate_render_plan). Text is referenced via content.ref, never written." }),
		}),
		async execute(_id, { workbenchId, plan }) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(String(plan ?? ""));
			} catch (e) {
				return { content: [{ type: "text", text: `Render plan is not valid JSON: ${(e as Error).message}` }], details: undefined, isError: true };
			}
			try {
				const generated = await renderDeckRenderPlanToPptxBuffer({ workbenchId, plan: parsed });
				const inspection = await inspectGeneratedPptxBuffer(generated.buffer, generated.summary.slideCount);
				// Discard the bytes: never return the buffer, a path, or base64. Fail closed if the
				// generated file does not pass safety inspection — never present it as OK.
				if (!inspection.valid) {
					return {
						content: [{ type: "text", text: `Generated PPTX failed safety inspection and was rejected: ${inspection.issues.join("; ") || "unknown inspection failure"}. Nothing was written or returned.` }],
						details: { summary: generated.summary, inspection },
						isError: true,
					};
				}
				const lines = [
					`In-memory PPTX generated: ${generated.summary.slideCount} slide(s), ${generated.summary.elementCount} element(s), ${generated.summary.bytes} bytes (discarded).`,
					`Fonts (named, not embedded): ${generated.summary.fonts.heading} / ${generated.summary.fonts.body}.`,
					`Speaker notes attached: ${generated.summary.notesIncluded}.`,
					`Safety inspection: passed — no macros/OLE/external refs/embedded fonts; slide XML present.`,
					...generated.summary.warnings.map((w) => `Warning: ${w}`),
					generated.summary.caveat,
				];
				return { content: [{ type: "text", text: lines.join("\n") }], details: { summary: generated.summary, inspection } };
			} catch (e) {
				return { content: [{ type: "text", text: (e as Error).message }], details: undefined, isError: true };
			}
		},
	});

	// Shared (all-optional) details shape so every branch of the render-images tool unifies cleanly.
	type RenderPreviewImagesDetails = {
		rendered: boolean;
		availability?: PptxRenderAvailability;
		rendererUsed?: string;
		slideCount?: number;
		renderedCount?: number;
		images?: Array<{ slideNumber: number; bytes: number }>;
		summary?: GeneratedPptxSummary;
		inspection?: GeneratedPptxInspection;
		caveat?: string;
	};
	pi.registerTool({
		name: "artifact_deck_workbench_render_pptx_preview_images",
		label: "Render the in-memory .pptx to slide images for visual critique (no save)",
		description: "Read-only visual feedback loop. Validates a DeckRenderPlanV1, builds the .pptx IN MEMORY, safety-inspects it (fails closed), then renders each slide to a PNG using a local headless LibreOffice + PDF rasteriser and returns the images so a vision-capable model can LOOK at the actual output, critique it (overflow, clipping, weak hierarchy/contrast, spacing), revise the plan, and re-render. Renders in a private temp dir that is deleted afterwards; no durable file is written, no network is used, and nothing is exported. Requires LibreOffice (and pdftoppm/poppler or sips/magick) installed locally; if absent it returns a clear install message.",
		promptSnippet: "Use `artifact_deck_workbench_render_pptx_preview_images` to SEE the generated deck: it renders each slide to an image so you can visually critique and iterate on the render plan before saving. It writes no durable file and needs a local headless renderer (LibreOffice + pdftoppm). Iterate: render \u2192 critique \u2192 revise layout \u2192 re-render, then write only when it looks right.",
		parameters: Type.Object({
			workbenchId: Type.String({ description: "Transient workbench id with an attached format reference." }),
			plan: Type.String({ description: "DeckRenderPlanV1 as a JSON string (same shape as artifact_deck_workbench_validate_render_plan). Prefer per-slide layout archetypes." }),
			maxSlides: Type.Optional(Type.Number({ description: `Optional cap on how many slides to render (1-${PPTX_PREVIEW_MAX_RENDER_SLIDES}).` })),
		}),
		async execute(_id, { workbenchId, plan, maxSlides }) {
			const avail = pptxRenderAvailability();
			if (!avail.available) {
				return { content: [{ type: "text", text: `Visual slide preview is unavailable: missing ${avail.missing.join(" and ")}. ${avail.installHint}` }], details: { rendered: false, availability: avail } as RenderPreviewImagesDetails, isError: true };
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(String(plan ?? ""));
			} catch (e) {
				return { content: [{ type: "text", text: `Render plan is not valid JSON: ${(e as Error).message}` }], details: { rendered: false } as RenderPreviewImagesDetails, isError: true };
			}
			try {
				const generated = await renderDeckRenderPlanToPptxBuffer({ workbenchId, plan: parsed });
				const inspection = await inspectGeneratedPptxBuffer(generated.buffer, generated.summary.slideCount);
				if (!inspection.valid) {
					return { content: [{ type: "text", text: `Generated PPTX failed safety inspection and was not rendered: ${inspection.issues.join("; ") || "unknown inspection failure"}.` }], details: { rendered: false, summary: generated.summary, inspection } as RenderPreviewImagesDetails, isError: true };
				}
				const { images, rendererUsed } = renderPptxBufferToSlideImages(generated.buffer, { maxSlides: typeof maxSlides === "number" ? maxSlides : undefined });
				const imageParts = images.map((img) => ({ type: "image" as const, data: img.pngBase64, mimeType: "image/png" }));
				const text = [
					`Rendered ${images.length} slide image(s) from the generated deck (${rendererUsed}). Review them and critique the actual output: title hierarchy/size, text overflow or clipping, alignment/margins, spacing, and contrast.`,
					"If anything looks off, revise the render plan (usually the per-slide layout archetype) and re-render. When it looks right, validate and then save with artifact_deck_workbench_write_reference_pptx.",
					generated.summary.caveat,
				].join("\n");
				return {
					content: [{ type: "text", text }, ...imageParts],
					details: {
						rendered: true,
						rendererUsed,
						slideCount: generated.summary.slideCount,
						renderedCount: images.length,
						images: images.map((i) => ({ slideNumber: i.slideNumber, bytes: i.bytes })),
						summary: generated.summary,
						inspection,
						caveat: "Visual preview only; rendered with a local converter for critique. Not a durable file, not an export. Approximate reference-style, not exact PPTX fidelity.",
					} as RenderPreviewImagesDetails,
				};
			} catch (e) {
				return { content: [{ type: "text", text: (e as Error).message }], details: { rendered: false } as RenderPreviewImagesDetails, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "artifact_deck_workbench_write_reference_pptx",
		label: "Approval-gated reference-style .pptx save from a validated render plan",
		description: "Approval-gated durable .pptx save. Validates a DeckRenderPlanV1 (JSON), builds the deck IN MEMORY from the sanitised normalizedPlan via pptxgenjs (named fonts only, no embedding; no images/assets/macros), enforces the size cap, inspects the bytes with JSZip, and fails closed if inspection fails (no approval prompt, no write). Only then resolves a safe .pptx path under an approved artifact destination, shows an approval card, and on approval writes the exact generated bytes (mode 0o600). It never mutates workbench content, copies no fonts/assets/images from the reference, and makes no exact-fidelity claim. .pptx is allowed only for this tool; global HTML/MD write behavior is unchanged.",
		promptSnippet: "Use `artifact_deck_workbench_write_reference_pptx` to approval-save an approximate reference-style .pptx from a validated DeckRenderPlanV1, only after content is approved, a format reference is attached, and the plan validates. It builds + inspects in memory, fails closed on unsafe output, and writes only after an approval card. Named local fonts only, no embedded fonts/assets, not exact fidelity.",
		parameters: Type.Object({
			workbenchId: Type.String({ description: "Transient workbench id with an attached format reference and an approved content draft." }),
			plan: Type.String({ description: "DeckRenderPlanV1 as a JSON string (same shape as artifact_deck_workbench_validate_render_plan). Text is referenced via content.ref, never written." }),
			filename: Type.String({ description: "Relative artifact filename ending in .pptx." }),
			destination: Type.Optional(Type.String({ description: "Approved destination name. Default: default (~/.exxperts/app/artifacts)." })),
			folder: Type.Optional(Type.String({ description: "Optional relative folder inside the destination." })),
			reason: Type.Optional(Type.String({ description: "Why this .pptx artifact should be saved." })),
		}),
		async execute(_id, { workbenchId, plan, filename, destination, folder, reason }, _signal, _onUpdate, ctx) {
			// 1. Parse plan JSON.
			let parsed: unknown;
			try {
				parsed = JSON.parse(String(plan ?? ""));
			} catch (e) {
				return { content: [{ type: "text", text: `Render plan is not valid JSON: ${(e as Error).message}` }], details: { saved: false }, isError: true };
			}
			try {
				// 2-4. Generate in memory (size-capped) → inspect → fail closed. No approval, no write on failure.
				const prep = await prepareDeckRenderPlanPptxForWrite({ workbenchId, plan: parsed });
				if (!prep.ok) {
					return {
						content: [{ type: "text", text: `${prep.message} Nothing was written.` }],
						details: { saved: false, stage: prep.stage, summary: prep.summary, inspection: prep.inspection },
						isError: true,
					};
				}

				// 5. Resolve a safe destination/path; .pptx allowed only here.
				const target = validateArtifactPath(filename, destination, folder, new Set([".pptx"]));
				if (target.extension !== ".pptx") throw new Error("Reference-style PPTX artifacts must use a .pptx filename.");

				const exists = fs.existsSync(target.fullPath);
				const summary = prep.summary;
				// 6. Approval preview: path, overwrite, slides, bytes, fonts-by-name, safety, fidelity caveat.
				const detail = [
					...targetDetail(target, exists, reason),
					`Slides: ${summary.slideCount}`,
					`Elements: ${summary.elementCount}`,
					`Size: ${summary.bytes} bytes`,
					`Fonts (named local fonts only, NOT embedded): heading ${summary.fonts.heading} / body ${summary.fonts.body}`,
					`Palette: background #${hexNoHash(summary.palette.background)}, text #${hexNoHash(summary.palette.text)}${summary.palette.accent ? `, accent #${hexNoHash(summary.palette.accent)}` : ""}`,
					`Speaker notes attached: ${summary.notesIncluded}`,
					"Safety: inspected — no embedded fonts, no assets/images, no macros, no OLE, no external references.",
					...summary.warnings.map((w) => `Warning: ${w}`),
					"Fidelity: approximate reference-style only — not an exact copy of the reference PPTX.",
				].join("\n");

				// 7. Confirm before writing.
				const ok = await approve(ctx, exists ? "Replace local .pptx deck from render plan?" : "Create local .pptx deck from render plan?", detail);
				// 8. If declined (or no UI), write nothing.
				if (!ok) {
					return {
						content: [{ type: "text", text: "Reference-style .pptx not saved; user approval missing or declined." }],
						details: {
							saved: false,
							workbenchId,
							destination: target.destination.name,
							path: target.fullPath,
							relativePath: target.relativePath,
							replaced: exists,
							slideCount: summary.slideCount,
							bytes: summary.bytes,
							caveat: summary.caveat,
						},
						isError: !ctx.hasUI,
					};
				}

				// 9. Approved: write the EXACT generated bytes (no regeneration), restrictive mode.
				fs.mkdirSync(path.dirname(target.fullPath), { recursive: true, mode: 0o700 });
				fs.writeFileSync(target.fullPath, prep.buffer, { mode: 0o600 });
				ctx.ui.notify(`Saved reference-style PPTX: ${target.fullPath}`, "info");
				const action = exists ? "Replaced" : "Created";
				// 10. Report the saved artifact.
				return {
					content: [{ type: "text", text: `${action} approximate reference-style .pptx: ${target.fullPath} (${summary.slideCount} slide(s), ${summary.bytes} bytes). Named local fonts only, no embedded fonts/assets; not an exact copy of the reference.` }],
					details: {
						saved: true,
						workbenchId,
						destination: target.destination.name,
						path: target.fullPath,
						relativePath: target.relativePath,
						replaced: exists,
						slideCount: summary.slideCount,
						bytes: summary.bytes,
						fonts: summary.fonts,
						caveat: summary.caveat,
					},
				};
			} catch (e) {
				return { content: [{ type: "text", text: (e as Error).message }], details: { saved: false }, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "artifact_deck_workbench_create_blank",
		label: "Create transient scratch deck workbench",
		description: "Create an in-memory scratch/blank deck workbench with a deterministic slide plan, or pass substantive slides to start pre-populated. Session-only state; no file write, no PPTX output.",
		promptSnippet: "Use `artifact_deck_workbench_create_blank` to start a transient scratch deck workbench (title/audience/goal/slide count/preset) without any PPTX reference; optionally pass subtitle/slides to create a populated draft in one call.",
		parameters: Type.Object({
			title: Type.String({ description: "Deck topic/title for the scratch workbench." }),
			subtitle: Type.Optional(Type.String({ description: "Optional deck subtitle." })),
			audience: Type.Optional(Type.String({ description: "Optional target audience." })),
			goal: Type.Optional(Type.String({ description: "Optional decision/goal for the deck." })),
			slideCount: Type.Optional(Type.Number({ description: `Optional slide count (${BLANK_WORKBENCH_MIN_SLIDES}-${BLANK_WORKBENCH_MAX_SLIDES}); default 5.` })),
			slides: Type.Optional(Type.Array(Type.Object({
				title: Type.String({ description: "Slide title." }),
				keyMessage: Type.Optional(Type.String({ description: "Optional key message." })),
				bullets: Type.Optional(Type.Array(Type.String({ description: "Optional bullet line." }))),
				speakerNotes: Type.Optional(Type.String({ description: "Optional speaker notes." })),
				visualIdea: Type.Optional(Type.String({ description: "Optional visual idea/storyboard hint." })),
			}))),
			structurePreset: Type.Optional(Type.Union([
				Type.Literal("executive"),
				Type.Literal("consulting"),
				Type.Literal("technical"),
				Type.Literal("minimal"),
				Type.Literal("executive_review"),
				Type.Literal("executive-review"),
				Type.Literal("strategy"),
				Type.Literal("consulting_deck"),
				Type.Literal("technical_review"),
			])),
		}),
		async execute(_id, params) {
			try {
				const created = createBlankDeckWorkbench({
					title: params.title,
					subtitle: params.subtitle,
					audience: params.audience,
					goal: params.goal,
					slideCount: params.slideCount,
					slides: params.slides,
					structurePreset: normaliseDeckStructurePreset(params.structurePreset),
				});
				const state = getDeckWorkbenchOrError(created.workbenchId);
				return {
					content: [{ type: "text", text: formatDeckWorkbenchSummary(state) }],
					details: {
						workbenchId: created.workbenchId,
						snapshot: created.snapshot,
						validation: created.validation,
						caveat: created.caveat,
					},
				};
			} catch (e) {
				return { content: [{ type: "text", text: (e as Error).message }], details: undefined, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "artifact_deck_workbench_get",
		label: "Get transient PPTX deck workbench",
		description: "Get current transient in-memory PPTX deck workbench state summary and bounded details. No filesystem access.",
		promptSnippet: "Use `artifact_deck_workbench_get` to inspect current transient workbench state by workbenchId.",
		parameters: Type.Object({
			workbenchId: Type.String({ description: "Transient workbench id from artifact_deck_workbench_create_blank." }),
		}),
		async execute(_id, { workbenchId }) {
			try {
				const state = getDeckWorkbenchOrError(workbenchId);
				const previewSlides = state.draft.slides.slice(0, PPTX_DRAFT_REPORT_MAX_PREVIEW_SLIDES).map((slide) => ({
					sourceSlideNumber: slide.source?.slideIndex ?? null,
					title: compactExcerpt(slide.title, PPTX_DRAFT_REPORT_MAX_TITLE),
					keyMessageExcerpt: compactExcerpt(slide.keyMessage, PPTX_DRAFT_REPORT_MAX_KEY_MESSAGE),
					bulletCount: Array.isArray(slide.bullets) ? slide.bullets.length : 0,
					hasSpeakerNotes: Boolean(nonEmpty(slide.speakerNotes)),
				}));
				return {
					content: [{ type: "text", text: formatDeckWorkbenchSummary(state) }],
					details: {
						workbenchId: state.id,
						id: state.id,
						createdAt: state.createdAt,
						updatedAt: state.updatedAt,
						source: state.source,
						reuseIntent: state.reuseIntent,
						formatReference: state.formatReference,
						intent: state.intent,
						draftSummary: {
						title: state.draft.title,
						subtitle: state.draft.subtitle,
						audience: state.draft.audience,
						slideCount: state.draft.slides.length,
						slidesPreview: previewSlides,
					},
						validation: {
							ready: state.validation.ready,
							summary: state.validation.summary.slice(0, PPTX_DRAFT_REPORT_MAX_SUMMARY),
							errors: state.validation.errors.slice(0, PPTX_WORKBENCH_MAX_SUMMARY_ISSUES),
							warnings: state.validation.warnings.slice(0, PPTX_WORKBENCH_MAX_SUMMARY_ISSUES),
						},
						caveat: "Transient scratch workbench; any attached .pptx is approximate style evidence only. No PPTX output/export/rendering is performed here.",
					},
				};
			} catch (e) {
				return { content: [{ type: "text", text: (e as Error).message }], details: undefined, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "artifact_deck_workbench_update",
		label: "Update transient PPTX deck workbench",
		description: "Deterministically update draft deck/slide fields on a transient in-memory PPTX deck workbench. No slide add/remove/reorder, no type changes, no writes or rendering.",
		promptSnippet: "Use `artifact_deck_workbench_update` for small deterministic in-memory workbench edits by workbenchId. It does not persist, render, write, or export.",
		parameters: Type.Object({
			workbenchId: Type.String({ description: "Transient workbench id from artifact_deck_workbench_create." }),
			title: Type.Optional(Type.String({ description: "Optional deck title update. Must stay non-empty after trim." })),
			subtitle: Type.Optional(Type.String({ description: "Optional deck subtitle update. Empty string clears." })),
			audience: Type.Optional(Type.String({ description: "Optional deck audience update. Empty string clears." })),
			slides: Type.Optional(Type.Array(Type.Object({
				slideId: Type.Optional(Type.String({ description: "Slide identifier (draft slide id or source slideId)." })),
				slideIndex: Type.Optional(Type.Number({ description: "1-based slide position in draft." })),
				title: Type.Optional(Type.String({ description: "Slide title update. Must stay non-empty after trim." })),
				keyMessage: Type.Optional(Type.String({ description: "Optional key message update. Empty string clears." })),
				bullets: Type.Optional(Type.Array(Type.String(), { description: "Full bullets replacement array." })),
				speakerNotes: Type.Optional(Type.String({ description: "Optional speaker notes update. Empty string clears." })),
				visualIdea: Type.Optional(Type.String({ description: "Optional visual idea update. Empty string clears." })),
			}))),
		}),
		async execute(_id, params) {
			try {
				const state = getDeckWorkbenchOrError(params.workbenchId);
				const changedDeckFields: string[] = [];
				const slideChanges: string[] = [];
				let changedFieldCount = 0;
				const draft = cloneDeckWorkbenchDraft(state.draft);

				if (Object.prototype.hasOwnProperty.call(params, "title")) {
					const value = nonEmpty(params.title);
					if (!value) throw new Error("Deck title is required and must not be empty.");
					if (draft.title !== value) {
						draft.title = value;
						changedDeckFields.push("title");
						changedFieldCount += 1;
					}
				}
				if (Object.prototype.hasOwnProperty.call(params, "subtitle")) {
					const raw = String(params.subtitle ?? "").trim();
					const next = raw || undefined;
					if ((draft.subtitle ?? undefined) !== next) {
						draft.subtitle = next;
						changedDeckFields.push("subtitle");
						changedFieldCount += 1;
					}
				}
				if (Object.prototype.hasOwnProperty.call(params, "audience")) {
					const raw = String(params.audience ?? "").trim();
					const next = raw || undefined;
					if ((draft.audience ?? undefined) !== next) {
						draft.audience = next;
						changedDeckFields.push("audience");
						changedFieldCount += 1;
					}
				}

				const updates = Array.isArray(params.slides) ? params.slides : [];
				const touchedSlides = new Set<number>();
				for (let i = 0; i < updates.length; i += 1) {
					const update = updates[i] || {};
					const { index, slide } = resolveWorkbenchSlideUpdateTarget(draft.slides, update, i + 1);
					const fields: string[] = [];
					if (Object.prototype.hasOwnProperty.call(update, "title")) {
						const value = nonEmpty(update.title);
						if (!value) throw new Error(`Slide ${index + 1} title is required and must not be empty.`);
						if (slide.title !== value) {
							slide.title = value;
							fields.push("title");
							changedFieldCount += 1;
						}
					}
					if (Object.prototype.hasOwnProperty.call(update, "keyMessage")) {
						const next = nonEmpty(update.keyMessage) || undefined;
						if ((slide.keyMessage ?? undefined) !== next) {
							slide.keyMessage = next;
							fields.push("keyMessage");
							changedFieldCount += 1;
						}
					}
					if (Object.prototype.hasOwnProperty.call(update, "bullets")) {
						const nextBullets = Array.isArray(update.bullets) ? update.bullets.map((b) => nonEmpty(b)).filter(Boolean) : [];
						const prevBullets = Array.isArray(slide.bullets) ? slide.bullets : [];
						if (JSON.stringify(prevBullets) !== JSON.stringify(nextBullets)) {
							slide.bullets = nextBullets.length ? nextBullets : undefined;
							fields.push("bullets");
							changedFieldCount += 1;
						}
					}
					if (Object.prototype.hasOwnProperty.call(update, "speakerNotes")) {
						const next = nonEmpty(update.speakerNotes) || undefined;
						if ((slide.speakerNotes ?? undefined) !== next) {
							slide.speakerNotes = next;
							fields.push("speakerNotes");
							changedFieldCount += 1;
						}
					}
					if (Object.prototype.hasOwnProperty.call(update, "visualIdea")) {
						const next = nonEmpty(update.visualIdea) || undefined;
						if ((slide.visualIdea ?? undefined) !== next) {
							slide.visualIdea = next;
							fields.push("visualIdea");
							changedFieldCount += 1;
						}
					}
					if (fields.length) {
						touchedSlides.add(index + 1);
						slideChanges.push(`slide ${index + 1}: ${fields.join(",")}`);
					}
				}

				const validation = validateDeckSpecDraftForWorkbench(draft);
				const updatedAt = new Date().toISOString();
				state.draft = draft;
				state.validation = validation;
				state.updatedAt = updatedAt;
				deckWorkbenchStore.set(state.id, state);
				const codes = [
					...validation.errors.slice(0, PPTX_WORKBENCH_UPDATE_MAX_CODES).map((e) => e.code),
					...validation.warnings.slice(0, PPTX_WORKBENCH_UPDATE_MAX_CODES).map((w) => w.code),
				];
				return {
					content: [{
						type: "text",
						text: [
							`Updated deck workbench: ${state.id}`,
							`Changed fields: ${changedFieldCount}; changed slides: ${touchedSlides.size}`,
							`Readiness: ready=${validation.ready ? "true" : "false"}`,
							`Codes: ${codes.length ? codes.join(", ") : "none"}`,
							`Changes: deck fields changed: ${changedDeckFields.length ? changedDeckFields.join(",") : "none"}; slide changes: ${slideChanges.slice(0, PPTX_WORKBENCH_UPDATE_MAX_SLIDE_CHANGES).join(" | ") || "none"}`,
							"Caveat: transient in-memory only; no rendering/write/PPTX output performed.",
						].join("\n"),
					}],
					details: {
						workbenchId: state.id,
						updatedAt: state.updatedAt,
						changed: {
							fieldCount: changedFieldCount,
							slideCount: touchedSlides.size,
							deckFields: changedDeckFields,
							slideChanges: slideChanges.slice(0, PPTX_WORKBENCH_UPDATE_MAX_SLIDE_CHANGES),
							slideChangesTruncated: slideChanges.length > PPTX_WORKBENCH_UPDATE_MAX_SLIDE_CHANGES,
						},
						validation: {
							ready: validation.ready,
							summary: validation.summary.slice(0, PPTX_DRAFT_REPORT_MAX_SUMMARY),
							errors: validation.errors.slice(0, PPTX_WORKBENCH_MAX_SUMMARY_ISSUES),
							warnings: validation.warnings.slice(0, PPTX_WORKBENCH_MAX_SUMMARY_ISSUES),
						},
						draftSummary: {
							title: compactExcerpt(state.draft.title, PPTX_DRAFT_REPORT_MAX_TITLE),
							subtitle: compactExcerpt(state.draft.subtitle, PPTX_DRAFT_REPORT_MAX_KEY_MESSAGE),
							audience: compactExcerpt(state.draft.audience, PPTX_DRAFT_REPORT_MAX_KEY_MESSAGE),
							slideCount: state.draft.slides.length,
							slidesPreview: state.draft.slides.slice(0, PPTX_DRAFT_REPORT_MAX_PREVIEW_SLIDES).map((slide) => ({
								sourceSlideNumber: slide.source?.slideIndex ?? null,
								title: compactExcerpt(slide.title, PPTX_DRAFT_REPORT_MAX_TITLE),
								keyMessageExcerpt: compactExcerpt(slide.keyMessage, PPTX_DRAFT_REPORT_MAX_KEY_MESSAGE),
								bulletCount: Array.isArray(slide.bullets) ? slide.bullets.length : 0,
								hasSpeakerNotes: Boolean(nonEmpty(slide.speakerNotes)),
							})),
						},
						caveat: "Transient in-memory only; no rendering/write/PPTX output performed.",
					},
				};
			} catch (e) {
				return { content: [{ type: "text", text: (e as Error).message }], details: undefined, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "artifact_deck_workbench_validate",
		label: "Validate transient PPTX deck workbench",
		description: "Re-run draft validation for a transient in-memory PPTX deck workbench and return readiness/report. No writes or rendering.",
		promptSnippet: "Use `artifact_deck_workbench_validate` to re-run readiness and validation summary for a transient workbench.",
		parameters: Type.Object({
			workbenchId: Type.String({ description: "Transient workbench id from artifact_deck_workbench_create." }),
		}),
		async execute(_id, { workbenchId }) {
			try {
				const state = getDeckWorkbenchOrError(workbenchId);
				const validation = validateDeckSpecDraftForWorkbench(state.draft);
				const repairTargets = buildWorkbenchRepairTargets(state.draft, validation);
				const summaryState: DeckWorkbenchState = { ...state, validation };
				return {
					content: [{ type: "text", text: formatDeckWorkbenchSummary(summaryState) }],
					details: {
						workbenchId: state.id,
						ready: validation.ready,
						summary: validation.summary.slice(0, PPTX_DRAFT_REPORT_MAX_SUMMARY),
						errors: validation.errors.slice(0, PPTX_WORKBENCH_MAX_SUMMARY_ISSUES),
						warnings: validation.warnings.slice(0, PPTX_WORKBENCH_MAX_SUMMARY_ISSUES),
						repairTargets,
						caveat: "PPTX is inspection-only reference input; no PPTX output/export/rendering is performed.",
					},
				};
			} catch (e) {
				return { content: [{ type: "text", text: (e as Error).message }], details: undefined, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "artifact_deck_workbench_assist_context",
		label: "Get transient deck workbench assist context",
		description: "Return deterministic bounded selected-scope context for targeted deck assist. No mutation, no writes, no approval, no model calls, no suggestions, no export.",
		promptSnippet: "Use `artifact_deck_workbench_assist_context` to fetch bounded selected slide/field or repair-target context only. Apply changes later via update/repair + validate.",
		parameters: Type.Object({
			workbenchId: Type.String({ description: "Transient workbench id from artifact_deck_workbench_create." }),
			slideId: Type.Optional(Type.String({ description: "Selected slide identifier (draft slide id or source slideId)." })),
			slideIndex: Type.Optional(Type.Number({ description: "Selected 1-based slide index." })),
			field: Type.Optional(Type.Union([
				Type.Literal("title"),
				Type.Literal("keyMessage"),
				Type.Literal("bullets"),
				Type.Literal("speakerNotes"),
				Type.Literal("visualIdea"),
			])),
			assistAction: Type.Union([
				Type.Literal("rewrite_bullets"),
				Type.Literal("suggest_key_message"),
				Type.Literal("critique_slide"),
				Type.Literal("suggest_repair_target"),
			]),
			repairTargetId: Type.Optional(Type.String({ description: "Required when assistAction is suggest_repair_target." })),
			audience: Type.Optional(Type.String({ description: "Optional targeted audience hint." })),
			goal: Type.Optional(Type.String({ description: "Optional targeted goal hint." })),
		}),
		async execute(_id, params): Promise<{ content: Array<{ type: "text"; text: string }>; details: DeckWorkbenchAssistDetails; isError?: boolean }> {
			try {
				const state = getDeckWorkbenchOrError(params.workbenchId);
				const assistAction = params.assistAction as DeckWorkbenchAssistAction;
				const field = (params.field ?? "bullets") as DeckWorkbenchAssistField;
				const { index, slide } = resolveWorkbenchAssistSlideTarget(state.draft.slides, { slideId: params.slideId, slideIndex: params.slideIndex });
				const validation = validateDeckSpecDraftForWorkbench(state.draft);
				const repairTargets = buildWorkbenchRepairTargets(state.draft, validation);
				let selectedRepairTarget: WorkbenchRepairTarget | undefined;
				if (assistAction === "suggest_repair_target") {
					const id = nonEmpty(params.repairTargetId);
					if (!id) throw new Error("assist_repair_target_required: repairTargetId is required for suggest_repair_target.");
					selectedRepairTarget = repairTargets.find((target) => target.id === id);
					if (!selectedRepairTarget) throw new Error("assist_repair_target_invalid: repairTargetId not found in current validation context.");
				}

				const relevantValidation = repairTargets
					.filter((target) => (target.slideIndex ? target.slideIndex === index + 1 : true))
					.slice(0, PPTX_WORKBENCH_MAX_SUMMARY_ISSUES)
					.map((target) => ({ id: target.id, category: target.category, field: target.field, severity: target.severity }));

				const details: DeckWorkbenchAssistDetails = {
					assistContextVersion: "1",
					workbenchId: state.id,
					affectedScope: {
						slideIndex: index + 1,
						slideId: slide.id,
						sourceSlideId: slide.source?.slideId,
						field,
					},
					assistAction,
					selectedContent: buildAssistFieldSelection(slide, field),
					slideContext: {
						title: compactExcerpt(slide.title, PPTX_WORKBENCH_ASSIST_MAX_TEXT),
						keyMessage: compactExcerpt(slide.keyMessage, PPTX_WORKBENCH_ASSIST_MAX_TEXT),
						bullets: (Array.isArray(slide.bullets) ? slide.bullets : []).slice(0, PPTX_WORKBENCH_ASSIST_MAX_BULLETS).map((b) => compactExcerpt(b, PPTX_WORKBENCH_ASSIST_MAX_TEXT)).filter(Boolean),
						speakerNotes: compactExcerpt(slide.speakerNotes, PPTX_WORKBENCH_ASSIST_MAX_TEXT),
					},
					deckContext: {
						title: compactExcerpt(state.draft.title, PPTX_WORKBENCH_ASSIST_MAX_TEXT),
						subtitle: compactExcerpt(state.draft.subtitle, PPTX_WORKBENCH_ASSIST_MAX_TEXT),
						audience: compactExcerpt(params.audience ?? state.draft.audience, PPTX_WORKBENCH_ASSIST_MAX_TEXT),
						goal: compactExcerpt(params.goal, PPTX_WORKBENCH_ASSIST_MAX_TEXT),
						reuseIntent: state.reuseIntent,
					},
					validationContextUsed: {
						ready: validation.ready,
						summary: validation.summary.slice(0, 3),
						relevantTargets: relevantValidation,
						repairTargetId: selectedRepairTarget?.id,
					},
					constraints: [
						"selected_scope_only",
						"no_whole_deck_rewrite",
						"apply_via_artifact_deck_workbench_update_or_repair",
						"revalidate_after_apply",
					],
					noMutation: true,
					caveat: "Context only: no writes, no approvals, no model calls, no PPTX/HTML export.",
				};
				return {
					content: [{ type: "text", text: `Deck workbench assist context: ${state.id}\nScope: slide ${index + 1} / ${field}\nAction: ${assistAction}\nCaveat: context only; apply remains via artifact_deck_workbench_update or artifact_deck_workbench_repair.` }],
					details,
				};
			} catch (e) {
				const message = String((e as Error).message || "assist_context_failed");
				const code = message.split(":")[0] || "assist_context_failed";
				const safeMessage = message.includes(":") ? message.slice(message.indexOf(":") + 1).trim() : message;
				const details: DeckWorkbenchAssistDetails = {
					assistContextVersion: "1",
					workbenchId: nonEmpty(params.workbenchId) || "unknown",
					affectedScope: { slideIndex: 1, slideId: "unknown", sourceSlideId: undefined, field: (params.field ?? "bullets") as DeckWorkbenchAssistField },
					assistAction: (params.assistAction as DeckWorkbenchAssistAction) ?? "critique_slide",
					selectedContent: "",
					slideContext: { title: "", keyMessage: "", bullets: [], speakerNotes: "" },
					deckContext: { title: "", subtitle: "", audience: "", goal: "", reuseIntent: "scratch" },
					validationContextUsed: { ready: false, summary: [], relevantTargets: [] },
					constraints: ["selected_scope_only", "no_whole_deck_rewrite", "apply_via_artifact_deck_workbench_update_or_repair", "revalidate_after_apply"],
					noMutation: true,
					caveat: "Context only: no writes, no approvals, no model calls, no PPTX/HTML export.",
					error: { code, message: safeMessage },
				};
				return { content: [{ type: "text", text: `Assist context failed (${code}): ${safeMessage}` }], details, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "artifact_deck_workbench_repair",
		label: "Repair transient PPTX deck workbench bullets",
		description: "Deterministic mechanical bullet cleanup for a transient in-memory deck workbench (trim/collapse whitespace, remove empty bullets, dedupe same-slide bullets). Preview by default; apply only when requested.",
		promptSnippet: "Use `artifact_deck_workbench_repair` for safe mechanical bullet cleanup only. It does not rewrite titles/key messages, write files, or persist workbench state.",
		parameters: Type.Object({
			workbenchId: Type.String({ description: "Transient workbench id from artifact_deck_workbench_create." }),
			apply: Type.Optional(Type.Boolean({ description: "If true, apply deterministic bullet cleanup to transient workbench state. Default false (preview only)." })),
		}),
		async execute(_id, { workbenchId, apply = false }): Promise<{ content: Array<{ type: "text"; text: string }>; details: DeckWorkbenchRepairDetails | undefined; isError?: boolean }> {
			try {
				const result = repairDeckWorkbenchForUi({ workbenchId, apply });
				return {
					content: [{
						type: "text",
						text: result.apply
							? [
								`Deck workbench repaired: ${result.workbenchId}`,
								`Applied bullet cleanup changes: ${result.appliedChanges.length}`,
								`Skipped non-deterministic issues: ${result.skippedIssues.length}`,
								"Caveat: applied changes are transient in-memory only.",
							].join("\n")
							: [
								`Deck workbench repair preview: ${result.workbenchId}`,
								`Proposed bullet cleanup changes: ${result.proposedChanges.length}`,
								`Skipped non-deterministic issues: ${result.skippedIssues.length}`,
								"Caveat: preview only; transient state unchanged.",
							].join("\n"),
					}],
					details: {
						workbenchId: result.workbenchId,
						apply: result.apply,
						proposedChanges: result.proposedChanges,
						appliedChanges: result.appliedChanges,
						skippedIssues: result.skippedIssues,
						preValidation: result.preValidation,
						postValidation: result.postValidation,
						caveat: result.caveat,
					},
				};
			} catch (e) {
				return { content: [{ type: "text", text: (e as Error).message }], details: undefined, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "artifact_deck_workbench_preview_html",
		label: "Preview transient PPTX deck workbench as HTML",
		description: "Read-only transient workbench HTML preview: revalidates current draft, prepares a clean DeckSpec, renders deterministic HTML in memory, validates rendered HTML, and returns a bounded preview report. No writes, no approval, no persistence, no PPTX output.",
		promptSnippet: "Use `artifact_deck_workbench_preview_html` for a read-only bounded HTML preview from a transient workbench. It does not write files, prompt for approval, persist state, or produce PPTX output/export.",
		parameters: Type.Object({
			workbenchId: Type.String({ description: "Transient workbench id from artifact_deck_workbench_create." }),
			footer: Type.Optional(Type.String({ description: "Optional footer text for this in-memory HTML preview render." })),
		}),
		async execute(_id, { workbenchId, footer }) {
			try {
				const state = getDeckWorkbenchOrError(workbenchId);
				const preview = previewDeckWorkbenchHtmlForUi({ workbenchId: state.id, footer, maxPreviewChars: PPTX_WORKBENCH_HTML_PREVIEW_MAX_CHARS });
				const details: DeckWorkbenchPreviewHtmlDetails = {
					...preview,
					source: {
						kind: state.source.kind,
						destination: state.source.destination,
						relativePath: state.source.relativePath,
						title: state.source.title,
						slideCount: state.source.slideCount,
						extractionVersion: state.source.extractionVersion,
					},
				};
				const blocking = !preview.ready || preview.renderedValidation.errors.length > 0;
				return {
					content: [{ type: "text", text: formatDeckWorkbenchPreviewHtmlReport(details) }],
					details,
					isError: blocking ? true : undefined,
				};
			} catch (e) {
				return { content: [{ type: "text", text: (e as Error).message }], details: undefined, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "artifact_deck_workbench_write_html",
		label: "Write transient workbench HTML deck artifact",
		description: "Approval-gated local HTML save from a transient in-memory deck workbench: revalidates draft readiness, prepares clean DeckSpec, renders deterministic HTML, validates rendered safety/shape, and writes only after approval. HTML only; no PPTX output/export.",
		promptSnippet: "Use `artifact_deck_workbench_write_html` after workbench validation/preview to approval-save the current transient workbench state as a local HTML deck artifact. It does not persist or mutate workbench state and does not produce PPTX output/export.",
		parameters: Type.Object({
			workbenchId: Type.String({ description: "Transient workbench id from artifact_deck_workbench_create." }),
			filename: Type.String({ description: "Relative artifact filename ending in .html." }),
			destination: Type.Optional(Type.String({ description: "Approved destination name. Default: default (~/.exxperts/app/artifacts)." })),
			folder: Type.Optional(Type.String({ description: "Optional relative folder inside the destination." })),
			footer: Type.Optional(Type.String({ description: "Optional footer text for rendered HTML." })),
			reason: Type.Optional(Type.String({ description: "Why this deck artifact should be saved." })),
		}),
		async execute(_id, { workbenchId, filename, destination, folder, footer, reason }, _signal, _onUpdate, ctx) {
			try {
				const state = getDeckWorkbenchOrError(workbenchId);
				const validation = validateDeckSpecDraftForWorkbench(state.draft);
				if (!validation.ready) {
					return {
						content: [{ type: "text", text: `Deck workbench is not ready for HTML save: ${validation.summary[0] ?? "fix validation issues first."}` }],
						details: {
							saved: false,
							workbenchId: state.id,
							ready: false,
							validation: {
								summary: validation.summary.slice(0, PPTX_DRAFT_REPORT_MAX_SUMMARY),
								errors: validation.errors.slice(0, PPTX_WORKBENCH_MAX_SUMMARY_ISSUES),
								warnings: validation.warnings.slice(0, PPTX_WORKBENCH_MAX_SUMMARY_ISSUES),
							},
							caveat: "PPTX is inspection-only reference input; output in this flow is HTML only.",
						},
						isError: true,
					};
				}

				const target = validateArtifactPath(filename, destination, folder);
				if (target.extension !== ".html") throw new Error("Workbench HTML artifacts must use a .html filename.");

				const deckSpec = prepareDeckSpecDraftForHtmlRendering(state.draft);
				const body = renderHtmlDeckFromSpec(deckSpec, { footer: nonEmpty(footer) || undefined });
				const renderedValidation = validateRenderedHtmlDeck(deckSpec, body);
				if (renderedValidation.errors.length > 0) {
					return {
						content: [{ type: "text", text: `Rendered HTML deck validation failed: ${renderedValidation.errors.map((e) => e.message).join(" ")}` }],
						details: {
							saved: false,
							workbenchId: state.id,
							validation: renderedValidation,
							caveat: "PPTX is inspection-only reference input; output in this flow is HTML only.",
						},
						isError: true,
					};
				}

				const filenameWarnings = evaluateDeckFilenameWarnings(target.relativePath);
				const warnings = [...validation.warnings, ...renderedValidation.warnings, ...filenameWarnings];
				const warningSummary = formatDeckWarningSummary(warnings);
				const exists = fs.existsSync(target.fullPath);
				const ok = await approve(
					ctx,
					exists ? "Replace local HTML deck from workbench?" : "Create local HTML deck from workbench?",
					[
						...targetDetail(target, exists, reason),
						`Workbench: ${state.id}`,
						`Slides: ${deckSpec.slides.length}`,
						warningSummary ? "" : undefined,
						warningSummary || undefined,
						"",
						"Generated HTML preview:",
						approvalPreviewContent(body),
					].filter(Boolean).join("\n"),
				);
				if (!ok) {
					return {
						content: [{ type: "text", text: "Workbench HTML deck artifact not saved; user approval missing or declined." }],
						details: {
							saved: false,
							workbenchId: state.id,
							destination: target.destination.name,
							path: target.fullPath,
							relativePath: target.relativePath,
							replaced: exists,
							slides: deckSpec.slides.length,
							warnings,
							caveat: "PPTX is inspection-only reference input; output in this flow is HTML only.",
						},
						isError: !ctx.hasUI,
					};
				}

				fs.mkdirSync(path.dirname(target.fullPath), { recursive: true, mode: 0o700 });
				fs.writeFileSync(target.fullPath, body.trimEnd() + "\n", { mode: 0o600 });
				ctx.ui.notify(`Saved HTML deck artifact: ${target.fullPath}`, "info");
				const action = exists ? "Replaced" : "Created";
				const baseText = `${action} local HTML deck artifact from transient workbench: ${target.fullPath}`;
				return {
					content: [{ type: "text", text: warningSummary ? `${baseText}\n${warningSummary}` : baseText }],
					details: {
						saved: true,
						workbenchId: state.id,
						destination: target.destination.name,
						path: target.fullPath,
						relativePath: target.relativePath,
						replaced: exists,
						slides: deckSpec.slides.length,
						warnings,
						sourceSummary: {
							kind: state.source.kind,
							destination: state.source.destination,
							relativePath: state.source.relativePath,
							title: state.source.title,
							reuseIntent: state.reuseIntent,
						},
						caveat: "PPTX is inspection-only reference input; output in this flow is HTML only.",
					},
				};
			} catch (e) {
				return { content: [{ type: "text", text: (e as Error).message }], details: { saved: false }, isError: true };
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
			"Use `artifact_write` when the user explicitly asks to save a non-deck local Markdown/HTML artifact, explicitly asks for a Markdown deck/outline, or provides an accessible HTML reference deck/template and asks to match its format closely. For generic saved slide decks prefer `artifact_write_html_deck`, but use raw `.html` here when preserving reference CSS/layout is materially required. It requires approval and can write only .md/.html/.svg under the default or an approved artifact destination.",
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
