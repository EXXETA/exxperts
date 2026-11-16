import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { streamSimple } from "../src/stream.js";
import { isContextOverflow } from "../src/utils/overflow.js";

// A gateway's refusal may echo the key it was sent. The error's text is cut of
// that key before it leaves the provider, and the same text is read next (an
// overflow starts the recovery), so a short key is cut only where it stands
// alone, and a key of 8 or more characters everywhere. Each row runs a
// refusal through the real stream and reads its error message.

const mockState = vi.hoisted(() => ({ refusal: "", unreadBody: undefined as unknown }));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					throw Object.assign(new Error(mockState.refusal), mockState.unreadBody ? { unreadBody: mockState.unreadBody } : {});
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
const model = { ...baseModel, api: "openai-completions" } as const;

async function refusedWith(refusal: string, apiKey: string) {
	mockState.refusal = refusal;
	return streamSimple(model, { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }, { apiKey }).result();
}

const overflow = "400 This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.";

// [row id, key, the refusal, the error message after the cut]
const rows: Array<[string, string, string, string]> = [
	["K1 a one-letter key: an overflow keeps its words", "e", overflow, overflow],
	[
		"K2 a one-letter key echoed as a word: alone, after key=, in quotes, at the start and the end",
		"e",
		`e Incorrect API key provided: e. key=e, "e" 'e' e`,
		`[key removed] Incorrect API key provided: [key removed]. key=[key removed], "[key removed]" '[key removed]' [key removed]`,
	],
	["K3 a one-letter key touching a letter or digit stays", "e", "seen in e1, xe and ée", "seen in e1, xe and ée"],
	["K4 a seven-character key: hidden alone, kept glued", "abc1234", "Xabc1234Y abc1234", "Xabc1234Y [key removed]"],
	["K5 an eight-character key (the control): hidden glued too", "abc12345", "Xabc12345Y abc12345", "X[key removed]Y [key removed]"],
	[
		"K6 a short key holding $ . * \\ is hidden whole and matches nothing else",
		"k.$*\\z",
		"key=k.$*\\z; kx$*\\z; ak.$*\\z",
		"key=[key removed]; kx$*\\z; ak.$*\\z",
	],
	[
		"K7 a long key holding $ . * \\ is hidden whole and matches nothing else",
		"sk.$*\\9zz",
		"Xsk.$*\\9zzY skX$*\\9zz $&",
		"X[key removed]Y skX$*\\9zz $&",
	],
];

describe("openai-completions cuts the request's key from a refusal", () => {
	beforeEach(() => {
		mockState.refusal = "";
		mockState.unreadBody = undefined;
	});

	for (const [id, key, refusal, cut] of rows) {
		it(id, async () => {
			const message = await refusedWith(refusal, key);
			expect(message.stopReason, id).toBe("error");
			expect(message.errorMessage, id).toBe(cut);
		});
	}

	it("K8 a one-letter key: an overflow the provider sends still reads as an overflow", async () => {
		const message = await refusedWith(overflow, "e");
		expect(isContextOverflow(message, 128000), "K8").toBe(true);
	});

	// A key holding a quote or a backslash reads escaped inside JSON text: the
	// client's own message for an error with no message of its own, and a body
	// with no "error" field, which rides along and is written out as JSON.
	const quoted = 'sk.\\9zz"123';
	const shortQuoted = 'a"b\\c';
	it("K9 a key with a quote and a backslash in the client's JSON message is hidden", async () => {
		const message = await refusedWith(`401 ${JSON.stringify({ detail: `bad key ${quoted}` })}`, quoted);
		expect(message.errorMessage, "K9").toBe('401 {"detail":"bad key [key removed]"}');
	});

	it("K10 a key with a quote and a backslash in a body with no error field is hidden", async () => {
		mockState.unreadBody = { message: `Incorrect API key: ${quoted}` };
		const message = await refusedWith("403 status code (no body)", quoted);
		expect(message.errorMessage, "K10").toBe('403 status code (no body)\n{"message":"Incorrect API key: [key removed]"}');
	});

	it("K11 a short key with a quote and a backslash in that body is hidden alone, kept glued", async () => {
		mockState.unreadBody = { message: `key ${shortQuoted}, not x${shortQuoted}` };
		const message = await refusedWith("403 status code (no body)", shortQuoted);
		expect(message.errorMessage, "K11").toBe(`403 status code (no body)\n${JSON.stringify({ message: `key [key removed], not x${shortQuoted}` })}`);
	});

	// Written out as JSON, a newline or a tab before the key reads as a
	// backslash and a letter: that letter is the escape's, not a word's.
	it("K12 a short key after a newline, a tab or a \\u escape in a body with no error field is hidden", async () => {
		mockState.unreadBody = { message: `Incorrect API key:\n${shortQuoted}\t${shortQuoted}\u0001${shortQuoted}` };
		const message = await refusedWith("403 status code (no body)", shortQuoted);
		expect(message.errorMessage, "K12").toBe('403 status code (no body)\n{"message":"Incorrect API key:\\n[key removed]\\t[key removed]\\u0001[key removed]"}');
	});

	it("K13 a one-letter key after a newline in the client's JSON message is hidden", async () => {
		const message = await refusedWith(`401 ${JSON.stringify({ detail: "bad key:\ne" })}`, "e");
		expect(message.errorMessage, "K13").toBe('401 {"detail":"bad key:\\n[key removed]"}');
	});
});
