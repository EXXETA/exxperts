import { describe, expect, it } from "vitest";
import { CitationMarkerStreamFilter, stripCitationMarkers } from "../src/utils/citation-markers.js";

const S = "\ue200";
const E = "\ue201";
const P = "\ue202";

function runStream(deltas: string[]): { pieces: string[]; text: string } {
	const filter = new CitationMarkerStreamFilter();
	const pieces = deltas.map((delta) => filter.push(delta));
	const tail = filter.flush();
	return { pieces, text: pieces.join("") + tail };
}

describe("stripCitationMarkers", () => {
	it("strips a single marker", () => {
		expect(stripCitationMarkers(`Rust is fast.${S}citeturn5view0${E} More text.`)).toBe(
			"Rust is fast. More text.",
		);
	});

	it("strips multiple markers", () => {
		expect(stripCitationMarkers(`a${S}citeturn0view0${E}b${S}citeturn1view2${E}c`)).toBe("abc");
	});

	it("strips the multi-source separator form", () => {
		expect(stripCitationMarkers(`fact${S}cite${P}turn0search1${P}turn0search3${E}!`)).toBe("fact!");
	});

	it("strips navlist markers", () => {
		expect(stripCitationMarkers(`${S}navlist${P}Top news${P}turn2news0${P}turn2news1${E}done`)).toBe("done");
	});

	it("is a byte-identical no-op on clean text", () => {
		const clean = "No markers here. Just prose with unicode: café \u{1f600}.";
		expect(stripCitationMarkers(clean)).toBe(clean);
	});

	it("removes a lone stray end character", () => {
		expect(stripCitationMarkers(`before${E}after`)).toBe("beforeafter");
	});

	it("removes a lone stray separator character", () => {
		expect(stripCitationMarkers(`x${P}y`)).toBe("xy");
	});

	it("preserves surrogate pairs around a marker", () => {
		expect(stripCitationMarkers(`\u{1f600}${S}citeturn0view0${E}\u{1f680}`)).toBe("\u{1f600}\u{1f680}");
	});
});

describe("CitationMarkerStreamFilter", () => {
	it("passes clean deltas through byte-identically", () => {
		const filter = new CitationMarkerStreamFilter();
		const delta = "plain streaming text \u{1f600}";
		expect(filter.push(delta)).toBe(delta);
		expect(filter.flush()).toBe("");
	});

	it("drops a whole marker inside one delta", () => {
		const { text } = runStream([`a${S}citeturn5view0${E}b`]);
		expect(text).toBe("ab");
	});

	it("drops multiple markers inside one delta", () => {
		const { text } = runStream([`a${S}citeturn0view0${E}b${S}citeturn1search2${E}c`]);
		expect(text).toBe("abc");
	});

	it("drops a marker split across two deltas", () => {
		const { pieces, text } = runStream([`before ${S}citeturn`, `5view0${E} after`]);
		expect(pieces[0]).toBe("before ");
		expect(text).toBe("before  after");
	});

	it("drops a marker split across five deltas", () => {
		const { text } = runStream(["ok ", `${S}cite`, `${P}turn0search1`, `${P}turn0`, "search3", `${E}fine`]);
		expect(text).toBe("ok fine");
	});

	it("handles marker edges exactly at delta boundaries", () => {
		const { text } = runStream(["before", `${S}citeturn2view1${E}`, "after"]);
		expect(text).toBe("beforeafter");
	});

	it("handles a delta ending exactly on the marker start", () => {
		const { pieces, text } = runStream([`before${S}`, `citeturn0view0${E}after`]);
		expect(pieces[0]).toBe("before");
		expect(text).toBe("beforeafter");
	});

	it("drops an unclosed marker at flush", () => {
		const filter = new CitationMarkerStreamFilter();
		expect(filter.push(`answer${S}citeturn0`)).toBe("answer");
		expect(filter.push("search1")).toBe("");
		expect(filter.flush()).toBe("");
	});

	it("removes stray end and separator characters", () => {
		const { text } = runStream([`a${E}b`, `c${P}d`]);
		expect(text).toBe("abcd");
	});

	it("keeps surrogate pairs intact around a marker", () => {
		const { text } = runStream([`\u{1f600}${S}cite`, `turn0view0${E}\u{1f680}`]);
		expect(text).toBe("\u{1f600}\u{1f680}");
	});
});
