// The memory entries API against a really spawned web server (memory v2, D2).
//
// It drives every route of the entries contract on one room, in the order a
// person would: open the pane (which migrates a v1 file once), add an entry,
// reword it, pin it, move it to another topic, close an open loop, delete an
// entry to the archive, restore it, and read the history — which must name the
// hand edits as `user_edit` beside the migration. It covers the budget setting's
// ceiling (80000 accepted, 80001 refused rather than quietly clamped), and it
// ends on the room that is MID-CONVERSATION: a real turn is opened against a
// gateway that never answers, and the pane must still open, read-only, on a
// memory that has not been touched.
//
// Offline: the only model call is the one that hangs on purpose.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authedFetch, type AuthedFetchInit, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "memory-entries-api-home-"));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 24000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;
const agentDir = path.join(tempHome, ".exxperts", "agent");
const productAppRoot = path.join(tempHome, ".exxperts", "app");
const agentsRoot = path.join(productAppRoot, "personalized-agents");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function smokeEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY", "EXXETA_AI_API_KEY", "COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "GEMINI_API_KEY", "GOOGLE_CLOUD_API_KEY", "OPENROUTER_API_KEY"]) {
		delete env[key];
	}
	env.HOME = tempHome;
	env.USERPROFILE = tempHome;
	env.PORT = String(port);
	Object.assign(env, SMOKE_SERVER_AUTH_ENV);
	env.EXXETA_HOME = repoRoot;
	env.EXXPERTS_CODING_AGENT_DIR = agentDir;
	return env;
}

async function waitForServer(server: ChildProcessWithoutNullStreams): Promise<void> {
	const deadline = Date.now() + 30_000;
	let lastError = "server did not respond";
	while (Date.now() < deadline) {
		if (server.exitCode != null) throw new Error(`server exited before startup with code ${server.exitCode}`);
		try {
			const response = await fetch(`${baseUrl}/healthz`);
			if (response.ok) return;
			lastError = `healthz returned ${response.status}`;
		} catch (error) {
			lastError = (error as Error).message;
		}
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`server did not become ready: ${lastError}`);
}

async function requestJson(pathname: string, init?: AuthedFetchInit): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, init);
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

function jsonBody(method: string, body: unknown): AuthedFetchInit {
	return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

const V1_L1B = (agentId: string) => `<!-- exxeta:l1b schema_version=1 -->

## Chronos

- Persistent agent id: ${agentId}
- Lifecycle state: ready
- Last checkpoint: cp_20260830_0001
- Last checkpoint at: 2026-08-30T09:00:00.000Z
- Last consolidation: none

## Deep Memory

### Commercial terms

- The Nordwind contract renews annually; legal signs before June.
- Invoices go out on the first working day of the month.

### Working style

- Send commercial summaries as one page, numbers first.

## Active Items

- Chase the vendor for the signed addendum.

## Recent Context

No checkpointed sessions yet.
`;

// A gateway that opens the stream and then says nothing, so the room's turn
// stays genuinely in flight for as long as the smoke needs it. Nothing about the
// busy state is faked: the server's own active-turn state is what the routes read.
let hangingRequests = 0;
const gateway = http.createServer((req, res) => {
	if (req.method !== "POST" || !String(req.url ?? "").endsWith("/chat/completions")) {
		res.writeHead(404).end();
		return;
	}
	req.on("data", () => {});
	req.on("end", () => {
		hangingRequests += 1;
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		res.write(`data: ${JSON.stringify({ id: "cmpl_hang", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "room-model", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })}\n\n`);
		// Never finished: only the smoke's teardown closes it.
	});
});

async function waitUntil(predicate: () => Promise<boolean> | boolean, label: string, timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`timed out waiting until ${label}`);
}

let server: ChildProcessWithoutNullStreams | null = null;
const serverOutput: string[] = [];
let busySocket: any = null;

try {
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	const gatewayPort = (gateway.address() as AddressInfo).port;
	fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	fs.mkdirSync(productAppRoot, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
		providers: { "openai-compatible": { name: "Silent Gateway", baseUrl: `http://127.0.0.1:${gatewayPort}/v1`, api: "openai-completions", models: [{ id: "room-model", name: "Room Model", contextWindow: 128000, maxTokens: 16384 }] } },
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-memory-entries-key" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(productAppRoot, "openai-compatible-ai-profile.json"), JSON.stringify({
		profileId: "openai-compatible",
		providerId: "openai-compatible",
		label: "Silent Gateway",
		roomModels: [{ modelId: "room-model", label: "Room Model" }],
		maintenanceModel: "room-model",
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(productAppRoot, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2), { mode: 0o600 });

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeEnv(),
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server);

	const created = await requestJson("/api/persistent-agents", jsonBody("POST", { displayName: "Memory Entries API Smoke Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }));
	assert(created.status === 201, `room creation should return 201, got ${created.status}: ${JSON.stringify(created.body)}`);
	const roomId = String(created.body?.agent?.id ?? "");
	assert(roomId, "room creation should return an agent id");
	const room = `/api/persistent-agents/${roomId}`;
	const l1bPath = path.join(agentsRoot, roomId, "L1b", "current.md");
	fs.writeFileSync(l1bPath, V1_L1B(roomId), { mode: 0o600 });

	// --- 1. Open the pane: the list reads a v1 file without writing it -------
	const listed = await requestJson(`${room}/memory/entries`);
	assert(listed.status === 200, `GET memory/entries should return 200, got ${listed.status}: ${JSON.stringify(listed.body)}`);
	assert(listed.body.migrated !== true, "listing never migrates the file; the first edit does");
	assert(fs.readFileSync(l1bPath, "utf-8") === V1_L1B(roomId), "listing a v1 room leaves its file byte-identical");
	assert(listed.body.budget.budgetTokens === 20_000 && listed.body.budget.overBudget === false, `the list must disclose the budget, got ${JSON.stringify(listed.body.budget)}`);
	const topics: any[] = listed.body.topics;
	assert(topics.map((t) => t.title).join(",") === "Commercial terms,Working style,Active Items", `topics should come back in document order, got ${JSON.stringify(topics.map((t) => t.title))}`);
	const allEntries = (payload: any): any[] => payload.topics.flatMap((t: any) => t.entries);
	assert(allEntries(listed.body).length === 4, `four bullets become four entries, got ${allEntries(listed.body).length}`);
	assert(allEntries(listed.body).every((e: any) => /^m-\d{4}$/.test(e.id) && e.tokens > 0 && !e.text.includes("<!-- e:")), "every card carries an id, a size and no metadata line");
	assert(listed.body.archive.count === 0, "a fresh room's archive is empty");
	const relisted = await requestJson(`${room}/memory/entries`);
	assert(relisted.body.migrated === undefined, "listing again must not migrate again");

	const nordwind = allEntries(relisted.body).find((e: any) => e.text.includes("Nordwind"));
	const openItem = allEntries(relisted.body).find((e: any) => e.kind === "item");
	assert(nordwind && openItem, "fixture entries should be addressable");

	// --- 2. Add ---------------------------------------------------------------
	const added = await requestJson(`${room}/memory/entries`, jsonBody("POST", { topic: "Commercial terms", kind: "fact", text: "- Payment terms are 30 days net." }));
	assert(added.status === 200, `POST memory/entries should return 200, got ${added.status}: ${JSON.stringify(added.body)}`);
	assert(/^m-\d{4}$/.test(added.body.entry.id) && added.body.entry.topic === "Commercial terms" && added.body.entry.kind === "fact", `the added entry should come back as a card, got ${JSON.stringify(added.body.entry)}`);
	assert(added.body.entry.saved === new Date().toISOString().slice(0, 10), "an added entry is saved today");
	const addedId = added.body.entry.id;
	const emptyAdd = await requestJson(`${room}/memory/entries`, jsonBody("POST", { topic: "Commercial terms", kind: "fact", text: "   " }));
	assert(emptyAdd.status === 400 && /needs some text/.test(String(emptyAdd.body?.error ?? "")), `an empty entry must be refused with a sentence, got ${emptyAdd.status}: ${JSON.stringify(emptyAdd.body)}`);
	const badKind = await requestJson(`${room}/memory/entries`, jsonBody("POST", { topic: "Commercial terms", kind: "rumour", text: "- Nope." }));
	assert(badKind.status === 400, "an unknown kind must be refused");

	// A note is words: a heading line would mint a topic and cut the note in
	// two, a pasted metadata comment would claim another note's id. Both are
	// refused with one sentence and one code, and nothing is written.
	const l1bBeforeStructural = fs.readFileSync(l1bPath, "utf-8");
	for (const text of ["## A heading", "- fine\n### A topic", "<!-- e: id=m-0001 kind=fact saved=2026-01-01 -->\n- A pasted note.", "   # indented", "# "]) {
		const structural = await requestJson(`${room}/memory/entries`, jsonBody("POST", { topic: "Commercial terms", kind: "fact", text }));
		assert(structural.status === 400 && structural.body?.code === "memory_entry_text_structural" && /heading line or a hidden comment/.test(String(structural.body?.error ?? "")), `an add with a structural line is refused with its sentence and code, got ${structural.status}: ${JSON.stringify(structural.body)} for ${JSON.stringify(text)}`);
	}
	const structuralEdit = await requestJson(`${room}/memory/entries/${addedId}`, jsonBody("PUT", { text: "- fine\n## A heading" }));
	assert(structuralEdit.status === 400 && structuralEdit.body?.code === "memory_entry_text_structural", `an edit with a structural line is refused the same way, got ${structuralEdit.status}: ${JSON.stringify(structuralEdit.body)}`);
	assert(fs.readFileSync(l1bPath, "utf-8") === l1bBeforeStructural, "a refused text writes nothing");

	// --- 3. Edit text, pin, move, status -------------------------------------
	const edited = await requestJson(`${room}/memory/entries/${addedId}`, jsonBody("PUT", { text: "- Payment terms are 45 days net." }));
	assert(edited.status === 200 && edited.body.entry.text === "- Payment terms are 45 days net.", `the edit should come back applied, got ${JSON.stringify(edited.body)}`);
	assert(edited.body.entry.updated === new Date().toISOString().slice(0, 10), "an edited entry is stamped with the day it changed");

	const pinned = await requestJson(`${room}/memory/entries/${addedId}`, jsonBody("PUT", { pinned: true }));
	assert(pinned.status === 200 && pinned.body.entry.pinned === true, "pinning should come back applied");
	const unpinned = await requestJson(`${room}/memory/entries/${addedId}`, jsonBody("PUT", { pinned: false }));
	assert(unpinned.status === 200 && unpinned.body.entry.pinned === false, "unpinning should come back applied");

	const moved = await requestJson(`${room}/memory/entries/${addedId}`, jsonBody("PUT", { topic: "Working style" }));
	assert(moved.status === 200 && moved.body.entry.topic === "Working style", `a move should come back in its new topic, got ${JSON.stringify(moved.body.entry)}`);

	const closed = await requestJson(`${room}/memory/entries/${openItem.id}`, jsonBody("PUT", { status: "done" }));
	assert(closed.status === 200 && closed.body.entry.status === "done", `closing an open loop should come back done, got ${JSON.stringify(closed.body.entry)}`);
	const badStatus = await requestJson(`${room}/memory/entries/${openItem.id}`, jsonBody("PUT", { status: "maybe" }));
	assert(badStatus.status === 400, "an unknown status must be refused");
	const emptyPut = await requestJson(`${room}/memory/entries/${openItem.id}`, jsonBody("PUT", {}));
	assert(emptyPut.status === 400 && /Nothing to change/.test(String(emptyPut.body?.error ?? "")), "a PUT with no field must say so");
	const ghost = await requestJson(`${room}/memory/entries/m-9999`, jsonBody("PUT", { text: "- nope" }));
	assert(ghost.status === 400 && /not in this room's memory/.test(String(ghost.body?.error ?? "")), `an unknown entry must be refused with a sentence, got ${ghost.status}: ${JSON.stringify(ghost.body)}`);

	// --- 4. Delete to the archive, then restore ------------------------------
	const deleted = await requestJson(`${room}/memory/entries/${nordwind.id}`, { method: "DELETE" });
	assert(deleted.status === 200 && deleted.body.archived.id === nordwind.id && deleted.body.archived.why === "user", `a delete should return the archived card, got ${JSON.stringify(deleted.body)}`);
	const invoices = allEntries(relisted.body).find((e: any) => e.text.includes("Invoices"));
	assert(invoices, "second fixture entry should be addressable");
	const deletedToo = await requestJson(`${room}/memory/entries/${invoices.id}`, { method: "DELETE" });
	assert(deletedToo.status === 200, `the second delete should return 200, got ${deletedToo.status}: ${JSON.stringify(deletedToo.body)}`);

	const archiveList = await requestJson(`${room}/memory/archive?limit=50`);
	assert(archiveList.status === 200 && archiveList.body.entries.length === 2, `the archive list should hold both deleted entries, got ${JSON.stringify(archiveList.body)}`);
	assert(archiveList.body.next === undefined, "a one-page archive has no next cursor");
	// The cursor is walked, not just returned: a page of one, then the rest.
	const firstPage = await requestJson(`${room}/memory/archive?limit=1`);
	assert(firstPage.body.entries.length === 1 && typeof firstPage.body.next === "string", `a partial page must hand back a cursor, got ${JSON.stringify(firstPage.body)}`);
	const secondPage = await requestJson(`${room}/memory/archive?limit=1&before=${encodeURIComponent(firstPage.body.next)}`);
	assert(secondPage.body.entries.length === 1 && secondPage.body.entries[0].id !== firstPage.body.entries[0].id, `the next page must continue where the first ended, got ${JSON.stringify(secondPage.body)}`);
	assert(secondPage.body.next === undefined, "the last page has no cursor");

	const afterDelete = await requestJson(`${room}/memory/entries`);
	assert(!allEntries(afterDelete.body).some((e: any) => e.id === nordwind.id), "a deleted entry is out of the core");
	assert(afterDelete.body.archive.count === 2 && afterDelete.body.archive.byTopic[0].topic === "Commercial terms", `the list must disclose the archive by topic, got ${JSON.stringify(afterDelete.body.archive)}`);

	const restored = await requestJson(`${room}/memory/archive/${nordwind.id}/restore`, { method: "POST" });
	assert(restored.status === 200 && restored.body.entry.id === nordwind.id, `a restore should return the entry card, got ${JSON.stringify(restored.body)}`);
	const afterRestore = await requestJson(`${room}/memory/entries`);
	assert(allEntries(afterRestore.body).some((e: any) => e.id === nordwind.id), "a restored entry is back in the core");
	assert(afterRestore.body.archive.count === 1, "a restored entry leaves the archive and the other stays");
	const ghostRestore = await requestJson(`${room}/memory/archive/m-9999/restore`, { method: "POST" });
	assert(ghostRestore.status === 400 && /archive/.test(String(ghostRestore.body?.error ?? "")), "restoring what is not archived must be refused with a sentence");

	// --- 4b. Delete for good: the one way out of the archive ------------------
	// The archive is where a deleted note waits to be restored; a person may
	// decide it has no way back. The row leaves entries.md, the notes file is
	// not touched (so no snapshot of it is taken), and the history says what
	// went with the note's first lines.
	const ghostGone = await requestJson(`${room}/memory/archive/m-9999`, { method: "DELETE" });
	assert(ghostGone.status === 400 && /not in this room's archive/.test(String(ghostGone.body?.error ?? "")), `deleting what is not archived must be refused with the archive's sentence, got ${ghostGone.status}: ${JSON.stringify(ghostGone.body)}`);
	const l1bBeforeGone = fs.readFileSync(l1bPath, "utf-8");
	const gone = await requestJson(`${room}/memory/archive/${invoices.id}`, { method: "DELETE" });
	assert(gone.status === 200 && gone.body.deleted?.id === invoices.id && gone.body.deleted.topic === "Commercial terms", `a delete for good should return the note as it was, got ${gone.status}: ${JSON.stringify(gone.body)}`);
	assert(gone.body.archive?.count === 0, `the answer says what the archive holds now, got ${JSON.stringify(gone.body.archive)}`);
	assert(fs.readFileSync(l1bPath, "utf-8") === l1bBeforeGone, "a delete for good leaves the notes file byte for byte as it was");
	const archiveAfterGone = await requestJson(`${room}/memory/archive?limit=50`);
	assert(archiveAfterGone.body.entries.length === 0, `the row is out of the archive, got ${JSON.stringify(archiveAfterGone.body.entries)}`);
	assert(!fs.readFileSync(path.join(agentsRoot, roomId, "L1b", "archive", "entries.md"), "utf-8").includes(invoices.id), "the row is out of entries.md itself");
	const afterGone = await requestJson(`${room}/memory/entries`);
	assert(afterGone.body.archive.count === 0, "the entries list counts the archive without the deleted row");
	const restoreGone = await requestJson(`${room}/memory/archive/${invoices.id}/restore`, { method: "POST" });
	assert(restoreGone.status === 400 && /not in this room's archive/.test(String(restoreGone.body?.error ?? "")), "a note deleted for good cannot be restored");
	const goneAgain = await requestJson(`${room}/memory/archive/${invoices.id}`, { method: "DELETE" });
	assert(goneAgain.status === 400 && /not in this room's archive/.test(String(goneAgain.body?.error ?? "")), "deleting it twice is refused with the same sentence");
	const goneRecords = fs.readdirSync(path.join(agentsRoot, roomId, "events", "memory-edit"))
		.map((name) => JSON.parse(fs.readFileSync(path.join(agentsRoot, roomId, "events", "memory-edit", name), "utf-8")))
		.filter((record: any) => record.entryOperation === "archive_delete");
	assert(goneRecords.length === 1, `one archive delete leaves one record, got ${goneRecords.length}`);
	const goneRecord = goneRecords[0];
	assert(goneRecord.kind === "user_edit" && goneRecord.entryId === invoices.id, `the record is a user edit about that note, got ${JSON.stringify({ kind: goneRecord.kind, entryId: goneRecord.entryId })}`);
	assert(goneRecord.edit?.op === "archive_delete" && goneRecord.edit.id === invoices.id && goneRecord.edit.topic === "Commercial terms" && goneRecord.edit.section === "Deep Memory", `the record keeps the note's address, got ${JSON.stringify(goneRecord.edit)}`);
	assert(typeof goneRecord.edit.text === "string" && goneRecord.edit.text.includes("Invoices") && goneRecord.edit.text.length <= 200, `the record keeps the note's first lines, got ${JSON.stringify(goneRecord.edit.text)}`);
	assert(goneRecord.paths.archivedL1bRelPath === undefined && typeof goneRecord.paths.eventRelPath === "string", `no snapshot is named, because the notes file did not change, got ${JSON.stringify(goneRecord.paths)}`);

	// --- 5. Every write left its trace in the history ------------------------
	const history = await requestJson(`${room}/memory/history`);
	assert(history.status === 200, `GET memory/history should return 200, got ${history.status}`);
	const rows: any[] = history.body.history;
	const userEdits = rows.filter((row) => row.kind === "user_edit");
	const migrations = rows.filter((row) => row.kind === "migrate");
	assert(migrations.length === 1 && migrations[0].entriesAssigned === 4, `the migration must appear once, got ${JSON.stringify(migrations)}`);
	assert(userEdits.length === 10, `every hand edit must appear once (add, edit, pin, unpin, move, status, two deletes, restore, delete for good), got ${userEdits.length}`);
	assert(userEdits.every((row) => typeof row.entryId === "string" && typeof row.operation === "string"), "every user_edit row names its entry and operation");
	const operations = userEdits.map((row) => row.operation).sort().join(",");
	assert(operations === "add,archive_delete,delete,delete,edit,move,pin,restore,status,unpin", `the history must name what each edit did, got ${operations}`);
	const goneRow = userEdits.find((row) => row.operation === "archive_delete");
	assert(goneRow && goneRow.topic === "Commercial terms" && goneRow.entryId === invoices.id && goneRow.diffable === false, `the delete-for-good row names the note's topic and offers no diff, got ${JSON.stringify(goneRow)}`);
	// Every row names itself the way the undo route takes a save back, so a
	// History row that offers Undo already holds the key that undo needs.
	assert(rows.every((row) => typeof row.saveId === "string" && row.saveId.length > 0 && row.saveId === row.id), `every history row must carry its saveId, got ${JSON.stringify(rows.map((row) => ({ kind: row.kind, id: row.id, saveId: row.saveId })).slice(0, 4))}`);

	// --- 5b. The Memory tab and the room's limit count the same bytes --------
	// The stored file of a migrated room carries bookkeeping — the id counter
	// and one metadata line per note — that never reaches a prompt. The limit
	// has always measured the context render; the tab measures it too, so the
	// two surfaces can no longer disagree about how full a room's memory is.
	const storedL1b = fs.readFileSync(l1bPath, "utf-8");
	assert(/<!--\s*entries: next=/.test(storedL1b) && /<!--\s*e: id=m-\d+/.test(storedL1b), "the migrated file should carry the id counter and per-note metadata the render drops");
	const tab = await requestJson(`/api/memory/rooms/${roomId}`);
	assert(tab.status === 200, `GET the room's memory detail should return 200, got ${tab.status}`);
	const budgetNow = await requestJson(`${room}/memory/entries`);
	assert(
		tab.body.memoryLimit && tab.body.memoryLimit.reviewTargetEstimatedTokens === budgetNow.body.budget.reviewTargetTokens,
		`the tab's numerator must be the limit's numerator, got ${JSON.stringify(tab.body.memoryLimit)} against ${JSON.stringify(budgetNow.body.budget)}`,
	);
	assert(tab.body.memoryLimit.budgetTokens === budgetNow.body.budget.budgetTokens, "both surfaces read one limit");
	assert(typeof tab.body.notes === "number" && tab.body.notes > 0, `the tab should count this room's notes, got ${tab.body.notes}`);
	assert(Array.isArray(tab.body.memoryTopics) && tab.body.memoryTopics.every((row: any) => typeof row.topic === "string" && typeof row.notes === "number"), `the tab should list the room's topics with their note counts, got ${JSON.stringify(tab.body.memoryTopics)}`);
	assert(tab.body.memoryTopics.reduce((sum: number, row: any) => sum + row.notes, 0) === tab.body.notes, "the topic counts must add up to the room's note count");

	// --- 6. Every write is archived and recorded on disk ---------------------
	const snapshots = fs.readdirSync(path.join(agentsRoot, roomId, "L1b", "archive")).filter((name) => name.includes("-before-"));
	const records = fs.readdirSync(path.join(agentsRoot, roomId, "events", "memory-edit"));
	// Eleven writes, ten snapshots: the delete for good recorded itself but
	// snapshotted nothing, because it changed nothing in the notes file.
	assert(snapshots.length === 10 && records.length === 11, `ten notes-file writes = ten snapshots, eleven records with the delete for good, got ${snapshots.length} and ${records.length}`);

	// --- 7. The budget ceiling ------------------------------------------------
	const atCeiling = await requestJson(`${room}/maintenance-settings`, jsonBody("PUT", { memoryBudgetTokens: 80_000 }));
	assert(atCeiling.status === 200 && atCeiling.body.settings.memoryBudgetTokens === 80_000, `80000 is inside the raised ceiling, got ${atCeiling.status}: ${JSON.stringify(atCeiling.body)}`);
	const overCeiling = await requestJson(`${room}/maintenance-settings`, jsonBody("PUT", { memoryBudgetTokens: 80_001 }));
	assert(overCeiling.status === 400 && /between 10000 and 80000/.test(String(overCeiling.body?.error ?? "")), `80001 must be refused, not clamped, got ${overCeiling.status}: ${JSON.stringify(overCeiling.body)}`);
	const stillAtCeiling = await requestJson(`${room}/maintenance-settings`);
	assert(stillAtCeiling.body.settings.memoryBudgetTokens === 80_000, "a refused budget must not have been stored");
	const listedAtCeiling = await requestJson(`${room}/memory/entries`);
	assert(listedAtCeiling.body.budget.budgetTokens === 80_000, "the entries list reads the room's own budget");

	// --- 7b. A restore never puts a note in beside itself ---------------------
	// The archive can hold a row whose note is still in the core: an older
	// text of it (`-v1`), or a copy an earlier fault left on both sides. Such a
	// restore is a conflict, with its own sentence and code; the row stays in
	// the archive, addressable, and the notes file is not touched.
	const entriesPath = path.join(agentsRoot, roomId, "L1b", "archive", "entries.md");
	const stray = (id: string, text: string) => `<!-- e: id=${id} kind=fact saved=2026-08-30 archived=2026-09-14 why=superseded topic="Commercial terms" section="Deep Memory" -->\n${text}\n\n`;
	fs.writeFileSync(entriesPath, fs.readFileSync(entriesPath, "utf-8") + stray(nordwind.id, "- A copy of the Nordwind note that never left the core.") + stray(`${nordwind.id}-v1`, "- The Nordwind note as it read before."), { mode: 0o600 });
	const l1bBeforeConflict = fs.readFileSync(l1bPath, "utf-8");
	assert(fs.readFileSync(l1bPath, "utf-8").includes(`id=${nordwind.id} `), "the fixture note is in the core");
	for (const id of [nordwind.id, `${nordwind.id}-v1`]) {
		const conflict = await requestJson(`${room}/memory/archive/${id}/restore`, { method: "POST" });
		assert(conflict.status === 409 && conflict.body?.code === "memory_entry_already_in_core" && conflict.body?.error === "This note is already in memory.", `restoring a note the core holds is a conflict with its sentence, got ${conflict.status}: ${JSON.stringify(conflict.body)} for ${id}`);
	}
	assert(fs.readFileSync(l1bPath, "utf-8") === l1bBeforeConflict, "a refused restore writes nothing to the notes file");
	const conflictArchive = await requestJson(`${room}/memory/archive?limit=50`);
	assert(conflictArchive.body.entries.length === 2 && conflictArchive.body.entries.every((e: any) => e.id === nordwind.id || e.id === `${nordwind.id}-v1`), `both rows stay in the archive, got ${JSON.stringify(conflictArchive.body.entries.map((e: any) => e.id))}`);
	const stillOne = await requestJson(`${room}/memory/entries`);
	assert(allEntries(stillOne.body).filter((e: any) => e.id === nordwind.id || e.id === `${nordwind.id}-v1`).length === 1, "the core holds the note once");
	for (const id of [nordwind.id, `${nordwind.id}-v1`]) {
		const cleared = await requestJson(`${room}/memory/archive/${id}`, { method: "DELETE" });
		assert(cleared.status === 200 && cleared.body.deleted?.id === id, `the stray row can still be deleted for good, got ${cleared.status}: ${JSON.stringify(cleared.body)}`);
	}
	assert((await requestJson(`${room}/memory/archive?limit=50`)).body.entries.length === 0, "and the archive is empty again");

	// --- 8. The pane while the room is in a conversation ----------------------
	// The field failure: with a turn in flight, the read-only Memory pane asked
	// for the room's entries and got a 400 "This room is in the middle of a turn"
	// where the memory should have been. A read changes nothing, so it answers —
	// read-only, with the reason — and on a room whose file has no entry ids it
	// renders from a migration done in memory, leaving the file exactly as it is.
	const busyRoom = await requestJson("/api/persistent-agents", jsonBody("POST", { displayName: "Memory Entries Busy Smoke Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }));
	assert(busyRoom.status === 201, `the busy room should be created, got ${busyRoom.status}: ${JSON.stringify(busyRoom.body)}`);
	const busyId = String(busyRoom.body?.agent?.id ?? "");
	const busy = `/api/persistent-agents/${busyId}`;
	const busyL1bPath = path.join(agentsRoot, busyId, "L1b", "current.md");
	fs.writeFileSync(busyL1bPath, V1_L1B(busyId), { mode: 0o600 });
	const busyBytesBefore = fs.readFileSync(busyL1bPath, "utf-8");

	const conversationId = `smokeconv_busy_${Date.now().toString(36)}`;
	const seeded = await requestJson(`${busy}/threads/${conversationId}`, jsonBody("PUT", { state: "active", origin: "launcher", model: { provider: "openai-compatible", model: "room-model" }, items: [] }));
	assert(seeded.status === 200, `seeding the busy room's thread should return 200, got ${seeded.status}: ${JSON.stringify(seeded.body).slice(0, 300)}`);
	const WebSocketImpl: any = (await import("ws")).default;
	busySocket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${busyId}&conversationId=${conversationId}&modelProvider=openai-compatible&model=room-model&reattach=1`, { headers: { ...SMOKE_AUTH_HEADERS } });
	const busyFrames: any[] = [];
	busySocket.addEventListener("message", (event: { data: unknown }) => {
		try { busyFrames.push(JSON.parse(String(event.data))); } catch {}
	});
	await new Promise<void>((resolve, reject) => {
		busySocket.addEventListener("open", () => resolve());
		busySocket.addEventListener("error", () => reject(new Error("the busy room's websocket failed to connect")));
	});
	await waitUntil(() => busyFrames.some((frame) => frame?.type === "ready"), "the busy room's socket is ready");
	busySocket.send(JSON.stringify({ type: "prompt", text: "Tell me what you remember about the Nordwind contract." }));
	await waitUntil(() => hangingRequests > 0, "the busy room's turn reaches the gateway");
	const roomIsBusy = async (): Promise<boolean> => {
		const statuses = await requestJson("/api/persistent-agents");
		const rows = statuses.body?.agents ?? statuses.body ?? [];
		return (Array.isArray(rows) ? rows : []).find((row: any) => row.id === busyId)?.activeThread?.inFlight === true;
	};
	await waitUntil(roomIsBusy, "the busy room reports a turn in flight");

	const busyEntries = await requestJson(`${busy}/memory/entries`);
	assert(busyEntries.status === 200, `a read never refuses for a busy room, got ${busyEntries.status}: ${JSON.stringify(busyEntries.body)}`);
	assert(busyEntries.body.readOnly === true && typeof busyEntries.body.reason === "string" && busyEntries.body.reason.length > 0, `a busy room's entries come back read-only with the reason, got ${JSON.stringify({ readOnly: busyEntries.body.readOnly, reason: busyEntries.body.reason })}`);
	const busyCards = (busyEntries.body.topics ?? []).flatMap((topic: any) => topic.entries);
	assert(busyCards.length === 4, `the pane must show the memory, not an error, and it showed ${busyCards.length} entries`);
	assert(busyCards.every((entry: any) => /^m-\d{4}$/.test(entry.id)), `an unmigrated file is rendered from a migration done in memory, so every card still has an id, got ${JSON.stringify(busyCards.map((entry: any) => entry.id))}`);
	assert(busyEntries.body.migrated === undefined, "a busy read never claims it migrated the file, because it did not write one");
	assert(fs.readFileSync(busyL1bPath, "utf-8") === busyBytesBefore, "a busy read writes nothing: the room's memory file must be byte for byte as it was");
	assert(!fs.existsSync(path.join(agentsRoot, busyId, "events", "memory-edit")) || fs.readdirSync(path.join(agentsRoot, busyId, "events", "memory-edit")).length === 0, "a busy read records no memory edit");

	const busyArchive = await requestJson(`${busy}/memory/archive`);
	assert(busyArchive.status === 200 && busyArchive.body.readOnly === true, `the archive list reads while the room is busy, got ${busyArchive.status}: ${JSON.stringify(busyArchive.body)}`);
	const busyHistory = await requestJson(`${busy}/memory/history`);
	assert(busyHistory.status === 200 && busyHistory.body.readOnly === true && Array.isArray(busyHistory.body.history), `the history reads while the room is busy, got ${busyHistory.status}: ${JSON.stringify(busyHistory.body).slice(0, 200)}`);

	// A write still waits: the turn in flight is reading this memory.
	const busyWrite = await requestJson(`${busy}/memory/entries`, jsonBody("POST", { topic: "Commercial terms", kind: "fact", text: "- Written mid-turn." }));
	assert(busyWrite.status === 400 && busyWrite.body?.code === "memory_room_busy", `a write during a turn is still refused, got ${busyWrite.status}: ${JSON.stringify(busyWrite.body)}`);
	const busyEdit = await requestJson(`${busy}/memory/entries/${busyCards[0].id}`, jsonBody("PUT", { pinned: true }));
	assert(busyEdit.status === 400 && busyEdit.body?.code === "memory_room_busy", `an edit during a turn is still refused, got ${busyEdit.status}: ${JSON.stringify(busyEdit.body)}`);
	const busyGone = await requestJson(`${busy}/memory/archive/m-0001`, { method: "DELETE" });
	assert(busyGone.status === 400 && busyGone.body?.code === "memory_room_busy", `a delete for good during a turn is refused before anything is looked up, got ${busyGone.status}: ${JSON.stringify(busyGone.body)}`);
	assert(fs.readFileSync(busyL1bPath, "utf-8") === busyBytesBefore, "a refused write leaves the memory untouched");

	console.log("memory-entries-api-smoke: OK");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp home preserved for inspection: ${tempHome}`);
	console.error(serverOutput.slice(-40).join(""));
	process.exitCode = 1;
} finally {
	try { busySocket?.close(); } catch {}
	await stopSmokeServer(server);
	gateway.closeAllConnections?.();
	gateway.close();
	if (process.exitCode !== 1) fs.rmSync(tempHome, { recursive: true, force: true });
}
