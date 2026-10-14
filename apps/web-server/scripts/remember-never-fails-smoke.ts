// Remember never fails while the Memory model answers.
//
// Pins the 0.14.3 Remember (design section 3): a refused part is read again in
// halves with the high-level lines; a stretch still refused leaves no words in
// the notes or the page, and the final call is told once that its messages
// were not read; a refused final call gets a page built by code from the
// notes, its title from their words; a keep-request the entry lost is put
// back; a reply cut at the output cap climbs the ladder down to a salvage;
// the checks Save makes are repaired before the preview; a memory too big for
// the window is read as its short view. Remember is a job: it finishes when
// the tab that started it goes away, a second tab attaches to it, Cancel stops
// it, and a part already read is never paid for twice (the parts cache).
//
// Offline: a fake Memory model, no server, no network.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PersistentAgentPiSessionJsonlThreadRuntime } from "../src/persistent-agents.js";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "remember-never-fails-home-"));
const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "remember-never-fails-cwd-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const smokeAppDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(smokeAppDir, { recursive: true });
fs.writeFileSync(path.join(smokeAppDir, "openai-compatible-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }], maintenanceModel: "gpt-5.5" }, null, 2));
fs.writeFileSync(path.join(smokeAppDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
process.env.EXXPERTS_CODING_AGENT_DIR = path.join(tempHome, ".exxperts", "agent");
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = path.join(smokeAppDir, "personalized-agents");
// Small parts, so a short synthetic conversation is read in several.
process.env.EXXPERTS_REMEMBER_PART_CAP_TOKENS = "12000";

const pa = await import("../src/persistent-agents.js");
const { REMEMBER_PART_TRIGGER, buildRememberPageFromNotes } = await import("../src/remember-two-stage.js");
const { ModelUnreachableError } = await import("../src/model-call-causes.js");
const { listMaintenanceDiagnostics } = await import("../src/maintenance-diagnostics.js");

/** A refused part read that goes on to a high-level read or to halves says so in its diagnostics record, never a bare error. */
function assertRefusedPartsRecorded(room: { agentId: string }): void {
	const records = listMaintenanceDiagnostics(pa.createPersistentAgentInstance(room.agentId).rootDir, 200).filter((record) => record.process === "remember-part");
	assert(records.some((record) => record.outcome === "refused"), "the refused part read is recorded as refused");
	assert(!records.some((record) => record.outcome === "error"), `no part read is left as a bare error, got ${records.map((record) => record.outcome).join(", ")}`);
}
const { writePersistentAgentAiProfileState } = await import("../src/persistent-agent-ai-profile-state.js");
writePersistentAgentAiProfileState("openai-compatible");

const model = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" };
const SENSITIVE = "SENSITIVE-STRETCH";
const HIGH_LEVEL = /at a high level/i;
const SAFETY_NET = /could not be summarized/i;
/** The page when every call was refused (decision 40): the dated title as title, arc and the one point; nothing else. */
const DATED_ONLY = /^### RC-DRAFT \| CLOSED \| \d{4}-\d{2}-\d{2} \| (Conversation of \d{4}-\d{2}-\d{2})\n\n\*\*Session arc:\*\* \1\n\n\*\*Body:\*\*\n- \1\n\n\*\*Parked:\*\*\nNone\.?\n*$/;
const PAGE = "TITLE:\nThe launch plan\n\nSESSION_ARC:\nWe planned the launch.\n\nBODY:\n- The launch moves to May.\n\nPARKED:\nNone\n";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const failures: string[] = [];
async function section(label: string, run: () => Promise<void>): Promise<void> {
	try {
		await run();
		console.log(`  ok  ${label}`);
	} catch (error) {
		failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
		console.log(`  FAIL ${label}`);
	}
}

let rooms = 0;
/** A room whose conversation is long enough for several parts; one message in the middle carries `marker` when given, or `turns` as given. */
function roomWithConversation(label: string, options: { marker?: string; messages?: number; turns?: Array<Record<string, unknown>> } = {}) {
	rooms += 1;
	const displayName = `Never Fails ${label} ${rooms}`;
	pa.createPersistentAgentFromScaffoldInput({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	const agentId = displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
	const threadId = `pi_never_${rooms}`;
	const written = pa.writePersistentAgentThread(agentId, threadId, { state: "active", origin: "home", model, items: [] }, {
		createRuntime: ({ model }) => pa.createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId, model, cwd: tempCwd }),
	});
	const session = pa.openPersistentAgentPiSessionManager(agentId, written.thread.runtime as PersistentAgentPiSessionJsonlThreadRuntime, tempCwd);
	options.turns?.forEach((turn, index) => session.appendMessage({ ...turn, timestamp: Date.now() + index } as any));
	const count = options.turns ? 0 : options.messages ?? 200; // three parts of at most 12k, and the end
	for (let index = 0; index < count; index++) {
		const marker = options.marker && index === Math.floor(count / 2) ? ` ${options.marker}` : "";
		session.appendMessage({ role: index % 2 ? "assistant" : "user", content: `Message ${index} STRETCH-${index}:${marker} ${"We weighed the launch date, the budget and who signs off. ".repeat(10)}`, timestamp: Date.now() + index } as any);
	}
	return { agentId, threadId };
}

type Call = { prompt: string; part: boolean; signal?: AbortSignal };
/** A fake Memory model: `answer` decides each call; every call is recorded. */
function fakeModel(answer: (call: Call) => { text: string; truncated?: boolean } | Error) {
	const calls: Call[] = [];
	const generate = async (prompt: string, _model: unknown, call?: { trigger?: string; signal?: AbortSignal }) => {
		const record = { prompt, part: call?.trigger === REMEMBER_PART_TRIGGER, signal: call?.signal };
		calls.push(record);
		const result = answer(record);
		if (result instanceof Error) throw result;
		return { text: result.text, truncated: result.truncated ?? false, usage: { input: 1, output: 1, totalTokens: 2, cost: 0 } };
	};
	return { calls, generate };
}

const tooLong = () => Object.assign(new Error("checkpoint compression worker failed: prompt is too long: 1048576 tokens > 1000000 maximum"), { providerMessage: "prompt is too long: 1048576 tokens > 1000000 maximum" });
const refusal = () => Object.assign(new Error("checkpoint compression worker failed: the model refused to answer this request"), { providerMessage: "the model refused to answer this request" });
const NOTES = "DECISIONS:\n- The launch moves to May.\n\nOPEN:\nNone\n\nMUST_KEEP:\nNone\n";

function propose(room: { agentId: string; threadId: string }, generate: any, options: Record<string, unknown> = {}) {
	// A window is what gives Remember a budget, and the budget is what splits a conversation into parts.
	// A small one (a budget of 20k, at most 6k for the verbatim end), so the end cannot hold the whole conversation.
	return pa.buildCheckpointProposal({ agentId: room.agentId, conversationId: room.threadId, model, density: "standard", runtimeCwd: tempCwd }, generate, { resolveModelWindow: () => ({ contextWindow: 40_000, maxOutputTokens: 16_000 }), ...options } as any);
}

function pageOf(proposal: any): string {
	return String(proposal?.proposedRecentContext ?? "");
}

try {
	await section("the synthetic conversation is read in parts", async () => {
		const room = roomWithConversation("baseline");
		const fake = fakeModel((call) => ({ text: call.part ? NOTES : PAGE }));
		await propose(room, fake.generate);
		assert(fake.calls.filter((call) => call.part).length >= 2, `expected at least two parts, got ${fake.calls.filter((call) => call.part).length}`);
	});

	// The part ceiling is a setting (not decided yet; none by default). At any
	// setting a conversation of about 30k tokens is remembered, never refused,
	// and the verbatim end is never larger than a part.
	for (const ceiling of ["24000", undefined]) await section(`a conversation of about 30k tokens on a large window is remembered with ${ceiling ? `a ${ceiling}-token part ceiling, in parts` : "no part ceiling, in one pass"}`, async () => {
		const room = roomWithConversation(`thirty thousand ${ceiling ?? "none"}`);
		const fake = fakeModel((call) => ({ text: call.part ? NOTES : PAGE }));
		const cap = process.env.EXXPERTS_REMEMBER_PART_CAP_TOKENS;
		if (ceiling) process.env.EXXPERTS_REMEMBER_PART_CAP_TOKENS = ceiling;
		else delete process.env.EXXPERTS_REMEMBER_PART_CAP_TOKENS;
		let proposal: any;
		try {
			proposal = await propose(room, fake.generate, { resolveModelWindow: () => ({ contextWindow: 200_000, maxOutputTokens: 16_000 }) });
		} finally {
			process.env.EXXPERTS_REMEMBER_PART_CAP_TOKENS = cap;
		}
		const parts = fake.calls.filter((call) => call.part).length;
		const final = fake.calls.find((call) => !call.part)!;
		assert(/launch moves to May/.test(pageOf(proposal)), "the page comes");
		if (ceiling) {
			assert(parts >= 1, `a conversation over the ceiling is read in parts, got ${parts}`);
			assert(final.prompt.length < 30 * 1_000 * 4, "the final call holds the notes and an end no larger than a part, not the whole conversation");
		} else {
			assert(parts === 0, `with no ceiling a conversation that fits is read in one pass, got ${parts} parts`);
		}
	});

	// Forget is the trash icon: a part that answers after it keeps no note, whatever started the read.
	await section("a part that answers after Forget keeps no note", async () => {
		const room = roomWithConversation("forget mid read");
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const calls: string[] = [];
		const generate = async (_prompt: string, _model: unknown, call?: { trigger?: string }) => {
			const part = call?.trigger === REMEMBER_PART_TRIGGER;
			calls.push(part ? "part" : "final");
			if (part) await gate;
			return { text: part ? NOTES : PAGE, truncated: false, usage: { input: 1, output: 1, totalTokens: 2, cost: 0 } };
		};
		const reading = propose(room, generate).catch(() => null);
		const deadline = Date.now() + 10_000;
		while (!calls.includes("part")) { assert(Date.now() < deadline, "a part is being read"); await new Promise((resolve) => setTimeout(resolve, 2)); }
		pa.writePersistentAgentMementoBoundary(room.agentId, room.threadId, new Date(), { runtimeCwd: tempCwd });
		release();
		await reading;
		const work = path.join(tempHome, ".exxperts", "app", "personalized-agents", room.agentId, "runtime", "remember", room.threadId);
		assert(!fs.existsSync(work) || fs.readdirSync(work).length === 0, `no note of the forgotten conversation is kept, got ${fs.existsSync(work) ? fs.readdirSync(work).join(",") : "none"}`);
	});

	await section("a refusal on one part is read again in halves with the high-level lines, and the page has no safety-net line", async () => {
		const room = roomWithConversation("part refusal", { marker: SENSITIVE });
		const fake = fakeModel((call) => (call.part && call.prompt.includes(SENSITIVE) && !HIGH_LEVEL.test(call.prompt) ? refusal() : { text: call.part ? NOTES : PAGE }));
		const proposal = await propose(room, fake.generate);
		assert(fake.calls.some((call) => call.part && call.prompt.includes(SENSITIVE) && HIGH_LEVEL.test(call.prompt)), "the refused stretch is asked again with the high-level lines");
		assert(!SAFETY_NET.test(pageOf(proposal)), "a stretch read at a high level needs no safety-net line");
		assertRefusedPartsRecorded(room);
	});

	await section("a stretch refused at every depth still gives a page, with no line about it", async () => {
		const room = roomWithConversation("persistent refusal", { marker: SENSITIVE });
		const fake = fakeModel((call) => (call.part && call.prompt.includes(SENSITIVE) ? refusal() : { text: call.part ? NOTES : PAGE }));
		const proposal = await propose(room, fake.generate);
		assert(/launch moves to May/.test(pageOf(proposal)) && !SAFETY_NET.test(pageOf(proposal)), "the page comes, with no safety-net line");
		assert(fake.calls.filter((call) => call.part && call.prompt.includes(SENSITIVE)).length <= 4, "the split stops at quarters");
	});

	await section("a final call refused twice gets a page built by code from the notes", async () => {
		const room = roomWithConversation("final refusal");
		const fake = fakeModel((call) => (call.part ? { text: NOTES } : refusal()));
		const proposal = await propose(room, fake.generate);
		assert(/launch moves to May/.test(pageOf(proposal)) && !SAFETY_NET.test(pageOf(proposal)), "the page is built from the notes, and with every part read it claims none was left unread");
		assert(fake.calls.filter((call) => !call.part).length === 2, `the final call is asked twice, got ${fake.calls.filter((call) => !call.part).length}`);
	});

	await section("a reply cut at the output cap climbs the ladder down to a salvage, and Save accepts it", async () => {
		const room = roomWithConversation("cut reply", { messages: 6 });
		const cut = "TITLE:\nThe launch plan\n\nSESSION_ARC:\nWe planned the launch.\n\nPARKED:\nNone\n\nBODY:\n- The launch moves to May.\n\n- A second paragraph that was cut mid";
		const fake = fakeModel(() => ({ text: cut, truncated: true }));
		const proposal = await propose(room, fake.generate);
		assert(fake.calls.length <= 3, `at most three tries, got ${fake.calls.length}`);
		assert(/launch moves to May/.test(pageOf(proposal)), "the salvage keeps the complete paragraphs");
		pa.parseCheckpointApprovalRequest({ conversationId: room.threadId, model, density: proposal.density, proposal, approvedRecentContext: pageOf(proposal) }, room.agentId);
	});

	// chars/4 undercounts some tokenizers, so the provider can call a prompt
	// too long that the estimate let through. That never fails a Remember.
	await section("a single pass the provider calls too long is read in parts", async () => {
		const room = roomWithConversation("too long single", { messages: 6 });
		const fake = fakeModel((call) => (!call.part && !fake.calls.some((earlier) => earlier.part) ? tooLong() : { text: call.part ? NOTES : PAGE }));
		const proposal = await propose(room, fake.generate);
		assert(fake.calls.some((call) => call.part) && /launch moves to May/.test(pageOf(proposal)), "the conversation is read in parts and the page comes");
	});

	// A gateway can refuse a prompt it counts too long in words no rule knows. While the Memory model
	// answers the probe, a single pass that failed for any such cause is read in parts, as a too-long one is.
	const unknownTooBig = () => Object.assign(new Error("checkpoint compression worker failed: 400 upstream rejected the request: the payload is more than this deployment accepts"), { providerMessage: "400 upstream rejected the request: the payload is more than this deployment accepts" });
	await section("a single pass refused in words no rule knows is read in parts while the model answers", async () => {
		const room = roomWithConversation("unknown words single", { messages: 6 });
		let limit = 0;
		const fake = fakeModel((call) => {
			limit ||= call.prompt.length;
			return call.prompt.length >= limit ? unknownTooBig() : { text: call.part ? NOTES : PAGE };
		});
		let probes = 0;
		const outcome = await propose(room, fake.generate, { patience: { sleep: async () => {}, probe: async () => { probes += 1; } } }).then((proposal) => proposal, (error) => error);
		assert(!(outcome instanceof Error), `Remember gives a page, got ${outcome instanceof Error ? outcome.message : outcome}`);
		assert(probes === 1, `the model is asked once whether it answers, got ${probes}`);
		assert(fake.calls.some((call) => call.part) && /launch moves to May/.test(pageOf(outcome)), "the conversation is read in parts and the page comes");
		pa.parseCheckpointApprovalRequest({ conversationId: room.threadId, model, density: outcome.density, proposal: outcome, approvedRecentContext: pageOf(outcome) }, room.agentId);
	});

	await section("a single pass that fails while the model no longer answers ends in the one notice, and no part is asked", async () => {
		const room = roomWithConversation("unknown words down", { messages: 6 });
		const fake = fakeModel(() => unknownTooBig());
		const outcome = await propose(room, fake.generate, { patience: { sleep: async () => {}, probe: async () => { throw new Error("worker failed: the probe produced no text"); } } }).then(() => "a page", (error) => error);
		assert(outcome instanceof ModelUnreachableError, `the one notice, got ${outcome instanceof Error ? `${outcome.name}: ${outcome.message}` : outcome}`);
		assert(!fake.calls.some((call) => call.part), `no part is asked, got ${fake.calls.filter((call) => call.part).length}`);
	});

	await section("a failure not about size, at every size, stops Remember after a bounded number of calls", async () => {
		const room = roomWithConversation("unknown words everywhere", { messages: 6 });
		const fake = fakeModel(() => unknownTooBig());
		let probes = 0;
		const outcome = await propose(room, fake.generate, { patience: { sleep: async () => {}, probe: async () => { probes += 1; } } }).then(() => "a page", (error) => error);
		assert(outcome instanceof Error && !(outcome instanceof ModelUnreachableError), `Remember stops with its plain stop, not the notice, got ${outcome instanceof Error ? outcome.name : outcome}`);
		// The single pass, one probe, then the parts read side by side: each tried twice, then halved down to
		// REMEMBER_SPLIT_DEPTH, until the first stretch that outlasts its halves stops them all.
		assert(probes === 1 && fake.calls.length === 9 && fake.calls.filter((call) => call.part).length === 8, `the single pass and eight part reads, with one probe, got ${fake.calls.length} calls (${fake.calls.filter((call) => call.part).length} part reads) and ${probes} probes`);
	});

	await section("a part the provider calls too long goes to halves at once, never asked the same twice", async () => {
		const room = roomWithConversation("too long part", { marker: SENSITIVE });
		let tooLongPrompt: string | null = null;
		const fake = fakeModel((call) => {
			if (call.part && call.prompt.includes(SENSITIVE) && (tooLongPrompt === null || tooLongPrompt === call.prompt)) {
				tooLongPrompt = call.prompt;
				return tooLong();
			}
			return { text: call.part ? NOTES : PAGE };
		});
		const proposal = await propose(room, fake.generate);
		const repeats = fake.calls.filter((call) => call.prompt === tooLongPrompt).length;
		assert(repeats === 1, `the part called too long is not asked again as it was, got ${repeats} identical calls`);
		assert(!SAFETY_NET.test(pageOf(proposal)) && /launch moves to May/.test(pageOf(proposal)), "its halves are read and the page comes whole");
	});

	await section("a final call the provider calls too long still gives a page", async () => {
		const room = roomWithConversation("too long final");
		const fake = fakeModel((call) => (call.part ? { text: NOTES } : tooLong()));
		const proposal = await propose(room, fake.generate);
		assert(/launch moves to May/.test(pageOf(proposal)), "the page comes from what was read");
	});

	await section("a page over 8,000 characters outside BODY is fitted, and Save accepts it", async () => {
		const room = roomWithConversation("long arc and parked", { messages: 6 });
		const lines = (label: string) => Array.from({ length: 200 }, (_, index) => `- ${label} ${index}: who signs off on the budget line`).join("\n");
		const text = `TITLE:\nThe launch plan\n\nSESSION_ARC:\n${lines("Arc step")}\n\nBODY:\n- The launch moves to May.\n\nPARKED:\n${lines("Open thread")}\n`;
		const proposal = await propose(room, fakeModel(() => ({ text })).generate);
		assert(pageOf(proposal).length <= 8_000 && /launch moves to May/.test(pageOf(proposal)), `the page fits and keeps its body, got ${pageOf(proposal).length} characters`);
		pa.parseCheckpointApprovalRequest({ conversationId: room.threadId, model, density: proposal.density, proposal, approvedRecentContext: pageOf(proposal) }, room.agentId);
	});

	await section("a page cut to fit keeps the keep-requests put back", async () => {
		const room = roomWithConversation("long page with a lost keep-request");
		const long = Array.from({ length: 40 }, (_, index) => `- Point ${index}: ${"the launch moves to May and the budget holds. ".repeat(6)}`).join("\n\n");
		const keepNotes = NOTES.replace("MUST_KEEP:\nNone\n", "MUST-KEEP:\n- \"remember the code word\": Bluebird\n");
		const fake = fakeModel((call) => ({ text: call.part ? keepNotes : PAGE.replace("- The launch moves to May.", long) }));
		const proposal = await propose(room, fake.generate);
		assert(pageOf(proposal).length <= 8_000 && pageOf(proposal).includes('- "remember the code word": Bluebird'), "the fit keeps the request put back");
	});

	await section("a single pass answered in prose three times is read in parts", async () => {
		const room = roomWithConversation("prose single", { messages: 6 });
		const fake = fakeModel((call) => (call.part ? { text: NOTES } : fake.calls.some((earlier) => earlier.part) ? { text: PAGE } : { text: "I would rather tell you about it in my own words." }));
		const proposal = await propose(room, fake.generate);
		assert(fake.calls.some((call) => call.part) && /launch moves to May/.test(pageOf(proposal)) && /The launch plan/.test(pageOf(proposal)), "the conversation is read in parts and the page has content");
	});

	await section("a final call answered in prose three times gets its BODY from the notes", async () => {
		const room = roomWithConversation("prose final");
		const fake = fakeModel((call) => ({ text: call.part ? NOTES : "I would rather tell you about it in my own words." }));
		const proposal = await propose(room, fake.generate);
		assert(/launch moves to May/.test(pageOf(proposal)), "the BODY holds what the notes hold");
		pa.parseCheckpointApprovalRequest({ conversationId: room.threadId, model, density: proposal.density, proposal, approvedRecentContext: pageOf(proposal) }, room.agentId);
	});

	await section("the checks Save makes are repaired before the preview", async () => {
		const room = roomWithConversation("repairs", { messages: 6 });
		const broken = "TITLE:\nThe launch plan\n\nSESSION_ARC:\n\nBODY:\n## Decisions\n- The launch moves to May. <!-- hidden -->\n### More\n- Budget agreed.\n\nPARKED:\n\n";
		const fake = fakeModel(() => ({ text: broken }));
		const proposal = await propose(room, fake.generate);
		const page = pageOf(proposal);
		assert(!/^#{2,3} /m.test(page.split("**Body:**")[1] ?? "") && !page.includes("<!--"), "no heading line and no comment is left in the body");
		pa.parseCheckpointApprovalRequest({ conversationId: room.threadId, model, density: proposal.density, proposal, approvedRecentContext: page }, room.agentId);
		assert(fake.calls.length === 1, `repairs cost no call, got ${fake.calls.length}`);
	});

	await section("a memory too big for the window is read as its short view", async () => {
		const room = roomWithConversation("short memory", { messages: 6 });
		const { loadMemoryDocument, writeMemoryDocument } = await import("../src/memory-entries-store.js");
		const doc = loadMemoryDocument(room.agentId).doc;
		// Deep Memory notes, as their name says (the scaffold's first topic is Active Items).
		const topic = { section: "Deep Memory", title: "Launch Details", heading: "### Launch Details", intro: "", entries: [] } as any;
		doc.topics.unshift(topic);
		const template = doc.topics.flatMap((each) => each.entries)[0] ?? {};
		for (let index = 0; index < 400; index++) topic.entries.push({ ...template, kind: "fact", status: undefined, id: `E-BIG-${index}`, text: `DEEP-NOTE-${index} ${"a remembered detail ".repeat(20)}` } as any);
		writeMemoryDocument(room.agentId, doc, { why: "edit", snapshotLabel: "edit" } as any);
		const fake = fakeModel((call) => ({ text: call.part ? NOTES : PAGE }));
		const estimate = (contextWindow: number, maxOutputTokens: number) => pa.estimateCheckpointRead({ agentId: room.agentId, conversationId: room.threadId, runtimeCwd: tempCwd }, { model, resolveModelWindow: () => ({ contextWindow, maxOutputTokens }) });
		assert(estimate(200_000, 16_000).fits === "full", `a large window holds the whole memory, got ${estimate(200_000, 16_000).fits}`);
		assert(estimate(200_000, 16_000).mode === "one-pass", "the 24k cap is on the conversation: a large memory never pushes a short conversation into parts");
		assert(estimate(32_000, 8_000).fits === "short-memory", `the dialog is told the memory goes as its short view, got ${estimate(32_000, 8_000).fits}`);
		let tiny: unknown;
		try { tiny = estimate(6_000, 2_000).fits; } catch (error) { tiny = error instanceof Error ? error.message : error; }
		assert(tiny === "no", `a window too small for anything says so before Generate, got ${String(tiny)}`);
		const proposal = await propose(room, fake.generate, { resolveModelWindow: () => ({ contextWindow: 32_000, maxOutputTokens: 8_000 }) });
		const final = fake.calls.filter((call) => !call.part).at(-1)!;
		assert(pageOf(proposal).includes("launch moves to May"), "the page comes");
		assert(!final.prompt.includes("DEEP-NOTE-1 ") && final.prompt.includes(topic.title), "the final call carries the topic titles, not every note");
	});

	await section("a refused single pass beside a memory that nearly fills the window is read in parts with the memory's short view", async () => {
		const room = roomWithConversation("nearly full window", { messages: 6 });
		const { loadMemoryDocument, writeMemoryDocument } = await import("../src/memory-entries-store.js");
		const doc = loadMemoryDocument(room.agentId).doc;
		const topic = { section: "Deep Memory", title: "Launch Details", heading: "### Launch Details", intro: "", entries: [] } as any;
		doc.topics.unshift(topic);
		const template = doc.topics.flatMap((each) => each.entries)[0] ?? {};
		for (let index = 0; index < 120; index++) topic.entries.push({ ...template, kind: "fact", status: undefined, id: `E-NEAR-${index}`, text: `NEAR-NOTE-${index} ${"a remembered detail ".repeat(20)}` } as any);
		writeMemoryDocument(room.agentId, doc, { why: "edit", snapshotLabel: "edit" } as any);
		// The smallest window that still reads this conversation in one pass beside the whole memory.
		let contextWindow = 0;
		for (let candidate = 8_000; candidate <= 400_000 && !contextWindow; candidate += 250) {
			const estimate = pa.estimateCheckpointRead({ agentId: room.agentId, conversationId: room.threadId, runtimeCwd: tempCwd }, { model, resolveModelWindow: () => ({ contextWindow: candidate, maxOutputTokens: 4_000 }) });
			if (estimate.fits === "full" && estimate.mode === "one-pass") contextWindow = candidate;
		}
		assert(contextWindow > 0, "a window that reads it in one pass exists");
		const fake = fakeModel((call) => (call.part ? { text: NOTES } : fake.calls.some((earlier) => earlier.part) ? { text: PAGE } : refusal()));
		const proposal = await propose(room, fake.generate, { resolveModelWindow: () => ({ contextWindow, maxOutputTokens: 4_000 }) });
		assert(fake.calls.some((call) => call.part) && /launch moves to May/.test(pageOf(proposal)), "the refused single pass is read in parts and the page comes");
	});

	// A refused single pass is read again in parts of at most half of it, so
	// the verbatim end can never hold it all, on a window that holds it whole:
	// a conversation of two short messages, and one whose tool output the
	// prompt trims (its raw text is more than twice what the parts read).
	const largeWindow = { resolveModelWindow: () => ({ contextWindow: 1_000_000, maxOutputTokens: 64_000 }) };
	const shortTurns = [
		{ role: "user", content: "Can you suggest a name for a small bakery on a quiet street?" },
		{ role: "assistant", content: "A few to try: Rise and Shine, The Daily Crumb, Flour Power. Pick the one that sounds like your street, then check that the name is free." },
	];
	for (const everywhere of [false, true]) await section(everywhere ? "a short conversation refused at every call still gets a page" : "a refused single pass of a short conversation is read in parts of at most half of it, and the page comes", async () => {
		const room = roomWithConversation(`short refused ${everywhere ? "everywhere" : "once"}`, { turns: shortTurns });
		const fake = fakeModel((call) => (call.part ? (everywhere ? refusal() : { text: NOTES }) : everywhere || !fake.calls.some((earlier) => earlier.part) ? refusal() : { text: PAGE }));
		const proposal = await propose(room, fake.generate, largeWindow);
		const parts = fake.calls.filter((call) => call.part);
		assert(parts.length > 0 && parts.every((call) => !(call.prompt.includes("small bakery") && call.prompt.includes("Daily Crumb"))), `the conversation is read in parts, none holding all of it, got ${parts.length} part call(s)`);
		assert(everywhere ? DATED_ONLY.test(pageOf(proposal)) : /launch moves to May/.test(pageOf(proposal)) && !SAFETY_NET.test(pageOf(proposal)), `the page comes, got ${pageOf(proposal)}`);
	});

	// A refused part of one short message cannot be halved: it is read once
	// more, whole, with the high-level lines before it gets the safety net.
	await section("a refused part that cannot be halved is read again at a high level, and the page has no safety-net line", async () => {
		const room = roomWithConversation("short refused part", { turns: shortTurns });
		const fake = fakeModel((call) => (call.part ? (call.prompt.includes("small bakery") && !HIGH_LEVEL.test(call.prompt) ? refusal() : { text: NOTES }) : fake.calls.some((earlier) => earlier.part) ? { text: PAGE } : refusal()));
		const page = pageOf(await propose(room, fake.generate, largeWindow));
		assert(/launch moves to May/.test(page) && !SAFETY_NET.test(page), `the page comes with no safety-net line, got ${page.split("could not be summarized").length - 1} safety-net line(s)`);
		assert(fake.calls.filter((call) => call.part && call.prompt.includes("small bakery") && HIGH_LEVEL.test(call.prompt)).length === 1, "the refused part is asked once more, whole, with the high-level lines");
		assertRefusedPartsRecorded(room);
	});

	await section("a refused single pass whose tool output the prompt trims is read in parts, and the page comes", async () => {
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		const room = roomWithConversation("trimmed tool output", { turns: [
			{ role: "user", content: "What is in the release folder?" },
			{ role: "assistant", content: [{ type: "text", text: "Listing it." }, { type: "toolCall", id: "call_list_1", name: "bash", arguments: { command: "ls release" } }], api: "openai-responses", provider: model.provider, model: model.model, usage, stopReason: "toolUse" },
			{ role: "toolResult", toolCallId: "call_list_1", toolName: "bash", content: [{ type: "text", text: "release-file-line ".repeat(4_000) }], isError: false },
			{ role: "assistant", content: "The folder holds the release files." },
		] });
		const fake = fakeModel((call) => (call.part ? { text: NOTES } : fake.calls.some((earlier) => earlier.part) ? { text: PAGE } : refusal()));
		const proposal = await propose(room, fake.generate, largeWindow);
		assert(fake.calls.some((call) => call.part) && /launch moves to May/.test(pageOf(proposal)), "the conversation is read in parts and the page comes");
	});

	await section("a note that came in as another part met an unreachable model is kept", async () => {
		const room = roomWithConversation("unreachable lane", { marker: SENSITIVE });
		const generate = async (prompt: string, _model: unknown, call?: { trigger?: string }) => {
			const part = call?.trigger === REMEMBER_PART_TRIGGER;
			await new Promise((resolve) => setTimeout(resolve, part && prompt.includes(SENSITIVE) ? 50 : 300));
			if (part && prompt.includes(SENSITIVE)) throw new ModelUnreachableError("not-answering", model);
			return { text: part ? NOTES : PAGE, truncated: false, usage: { input: 1, output: 1, totalTokens: 2, cost: 0 } };
		};
		let failed = false;
		await propose(room, generate).catch(() => { failed = true; });
		assert(failed, "the Remember stops on the unreachable model");
		await new Promise((resolve) => setTimeout(resolve, 500)); // the other lanes' replies come in
		const { countRememberPartNotes } = await import("../src/remember-parts-cache.js");
		assert(countRememberPartNotes(pa.createPersistentAgentInstance(room.agentId).rootDir, room.threadId) >= 1, "the notes the other lanes finished are kept");
	});

	await section("the notes a Remember kept go at Save and at Forget", async () => {
		const workDir = (room: { agentId: string; threadId: string }) => path.join(pa.createPersistentAgentInstance(room.agentId).rootDir, "runtime", "remember", room.threadId);
		const saved = roomWithConversation("kept then saved");
		const proposal = await propose(saved, fakeModel((call) => ({ text: call.part ? NOTES : PAGE })).generate);
		assert(fs.existsSync(workDir(saved)), "the part notes are kept while the proposal waits");
		const parsed = pa.parseCheckpointApprovalRequest({ conversationId: saved.threadId, model, density: proposal.density, proposal, approvedRecentContext: pageOf(proposal) }, saved.agentId);
		pa.writeApprovedCheckpoint(parsed.request, parsed.warnings, new Date(), { runtimeCwd: tempCwd });
		assert(!fs.existsSync(workDir(saved)), "Save deletes the kept notes");
		const forgotten = roomWithConversation("kept then forgotten");
		await propose(forgotten, fakeModel((call) => ({ text: call.part ? NOTES : PAGE })).generate);
		pa.writePersistentAgentMementoBoundary(forgotten.agentId, forgotten.threadId, new Date(), { runtimeCwd: tempCwd });
		assert(!fs.existsSync(workDir(forgotten)), "Forget deletes the kept notes");
	});

	// --- The job -----------------------------------------------------------------
	const job = await import("../src/remember-job.js").catch((error: Error) => error);
	await section("a Remember whose tab went away finishes, and its proposal is kept for the dialog", async () => {
		assert(!(job instanceof Error), `remember-job.ts: ${job instanceof Error ? job.message : ""}`);
		const room = roomWithConversation("closed tab", { messages: 6 });
		const fake = fakeModel(() => ({ text: PAGE }));
		const started = (job as any).startRememberJob(room.agentId, room.threadId, (signal: AbortSignal) => propose(room, fake.generate, { signal }));
		await (job as any).rememberJobSettled(room.agentId, room.threadId);
		const view = (job as any).getRememberJob(room.agentId, room.threadId);
		assert(view?.jobId === started.jobId && view.state === "done" && /launch moves to May/.test(pageOf(view.proposal)), "the job finished with no one waiting on it");
		assert(fs.existsSync(path.join(pa.createPersistentAgentInstance(room.agentId).rootDir, "runtime", "remember", room.threadId, "proposal.json")), "the proposal is kept on disk for the reopened dialog");
	});

	await section("a finished page that cannot be stored on this computer ends in a plain line, never in the unexpected stop", async () => {
		assert(!(job instanceof Error), "remember-job.ts is missing");
		const room = roomWithConversation("disk refuses", { messages: 6 });
		const work = path.join(pa.createPersistentAgentInstance(room.agentId).rootDir, "runtime", "remember", room.threadId);
		(job as any).startRememberJob(room.agentId, room.threadId, async () => {
			// The disk refuses the write (full, or a file another program holds): the folder is made read-only.
			fs.chmodSync(work, 0o500);
			return { proposedRecentContext: "done" };
		});
		try {
			await (job as any).rememberJobSettled(room.agentId, room.threadId);
		} finally {
			fs.chmodSync(work, 0o700);
		}
		const view = (job as any).getRememberJob(room.agentId, room.threadId);
		const { isPlainRememberSentence } = await import("../../web-ui/src/remember-read.js");
		const message = view?.error instanceof Error ? view.error.message : String(view?.error);
		assert(view?.state === "failed" && isPlainRememberSentence(message) && /Nothing was saved\./.test(message) && !/EACCES|ENOSPC|rename|proposal\.json/.test(message), `the job ends in a plain line, got ${view?.state}: ${message}`);
	});

	await section("a restart while Remember reads is said whenever the room is opened, until Remember starts again or it is discarded", async () => {
		assert(!(job instanceof Error), "remember-job.ts is missing");
		const room = roomWithConversation("restart mid-read", { messages: 6 });
		(job as any).startRememberJob(room.agentId, room.threadId, () => new Promise(() => {}));
		(job as any).forgetRememberJobsForTests();
		assert((job as any).getRememberJob(room.agentId, room.threadId) === null, "after the restart no job is reading");
		assert((job as any).takeRestartedRemember(room.agentId, room.threadId) === true, "the room learns a Remember was cut by the restart");
		assert((job as any).takeRestartedRemember(room.agentId, room.threadId) === true, "and says it again to a tab that comes later: a read that used it up left the room with no word");
		(job as any).discardRememberJob(room.agentId, room.threadId);
		assert((job as any).takeRestartedRemember(room.agentId, room.threadId) === false, "after Discard it is not said");
		const again = roomWithConversation("restart then generate again", { messages: 6 });
		(job as any).startRememberJob(again.agentId, again.threadId, () => new Promise(() => {}));
		(job as any).forgetRememberJobsForTests();
		assert((job as any).takeRestartedRemember(again.agentId, again.threadId) === true, "a second room learns its Remember was cut");
		(job as any).startRememberJob(again.agentId, again.threadId, async () => ({ proposedRecentContext: "done" }));
		await (job as any).rememberJobSettled(again.agentId, again.threadId);
		assert((job as any).takeRestartedRemember(again.agentId, again.threadId) === false, "once Generate again has read it, the restart is not said");
		const finished = roomWithConversation("finished, no restart", { messages: 6 });
		(job as any).startRememberJob(finished.agentId, finished.threadId, async () => ({ proposedRecentContext: "done" }));
		await (job as any).rememberJobSettled(finished.agentId, finished.threadId);
		assert((job as any).takeRestartedRemember(finished.agentId, finished.threadId) === false, "a Remember that ended says nothing about a restart");
		// An older proposal kept from an earlier Remember never hides the restart: the cut read is the newer one.
		(job as any).startRememberJob(finished.agentId, finished.threadId, () => new Promise(() => {}));
		(job as any).forgetRememberJobsForTests();
		assert((job as any).getRememberJob(finished.agentId, finished.threadId) === null, "after a restart cut a newer read, the older kept proposal is not the job");
		assert((job as any).takeRestartedRemember(finished.agentId, finished.threadId) === true, "the restart line wins over an older kept proposal");
		assert((job as any).getRememberJob(finished.agentId, finished.threadId) === null, "and the older proposal does not come back after the line was said");
	});

	await section("a second tab attaches to the running Remember, and Cancel stops it from either", async () => {
		assert(!(job instanceof Error), "remember-job.ts is missing");
		const room = roomWithConversation("second tab", { messages: 6 });
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const run = async (signal: AbortSignal) => {
			await Promise.race([gate, new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))]);
			if (signal.aborted) throw Object.assign(new Error("Remember was cancelled. Nothing was saved."), { name: "AbortError" });
			return { proposedRecentContext: "never" };
		};
		const first = (job as any).startRememberJob(room.agentId, room.threadId, run);
		const second = (job as any).startRememberJob(room.agentId, room.threadId, run);
		assert(second.jobId === first.jobId && second.attached === true, "the second start attaches instead of answering 409");
		assert((job as any).cancelRememberJob(room.agentId, room.threadId) === true, "Cancel reaches the running job");
		await (job as any).rememberJobSettled(room.agentId, room.threadId);
		assert((job as any).getRememberJob(room.agentId, room.threadId)?.state === "cancelled", "the job ends cancelled");
		release();
	});

	await section("Generate right after Cancel starts a fresh Remember once the stopped one has ended", async () => {
		assert(!(job instanceof Error), "remember-job.ts is missing");
		const room = roomWithConversation("after cancel", { messages: 6 });
		let release!: () => void;
		const unwinding = new Promise<void>((resolve) => { release = resolve; });
		const first = (job as any).startRememberJob(room.agentId, room.threadId, async () => {
			await unwinding;
			throw Object.assign(new Error("Remember was cancelled. Nothing was saved."), { name: "AbortError" });
		});
		assert((job as any).cancelRememberJob(room.agentId, room.threadId) === true, "Cancel reaches the running job");
		const second = (job as any).startRememberJob(room.agentId, room.threadId, async () => ({ proposedRecentContext: "fresh" }));
		assert(second.attached === false && second.jobId !== first.jobId, "the new Generate does not attach to the stopped job");
		release();
		await (job as any).rememberJobSettled(room.agentId, room.threadId);
		assert((job as any).getRememberJob(room.agentId, room.threadId)?.state === "done", "the fresh job finishes");
	});

	for (const end of ["Save", "Forget"] as const) await section(`${end} stops a Remember still reading the conversation, and nothing it read is left`, async () => {
		assert(!(job instanceof Error), "remember-job.ts is missing");
		const room = roomWithConversation(`${end} while reading`);
		const saved = await propose(room, fakeModel((call) => ({ text: call.part ? NOTES : PAGE })).generate);
		// Another tab generates again (another density, so no note is cached) and its part reads hang.
		let entered!: () => void;
		const reading = new Promise<void>((resolve) => { entered = resolve; });
		let release!: () => void;
		const held = new Promise<void>((resolve) => { release = resolve; });
		const generate = async (prompt: string, _model: unknown, call?: { trigger?: string }) => {
			if (call?.trigger === REMEMBER_PART_TRIGGER) {
				entered();
				await held;
			}
			return { text: call?.trigger === REMEMBER_PART_TRIGGER ? NOTES : PAGE, truncated: false, usage: { input: 1, output: 1, totalTokens: 2, cost: 0 } };
		};
		// As the server runs it: the reading mark stops the job when the conversation ends.
		(job as any).startRememberJob(room.agentId, room.threadId, async (signal: AbortSignal) => {
			const mark = pa.beginRememberGeneration(room.agentId, room.threadId, (reason?: "saved" | "forgotten") => (job as any).cancelRememberJob(room.agentId, room.threadId, reason));
			try {
				return await pa.buildCheckpointProposal({ agentId: room.agentId, conversationId: room.threadId, model, density: "rich", runtimeCwd: tempCwd }, generate, { resolveModelWindow: () => ({ contextWindow: 40_000, maxOutputTokens: 16_000 }), signal } as any);
			} finally {
				mark.end();
			}
		});
		await reading;
		if (end === "Save") {
			const parsed = pa.parseCheckpointApprovalRequest({ conversationId: room.threadId, model, density: saved.density, proposal: saved, approvedRecentContext: pageOf(saved) }, room.agentId);
			pa.writeApprovedCheckpoint(parsed.request, parsed.warnings, new Date(), { runtimeCwd: tempCwd });
		} else {
			pa.writePersistentAgentMementoBoundary(room.agentId, room.threadId, new Date(), { runtimeCwd: tempCwd });
		}
		release();
		await (job as any).rememberJobSettled(room.agentId, room.threadId);
		const dir = path.join(pa.createPersistentAgentInstance(room.agentId).rootDir, "runtime", "remember", room.threadId);
		assert((job as any).getRememberJob(room.agentId, room.threadId)?.state === "cancelled", `the reading job is stopped, got ${(job as any).getRememberJob(room.agentId, room.threadId)?.state}`);
		const reason = (job as any).getRememberJob(room.agentId, room.threadId)?.reason;
		assert(reason === (end === "Save" ? "saved" : "forgotten"), `a Save says the conversation was saved, a Forget that it was forgotten, got ${reason}`);
		assert(!fs.existsSync(path.join(dir, "parts.json")) && !fs.existsSync(path.join(dir, "proposal.json")), "no note and no proposal outlive the conversation");
	});

	await section("Discard then Generate at once waits for the discarded read to end, never meets its reading mark", async () => {
		const room = roomWithConversation("discard then generate");
		let entered!: () => void;
		const reading = new Promise<void>((resolve) => { entered = resolve; });
		const held = (signal: AbortSignal) => new Promise<void>((resolve) => signal.addEventListener("abort", () => setTimeout(resolve, 20), { once: true }));
		const start = (generate: any) => (job as any).startRememberJob(room.agentId, room.threadId, async (signal: AbortSignal) => {
			const mark = pa.beginRememberGeneration(room.agentId, room.threadId, (reason?: "saved" | "forgotten") => (job as any).cancelRememberJob(room.agentId, room.threadId, reason));
			try {
				return await pa.buildCheckpointProposal({ agentId: room.agentId, conversationId: room.threadId, model, density: "standard", runtimeCwd: tempCwd }, generate, { resolveModelWindow: () => ({ contextWindow: 40_000, maxOutputTokens: 16_000 }), signal } as any);
			} finally {
				mark.end();
			}
		});
		// The first read hangs until its abort lands, a few ticks after the Discard.
		start(async (_prompt: string, _model: unknown, call?: { trigger?: string; signal?: AbortSignal }) => {
			entered();
			await held(call!.signal!);
			const error = new Error("worker aborted") as Error & { stopReason?: string };
			error.stopReason = "aborted";
			throw error;
		});
		await reading;
		(job as any).discardRememberJob(room.agentId, room.threadId);
		start(fakeModel((call) => ({ text: call.part ? NOTES : PAGE })).generate);
		await (job as any).rememberJobSettled(room.agentId, room.threadId);
		await (job as any).rememberJobSettled(room.agentId, room.threadId);
		const view = (job as any).getRememberJob(room.agentId, room.threadId);
		assert(view?.state === "done", `the Generate after the Discard gives its page, got ${view?.state}: ${view?.error?.message ?? ""}`);
	});

	await section("a restart mid-parts keeps the parts read, and Generate again pays only for the missing one", async () => {
		const room = roomWithConversation("restart");
		let partCalls = 0;
		const firstRun = fakeModel((call) => {
			if (!call.part) return { text: PAGE };
			partCalls += 1;
			return partCalls >= 3 ? new ModelUnreachableError("not-answering", model) : { text: NOTES };
		});
		let failed = false;
		await propose(room, firstRun.generate).catch(() => { failed = true; });
		assert(failed, "the first Remember stops on an unreachable model");
		const readBefore = new Set(firstRun.calls.filter((call, index) => call.part && index < 2).map((call) => call.prompt));
		const secondRun = fakeModel((call) => ({ text: call.part ? NOTES : PAGE }));
		await propose(room, secondRun.generate);
		const again = secondRun.calls.filter((call) => call.part && readBefore.has(call.prompt));
		assert(again.length === 0, `no part already read is called again, got ${again.length}`);
		assert(secondRun.calls.some((call) => call.part), "the missing part is read");
	});

	await section("one part meeting an unreachable model ends in the notice, never in a cancel, while the other parts stop on their abort", async () => {
		// Every part answers at the same moment: the one with the marker meets the unreachable model, and
		// another, a few ticks behind, finds the parts stopped as it ends. Whichever reaches the job first
		// must not decide: across the offsets, the job always ends in the notice.
		const endings: string[] = [];
		for (let offset = 0; offset <= 12; offset++) {
			const room = roomWithConversation(`lane race ${offset}`, { marker: SENSITIVE });
			let release: () => void = () => {};
			const gate = new Promise<void>((resolve) => { release = resolve; });
			let partCalls = 0;
			const generate = async (prompt: string, _model: unknown, call?: { trigger?: string }) => {
				if (call?.trigger !== REMEMBER_PART_TRIGGER) return { text: PAGE, truncated: false, usage: { input: 1, output: 1, totalTokens: 2, cost: 0 } };
				partCalls += 1;
				if (partCalls === 3) release();
				await gate;
				if (prompt.includes(SENSITIVE)) throw new ModelUnreachableError("not-answering", model);
				for (let tick = 0; tick < offset; tick++) await null;
				return { text: NOTES, truncated: false, usage: { input: 1, output: 1, totalTokens: 2, cost: 0 } };
			};
			const error = await propose(room, generate).then(() => null, (failure: unknown) => failure);
			if (!(error instanceof ModelUnreachableError)) endings.push(`offset ${offset}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
		}
		assert(endings.length === 0, `the job ends in the notice at every offset, got ${endings.join("; ")}`);
	});

	// Nothing engine-made inside memory: how the page was made goes to the
	// diagnostics, never into the entry.
	const ENGINE_LINE = /could not be summarized|were not read|\(Shortened|read in parts; this entry|Conversation of \d/i;
	const titleOf = (page: string) => /^### RC-DRAFT \| \w+ \| [\d-]+ \| (.*)$/m.exec(page)?.[1] ?? "";
	const ARC_NOTES = "MUST-KEEP:\nNone\n\nDECISIONS AND CORRECTIONS:\n- The launch moves to May.\n\nARC:\nWe weighed the launch date and the budget, then settled on May for the launch.\n\nOPEN AT THE END OF THIS PART:\nNone\n";
	await section("a stretch refused at every depth: the final call is told once which messages were not read, and no page line says so", async () => {
		const room = roomWithConversation("gap in the frame", { marker: SENSITIVE });
		const fake = fakeModel((call) => (call.part && call.prompt.includes(SENSITIVE) ? refusal() : { text: call.part ? NOTES : PAGE }));
		const page = pageOf(await propose(room, fake.generate));
		const final = fake.calls.filter((call) => !call.part).at(-1)!;
		assert(!/could not be summarized/i.test(final.prompt), "the notes the final call reads hold no placeholder");
		assert((final.prompt.match(/Messages? \d+( to \d+)? (was|were) not read\. Write nothing about (it|them)\./g) ?? []).length === 1, "the final call is told the gap once");
		assert(!ENGINE_LINE.test(page), `the page holds no engine line, got: ${page.match(ENGINE_LINE)?.[0]}`);
		const records = listMaintenanceDiagnostics(pa.createPersistentAgentInstance(room.agentId).rootDir, 200);
		assert(records.some((record) => record.validatorWarnings?.includes("refused-net")), "the diagnostics keep refused-net");
	});

	await section("a page cut to fit holds no marker, ends on a whole paragraph, and the diagnostics say shortened", async () => {
		const room = roomWithConversation("cut to fit, no marker", { messages: 6 });
		const long = Array.from({ length: 40 }, (_, index) => `- Point ${index}: ${"the launch moves to May and the budget holds. ".repeat(6)}`).join("\n\n");
		const page = pageOf(await propose(room, fakeModel(() => ({ text: PAGE.replace("- The launch moves to May.", long) })).generate));
		assert(page.length <= 8_000 && /Point 0:/.test(page), "the page fits");
		assert(!/\(Shortened/.test(page), "no Shortened marker");
		assert(/budget holds\.\s*\n\n\*\*Parked:\*\*/.test(page), "the body ends on a whole paragraph");
		const records = listMaintenanceDiagnostics(pa.createPersistentAgentInstance(room.agentId).rootDir, 200);
		assert(records.some((record) => record.validatorWarnings?.includes("shortened")), "the diagnostics say shortened");
	});

	await section("a reply cut at the output cap is salvaged with no marker", async () => {
		const room = roomWithConversation("salvage, no marker", { messages: 6 });
		const cut = "TITLE:\nThe launch plan\n\nSESSION_ARC:\nWe planned the launch.\n\nBODY:\n- The launch moves to May.\n\n- A second paragraph that was cut mid";
		const page = pageOf(await propose(room, fakeModel(() => ({ text: cut, truncated: true })).generate));
		assert(/launch moves to May/.test(page) && !/\(Shortened/.test(page) && !/cut mid/.test(page), "the salvage keeps the complete paragraphs, with no marker");
	});

	await section("a page built by code takes its title and arc from the notes", async () => {
		const room = roomWithConversation("title from notes");
		const fake = fakeModel((call) => (call.part ? { text: ARC_NOTES } : refusal()));
		const page = pageOf(await propose(room, fake.generate));
		assert(titleOf(page) === "We weighed the launch date and the budget, then settled", `the title is the arc's first words, got "${titleOf(page)}"`);
		assert(/\*\*Session arc:\*\* We weighed the launch date/.test(page) && !ENGINE_LINE.test(page), "the arc is the notes' own, with no engine line");
	});

	await section("a reply with no TITLE takes its own arc's first words", async () => {
		const room = roomWithConversation("no title", { messages: 6 });
		const fake = fakeModel(() => ({ text: PAGE.replace("TITLE:\nThe launch plan\n\n", "") }));
		const page = pageOf(await propose(room, fake.generate));
		assert(titleOf(page) === "We planned the launch", `got "${titleOf(page)}"`);
		assert(fake.calls.length === 1, `no second call for a title, got ${fake.calls.length} calls`);
	});

	await section("a conversation refused at every call and noted nowhere gets the dated title alone, and it saves", async () => {
		const room = roomWithConversation("refused everywhere, dated only", { turns: shortTurns });
		const proposal: any = await propose(room, fakeModel(() => refusal()).generate, largeWindow);
		const page = pageOf(proposal);
		assert(DATED_ONLY.test(page) && !/not summarized|Search can find|bakery/i.test(page), `the dated title alone, none of the refused words, got ${page}`);
		assert(proposal.rememberRead?.refusedWhole === true, "the server says every part was refused");
		const parsed = pa.parseCheckpointApprovalRequest({ conversationId: room.threadId, model, density: proposal.density, proposal, approvedRecentContext: page }, room.agentId);
		assert(parsed.warnings.length === 0, `it saves with no warning, got ${JSON.stringify(parsed.warnings)}`);
		// Saved at half past midnight in Berlin: the heading's day is the person's, as the title's is.
		const zone = process.env.TZ;
		process.env.TZ = "Europe/Berlin";
		try {
			pa.writeApprovedCheckpoint(parsed.request, parsed.warnings, new Date("2026-10-09T22:30:00.000Z"), { runtimeCwd: tempCwd });
		} finally {
			if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone;
		}
		const instance = pa.createPersistentAgentInstance(room.agentId);
		const heading = fs.readFileSync(instance.l1bCurrentPath(instance.readAgentJson()), "utf-8").split("\n").find((line) => /^### RC-/.test(line)) ?? "";
		assert(/\| 2026-10-10 \|/.test(heading), `the heading's day is the person's own, got ${heading}`);
	});

	await section("a keep-request the final entry lost is put back, word for word, with no warning", async () => {
		const room = roomWithConversation("keep request restored");
		const keepNotes = NOTES.replace("MUST_KEEP:\nNone\n", "MUST-KEEP:\n- \"remember the code word\": Bluebird, for the May launch\n- \"keep this\": The budget is 40k\n");
		const fake = fakeModel((call) => ({ text: call.part ? keepNotes : PAGE.replace("- The launch moves to May.", "- The launch moves to May.\n- The budget is 40k, as the user asked to keep this.") }));
		const proposal: any = await propose(room, fake.generate);
		const page = pageOf(proposal);
		assert(page.includes("- \"remember the code word\": Bluebird, for the May launch"), "the lost request is back, word for word");
		assert(!page.includes("\"keep this\""), "a request the body already holds is not added again");
		assert(!proposal.warnings.some((warning: string) => /asked to keep/.test(warning)), "no warning about it");
	});

	await section("the proposal carries no engine warning, and Save adds none", async () => {
		const room = roomWithConversation("no engine warnings");
		const fake = fakeModel((call) => (call.part ? { text: `FACTS:\n- The partner API allows 600 requests a minute.\n\n${NOTES}` } : refusal()));
		const proposal: any = await propose(room, fake.generate);
		assert(JSON.stringify(proposal.warnings) === JSON.stringify(["no memory has been written"]), `only the status line, got ${JSON.stringify(proposal.warnings)}`);
		assert(pageOf(proposal).includes("- The partner API allows 600 requests a minute."), "a fact the notes hold reaches the page");
		const records = listMaintenanceDiagnostics(pa.createPersistentAgentInstance(room.agentId).rootDir, 200);
		assert(records.some((record) => record.validatorWarnings?.some((warning: string) => /put together from the notes/.test(warning))), "the diagnostics keep how the page was made");
		const claims = pageOf(proposal).replace("**Parked:**", "- Note: memory was saved.\n\n**Parked:**");
		const parsed = pa.parseCheckpointApprovalRequest({ conversationId: room.threadId, model, density: proposal.density, proposal, approvedRecentContext: claims }, room.agentId);
		assert(parsed.warnings.length === 0, `Save adds no warning, got ${JSON.stringify(parsed.warnings)}`);
	});

	await section("a page with a dated title is never placed under a topic named after the date", async () => {
		const { placeByCode } = await import("../src/memory-placement.js");
		const { loadMemoryDocument } = await import("../src/memory-entries-store.js");
		const room = roomWithConversation("dated topic", { messages: 2 });
		const doc = loadMemoryDocument(room.agentId).doc;
		const dated = placeByCode(doc, "nothing that matches", "Conversation of 2026-10-09");
		assert(dated !== "Conversations" && !/\d{4}-\d{2}-\d{2}/.test(dated), `no topic is named Conversations or after a date, got ${dated}`);
		assert(placeByCode(doc, "nothing that matches", "The launch plan") === "The launch plan", "a real title stays");
		assert(placeByCode(doc, "- The renewal moves to May.", "") === "The renewal moves to May", `with no title, the note's own words, got ${placeByCode(doc, "- The renewal moves to May.", "")}`);
		const placement = fs.readFileSync(path.join(process.cwd(), "apps", "web-server", "src", "memory-placement.ts"), "utf8");
		const twoStage = fs.readFileSync(path.join(process.cwd(), "apps", "web-server", "src", "remember-two-stage.ts"), "utf8");
		assert(!/"Conversations"/.test(placement) && !/not summarized/i.test(twoStage), "no engine words in the page builders");
	});

	// Only a refusal may leave a stretch unread. Any other failure that
	// outlasts the halves ends in the one plain stop; Generate again pays
	// only for what was not kept.
	const noWait = { patience: { sleep: async () => {} } };
	const spentTimeout = () => Object.assign(new Error("checkpoint compression worker timed out"), { patienceSpent: true });
	await section("a part that fails for an unknown cause at every size stops Remember, and no page leaves its messages out", async () => {
		const room = roomWithConversation("unknown failure", { marker: SENSITIVE });
		const fake = fakeModel((call) => (call.part && call.prompt.includes(SENSITIVE) ? new Error("upstream returned 400: the body exceeds the gateway limit") : { text: call.part ? NOTES : PAGE }));
		const outcome = await propose(room, fake.generate, noWait).then(() => "a page", (error) => error);
		assert(outcome instanceof Error, `Remember stops, got ${outcome}`);
		assert(!fake.calls.some((call) => !call.part && /were not read/.test(call.prompt)), "no final call is told to leave messages out");
		const records = listMaintenanceDiagnostics(pa.createPersistentAgentInstance(room.agentId).rootDir, 200);
		assert(!records.some((record) => record.validatorWarnings?.includes("refused-net")), "nothing is logged as refused");
	});

	await section("a part cut at the output cap at every size keeps what it holds", async () => {
		const room = roomWithConversation("cut part", { marker: SENSITIVE });
		const fake = fakeModel((call) => (call.part && call.prompt.includes(SENSITIVE) ? { text: "DECISIONS:\n- CUT-KEPT the launch moves to May.\n- and the bud", truncated: true } : { text: call.part ? NOTES : PAGE }));
		await propose(room, fake.generate);
		const final = fake.calls.filter((call) => !call.part).at(-1)!;
		assert(final.prompt.includes("CUT-KEPT") && !/were not read/.test(final.prompt), "the cut note reaches the final call, and no message is left unread");
		assert(!final.prompt.includes("and the bud"), "the line cut mid-way is dropped");
	});

	await section("a part cut before its first line at every size stops Remember, and never as an empty reply", async () => {
		const room = roomWithConversation("cut before a line", { marker: SENSITIVE });
		const fake = fakeModel((call) => (call.part && call.prompt.includes(SENSITIVE) ? { text: "DECISIONS: the launch moves to Ma", truncated: true } : { text: call.part ? NOTES : PAGE }));
		const outcome = await propose(room, fake.generate, noWait).then(() => "a page", (error) => error);
		assert(outcome instanceof Error, `Remember stops, got ${outcome}`);
		assert(!/produced no text/.test(outcome.message), `the stop does not say the reply was empty, got ${outcome.message}`);
		// The same model meets the same cut again: the line says so and points at another model, and the dialog passes it through.
		const { isPlainRememberSentence } = await import("../../web-ui/src/remember-read.js");
		assert(isPlainRememberSentence(outcome.message) && /Choose another Memory model/.test(outcome.message) && /Nothing was saved\.$/.test(outcome.message), `the stop is a plain line with its way out, got ${outcome.message}`);
	});

	await section("a part that timed out past the patience is asked once at each size, then Remember stops", async () => {
		const room = roomWithConversation("timed out part", { marker: SENSITIVE });
		const fake = fakeModel((call) => (call.part && call.prompt.includes(SENSITIVE) ? spentTimeout() : { text: call.part ? NOTES : PAGE }));
		const outcome = await propose(room, fake.generate, noWait).then(() => "a page", (error) => error);
		const asked = fake.calls.filter((call) => call.part && call.prompt.includes(SENSITIVE)).length;
		assert(asked <= 3, `one call at the whole part, the half and the quarter, got ${asked}`);
		assert(outcome instanceof Error, `Remember stops, got ${outcome}`);
	});

	await section("a shorter-page call that times out keeps the page it had", async () => {
		const room = roomWithConversation("shorter times out", { messages: 6 });
		const long = Array.from({ length: 40 }, (_, index) => `- Point ${index}: ${"the launch moves to May and the budget holds. ".repeat(6)}`).join("\n\n");
		const fake = fakeModel(() => (fake.calls.length > 1 ? spentTimeout() : { text: PAGE.replace("- The launch moves to May.", long) }));
		const page = pageOf(await propose(room, fake.generate, noWait));
		assert(page.length <= 8_000 && /Point 0:/.test(page), "the page it had, fitted");
	});

	await section("a cut reply whose shorter ask times out keeps what came complete", async () => {
		const room = roomWithConversation("rung times out", { messages: 6 });
		const cut = "TITLE:\nThe launch plan\n\nSESSION_ARC:\nWe planned the launch.\n\nBODY:\n- The launch moves to May.\n\n- A second paragraph that was cut mid";
		const fake = fakeModel(() => (fake.calls.length > 1 ? spentTimeout() : { text: cut, truncated: true }));
		const page = pageOf(await propose(room, fake.generate, noWait));
		assert(/launch moves to May/.test(page) && !/cut mid/.test(page), "the complete paragraphs are kept");
	});

	await section("an empty single-pass reply is read in parts", async () => {
		const room = roomWithConversation("empty single", { messages: 6 });
		const fake = fakeModel((call) => (!call.part && !fake.calls.some((earlier) => earlier.part) ? new Error("checkpoint compression worker produced no text") : { text: call.part ? NOTES : PAGE }));
		const page = pageOf(await propose(room, fake.generate, noWait));
		assert(fake.calls.some((call) => call.part) && /launch moves to May/.test(page), "the conversation is read in parts and the page comes");
	});

	await section("a single pass that timed out past the patience is read in parts", async () => {
		const room = roomWithConversation("single times out", { messages: 6 });
		const fake = fakeModel((call) => (!call.part && !fake.calls.some((earlier) => earlier.part) ? spentTimeout() : { text: call.part ? NOTES : PAGE }));
		const page = pageOf(await propose(room, fake.generate, noWait));
		assert(fake.calls.some((call) => call.part) && /launch moves to May/.test(page), "the conversation is read in parts and the page comes");
	});

	for (const [label, failure] of [["timed out past the patience", spentTimeout], ["answered empty", () => new Error("checkpoint compression worker produced no text")]] as const) {
		await section(`a final call that ${label} still gives a page`, async () => {
			const room = roomWithConversation(`final ${label}`);
			const fake = fakeModel((call) => (call.part ? { text: NOTES } : failure()));
			const page = pageOf(await propose(room, fake.generate, noWait).catch((error) => { throw new Error(`Remember failed: ${error instanceof Error ? error.message : String(error)}`); }));
			assert(/launch moves to May/.test(page), "the page comes from the notes");
			assert(fake.calls.filter((call) => !call.part).length <= 2, `the final call is asked at most twice (the whole end, then half of it), got ${fake.calls.filter((call) => !call.part).length}`);
		});
	}

	await section("a page built from the notes keeps each part's decisions, and only the last part's open end", async () => {
		const room = roomWithConversation("from notes, every part");
		const partNote = (part: string) => `FACTS:\n${Array.from({ length: 30 }, (_, index) => `- Part ${part} fact ${index}: ${"the venue holds two hundred people. ".repeat(3)}`).join("\n")}\n\nDECISIONS AND CORRECTIONS:\n${Array.from({ length: 30 }, (_, index) => `- Part ${part} decision ${index}: ${"the launch moves to May and the budget holds. ".repeat(3)}`).join("\n")}\n\nOPEN THREADS:\n- THREAD-${part}: not settled\n\nOPEN AT THE END OF THIS PART:\n- IN-PROGRESS-${part}\n`;
		const fake = fakeModel((call) => (call.part ? { text: partNote(/Part (\d+) of \d+ of the Conversation/.exec(call.prompt)![1]!) } : refusal()));
		const page = pageOf(await propose(room, fake.generate));
		const last = Math.max(...fake.calls.filter((call) => call.part).map((call) => Number(/Part (\d+) of/.exec(call.prompt)![1])));
		assert(last >= 3, `three parts or more, got ${last}`);
		assert(page.length <= 8_000, `the page fits, got ${page.length}`);
		for (let part = 1; part <= last; part++) assert(page.includes(`Part ${part} decision 0:`), `part ${part}'s first decision is on the page`);
		assert(page.indexOf(`Part ${last} decision 0:`) < page.indexOf(`Part ${last} fact 0:`) || !page.includes(`Part ${last} fact 0:`), "a part's decisions come before its facts");
		assert(page.includes(`IN-PROGRESS-${last}`) && !page.includes("IN-PROGRESS-1"), "only the last part's open end is parked");
		assert(page.includes("THREAD-1"), "every part's open threads are parked");
	});

	await section("a page built from the notes parks the open end of the last part read, and only its second half's", async () => {
		const note = (part: string, end: string) => `DECISIONS AND CORRECTIONS:\n- Part ${part} decided.\n\nOPEN AT THE END OF THIS PART:\n- ${end}\n`;
		const unreadLast = buildRememberPageFromNotes([note("1", "END-ONE"), note("2", "END-TWO"), ""]);
		assert(unreadLast.parked.includes("END-TWO") && !unreadLast.parked.includes("END-ONE"), `an unread last part leaves the open end of the part before it, got ${JSON.stringify(unreadLast.parked)}`);
		const halves = buildRememberPageFromNotes([note("1", "END-ONE"), `${note("2a", "END-FIRST-HALF")}\n\n${note("2b", "END-SECOND-HALF")}`]);
		assert(halves.parked.includes("END-SECOND-HALF") && !halves.parked.includes("END-FIRST-HALF"), `a last part read in halves parks only the second half's open end, got ${JSON.stringify(halves.parked)}`);
	});

	await section("a title that is only markup becomes the entry's own words, never a placeholder", async () => {
		const room = roomWithConversation("markup title", { messages: 2 });
		const fake = fakeModel((call) => ({ text: call.part ? NOTES : PAGE.replace("TITLE:\nThe launch plan", "TITLE:\n**") }));
		const proposal: any = await propose(room, fake.generate);
		const heading = pageOf(proposal).split("\n")[0] ?? "";
		assert(!/Untitled/.test(heading) && !/Untitled/.test(String(proposal?.fields?.title)) && /We planned the launch/.test(String(proposal?.fields?.title)), `the title comes from what happened, got ${JSON.stringify(proposal?.fields?.title)} / ${JSON.stringify(heading)}`);
	});

	await section("the dated title is the person's own day", async () => {
		const { rememberDatedTitle } = await import("../src/remember-two-stage.js");
		const zone = process.env.TZ;
		process.env.TZ = "Europe/Berlin";
		try {
			const title = rememberDatedTitle(new Date("2026-10-09T22:30:00.000Z"));
			assert(title === "Conversation of 2026-10-10", `half past midnight in Berlin is the 10th, got ${title}`);
		} finally {
			if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone;
		}
	});

	await section("a sort reply that numbers or bolds its lines is read", async () => {
		const { readSort } = await import("../src/memory-placement.js");
		const { loadMemoryDocument } = await import("../src/memory-entries-store.js");
		const doc = loadMemoryDocument(roomWithConversation("sort reply shapes", { messages: 2 }).agentId).doc;
		const read = readSort(doc, "1. m-0101: Billing\n2) **m-0102**: Billing\n- **m-0103:** Billing");
		assert(read.size === 3, `every line is read, got ${JSON.stringify([...read])}`);
	});

	await section("Generate again does not send a refused part again once its halves were read", async () => {
		const room = roomWithConversation("refused part kept", { marker: SENSITIVE });
		const fake = fakeModel((call) => (call.part && call.prompt.includes(SENSITIVE) && !HIGH_LEVEL.test(call.prompt) ? refusal() : { text: call.part ? NOTES : PAGE }));
		await propose(room, fake.generate);
		const refusedBefore = fake.calls.filter((call) => call.part && call.prompt.includes(SENSITIVE) && !HIGH_LEVEL.test(call.prompt)).length;
		await propose(room, fake.generate);
		const refusedAfter = fake.calls.filter((call) => call.part && call.prompt.includes(SENSITIVE) && !HIGH_LEVEL.test(call.prompt)).length;
		assert(refusedAfter === refusedBefore, `the refused part is not paid for again, got ${refusedAfter - refusedBefore} more`);
	});

	assert(failures.length === 0, `remember never fails smoke failed:\n${failures.join("\n")}`);
	console.log("remember never fails smoke passed");
	fs.rmSync(tempHome, { recursive: true, force: true });
	fs.rmSync(tempCwd, { recursive: true, force: true });
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	console.error(`temp home preserved for inspection: ${tempHome}`);
	process.exitCode = 1;
}
