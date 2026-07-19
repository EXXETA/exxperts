/**
 * Static specialist-template registry (visuals contract spec §2, v1).
 *
 * A template is the complete definition of what one kind of specialist may
 * do: which artifact tools it gets, what it may write, how its output is
 * rendered and exported. Templates are code, not user data — nothing here is
 * configurable at runtime, and every tool a template names must come from the
 * closed grantable set below (inheritance, never escalation; web tools are
 * deliberately absent from that set — D6).
 */

import {
	MAX_SVG_ARTIFACT_BYTES,
	MAX_SCOPED_HTML_ARTIFACT_BYTES,
	MAX_SCOPED_MD_ARTIFACT_BYTES,
} from "../../../pi-package/extensions/artifacts/index.js";

/** The only tools a specialist template may grant (visuals contract §2/§3). */
export const SPECIALIST_GRANTABLE_TOOL_NAMES = new Set<string>([
	"artifact_write",
	"artifact_write_html_deck",
	"artifact_read",
	"artifact_list",
]);

// Names/prefixes that must never appear in a specialist session no matter
// what a template claims. This is a second, independent floor under the
// grantable-set check — both must fail for a forbidden tool to slip through.
const SPECIALIST_FORBIDDEN_TOOL_PATTERN = /^(memory_|kb_|mcp)|^(bash|delegate|start_handoff|return_handoff|web_search|fetch_url|read_skill)$/;

/** D9 caps, shared by all v1 templates. */
export const SPECIALIST_TASK_CAPS = {
	maxArtifacts: 8,
	maxTotalBytes: 40_000_000,
	perFileBytesByExtension: {
		".svg": MAX_SVG_ARTIFACT_BYTES,
		".html": MAX_SCOPED_HTML_ARTIFACT_BYTES,
		".md": MAX_SCOPED_MD_ARTIFACT_BYTES,
	} as Record<string, number>,
} as const;

export type SpecialistRenderProfile =
	| "img" // consumed via <img> — non-scriptable (SVG)
	| "iframe-static"; // consumed via sandboxed iframe with sandbox="" (no scripts)

/**
 * The output-constraint block for a render profile, single-sourced (prompt
 * hardening slice 2): these lines state exactly what the write-time validators
 * (`validateRawSvgArtifactContent` / `validateRawHtmlArtifactContent`) enforce,
 * so the specialist prompt can never drift from enforcement again. Template
 * `promptIntro`s carry task-shape guidance only — never constraint wording.
 */
export function specialistRenderProfileConstraints(profile: SpecialistRenderProfile): string {
	if (profile === "img") {
		return [
			"Output constraints (validation-enforced at write time — a violating write is rejected):",
			"- Fully static, self-contained SVG: no <script>, no event handlers (onclick=, onload=, …), no <foreignObject>, no iframe/object/embed.",
			"- No external references and no embedded images: no src attributes (external, local, or data:), no CSS @import. Same-document references are fine and encouraged: <use href=\"#id\">, fill=\"url(#gradient)\".",
			"- No URLs anywhere, not even as visible text — refer to sources by name instead. (The standard SVG xmlns declarations are allowed.)",
			"- The file is displayed via <img>: anything script-dependent would not render even if it could be written.",
		].join("\n");
	}
	return [
		"Output constraints (validation-enforced at write time — a violating write is rejected):",
		"- Fully static, self-contained HTML: no <script>, no inline event handlers (onclick=, onload=, …), no iframe/object/embed. The page is displayed in a no-scripts sandbox, so JavaScript would not run anyway.",
		"- No external references and no images: no src attributes (external, local, or data:), no external stylesheets or fonts, no CSS @import. Express visuals with inline SVG and CSS; put all styling in an inline <style> block.",
		"- No URLs anywhere, not even as visible text — refer to sources by name instead.",
		"- Links only as same-document fragments (href=\"#some-id\").",
	].join("\n");
}

export type SpecialistExportOption = "file" | "workspace" | "pptx";

export interface SpecialistTemplate {
	id: string;
	label: string;
	version: number;
	/** Extensions the template is expected to produce (informational + smoke-checked). */
	outputExtensions: string[];
	/** Exact session tool allowlist; must be a subset of SPECIALIST_GRANTABLE_TOOL_NAMES. */
	toolNames: string[];
	renderProfile: SpecialistRenderProfile;
	exportMenu: SpecialistExportOption[];
	/** One-line L0 doctrine entry (consumed by V2's delegate_task prompt lines). */
	doctrineLine: string;
	/** Template-specific working instructions inside the specialist system prompt. */
	promptIntro: string;
}

const TEMPLATES: SpecialistTemplate[] = [
	{
		id: "diagram-svg",
		label: "Diagram",
		// v2 (prompt hardening slice 2, 2026-07-17): constraint wording moved out
		// of promptIntro into the profile-derived block; write-time SVG validation
		// now enforces what the old intro only asked for.
		version: 2,
		outputExtensions: [".svg"],
		toolNames: ["artifact_write", "artifact_read", "artifact_list"],
		renderProfile: "img",
		exportMenu: ["file", "workspace"],
		doctrineLine: "diagram-svg — a standalone SVG diagram (architecture, flow, timeline); no scripts, no external references.",
		promptIntro: [
			"You produce ONE self-contained SVG diagram (plus optional variants) with `artifact_write`.",
			"Set an explicit viewBox and design for legibility at ~800px wide.",
		].join("\n"),
	},
	{
		id: "chart-html",
		label: "Chart",
		// v2 (prompt hardening slice 2, 2026-07-17): constraint wording single-
		// sourced into the profile-derived block.
		version: 2,
		outputExtensions: [".html"],
		toolNames: ["artifact_write", "artifact_read", "artifact_list"],
		renderProfile: "iframe-static",
		exportMenu: ["file", "workspace"],
		doctrineLine: "chart-html — a static self-contained HTML chart page (SVG/CSS based, no JavaScript) from data supplied in the brief.",
		promptIntro: [
			"You produce ONE self-contained HTML page presenting the chart(s) with `artifact_write`.",
			"Render charts as inline SVG or CSS.",
			"All data comes from the brief or the listed input artifacts; you have no way to fetch anything, so never invent numbers.",
		].join("\n"),
	},
	{
		id: "deck",
		label: "Slide deck",
		// v2 (D3 amendment, Borja 2026-07-12): free model-authored HTML replaced
		// the deterministic DeckSpecV1 generator — its {title,keyMessage,bullets}
		// schema could not express real slide layouts (card grids, chips, accent
		// panels), so specialist decks came out visibly below main-room quality.
		// Same write validation, sandbox, and scriptless CSP as document-html;
		// the PPTX derivative is deferred until a structured path returns (§9).
		// artifact_write_html_deck stays registered for main-room use.
		// v3 (prompt hardening slice 2, 2026-07-17): constraint wording (static,
		// no external refs, data:-URI line) single-sourced into the profile block;
		// the old intro's data:-URI invitation contradicted the write validator.
		version: 3,
		outputExtensions: [".html"],
		toolNames: ["artifact_write", "artifact_read", "artifact_list"],
		renderProfile: "iframe-static",
		// D7's PPTX export is deferred (spec §9 rides the deck-quality discussion);
		// the menu lists only what the UI can actually do today.
		exportMenu: ["file", "workspace"],
		doctrineLine: "deck — a slide deck as model-designed self-contained HTML (one <section class=\"slide\"> per slide; static, no scripts).",
		promptIntro: [
			"You produce ONE self-contained HTML slide deck with `artifact_write` — you design the markup and CSS yourself.",
			'Structure: exactly one `<section class="slide">` element per slide (this exact class drives slide thumbnails and the slide count); give every slide a consistent 16:9 frame.',
			"Aim for consulting-grade quality: one message per slide, an opening framing slide and a closing action slide — and design real layout for the content (card grids, chips, accent colors, strong typographic hierarchy), never walls of bullets.",
		].join("\n"),
	},
	{
		id: "document-html",
		label: "Document",
		// v2 (prompt hardening slice 2, 2026-07-17): constraint wording single-
		// sourced into the profile block; the old intro's data:-URI invitation
		// contradicted the write validator.
		version: 2,
		outputExtensions: [".html"],
		toolNames: ["artifact_write", "artifact_read", "artifact_list"],
		renderProfile: "iframe-static",
		exportMenu: ["file", "workspace"],
		doctrineLine: "document-html — a free-form self-contained HTML document (visual digest, report, one-pager); static HTML+CSS only.",
		promptIntro: [
			"You produce ONE self-contained HTML document with `artifact_write` — a visually structured page, not a slide deck.",
			"Use clear typographic hierarchy; the point of this format is to be easier to digest than markdown.",
		].join("\n"),
	},
];

const TEMPLATE_INDEX = new Map(TEMPLATES.map((template) => [template.id, template]));

export function listSpecialistTemplates(): SpecialistTemplate[] {
	return [...TEMPLATES];
}

export function getSpecialistTemplate(id: string): SpecialistTemplate | null {
	return TEMPLATE_INDEX.get(String(id ?? "").trim()) ?? null;
}

/**
 * Structural floor for template tool grants; throws on any violation. Runs at
 * plan-build time AND is smoke-asserted for every registered template, so a
 * template edit cannot silently widen the specialist tool surface.
 */
export function assertSpecialistTemplateTools(template: SpecialistTemplate): void {
	if (template.toolNames.length === 0) throw new Error(`specialist template ${template.id} grants no tools`);
	for (const toolName of template.toolNames) {
		if (SPECIALIST_FORBIDDEN_TOOL_PATTERN.test(toolName)) {
			throw new Error(`specialist template ${template.id} grants forbidden tool: ${toolName}`);
		}
		if (!SPECIALIST_GRANTABLE_TOOL_NAMES.has(toolName)) {
			throw new Error(`specialist template ${template.id} grants non-grantable tool: ${toolName}`);
		}
	}
}
