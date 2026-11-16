// The release check scripts/check-model-catalogue.mjs, on saved copies of
// models.dev and the catalogue. A model models.dev lists with tools and the
// catalogue lacks fails it; the same catalogue with that row passes, and so
// does the missing model once it is on the script's skip list. Deprecated
// and tool-less upstream models never fail it, and catalogue rows upstream
// deprecated or dropped are listed, not failed, and an upstream copy with no
// models for a provider is a failed read, never a pass. Every run with --from goes
// through a preload that records and refuses any fetch: none is made, and
// the same preload catches the fetch a run without --from makes.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const checkScript = path.join(repoRoot, "scripts", "check-model-catalogue.mjs");
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "model-catalogue-check-")));
const fetchMarker = path.join(temp, "fetch-attempted");
const noNetwork = path.join(temp, "no-network.mjs");
fs.writeFileSync(
	noNetwork,
	`import { appendFileSync } from "node:fs";\n` +
		`globalThis.fetch = async (url) => { appendFileSync(${JSON.stringify(fetchMarker)}, String(url) + "\\n"); throw new Error("network refused by the smoke"); };\n`,
);

// The two shapes the generator writes: a provider line and a row line.
function catalogueText(rows: Record<string, string[]>): string {
	let text = `import type { Model } from "./types.js";\n\nexport const MODELS = {\n`;
	for (const [provider, ids] of Object.entries(rows)) {
		text += `\t${JSON.stringify(provider)}: {\n`;
		for (const id of ids) text += `\t\t${JSON.stringify(id)}: {\n\t\t\tid: ${JSON.stringify(id)},\n\t\t} satisfies Model<"openai-completions">,\n`;
		text += `\t},\n`;
	}
	return `${text}} as const;\n`;
}

const upstream = {
	anthropic: { models: { "claude-a": { name: "Claude A", tool_call: true } } },
	openai: { models: { "gpt-a": { name: "GPT A", tool_call: true }, "gpt-old": { name: "GPT Old", tool_call: true, status: "deprecated" } } },
	google: {
		models: {
			"gemini-a": { name: "Gemini A", tool_call: true },
			"gemini-new": { name: "Gemini New", tool_call: true },
			"gemini-tts": { name: "Gemini TTS", tool_call: false },
			"gemini-gone": { name: "Gemini Gone", tool_call: true, status: "deprecated" },
		},
	},
	"github-copilot": { models: { "claude-a": { name: "Claude A", tool_call: true } } },
};
const upstreamFile = path.join(temp, "api.json");
fs.writeFileSync(upstreamFile, JSON.stringify(upstream));

const baseRows = {
	anthropic: ["claude-a"],
	"github-copilot": ["claude-a", "claude-dropped"],
	google: ["gemini-a"],
	openai: ["gpt-a", "gpt-old"],
};
const lacking = path.join(temp, "lacking.ts");
fs.writeFileSync(lacking, catalogueText(baseRows));
const complete = path.join(temp, "complete.ts");
fs.writeFileSync(complete, catalogueText({ ...baseRows, google: ["gemini-a", "gemini-new"] }));

function run(script: string, args: string[]) {
	const result = spawnSync(process.execPath, ["--import", pathToFileURL(noNetwork).href, script, ...args], {
		encoding: "utf8",
		timeout: 60_000,
	});
	return { code: result.status, out: result.stdout, err: result.stderr };
}

try {
	const missing = run(checkScript, ["--from", upstreamFile, "--catalogue", lacking]);
	assert(missing.code === 1, `a missing model must fail the check, got ${missing.code}: ${missing.out}${missing.err}`);
	assert(missing.err.includes("google/gemini-new (Gemini New)"), `the failure must name the missing model: ${missing.err}`);
	assert(!/gemini-tts|gemini-gone|gpt-old/.test(missing.err), `tool-less and deprecated upstream models are not missing: ${missing.err}`);

	const present = run(checkScript, ["--from", upstreamFile, "--catalogue", complete]);
	assert(present.code === 0, `a catalogue with every model must pass, got ${present.code}: ${present.out}${present.err}`);
	assert(
		/marks it deprecated:\n {2}- openai\/gpt-old\n/.test(present.out),
		`a row upstream deprecated is listed as kept: ${present.out}`,
	);
	assert(
		/no longer lists it:\n {2}- github-copilot\/claude-dropped\n/.test(present.out),
		`a row upstream dropped is listed as kept: ${present.out}`,
	);

	const emptyFile = path.join(temp, "empty-api.json");
	fs.writeFileSync(emptyFile, JSON.stringify({ ...upstream, google: { models: {} } }));
	const empty = run(checkScript, ["--from", emptyFile, "--catalogue", complete]);
	assert(empty.code === 2, `an upstream copy with no google models must not pass, got ${empty.code}: ${empty.out}${empty.err}`);
	assert(empty.err.includes("models.dev lists no models for google"), `the failure names the provider: ${empty.err}`);

	// The same missing model on the script's skip list, in a copy that adds that one entry
	// to whatever the list holds.
	const source = fs.readFileSync(checkScript, "utf8");
	const skipsOpen = "const SKIPS = {";
	assert(source.split(skipsOpen).length === 2, `the check script must declare its skip list once, opening with ${skipsOpen}`);
	const skippingScript = path.join(temp, "check-model-catalogue-skipping.mjs");
	fs.writeFileSync(skippingScript, source.replace(skipsOpen, `${skipsOpen} "google/gemini-new": "not served to tools yet",`));
	const skipped = run(skippingScript, ["--from", upstreamFile, "--catalogue", lacking]);
	assert(skipped.code === 0, `a skipped model must pass, got ${skipped.code}: ${skipped.out}${skipped.err}`);
	assert(
		skipped.out.includes("Missing but skipped:\n  - google/gemini-new: not served to tools yet"),
		`a skipped model is printed with its reason: ${skipped.out}`,
	);

	assert(!fs.existsSync(fetchMarker), `a run with --from must not fetch: ${fs.existsSync(fetchMarker) ? fs.readFileSync(fetchMarker, "utf8") : ""}`);

	// The preload's neighbour: without --from the check fetches, and is caught.
	const live = run(checkScript, ["--catalogue", complete]);
	assert(live.code === 2, `a run whose fetch fails must exit 2, got ${live.code}: ${live.out}${live.err}`);
	assert(live.err.includes("could not fetch https://models.dev/api.json"), `the failure names the source: ${live.err}`);
	assert(fs.readFileSync(fetchMarker, "utf8").trim() === "https://models.dev/api.json", "the preload must see the fetch a live run makes");

	console.log("model catalogue check smoke ok");
} finally {
	fs.rmSync(temp, { recursive: true, force: true });
}
