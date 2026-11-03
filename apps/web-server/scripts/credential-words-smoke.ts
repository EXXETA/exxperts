// The words for a connection whose credential is gone: a name that already
// ends in "key" is never followed by "key" again. Then the server's sentences
// for a missing or gone model, first on this computer, then with this process
// made a shared server, where nobody signs in and only the admin can change
// the AI setup: each sends the person to the admin, and none reads as a
// failed sign-in to the matcher the page and the server read failures with.
// Offline: the one model call goes to a local fake.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { modelCredentialWords, nameEndsInKey, providerCredentialClause, roomModelUnavailableLine, signInFailed } from "../src/model-not-offered.js";
import { SMOKE_SERVER_AUTH_ENV } from "./smoke-server-process.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function same(actual: unknown, expected: unknown, label: string): void {
	assert(JSON.stringify(actual) === JSON.stringify(expected), `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

same(nameEndsInKey("Claude API key"), true, "a name ending in key");
same(nameEndsInKey("Monkey"), false, "a word that only ends in the letters");
same(providerCredentialClause("Claude API key", "key-missing"), "No Claude API key is saved", "a missing key after a name ending in key");
same(providerCredentialClause("Fake GPT", "key-missing"), "Fake GPT has no key saved", "a missing key after another name");
same(providerCredentialClause("Claude API key", "key-refused"), "Claude API key did not accept the saved key", "only the missing state changes");
same(modelCredentialWords("Claude Opus 5.5", "Claude API key", "Claude Opus 5.5 on Claude API key", "key-missing"), { subject: "Claude Opus 5.5", state: "has no Claude API key saved" }, "a model on a provider ending in key");
same(modelCredentialWords("GPT Fake", "Fake GPT", "GPT Fake on Fake GPT", "key-missing"), { subject: "GPT Fake on Fake GPT", state: "has no key saved" }, "a model on another provider");
same(roomModelUnavailableLine("Claude Opus 5.5 on Claude API key", "signed-out", "conversation", "room", false, { model: "Claude Opus 5.5", provider: "Claude API key" }), "This room's model, Claude Opus 5.5, has no Claude API key saved. Add the key again in Settings, AI setup, or choose another model in Room settings, Model.", "the room's line");
same(roomModelUnavailableLine("GPT Fake on Fake GPT", "signed-out", "conversation", "room", false, { model: "GPT Fake", provider: "Fake GPT" }), "This room's model, GPT Fake on Fake GPT, has no key saved. Add the key again in Settings, AI setup, or choose another model in Room settings, Model.", "the room's line for another provider");

// --- The server's sentences, on this computer and on a shared server ---
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-credential-words-"));
const agentDir = path.join(tempHome, ".exxperts", "agent");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;
// The app's state follows these before HOME: left set, the smoke would write into the profile they name (smokeHomeEnv does the same).
delete process.env.EXXPERTS_DATA_DIR;
delete process.env.EXXPERTS_STATE_HOME;
Object.assign(process.env, SMOKE_SERVER_AUTH_ENV);
fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
// A provider that answers every call with a 400 nobody knows: the memory chat's call fails for an unknown reason.
const backend = http.createServer((req, res) => {
	req.resume();
	req.on("end", () => {
		res.writeHead(400, { "content-type": "application/json" });
		res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Something odd happened." } }));
	});
});
await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", () => resolve()));
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { anthropic: { baseUrl: `http://127.0.0.1:${(backend.address() as { port: number }).port}` } } }));
const authFile = path.join(agentDir, "auth.json");
const keySaved = (saved: boolean) => saved ? fs.writeFileSync(authFile, JSON.stringify({ anthropic: { type: "api_key", key: "sk-smoke" } }), { mode: 0o600 }) : fs.rmSync(authFile, { force: true });

try {
	const { createPersistentAgentFromScaffoldInput } = await import("../src/persistent-agents.js");
	const { resolvePersistentAgentBindModel, roomConversationModelForNewThread, roomMemoryModelSelection } = await import("../src/ai-profile-models.js");
	const { parseRoomModelPatch, roomModelNames } = await import("../src/ai-models.js");
	const { createRoomModelCatalog, memoryModelTooSmallSentence, roomModelUnavailableSentence } = await import("../src/room-models.js");
	const { modelUnreachableSentence, notOnAccountLine } = await import("../src/model-call-causes.js");
	const { registerServerHooks } = await import("../src/server-hooks.js");
	const { PERSISTENT_AGENT_AI_PROFILE_FILE } = await import("../src/persistent-agent-ai-profile-state.js");
	await import("../src/memory-routes.js");
	const { app, AUTH_HEADER_NAME, AUTH_TOKEN } = await import("../src/server-app.js");
	app.log.level = "silent";

	const room = createPersistentAgentFromScaffoldInput({ displayName: "Words Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	// One note, so the memory chat has something to ask its model about.
	fs.writeFileSync(path.join(agentsRoot, room, "L1b", "current.md"), ["<!-- exxeta:l1b schema_version=1 -->", "", "## Chronos", "", `- Persistent agent id: ${room}`, "- Lifecycle state: ready", "- Last checkpoint: cp_20260912_0001", "- Last checkpoint at: 2026-09-12T09:00:00.000Z", "- Last consolidation: none", "", "## Deep Memory", "", "<!-- entries: next=900 -->", "", "### Crates", "", "<!-- e: id=m-0001 kind=fact saved=2026-09-01 -->", "- The crates leave on Thursdays.", "", "## Active Items", "", "## Recent Context", ""].join("\n"));

	const thrown = (run: () => unknown): string => {
		try {
			run();
		} catch (error) {
			return (error as Error).message;
		}
		return "(nothing thrown)";
	};
	const memoryChat = async (): Promise<string> => {
		const answer = await app.inject({ method: "POST", url: "/api/memory/ask", headers: { [AUTH_HEADER_NAME]: AUTH_TOKEN }, payload: { question: "When do the crates leave?" } });
		return String(JSON.parse(answer.body).message);
	};
	const OPUS = { provider: "anthropic", model: "claude-opus-5-5", label: "Claude Opus 5.5" };
	const SOL = { provider: "openai-codex", model: "gpt-6.1-sol" };
	// The registry lost the key between the room's pick and its bind.
	const keyGone = { find: (provider: string, model: string) => ({ id: model, provider, name: OPUS.label, api: "anthropic-messages" }), hasConfiguredAuth: () => false } as never;
	const NOT_ON_ACCOUNT = new Error("400 The 'claude-opus-5-5' model is not supported when using Codex with a ChatGPT account.");

	/** Every sentence, by its place in the word list; nothing set up first, then with a key saved. */
	async function sentences(): Promise<Record<string, string>> {
		keySaved(false);
		// A key saved before made its first model the default: nothing set up has none.
		fs.rmSync(PERSISTENT_AGENT_AI_PROFILE_FILE, { force: true });
		const catalog = createRoomModelCatalog();
		const names = roomModelNames(catalog);
		const said: Record<string, string> = {
			"8 missing": modelUnreachableSentence("signed-out", OPUS, "missing"),
			"8 signed out": modelUnreachableSentence("signed-out", OPUS),
			"8 refused": modelUnreachableSentence("signed-out", OPUS, "refused"),
			"8 no workspace": modelUnreachableSentence("signed-out", OPUS, "no-workspace"),
			"9 opening a room": thrown(() => roomConversationModelForNewThread(room)),
			"10 memory work": thrown(() => roomMemoryModelSelection(room)),
			"11 memory chat": await memoryChat(),
			"14 room": roomModelUnavailableSentence(SOL, "signed-out", "conversation", names, "room"),
			"14 room memory": roomModelUnavailableSentence(SOL, "signed-out", "memory", names, "room"),
			"14 another room": roomModelUnavailableSentence(SOL, "signed-out", "memory", names, { room: "Supplier Desk" }),
			"14 default": roomModelUnavailableSentence(SOL, "signed-out", "conversation", names, "defaults"),
			"14 default memory": roomModelUnavailableSentence(SOL, "signed-out", "memory", names, "defaults"),
			"15 saving a model": thrown(() => parseRoomModelPatch({ conversation: SOL }, catalog, { allowClear: false })),
			"16 notice": modelUnreachableSentence("not-on-account", SOL),
			"16 room": notOnAccountLine(NOT_ON_ACCOUNT, SOL, "room") ?? "(no line)",
			"16 defaults": notOnAccountLine(NOT_ON_ACCOUNT, SOL, "defaults") ?? "(no line)",
			"17 too small": memoryModelTooSmallSentence(OPUS.label, "default"),
		};
		keySaved(true);
		said["12 memory chat failed"] = await memoryChat();
		said["13 reopening"] = thrown(() => resolvePersistentAgentBindModel(keyGone, new URLSearchParams(), { agentId: room }));
		return said;
	}

	const DESKTOP: Record<string, string> = {
		"8 missing": "Claude Opus 5.5 cannot answer because its provider has no key saved. Nothing was lost.",
		"8 signed out": "Claude Opus 5.5 cannot answer because its provider is signed out. Nothing was lost.",
		"8 refused": "Claude Opus 5.5 cannot answer because its provider did not accept the saved key. Nothing was lost.",
		"8 no workspace": "Claude Opus 5.5 cannot answer because its key isn't tied to a workspace. Nothing was lost.",
		"9 opening a room": "No AI provider is signed in. Sign in in Settings, AI setup, then open the room again.",
		"10 memory work": "No AI provider is signed in, so this room's memory work has no model. Sign in in Settings, AI setup.",
		"11 memory chat": "Connect a model in AI setup to chat with your memory.",
		"14 room": "This room's model, GPT-6.1 Sol on ChatGPT Plus/Pro, is signed out. Sign in again in Settings, AI setup, or choose another model in Room settings, Model.",
		"14 room memory": "This room's memory model, GPT-6.1 Sol on ChatGPT Plus/Pro, is signed out. Sign in again in Settings, AI setup, or choose another model in Room settings, Model.",
		"14 another room": "The memory model of Supplier Desk, GPT-6.1 Sol on ChatGPT Plus/Pro, is signed out. Sign in again in Settings, AI setup, or choose another model in its Room settings, Model.",
		"14 default": "The default model, GPT-6.1 Sol on ChatGPT Plus/Pro, is signed out. Sign in again, or choose another default, in Settings, AI setup.",
		"14 default memory": "The default memory model, GPT-6.1 Sol on ChatGPT Plus/Pro, is signed out. Sign in again, or choose another default, in Settings, AI setup.",
		"15 saving a model": "ChatGPT Plus/Pro is signed out; sign in again in Settings, AI setup, then choose this model.",
		"16 notice": "GPT-6.1 Sol isn't available on your ChatGPT account. Nothing was lost.",
		"16 room": "GPT-6.1 Sol isn't available on your ChatGPT account. Choose another model in Room settings, Model.",
		"16 defaults": "GPT-6.1 Sol isn't available on your ChatGPT account. Choose another default in Settings, AI setup.",
		"17 too small": "The default, Claude Opus 5.5, is too small for this room's memory. Keep this room's own Memory model, or choose a larger default in Settings, AI setup.",
		"12 memory chat failed": "Couldn't answer right now \u2014 check your model connection in AI setup.",
		"13 reopening": "Anthropic / Claude is signed out, so this conversation cannot continue on Claude Opus 5.5. Sign in again in Settings, AI setup, or continue it on another model in Room settings, Model.",
	};
	// The word list's shared-server words, one for everyone where the server builds the sentence.
	const SHARED: Record<string, string> = {
		"8 missing": "Claude Opus 5.5 cannot answer because its provider isn't available on this server. Nothing was lost. Tell your admin.",
		"8 signed out": "Claude Opus 5.5 cannot answer because its provider isn't available on this server. Nothing was lost. Tell your admin.",
		"8 refused": "Claude Opus 5.5 cannot answer because its provider did not accept the saved key. Nothing was lost. Tell your admin.",
		"8 no workspace": "Claude Opus 5.5 cannot answer because its key isn't tied to a workspace. Nothing was lost. Tell your admin.",
		"9 opening a room": "No AI model is set up on this server yet. Ask your admin to add one in Settings, AI setup, then open the room again.",
		"10 memory work": "No AI model is set up on this server yet, so this room's memory work has none. Ask your admin to add one in Settings, AI setup.",
		"11 memory chat": "Memory chat has no model yet. Ask your admin to add one in Settings, AI setup.",
		"14 room": "This room's model, GPT-6.1 Sol on ChatGPT Plus/Pro, isn't available on this server. Choose another model in Room settings, Model, or tell your admin.",
		"14 room memory": "This room's memory model, GPT-6.1 Sol on ChatGPT Plus/Pro, isn't available on this server. Choose another model in Room settings, Model, or tell your admin.",
		"14 another room": "The memory model of Supplier Desk, GPT-6.1 Sol on ChatGPT Plus/Pro, isn't available on this server. Choose another model in its Room settings, Model, or tell your admin.",
		"14 default": "The default model, GPT-6.1 Sol on ChatGPT Plus/Pro, isn't available on this server. Tell your admin.",
		"14 default memory": "The default memory model, GPT-6.1 Sol on ChatGPT Plus/Pro, isn't available on this server. Tell your admin.",
		"15 saving a model": "ChatGPT Plus/Pro isn't available on this server; choose another model, or tell your admin.",
		"16 notice": "GPT-6.1 Sol isn't available on this server's ChatGPT account. Nothing was lost.",
		"16 room": "GPT-6.1 Sol isn't available on this server's ChatGPT account. Choose another model in Room settings, Model.",
		"16 defaults": "GPT-6.1 Sol isn't available on this server's ChatGPT account. Tell your admin.",
		"17 too small": "The default, Claude Opus 5.5, is too small for this room's memory. Keep this room's own Memory model, or ask your admin for a larger default.",
		"12 memory chat failed": "Couldn't answer right now. Try again in a moment; if it repeats, tell your admin.",
		"13 reopening": "Anthropic / Claude isn't available on this server, so this conversation cannot continue on Claude Opus 5.5. Continue it on another model in Room settings, Model, or tell your admin.",
	};
	// The words the page builds on a shared server, for a member and for the admin, as the word list has them.
	const PAGE_SHARED = [
		"No AI model is set up on this server yet. Ask your admin to add one in Settings, AI setup, then open the room again.",
		"No AI model is set up yet. Add an API key or a gateway in Settings, AI setup, then open the room again.",
		"Ask your admin to add a model in Settings, AI setup.",
		"Add an API key or a gateway in Settings, AI setup.",
		"No models yet. Ask your admin to add one in Settings, AI setup.",
		"No models yet. Add an API key or a gateway in Settings, AI setup.",
		"Your admin sets up the models for this server. Each room picks one in Room settings, Model.",
		"Open the gear, then Settings, AI setup. Add an API key or connect your company gateway. Set the default models for your rooms there.",
		"Anthropic isn't available on this server. Choose another model to continue this conversation, or tell your admin.",
		"Anthropic did not accept the saved key. Choose another model to continue this conversation, or tell your admin.",
		"Claude Opus 5.5 cannot answer because its key isn't tied to a workspace. Choose another model to continue this conversation, or tell your admin.",
		"Anthropic isn't available on this server. Choose another model to continue this conversation.",
		"The Memory model's key is missing or was not accepted. No memory was updated. Choose another Memory model in Room settings, Model, or tell your admin.",
		"The Memory model has a key that isn't tied to a workspace. No memory was updated. Choose another Memory model in Room settings, Model, or tell your admin.",
		"The Memory model's key is missing or was not accepted. No memory was updated. Check it in Settings, AI setup, then run this step again.",
	];

	same(await sentences(), DESKTOP, "on this computer, the server's sentences");
	registerServerHooks({});
	const shared = await sentences();
	same(shared, SHARED, "on a shared server, the server's sentences");
	const readAsSignIn = [...Object.values(shared), ...PAGE_SHARED].filter((sentence) => signInFailed(sentence));
	same(readAsSignIn, [], "on a shared server, sentences the sign-in matcher reads as a failed sign-in");
} finally {
	backend.close();
	fs.rmSync(tempHome, { recursive: true, force: true });
}

console.log("credential-words smoke: ok");
