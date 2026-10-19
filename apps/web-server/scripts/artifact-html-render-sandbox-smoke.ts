// Model-written HTML renders in server-side Chromium with page scripts off and
// every network request blocked, for deck slides and card previews alike.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-html-render-sandbox-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const artifacts = await import("../../../pi-package/extensions/artifacts/index.js");

// A machine without Chromium cannot render at all; skip whole, the same way
// the other browser smokes do.
if (!(await artifacts.htmlRenderAvailability()).available) {
	console.log("artifact html render sandbox smoke skipped (no Chromium found for this HOME)");
	fs.rmSync(tempHome, { recursive: true, force: true });
	process.exit(0);
}

// The top-left pixel of a PNG. The first pixel of the first row reads the
// same under every PNG filter, so no unfiltering is needed.
function firstPixel(png: Buffer): [number, number, number] {
	let offset = 8;
	let colorType = -1;
	const idat: Buffer[] = [];
	while (offset < png.length) {
		const length = png.readUInt32BE(offset);
		const type = png.toString("ascii", offset + 4, offset + 8);
		const data = png.subarray(offset + 8, offset + 8 + length);
		if (type === "IHDR") {
			assert(data[8] === 8, `expected 8-bit PNG, got bit depth ${data[8]}`);
			colorType = data[9];
		} else if (type === "IDAT") idat.push(data);
		offset += 12 + length;
	}
	assert(colorType === 2 || colorType === 6, `expected an RGB or RGBA PNG, got colour type ${colorType}`);
	const raw = zlib.inflateSync(Buffer.concat(idat));
	return [raw[1], raw[2], raw[3]];
}

const hits: string[] = [];
const server = http.createServer((req, res) => {
	hits.push(String(req.url));
	res.writeHead(200, { "content-type": "text/plain" });
	res.end("");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// Every way a page can reach out, all aimed at the local server.
const outbound = `
<link rel="stylesheet" href="${origin}/style.css">
<script src="${origin}/script.js"></script>
<img src="${origin}/image.png" alt="">
<div style="width:10px;height:10px;background:url(${origin}/background.png)"></div>`;

try {
	{
		hits.length = 0;
		const deck = `<!doctype html><html><head><style>body{margin:0;background:#fff}</style></head><body>
<section class="slide"><h1>Only slide</h1>${outbound}</section>
<script>
for (let i = 0; i < 2; i++) { const s = document.createElement("section"); s.className = "slide"; s.textContent = "added by script"; document.body.appendChild(s); }
</script></body></html>`;
		const rendered = await artifacts.renderDeckHtmlToSlideImages(deck);
		assert(rendered.images.length === 1, `the deck renderer must not run page scripts: expected 1 slide image, got ${rendered.images.length}`);
		assert(hits.length === 0, `the deck renderer must block the network, the page reached: ${hits.join(", ")}`);
	}

	{
		hits.length = 0;
		const page = `<!doctype html><html><head><style>html,body{margin:0;background:#fff}</style></head><body>
<p>Preview</p>${outbound}
<script>document.documentElement.style.background = "rgb(255,0,0)"; document.body.style.background = "rgb(255,0,0)";</script>
</body></html>`;
		const preview = await artifacts.renderHtmlToPreviewImage(page);
		assert(preview, "the preview renderer must return an image");
		const [r, g, b] = firstPixel(Buffer.from(preview.pngBase64, "base64"));
		assert(r > 240 && g > 240 && b > 240, `the preview renderer must not run page scripts: the top-left pixel is rgb(${r},${g},${b}), not white`);
		assert(hits.length === 0, `the preview renderer must block the network, the page reached: ${hits.join(", ")}`);
	}

	console.log("artifact html render sandbox smoke ok");
} finally {
	server.close();
	fs.rmSync(tempHome, { recursive: true, force: true });
}
