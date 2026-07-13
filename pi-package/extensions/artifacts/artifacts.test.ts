import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import JSZip from "jszip";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-artifacts-"));
process.env.HOME = tempHome;
// os.homedir() ignores HOME on Windows; USERPROFILE keeps the test isolated there too.
process.env.USERPROFILE = tempHome;

const mod = await import("./index.ts");
const registerArtifacts = mod.default;
const normaliseDeckSpecV1 = mod.normaliseDeckSpecV1 as (input: any) => any;
const renderHtmlDeck = mod.renderHtmlDeck as (input: any) => string;
const renderHtmlDeckFromSpec = mod.renderHtmlDeckFromSpec as (deck: any, options?: { footer?: string }) => string;
const validateDeckSpecV1 = mod.validateDeckSpecV1 as (deck: any) => { errors: Array<{ code: string; message: string; slide?: number }>; warnings: Array<{ code: string; message: string; slide?: number }> };
const validateRenderedHtmlDeck = mod.validateRenderedHtmlDeck as (deck: any, html: string) => { errors: Array<{ code: string; message: string; slide?: number }>; warnings: Array<{ code: string; message: string; slide?: number }> };
const validateDeckSpecDraftForWorkbench = mod.validateDeckSpecDraftForWorkbench as (draft: any) => { ready: boolean; errors: Array<{ code: string }>; warnings: Array<{ code: string }>; summary: string[] };
const prepareDeckSpecDraftForHtmlRendering = mod.prepareDeckSpecDraftForHtmlRendering as (draft: any, options?: { requireReady?: boolean }) => any;
const htmlRenderAvailability = mod.htmlRenderAvailability as () => Promise<{ available: boolean; playwright: boolean; browser: boolean; missing: string[]; installHint: string }>;
const renderDeckHtmlToSlideImages = mod.renderDeckHtmlToSlideImages as (html: string, options?: { maxSlides?: number }) => Promise<{ images: Array<{ slideNumber: number; pngBase64: string; bytes: number }>; rendererUsed: string }>;
const getDeckWorkbenchUiSnapshot = mod.getDeckWorkbenchUiSnapshot as (workbenchId: string, slideIndex?: number) => any;
const updateDeckWorkbenchSelectedSlide = mod.updateDeckWorkbenchSelectedSlide as (input: { workbenchId: string; slideIndex: number; title: string; keyMessage?: string; bullets: string[]; speakerNotes?: string; visualIdea?: string }) => any;
const updateDeckWorkbenchDeckMeta = mod.updateDeckWorkbenchDeckMeta as (input: { workbenchId: string; title: string; subtitle?: string; selectedSlideIndex?: number }) => any;
const addDeckWorkbenchSlide = mod.addDeckWorkbenchSlide as (input: { workbenchId: string; afterIndex?: number }) => any;
const deleteDeckWorkbenchSlide = mod.deleteDeckWorkbenchSlide as (input: { workbenchId: string; slideIndex: number }) => any;
const reorderDeckWorkbenchSlide = mod.reorderDeckWorkbenchSlide as (input: { workbenchId: string; fromIndex: number; toIndex: number }) => any;
const previewDeckWorkbenchHtmlForUi = mod.previewDeckWorkbenchHtmlForUi as (input: { workbenchId: string; footer?: string; selectedSlideIndex?: number }) => any;
const previewDeckWorkbenchReferenceHtmlForUi = mod.previewDeckWorkbenchReferenceHtmlForUi as (input: { workbenchId: string; footer?: string; selectedSlideIndex?: number }) => any;
const repairDeckWorkbenchForUi = mod.repairDeckWorkbenchForUi as (input: { workbenchId: string; apply?: boolean; selectedSlideIndex?: number }) => any;
const renderDeckRenderPlanToPptxBuffer = mod.renderDeckRenderPlanToPptxBuffer as (input: { workbenchId: string; plan: unknown }, options?: { maxBytes?: number }) => Promise<{ buffer: Buffer; summary: any }>;
const inspectGeneratedPptxBuffer = mod.inspectGeneratedPptxBuffer as (buffer: Buffer, expectedSlides: number) => Promise<any>;
const prepareDeckRenderPlanPptxForWrite = mod.prepareDeckRenderPlanPptxForWrite as (input: { workbenchId: string; plan: unknown }, options?: { maxBytes?: number; forceInspectionInvalidForTest?: boolean }) => Promise<any>;
const attachDeckWorkbenchFormatReference = mod.attachDeckWorkbenchFormatReference as (input: {
	workbenchId: string;
	filename: string;
	destination?: string;
	folder?: string;
}) => Promise<{ workbenchId: string; snapshot: any; validation: any; caveat: string }>;
// The content-import path (createDeckWorkbenchFromApprovedPptx) was removed: references are now
// style-only evidence attached to a scratch workbench built from the user's own content. This
// test helper preserves that flow — build a blank deck, then attach the .pptx as a format reference.
// reuseIntent/notesUse are accepted but ignored (no content/notes are ever imported).
async function createDeckWorkbenchFromApprovedPptx(input: {
	filename: string;
	destination?: string;
	folder?: string;
	slideCount?: number;
	reuseIntent?: string;
	notesUse?: string;
}): Promise<{ workbenchId: string; snapshot: any; validation: any; caveat: string }> {
	const blank = createBlankDeckWorkbench({ title: "Reference style deck", slideCount: input.slideCount ?? 5, structurePreset: "executive" });
	return await attachDeckWorkbenchFormatReference({
		workbenchId: blank.workbenchId,
		filename: input.filename,
		destination: input.destination,
		folder: input.folder,
	});
}
const createBlankDeckWorkbench = mod.createBlankDeckWorkbench as (input: {
	title: string;
	audience?: string;
	goal?: string;
	slideCount?: number;
	structurePreset?: "executive" | "consulting" | "technical" | "minimal" | "executive_review" | "executive-review" | "strategy" | "consulting_deck" | "technical_review";
}) => { workbenchId: string; snapshot: any; validation: any; caveat: string };
const normaliseDeckStructurePreset = mod.normaliseDeckStructurePreset as (input: unknown) => "executive" | "consulting" | "technical" | "minimal";

type Tool = { name: string; execute: (...args: any[]) => Promise<any> };
const tools = new Map<string, Tool>();
registerArtifacts({ registerTool(tool: Tool) { tools.set(tool.name, tool); } } as any);

const deck = tools.get("artifact_write_html_deck");
const write = tools.get("artifact_write");
const list = tools.get("artifact_list");
const read = tools.get("artifact_read");
const destinations = tools.get("artifact_destinations");
const connect = tools.get("artifact_connect_destination");
const disconnect = tools.get("artifact_disconnect_destination");
const inspectReferenceStyle = tools.get("artifact_inspect_reference_style");
const inspectPptx = tools.get("artifact_inspect_pptx");
const deckWorkbenchCreateBlank = tools.get("artifact_deck_workbench_create_blank");
const deckWorkbenchAttachFormatReference = tools.get("artifact_deck_workbench_attach_format_reference");
const deckWorkbenchReferenceHtmlContext = tools.get("artifact_deck_workbench_reference_html_context");
const deckWorkbenchPreviewReferenceHtml = tools.get("artifact_deck_workbench_preview_reference_html");
const deckWorkbenchPreviewAuthoredHtml = tools.get("artifact_deck_workbench_preview_authored_html");
const deckWorkbenchRenderAuthoredHtmlImages = tools.get("artifact_deck_workbench_render_authored_html_images");
const deckWorkbenchValidateRenderPlan = tools.get("artifact_deck_workbench_validate_render_plan");
const deckWorkbenchGeneratePptxPreview = tools.get("artifact_deck_workbench_generate_reference_pptx_preview");
const deckWorkbenchWritePptx = tools.get("artifact_deck_workbench_write_reference_pptx");
const deckWorkbenchRenderPlanContext = tools.get("artifact_deck_workbench_render_plan_context");
const deckWorkbenchRenderPptxImages = tools.get("artifact_deck_workbench_render_pptx_preview_images");
const validateDeckRenderPlan = mod.validateDeckRenderPlan as (input: { workbenchId: string; plan: unknown }) => any;
const pptxRenderAvailability = mod.pptxRenderAvailability as () => { available: boolean; soffice: boolean; rasteriser: string | null; missing: string[]; installHint: string };
const renderPptxBufferToSlideImages = mod.renderPptxBufferToSlideImages as (buffer: Buffer, options?: { maxSlides?: number; dpi?: number }) => { images: any[]; rendererUsed: string };
const deckWorkbenchGet = tools.get("artifact_deck_workbench_get");
const deckWorkbenchValidate = tools.get("artifact_deck_workbench_validate");
const deckWorkbenchUpdate = tools.get("artifact_deck_workbench_update");
const deckWorkbenchPreviewHtml = tools.get("artifact_deck_workbench_preview_html");
const deckWorkbenchRepair = tools.get("artifact_deck_workbench_repair");
const deckWorkbenchAssistContext = tools.get("artifact_deck_workbench_assist_context");
const deckWorkbenchWriteHtml = tools.get("artifact_deck_workbench_write_html");
assert.ok(deck, "artifact_write_html_deck registered");
assert.equal(typeof normaliseDeckSpecV1, "function", "normaliseDeckSpecV1 exported");
assert.equal(typeof renderHtmlDeckFromSpec, "function", "renderHtmlDeckFromSpec exported");
assert.equal(typeof validateDeckSpecV1, "function", "validateDeckSpecV1 exported");
assert.equal(typeof validateRenderedHtmlDeck, "function", "validateRenderedHtmlDeck exported");
assert.equal(typeof validateDeckSpecDraftForWorkbench, "function", "validateDeckSpecDraftForWorkbench exported");
assert.equal(typeof prepareDeckSpecDraftForHtmlRendering, "function", "prepareDeckSpecDraftForHtmlRendering exported");
assert.equal(typeof getDeckWorkbenchUiSnapshot, "function", "getDeckWorkbenchUiSnapshot exported");
assert.equal(typeof updateDeckWorkbenchSelectedSlide, "function", "updateDeckWorkbenchSelectedSlide exported");
assert.equal(typeof previewDeckWorkbenchHtmlForUi, "function", "previewDeckWorkbenchHtmlForUi exported");
assert.equal(typeof previewDeckWorkbenchReferenceHtmlForUi, "function", "previewDeckWorkbenchReferenceHtmlForUi exported");
assert.equal(typeof repairDeckWorkbenchForUi, "function", "repairDeckWorkbenchForUi exported");
assert.equal(typeof attachDeckWorkbenchFormatReference, "function", "attachDeckWorkbenchFormatReference exported");
assert.equal(typeof createBlankDeckWorkbench, "function", "createBlankDeckWorkbench exported");
assert.equal(typeof normaliseDeckStructurePreset, "function", "normaliseDeckStructurePreset exported");
assert.ok(write, "artifact_write registered");
assert.ok(list, "artifact_list registered");
assert.ok(read, "artifact_read registered");
assert.ok(destinations, "artifact_destinations registered");
assert.ok(connect, "artifact_connect_destination registered");
assert.ok(disconnect, "artifact_disconnect_destination registered");
assert.ok(inspectReferenceStyle, "artifact_inspect_reference_style registered");
assert.ok(inspectPptx, "artifact_inspect_pptx registered");
assert.ok(deckWorkbenchCreateBlank, "artifact_deck_workbench_create_blank registered");
assert.ok(deckWorkbenchAttachFormatReference, "artifact_deck_workbench_attach_format_reference registered");
assert.ok(deckWorkbenchReferenceHtmlContext, "artifact_deck_workbench_reference_html_context registered");
assert.ok(deckWorkbenchPreviewReferenceHtml, "artifact_deck_workbench_preview_reference_html registered");
assert.ok(deckWorkbenchPreviewAuthoredHtml, "artifact_deck_workbench_preview_authored_html registered");
assert.ok(deckWorkbenchRenderAuthoredHtmlImages, "artifact_deck_workbench_render_authored_html_images registered");
assert.ok(deckWorkbenchValidateRenderPlan, "artifact_deck_workbench_validate_render_plan registered");
assert.ok(deckWorkbenchGeneratePptxPreview, "artifact_deck_workbench_generate_reference_pptx_preview registered");
assert.ok(deckWorkbenchGet, "artifact_deck_workbench_get registered");
assert.ok(deckWorkbenchValidate, "artifact_deck_workbench_validate registered");
assert.ok(deckWorkbenchUpdate, "artifact_deck_workbench_update registered");
assert.ok(deckWorkbenchPreviewHtml, "artifact_deck_workbench_preview_html registered");
assert.ok(deckWorkbenchRepair, "artifact_deck_workbench_repair registered");
assert.ok(deckWorkbenchAssistContext, "artifact_deck_workbench_assist_context registered");
assert.ok(deckWorkbenchWriteHtml, "artifact_deck_workbench_write_html registered");
assert.ok(deckWorkbenchWritePptx, "artifact_deck_workbench_write_reference_pptx registered");
assert.ok(deckWorkbenchRenderPlanContext, "artifact_deck_workbench_render_plan_context registered");
assert.ok(deckWorkbenchRenderPptxImages, "artifact_deck_workbench_render_pptx_preview_images registered");

const confirmDetails: string[] = [];
const approvalTrue = { hasUI: true, ui: { confirm: async (_title: string, detail: string) => { confirmDetails.push(detail); return true; }, notify: () => undefined } };
const approvalFalse = { hasUI: true, ui: { confirm: async () => false, notify: () => undefined } };
const noUi = { hasUI: false, ui: { confirm: async () => { throw new Error("must not prompt"); }, notify: () => undefined } };

const validPayload = {
	filename: "decks/demo.html",
	title: "exxperts <Deck>",
	subtitle: "A deterministic helper",
	audience: "Fernando & team",
	footer: "Local artifact",
	slides: [
		{
			title: "Problem <script>alert('x')</script>",
			keyMessage: "Teams need consistent artifacts without raw HTML risks.",
			bullets: ["Approval-gated writes", "Fixed HTML template", "Escaped content <script>bad()</script>"],
			speakerNote: "Do not execute user-provided markup.",
			visualIdea: "Black/white section divider",
		},
		{ title: "Next step", keyMessage: "Test in CLI and web approval flows.", bullets: ["No PDF", "No PPTX"] },
	],
	reason: "tool-level test",
};

const normalisedDeck = normaliseDeckSpecV1({
	title: "Deck title",
	slides: [
		{ title: "Cover" },
		{ title: "Intro", bullets: ["A", "B"] },
	],
});
assert.equal(normalisedDeck.version, "1.0");
assert.equal(normalisedDeck.artifactType, "deck");
assert.equal(normalisedDeck.slides[0].id, "slide-1");
assert.equal(normalisedDeck.slides[1].id, "slide-2");
assert.equal(normalisedDeck.slides[0].type, "title");
assert.equal(normalisedDeck.slides[1].type, "bullets");
const htmlFromInput = renderHtmlDeck({ title: "Deck title", slides: [{ title: "Cover" }], footer: "Foot" });
const htmlFromSpec = renderHtmlDeckFromSpec(normaliseDeckSpecV1({ title: "Deck title", slides: [{ title: "Cover" }] }), { footer: "Foot" });
assert.equal(htmlFromInput, htmlFromSpec);

const validValidation = validateDeckSpecV1(normaliseDeckSpecV1({
	title: "Valid deck",
	slides: [
		{ title: "Cover" },
		{ title: "Message", keyMessage: "One message", bullets: ["One", "Two"] },
	],
}));
assert.equal(validValidation.errors.length, 0);
assert.equal(validValidation.warnings.length, 0);

const duplicateIdValidation = validateDeckSpecV1({
	...normaliseDeckSpecV1({
		title: "Duplicate ids",
		slides: [
			{ title: "A" },
			{ title: "B", keyMessage: "B" },
		],
	}),
	slides: [
		{ id: "same", type: "title", title: "A" },
		{ id: "same", type: "content", title: "B", keyMessage: "B" },
	],
});
assert.ok(duplicateIdValidation.errors.some((e) => e.code === "slide_id_duplicate"));

const warningValidation = validateDeckSpecV1(normaliseDeckSpecV1({
	title: "This is a very long deck title intended to trigger the lightweight warning helper because it exceeds the configured threshold for title length in the artifact helper",
	slides: [
		{
			title: "Dense slide",
			bullets: [
				"A very long bullet that should trigger the warning helper because it intentionally exceeds the lightweight length threshold used to detect bullets that are probably too verbose for slide reading comfort in this first validation bridge.",
				"Two",
				"Three",
				"Four",
				"Five",
				"Six",
			],
		},
	],
}));
assert.ok(warningValidation.warnings.some((w) => w.code === "deck_title_long"));
assert.ok(warningValidation.warnings.some((w) => w.code === "slide_missing_key_message"));
assert.ok(warningValidation.warnings.some((w) => w.code === "slide_many_bullets"));
assert.ok(warningValidation.warnings.some((w) => w.code === "slide_bullet_long"));

const multiLongBulletsValidation = validateDeckSpecV1(normaliseDeckSpecV1({
	title: "Multiple long bullets",
	slides: [
		{
			title: "Dense slide",
			bullets: [
				"This is an intentionally very long first bullet that should trigger the long bullet warning and clearly exceeds the configured threshold for comfortable slide readability in this validation helper.",
				"This is an intentionally very long second bullet that also exceeds the threshold, but the validator should still emit only one long-bullet warning per slide.",
			],
		},
	],
}));
assert.equal(multiLongBulletsValidation.warnings.filter((w) => w.code === "slide_bullet_long").length, 1);

const genericTitleValidation = validateDeckSpecV1(normaliseDeckSpecV1({
	title: "Generic title warning",
	slides: [
		{ title: "Cover" },
		{ title: "Overview", keyMessage: "Specific update", bullets: ["One"] },
	],
}));
assert.ok(genericTitleValidation.warnings.some((w) => w.code === "slide_title_generic"));

const duplicateBulletValidation = validateDeckSpecV1(normaliseDeckSpecV1({
	title: "Duplicate bullets",
	slides: [
		{ title: "Cover" },
		{ title: "Details", keyMessage: "Message", bullets: ["Same bullet", "same bullet.", "Another"] },
	],
}));
assert.ok(duplicateBulletValidation.warnings.some((w) => w.code === "slide_duplicate_bullet"));

const repeatedKeyMessageValidation = validateDeckSpecV1(normaliseDeckSpecV1({
	title: "Repeated key message",
	slides: [
		{ title: "Cover" },
		{ title: "A", keyMessage: "We should consolidate vendors", bullets: ["One"] },
		{ title: "B", keyMessage: "We should consolidate vendors.", bullets: ["Two"] },
	],
}));
assert.ok(repeatedKeyMessageValidation.warnings.some((w) => w.code === "deck_repeated_key_message"));

const execMissingWarningsValidation = validateDeckSpecV1(normaliseDeckSpecV1({
	title: "Product Review Q2",
	audience: "Executive leadership",
	slides: [
		{ title: "Cover" },
		{ title: "Overview", keyMessage: "Current state", bullets: ["One"] },
		{ title: "Context", keyMessage: "Progress status", bullets: ["Two"] },
		{ title: "Background", keyMessage: "Risks and blockers", bullets: ["Three"] },
		{ title: "Summary", keyMessage: "Open topics", bullets: ["Four"] },
	],
}));
assert.ok(execMissingWarningsValidation.warnings.some((w) => w.code === "slide_title_generic"));
assert.ok(execMissingWarningsValidation.warnings.some((w) => w.code === "deck_missing_recommendation"));
assert.ok(execMissingWarningsValidation.warnings.some((w) => w.code === "deck_missing_decision_ask"));

const execPresentWarningsValidation = validateDeckSpecV1(normaliseDeckSpecV1({
	title: "Internal Product Review",
	audience: "Exec management",
	slides: [
		{ title: "Cover" },
		{ title: "Recommendation", keyMessage: "We should simplify product packaging", bullets: ["One"] },
		{ title: "Decision ask", keyMessage: "Ask: approve next 30 days plan", bullets: ["Two"] },
	],
}));
assert.equal(execPresentWarningsValidation.warnings.some((w) => w.code === "deck_missing_recommendation"), false);
assert.equal(execPresentWarningsValidation.warnings.some((w) => w.code === "deck_missing_decision_ask"), false);

const renderedValid = validateRenderedHtmlDeck(
	normaliseDeckSpecV1({ title: "Rendered valid", slides: [{ title: "A", keyMessage: "m", bullets: ["b1", "b2"] }] }),
	renderHtmlDeckFromSpec(normaliseDeckSpecV1({ title: "Rendered valid", slides: [{ title: "A", keyMessage: "m", bullets: ["b1", "b2"] }] })),
);
assert.equal(renderedValid.errors.length, 0);

const renderedScript = validateRenderedHtmlDeck(
	normaliseDeckSpecV1({ title: "Rendered invalid", slides: [{ title: "A" }] }),
	"<!doctype html><html><body><script>alert('x')</script></body></html>",
);
assert.ok(renderedScript.errors.some((e) => e.code === "render_script_tag_found"));

const renderedSlideMismatch = validateRenderedHtmlDeck(
	normaliseDeckSpecV1({ title: "Rendered mismatch", slides: [{ title: "A" }, { title: "B" }] }),
	renderHtmlDeckFromSpec(normaliseDeckSpecV1({ title: "Rendered mismatch", slides: [{ title: "A" }] })),
);
assert.ok(renderedSlideMismatch.errors.some((e) => e.code === "render_slide_count_mismatch"));

const renderedExternalRefs = validateRenderedHtmlDeck(
	normaliseDeckSpecV1({ title: "Rendered external", slides: [{ title: "A" }] }),
	"<!doctype html><html><body><img src=\"https://example.com/a.png\"></body></html>",
);
assert.ok(renderedExternalRefs.errors.some((e) => e.code === "render_external_src_found"));
assert.ok(renderedExternalRefs.errors.some((e) => e.code === "render_external_url_found"));

const warningPayload = {
	filename: "decks/warnings.html",
	title: "This is a very long deck title intended to trigger the lightweight warning helper because it exceeds the configured threshold for title length in the artifact helper",
	slides: [
		{
			title: "Dense slide",
			bullets: [
				"A very long bullet that should trigger the warning helper because it intentionally exceeds the lightweight length threshold used to detect bullets that are probably too verbose for slide reading comfort in this first validation bridge.",
				"Two",
				"Three",
				"Four",
				"Five",
				"Six",
			],
		},
	],
};

const destinationsResult = await destinations!.execute("dest", {});
assert.match(destinationsResult.content[0].text, /default:/);
assert.match(destinationsResult.content[0].text, /\.exxperts[/\\]app[/\\]artifacts/);

const writeResult = await deck!.execute("1", validPayload, undefined, undefined, approvalTrue);
assert.equal(writeResult.details.saved, true);
assert.equal(writeResult.details.destination, "default");
assert.match(confirmDetails.at(-1) ?? "", /Path: .*decks[/\\]demo\.html/);
assert.match(confirmDetails.at(-1) ?? "", /Overwrite: no, new file/);
assert.match(confirmDetails.at(-1) ?? "", /<body>/);
assert.match(confirmDetails.at(-1) ?? "", /<\/html>/);
const written = fs.readFileSync(path.join(tempHome, ".exxperts", "app", "artifacts", "decks", "demo.html"), "utf-8");
assert.ok((written.match(/<section class="slide layout-(?:content|decision|storyboard|evidence|options|statement|two-column|section)">/g) || []).length >= 2);
assert.equal((written.match(/<section class="slide layout-/g) || []).length, 2);
assert.match(written, /<section class="slide layout-(?:content|decision)">[\s\S]*<h2>Next step<\/h2>[\s\S]*<li>No PDF<\/li>/);
assert.match(written, /deck-title::before/);
assert.match(written, /layout-section/);
assert.match(written, /layout-two-column/);
assert.doesNotMatch(written, /\.layout-section ul \{ display: none; \}/);
assert.match(written, /overflow-x: hidden/);
assert.match(written, /max-width: 100%/);
assert.match(written, /overflow-wrap: anywhere/);
assert.match(written, /@media \(max-width: 700px\)/);
assert.match(written, /Fonts are not embedded/);
assert.match(written, /font-family: "Sen", Arial, Helvetica, sans-serif/);
assert.match(written, /font-family: "Bandeins Sans", "Bandeins", "Sen", Arial, Helvetica, sans-serif/);
assert.match(written, /&lt;Deck&gt;/);
assert.match(written, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
assert.doesNotMatch(written, /<script>/i);
assert.doesNotMatch(written, /<script>bad\(\)<\/script>/i);
assert.doesNotMatch(written, /src=/i);

assert.equal(Array.isArray(writeResult.details.warnings), true);
assert.equal(writeResult.details.warnings.length, 0);
assert.doesNotMatch(writeResult.content[0].text, /Warnings:/);
assert.ok(!(confirmDetails.at(-1) ?? "").includes("Filename is generic"));

const genericFilenameResult = await deck!.execute("generic", {
	...validPayload,
	filename: "deck.html",
	title: "Quality Deck",
	slides: [{ title: "Intro", keyMessage: "Clear message", bullets: ["A", "B"] }],
}, undefined, undefined, approvalTrue);
assert.equal(genericFilenameResult.details.saved, true);
assert.match(confirmDetails.at(-1) ?? "", /Warnings: Filename is generic/);
assert.match(genericFilenameResult.content[0].text, /Warnings: Filename is generic/);
assert.ok(genericFilenameResult.details.warnings.some((w: any) => w.code === "filename_generic"));

const nonKebabFilenameResult = await deck!.execute("non-kebab", {
	...validPayload,
	filename: "client_demo.html",
	title: "Client Demo",
	slides: [{ title: "Summary", keyMessage: "One message", bullets: ["A", "B"] }],
}, undefined, undefined, approvalTrue);
assert.equal(nonKebabFilenameResult.details.saved, true);
assert.match(confirmDetails.at(-1) ?? "", /Filename is safe but not lowercase kebab-case/);
assert.match(nonKebabFilenameResult.content[0].text, /Filename is safe but not lowercase kebab-case/);
assert.ok(nonKebabFilenameResult.details.warnings.some((w: any) => w.code === "filename_not_kebab_case"));

const duplicateBulletDeckResult = await deck!.execute("warn-duplicate-bullet", {
	...validPayload,
	filename: "decks/duplicate-bullet-warning.html",
	title: "Internal Product Review",
	audience: "Executive team",
	slides: [
		{ title: "Cover" },
		{ title: "Overview", keyMessage: "Current state", bullets: ["Same point", "same point."] },
		{ title: "Context", keyMessage: "Details", bullets: ["A"] },
		{ title: "Background", keyMessage: "More details", bullets: ["B"] },
		{ title: "Summary", keyMessage: "Close", bullets: ["C"] },
	],
}, undefined, undefined, approvalTrue);
assert.equal(duplicateBulletDeckResult.details.saved, true);
assert.ok(duplicateBulletDeckResult.details.warnings.some((w: any) => w.code === "slide_duplicate_bullet"));
assert.match(duplicateBulletDeckResult.content[0].text, /Warnings: /);

const warningResult = await deck!.execute("warn", warningPayload, undefined, undefined, approvalTrue);
assert.match(confirmDetails.at(-1) ?? "", /\nWarnings: /);
assert.match(confirmDetails.at(-1) ?? "", /\nGenerated HTML preview:/);
assert.equal(warningResult.details.saved, true);
assert.equal(Array.isArray(warningResult.details.warnings), true);
assert.ok(warningResult.details.warnings.some((w: any) => w.code === "deck_title_long"));
assert.ok(warningResult.details.warnings.some((w: any) => w.code === "slide_missing_key_message"));
assert.ok(warningResult.details.warnings.some((w: any) => w.code === "slide_many_bullets"));
assert.ok(warningResult.details.warnings.some((w: any) => w.code === "slide_bullet_long"));
assert.match(warningResult.content[0].text, /^Created local HTML deck artifact: .*\nWarnings: /);
assert.match(warningResult.content[0].text, /Slide 1:/);
assert.doesNotMatch(warningResult.content[0].text, /\.\./);

const listResult = await list!.execute("2", { limit: 10 });
assert.match(listResult.content[0].text, /decks[/\\]demo.html/);
const readResult = await read!.execute("3", { filename: "decks/demo.html" });
assert.match(readResult.content[0].text, /<!doctype html>/);
assert.equal(readResult.details.styleProfile.sourceType, "html");
assert.equal(readResult.details.styleProfile.sourceLabel, "default/decks/demo.html");
assert.ok(readResult.details.styleProfile.colors.backgrounds.some((c: any) => c.value === "#000" || c.value === "#000000"));
assert.ok(readResult.details.styleProfile.fonts.some((f: any) => /Sen/.test(f.family)));
assert.ok(readResult.details.styleProfile.layouts.length >= 1);
assert.ok(readResult.details.styleProfile.caveats.some((c: string) => /approximate/i.test(c)));

// Offset paging (bug 8): a file larger than MAX_READ_BYTES (180_000) reads in
// byte slices. The truncation notice must name the exact next offset so an
// iterate specialist can continue instead of silently rebuilding a partial file.
{
	const bigDir = path.join((mod.artifactRoot as () => string)(), "big");
	fs.mkdirSync(bigDir, { recursive: true, mode: 0o700 });
	const tail = "TAILMARKER-END";
	fs.writeFileSync(path.join(bigDir, "large.md"), "A".repeat(180_000) + tail); // 180_014 bytes, ASCII
	const first = await read!.execute("big-1", { filename: "large.md", folder: "big" });
	assert.equal(first.details.truncated, true, "first slice of an oversized file must report truncated");
	assert.match(first.content[0].text, /\[truncated — file is 180014 bytes; call artifact_read again with offset=180000 to continue\]/);
	assert.ok(!first.content[0].text.includes(tail), "the tail must not appear in the first slice");
	const cont = await read!.execute("big-2", { filename: "large.md", folder: "big", offset: 180_000 });
	assert.equal(cont.details.truncated, false, "the continuation slice must not report truncated");
	assert.ok(cont.content[0].text.startsWith(tail), "continuation from the named offset must return the remaining bytes");
	const badOffset = await read!.execute("big-3", { filename: "large.md", folder: "big", offset: -1 });
	assert.equal(badOffset.isError, true, "a negative offset must be rejected");
	assert.match(badOffset.content[0].text, /offset must be a non-negative integer/);
}

const pastedHtmlStyle = await inspectReferenceStyle!.execute("style-pasted", {
	html: "<!doctype html><html><head><style>.slide{background:#123456;color:#ffffff;font-family:'Inter', Arial;font-size:32px;border:1px solid #ffcc00}</style></head><body><section class='slide title'><h1>Hi</h1></section></body></html>",
});
assert.equal(pastedHtmlStyle.isError, undefined);
assert.equal(pastedHtmlStyle.details.styleProfile.sourceType, "html");
assert.equal(pastedHtmlStyle.details.styleProfile.sourceLabel, "pasted-html");
assert.ok(pastedHtmlStyle.details.styleProfile.colors.backgrounds.some((c: any) => c.value === "#123456"));
assert.ok(pastedHtmlStyle.details.styleProfile.fonts.some((f: any) => f.family === "Inter"));
assert.match(pastedHtmlStyle.content[0].text, /Reference style profile: html pasted-html/);

const approvedHtmlStyle = await inspectReferenceStyle!.execute("style-approved", { filename: "decks/demo.html" });
assert.equal(approvedHtmlStyle.isError, undefined);
assert.equal(approvedHtmlStyle.details.styleProfile.sourceLabel, "default/decks/demo.html");

const pptxZip = new JSZip();
pptxZip.file("[Content_Types].xml", "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"></Types>");
pptxZip.file("ppt/presentation.xml", "<p:presentation xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><p:sldSz cx=\"12192000\" cy=\"6858000\"/><p:sldIdLst><p:sldId id=\"256\" r:id=\"rId1\"/><p:sldId id=\"257\" r:id=\"rId2\"/></p:sldIdLst></p:presentation>");
pptxZip.file("ppt/_rels/presentation.xml.rels", "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide\" Target=\"slides/slide1.xml\"/><Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide\" Target=\"slides/slide2.xml\"/><Relationship Id=\"rIdX\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink\" Target=\"https://example.com\" TargetMode=\"External\"/></Relationships>");
pptxZip.file("ppt/theme/theme1.xml", "<a:theme xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\"><a:themeElements><a:clrScheme><a:accent1><a:srgbClr val=\"FF6600\"/></a:accent1></a:clrScheme><a:fontScheme><a:majorFont><a:latin typeface=\"Aptos Display\"/></a:majorFont></a:fontScheme></a:themeElements></a:theme>");
pptxZip.file("ppt/slides/slide1.xml", "<p:sld xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\" xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val=\"000000\"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:sp><p:spPr><a:xfrm><a:off x=\"600000\" y=\"500000\"/><a:ext cx=\"5000000\" cy=\"1200000\"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:rPr typeface=\"Sen\" sz=\"2800\"><a:solidFill><a:srgbClr val=\"FFFFFF\"/></a:solidFill></a:rPr><a:t>Hello slide</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>");
pptxZip.file("ppt/slides/slide2.xml", "<p:sld xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\" xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\"><p:cSld><p:spTree><p:sp><p:spPr><a:xfrm><a:off x=\"6500000\" y=\"3000000\"/><a:ext cx=\"4000000\" cy=\"1200000\"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:rPr typeface=\"Sen\" sz=\"2200\"><a:solidFill><a:srgbClr val=\"111111\"/></a:solidFill></a:rPr><a:t>Second slide</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>");
pptxZip.file("ppt/slides/_rels/slide1.xml.rels", "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide\" Target=\"../notesSlides/notesSlide1.xml\"/><Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\" Target=\"../media/image1.png\"/><Relationship Id=\"rId3\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink\" Target=\"https://example.org\" TargetMode=\"External\"/></Relationships>");
pptxZip.file("ppt/notesSlides/notesSlide1.xml", "<p:notes xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\" xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Speaker notes here</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>");
pptxZip.file("ppt/media/image1.png", "not-a-real-image");
pptxZip.file("ppt/vbaProject.bin", "macro");
pptxZip.file("ppt/embeddings/oleObject1.bin", "ole");
const pptxBytes = await pptxZip.generateAsync({ type: "nodebuffer" });
const pptxPath = path.join(tempHome, ".exxperts", "app", "artifacts", "refs", "sample.pptx");
fs.mkdirSync(path.dirname(pptxPath), { recursive: true });
fs.writeFileSync(pptxPath, pptxBytes);

assert.equal(normaliseDeckStructurePreset("executive_review"), "executive");
assert.equal(normaliseDeckStructurePreset("executive-review"), "executive");
assert.equal(normaliseDeckStructurePreset("strategy"), "consulting");
assert.equal(normaliseDeckStructurePreset("consulting_deck"), "consulting");
assert.equal(normaliseDeckStructurePreset("technical_review"), "technical");

const helperBlankCreated = createBlankDeckWorkbench({
	title: "Scratch deck plan",
	audience: "Leadership",
	goal: "Align on decision",
	slideCount: 5,
	structurePreset: "executive",
});
assert.equal(typeof helperBlankCreated.workbenchId, "string");
assert.match(helperBlankCreated.workbenchId, /^wb_/);
assert.equal(helperBlankCreated.snapshot.reuseIntent, "scratch");
assert.equal(helperBlankCreated.snapshot.selectedSlide.index, 1);
assert.equal(typeof helperBlankCreated.snapshot.selectedSlide.visualIdea, "string");
assert.match(helperBlankCreated.snapshot.selectedSlide.visualIdea ?? "", /storyboard visual/i);

const helperBlankAliasCreated = createBlankDeckWorkbench({
	title: "Scratch alias preset",
	structurePreset: "executive_review",
});
assert.equal(helperBlankAliasCreated.snapshot.reuseIntent, "scratch");
assert.match(helperBlankAliasCreated.snapshot.selectedSlide.title, /Decision context/i);

const blankToolCreated = await deckWorkbenchCreateBlank!.execute("wb-create-blank", {
	title: "Tool scratch deck",
	audience: "Exec",
	goal: "Approve phase 1",
	slideCount: 4,
	structurePreset: "consulting",
});
assert.equal(blankToolCreated.isError, undefined);
assert.equal(blankToolCreated.details.snapshot.reuseIntent, "scratch");
assert.equal(blankToolCreated.details.snapshot.selectedSlide.index, 1);
assert.equal(typeof blankToolCreated.details.snapshot.selectedSlide.visualIdea, "string");
assert.throws(
	() => previewDeckWorkbenchReferenceHtmlForUi({ workbenchId: blankToolCreated.details.workbenchId }),
	/Reference-style preview requires retained reference style evidence/,
);

const populatedBlankToolCreated = await deckWorkbenchCreateBlank!.execute("wb-create-blank-populated", {
	title: "Use defaults deck",
	subtitle: "Financial services pitch",
	audience: "Financial-services leadership",
	goal: "Approve pilot",
	slides: [
		{ title: "Why exxperts now", keyMessage: "FS teams need safe AI acceleration.", bullets: ["Regulatory pressure", "Delivery speed", "Cost discipline"], speakerNotes: "Frame urgency.", visualIdea: "Tension chart" },
		{ title: "Where it helps", keyMessage: "Specialist agents cover core FS workflows.", bullets: ["Research", "Knowledge", "Content"], speakerNotes: "Map to teams.", visualIdea: "Capability map" },
		{ title: "Risk controls", keyMessage: "Approval gates and local-first reduce risk.", bullets: ["Approval-gated writes", "Local artifacts", "Bounded tools"], speakerNotes: "Address security concerns.", visualIdea: "Control stack" },
		{ title: "Business impact", keyMessage: "Faster cycles with measurable quality.", bullets: ["Shorter turnaround", "Higher consistency", "Lower rework"], speakerNotes: "Show value.", visualIdea: "Impact bars" },
		{ title: "Decision ask", keyMessage: "Approve a 30-day FS pilot.", bullets: ["Nominate owner", "Choose scope", "Start next week"], speakerNotes: "Close with explicit ask.", visualIdea: "Timeline" },
	],
	structurePreset: "executive",
});
assert.equal(populatedBlankToolCreated.isError, undefined);
assert.equal(populatedBlankToolCreated.details.snapshot.reuseIntent, "scratch");
assert.equal(populatedBlankToolCreated.details.snapshot.slideCount, 5);
assert.equal(populatedBlankToolCreated.details.snapshot.selectedSlide.title, "Why exxperts now");
assert.equal(populatedBlankToolCreated.details.snapshot.selectedSlide.keyMessage, "FS teams need safe AI acceleration.");

const helperCreated = await createDeckWorkbenchFromApprovedPptx({
	filename: "sample.pptx",
	folder: "refs",
});
assert.equal(typeof helperCreated.workbenchId, "string");
assert.match(helperCreated.workbenchId, /^wb_/);
assert.equal(helperCreated.snapshot.selectedSlide.index, 1);
assert.equal(helperCreated.snapshot.workbenchId, helperCreated.workbenchId);
assert.equal(typeof helperCreated.validation.ready, "boolean");
assert.equal(helperCreated.snapshot.formatReference?.sourceType, "pptx");
assert.equal(helperCreated.snapshot.formatReference?.sourceLabel, "default/refs/sample.pptx");
assert.equal(helperCreated.snapshot.formatReference?.evidenceStatus, "approximate_style_evidence_available");
assert.match(helperCreated.caveat, /approximate style evidence only/i);

await assert.rejects(
	() => createDeckWorkbenchFromApprovedPptx({ filename: "demo.html", folder: "decks" }),
	/Unsupported artifact extension|Only \.pptx is supported/,
);
await assert.rejects(
	() => createDeckWorkbenchFromApprovedPptx({ filename: "../sample.pptx", folder: "refs" }),
	/must not contain '\.\.'/,
);

const filesBeforeInspect = fs.readdirSync(path.join(tempHome, ".exxperts", "app", "artifacts", "refs"));
const inspectResult = await inspectPptx!.execute("inspect", { filename: "sample.pptx", folder: "refs" });
assert.equal(inspectResult.isError, undefined);
assert.equal(inspectResult.details.metadata.destination, "default");
assert.equal(inspectResult.details.metadata.relativePath, "refs/sample.pptx");
assert.equal(inspectResult.details.slideCount, 2);
assert.match(inspectResult.details.slides[0].text, /Hello slide/);
assert.match(inspectResult.details.slides[0].speakerNotes, /Speaker notes here/);
assert.equal(inspectResult.details.styleProfile.sourceType, "pptx");
assert.equal(inspectResult.details.styleProfile.sourceLabel, "default/refs/sample.pptx");
assert.equal(inspectResult.details.styleProfile.slideSize.width, 12192000);
assert.ok(inspectResult.details.styleProfile.colors.backgrounds.some((c: any) => c.value === "#000000"));
assert.ok(inspectResult.details.styleProfile.colors.text.some((c: any) => c.value === "#FFFFFF"));
assert.ok(inspectResult.details.styleProfile.colors.accents.some((c: any) => c.value === "#FF6600"));
assert.ok(inspectResult.details.styleProfile.fonts.some((f: any) => f.family === "Sen"));
assert.ok(inspectResult.details.styleProfile.fontSizes.some((f: any) => f.value === 2800 && f.unit === "pptx-hundredth-pt"));
assert.ok(inspectResult.details.styleProfile.layouts.some((l: any) => l.roughRegions?.includes("top-left")));
assert.ok(inspectResult.details.styleProfile.media.some((m: any) => m.path === "ppt/media/image1.png" && m.likelyLogo === true));
assert.ok(inspectResult.details.styleProfile.caveats.some((c: string) => /approximate/i.test(c)));
assert.ok(inspectResult.details.warnings.some((w: string) => /vbaProject\.bin/.test(w)));
assert.ok(inspectResult.details.warnings.some((w: string) => /Embedded\/OLE/.test(w)));
assert.ok(inspectResult.details.warnings.some((w: string) => /External relationship detected/.test(w)));
assert.match(inspectResult.content[0].text, /Slides: 2/);
assert.match(inspectResult.content[0].text, /Hello slide/);
assert.match(inspectResult.content[0].text, /Speaker notes here/);
assert.match(inspectResult.content[0].text, /vbaProject\.bin/);
assert.match(inspectResult.content[0].text, /Embedded\/OLE/);
assert.match(inspectResult.content[0].text, /External relationship detected/);
assert.match(inspectResult.content[0].text, /Style profile \(bounded, approximate\):/);
assert.match(inspectResult.content[0].text, /Slide size: 12192000 × 6858000 emu/);
const filesAfterInspect = fs.readdirSync(path.join(tempHome, ".exxperts", "app", "artifacts", "refs"));
assert.deepEqual(filesAfterInspect, filesBeforeInspect);

// Full-bleed background shape fixture: a 16:9 deck whose visible background is a full-slide
// black rectangle shape (not a slide-level <p:bg>) with a white text box on top, a decorative
// red rectangle, and a second slide with no full-bleed background (regression: must not crash).
const fullBleedZip = new JSZip();
fullBleedZip.file("[Content_Types].xml", "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"></Types>");
fullBleedZip.file("ppt/presentation.xml", "<p:presentation xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><p:sldSz cx=\"12192000\" cy=\"6858000\"/><p:sldIdLst><p:sldId id=\"256\" r:id=\"rId1\"/><p:sldId id=\"257\" r:id=\"rId2\"/></p:sldIdLst></p:presentation>");
fullBleedZip.file("ppt/_rels/presentation.xml.rels", "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide\" Target=\"slides/slide1.xml\"/><Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide\" Target=\"slides/slide2.xml\"/></Relationships>");
fullBleedZip.file("ppt/slides/slide1.xml", "<p:sld xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\" xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\"><p:cSld><p:spTree><p:sp><p:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"12192000\" cy=\"6858000\"/></a:xfrm><a:solidFill><a:srgbClr val=\"000000\"/></a:solidFill></p:spPr></p:sp><p:sp><p:spPr><a:xfrm><a:off x=\"900000\" y=\"4200000\"/><a:ext cx=\"800000\" cy=\"800000\"/></a:xfrm><a:solidFill><a:srgbClr val=\"FF0000\"/></a:solidFill></p:spPr></p:sp><p:sp><p:spPr><a:xfrm><a:off x=\"600000\" y=\"500000\"/><a:ext cx=\"6000000\" cy=\"1200000\"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:rPr typeface=\"Bandeins Strange\" sz=\"6800\"><a:solidFill><a:srgbClr val=\"FFFFFF\"/></a:solidFill></a:rPr><a:t>Cover headline</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>");
fullBleedZip.file("ppt/slides/slide2.xml", "<p:sld xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\" xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\"><p:cSld><p:spTree><p:sp><p:spPr><a:xfrm><a:off x=\"600000\" y=\"3000000\"/><a:ext cx=\"6000000\" cy=\"1200000\"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:rPr typeface=\"Sen\" sz=\"2000\"><a:solidFill><a:srgbClr val=\"FFFFFF\"/></a:solidFill></a:rPr><a:t>Body slide content with enough words to look like a real content slide</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>");
const fullBleedBytes = await fullBleedZip.generateAsync({ type: "nodebuffer" });
fs.writeFileSync(path.join(tempHome, ".exxperts", "app", "artifacts", "refs", "fullbleed.pptx"), fullBleedBytes);

const fullBleedInspect = await inspectPptx!.execute("inspect-fullbleed", { filename: "fullbleed.pptx", folder: "refs" });
assert.equal(fullBleedInspect.isError, undefined);
const fullBleedProfile = fullBleedInspect.details.styleProfile;
// Full-bleed rectangle fill is read as the visible background, even without a <p:bg> element.
assert.ok(fullBleedProfile.colors.backgrounds.some((c: any) => c.value === "#000000"), "full-bleed black background extracted");
// White text-box run fill is kept as a text colour, separate from the background fill.
assert.ok(fullBleedProfile.colors.text.some((c: any) => c.value === "#FFFFFF"), "white text colour extracted");
assert.ok(!fullBleedProfile.colors.text.some((c: any) => c.value === "#000000"), "full-bleed background fill not counted as text colour");
// Decorative (non-text, non-full-bleed) red shape fill must pollute neither palette.
assert.ok(!fullBleedProfile.colors.text.some((c: any) => c.value === "#FF0000"), "decorative fill not counted as text colour");
assert.ok(!fullBleedProfile.colors.backgrounds.some((c: any) => c.value === "#FF0000"), "decorative non-full-bleed fill not counted as background");
// First layout records the visible background; the second (no full-bleed) extracts without crashing.
assert.equal(fullBleedProfile.layouts[0].background, "#000000");
assert.equal(fullBleedProfile.layouts.length, 2);
assert.equal(fullBleedProfile.layouts[1].background, undefined);

// Reference-style preview should use the real black background, not the #111111 fallback.
const fullBleedWorkbench = await createDeckWorkbenchFromApprovedPptx({
	filename: "fullbleed.pptx",
	folder: "refs",
	reuseIntent: "both",
	notesUse: "ignore",
});
const fullBleedPreview = previewDeckWorkbenchReferenceHtmlForUi({ workbenchId: fullBleedWorkbench.workbenchId, footer: "Full-bleed reference" });
assert.ok(/background:\s*#000000/i.test(fullBleedPreview.htmlPreview), "reference preview uses extracted black background");
assert.ok(!/#111111/i.test(fullBleedPreview.htmlPreview), "reference preview does not fall back to #111111");

// Unusable reference: a deck whose only colours are theme-scheme references (no concrete hex
// background or text). Reference-style preview must report unavailable rather than render a
// generic default style.
const noPaletteZip = new JSZip();
noPaletteZip.file("[Content_Types].xml", "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"></Types>");
noPaletteZip.file("ppt/presentation.xml", "<p:presentation xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><p:sldSz cx=\"12192000\" cy=\"6858000\"/><p:sldIdLst><p:sldId id=\"256\" r:id=\"rId1\"/></p:sldIdLst></p:presentation>");
noPaletteZip.file("ppt/_rels/presentation.xml.rels", "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide\" Target=\"slides/slide1.xml\"/></Relationships>");
noPaletteZip.file("ppt/slides/slide1.xml", "<p:sld xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\" xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\"><p:cSld><p:spTree><p:sp><p:spPr><a:xfrm><a:off x=\"600000\" y=\"500000\"/><a:ext cx=\"6000000\" cy=\"1200000\"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:rPr typeface=\"Sen\" sz=\"2800\"><a:solidFill><a:schemeClr val=\"tx1\"/></a:solidFill></a:rPr><a:t>Scheme colored title without concrete palette</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>");
const noPaletteBytes = await noPaletteZip.generateAsync({ type: "nodebuffer" });
fs.writeFileSync(path.join(tempHome, ".exxperts", "app", "artifacts", "refs", "nopalette.pptx"), noPaletteBytes);

const noPaletteInspect = await inspectPptx!.execute("inspect-nopalette", { filename: "nopalette.pptx", folder: "refs" });
assert.equal(noPaletteInspect.isError, undefined);
assert.ok(!noPaletteInspect.details.styleProfile.colors.backgrounds.some((c: any) => /^#[0-9A-F]{3,8}$/i.test(c.value)), "no concrete background extracted");

const noPaletteWorkbench = await createDeckWorkbenchFromApprovedPptx({
	filename: "nopalette.pptx",
	folder: "refs",
	reuseIntent: "both",
	notesUse: "ignore",
});
assert.throws(
	() => previewDeckWorkbenchReferenceHtmlForUi({ workbenchId: noPaletteWorkbench.workbenchId }),
	/Reference-style preview unavailable/,
	"unusable reference palette reports unavailable instead of generic styling",
);

// Regression resembling ExxPerts_Pitch_C_level.pptx: the visible background is a full-bleed
// rectangle shape with a concrete srgbClr fill that ALSO carries an empty <p:txBody> placeholder.
// The extractor must still read it as a background (it previously skipped any shape with <p:txBody>).
const emptyTbZip = new JSZip();
emptyTbZip.file("[Content_Types].xml", "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"></Types>");
emptyTbZip.file("ppt/presentation.xml", "<p:presentation xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><p:sldSz cx=\"12192000\" cy=\"6858000\"/><p:sldIdLst><p:sldId id=\"256\" r:id=\"rId1\"/></p:sldIdLst></p:presentation>");
emptyTbZip.file("ppt/_rels/presentation.xml.rels", "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide\" Target=\"slides/slide1.xml\"/></Relationships>");
emptyTbZip.file("ppt/theme/theme1.xml", "<a:theme xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\"><a:themeElements><a:clrScheme name=\"x\"><a:dk1><a:sysClr val=\"windowText\" lastClr=\"000000\"/></a:dk1><a:lt1><a:sysClr val=\"window\" lastClr=\"FFFFFF\"/></a:lt1><a:dk2><a:srgbClr val=\"1F497D\"/></a:dk2><a:lt2><a:srgbClr val=\"EEECE1\"/></a:lt2><a:accent1><a:srgbClr val=\"FF6600\"/></a:accent1></a:clrScheme><a:fontScheme><a:majorFont><a:latin typeface=\"Aptos\"/></a:majorFont></a:fontScheme></a:themeElements></a:theme>");
emptyTbZip.file("ppt/slideMasters/slideMaster1.xml", "<p:sldMaster xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\" xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\"><p:clrMap bg1=\"lt1\" tx1=\"dk1\" bg2=\"lt2\" tx2=\"dk2\" accent1=\"accent1\"/></p:sldMaster>");
emptyTbZip.file("ppt/slides/slide1.xml", "<p:sld xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\" xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\"><p:cSld><p:spTree><p:sp><p:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"12191695\" cy=\"6858000\"/></a:xfrm><a:prstGeom prst=\"rect\"/><a:solidFill><a:srgbClr val=\"000000\"/></a:solidFill></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr/></a:p></p:txBody></p:sp><p:sp><p:spPr><a:xfrm><a:off x=\"548640\" y=\"1828800\"/><a:ext cx=\"10972800\" cy=\"2194560\"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:rPr typeface=\"Bandeins Strange\" sz=\"6800\"><a:solidFill><a:srgbClr val=\"FFFFFF\"/></a:solidFill></a:rPr><a:t>Cover headline</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>");
const emptyTbBytes = await emptyTbZip.generateAsync({ type: "nodebuffer" });
fs.writeFileSync(path.join(tempHome, ".exxperts", "app", "artifacts", "refs", "emptytxbody.pptx"), emptyTbBytes);

const emptyTbInspect = await inspectPptx!.execute("inspect-emptytxbody", { filename: "emptytxbody.pptx", folder: "refs" });
assert.equal(emptyTbInspect.isError, undefined);
const emptyTbProfile = emptyTbInspect.details.styleProfile;
assert.ok(emptyTbProfile.colors.backgrounds.some((c: any) => c.value === "#000000"), "full-bleed background with empty txBody is extracted");
assert.ok(emptyTbProfile.colors.text.some((c: any) => c.value === "#FFFFFF"), "white text extracted");
assert.equal(emptyTbProfile.layouts[0].background, "#000000");
// End-to-end: a workbench attached to this deck now yields a usable reference-style context.
const emptyTbWorkbench = await createDeckWorkbenchFromApprovedPptx({ filename: "emptytxbody.pptx", folder: "refs", reuseIntent: "both", notesUse: "ignore" });
const emptyTbContext = await deckWorkbenchReferenceHtmlContext!.execute("ctx-emptytxbody", { workbenchId: emptyTbWorkbench.workbenchId });
assert.equal(emptyTbContext.isError, undefined, "empty-txBody background deck now produces a usable reference-style context");

// schemeClr/theme resolution + master clrMap: a full-bleed shape filled with schemeClr tx1 and run
// text filled with schemeClr bg1 must resolve to concrete theme hex via the slide master clrMap.
const schemeZip = new JSZip();
schemeZip.file("[Content_Types].xml", "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"></Types>");
schemeZip.file("ppt/presentation.xml", "<p:presentation xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><p:sldSz cx=\"12192000\" cy=\"6858000\"/><p:sldIdLst><p:sldId id=\"256\" r:id=\"rId1\"/></p:sldIdLst></p:presentation>");
schemeZip.file("ppt/_rels/presentation.xml.rels", "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide\" Target=\"slides/slide1.xml\"/></Relationships>");
schemeZip.file("ppt/theme/theme1.xml", "<a:theme xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\"><a:themeElements><a:clrScheme name=\"x\"><a:dk1><a:srgbClr val=\"000000\"/></a:dk1><a:lt1><a:srgbClr val=\"FFFFFF\"/></a:lt1><a:dk2><a:srgbClr val=\"1F497D\"/></a:dk2><a:lt2><a:srgbClr val=\"EEECE1\"/></a:lt2><a:accent1><a:srgbClr val=\"FF6600\"/></a:accent1></a:clrScheme><a:fontScheme><a:majorFont><a:latin typeface=\"Aptos\"/></a:majorFont></a:fontScheme></a:themeElements></a:theme>");
schemeZip.file("ppt/slideMasters/slideMaster1.xml", "<p:sldMaster xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\" xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\"><p:clrMap bg1=\"lt1\" tx1=\"dk1\" bg2=\"lt2\" tx2=\"dk2\" accent1=\"accent1\"/></p:sldMaster>");
schemeZip.file("ppt/slides/slide1.xml", "<p:sld xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\" xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\"><p:cSld><p:spTree><p:sp><p:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"12192000\" cy=\"6858000\"/></a:xfrm><a:prstGeom prst=\"rect\"/><a:solidFill><a:schemeClr val=\"tx1\"/></a:solidFill></p:spPr></p:sp><p:sp><p:spPr><a:xfrm><a:off x=\"548640\" y=\"1828800\"/><a:ext cx=\"10972800\" cy=\"2194560\"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:rPr typeface=\"Sen\" sz=\"2800\"><a:solidFill><a:schemeClr val=\"bg1\"/></a:solidFill></a:rPr><a:t>Title text</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>");
const schemeBytes = await schemeZip.generateAsync({ type: "nodebuffer" });
fs.writeFileSync(path.join(tempHome, ".exxperts", "app", "artifacts", "refs", "schemecolors.pptx"), schemeBytes);

const schemeInspect = await inspectPptx!.execute("inspect-scheme", { filename: "schemecolors.pptx", folder: "refs" });
assert.equal(schemeInspect.isError, undefined);
const schemeProfile = schemeInspect.details.styleProfile;
// tx1 -> dk1 -> #000000 (full-bleed background); bg1 -> lt1 -> #FFFFFF (run text).
assert.ok(schemeProfile.colors.backgrounds.some((c: any) => c.value === "#000000"), "schemeClr tx1 background resolved to #000000");
assert.ok(schemeProfile.colors.text.some((c: any) => c.value === "#FFFFFF"), "schemeClr bg1 text resolved to #FFFFFF");
assert.equal(schemeProfile.layouts[0].background, "#000000");

// Richer layout/font evidence: full-bleed black background, large title (sz 6800), a white
// horizontal divider bar, named fonts (Bandeins Strange / Sen), and multiple text boxes.
const richZip = new JSZip();
richZip.file("[Content_Types].xml", "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"></Types>");
richZip.file("ppt/presentation.xml", "<p:presentation xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><p:sldSz cx=\"12192000\" cy=\"6858000\"/><p:sldIdLst><p:sldId id=\"256\" r:id=\"rId1\"/></p:sldIdLst></p:presentation>");
richZip.file("ppt/_rels/presentation.xml.rels", "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide\" Target=\"slides/slide1.xml\"/></Relationships>");
richZip.file("ppt/theme/theme1.xml", "<a:theme xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\"><a:themeElements><a:clrScheme name=\"x\"><a:dk1><a:srgbClr val=\"000000\"/></a:dk1><a:lt1><a:srgbClr val=\"FFFFFF\"/></a:lt1><a:dk2><a:srgbClr val=\"1F497D\"/></a:dk2><a:lt2><a:srgbClr val=\"EEECE1\"/></a:lt2><a:accent1><a:srgbClr val=\"FF6600\"/></a:accent1></a:clrScheme><a:fontScheme><a:majorFont><a:latin typeface=\"Aptos\"/></a:majorFont></a:fontScheme></a:themeElements></a:theme>");
richZip.file("ppt/slideMasters/slideMaster1.xml", "<p:sldMaster xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\" xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\"><p:clrMap bg1=\"lt1\" tx1=\"dk1\" bg2=\"lt2\" tx2=\"dk2\" accent1=\"accent1\"/></p:sldMaster>");
richZip.file("ppt/slides/slide1.xml", "<p:sld xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\" xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\"><p:cSld><p:spTree>"
	+ "<p:sp><p:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"12192000\" cy=\"6858000\"/></a:xfrm><a:prstGeom prst=\"rect\"/><a:solidFill><a:srgbClr val=\"000000\"/></a:solidFill></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr/></a:p></p:txBody></p:sp>"
	+ "<p:sp><p:spPr><a:xfrm><a:off x=\"600000\" y=\"3400000\"/><a:ext cx=\"10000000\" cy=\"60000\"/></a:xfrm><a:prstGeom prst=\"rect\"/><a:solidFill><a:srgbClr val=\"FFFFFF\"/></a:solidFill></p:spPr></p:sp>"
	+ "<p:sp><p:spPr><a:xfrm><a:off x=\"548640\" y=\"548640\"/><a:ext cx=\"10972800\" cy=\"1800000\"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:rPr typeface=\"Bandeins Strange\" sz=\"6800\"><a:solidFill><a:srgbClr val=\"FFFFFF\"/></a:solidFill></a:rPr><a:t>Cover Title</a:t></a:r></a:p></p:txBody></p:sp>"
	+ "<p:sp><p:spPr><a:xfrm><a:off x=\"600000\" y=\"4000000\"/><a:ext cx=\"5000000\" cy=\"1000000\"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:rPr typeface=\"Sen\" sz=\"1400\"><a:solidFill><a:srgbClr val=\"FFFFFF\"/></a:solidFill></a:rPr><a:t>Point one detail</a:t></a:r></a:p></p:txBody></p:sp>"
	+ "<p:sp><p:spPr><a:xfrm><a:off x=\"6500000\" y=\"4000000\"/><a:ext cx=\"5000000\" cy=\"1000000\"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:rPr typeface=\"Sen\" sz=\"1400\"><a:solidFill><a:srgbClr val=\"FFFFFF\"/></a:solidFill></a:rPr><a:t>Point two detail</a:t></a:r></a:p></p:txBody></p:sp>"
	+ "</p:spTree></p:cSld></p:sld>");
const richBytes = await richZip.generateAsync({ type: "nodebuffer" });
fs.writeFileSync(path.join(tempHome, ".exxperts", "app", "artifacts", "refs", "richlayout.pptx"), richBytes);

// Profile-level layout evidence.
const richInspect = await inspectPptx!.execute("inspect-rich", { filename: "richlayout.pptx", folder: "refs" });
assert.equal(richInspect.isError, undefined);
const richLayout0 = richInspect.details.styleProfile.layouts[0];
assert.equal(richLayout0.background, "#000000");
assert.equal(richLayout0.titleFontSizePt, 68, "large title font size captured");
assert.ok(richLayout0.shapeHints?.includes("full-bleed-background"), "full-bleed background hint captured");
assert.ok(richLayout0.shapeHints?.includes("horizontal-divider"), "horizontal divider hint captured");
assert.ok(["sparse", "medium", "dense"].includes(richLayout0.density), "density signal captured");
assert.ok((richLayout0.fonts || []).includes("Bandeins Strange") && (richLayout0.fonts || []).includes("Sen"), "per-slide fonts captured");

// Context tool surfaces fonts, recommended stack, and layout evidence.
const richWorkbench = await createDeckWorkbenchFromApprovedPptx({ filename: "richlayout.pptx", folder: "refs", slideCount: 3 });
const richCtx = await deckWorkbenchReferenceHtmlContext!.execute("ctx-rich", { workbenchId: richWorkbench.workbenchId });
assert.equal(richCtx.isError, undefined);
assert.ok(richCtx.details.referenceFonts.includes("Bandeins Strange"), "extracted font name appears in context");
assert.ok(richCtx.details.referenceFonts.includes("Sen"), "second extracted font name appears in context");
assert.match(richCtx.details.recommendedFontStack, /"Bandeins Strange"/, "recommended stack names the extracted font first");
assert.match(richCtx.details.recommendedFontStack, /"Sen"/, "recommended stack includes second extracted font");
assert.match(richCtx.details.recommendedFontStack, /Arial.*sans-serif$/, "recommended stack ends with safe fallbacks");
const richEvidence0 = richCtx.details.layoutEvidence[0];
assert.equal(richEvidence0.background, "#000000");
assert.equal(richEvidence0.titleFontSizePt, 68);
assert.ok(richEvidence0.shapeHints?.includes("full-bleed-background") && richEvidence0.shapeHints?.includes("horizontal-divider"));
assert.ok(["sparse", "medium", "dense"].includes(richEvidence0.density));
// Context includes explicit CSS guidance applying the stack broadly, plus a font debugging note.
assert.ok(Array.isArray(richCtx.details.cssGuidance) && richCtx.details.cssGuidance.length > 0, "context includes CSS guidance");
const richCssGuidanceText = richCtx.details.cssGuidance.join("\n");
assert.match(richCssGuidanceText, /h1, h2, h3, p, li, \.kicker, \.footer/, "CSS guidance applies the stack to headings/body, not only body");
assert.ok(richCssGuidanceText.includes(richCtx.details.recommendedFontStack), "CSS guidance embeds the exact recommendedFontStack");
assert.match(richCssGuidanceText, /render only if installed locally; no fonts are embedded/, "CSS guidance includes the font comment");
assert.ok(typeof richCtx.details.fontDebuggingNote === "string" && /installed locally|family name differs/i.test(richCtx.details.fontDebuggingNote), "context includes a font debugging note");
// Context tool text output exposes fonts + CSS guidance + layout evidence (style only, no slide text dumps).
assert.match(richCtx.content[0].text, /Recommended CSS font stack:.*Bandeins Strange/);
assert.match(richCtx.content[0].text, /CSS guidance:/);
assert.match(richCtx.content[0].text, /Font debugging note:/);
assert.match(richCtx.content[0].text, /Layout evidence/);

// HTML contract permits named local font-family usage but still blocks the unsafe tokens.
const richContractText = richCtx.details.htmlContract.join("\n");
assert.match(richContractText, /recommendedFontStack|font-family/i, "contract permits named font-family usage");
assert.match(richContractText, /@import/);
assert.match(richContractText, /url\(\)/);
assert.match(richContractText, /src=/);
assert.match(richContractText, /href=/);
assert.match(richContractText, /data:/);
assert.match(richContractText, /file:/);

// Preview accepts HTML that names local fonts; still rejects @import and url().
const richSlideCount = richWorkbench.snapshot.slideCount;
const richNamedFontHtml = `<!doctype html><html><head><style>body{background:#000;color:#fff;font-family:"Bandeins Strange","Sen",Arial,sans-serif}/* Fonts are referenced by name only and render if installed locally; no fonts are embedded. */</style></head><body>${Array.from({ length: richSlideCount }, (_, i) => `<section class="slide"><h2>Slide ${i + 1}</h2></section>`).join("")}</body></html>`;
const richNamedFontPreview = await deckWorkbenchPreviewReferenceHtml!.execute("rich-named-font", { workbenchId: richWorkbench.workbenchId, html: richNamedFontHtml });
assert.equal(richNamedFontPreview.isError, undefined, "named local fonts are allowed in reference-style HTML");
assert.equal(richNamedFontPreview.details.ready, true);
// HTML that uses the reference fonts has no "fonts not used" warning.
assert.ok(!richNamedFontPreview.details.renderedValidation.warnings.some((w: any) => w.code === "reference_fonts_not_used"), "no font warning when reference fonts are used");

// HTML that uses only generic fonts still previews (ready=true) but carries a soft warning.
const richGenericFontHtml = `<!doctype html><html><head><style>body{background:#000;color:#fff;font-family:Arial,Helvetica,sans-serif}</style></head><body>${Array.from({ length: richSlideCount }, (_, i) => `<section class="slide"><h2>Slide ${i + 1}</h2></section>`).join("")}</body></html>`;
const richGenericFontPreview = await deckWorkbenchPreviewReferenceHtml!.execute("rich-generic-font", { workbenchId: richWorkbench.workbenchId, html: richGenericFontHtml });
assert.equal(richGenericFontPreview.isError, undefined);
assert.equal(richGenericFontPreview.details.ready, true, "preview is still allowed when reference fonts are missing");
assert.ok(richGenericFontPreview.details.renderedValidation.warnings.some((w: any) => w.code === "reference_fonts_not_used"), "warns when extracted reference fonts are absent from the HTML");
assert.match(richGenericFontPreview.content[0].text, /Warning:.*reference fonts|recommendedFontStack/i, "preview text surfaces the font warning");
const richImportHtml = `<!doctype html><html><head><style>@import "x.css";</style></head><body>${Array.from({ length: richSlideCount }, (_, i) => `<section class="slide"><h2>Slide ${i + 1}</h2></section>`).join("")}</body></html>`;
const richImportPreview = await deckWorkbenchPreviewReferenceHtml!.execute("rich-import", { workbenchId: richWorkbench.workbenchId, html: richImportHtml });
assert.equal(richImportPreview.isError, true);
assert.match(richImportPreview.content[0].text, /@import detected/);
const richUrlHtml = `<!doctype html><html><head><style>body{background:url(x.png)}</style></head><body>${Array.from({ length: richSlideCount }, (_, i) => `<section class="slide"><h2>Slide ${i + 1}</h2></section>`).join("")}</body></html>`;
const richUrlPreview = await deckWorkbenchPreviewReferenceHtml!.execute("rich-url", { workbenchId: richWorkbench.workbenchId, html: richUrlHtml });
assert.equal(richUrlPreview.isError, true);
assert.match(richUrlPreview.content[0].text, /url\(\) detected/);

// Render-plan contract (Slice A.1): validation only, content-by-reference, no generation/output.
// Set deterministic slide content so required-content placement is testable.
await deckWorkbenchUpdate!.execute("rp-setup", {
	workbenchId: richWorkbench.workbenchId,
	slides: [
		{ slideIndex: 1, title: "Cover Title", keyMessage: "One clear key message", bullets: ["First point", "Second point"], speakerNotes: "Spoken aside for the room", visualIdea: "" },
		{ slideIndex: 2, title: "Second Slide", keyMessage: "Second key message", bullets: ["Alpha", "Beta"], speakerNotes: "", visualIdea: "" },
		{ slideIndex: 3, title: "Third Slide", keyMessage: "Third key message", bullets: ["Gamma", "Delta"], speakerNotes: "", visualIdea: "" },
	],
});
const rpSnap = getDeckWorkbenchUiSnapshot(richWorkbench.workbenchId, 1);
const rpId = rpSnap.slides[0].id;
const rpId2 = rpSnap.slides[1].id;
const rpId3 = rpSnap.slides[2].id;
const baseElements = () => ([
	{ type: "title", content: { ref: "title" }, font: "heading", fontSizePt: 54, color: "#FFFFFF", x: 0.06, y: 0.1, w: 0.88, h: 0.22 },
	{ type: "divider", orientation: "horizontal", fill: "#FFFFFF", x: 0.06, y: 0.36, w: 0.88, h: 0.004, weightPt: 1 },
	{ type: "body", content: { ref: "keyMessage" }, font: "body", fontSizePt: 24, color: "#FFFFFF", x: 0.06, y: 0.42, w: 0.88, h: 0.16 },
	{ type: "bullets", content: { ref: "bullets" }, font: "body", fontSizePt: 20, color: "#FFFFFF", x: 0.06, y: 0.62, w: 0.88, h: 0.3 },
]);
// Slide 0 is the detailed elements-based slide the tests inspect/mutate; slides 1-2 are simple
// layout-based slides so the plan covers every workbench slide (validator requires one per slide).
const basePlan = () => ({
	version: "1.0",
	palette: { background: "#000000", text: "#FFFFFF" },
	fonts: { heading: "Bandeins Strange", body: "Sen" },
	slides: [
		{ sourceSlideId: rpId, background: "#000000", includeSpeakerNotes: true, elements: baseElements() },
		{ sourceSlideId: rpId2, layout: "content" },
		{ sourceSlideId: rpId3, layout: "content" },
	],
});
const clonePlan = () => JSON.parse(JSON.stringify(basePlan()));
const runPlan = async (id: string, plan: any) => deckWorkbenchValidateRenderPlan!.execute(id, { workbenchId: richWorkbench.workbenchId, plan: JSON.stringify(plan) });
const hasErr = (res: any, code: string) => res.details.errors.some((e: any) => e.code === code);

// Valid content-ref plan → ready, returns a normalizedPlan with exact workbench text resolved.
const rpOk = await runPlan("rp-ok", basePlan());
assert.equal(rpOk.isError, undefined);
assert.equal(rpOk.details.ready, true, "well-formed content-ref render plan validates");
assert.equal(rpOk.details.errors.length, 0);
assert.ok(rpOk.details.normalizedPlan, "ready plan returns a normalizedPlan");
const rpNormSlide = rpOk.details.normalizedPlan.slides[0];
assert.equal(rpNormSlide.sourceSlideId, rpId);
const rpNormTitle = rpNormSlide.elements.find((e: any) => e.ref === "title");
assert.equal(rpNormTitle.text, "Cover Title", "normalizedPlan resolves exact workbench title text");
const rpNormBullets = rpNormSlide.elements.find((e: any) => e.ref === "bullets");
assert.deepEqual(rpNormBullets.items, ["First point", "Second point"], "normalizedPlan resolves exact workbench bullets");
assert.equal(rpNormSlide.speakerNotes, "Spoken aside for the room", "includeSpeakerNotes pulls workbench notes");
assert.ok(rpOk.details.allowed.contentRefs.includes("title") && rpOk.details.allowed.contentRefs.includes("bullets"), "allowed content refs reported");

// Invalid JSON → tool error.
const rpBadJson = await deckWorkbenchValidateRenderPlan!.execute("rp-badjson", { workbenchId: richWorkbench.workbenchId, plan: "{not json" });
assert.equal(rpBadJson.isError, true);
assert.match(rpBadJson.content[0].text, /not valid JSON/);

// Raw model text is rejected (text is referenced, never written) and excluded from any normalizedPlan.
const rpRawText = clonePlan();
rpRawText.slides[0].elements[0].text = "INVENTED HEADLINE";
const rpRawTextRes = await runPlan("rp-rawtext", rpRawText);
assert.equal(rpRawTextRes.details.ready, false, "raw text field is rejected");
assert.ok(hasErr(rpRawTextRes, "plan_unknown_field"), "raw text surfaces as an unknown-field error");
assert.equal(rpRawTextRes.details.normalizedPlan, undefined, "no normalizedPlan when invalid");

// Unknown fields are errors at top, slide, and element level.
const rpTop = clonePlan(); rpTop.extra = 1;
assert.ok(hasErr(await runPlan("rp-top", rpTop), "plan_unknown_field"), "unknown top-level field is an error");
const rpSlideUnknown = clonePlan(); rpSlideUnknown.slides[0].notes = "x";
assert.ok(hasErr(await runPlan("rp-slideunknown", rpSlideUnknown), "plan_unknown_field"), "unknown slide field is an error");
const rpElUnknown = clonePlan(); rpElUnknown.slides[0].elements[0].rotation = 45;
const rpElUnknownRes = await runPlan("rp-elunknown", rpElUnknown);
assert.equal(rpElUnknownRes.details.ready, false, "unknown element field blocks ready");
assert.ok(hasErr(rpElUnknownRes, "plan_unknown_field"), "unknown element field is an error");

// Required content placement is an error (title; bullets/keyMessage when present).
const rpNoTitle = clonePlan(); rpNoTitle.slides[0].elements = rpNoTitle.slides[0].elements.filter((e: any) => !(e.content && e.content.ref === "title"));
assert.ok(hasErr(await runPlan("rp-notitle", rpNoTitle), "plan_title_not_placed"), "missing title placement is an error");
const rpNoBullets = clonePlan(); rpNoBullets.slides[0].elements = rpNoBullets.slides[0].elements.filter((e: any) => !(e.content && e.content.ref === "bullets"));
assert.ok(hasErr(await runPlan("rp-nobullets", rpNoBullets), "plan_bullets_not_placed"), "missing bullets placement is an error");
const rpNoKey = clonePlan(); rpNoKey.slides[0].elements = rpNoKey.slides[0].elements.filter((e: any) => !(e.content && e.content.ref === "keyMessage"));
assert.ok(hasErr(await runPlan("rp-nokey", rpNoKey), "plan_key_message_not_placed"), "missing keyMessage placement is an error");

// One output slide per workbench slide, same order/id.
const rpCount = clonePlan(); rpCount.slides.push(JSON.parse(JSON.stringify(rpCount.slides[0])));
assert.ok(hasErr(await runPlan("rp-count", rpCount), "plan_slide_count_mismatch"), "rejects slide count mismatch");
const rpIdMis = clonePlan(); rpIdMis.slides[0].sourceSlideId = "not-a-real-id";
assert.ok(hasErr(await runPlan("rp-idmis", rpIdMis), "plan_slide_id_mismatch"), "rejects mismatched sourceSlideId");

// Existing safety checks still hold: bad color, bad font, bad shape, off-slide geometry, unsafe string.
const rpColor = clonePlan(); rpColor.palette.text = "#123456";
assert.ok(hasErr(await runPlan("rp-color", rpColor), "plan_color_not_allowed"), "rejects color outside reference palette");
const rpFont = clonePlan(); rpFont.fonts.heading = "Comic Sans Imaginary";
assert.ok(hasErr(await runPlan("rp-font", rpFont), "plan_font_not_allowed"), "rejects font outside extracted/safe set");
const rpShape = clonePlan(); rpShape.slides[0].elements.push({ type: "image", x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
assert.ok(hasErr(await runPlan("rp-shape", rpShape), "plan_element_type_invalid"), "rejects disallowed element type");
const rpGeom = clonePlan(); rpGeom.slides[0].elements[0].x = 1.5;
assert.ok(hasErr(await runPlan("rp-geom", rpGeom), "plan_geometry_out_of_bounds"), "rejects off-slide geometry");
const rpUnsafe = clonePlan(); rpUnsafe.fonts.heading = "http://evil.example/font";
assert.ok(hasErr(await runPlan("rp-unsafe", rpUnsafe), "plan_unsafe_string"), "rejects unsafe url/file/data tokens");

// Slice B: deterministic normalizedPlan → in-memory PPTX (no write, no export).
const genContentBefore = JSON.stringify(getDeckWorkbenchUiSnapshot(richWorkbench.workbenchId, 1).slides);

// Direct helper: a ready plan produces a non-empty PPTX buffer in memory with the right slide count.
const genDirect = await renderDeckRenderPlanToPptxBuffer({ workbenchId: richWorkbench.workbenchId, plan: basePlan() });
assert.ok(Buffer.isBuffer(genDirect.buffer) && genDirect.buffer.byteLength > 0, "generates an in-memory PPTX buffer");
assert.equal(genDirect.summary.slideCount, 3, "one output slide per workbench slide");
assert.equal(genDirect.summary.fonts.heading, "Bandeins Strange");
// Inspect the generated zip directly: macro/OLE/external-ref/embedded-font free, slide XML present.
const genZip = await JSZip.loadAsync(genDirect.buffer);
const genNames = Object.keys(genZip.files).filter((n) => !genZip.files[n].dir);
assert.ok(genNames.some((n) => /^ppt\/slides\/slide1\.xml$/i.test(n)), "expected slide XML exists");
assert.equal(genNames.filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n)).length, 3, "exactly three slides");
assert.ok(!genNames.some((n) => /vbaProject\.bin$/i.test(n)), "no macros");
assert.ok(!genNames.some((n) => /oleObject|\/embeddings\/.+|activeX/i.test(n)), "no OLE/embedded objects");
assert.ok(!genNames.some((n) => /^ppt\/fonts\/.+/i.test(n)), "no embedded fonts");
for (const rels of genNames.filter((n) => /\.rels$/i.test(n))) {
	const xml = await genZip.files[rels].async("string");
	assert.ok(!/TargetMode="External"/i.test(xml), "no external relationships");
	assert.ok(!/Target="(https?:|file:|data:)/i.test(xml), "no external http/file/data targets");
}

// Inspection tool: returns summary + safety metadata, never the bytes/path/base64.
const genTool = await deckWorkbenchGeneratePptxPreview!.execute("gen-ok", { workbenchId: richWorkbench.workbenchId, plan: JSON.stringify(basePlan()) });
assert.equal(genTool.isError, undefined);
assert.equal(genTool.details.inspection.valid, true, "generated PPTX passes safety inspection");
assert.equal(genTool.details.summary.slideCount, 3);
assert.ok(genTool.details.inspection.checks.noMacros && genTool.details.inspection.checks.noOle && genTool.details.inspection.checks.noExternalRefs && genTool.details.inspection.checks.noEmbeddedFonts && genTool.details.inspection.checks.slideXmlPresent && genTool.details.inspection.checks.slideCountMatches, "all safety checks pass");
assert.equal((genTool.details as any).buffer, undefined, "tool does not return the buffer");
assert.ok(!/[A-Za-z0-9+/]{200,}={0,2}/.test(JSON.stringify(genTool.details)), "tool returns no base64 blob");
assert.ok(!/\.pptx|nodebuffer|base64/i.test(JSON.stringify(genTool.details)), "tool returns no file/path/base64 reference");

// Invalid plan does not generate (helper throws; tool reports isError).
const genInvalid = clonePlan();
genInvalid.slides[0].elements = genInvalid.slides[0].elements.filter((e: any) => !(e.content && e.content.ref === "title"));
await assert.rejects(() => renderDeckRenderPlanToPptxBuffer({ workbenchId: richWorkbench.workbenchId, plan: genInvalid }), /not ready for PPTX generation/, "invalid plan does not generate");
const genInvalidTool = await deckWorkbenchGeneratePptxPreview!.execute("gen-invalid", { workbenchId: richWorkbench.workbenchId, plan: JSON.stringify(genInvalid) });
assert.equal(genInvalidTool.isError, true);

// Generation fails when reference evidence/palette is missing (workbench with no attached reference).
const genNoRefSnap = getDeckWorkbenchUiSnapshot(populatedBlankToolCreated.details.workbenchId, 1);
assert.equal(genNoRefSnap.formatReference, undefined, "control workbench has no attached reference");
await assert.rejects(() => renderDeckRenderPlanToPptxBuffer({ workbenchId: populatedBlankToolCreated.details.workbenchId, plan: basePlan() }), /attached formatting reference/, "generation requires attached reference evidence");

// Workbench content is unchanged after generation.
assert.equal(JSON.stringify(getDeckWorkbenchUiSnapshot(richWorkbench.workbenchId, 1).slides), genContentBefore, "workbench content unchanged after generation");

// Slice B.1 hardening:
// (a) Generated buffer over MAX_PPTX_BYTES is rejected by the helper (deterministic via maxBytes seam).
await assert.rejects(() => renderDeckRenderPlanToPptxBuffer({ workbenchId: richWorkbench.workbenchId, plan: basePlan() }, { maxBytes: 100 }), /over the 100-byte limit/, "oversized generated PPTX is rejected");
// A normal generation stays well under the real cap.
assert.ok(genDirect.summary.bytes < 25 * 1024 * 1024, "normal generated PPTX is within MAX_PPTX_BYTES");

// (b) inspectGeneratedPptxBuffer flags unsafe/malformed PPTX as valid:false (fail-closed substance).
const makeBadZip = async (extra: (z: InstanceType<typeof JSZip>) => void) => {
	const z = new JSZip();
	z.file("[Content_Types].xml", "<Types/>");
	z.file("ppt/slides/slide1.xml", "<p:sld/>");
	extra(z);
	return Buffer.from(await z.generateAsync({ type: "nodebuffer" }));
};
const okBuf = await makeBadZip(() => {});
const okInspect = await inspectGeneratedPptxBuffer(okBuf, 1);
assert.equal(okInspect.valid, true, "clean minimal zip inspects valid");

const macroInspect = await inspectGeneratedPptxBuffer(await makeBadZip((z) => z.file("ppt/vbaProject.bin", "macro")), 1);
assert.equal(macroInspect.valid, false);
assert.equal(macroInspect.checks.noMacros, false, "macro project flagged");

const oleInspect = await inspectGeneratedPptxBuffer(await makeBadZip((z) => z.file("ppt/embeddings/oleObject1.bin", "ole")), 1);
assert.equal(oleInspect.valid, false);
assert.equal(oleInspect.checks.noOle, false, "OLE object flagged");

const fontInspect = await inspectGeneratedPptxBuffer(await makeBadZip((z) => z.file("ppt/fonts/font1.fntdata", "FNT")), 1);
assert.equal(fontInspect.valid, false);
assert.equal(fontInspect.checks.noEmbeddedFonts, false, "embedded font flagged");

const externInspect = await inspectGeneratedPptxBuffer(await makeBadZip((z) => z.file("ppt/slides/_rels/slide1.xml.rels", "<Relationships><Relationship TargetMode=\"External\" Target=\"http://evil.example\"/></Relationships>")), 1);
assert.equal(externInspect.valid, false);
assert.equal(externInspect.checks.noExternalRefs, false, "external relationship flagged");

const countInspect = await inspectGeneratedPptxBuffer(okBuf, 2);
assert.equal(countInspect.valid, false);
assert.equal(countInspect.checks.slideCountMatches, false, "slide count mismatch flagged");

const notZipInspect = await inspectGeneratedPptxBuffer(Buffer.from("not a zip"), 1);
assert.equal(notZipInspect.valid, false);
assert.equal(notZipInspect.checks.validZip, false, "non-zip flagged");

// ── Slice C: approval-gated durable .pptx write ───────────────────────────────────────────────
const pptxRoot = path.join(tempHome, ".exxperts", "app", "artifacts");
const writeContentBefore = JSON.stringify(getDeckWorkbenchUiSnapshot(richWorkbench.workbenchId, 1).slides);

// Helper seam: a forced inspection failure is not write-ready (fail closed at the inspect stage).
const prepForced = await prepareDeckRenderPlanPptxForWrite({ workbenchId: richWorkbench.workbenchId, plan: basePlan() }, { forceInspectionInvalidForTest: true });
assert.equal(prepForced.ok, false, "forced inspection failure is not write-ready");
assert.equal(prepForced.stage, "inspect");
assert.equal(prepForced.buffer, undefined, "failed prep exposes no buffer to write");
// A clean plan preps ok and yields a real buffer.
const prepOk = await prepareDeckRenderPlanPptxForWrite({ workbenchId: richWorkbench.workbenchId, plan: basePlan() });
assert.equal(prepOk.ok, true);
assert.ok(Buffer.isBuffer(prepOk.buffer) && prepOk.buffer.byteLength > 0, "ready prep yields PPTX bytes");

const writeStateBefore = snapshotLocalState();
const writeConfirmBefore = confirmDetails.length;

// Non-.pptx filename is rejected before any approval/write (.pptx allowed only for this tool).
const wrongExt = await deckWorkbenchWritePptx!.execute("wpx-ext", { workbenchId: richWorkbench.workbenchId, plan: JSON.stringify(basePlan()), filename: "decks/wrong.html" }, undefined, undefined, approvalTrue);
assert.equal(wrongExt.isError, true);
assert.equal(confirmDetails.length, writeConfirmBefore, "non-.pptx rejected before approval");
assert.deepEqual(snapshotLocalState(), writeStateBefore, "non-.pptx writes nothing");

// Path escape is rejected before approval/write.
const escapeWrite = await deckWorkbenchWritePptx!.execute("wpx-escape", { workbenchId: richWorkbench.workbenchId, plan: JSON.stringify(basePlan()), filename: "../escape.pptx" }, undefined, undefined, approvalTrue);
assert.equal(escapeWrite.isError, true);
assert.equal(confirmDetails.length, writeConfirmBefore, "path escape rejected before approval");
assert.deepEqual(snapshotLocalState(), writeStateBefore, "path escape writes nothing");

// Invalid plan fails before approval and writes nothing.
const wpxInvalid = clonePlan();
wpxInvalid.slides[0].elements = wpxInvalid.slides[0].elements.filter((e: any) => !(e.content && e.content.ref === "title"));
const invalidWrite = await deckWorkbenchWritePptx!.execute("wpx-invalid", { workbenchId: richWorkbench.workbenchId, plan: JSON.stringify(wpxInvalid), filename: "decks/invalid.pptx" }, undefined, undefined, approvalTrue);
assert.equal(invalidWrite.isError, true);
assert.equal(confirmDetails.length, writeConfirmBefore, "invalid plan fails before approval");
assert.deepEqual(snapshotLocalState(), writeStateBefore, "invalid plan writes nothing");

// No UI: cannot approve → nothing written, reports error.
const noUiWrite = await deckWorkbenchWritePptx!.execute("wpx-noui", { workbenchId: richWorkbench.workbenchId, plan: JSON.stringify(basePlan()), filename: "decks/noui.pptx" }, undefined, undefined, noUi);
assert.equal(noUiWrite.isError, true);
assert.equal(noUiWrite.details.saved, false);
assert.ok(!fs.existsSync(path.join(pptxRoot, "decks", "noui.pptx")), "no-UI writes nothing");

// Approval declined: nothing written.
const declinedWrite = await deckWorkbenchWritePptx!.execute("wpx-declined", { workbenchId: richWorkbench.workbenchId, plan: JSON.stringify(basePlan()), filename: "decks/declined.pptx" }, undefined, undefined, approvalFalse);
assert.equal(declinedWrite.details.saved, false);
assert.ok(!fs.existsSync(path.join(pptxRoot, "decks", "declined.pptx")), "declined approval writes nothing");

// Approved: writes a real .pptx under the approved artifact root.
const writeConfirmCountBeforeSave = confirmDetails.length;
const savedWrite = await deckWorkbenchWritePptx!.execute("wpx-save", { workbenchId: richWorkbench.workbenchId, plan: JSON.stringify(basePlan()), filename: "decks/reference-style.pptx", reason: "save approved deck" }, undefined, undefined, approvalTrue);
assert.equal(savedWrite.isError, undefined, "approved write succeeds");
assert.equal(savedWrite.details.saved, true);
const savedPptxPath = path.join(pptxRoot, "decks", "reference-style.pptx");
assert.equal(savedWrite.details.path, savedPptxPath);
assert.ok(fs.existsSync(savedPptxPath), "approved .pptx exists on disk");
assert.ok(savedPptxPath.startsWith(pptxRoot + path.sep), "saved under approved artifact root");
assert.equal(confirmDetails.length, writeConfirmCountBeforeSave + 1, "exactly one approval prompt");
// Approval card: path, overwrite, slides, bytes, fonts-by-name, safety, fidelity caveat.
const writeCard = confirmDetails.at(-1) ?? "";
assert.match(writeCard, /Path: .*decks[/\\]reference-style\.pptx/);
assert.match(writeCard, /Overwrite: no, new file/);
assert.match(writeCard, /Slides: 3/);
assert.match(writeCard, /Size: \d+ bytes/);
assert.match(writeCard, /Fonts \(named local fonts only, NOT embedded\): heading Bandeins Strange/);
assert.match(writeCard, /no embedded fonts, no assets\/images, no macros, no OLE, no external references/);
assert.match(writeCard, /Fidelity: approximate reference-style only/);
// The internal workbench id is not exposed in the user-visible approval card.
assert.doesNotMatch(writeCard, /Workbench:/);
assert.ok(!writeCard.includes(richWorkbench.workbenchId), "approval card hides the workbench id");

// The exact saved bytes reopen with JSZip and re-pass inspection.
const savedBytes = fs.readFileSync(savedPptxPath);
const savedInspect = await inspectGeneratedPptxBuffer(savedBytes, savedWrite.details.slideCount);
assert.equal(savedInspect.valid, true, "saved .pptx re-passes safety inspection");
const savedZip = await JSZip.loadAsync(savedBytes);
assert.ok(Object.keys(savedZip.files).some((n) => /^ppt\/slides\/slide1\.xml$/i.test(n)), "saved .pptx has slide XML");

// Re-saving the same path is flagged as an overwrite in the approval card.
const overwriteWrite = await deckWorkbenchWritePptx!.execute("wpx-overwrite", { workbenchId: richWorkbench.workbenchId, plan: JSON.stringify(basePlan()), filename: "decks/reference-style.pptx" }, undefined, undefined, approvalTrue);
assert.equal(overwriteWrite.details.saved, true);
assert.equal(overwriteWrite.details.replaced, true);
assert.match(confirmDetails.at(-1) ?? "", /Overwrite: yes/);

// Global write behavior unchanged: generic artifact_write still refuses .pptx (ALLOWED_EXTENSIONS not broadened).
const genericPptx = await write!.execute("generic-pptx", { filename: "decks/generic.pptx", content: "x" }, undefined, undefined, approvalTrue);
assert.equal(genericPptx.isError, true);
assert.match(genericPptx.content[0].text, /Unsupported artifact extension/);
assert.ok(!fs.existsSync(path.join(pptxRoot, "decks", "generic.pptx")), "generic write does not create .pptx");

// Workbench content is unchanged after the entire write flow.
assert.equal(JSON.stringify(getDeckWorkbenchUiSnapshot(richWorkbench.workbenchId, 1).slides), writeContentBefore, "workbench content unchanged after .pptx write");

// ── Slice C.2: render-plan authoring context ──────────────────────────────────────────────────
const ctxContentBefore = JSON.stringify(getDeckWorkbenchUiSnapshot(richWorkbench.workbenchId, 1).slides);

// Fails without an attached reference (content-only workbench).
const ctxNoRef = await deckWorkbenchRenderPlanContext!.execute("rpc-noref", { workbenchId: populatedBlankToolCreated.details.workbenchId });
assert.equal(ctxNoRef.isError, true);
assert.match(ctxNoRef.content[0].text, /attached formatting reference/);

// Fails when the attached reference has no usable palette.
const ctxNoPalette = await deckWorkbenchRenderPlanContext!.execute("rpc-nopalette", { workbenchId: noPaletteWorkbench.workbenchId });
assert.equal(ctxNoPalette.isError, true);
assert.match(ctxNoPalette.content[0].text, /usable background\/text palette/);

// Succeeds for a workbench with reference + usable palette.
const ctxOk = await deckWorkbenchRenderPlanContext!.execute("rpc-ok", { workbenchId: richWorkbench.workbenchId });
assert.equal(ctxOk.isError, undefined);
const rpc = ctxOk.details;
// Returns exact current slide ids in order.
const liveIds = getDeckWorkbenchUiSnapshot(richWorkbench.workbenchId, 1).slides.map((s: any) => s.id);
assert.deepEqual(rpc.slideIds, liveIds, "render-plan context returns exact slide ids in order");
assert.equal(rpc.slideCount, liveIds.length);
// Per-slide content availability for the populated slide.
assert.equal(rpc.slides[0].sourceSlideId, rpId);
assert.equal(rpc.slides[0].available.title, true);
assert.equal(rpc.slides[0].available.keyMessage, true);
assert.equal(rpc.slides[0].available.bullets, true);
assert.equal(rpc.slides[0].available.speakerNotes, true);
assert.equal(rpc.slides[0].available.slideNumber, true);
// Returns allowed colors/fonts/shapes/contentRefs.
assert.ok(rpc.allowed.colors.includes("#000000") && rpc.allowed.colors.includes("#FFFFFF"), "allowed colors include base palette");
assert.ok(Array.isArray(rpc.allowed.fonts) && rpc.allowed.fonts.length > 0, "allowed fonts reported");
assert.deepEqual([...rpc.allowed.shapeTypes].sort(), ["block", "divider", "outline-rect"], "allowed shape types reported");
assert.deepEqual([...rpc.allowed.contentRefs].sort(), ["bullets", "keyMessage", "slideNumber", "speakerNotes", "title", "visualIdea"], "allowed content refs reported");
assert.ok(Array.isArray(rpc.layoutEvidence), "reference layout evidence included");
// Slice C.3 fidelity authoring: slideContentPackets, layoutRecipes, authoringGuidance.
assert.ok(Array.isArray(rpc.slideContentPackets) && rpc.slideContentPackets.length === liveIds.length, "render-plan context returns slideContentPackets per slide");
const packet0 = rpc.slideContentPackets[0];
assert.equal(packet0.slideNumber, 1);
assert.equal(packet0.sourceSlideId, rpId);
assert.equal(packet0.title, "Cover Title", "packet carries authoring title text");
assert.equal(packet0.keyMessage, "One clear key message");
assert.equal(packet0.subtitleLike, "One clear key message", "keyMessage exposed as subtitle-like");
assert.deepEqual(packet0.bullets, ["First point", "Second point"]);
assert.deepEqual(packet0.bodyItems, ["First point", "Second point"], "bullets exposed as bodyItems");
assert.equal(packet0.speakerNotesAvailable, true);
// layoutRecipes derived from reference layoutEvidence (richlayout.pptx has evidence).
assert.ok(Array.isArray(rpc.layoutRecipes) && rpc.layoutRecipes.length > 0, "layoutRecipes returned when layoutEvidence exists");
const recipe0 = rpc.layoutRecipes[0];
assert.ok(typeof recipe0.name === "string" && recipe0.name.length > 0, "layout recipe has a name");
assert.ok(typeof recipe0.hint === "string" && recipe0.hint.length > 0, "layout recipe has a concise hint");
assert.ok(Array.isArray(recipe0.motifs) && Array.isArray(recipe0.roughRegions), "layout recipe exposes safe hint arrays");
// Recipes must not leak unsafe/asset references.
assert.ok(!/https?:|url\(|<|data:|file:|\.png|\.jpg/i.test(JSON.stringify(rpc.layoutRecipes)), "layout recipes contain only safe hints");
// authoringGuidance steers to designed layout-based authoring (engine owns geometry).
assert.ok(Array.isArray(rpc.authoringGuidance) && rpc.authoringGuidance.length > 0, "authoringGuidance present");
assert.match(rpc.authoringGuidance.join("\n"), /layout|engine/i, "authoringGuidance directs layout-based authoring");
assert.match(rpc.authoringGuidance.join("\n"), /Do NOT hand-place|font sizes/i, "authoringGuidance warns against hand-placing coordinates");
assert.match(rpc.authoringGuidance.join("\n"), /content refs|never paste it as raw text/i, "authoringGuidance reinforces content-ref-only authoring");
// Designed layout engine: allowed layouts + recommended layout per slide.
assert.deepEqual([...rpc.allowed.layouts].sort(), ["content", "cover", "quote", "section", "statement"], "allowed layout archetypes reported");
assert.equal(packet0.recommendedLayout, "cover", "slide 1 is recommended the cover layout");
assert.ok(rpc.allowed.layouts.includes(packet0.recommendedLayout), "recommended layout is an allowed archetype");
// Skeleton is layout-based: one slide per workbench slide, exact sourceSlideId, a valid layout name.
assert.equal(rpc.skeleton.version, "1.0");
assert.equal(rpc.skeleton.slides.length, liveIds.length, "skeleton has one slide per workbench slide");
assert.deepEqual(rpc.skeleton.slides.map((s: any) => s.sourceSlideId), liveIds, "skeleton uses exact sourceSlideIds in order");
assert.ok(rpc.skeleton.slides.every((s: any) => rpc.allowed.layouts.includes(s.layout)), "skeleton slides use allowed layout archetypes");
assert.equal(rpc.skeleton.slides[0].layout, "cover", "skeleton slide 1 uses the cover layout");
// Skeleton contains no raw workbench text (layout-based, content resolved by ref at generation).
const skelJson = JSON.stringify(rpc.skeleton);
assert.ok(!/Cover Title|key message|First point/i.test(skelJson), "skeleton references content, never raw text");
// The skeleton validates with validateDeckRenderPlan as-is.
assert.equal(rpc.skeletonValidates, true, "context reports skeleton validates");
const skelValidation = validateDeckRenderPlan({ workbenchId: richWorkbench.workbenchId, plan: rpc.skeleton });
assert.equal(skelValidation.ready, true, "skeleton validates with validateDeckRenderPlan");
assert.ok(skelValidation.normalizedPlan, "validated skeleton yields a normalizedPlan");
// Reference-extracted type scale (title>subtitle>body) drives the generated font sizes.
assert.ok(rpc.typeScale, "render-plan context reports the extracted type scale");
assert.ok(rpc.typeScale.titlePt > rpc.typeScale.subtitlePt && rpc.typeScale.subtitlePt > rpc.typeScale.bodyPt, "extracted type scale is ordered title>subtitle>body");
assert.ok(Number.isInteger(rpc.typeScale.titlePt) && Number.isInteger(rpc.typeScale.bodyPt), "type scale sizes are integer points");
const normSlide0 = skelValidation.normalizedPlan.slides[0];
const titleEl = normSlide0.elements.find((e: any) => e.ref === "title");
const subtitleEl = normSlide0.elements.find((e: any) => e.ref === "keyMessage");
const bulletsEl = normSlide0.elements.find((e: any) => e.ref === "bullets");
assert.equal(bulletsEl.fontSizePt, rpc.typeScale.bodyPt, "generated body/bullets size comes straight from the reference body size");
assert.equal(subtitleEl.fontSizePt, rpc.typeScale.subtitlePt, "generated subtitle size comes from the reference subtitle size");
assert.ok(titleEl.fontSizePt >= rpc.typeScale.subtitlePt, "generated title size is at least the subtitle size");
// Round-trips through the validate tool too.
const skelToolValidation = await deckWorkbenchValidateRenderPlan!.execute("rpc-skel-validate", { workbenchId: richWorkbench.workbenchId, plan: JSON.stringify(rpc.skeleton) });
assert.equal(skelToolValidation.details.ready, true, "skeleton validates through the render-plan validate tool");
// Layout-based skeleton generates a real, multi-element designed slide via the engine.
const skelGenerated = await renderDeckRenderPlanToPptxBuffer({ workbenchId: richWorkbench.workbenchId, plan: rpc.skeleton });
assert.ok(skelGenerated.summary.elementCount >= 3, "layout engine composes multiple designed elements per slide");
const skelInspect = await inspectGeneratedPptxBuffer(skelGenerated.buffer, skelGenerated.summary.slideCount);
assert.equal(skelInspect.valid, true, "layout-based generated PPTX passes safety inspection");
// Content refs remain mandatory in the manual element path: raw text (a `text` field) is rejected.
const rawTextPlan = clonePlan();
const rawTitleEl = rawTextPlan.slides[0].elements.find((e: any) => e.content && e.content.ref === "title");
delete rawTitleEl.content;
rawTitleEl.text = "Hand-written title that bypasses refs";
const rawTextValidation = await deckWorkbenchValidateRenderPlan!.execute("rpc-rawtext", { workbenchId: richWorkbench.workbenchId, plan: JSON.stringify(rawTextPlan) });
assert.equal(rawTextValidation.details.ready, false, "render plan with raw text instead of content ref is rejected");
assert.ok(rawTextValidation.details.errors.some((e: any) => e.code === "plan_unknown_field" || e.code === "plan_content_required" || e.code === "plan_title_not_placed"), "raw-text element fails content-ref enforcement");
// A layout slide cannot also carry hand-authored elements.
const layoutAndElements = clonePlan();
layoutAndElements.slides[0].layout = "content";
const layoutBothValidation = await deckWorkbenchValidateRenderPlan!.execute("rpc-layout-both", { workbenchId: richWorkbench.workbenchId, plan: JSON.stringify(layoutAndElements) });
assert.equal(layoutBothValidation.details.ready, false, "providing both layout and elements is rejected");
assert.ok(layoutBothValidation.details.errors.some((e: any) => e.code === "plan_layout_with_elements"), "layout+elements conflict flagged");
// No workbench mutation from requesting context.
assert.equal(JSON.stringify(getDeckWorkbenchUiSnapshot(richWorkbench.workbenchId, 1).slides), ctxContentBefore, "render-plan context does not mutate workbench content");

// ── Visual render-and-critique loop ───────────────────────────────────────────────────────────
const renderAvail = pptxRenderAvailability();
assert.equal(typeof renderAvail.available, "boolean", "render availability is reported");
assert.ok(typeof renderAvail.installHint === "string" && /libreoffice/i.test(renderAvail.installHint), "availability includes an install hint");
if (renderAvail.available) {
	// A real headless renderer is present: render the layout-based skeleton and get back slide images.
	const renderTool = await deckWorkbenchRenderPptxImages!.execute("render-ok", { workbenchId: richWorkbench.workbenchId, plan: JSON.stringify(rpc.skeleton) });
	assert.equal(renderTool.isError, undefined, "render-to-images succeeds when a renderer is installed");
	assert.equal(renderTool.details.rendered, true);
	assert.ok(renderTool.details.renderedCount >= 1, "at least one slide image rendered");
	assert.ok(renderTool.content.some((c: any) => c.type === "image" && c.mimeType === "image/png" && typeof c.data === "string" && c.data.length > 0), "returns PNG image content parts");
	const direct = renderPptxBufferToSlideImages((await renderDeckRenderPlanToPptxBuffer({ workbenchId: richWorkbench.workbenchId, plan: rpc.skeleton })).buffer, { maxSlides: 1 });
	assert.ok(direct.images.length >= 1 && typeof direct.images[0].pngBase64 === "string", "helper returns base64 PNG slide images");
} else {
	// No renderer installed (this environment): fail closed with clear, actionable install guidance.
	assert.ok(renderAvail.missing.length > 0, "missing renderer components are listed");
	const renderTool = await deckWorkbenchRenderPptxImages!.execute("render-missing", { workbenchId: richWorkbench.workbenchId, plan: JSON.stringify(rpc.skeleton) });
	assert.equal(renderTool.isError, true, "render-to-images fails closed without a renderer");
	assert.equal(renderTool.details.rendered, false);
	assert.match(renderTool.content[0].text, /unavailable|install/i, "tool explains how to enable visual preview");
	assert.throws(() => renderPptxBufferToSlideImages(Buffer.from("x")), /missing|install/i, "helper throws a clear error without a renderer");
}

// Attach a formatting reference to an existing content-only workbench. populatedBlankToolCreated
// was created from slides with no reference; attaching approved PPTX style evidence must not seed,
// replace, or mutate any content, and must not write files or request approval.
const attachWorkbenchId = populatedBlankToolCreated.details.workbenchId;
const attachContentBefore = getDeckWorkbenchUiSnapshot(attachWorkbenchId, 1);
assert.equal(attachContentBefore.formatReference, undefined, "workbench starts content-only with no format reference");
const attachSlidesBefore = JSON.stringify(attachContentBefore.slides);
const attachSlideCountBefore = attachContentBefore.slideCount;
const attachSelectedTitleBefore = attachContentBefore.selectedSlide.title;
const attachConfirmCountBefore = confirmDetails.length;
const attachFilesBefore = snapshotLocalState();

const attachResult = await deckWorkbenchAttachFormatReference!.execute("wb-attach-format", {
	workbenchId: attachWorkbenchId,
	filename: "sample.pptx",
	folder: "refs",
});
assert.equal(attachResult.isError, undefined);
// formatReference is attached and marked as approximate style evidence only.
assert.equal(attachResult.details.snapshot.formatReference.sourceType, "pptx");
assert.equal(attachResult.details.snapshot.formatReference.sourceLabel, "default/refs/sample.pptx");
assert.equal(attachResult.details.snapshot.formatReference.evidenceStatus, "approximate_style_evidence_available");
assert.match(attachResult.details.caveat, /approximate style evidence only/i);
assert.match(attachResult.content[0].text, /content\/slides unchanged/i);
// No approval requested and no local filesystem write/mutation.
assert.equal(confirmDetails.length, attachConfirmCountBefore, "attach does not request approval");
assert.deepEqual(snapshotLocalState(), attachFilesBefore, "attach does not write or mutate local files");
// Content preserved exactly: slide count, slides (ids/titles/key messages/bullets/notes), selection.
const attachContentAfter = getDeckWorkbenchUiSnapshot(attachWorkbenchId, 1);
assert.equal(attachContentAfter.slideCount, attachSlideCountBefore);
assert.equal(attachContentAfter.selectedSlide.title, attachSelectedTitleBefore);
assert.equal(JSON.stringify(attachContentAfter.slides), attachSlidesBefore, "slide content unchanged after attach");
// referenceStyleProfile is retained on state: reference-style preview now renders from it
// (sample.pptx has a usable black/white palette).
const attachedReferencePreview = previewDeckWorkbenchReferenceHtmlForUi({ workbenchId: attachWorkbenchId, footer: "Attached reference" });
assert.equal(attachedReferencePreview.ready, true);
assert.equal((attachedReferencePreview.htmlPreview.match(/<section class="slide"/g) || []).length, attachSlideCountBefore);
assert.ok(!/#111111/i.test(attachedReferencePreview.htmlPreview), "attached-reference preview does not fall back to generic styling");

// Two-step model-generated reference-style preview. Step 1: read-only context returns retained
// style evidence + current content + the HTML contract (no mutation, no writes).
const filesBeforeRefContext = snapshotLocalState();
const refContextResult = await deckWorkbenchReferenceHtmlContext!.execute("ref-context", { workbenchId: attachWorkbenchId });
assert.equal(refContextResult.isError, undefined);
assert.equal(refContextResult.details.slideCount, attachSlideCountBefore);
assert.equal(refContextResult.details.referenceSourceLabel, "default/refs/sample.pptx");
assert.ok(typeof refContextResult.details.styleProfileSummary === "string" && refContextResult.details.styleProfileSummary.length > 0);
assert.equal(refContextResult.details.slides.length, attachSlideCountBefore);
assert.ok(Array.isArray(refContextResult.details.htmlContract) && refContextResult.details.htmlContract.length > 0);
assert.deepEqual(snapshotLocalState(), filesBeforeRefContext, "reference html context does not write or mutate local files");
// Context tool did not change workbench content.
assert.equal(JSON.stringify(getDeckWorkbenchUiSnapshot(attachWorkbenchId, 1).slides), attachSlidesBefore);

// Step 2: a valid self-contained document with one <section class="slide"> per slide is accepted
// and echoed back as a ready RHS preview, non-persistent.
const sectionsFor = (n: number) => Array.from({ length: n }, (_, i) => `<section class="slide"><h2>Slide ${i + 1}</h2><p>Approximate reference-style preview; not exact PPTX fidelity.</p><div class="footer">Footer</div></section>`).join("");
const validRefHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Ref preview</title><style>body{margin:0;background:#000;color:#fff;font-family:Arial,Helvetica,sans-serif}.slide{min-height:100vh;padding:48px;border-bottom:1px solid #fff}/* Fonts are not embedded. */</style></head><body>${sectionsFor(attachSlideCountBefore)}</body></html>`;
const filesBeforeRefPreview = snapshotLocalState();
const refPreviewResult = await deckWorkbenchPreviewReferenceHtml!.execute("ref-preview", { workbenchId: attachWorkbenchId, html: validRefHtml });
assert.equal(refPreviewResult.isError, undefined);
assert.equal(refPreviewResult.details.ready, true);
assert.equal(refPreviewResult.details.htmlPreviewTruncated, false);
assert.equal(refPreviewResult.details.slideCount, attachSlideCountBefore);
assert.equal(refPreviewResult.details.htmlPreview, validRefHtml, "preview echoes the model HTML unchanged");
assert.deepEqual(snapshotLocalState(), filesBeforeRefPreview, "reference html preview does not write or mutate local files");
// Content still unchanged after preview.
assert.equal(JSON.stringify(getDeckWorkbenchUiSnapshot(attachWorkbenchId, 1).slides), attachSlidesBefore);

// Rejects wrong <section> count instead of rendering it.
const wrongCountResult = await deckWorkbenchPreviewReferenceHtml!.execute("ref-preview-wrong-count", { workbenchId: attachWorkbenchId, html: `<!doctype html><html><body>${sectionsFor(attachSlideCountBefore - 1)}</body></html>` });
assert.equal(wrongCountResult.isError, true);
assert.match(wrongCountResult.content[0].text, new RegExp(`expected ${attachSlideCountBefore}`));

// Rejects unsafe HTML (script tag).
const unsafeResult = await deckWorkbenchPreviewReferenceHtml!.execute("ref-preview-unsafe", { workbenchId: attachWorkbenchId, html: `<!doctype html><html><body>${sectionsFor(attachSlideCountBefore)}<script>alert(1)</script></body></html>` });
assert.equal(unsafeResult.isError, true);
assert.match(unsafeResult.content[0].text, /script tag detected/);

// Rejects inline event handlers (e.g. onload=, onclick=).
const refHandlerResult = await deckWorkbenchPreviewReferenceHtml!.execute("ref-preview-handler", { workbenchId: attachWorkbenchId, html: `<!doctype html><html><body onload="alert(1)">${sectionsFor(attachSlideCountBefore)}</body></html>` });
assert.equal(refHandlerResult.isError, true);
assert.match(refHandlerResult.content[0].text, /inline event handler/);

// Unusable reference palette → both steps report unavailable, never generic styling.
const noPaletteContext = await deckWorkbenchReferenceHtmlContext!.execute("ref-context-nopalette", { workbenchId: noPaletteWorkbench.workbenchId });
assert.equal(noPaletteContext.isError, true);
assert.match(noPaletteContext.content[0].text, /unavailable/i);
const noPalettePreview = await deckWorkbenchPreviewReferenceHtml!.execute("ref-preview-nopalette", { workbenchId: noPaletteWorkbench.workbenchId, html: `<!doctype html><html><body><section class="slide"><h2>One</h2></section></body></html>` });
assert.equal(noPalettePreview.isError, true);
assert.match(noPalettePreview.content[0].text, /unavailable/i);

// Canonical setup for the downstream workbench tests (update/validate/repair/render-plan):
// a scratch workbench built from the user's own content, with an approved .pptx attached as
// style-only evidence. Content is the blank deck's preset slides; the reference never imports content.
const confirmCountBeforeWorkbench = confirmDetails.length;
const localStateBeforeWorkbench = snapshotLocalState();
const refSetup = await createDeckWorkbenchFromApprovedPptx({ filename: "sample.pptx", folder: "refs" });
const workbenchId = refSetup.workbenchId;
assert.match(workbenchId, /^wb_/);
assert.ok(workbenchId.length > 10);
assert.equal(refSetup.snapshot.formatReference?.sourceType, "pptx");
assert.equal(refSetup.snapshot.formatReference?.sourceLabel, "default/refs/sample.pptx");
assert.equal(refSetup.snapshot.formatReference?.evidenceStatus, "approximate_style_evidence_available");

// Reference-style preview renders one <section> per workbench slide once a usable palette exists.
const styleIntentReferencePreview = previewDeckWorkbenchReferenceHtmlForUi({ workbenchId, footer: "Style-only preview" });
assert.equal(styleIntentReferencePreview.ready, true);
assert.equal(styleIntentReferencePreview.htmlPreviewTruncated, false);
assert.equal((styleIntentReferencePreview.htmlPreview.match(/<section class="slide"/g) || []).length, styleIntentReferencePreview.slideCount);

const workbenchForHelperOtherSlide = await deckWorkbenchUpdate!.execute("wb-helper-seed-other-slide", {
	workbenchId,
	slides: [{ slideIndex: 1, title: "Helper slide one", keyMessage: "One", bullets: ["A"], speakerNotes: "Notes one" }],
});
assert.equal(workbenchForHelperOtherSlide.isError, undefined);
const helperPreState = getDeckWorkbenchUiSnapshot(workbenchId, 1);
const helperOtherBefore = helperPreState.slides.length > 1 ? getDeckWorkbenchUiSnapshot(workbenchId, 2) : null;
const helperBeforeFiles = snapshotLocalState();
const helperUpdated = updateDeckWorkbenchSelectedSlide({
	workbenchId,
	slideIndex: 1,
	title: "Helper selected title",
	keyMessage: "Helper key",
	bullets: ["First", "Second"],
	speakerNotes: "Helper notes",
	visualIdea: "Storyboard: one-column journey",
});
assert.equal(helperUpdated.selectedSlide.index, 1);
assert.equal(helperUpdated.selectedSlide.title, "Helper selected title");
assert.equal(helperUpdated.selectedSlide.keyMessage, "Helper key");
assert.deepEqual(helperUpdated.selectedSlide.bullets, ["First", "Second"]);
assert.equal(helperUpdated.selectedSlide.speakerNotes, "Helper notes");
assert.equal(helperUpdated.selectedSlide.visualIdea, "Storyboard: one-column journey");
assert.equal(helperUpdated.slides.length, helperPreState.slides.length);
if (helperUpdated.slides.length > 1 && helperOtherBefore) {
	const helperOtherAfter = getDeckWorkbenchUiSnapshot(workbenchId, 2);
	assert.equal(helperOtherAfter.selectedSlide.title, helperOtherBefore.selectedSlide.title);
	assert.deepEqual(helperOtherAfter.selectedSlide.bullets, helperOtherBefore.selectedSlide.bullets);
}
assert.deepEqual(snapshotLocalState(), helperBeforeFiles);
assert.throws(() => updateDeckWorkbenchSelectedSlide({
	workbenchId,
	slideIndex: 1,
	title: "   ",
	bullets: [],
}), /Slide title is required/);

const workbenchGet = await deckWorkbenchGet!.execute("wb-get", { workbenchId });
assert.equal(workbenchGet.isError, undefined);
assert.equal(workbenchGet.details.workbenchId, workbenchId);
assert.equal(workbenchGet.details.reuseIntent, "scratch");
assert.equal(workbenchGet.details.formatReference?.sourceType, "pptx");
assert.equal(workbenchGet.details.formatReference?.sourceLabel, "default/refs/sample.pptx");
assert.equal(typeof workbenchGet.details.draftSummary.title, "string");
assert.ok(workbenchGet.details.draftSummary.slideCount >= 1);

const workbenchBeforeValidate = await deckWorkbenchGet!.execute("wb-get-before-validate", { workbenchId });
assert.equal(workbenchBeforeValidate.isError, undefined);
const updatedAtBeforeValidate = workbenchBeforeValidate.details.updatedAt;

const workbenchValidate = await deckWorkbenchValidate!.execute("wb-validate", { workbenchId });
assert.equal(workbenchValidate.isError, undefined);
assert.equal(workbenchValidate.details.workbenchId, workbenchId);
assert.equal(typeof workbenchValidate.details.ready, "boolean");
assert.ok(Array.isArray(workbenchValidate.details.summary));
assert.ok(Array.isArray(workbenchValidate.details.errors));
assert.ok(Array.isArray(workbenchValidate.details.warnings));
assert.ok(Array.isArray(workbenchValidate.details.repairTargets));
assert.match(workbenchValidate.content[0].text, /Readiness: ready=/);

const workbenchAfterValidate = await deckWorkbenchGet!.execute("wb-get-after-validate", { workbenchId });
assert.equal(workbenchAfterValidate.isError, undefined);
assert.equal(workbenchAfterValidate.details.updatedAt, updatedAtBeforeValidate);

const updatedAtBeforeUpdate = workbenchGet.details.updatedAt;
await new Promise((resolve) => setTimeout(resolve, 5));
const workbenchUpdateDeck = await deckWorkbenchUpdate!.execute("wb-update-deck", {
	workbenchId,
	title: "  Updated Deck Title  ",
	subtitle: "  Updated Subtitle  ",
	audience: "  Exec Team  ",
});
assert.equal(workbenchUpdateDeck.isError, undefined);
assert.equal(workbenchUpdateDeck.details.workbenchId, workbenchId);
assert.equal(workbenchUpdateDeck.details.changed.fieldCount, 3);
assert.equal(workbenchUpdateDeck.details.changed.slideCount, 0);
assert.deepEqual(workbenchUpdateDeck.details.changed.deckFields, ["title", "subtitle", "audience"]);
assert.match(workbenchUpdateDeck.content[0].text, /Changed fields: 3; changed slides: 0/);
assert.match(workbenchUpdateDeck.content[0].text, /Readiness: ready=/);
assert.match(workbenchUpdateDeck.content[0].text, /transient in-memory only/);
assert.ok(Array.isArray(workbenchUpdateDeck.details.validation.summary));

const workbenchAfterDeckUpdate = await deckWorkbenchGet!.execute("wb-get-after-deck-update", { workbenchId });
assert.equal(workbenchAfterDeckUpdate.isError, undefined);
assert.equal(workbenchAfterDeckUpdate.details.draftSummary.title, "Updated Deck Title");
assert.equal(workbenchAfterDeckUpdate.details.draftSummary.subtitle, "Updated Subtitle");
assert.equal(workbenchAfterDeckUpdate.details.draftSummary.audience, "Exec Team");
assert.notEqual(workbenchAfterDeckUpdate.details.updatedAt, updatedAtBeforeUpdate);

const workbenchUpdateByIndex = await deckWorkbenchUpdate!.execute("wb-update-slide-index", {
	workbenchId,
	slides: [{ slideIndex: 1, title: "  Slide One Updated  ", keyMessage: "  Key Update  ", bullets: ["  A  ", "B"], speakerNotes: "  Notes updated  " }],
});
assert.equal(workbenchUpdateByIndex.isError, undefined);
assert.equal(workbenchUpdateByIndex.details.changed.slideCount, 1);
assert.match(workbenchUpdateByIndex.content[0].text, /slide 1: title,keyMessage,bullets,speakerNotes/);

const workbenchAfterIndexUpdate = await deckWorkbenchGet!.execute("wb-get-after-index-update", { workbenchId });
assert.equal(workbenchAfterIndexUpdate.isError, undefined);
assert.equal(workbenchAfterIndexUpdate.details.draftSummary.slidesPreview[0].title, "Slide One Updated");
assert.equal(workbenchAfterIndexUpdate.details.draftSummary.slidesPreview[0].keyMessageExcerpt, "Key Update");
assert.equal(workbenchAfterIndexUpdate.details.draftSummary.slidesPreview[0].bulletCount, 2);
assert.equal(workbenchAfterIndexUpdate.details.draftSummary.slidesPreview[0].hasSpeakerNotes, true);

const workbenchUpdateById = await deckWorkbenchUpdate!.execute("wb-update-slide-id", {
	workbenchId,
	slides: [{ slideId: "scratch-slide-1", visualIdea: "  Two column visual  ", speakerNotes: "" }],
});
assert.equal(workbenchUpdateById.isError, undefined);
assert.equal(workbenchUpdateById.details.changed.slideCount, 1);
assert.match(workbenchUpdateById.content[0].text, /slide 1: speakerNotes,visualIdea|slide 1: visualIdea,speakerNotes/);

const workbenchValidateAfterUpdate = await deckWorkbenchValidate!.execute("wb-validate-after-update", { workbenchId });
assert.equal(workbenchValidateAfterUpdate.isError, undefined);
assert.equal(workbenchValidateAfterUpdate.details.workbenchId, workbenchId);
assert.ok(Array.isArray(workbenchValidateAfterUpdate.details.summary));

const workbenchSuggestionSeed = await deckWorkbenchUpdate!.execute("wb-suggestion-seed", {
	workbenchId,
	title: "Internal Product Review",
	audience: "Executive leadership",
	slides: [
		{ slideIndex: 1, title: "Overview", keyMessage: "" },
		// A content slide with an empty key message yields a suggestion-needed repair target.
		{ slideIndex: 2, title: "Detail", keyMessage: "", bullets: ["A", "B"] },
	],
});
assert.equal(workbenchSuggestionSeed.isError, undefined);
const workbenchValidateSuggestions = await deckWorkbenchValidate!.execute("wb-validate-suggestions", { workbenchId });
assert.equal(workbenchValidateSuggestions.isError, undefined);
assert.ok(workbenchValidateSuggestions.details.repairTargets.some((t: any) => t.category === "suggestion-needed"));

const workbenchAssistTitle = await deckWorkbenchAssistContext!.execute("wb-assist-title", {
	workbenchId,
	slideIndex: 1,
	field: "title",
	assistAction: "critique_slide",
});
assert.equal(workbenchAssistTitle.isError, undefined);
assert.equal(workbenchAssistTitle.details.workbenchId, workbenchId);
assert.equal(workbenchAssistTitle.details.affectedScope.slideIndex, 1);
assert.equal(workbenchAssistTitle.details.affectedScope.field, "title");
assert.equal(workbenchAssistTitle.details.noMutation, true);
assert.equal(typeof workbenchAssistTitle.details.selectedContent, "string");
assert.ok(String(workbenchAssistTitle.details.selectedContent).length <= 220);
assert.equal(workbenchAssistTitle.details.slideContext.title, "Overview");
assert.equal(workbenchAssistTitle.details.deckContext.title, "Internal Product Review");
assert.equal(Array.isArray(workbenchAssistTitle.details.constraints), true);
assert.equal((workbenchAssistTitle.details as any).slides, undefined);
assert.match(workbenchAssistTitle.details.caveat, /no writes, no approvals, no model calls/i);
const workbenchAssistTitleAgain = await deckWorkbenchAssistContext!.execute("wb-assist-title-again", {
	workbenchId,
	slideIndex: 1,
	field: "title",
	assistAction: "critique_slide",
});
assert.equal(workbenchAssistTitleAgain.isError, undefined);
assert.equal(JSON.stringify(workbenchAssistTitleAgain.details), JSON.stringify(workbenchAssistTitle.details));

const workbenchBeforeAssist = await deckWorkbenchGet!.execute("wb-get-before-assist", { workbenchId });
assert.equal(workbenchBeforeAssist.isError, undefined);
const assistUpdatedAtBefore = workbenchBeforeAssist.details.updatedAt;
const assistDraftBefore = JSON.stringify(workbenchBeforeAssist.details.draftSummary);

const suggestionTarget = workbenchValidateSuggestions.details.repairTargets.find((t: any) => t.category === "suggestion-needed");
assert.ok(suggestionTarget);
const workbenchAssistRepairTarget = await deckWorkbenchAssistContext!.execute("wb-assist-repair-target", {
	workbenchId,
	slideIndex: suggestionTarget.slideIndex ?? 1,
	field: suggestionTarget.field === "title" ? "title" : "keyMessage",
	assistAction: "suggest_repair_target",
	repairTargetId: suggestionTarget.id,
});
assert.equal(workbenchAssistRepairTarget.isError, undefined);
assert.equal(workbenchAssistRepairTarget.details.validationContextUsed.repairTargetId, suggestionTarget.id);
assert.equal(workbenchAssistRepairTarget.details.noMutation, true);

const workbenchAfterAssist = await deckWorkbenchGet!.execute("wb-get-after-assist", { workbenchId });
assert.equal(workbenchAfterAssist.isError, undefined);
assert.equal(workbenchAfterAssist.details.updatedAt, assistUpdatedAtBefore);
assert.equal(JSON.stringify(workbenchAfterAssist.details.draftSummary), assistDraftBefore);

const workbenchAssistInvalidSlide = await deckWorkbenchAssistContext!.execute("wb-assist-invalid-slide", {
	workbenchId,
	slideIndex: 99,
	field: "title",
	assistAction: "critique_slide",
});
assert.equal(workbenchAssistInvalidSlide.isError, true);
assert.equal(workbenchAssistInvalidSlide.details.error.code, "assist_scope_not_found");

const workbenchAssistAmbiguousScope = await deckWorkbenchAssistContext!.execute("wb-assist-ambiguous", {
	workbenchId,
	slideId: "scratch-slide-1",
	slideIndex: 1,
	field: "title",
	assistAction: "critique_slide",
});
assert.equal(workbenchAssistAmbiguousScope.isError, true);
assert.equal(workbenchAssistAmbiguousScope.details.error.code, "assist_scope_invalid");

const workbenchAssistMissingScope = await deckWorkbenchAssistContext!.execute("wb-assist-missing-scope", {
	workbenchId,
	field: "title",
	assistAction: "critique_slide",
});
assert.equal(workbenchAssistMissingScope.isError, true);
assert.equal(workbenchAssistMissingScope.details.error.code, "assist_scope_invalid");

const workbenchAssistMissingRepairTarget = await deckWorkbenchAssistContext!.execute("wb-assist-missing-repair-target", {
	workbenchId,
	slideIndex: 1,
	field: "title",
	assistAction: "suggest_repair_target",
});
assert.equal(workbenchAssistMissingRepairTarget.isError, true);
assert.equal(workbenchAssistMissingRepairTarget.details.error.code, "assist_repair_target_required");

const workbenchAssistInvalidRepairTarget = await deckWorkbenchAssistContext!.execute("wb-assist-invalid-repair-target", {
	workbenchId,
	slideIndex: 1,
	field: "title",
	assistAction: "suggest_repair_target",
	repairTargetId: "missing-target",
});
assert.equal(workbenchAssistInvalidRepairTarget.isError, true);
assert.equal(workbenchAssistInvalidRepairTarget.details.error.code, "assist_repair_target_invalid");

const workbenchRepairSeed = await deckWorkbenchUpdate!.execute("wb-repair-seed", {
	workbenchId,
	slides: [{ slideIndex: 1, bullets: ["  Same   bullet  ", "same bullet.", "", "   Keep me   ", "   "] }],
});
assert.equal(workbenchRepairSeed.isError, undefined);

const workbenchValidateMessyBullets = await deckWorkbenchValidate!.execute("wb-validate-messy-bullets", { workbenchId });
assert.equal(workbenchValidateMessyBullets.isError, undefined);
const deterministicTargets = workbenchValidateMessyBullets.details.repairTargets.filter((t: any) => t.category === "deterministic-fixable");
assert.ok(deterministicTargets.some((t: any) => t.deterministicAction?.type === "trim_whitespace"));
assert.ok(deterministicTargets.some((t: any) => t.deterministicAction?.type === "dedupe_same_slide_bullets"));

const workbenchBeforeRepairPreview = await deckWorkbenchGet!.execute("wb-get-before-repair-preview", { workbenchId });
assert.equal(workbenchBeforeRepairPreview.isError, undefined);
const repairPreviewUpdatedAtBefore = workbenchBeforeRepairPreview.details.updatedAt;
const repairPreviewStateBefore = JSON.stringify(workbenchBeforeRepairPreview.details.draftSummary);
const localStateBeforeRepairPreview = snapshotLocalState();
const confirmCountBeforeRepairPreview = confirmDetails.length;
const repairPreview = await deckWorkbenchRepair!.execute("wb-repair-preview", { workbenchId });
assert.equal(repairPreview.isError, undefined);
assert.equal(repairPreview.details.apply, false);
assert.equal(Array.isArray(repairPreview.details.proposedChanges), true);
assert.equal(repairPreview.details.proposedChanges.length, 1);
assert.equal(repairPreview.details.proposedChanges[0].actions.removedDuplicates >= 1, true);
assert.equal(repairPreview.details.proposedChanges[0].actions.trimmedWhitespace >= 1, true);
assert.equal(Array.isArray(repairPreview.details.skippedIssues), true);
assert.match(repairPreview.content[0].text, /preview only/);
assert.equal(confirmDetails.length, confirmCountBeforeRepairPreview);
assert.deepEqual(snapshotLocalState(), localStateBeforeRepairPreview);
const workbenchAfterRepairPreview = await deckWorkbenchGet!.execute("wb-get-after-repair-preview", { workbenchId });
assert.equal(workbenchAfterRepairPreview.isError, undefined);
assert.equal(workbenchAfterRepairPreview.details.updatedAt, repairPreviewUpdatedAtBefore);
assert.equal(JSON.stringify(workbenchAfterRepairPreview.details.draftSummary), repairPreviewStateBefore);

const helperRepairPreviewBefore = await deckWorkbenchGet!.execute("wb-get-before-helper-repair-preview", { workbenchId });
assert.equal(helperRepairPreviewBefore.isError, undefined);
const helperPreview = repairDeckWorkbenchForUi({ workbenchId, selectedSlideIndex: 1 });
assert.equal(helperPreview.apply, false);
assert.equal(helperPreview.proposedChanges.length, 1);
const helperRepairPreviewAfter = await deckWorkbenchGet!.execute("wb-get-after-helper-repair-preview", { workbenchId });
assert.equal(helperRepairPreviewAfter.isError, undefined);
assert.equal(helperRepairPreviewAfter.details.updatedAt, helperRepairPreviewBefore.details.updatedAt);
assert.equal(JSON.stringify(helperRepairPreviewAfter.details.draftSummary), JSON.stringify(helperRepairPreviewBefore.details.draftSummary));

const repairApply = await deckWorkbenchRepair!.execute("wb-repair-apply", { workbenchId, apply: true });
assert.equal(repairApply.isError, undefined);
assert.equal(repairApply.details.apply, true);
assert.equal(Array.isArray(repairApply.details.appliedChanges), true);
assert.equal(repairApply.details.appliedChanges.length, 1);
assert.equal(repairApply.details.postValidation.ready, true);
assert.match(repairApply.content[0].text, /transient in-memory only/);
const workbenchAfterRepairApply = await deckWorkbenchGet!.execute("wb-get-after-repair-apply", { workbenchId });
assert.equal(workbenchAfterRepairApply.isError, undefined);
assert.deepEqual(workbenchAfterRepairApply.details.draftSummary.slidesPreview[0].bulletCount, 2);
assert.equal(workbenchAfterRepairApply.details.draftSummary.slidesPreview[0].title, "Overview");

const helperApplyNoop = repairDeckWorkbenchForUi({ workbenchId, apply: true, selectedSlideIndex: 1 });
assert.equal(helperApplyNoop.apply, true);
assert.equal(helperApplyNoop.appliedChanges.length, 0);
assert.equal(Array.isArray(helperApplyNoop.skippedIssues), true);
assert.ok(helperApplyNoop.skippedIssues.every((issue: any) => issue.code !== "slide_duplicate_bullet"));

const repairApplyNoop = await deckWorkbenchRepair!.execute("wb-repair-apply-noop", { workbenchId, apply: true });
assert.equal(repairApplyNoop.isError, undefined);
assert.equal(Array.isArray(repairApplyNoop.details.appliedChanges), true);
assert.equal(repairApplyNoop.details.appliedChanges.length, 0);

const workbenchGetBeforePreviewHtml = await deckWorkbenchGet!.execute("wb-get-before-preview-html", { workbenchId });
assert.equal(workbenchGetBeforePreviewHtml.isError, undefined);
const updatedAtBeforePreviewHtml = workbenchGetBeforePreviewHtml.details.updatedAt;
const localStateBeforePreviewHtml = snapshotLocalState();
const confirmCountBeforePreviewHtml = confirmDetails.length;
const previewHtmlResult = await deckWorkbenchPreviewHtml!.execute("wb-preview-html", { workbenchId, footer: "Preview Footer" });
assert.equal(previewHtmlResult.isError, undefined);
assert.equal(previewHtmlResult.details.workbenchId, workbenchId);
assert.equal(previewHtmlResult.details.ready, true);
assert.equal(Array.isArray(previewHtmlResult.details.renderedValidation.errors), true);
assert.equal(previewHtmlResult.details.renderedValidation.errors.length, 0);
assert.equal(typeof previewHtmlResult.details.htmlPreview, "string");
assert.match(previewHtmlResult.details.htmlPreview, /<!doctype html>/i);
assert.match(previewHtmlResult.details.htmlPreview, /<section class="slide layout-/);
assert.ok(previewHtmlResult.details.htmlPreview.length <= 16000);
assert.match(previewHtmlResult.content[0].text, /HTML preview only; no file write and no PPTX output\/export performed\./);
const standardPreviewFromHelper = previewDeckWorkbenchHtmlForUi({ workbenchId, footer: "Preview Footer" });
assert.equal(standardPreviewFromHelper.ready, true);
assert.match(standardPreviewFromHelper.htmlPreview, /<section class="slide layout-/);
const referencePreviewFromHelper = previewDeckWorkbenchReferenceHtmlForUi({ workbenchId, footer: "Reference Footer" });
assert.equal(referencePreviewFromHelper.ready, true);
assert.equal(referencePreviewFromHelper.htmlPreviewTruncated, false);
assert.match(referencePreviewFromHelper.htmlPreview, /Approximate reference-style preview only/i);
assert.equal((referencePreviewFromHelper.htmlPreview.match(/<section class="slide"/g) || []).length, referencePreviewFromHelper.slideCount);
assert.match(referencePreviewFromHelper.htmlPreview, /border-bottom: 2px solid #FFFFFF/i);
assert.doesNotMatch(referencePreviewFromHelper.htmlPreview, /#FF6600|#ff6600/);
assert.doesNotMatch(referencePreviewFromHelper.htmlPreview, /<script\b/i);
assert.doesNotMatch(referencePreviewFromHelper.htmlPreview, /\bsrc\s*=/i);
assert.doesNotMatch(referencePreviewFromHelper.htmlPreview, /\bhref\s*=/i);
assert.doesNotMatch(referencePreviewFromHelper.htmlPreview, /\burl\s*\(/i);
assert.doesNotMatch(referencePreviewFromHelper.htmlPreview, /\bfile\s*:/i);
assert.doesNotMatch(referencePreviewFromHelper.htmlPreview, /\bdata\s*:/i);
assert.doesNotMatch(referencePreviewFromHelper.htmlPreview, /https?:\/\//i);
assert.doesNotMatch(referencePreviewFromHelper.htmlPreview, /@import/i);
assert.equal(confirmDetails.length, confirmCountBeforePreviewHtml);
const localStateAfterPreviewHtml = snapshotLocalState();
assert.deepEqual(localStateAfterPreviewHtml, localStateBeforePreviewHtml);
const workbenchGetAfterPreviewHtml = await deckWorkbenchGet!.execute("wb-get-after-preview-html", { workbenchId });
assert.equal(workbenchGetAfterPreviewHtml.isError, undefined);
assert.equal(workbenchGetAfterPreviewHtml.details.updatedAt, updatedAtBeforePreviewHtml);

const htmlWriteWorkbench = await createDeckWorkbenchFromApprovedPptx({ filename: "sample.pptx", folder: "refs" });
const htmlWriteWorkbenchId = htmlWriteWorkbench.workbenchId;
const htmlWriteWorkbenchBefore = await deckWorkbenchGet!.execute("wb-get-before-write-html", { workbenchId: htmlWriteWorkbenchId });
assert.equal(htmlWriteWorkbenchBefore.isError, undefined);
const htmlWriteUpdatedAtBefore = htmlWriteWorkbenchBefore.details.updatedAt;
const htmlWriteSummaryBefore = JSON.stringify(htmlWriteWorkbenchBefore.details.draftSummary);
const confirmCountBeforeWriteHtml = confirmDetails.length;
const writeHtmlFromWorkbench = await deckWorkbenchWriteHtml!.execute("wb-write-html", {
	workbenchId: htmlWriteWorkbenchId,
	filename: "decks/workbench-save.html",
	reason: "workbench html save test",
	footer: "Workbench Footer",
}, undefined, undefined, approvalTrue);
assert.equal(writeHtmlFromWorkbench.isError, undefined);
assert.equal(writeHtmlFromWorkbench.details.saved, true);
assert.equal(writeHtmlFromWorkbench.details.workbenchId, htmlWriteWorkbenchId);
assert.equal(writeHtmlFromWorkbench.details.destination, "default");
assert.equal(writeHtmlFromWorkbench.details.relativePath, "decks/workbench-save.html");
assert.equal(writeHtmlFromWorkbench.details.replaced, false);
assert.ok(Array.isArray(writeHtmlFromWorkbench.details.warnings));
assert.match(writeHtmlFromWorkbench.details.caveat, /HTML only/);
assert.match(confirmDetails.at(-1) ?? "", /Workbench: /);
assert.equal(confirmDetails.length, confirmCountBeforeWriteHtml + 1);
const savedWorkbenchHtmlPath = path.join(tempHome, ".exxperts", "app", "artifacts", "decks", "workbench-save.html");
assert.equal(fs.existsSync(savedWorkbenchHtmlPath), true);
const savedWorkbenchHtml = fs.readFileSync(savedWorkbenchHtmlPath, "utf-8");
assert.equal((savedWorkbenchHtml.match(/<section class="slide layout-/g) || []).length, writeHtmlFromWorkbench.details.slides);
assert.doesNotMatch(writeHtmlFromWorkbench.content[0].text, /PPTX output|PPTX export/i);
const htmlWriteWorkbenchAfter = await deckWorkbenchGet!.execute("wb-get-after-write-html", { workbenchId: htmlWriteWorkbenchId });
assert.equal(htmlWriteWorkbenchAfter.isError, undefined);
assert.equal(htmlWriteWorkbenchAfter.details.updatedAt, htmlWriteUpdatedAtBefore);
assert.equal(JSON.stringify(htmlWriteWorkbenchAfter.details.draftSummary), htmlWriteSummaryBefore);

const declinedWorkbenchPath = path.join(tempHome, ".exxperts", "app", "artifacts", "decks", "workbench-declined.html");
const declinedWorkbenchWrite = await deckWorkbenchWriteHtml!.execute("wb-write-html-declined", {
	workbenchId: htmlWriteWorkbenchId,
	filename: "decks/workbench-declined.html",
}, undefined, undefined, approvalFalse);
assert.equal(declinedWorkbenchWrite.details.saved, false);
assert.equal(fs.existsSync(declinedWorkbenchPath), false);

const localStateAfterWorkbench = snapshotLocalState();
assert.deepEqual(localStateAfterWorkbench.filter((p) => p !== "artifacts/decks/workbench-save.html"), localStateBeforeWorkbench);
assert.equal(confirmDetails.length, confirmCountBeforeWorkbench + 1);

// Attaching a non-.pptx or a missing file as a format reference is rejected.
const rejectAttachNonPptx = await deckWorkbenchAttachFormatReference!.execute("wb-attach-bad-ext", {
	workbenchId,
	filename: "demo.html",
	folder: "decks",
});
assert.equal(rejectAttachNonPptx.isError, true);

const rejectAttachMissing = await deckWorkbenchAttachFormatReference!.execute("wb-attach-missing", {
	workbenchId,
	filename: "missing.pptx",
	folder: "refs",
});
assert.equal(rejectAttachMissing.isError, true);

const rejectWorkbenchGetMissing = await deckWorkbenchGet!.execute("wb-get-missing", { workbenchId: "wb_missing" });
assert.equal(rejectWorkbenchGetMissing.isError, true);
const rejectWorkbenchValidateMissing = await deckWorkbenchValidate!.execute("wb-validate-missing", { workbenchId: "wb_missing" });
assert.equal(rejectWorkbenchValidateMissing.isError, true);
const rejectWorkbenchRepairMissing = await deckWorkbenchRepair!.execute("wb-repair-missing", { workbenchId: "wb_missing" });
assert.equal(rejectWorkbenchRepairMissing.isError, true);
const rejectWorkbenchPreviewHtmlMissing = await deckWorkbenchPreviewHtml!.execute("wb-preview-html-missing", { workbenchId: "wb_missing" });
assert.equal(rejectWorkbenchPreviewHtmlMissing.isError, true);
const rejectWorkbenchAssistMissing = await deckWorkbenchAssistContext!.execute("wb-assist-missing", {
	workbenchId: "wb_missing",
	slideIndex: 1,
	field: "title",
	assistAction: "critique_slide",
});
assert.equal(rejectWorkbenchAssistMissing.isError, true);
assert.equal(rejectWorkbenchAssistMissing.details.error.code, "Deck workbench not found");
const rejectWorkbenchUpdateMissingId = await deckWorkbenchUpdate!.execute("wb-update-missing-id", { title: "X" });
assert.equal(rejectWorkbenchUpdateMissingId.isError, true);
const rejectWorkbenchUpdateMissing = await deckWorkbenchUpdate!.execute("wb-update-missing", { workbenchId: "wb_missing", title: "X" });
assert.equal(rejectWorkbenchUpdateMissing.isError, true);
const workbenchBeforeMixedFailure = await deckWorkbenchGet!.execute("wb-get-before-mixed-failure", { workbenchId });
assert.equal(workbenchBeforeMixedFailure.isError, undefined);
const previousStableTitle = workbenchBeforeMixedFailure.details.draftSummary.title;
const previousStableAudience = workbenchBeforeMixedFailure.details.draftSummary.audience;
const previousStableSlideTitle = workbenchBeforeMixedFailure.details.draftSummary.slidesPreview[0].title;

const rejectWorkbenchUpdateMixed = await deckWorkbenchUpdate!.execute("wb-update-mixed-failure", {
	workbenchId,
	title: "Should Not Commit",
	slides: [{ slideIndex: 999, title: "Nope" }],
});
assert.equal(rejectWorkbenchUpdateMixed.isError, true);

const workbenchAfterMixedFailure = await deckWorkbenchGet!.execute("wb-get-after-mixed-failure", { workbenchId });
assert.equal(workbenchAfterMixedFailure.isError, undefined);
assert.equal(workbenchAfterMixedFailure.details.draftSummary.title, previousStableTitle);
assert.equal(workbenchAfterMixedFailure.details.draftSummary.audience, previousStableAudience);
assert.equal(workbenchAfterMixedFailure.details.draftSummary.slidesPreview[0].title, previousStableSlideTitle);

const rejectWorkbenchUpdateUnresolvedSlide = await deckWorkbenchUpdate!.execute("wb-update-unresolved-slide", { workbenchId, slides: [{ slideIndex: 99, title: "Nope" }] });
assert.equal(rejectWorkbenchUpdateUnresolvedSlide.isError, true);
const rejectWorkbenchUpdateEmptyDeckTitle = await deckWorkbenchUpdate!.execute("wb-update-empty-title", { workbenchId, title: "   " });
assert.equal(rejectWorkbenchUpdateEmptyDeckTitle.isError, true);

const slideTitleBeforeEmptyTitleFailure = workbenchAfterMixedFailure.details.draftSummary.slidesPreview[0].title;
const rejectWorkbenchUpdateEmptySlideTitle = await deckWorkbenchUpdate!.execute("wb-update-empty-slide-title", {
	workbenchId,
	slides: [{ slideIndex: 1, title: "" }],
});
assert.equal(rejectWorkbenchUpdateEmptySlideTitle.isError, true);
const workbenchAfterEmptySlideTitleFailure = await deckWorkbenchGet!.execute("wb-get-after-empty-slide-title-failure", { workbenchId });
assert.equal(workbenchAfterEmptySlideTitleFailure.isError, undefined);
assert.equal(workbenchAfterEmptySlideTitleFailure.details.draftSummary.slidesPreview[0].title, slideTitleBeforeEmptyTitleFailure);

function snapshotLocalState() {
	const base = path.join(tempHome, ".exxperts", "app");
	const out: string[] = [];
	const visit = (dir: string) => {
		if (!fs.existsSync(dir)) return;
		const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) visit(full);
			else out.push(path.relative(base, full).split(path.sep).join("/"));
		}
	};
	visit(base);
	return out;
}


const structurallyInvalidReport = validateDeckSpecDraftForWorkbench({
	version: "1.0",
	artifactType: "deck",
	title: "Broken",
	design: { source: "reference_pptx" },
	slides: [
		{ id: "dup", type: "title", title: "A" },
		{ id: "dup", type: "content", title: "B", keyMessage: "B" },
	],
});
assert.equal(structurallyInvalidReport.ready, false);
assert.ok(structurallyInvalidReport.errors.some((e: any) => e.code === "slide_id_duplicate"));

const rejectNonPptx = await inspectPptx!.execute("inspect-bad-ext", { filename: "demo.html", folder: "decks" });
assert.equal(rejectNonPptx.isError, true);
const rejectTraversalPptx = await inspectPptx!.execute("inspect-traversal", { filename: "../sample.pptx", folder: "refs" });
assert.equal(rejectTraversalPptx.isError, true);
const rejectUnapprovedDestinationPptx = await inspectPptx!.execute("inspect-unapproved", { destination: "documents", filename: "sample.pptx", folder: "refs" });
assert.equal(rejectUnapprovedDestinationPptx.isError, true);

const declined = await deck!.execute("4", { ...validPayload, filename: "decks/declined.html" }, undefined, undefined, approvalFalse);
assert.equal(declined.details.saved, false);
assert.equal(fs.existsSync(path.join(tempHome, ".exxperts", "app", "artifacts", "decks", "declined.html")), false);

const noUiResult = await deck!.execute("5", { ...validPayload, filename: "decks/no-ui.html" }, undefined, undefined, noUi);
assert.equal(noUiResult.details.saved, false);
assert.equal(noUiResult.isError, true);
assert.equal(fs.existsSync(path.join(tempHome, ".exxperts", "app", "artifacts", "decks", "no-ui.html")), false);

for (const filename of ["/tmp/bad.html", "../bad.html", "decks/../bad.html", "deck.md", "bad name.html", "bad<script>.html"]) {
	const result = await deck!.execute("bad", { ...validPayload, filename }, undefined, undefined, approvalTrue);
	assert.equal(result.details.saved, false, `${filename} should be rejected`);
	assert.equal(result.isError, true, `${filename} should be an error`);
}

const desktop = path.join(tempHome, "Desktop");
fs.mkdirSync(desktop);
const connectResult = await connect!.execute("connect", { name: "desktop", path: "~/Desktop", reason: "test output root" }, undefined, undefined, approvalTrue);
assert.equal(connectResult.details.saved, true);
assert.equal(connectResult.details.destination, "desktop");
assert.ok(fs.existsSync(path.join(tempHome, ".exxperts", "app", "artifact-destinations.json")));

const configuredWrite = await write!.execute("write", {
	destination: "desktop",
	folder: "client-demo",
	filename: "brief.md",
	content: "# Brief\n\nConfigured destination write.",
	reason: "test configured destination",
}, undefined, undefined, approvalTrue);
assert.equal(configuredWrite.details.saved, true);
assert.equal(configuredWrite.details.path, path.join(desktop, "client-demo", "brief.md"));
assert.equal(fs.readFileSync(path.join(desktop, "client-demo", "brief.md"), "utf-8"), "# Brief\n\nConfigured destination write.\n");
assert.match(confirmDetails.at(-1) ?? "", /Destination: desktop/);
assert.match(confirmDetails.at(-1) ?? "", /Path: .*Desktop[/\\]client-demo[/\\]brief\.md/);

const safeHtmlWrite = await write!.execute("safe-html", {
	destination: "desktop",
	folder: "client-demo",
	filename: "safe.html",
	content: "<!doctype html><html><body><main><h1>Safe</h1><p>Self-contained deck.</p></main></body></html>",
	reason: "safe html test",
}, undefined, undefined, approvalTrue);
assert.equal(safeHtmlWrite.details.saved, true);
assert.equal(fs.existsSync(path.join(desktop, "client-demo", "safe.html")), true);

const confirmCountBeforeBlockedHtml = confirmDetails.length;
const blockedScriptHtmlWrite = await write!.execute("blocked-script-html", {
	destination: "desktop",
	folder: "client-demo",
	filename: "blocked-script.html",
	content: "<!doctype html><html><body><script>alert('x')</script></body></html>",
	reason: "blocked script html test",
}, undefined, undefined, approvalTrue);
assert.equal(blockedScriptHtmlWrite.details.saved, false);
assert.equal(blockedScriptHtmlWrite.isError, true);
assert.match(blockedScriptHtmlWrite.content[0].text, /Unsafe HTML is blocked/);
assert.equal(confirmDetails.length, confirmCountBeforeBlockedHtml);
assert.equal(fs.existsSync(path.join(desktop, "client-demo", "blocked-script.html")), false);

const confirmCountBeforeBlockedExternal = confirmDetails.length;
const blockedExternalHtmlWrite = await write!.execute("blocked-external-html", {
	destination: "desktop",
	folder: "client-demo",
	filename: "blocked-external.html",
	content: "<!doctype html><html><head><style>@import 'x.css';</style></head><body><a href=\"https://example.com\">x</a></body></html>",
	reason: "blocked external html test",
}, undefined, undefined, approvalTrue);
assert.equal(blockedExternalHtmlWrite.details.saved, false);
assert.equal(blockedExternalHtmlWrite.isError, true);
assert.match(blockedExternalHtmlWrite.content[0].text, /Unsafe HTML is blocked/);
assert.equal(confirmDetails.length, confirmCountBeforeBlockedExternal);
assert.equal(fs.existsSync(path.join(desktop, "client-demo", "blocked-external.html")), false);

const markdownWithUrlWrite = await write!.execute("markdown-with-url", {
	destination: "desktop",
	folder: "client-demo",
	filename: "with-url.md",
	content: "# Notes\n\nReference: https://example.com",
	reason: "markdown url still allowed",
}, undefined, undefined, approvalTrue);
assert.equal(markdownWithUrlWrite.details.saved, true);
assert.equal(fs.existsSync(path.join(desktop, "client-demo", "with-url.md")), true);

const unsafeTraversal = await write!.execute("unsafe", {
	destination: "desktop",
	folder: "../escape",
	filename: "bad.md",
	content: "bad",
}, undefined, undefined, approvalTrue);
assert.equal(unsafeTraversal.details.saved, false);
assert.equal(unsafeTraversal.isError, true);
assert.equal(fs.existsSync(path.join(tempHome, "escape", "bad.md")), false);

const unapprovedDestination = await write!.execute("unapproved", {
	destination: "documents",
	filename: "bad.md",
	content: "bad",
}, undefined, undefined, approvalTrue);
assert.equal(unapprovedDestination.details.saved, false);
assert.equal(unapprovedDestination.isError, true);

const disconnectResult = await disconnect!.execute("disconnect", { name: "desktop" }, undefined, undefined, approvalTrue);
assert.equal(disconnectResult.details.saved, true);
const afterDisconnect = await write!.execute("after-disconnect", {
	destination: "desktop",
	filename: "bad.md",
	content: "bad",
}, undefined, undefined, approvalTrue);
assert.equal(afterDisconnect.details.saved, false);
assert.equal(afterDisconnect.isError, true);

// HTML reference-style visual render loop (Playwright/Chromium optional).
const htmlAvail = await htmlRenderAvailability();
assert.equal(typeof htmlAvail.available, "boolean");
assert.equal(typeof htmlAvail.playwright, "boolean");
assert.equal(typeof htmlAvail.browser, "boolean");
assert.ok(Array.isArray(htmlAvail.missing));
assert.ok(/playwright/i.test(htmlAvail.installHint));
const twoSlideHtml = '<!doctype html><html><head><style>.slide{width:1280px;height:720px;background:#0c0d10;color:#fff;font-family:Arial;box-sizing:border-box;padding:80px}</style></head><body><section class="slide"><h1>One</h1></section><section class="slide"><h1>Two</h1></section></body></html>';
if (htmlAvail.available) {
	const rendered = await renderDeckHtmlToSlideImages(twoSlideHtml, { maxSlides: 5 });
	assert.equal(rendered.rendererUsed, "playwright-chromium");
	assert.equal(rendered.images.length, 2);
	for (const img of rendered.images) {
		assert.ok(img.bytes > 0);
		// PNG magic bytes confirm we got a real raster, not an error placeholder.
		assert.equal(Buffer.from(img.pngBase64, "base64").subarray(0, 4).toString("hex"), "89504e47");
	}
} else {
	// Without a local browser the render must fail loudly rather than silently degrade.
	await assert.rejects(() => renderDeckHtmlToSlideImages(twoSlideHtml));
}

// --- Slice 5: model-authored (no-reference) HTML deck path + render loop ---
const authoredWb = createBlankDeckWorkbench({ title: "Authored deck", slideCount: 2, structurePreset: "minimal" });
const authoredSlideCount = getDeckWorkbenchUiSnapshot(authoredWb.workbenchId).slideCount;
for (let i = 1; i <= authoredSlideCount; i++) {
	updateDeckWorkbenchSelectedSlide({ workbenchId: authoredWb.workbenchId, slideIndex: i, title: `Slide ${i}`, keyMessage: `Key message ${i}`, bullets: [`Point ${i}a`, `Point ${i}b`] });
}
const authoredSections = Array.from({ length: authoredSlideCount }, (_n, i) => `<section class="slide"><h1>Slide ${i + 1}</h1><p>Key message ${i + 1}</p></section>`).join("");
const authoredHtml = `<!doctype html><html><head><style>html,body,.slide,h1,p{font-family:Arial,Helvetica,sans-serif}.slide{width:1280px;height:720px;background:#0c0d10;color:#fff;box-sizing:border-box;padding:80px}</style></head><body>${authoredSections}</body></html>`;

// preview accepts valid self-contained deck HTML with NO reference attached.
const authoredPreview = await deckWorkbenchPreviewAuthoredHtml!.execute("wb-authored-preview", { workbenchId: authoredWb.workbenchId, html: authoredHtml });
assert.equal(authoredPreview.isError, undefined, "authored preview accepts safe HTML with no reference");
assert.equal(authoredPreview.details.ready, true);
assert.equal(authoredPreview.details.slideCount, authoredSlideCount);
assert.equal((authoredPreview.details.htmlPreview.match(/<section class="slide"/g) || []).length, authoredSlideCount);
assert.match(authoredPreview.details.caveat, /Model-authored self-contained HTML preview; no file write, no PPTX export/);
assert.match(authoredPreview.content[0].text, /Model-authored HTML preview ready/);

// preview REJECTS unsafe HTML (a <script>).
const authoredScript = await deckWorkbenchPreviewAuthoredHtml!.execute("wb-authored-script", { workbenchId: authoredWb.workbenchId, html: authoredHtml.replace("</body>", "<script>alert(1)</script></body>") });
assert.equal(authoredScript.isError, true, "authored preview rejects <script>");
// preview REJECTS unsafe HTML (an external url()).
const authoredUrl = await deckWorkbenchPreviewAuthoredHtml!.execute("wb-authored-url", { workbenchId: authoredWb.workbenchId, html: authoredHtml.replace("background:#0c0d10", "background:url(http://example.com/a.png)") });
assert.equal(authoredUrl.isError, true, "authored preview rejects external url()");
// preview REJECTS inline event handlers (e.g. onclick=).
const authoredHandler = await deckWorkbenchPreviewAuthoredHtml!.execute("wb-authored-handler", { workbenchId: authoredWb.workbenchId, html: authoredHtml.replace('class="slide"', 'class="slide" onclick="alert(1)"') });
assert.equal(authoredHandler.isError, true, "authored preview rejects inline event handlers");
assert.match(authoredHandler.content[0].text, /inline event handler/);

// preview ACCEPTS same-document fragment navigation links (href="#slide-N") that point at real ids.
const authoredNavSections = Array.from({ length: authoredSlideCount }, (_n, i) =>
	`<section class="slide" id="slide-${i + 1}"><nav><a href="#slide-${((i + 1) % authoredSlideCount) + 1}">Next</a></nav><h1>Slide ${i + 1}</h1><p>Key message ${i + 1}</p></section>`).join("");
const authoredNavHtml = `<!doctype html><html><head><style>html,body,.slide,h1,p{font-family:Arial,Helvetica,sans-serif}.slide{width:1280px;height:720px}</style></head><body>${authoredNavSections}</body></html>`;
const authoredNav = await deckWorkbenchPreviewAuthoredHtml!.execute("wb-authored-nav", { workbenchId: authoredWb.workbenchId, html: authoredNavHtml });
assert.equal(authoredNav.isError, undefined, "authored preview accepts same-document fragment nav links to real ids");
assert.equal(authoredNav.details.ready, true);
// preview REJECTS a fragment link with no matching element id (dead nav link).
const authoredDeadFrag = await deckWorkbenchPreviewAuthoredHtml!.execute("wb-authored-dead-frag", { workbenchId: authoredWb.workbenchId, html: authoredNavHtml.replace('href="#slide-2"', 'href="#missing-slide"') });
assert.equal(authoredDeadFrag.isError, true, "authored preview rejects a fragment link to a missing element id");
// preview REJECTS every external/local/actionable href and empty href; only #fragment is allowed.
for (const badHref of ["https://example.com", "http://example.com", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "mailto:a@b.com", "/root/path", "../up", "./rel", "page.html", ""]) {
	const badHtml = authoredNavHtml.replace('href="#slide-2"', `href="${badHref}"`);
	const res = await deckWorkbenchPreviewAuthoredHtml!.execute("wb-authored-bad-href", { workbenchId: authoredWb.workbenchId, html: badHtml });
	assert.equal(res.isError, true, `authored preview rejects non-fragment href ${JSON.stringify(badHref)}`);
}

// render renders when the renderer is available, else returns the graceful install-hint path (no throw).
const authoredRender = await deckWorkbenchRenderAuthoredHtmlImages!.execute("wb-authored-render", { workbenchId: authoredWb.workbenchId, html: authoredHtml });
if (htmlAvail.available) {
	assert.equal(authoredRender.isError, undefined, "authored render succeeds when renderer available");
	assert.equal(authoredRender.details.rendered, true);
	assert.equal(authoredRender.details.slideCount, authoredSlideCount);
	assert.ok(authoredRender.content.some((c: any) => c.type === "image"), "authored render returns PNG image blocks");
	assert.match(authoredRender.content[0].text, /critique/i);
} else {
	assert.equal(authoredRender.isError, true, "authored render reports unavailable gracefully");
	assert.equal(authoredRender.details.rendered, false);
	assert.match(authoredRender.content[0].text, /artifact_write_html_deck/, "unavailable render hints the deterministic fallback");
}

// --- Slice 2: deterministic workbench editing (deck meta + add/delete/reorder slides) ---
assert.equal(typeof updateDeckWorkbenchDeckMeta, "function", "updateDeckWorkbenchDeckMeta exported");
assert.equal(typeof addDeckWorkbenchSlide, "function", "addDeckWorkbenchSlide exported");
assert.equal(typeof deleteDeckWorkbenchSlide, "function", "deleteDeckWorkbenchSlide exported");
assert.equal(typeof reorderDeckWorkbenchSlide, "function", "reorderDeckWorkbenchSlide exported");

// snapshot exposes deckTitle/deckSubtitle
const metaWb = createBlankDeckWorkbench({ title: "Quarterly review", slideCount: 5, structurePreset: "executive" });
const metaSnap0 = getDeckWorkbenchUiSnapshot(metaWb.workbenchId, 1);
assert.equal(metaSnap0.deckTitle, "Quarterly review", "snapshot exposes deckTitle");
assert.equal("deckSubtitle" in metaSnap0, true, "snapshot has deckSubtitle key");

// updateDeckWorkbenchDeckMeta sets title/subtitle; rejects empty title
const metaUpdated = updateDeckWorkbenchDeckMeta({ workbenchId: metaWb.workbenchId, title: "Renamed deck", subtitle: "FY26 board" });
assert.equal(metaUpdated.deckTitle, "Renamed deck", "deck title updated");
assert.equal(metaUpdated.deckSubtitle, "FY26 board", "deck subtitle updated");
const metaSubtitleCleared = updateDeckWorkbenchDeckMeta({ workbenchId: metaWb.workbenchId, title: "Renamed deck", subtitle: "   " });
assert.equal(metaSubtitleCleared.deckSubtitle, undefined, "blank subtitle clears to undefined");
assert.throws(() => updateDeckWorkbenchDeckMeta({ workbenchId: metaWb.workbenchId, title: "  " }), /Deck title is required/);
// deck-meta save preserves the caller's selected slide instead of resetting to slide 1
const metaKeepsSelection = updateDeckWorkbenchDeckMeta({ workbenchId: metaWb.workbenchId, title: "Renamed deck", selectedSlideIndex: 4 });
assert.equal(metaKeepsSelection.selectedSlide.index, 4, "deck-meta update keeps selected slide");

// addDeckWorkbenchSlide increments count and inserts a blank slide
const addWb = createBlankDeckWorkbench({ title: "Add deck", slideCount: 5, structurePreset: "executive" });
const beforeAdd = getDeckWorkbenchUiSnapshot(addWb.workbenchId, 1).slideCount;
const afterAdd = addDeckWorkbenchSlide({ workbenchId: addWb.workbenchId, afterIndex: 2 });
assert.equal(afterAdd.slideCount, beforeAdd + 1, "add increments slide count");
assert.equal(afterAdd.slides[2].title, "New slide", "blank slide inserted after afterIndex");
assert.equal(afterAdd.selectedSlide.index, 3, "selection follows inserted slide");
const addIds = afterAdd.slides.map((s: any) => s.id);
assert.equal(new Set(addIds).size, addIds.length, "inserted slide id is unique");
const appendAdd = addDeckWorkbenchSlide({ workbenchId: addWb.workbenchId });
assert.equal(appendAdd.slides[appendAdd.slideCount - 1].title, "New slide", "omitted afterIndex appends");
// throws at max (15)
const maxWb = createBlankDeckWorkbench({ title: "Max deck", slideCount: 15, structurePreset: "executive" });
assert.equal(getDeckWorkbenchUiSnapshot(maxWb.workbenchId, 1).slideCount, 15);
assert.throws(() => addDeckWorkbenchSlide({ workbenchId: maxWb.workbenchId }), /cannot have more than 15/);

// deleteDeckWorkbenchSlide decrements; selection stays valid; throws at min (3)
const delWb = createBlankDeckWorkbench({ title: "Delete deck", slideCount: 5, structurePreset: "executive" });
const beforeDel = getDeckWorkbenchUiSnapshot(delWb.workbenchId, 1).slideCount;
const afterDel = deleteDeckWorkbenchSlide({ workbenchId: delWb.workbenchId, slideIndex: 5 });
assert.equal(afterDel.slideCount, beforeDel - 1, "delete decrements slide count");
assert.ok(afterDel.selectedSlide.index >= 1 && afterDel.selectedSlide.index <= afterDel.slideCount, "selection clamped to valid index");
deleteDeckWorkbenchSlide({ workbenchId: delWb.workbenchId, slideIndex: 1 });
assert.equal(getDeckWorkbenchUiSnapshot(delWb.workbenchId, 1).slideCount, 3, "down to min");
assert.throws(() => deleteDeckWorkbenchSlide({ workbenchId: delWb.workbenchId, slideIndex: 1 }), /at least 3 slides/);

// reorderDeckWorkbenchSlide moves a slide and preserves ids + content
const reWb = createBlankDeckWorkbench({ title: "Reorder deck", slideCount: 5, structurePreset: "executive" });
const reBefore = getDeckWorkbenchUiSnapshot(reWb.workbenchId, 1);
const movedId = reBefore.slides[0].id;
const movedTitle = reBefore.slides[0].title;
const reAfter = reorderDeckWorkbenchSlide({ workbenchId: reWb.workbenchId, fromIndex: 1, toIndex: 3 });
assert.equal(reAfter.slides[2].id, movedId, "moved slide id preserved at new position");
assert.equal(reAfter.slides[2].title, movedTitle, "moved slide content preserved");
assert.equal(reAfter.selectedSlide.index, 3, "selection follows moved slide");
assert.deepEqual([...reBefore.slides.map((s: any) => s.id)].sort(), [...reAfter.slides.map((s: any) => s.id)].sort(), "no ids lost on reorder");
assert.throws(() => reorderDeckWorkbenchSlide({ workbenchId: reWb.workbenchId, fromIndex: 99, toIndex: 1 }), /fromIndex must be a valid slide index/);

fs.rmSync(tempHome, { recursive: true, force: true });
console.log("artifact tool tests passed");
