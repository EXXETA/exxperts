// The first read never blocks Memorize: it is fitted to the Memory model's
// window, a failed, cut or too long one gives "None." with one reason, a
// failed window lookup reads as unknown, the run starts on a missing or too
// long first read, and the fold is not told to follow an assessment it does
// not have. Every section can run alone (ONLY=<name>), so each behaviour is its
// own red-first command against the base.
//
// Offline: no server, no provider, no network, no port.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AbsorbGenerateResult } from "../src/persistent-agents.js";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "absorb-first-read-home-"));
const root = path.join(tempHome, ".exxperts", "app", "personalized-agents");
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const appDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(appDir, { recursive: true });
fs.writeFileSync(path.join(appDir, "openai-compatible-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }], maintenanceModel: "gpt-5.5" }, null, 2));
fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
process.env.EXXPERTS_CODING_AGENT_DIR = path.join(tempHome, ".exxperts", "agent");
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const agents = await import("../src/persistent-agents.js");
const { buildAbsorbAssessment, buildAbsorbAssessmentMaterial, createPersistentAgentFromScaffoldInput } = agents;
const { parseAbsorbRunProposeRequest } = await import("../src/absorb-run.js");
const { buildFoldPrompt } = await import("../src/absorb-ops.js");
const { estimateTokens } = await import("../src/token-estimate.js");

const MODEL = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" };
const FIRST_READ = "## Absorb assessment\n\nI found 2 Recent Context entries. Here is the proposed direction.\n\n### What to remember\n- The renewal.\n\n### What to forget\n- Small talk.\n\n### What changes in stable memory\n- Deep Memory: the renewal.\n- Active Items: none.\n- Recent Context: all entries are expected to be cleared after approval.\n\n### Needs your judgment\nNone\n";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function page(id: string, title: string, body: string): string {
	return [`### ${id} | OPEN | 2026-09-11 | ${title}`, "", `**Session arc:** ${title} was settled.`, "", "**Body:**", `- ${body}`, "", "**Parked:**", "None", ""].join("\n");
}

/** A room with `sessions` waiting pages of `bodyChars` each (the oldest `firstChars` long when given) and `entries` notes. */
function createRoom(name: string, sessions: number, bodyChars: number, entries: number, firstChars?: number): { agentId: string; l1b: string } {
	const created = createPersistentAgentFromScaffoldInput({ displayName: name, userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	const agentId = created.agent.agentId;
	const notes: string[] = [];
	for (let n = 0; n < entries; n++) notes.push(`<!-- e: id=m-${String(100 + n).padStart(4, "0")} kind=fact saved=2026-09-01 -->`, `- Note ${n} about the renewal terms and the people involved.`, "");
	const pages: string[] = [];
	for (let n = 1; n <= sessions; n++) pages.push(page(`RC-${String(n).padStart(4, "0")}`, `Conversation ${n}`, `POINT-${n} ${"is a long durable detail about the delivery plan ".repeat(Math.ceil((n === 1 && firstChars ? firstChars : bodyChars) / 48)).trim()}.`));
	const l1b = [
		"<!-- exxeta:l1b schema_version=1 -->", "", "## Chronos", "", `- Persistent agent id: ${agentId}`, "- Lifecycle state: ready", "- Last checkpoint: cp_20260912_0001", "- Last checkpoint at: 2026-09-12T09:00:00.000Z", "- Last consolidation: none", "",
		"## Deep Memory", "", `<!-- entries: next=${100 + entries} -->`, "", "### Renewals", "", ...notes,
		"## Active Items", "",
		"## Recent Context", "", pages.join("\n"),
	].join("\n");
	fs.writeFileSync(path.join(root, agentId, "L1b", "current.md"), l1b, { mode: 0o600 });
	return { agentId, l1b };
}

const ONLY = process.env.ONLY;
async function section(name: string, body: () => Promise<void>): Promise<void> {
	if (ONLY && ONLY !== name) return;
	await body();
	console.log(`ok ${name}`);
}

// A room too big for the window: the first read is fitted, every session that
// fits shown whole even behind an oldest one too long to show, and the prompt
// passes the same check the route runs.
await section("fitted", async () => {
	const room = createRoom("Fitted Room", 12, 4_000, 300, 60_000);
	const window = { contextWindow: 20_000, maxOutputTokens: 4_000 };
	const budget = agents.maintenancePromptTokenBudget?.(window) ?? 13_000;
	const prompts: string[] = [];
	const read = await buildAbsorbAssessment(room.agentId, MODEL, async (prompt) => {
		prompts.push(prompt);
		return { text: FIRST_READ };
	}, { resolveModelWindow: () => window });
	assert(prompts.length === 1 && read.assessmentMarkdown === FIRST_READ.trim() && read.firstReadMissing === undefined, `a room too big for the window still gets its first read, got ${prompts.length} call(s) and ${JSON.stringify(read.firstReadMissing)}`);
	const prompt = prompts[0]!;
	assert(estimateTokens(prompt) <= budget, `the fitted prompt passes the window check (${estimateTokens(prompt)} of ${budget} tokens)`);
	assert(!prompt.includes("POINT-1 ") && prompt.includes("POINT-2 "), "an oldest session too long to show never pushes out the ones behind it");
	const named = /(\d+) more (?:sessions are|session is) waiting and too long to show here; their headings:\n((?:### RC-.*\n?)+)/.exec(prompt);
	assert(named && Number(named[1]) === named[2]!.trim().split("\n").length && named[2]!.includes("### RC-0001 |"), `the sessions that do not fit are named by their headings and counted, got ${named?.[1]}`);
	const shownWhole = [...prompt.matchAll(/POINT-(\d+) /g)].length;
	assert(shownWhole >= 2 && shownWhole + Number(named[1]) === 12, `every session is either whole or named (${shownWhole} whole, ${named[1]} named)`);
	assert(/\((\d+) more entries are in memory and not shown here\.\)/.test(prompt), "the entries left out are counted");
	assert(prompt.includes("## Material: This Room's Memory") && !prompt.includes("## Material: Current L1b Memory State"), "the fitted material is sent, never the whole file");
});

// With no room at all, the material still says what it holds, so the prompt
// never falls back to the whole file; the first read is then missing.
await section("too-large", async () => {
	const room = createRoom("Tiny Window Room", 12, 4_000, 300);
	const material = buildAbsorbAssessmentMaterial(room.l1b, 0);
	assert(material.trim() !== "" && material.includes("### Sessions waiting (12)") && material.includes("12 more sessions are waiting and not shown here.") && material.includes("(300 more entries are in memory and not shown here.)"), `the material fitted to nothing is not empty and counts what it left out, got:\n${material}`);
	let ran = false;
	const read = await buildAbsorbAssessment(room.agentId, MODEL, async () => {
		ran = true;
		return { text: FIRST_READ };
	}, { resolveModelWindow: () => ({ contextWindow: 1_000, maxOutputTokens: 1_000 }) });
	assert(!ran && read.assessmentMarkdown === "None." && read.firstReadMissing === "too-large", `a window too small for any first read gives "None." without a call, got ${ran} and ${JSON.stringify(read.firstReadMissing)}`);
	const diagnostics = path.join(root, room.agentId, "events", "maintenance-diagnostics");
	const written = fs.existsSync(diagnostics) ? fs.readdirSync(diagnostics).filter((name) => name.endsWith(".json")).map((name) => fs.readFileSync(path.join(diagnostics, name), "utf-8")).join("\n") : "";
	assert(written.includes("first read missing: too-large") && written.includes('"provider": "openai-compatible"'), "a first read too large for the window is on the diagnostics, with its provider, though no call was made");
});

// No cliff: a material one character too long for its room keeps every
// session and gives up only the entry rows it must.
await section("no-cliff", async () => {
	const room = createRoom("No Cliff Room", 3, 300, 8);
	const whole = buildAbsorbAssessmentMaterial(room.l1b);
	const fitted = buildAbsorbAssessmentMaterial(room.l1b, whole.length - 1);
	const rows = [...fitted.matchAll(/^- m-\d+ ·/gm)].length;
	assert(fitted.length <= whole.length - 1, `the fitted material fits (${fitted.length} of ${whole.length - 1})`);
	assert([1, 2, 3].every((n) => fitted.includes(`POINT-${n} `)) && rows >= 5, `every session stays whole and most rows stay, got ${[...fitted.matchAll(/POINT-\d+ /g)].length} sessions and ${rows} of 8 rows`);
});

// A failed window lookup reads as unknown: the material is built whole, as
// before, and the lookup's words go nowhere.
await section("window-unknown", async () => {
	const room = createRoom("Unknown Window Room", 2, 200, 3);
	const prompts: string[] = [];
	const read = await buildAbsorbAssessment(room.agentId, MODEL, async (prompt) => {
		prompts.push(prompt);
		return { text: FIRST_READ };
	}, { resolveModelWindow: () => { throw new Error("model not found: openai-compatible/gpt-5.5"); } });
	assert(prompts.length === 1 && prompts[0]!.includes("POINT-2 ") && read.assessmentMarkdown === FIRST_READ.trim(), "a failed window lookup still gives the first read, built whole");
	assert(!JSON.stringify(read).includes("model not found"), "the lookup's words are nowhere in the answer");
});

// A call that fails is no first read: "None.", the one reason, no parser
// findings, and the source kept so Discuss first stays open.
await section("failed", async () => {
	const room = createRoom("Failed First Read Room", 2, 200, 3);
	const read = await buildAbsorbAssessment(room.agentId, MODEL, async (): Promise<AbsorbGenerateResult> => {
		throw new Error("provider error: the content was filtered");
	});
	assert(read.assessmentMarkdown === "None." && read.firstReadMissing === "failed", `a failed first read gives "None.", got ${JSON.stringify({ text: read.assessmentMarkdown, missing: read.firstReadMissing })}`);
	assert(read.warnings.length === 1 && read.warnings[0] === "no memory has been written", `and no missing-section warnings, got ${JSON.stringify(read.warnings)}`);
	assert(/^[a-f0-9]{64}$/.test(read.source.l1bFingerprint.value), "the source is kept, so the discussion can start from it");
	assert(!JSON.stringify(read).includes("content was filtered"), "the provider's words are nowhere in the answer");
	const diagnostics = path.join(root, room.agentId, "events", "maintenance-diagnostics");
	const written = fs.existsSync(diagnostics) ? fs.readdirSync(diagnostics, { recursive: true }).map(String).filter((name) => name.endsWith(".json")) : [];
	const text = written.map((name) => fs.readFileSync(path.join(diagnostics, name), "utf-8")).join("\n");
	assert(text.includes("first read missing: failed"), `the diagnostics record says why, got ${written.length} record(s)`);
});

// With no first read, the answer still lists the conversations waiting, from
// their headings, one per line with its date; a first read that came back lists none.
await section("waiting-list", async () => {
	const room = createRoom("Waiting List Room", 2, 200, 3);
	const read = await buildAbsorbAssessment(room.agentId, MODEL, async (): Promise<AbsorbGenerateResult> => {
		throw new Error("provider error: the content was filtered");
	});
	const listed = (read as { waitingConversations?: Array<{ title: string; date: string }> }).waitingConversations;
	assert(JSON.stringify(listed) === JSON.stringify([{ title: "Conversation 1", date: "2026-09-11" }, { title: "Conversation 2", date: "2026-09-11" }]), `a missing first read lists the waiting conversations by title and date, got ${JSON.stringify(listed)}`);
	const big = createRoom("Waiting List Big Room", 3, 4_000, 300);
	const tooLarge = await buildAbsorbAssessment(big.agentId, MODEL, async () => ({ text: FIRST_READ }), { resolveModelWindow: () => ({ contextWindow: 1_000, maxOutputTokens: 1_000 }) });
	assert((tooLarge as { waitingConversations?: unknown[] }).waitingConversations?.length === 3, "a first read too large for the window lists every waiting conversation, even those it could not show");
	const fine = await buildAbsorbAssessment(room.agentId, MODEL, async () => ({ text: FIRST_READ }));
	assert(!("waitingConversations" in fine), "a first read that came back carries no list");
	// A block written by hand, with no title or date, is named by its first line, never its id.
	const hand = createRoom("Waiting List Hand Room", 1, 200, 3);
	const l1bPath = path.join(root, hand.agentId, "L1b", "current.md");
	fs.writeFileSync(l1bPath, `${hand.l1b}\n### RC-0002 | OPEN\n\nCall the supplier about the delay.\nThey promised an answer by Friday.\n`, { mode: 0o600 });
	const handRead = await buildAbsorbAssessment(hand.agentId, MODEL, async (): Promise<AbsorbGenerateResult> => {
		throw new Error("provider error");
	});
	const handListed = (handRead as { waitingConversations?: Array<{ title: string; date?: string }> }).waitingConversations;
	assert(JSON.stringify(handListed) === JSON.stringify([{ title: "Conversation 1", date: "2026-09-11" }, { title: "Call the supplier about the delay." }]), `an untitled block is listed by its first line, with no date, got ${JSON.stringify(handListed)}`);
});

// The run starts on a missing or too long first read.
await section("propose", async () => {
	assert(parseAbsorbRunProposeRequest({}).assessmentMarkdown === "None.", "a run sent no first read folds with none");
	assert(parseAbsorbRunProposeRequest({ assessmentMarkdown: "   " }).assessmentMarkdown === "None.", "a blank first read is none");
	assert(parseAbsorbRunProposeRequest({ assessmentMarkdown: "x".repeat(20_001) }).assessmentMarkdown === "None.", "a first read too long to carry is none");
	assert(parseAbsorbRunProposeRequest({ assessmentMarkdown: FIRST_READ }).assessmentMarkdown === FIRST_READ.trim(), "a first read is carried as sent");
});

// The fold is told to follow the assessment only when there is one.
await section("fold-guidance", async () => {
	const room = createRoom("Fold Guidance Room", 1, 200, 3);
	const session = { id: "RC-0001", date: "2026-09-11", text: page("RC-0001", "Conversation 1", "POINT-1") };
	const promptFor = (assessmentMarkdown: string) => buildFoldPrompt({ agentId: room.agentId, model: MODEL, coreContext: "", areas: [], assessmentMarkdown, session, sessionIndex: 1, sessionCount: 1 }).prompt;
	const without = promptFor("None.");
	assert(without.includes("## Material: Signed-Off Assessment\n\nNone.") && without.includes("The user signed off without further instructions.") && !without.includes("Follow the assessment."), "without a first read the fold is not told to follow one");
	assert(!promptFor("").includes("Follow the assessment."), "nor with an empty one");
	assert(promptFor(FIRST_READ).includes("The user signed off without further instructions. Follow the assessment."), "with a first read it still is");
});

fs.rmSync(tempHome, { recursive: true, force: true });
console.log("absorb-first-read smoke passed");
