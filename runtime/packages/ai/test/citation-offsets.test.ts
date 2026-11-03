import { describe, expect, it } from "vitest";
import { stripCitationMarkers } from "../src/utils/citation-markers.js";
import { placeCitations, strippedIndex, toUtf16, webLink } from "../src/utils/citation-offsets.js";

// A provider counts its citation offsets in its own unit; the page slices the
// text with JavaScript indexes. "é" is one code point, one UTF-16 unit and two
// UTF-8 bytes; "😀" is one code point, two UTF-16 units and four bytes.
const TEXT = "é😀 Node";

describe("toUtf16", () => {
	it("reads code points", () => {
		expect(toUtf16(TEXT, 0, "codepoint")).toBe(0);
		expect(toUtf16(TEXT, 1, "codepoint")).toBe(1);
		expect(toUtf16(TEXT, 2, "codepoint")).toBe(3);
		expect(TEXT.slice(toUtf16(TEXT, 3, "codepoint"))).toBe("Node");
	});

	it("reads UTF-8 bytes", () => {
		expect(toUtf16(TEXT, 2, "utf8")).toBe(1);
		expect(toUtf16(TEXT, 6, "utf8")).toBe(3);
		expect(TEXT.slice(toUtf16(TEXT, 7, "utf8"))).toBe("Node");
		// A byte inside a character moves to the character's end.
		expect(toUtf16(TEXT, 4, "utf8")).toBe(3);
	});

	it("takes UTF-16 as it is", () => {
		expect(toUtf16(TEXT, 4, "utf16")).toBe(4);
		expect(TEXT.slice(toUtf16(TEXT, 4, "utf16"))).toBe("Node");
	});

	it("clamps to the text", () => {
		for (const unit of ["utf16", "codepoint", "utf8"] as const) {
			expect(toUtf16(TEXT, -3, unit)).toBe(0);
			expect(toUtf16(TEXT, Number.NaN, unit)).toBe(0);
			expect(toUtf16(TEXT, 999, unit)).toBe(TEXT.length);
		}
	});
});

describe("strippedIndex", () => {
	const raw = "Node 26.citeturn0search1 Bun 2.";

	it("counts only the text a person sees", () => {
		expect(strippedIndex(raw, 8)).toBe(8);
		expect(strippedIndex(raw, raw.length)).toBe("Node 26. Bun 2.".length);
		expect(strippedIndex("plain", 3)).toBe(3);
	});

	it("puts a position inside a marker at the marker's start", () => {
		expect(strippedIndex(raw, 12)).toBe(8);
	});

	it("drops a stray marker start alone, as stripCitationMarkers does", () => {
		const stray = "A\ue200Node";
		expect(stripCitationMarkers(stray)).toBe("ANode");
		expect(strippedIndex(stray, stray.length)).toBe(5);
	});
});

describe("placeCitations", () => {
	const link = { url: "https://nodejs.org", title: "Node.js" };
	const at = (part: number, start: unknown, end: unknown, url = link.url) => ({ link: { ...link, url }, part, start, end });

	it("places code point offsets on the stripped text, past the earlier parts", () => {
		const parts = ["é😀\ue200cite", "\ue201 Node"];
		const text = stripCitationMarkers(parts.join(""));
		const { citations, sources } = placeCitations([at(1, 2, 6)], parts, text, "codepoint");
		expect(text).toBe("é😀 Node");
		expect(citations).toEqual([{ ...link, start: 4, end: 8 }]);
		expect(text.slice(4, 8)).toBe("Node");
		expect(sources).toEqual([]);
	});

	it("keeps a citation without an end, or for a missing part, as a source, once", () => {
		const { citations, sources } = placeCitations([at(0, 0, undefined), at(0, 0, 2.5), at(3, 0, 4), at(0, undefined, 4, "https://bun.sh")], ["Node"], "Node", "codepoint");
		expect(citations).toEqual([{ ...link, url: "https://bun.sh", end: 4 }]);
		expect(sources).toEqual([link]);
	});

	it("keeps a page once per end, and bounds every place by the text", () => {
		const { citations } = placeCitations([at(0, 0, 4), at(0, 0, 4), at(0, 0, 99)], ["Node 26 is out."], "Node", "codepoint");
		expect(citations).toEqual([
			{ ...link, start: 0, end: 4 },
		]);
	});
});

describe("webLink", () => {
	it("keeps http and https only", () => {
		expect(webLink("https://nodejs.org", "Node.js")).toEqual({ url: "https://nodejs.org", title: "Node.js" });
		expect(webLink("http://example.com", "")).toEqual({ url: "http://example.com" });
		expect(webLink("javascript:alert(1)", "x")).toBeUndefined();
		expect(webLink("file:///etc/passwd", "x")).toBeUndefined();
		expect(webLink("not a url", "x")).toBeUndefined();
		expect(webLink(42, "x")).toBeUndefined();
	});
});
