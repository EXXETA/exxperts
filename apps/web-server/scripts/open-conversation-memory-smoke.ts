// A conversation with messages keeps the memory it started with: its start
// text is frozen. So when a Memorize or Review save changes what a
// conversation reads while the room's open conversation has started, the save
// says so (openConversationKeepsMemory), and the saved screen tells the person
// the changes apply from their next conversation. Nothing is said when the
// room has no open conversation, when the open one is the empty one Remember
// prepared (it boots on the memory as it is at its next open), or when the
// save changed nothing a conversation reads (Chronos dates aside). The routes
// that carry it are proved in the Memorize and Review route smokes, the line
// on the page in the maintain flows smoke. Offline: no server, no model.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-open-conversation-memory-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const smokeAppDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(smokeAppDir, { recursive: true });
fs.writeFileSync(
	path.join(smokeAppDir, "openai-compatible-ai-profile.json"),
	JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }], maintenanceModel: "gpt-5.5" }, null, 2),
);
fs.writeFileSync(path.join(smokeAppDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-open-conversation-memory-rooms-"));
const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-open-conversation-memory-cwd-"));
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const {
	createPersistentAgentFromScaffoldInput,
	createPersistentAgentInstance,
	createPersistentAgentPiSessionJsonlThreadRuntime,
	saveWithOpenConversationCheck,
	updateChronosForReview,
	writePersistentAgentThread,
} = await import("../src/persistent-agents.js");

const model = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" };
let failures = 0;
function check(label: string, condition: unknown, detail?: unknown): void {
	if (condition) console.log(`  ok  ${label}`);
	else {
		failures += 1;
		console.log(`FAIL  ${label}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
	}
}

let roomCount = 0;
/** A fresh room, with its open conversation as asked: none, the empty prepared one, or one that has started. */
function room(open: "none" | "empty" | "started" | "started-standby"): { agentId: string; l1bPath: string } {
	roomCount += 1;
	const agentId = createPersistentAgentFromScaffoldInput({ displayName: `Open Conversation Room ${roomCount}`, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	const instance = createPersistentAgentInstance(agentId);
	if (open !== "none") {
		const threadId = `pi_open_conv_${roomCount}`;
		const items = open === "empty" ? [] : [{ kind: "user", id: "u1", text: "a real question" }, { kind: "assistant", id: "a1", text: "a real answer" }];
		writePersistentAgentThread(agentId, threadId, { state: open === "started-standby" ? "standby" : "active", origin: open === "empty" ? "checkpoint" : "home", model, items }, {
			createRuntime: ({ model }) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId, model, cwd: tempCwd }),
		});
	}
	return { agentId, l1bPath: instance.l1bCurrentPath(instance.readAgentJson()) };
}

/** A save that changes what a conversation reads: one new waiting conversation in Recent Context. */
function changingSave(l1bPath: string) {
	return () => {
		const text = fs.readFileSync(l1bPath, "utf-8");
		const recent = /^##\s+Recent Context\s*$/m.exec(text)!;
		const page = "### RC-0001 | CLOSED | 2026-10-12 | OPEN_CONVERSATION_SENTINEL\n\n**Session arc:** A synthetic session.\n\n**Body:**\n- A line worth remembering.\n\n**Parked:**\nNone\n";
		fs.writeFileSync(l1bPath, `${text.slice(0, recent.index + recent[0].length)}\n\n${page}${text.slice(recent.index + recent[0].length)}`, "utf-8");
		return { saved: true };
	};
}

try {
	const started = room("started");
	const saved = await saveWithOpenConversationCheck(started.agentId, changingSave(started.l1bPath));
	check("a started open conversation: the save says it keeps the memory it started with", saved.openConversationKeepsMemory === true, saved);
	check("the save's own answer is passed through", (saved as { saved?: boolean }).saved === true);

	const standby = room("started-standby");
	const standbySaved = await saveWithOpenConversationCheck(standby.agentId, changingSave(standby.l1bPath));
	check("a started conversation on standby (the room closed, the conversation still open): the save says so", standbySaved.openConversationKeepsMemory === true, standbySaved);

	const none = room("none");
	const noneSaved = await saveWithOpenConversationCheck(none.agentId, changingSave(none.l1bPath));
	check("no open conversation: nothing is said", !("openConversationKeepsMemory" in noneSaved), noneSaved);

	const empty = room("empty");
	const emptySaved = await saveWithOpenConversationCheck(empty.agentId, changingSave(empty.l1bPath));
	check("the empty prepared conversation (it boots on the memory as it is): nothing is said", !("openConversationKeepsMemory" in emptySaved), emptySaved);

	const unchanged = room("started");
	const unchangedSaved = await saveWithOpenConversationCheck(unchanged.agentId, () => {
		fs.writeFileSync(unchanged.l1bPath, updateChronosForReview(fs.readFileSync(unchanged.l1bPath, "utf-8"), "review_unchanged", new Date()), "utf-8");
		return {};
	});
	check("a save that only dated Chronos changed nothing a conversation reads: nothing is said", !("openConversationKeepsMemory" in unchangedSaved), unchangedSaved);

	let thrown: string | null = null;
	try {
		await saveWithOpenConversationCheck(started.agentId, () => {
			throw new Error("the save refused");
		});
	} catch (error) {
		thrown = (error as Error).message;
	}
	check("a save that fails fails as it did, with its own error", thrown === "the save refused", thrown);
} finally {
	fs.rmSync(tempHome, { recursive: true, force: true });
	fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(tempCwd, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`open conversation memory smoke: ${failures} failure(s)`);
	process.exit(1);
}
console.log("open conversation memory smoke passed");
