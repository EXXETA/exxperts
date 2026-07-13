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
		label: "SVG diagram",
		version: 1,
		outputExtensions: [".svg"],
		toolNames: ["artifact_write", "artifact_read", "artifact_list"],
		renderProfile: "img",
		exportMenu: ["file", "workspace"],
		doctrineLine: "diagram-svg — a standalone SVG diagram (architecture, flow, timeline); no scripts, no external references.",
		promptIntro: [
			"You produce ONE self-contained SVG diagram (plus optional variants) with `artifact_write`.",
			"The SVG must be fully self-contained: no <script>, no event handlers, no external hrefs/images/fonts, no <foreignObject>.",
			"It will be displayed via <img>, so anything script-dependent will simply not render.",
			"Set an explicit viewBox and design for legibility at ~800px wide.",
		].join("\n"),
	},
	{
		id: "chart-html",
		label: "HTML chart",
		version: 1,
		outputExtensions: [".html"],
		toolNames: ["artifact_write", "artifact_read", "artifact_list"],
		renderProfile: "iframe-static",
		exportMenu: ["file", "workspace"],
		doctrineLine: "chart-html — a static self-contained HTML chart page (SVG/CSS based, no JavaScript) from data supplied in the brief.",
		promptIntro: [
			"You produce ONE self-contained HTML page presenting the chart(s) with `artifact_write`.",
			"Render charts as inline SVG or CSS — the page is displayed in a no-scripts sandbox, so JavaScript will not run.",
			"All data comes from the brief or the listed input artifacts; you have no way to fetch anything, so never invent numbers.",
			"Inline all styling; no external stylesheets, fonts, images, or scripts.",
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
		version: 2,
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
			"Static HTML + inline CSS only — the deck is displayed in a no-scripts sandbox, so JavaScript will not run. No external references of any kind (stylesheets, fonts, images, scripts); embed small images as data: URIs if truly needed.",
			"Aim for consulting-grade quality: one message per slide, an opening framing slide and a closing action slide — and design real layout for the content (card grids, chips, accent colors, strong typographic hierarchy), never walls of bullets.",
		].join("\n"),
	},
	{
		id: "document-html",
		label: "Visual document",
		version: 1,
		outputExtensions: [".html"],
		toolNames: ["artifact_write", "artifact_read", "artifact_list"],
		renderProfile: "iframe-static",
		exportMenu: ["file", "workspace"],
		doctrineLine: "document-html — a free-form self-contained HTML document (visual digest, report, one-pager); static HTML+CSS only.",
		promptIntro: [
			"You produce ONE self-contained HTML document with `artifact_write` — a visually structured page, not a slide deck.",
			"The page is displayed in a no-scripts sandbox: HTML + inline CSS only; JavaScript will not run.",
			"No external references of any kind (stylesheets, fonts, images, scripts); embed small images as data: URIs if truly needed.",
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
