// Prompt-hardening slice 1 (visuals contract D4 amendment 2026-07-17): the
// write-time content floor for raw .html and .svg artifacts. SVG mirrors the
// HTML blocklist — the in-app surfaces (<img>, CSP route) were always safe,
// but an EXPORTED file leaves them behind, so the file itself is validated.
// Also pins the instructive tails of the rejection messages: the error text is
// the model's retry prompt, so a reworded message is a behavior change.
import {
	validateRawHtmlArtifactContent,
	validateRawSvgArtifactContent,
} from "../../../pi-package/extensions/artifacts/index.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function rejection(fn: (body: string) => void, body: string): string | null {
	try {
		fn(body);
		return null;
	} catch (e) {
		return (e as Error).message;
	}
}

// ── 1. Legitimate SVG passes: namespace URI, gradient url(#), fragment <use> ──
{
	const safe = [
		'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 200 100">',
		'<defs><linearGradient id="g"><stop offset="0" stop-color="#345"/></linearGradient><circle id="dot" r="4"/></defs>',
		'<rect width="200" height="100" fill="url(#g)"/><use href="#dot" x="20" y="20"/>',
		'<a href="#dot"><text x="10" y="90">Legend</text></a></svg>',
	].join("\n");
	assert(rejection(validateRawSvgArtifactContent, safe) === null, "a normal namespaced SVG with gradient + fragment refs must pass");
}

// ── 2. SVG rejections, one per rule, with instructive tails ──────────────────
{
	const cases: Array<{ body: string; expect: RegExp; label: string }> = [
		{ body: "<svg><script>alert(1)</script></svg>", expect: /fully static/, label: "script tag" },
		{ body: '<svg onload="alert(1)"></svg>', expect: /event handlers/, label: "event handler" },
		{ body: "<svg><foreignObject><div>x</div></foreignObject></svg>", expect: /native SVG shapes/, label: "foreignObject" },
		{ body: '<svg><image href="https://evil.example/x.png"/></svg>', expect: /even in visible text/, label: "external URL" },
		{ body: '<svg><image href="data:image/png;base64,AAAA"/></svg>', expect: /fragment links/, label: "data: href" },
		{ body: '<svg><image src="local.png"/></svg>', expect: /src attributes are not allowed/, label: "src attribute" },
		{ body: "<svg><style>@import 'x.css';</style></svg>", expect: /styles inline/, label: "@import" },
	];
	for (const { body, expect, label } of cases) {
		const message = rejection(validateRawSvgArtifactContent, body);
		assert(message !== null, `SVG with ${label} must be rejected`);
		assert(message.startsWith("Unsafe SVG is blocked"), `SVG ${label} rejection must carry the SVG prefix, got: ${message}`);
		assert(expect.test(message), `SVG ${label} rejection must be instructive (${expect}), got: ${message}`);
	}
}

// ── 3. The namespace exemption cannot be abused as a general URL pass ────────
{
	const smuggled = '<svg xmlns="http://www.w3.org/2000/svg"><text>see https://evil.example</text></svg>';
	const message = rejection(validateRawSvgArtifactContent, smuggled);
	assert(message !== null && /even in visible text/.test(message), "a non-namespace URL must still reject even when the namespace URI is present");
}

// ── 4. HTML floor unchanged + instructive tails ──────────────────────────────
{
	assert(rejection(validateRawHtmlArtifactContent, "<!doctype html><body><h1>ok</h1><a href=\"#top\">top</a></body>") === null, "plain static HTML must pass");
	const scriptMessage = rejection(validateRawHtmlArtifactContent, "<body><script>x</script></body>");
	assert(scriptMessage !== null && /scripts disabled/.test(scriptMessage), `HTML script rejection must explain the no-scripts display, got: ${scriptMessage}`);
	const urlMessage = rejection(validateRawHtmlArtifactContent, "<body><p>See https://example.com</p></body>");
	assert(urlMessage !== null && /even as visible text/.test(urlMessage), `HTML URL-in-text rejection must name the visible-text rule, got: ${urlMessage}`);
	const dataImgMessage = rejection(validateRawHtmlArtifactContent, '<body><img src="data:image/png;base64,AAAA"></body>');
	assert(dataImgMessage !== null && /data: assets/.test(dataImgMessage), `HTML data:-image rejection must name data: explicitly, got: ${dataImgMessage}`);
}

console.log("artifact-write-validation smoke passed");
