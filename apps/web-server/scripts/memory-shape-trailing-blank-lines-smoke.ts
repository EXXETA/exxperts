// The section-end rule of memory-shape stays linear, and stays the rule it was.
//
// `trimSectionTrailingBlankLines` used to be one regex, `/(\r?\n\s*)+$/`. Its
// nested quantifiers made a run of blank lines followed by content cost time
// exponential in the run's length: twenty-four blank lines took a tenth of a
// second, thirty took ten, forty did not come back. Every stamp written before
// 0.12.0 left one more blank line after "## Chronos", so an old room could
// carry exactly that run, and the two Memory routes that measure every room
// took minutes. The function is now two scans that produce the same bytes.
//
// Four things are pinned here. First, the two shapes agree: the old regex is
// kept locally as the oracle and compared with the product function on
// thousands of seeded random strings over the five characters that matter,
// plus the hand-picked edges (a trailing space on a content line stays, a lone
// trailing `\r` stays, whitespace before the first break is content). Second,
// the red: a child process applying the old regex to a Chronos with forty
// blank lines and content after them is killed by its two-second timeout, and
// a child process applying the product function is not. That pair is the
// proof the old shape hung and the new one does not, without the smoke itself
// ever waiting on the old one, and it runs before the in-process timings so
// that against the old function the smoke fails fast instead of hanging.
// Third, the product paths that count memory — metrics, the memory map, the
// section split — finish in milliseconds on that Chronos, with the run inside
// a section body too, and with `\r\n` endings. Fourth, the overview the Memory
// tab asks for is built in milliseconds over a real room in a temp HOME whose
// memory file carries that run.
//
// Everything runs in-process except the two children; the overview is read
// through the same function the route calls, so no server is started.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "memory-shape-trailing-blank-lines-smoke-home-"));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const smokeAppDir = path.join(tempHome, ".exxperts", "app");
const root = path.join(smokeAppDir, "personalized-agents");
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
fs.mkdirSync(smokeAppDir, { recursive: true });
fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(
	path.join(smokeAppDir, "openai-compatible-ai-profile.json"),
	JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }], maintenanceModel: "gpt-5.5" }, null, 2),
);
fs.writeFileSync(path.join(smokeAppDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const { buildMemoryMap, extractMemorySourceParts, extractTopLevelSectionBlocks, memoryMetrics, trimSectionTrailingBlankLines } = await import("../src/memory-shape.js");
const { buildMemoryOverview } = await import("../src/memory-api.js");
const { createPersistentAgentFromScaffoldInput } = await import("../src/persistent-agents.js");

/** The shape the function had: the oracle every random string is checked against. */
const oldTrim = (text: string): string => text.replace(/(\r?\n\s*)+$/, "");

const BLANK_RUN = 40;
const RANDOM_STRINGS = 5000;
const FAST_MS = 50;
const CHILD_TIMEOUT_MS = 2000;

let passes = 0;
function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
	passes += 1;
}

function timed<T>(work: () => T): { result: T; ms: number } {
	const started = performance.now();
	const result = work();
	return { result, ms: performance.now() - started };
}

const ms = (value: number) => `${value.toFixed(2)} ms`;
/** The code a killed or failed child leaves on its error, "none" when it ran to the end. */
const errorCode = (error: Error | undefined): string => (error as NodeJS.ErrnoException | undefined)?.code ?? "none";

// --- Fixtures -----------------------------------------------------------------

/** A room's memory with a run of blank lines somewhere in it, the usual four sections around it. */
function memoryFixture(agentId: string, options: { chronosRun: number; bodyRun: number; eol: "\n" | "\r\n" }): string {
	const blank = (count: number) => Array.from({ length: count }, () => "");
	return [
		"<!-- exxeta:l1b schema_version=1 -->",
		"",
		"## Chronos",
		"",
		`- Persistent agent id: ${agentId}`,
		"- Lifecycle state: ready",
		"- Last checkpoint: none",
		"- Last consolidation: none",
		...blank(options.chronosRun),
		"- Last save: 2026-09-15",
		"",
		"## Deep Memory",
		"",
		"<!-- entries: next=300 -->",
		"",
		"### Commercial terms",
		...blank(options.bodyRun),
		"",
		"<!-- e: id=m-0001 kind=fact saved=2026-09-01 refs=0 -->",
		"- The pricing arrangement follows the volume schedule agreed in September.",
		"",
		"## Active Items",
		"",
		"<!-- e: id=m-0201 kind=item saved=2026-09-01 status=open refs=0 -->",
		"- Chase the vendor for the signed addendum.",
		"",
		"## Recent Context",
		"",
		"No checkpointed sessions yet.",
		"",
	].join(options.eol);
}

// --- A deterministic generator, so a failing string can be found again --------

function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const ALPHABET = ["a", " ", "\t", "\n", "\r"];
function randomString(next: () => number): string {
	const length = Math.floor(next() * 13);
	let out = "";
	for (let index = 0; index < length; index += 1) out += ALPHABET[Math.floor(next() * ALPHABET.length)];
	return out;
}

const show = (text: string) => JSON.stringify(text);

try {
	// --- 1. The two shapes agree ---------------------------------------------------
	//     The oracle is the old regex on strings short enough for it to answer.
	const fixedCases: Array<[string, string]> = [
		["a \n", "a "],
		["a\r", "a\r"],
		["a\r\n\r\n", "a"],
		["\n\n", ""],
		["", ""],
		["a\r \n", "a\r "],
		["a\n \t\r\n", "a"],
	];
	for (const [input, expected] of fixedCases) {
		check(trimSectionTrailingBlankLines(input) === expected, `${show(input)} trims to ${show(expected)}, got ${show(trimSectionTrailingBlankLines(input))}`);
		check(oldTrim(input) === expected, `the old regex reads ${show(input)} the same way, got ${show(oldTrim(input))}`);
	}

	const next = seededRandom(0x5eed);
	let compared = 0;
	for (let index = 0; index < RANDOM_STRINGS; index += 1) {
		const input = randomString(next);
		const expected = oldTrim(input);
		const actual = trimSectionTrailingBlankLines(input);
		if (actual !== expected) throw new Error(`random string ${index} ${show(input)}: old regex gives ${show(expected)}, product gives ${show(actual)}`);
		compared += 1;
	}
	check(compared === RANDOM_STRINGS, `${compared} seeded random strings over {a, space, tab, LF, CR} of length 0..12 agree with the old regex`);
	console.log(`property check: ${compared} random strings compared, all equal`);

	// --- 2. The red: the old regex hangs on this input, the product function does not ---
	//     Both run as children so the smoke never waits on the old shape itself,
	//     and this pair comes before the in-process timings so that against the
	//     old function the smoke fails here in two seconds instead of hanging
	//     on its own first measurement.
	const chronosWithRun = `## Chronos\n${"\n".repeat(BLANK_RUN)}- Last save: 2026-09-15\n`;
	const inputLiteral = JSON.stringify(chronosWithRun);
	const oldRun = spawnSync(process.execPath, ["-e", `const out = (${inputLiteral}).replace(/(\\r?\\n\\s*)+$/, ""); process.stdout.write(String(out.length));`], {
		encoding: "utf-8",
		timeout: CHILD_TIMEOUT_MS,
		env: { ...process.env },
	});
	check(errorCode(oldRun.error) === "ETIMEDOUT" || oldRun.signal !== null, `the old regex on ${BLANK_RUN} blank lines followed by content is killed by the ${CHILD_TIMEOUT_MS} ms timeout (status ${oldRun.status}, signal ${oldRun.signal}, error ${errorCode(oldRun.error)})`);

	const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
	// `.mts`, so the runner is a module wherever it sits: the temp HOME has no
	// package.json to say so, and the import at its top level needs one.
	const productRunner = path.join(tempHome, "product-trim-runner.mts");
	const memoryShapeUrl = pathToFileURL(path.join(webServerDir, "src", "memory-shape.ts")).href;
	fs.writeFileSync(
		productRunner,
		[
			`const { trimSectionTrailingBlankLines } = await import(${JSON.stringify(memoryShapeUrl)});`,
			`const out = trimSectionTrailingBlankLines(${inputLiteral});`,
			"process.stdout.write(String(out.length));",
			"",
		].join("\n"),
	);
	const productStarted = performance.now();
	const productRun = spawnSync(process.execPath, ["--import", tsxLoader, productRunner], {
		encoding: "utf-8",
		timeout: CHILD_TIMEOUT_MS,
		cwd: webServerDir,
		env: { ...process.env },
	});
	const productMs = performance.now() - productStarted;
	check(productRun.status === 0 && productRun.error === undefined, `the product function on the same input finishes inside the timeout (status ${productRun.status}, error ${errorCode(productRun.error)}): ${productRun.stderr ?? ""}`);
	check(productRun.stdout === String(chronosWithRun.length - 1), `and it cuts only the final line break, the run before the content being content: expected ${chronosWithRun.length - 1} characters, got ${productRun.stdout}`);
	console.log(`red pair: old regex child ${errorCode(oldRun.error)} after ${CHILD_TIMEOUT_MS} ms, product child done in ${ms(productMs)} including its start`);

	// --- 3. The product paths on a run of forty blank lines -----------------------
	const shapes: Array<{ name: string; text: string }> = [
		{ name: "forty blank lines after the Chronos stamps", text: memoryFixture("room-a", { chronosRun: BLANK_RUN, bodyRun: 0, eol: "\n" }) },
		{ name: "forty blank lines between a heading and its content", text: memoryFixture("room-b", { chronosRun: 0, bodyRun: BLANK_RUN, eol: "\n" }) },
		{ name: "forty blank CRLF lines after the Chronos stamps", text: memoryFixture("room-c", { chronosRun: BLANK_RUN, bodyRun: 0, eol: "\r\n" }) },
	];
	for (const shape of shapes) {
		const metrics = timed(() => memoryMetrics(shape.text));
		check(metrics.ms < FAST_MS && metrics.result.estimatedTokens > 0, `memoryMetrics on ${shape.name} finishes in ${ms(metrics.ms)}`);
		const map = timed(() => buildMemoryMap(shape.text));
		check(map.ms < FAST_MS && map.result.some((row) => row.area === "Deep Memory / Commercial terms"), `buildMemoryMap on ${shape.name} finishes in ${ms(map.ms)} and still finds the topic`);
		const blocks = timed(() => extractTopLevelSectionBlocks(shape.text));
		check(blocks.ms < FAST_MS && blocks.result.length === 4, `extractTopLevelSectionBlocks on ${shape.name} finishes in ${ms(blocks.ms)} with four sections`);
		const parts = timed(() => extractMemorySourceParts(shape.text));
		check(parts.ms < FAST_MS && parts.result.preservedChronos.includes("Last save: 2026-09-15"), `extractMemorySourceParts on ${shape.name} finishes in ${ms(parts.ms)} and keeps the content after the run`);
		console.log(`${shape.name}: metrics ${ms(metrics.ms)}, map ${ms(map.ms)}, sections ${ms(blocks.ms)}, parts ${ms(parts.ms)}`);
	}

	// --- 4. The overview over a real room --------------------------------------------
	//     buildMemoryOverview is what GET /api/memory/overview returns and what
	//     GET /api/memory/room-memory starts from; it measures every room.
	const created = createPersistentAgentFromScaffoldInput({ displayName: "Trailing Blank Lines Smoke Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	const agentId = created.agent.agentId;
	const l1bPath = path.join(root, agentId, "L1b", "current.md");
	fs.writeFileSync(l1bPath, memoryFixture(agentId, { chronosRun: BLANK_RUN, bodyRun: 0, eol: "\n" }), { mode: 0o600 });
	const overview = timed(() => buildMemoryOverview());
	const room = overview.result.rooms.find((entry) => entry.id === agentId);
	check(room !== undefined && overview.result.totals.rooms === 1, "the overview lists the room whose Chronos carries the run");
	check(overview.ms < FAST_MS, `the overview over that room is built in ${ms(overview.ms)}, in-process, no server`);
	check(room !== undefined && room.l1bTokens > 0 && room.composition.chronos > 0, `the room's Chronos is measured, not skipped: ${room?.composition.chronos} tokens`);
	console.log(`overview over one room with the run: ${ms(overview.ms)}`);

	console.log(`memory-shape-trailing-blank-lines-smoke: ${passes}/${passes} checks passed`);
} finally {
	fs.rmSync(tempHome, { recursive: true, force: true });
}
