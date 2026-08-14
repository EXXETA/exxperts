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
const htmlRenderAvailability = mod.htmlRenderAvailability as () => Promise<{ available: boolean; playwright: boolean; browser: boolean; missing: string[]; installHint: string }>;
const renderDeckHtmlToSlideImages = mod.renderDeckHtmlToSlideImages as (html: string, options?: { maxSlides?: number }) => Promise<{ images: Array<{ slideNumber: number; pngBase64: string; bytes: number }>; rendererUsed: string }>;

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
assert.ok(deck, "artifact_write_html_deck registered");
assert.equal(typeof normaliseDeckSpecV1, "function", "normaliseDeckSpecV1 exported");
assert.equal(typeof renderHtmlDeckFromSpec, "function", "renderHtmlDeckFromSpec exported");
assert.equal(typeof validateDeckSpecV1, "function", "validateDeckSpecV1 exported");
assert.equal(typeof validateRenderedHtmlDeck, "function", "validateRenderedHtmlDeck exported");
assert.ok(write, "artifact_write registered");
assert.ok(list, "artifact_list registered");
assert.ok(read, "artifact_read registered");
assert.ok(destinations, "artifact_destinations registered");
assert.ok(connect, "artifact_connect_destination registered");
assert.ok(disconnect, "artifact_disconnect_destination registered");
assert.ok(inspectReferenceStyle, "artifact_inspect_reference_style registered");
assert.ok(inspectPptx, "artifact_inspect_pptx registered");

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

const filesBeforeInspect = fs.readdirSync(path.dirname(pptxPath));
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
// Inspection is read-only: it must leave the destination byte-for-byte alone.
assert.deepEqual(fs.readdirSync(path.dirname(pptxPath)), filesBeforeInspect);

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

const urlInTextHtmlWrite = await write!.execute("blocked-url-text-html", {
	destination: "desktop",
	folder: "client-demo",
	filename: "blocked-url-text.html",
	content: "<!doctype html><html><body><p>See https://example.com for details.</p></body></html>",
	reason: "url as visible text is still blocked, with an instructive error",
}, undefined, undefined, approvalTrue);
assert.equal(urlInTextHtmlWrite.details.saved, false);
assert.match(urlInTextHtmlWrite.content[0].text, /Unsafe HTML is blocked/);
assert.match(urlInTextHtmlWrite.content[0].text, /even as visible text/);

const safeSvgWrite = await write!.execute("safe-svg", {
	destination: "desktop",
	folder: "client-demo",
	filename: "safe.svg",
	content: [
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">',
		'<defs><linearGradient id="g"><stop offset="0" stop-color="#333"/></linearGradient><circle id="dot" r="4"/></defs>',
		'<rect width="100" height="100" fill="url(#g)"/><use href="#dot" x="50" y="50"/>',
		"<text x=\"10\" y=\"20\">Safe diagram</text></svg>",
	].join("\n"),
	reason: "safe svg with namespace, gradient, and fragment use",
}, undefined, undefined, approvalTrue);
assert.equal(safeSvgWrite.details.saved, true);
assert.equal(fs.existsSync(path.join(desktop, "client-demo", "safe.svg")), true);

const confirmCountBeforeBlockedSvg = confirmDetails.length;
const blockedScriptSvgWrite = await write!.execute("blocked-script-svg", {
	destination: "desktop",
	folder: "client-demo",
	filename: "blocked-script.svg",
	content: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
	reason: "svg script is blocked at write",
}, undefined, undefined, approvalTrue);
assert.equal(blockedScriptSvgWrite.details.saved, false);
assert.equal(blockedScriptSvgWrite.isError, true);
assert.match(blockedScriptSvgWrite.content[0].text, /Unsafe SVG is blocked/);

const blockedHandlerSvgWrite = await write!.execute("blocked-handler-svg", {
	destination: "desktop",
	folder: "client-demo",
	filename: "blocked-handler.svg",
	content: '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="1" height="1"/></svg>',
	reason: "svg event handler is blocked at write",
}, undefined, undefined, approvalTrue);
assert.equal(blockedHandlerSvgWrite.details.saved, false);
assert.match(blockedHandlerSvgWrite.content[0].text, /Unsafe SVG is blocked/);

const blockedForeignObjectSvgWrite = await write!.execute("blocked-foreignobject-svg", {
	destination: "desktop",
	folder: "client-demo",
	filename: "blocked-foreignobject.svg",
	content: '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>html inside</div></foreignObject></svg>',
	reason: "svg foreignObject is blocked at write",
}, undefined, undefined, approvalTrue);
assert.equal(blockedForeignObjectSvgWrite.details.saved, false);
assert.match(blockedForeignObjectSvgWrite.content[0].text, /Unsafe SVG is blocked/);

const blockedExternalSvgWrite = await write!.execute("blocked-external-svg", {
	destination: "desktop",
	folder: "client-demo",
	filename: "blocked-external.svg",
	content: '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/x.png"/></svg>',
	reason: "svg external reference is blocked at write",
}, undefined, undefined, approvalTrue);
assert.equal(blockedExternalSvgWrite.details.saved, false);
assert.match(blockedExternalSvgWrite.content[0].text, /Unsafe SVG is blocked/);
// No approval prompt is ever shown for a rejected SVG write.
assert.equal(confirmDetails.length, confirmCountBeforeBlockedSvg);
for (const name of ["blocked-script.svg", "blocked-handler.svg", "blocked-foreignobject.svg", "blocked-external.svg"]) {
	assert.equal(fs.existsSync(path.join(desktop, "client-demo", name)), false);
}

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
fs.rmSync(tempHome, { recursive: true, force: true });
console.log("artifact tool tests passed");
