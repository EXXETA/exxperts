// A room's live state rides one hidden room-state message, never the system
// prompt, as the model really receives it (synthetic gateway, real server).
// A change to the system prompt makes the provider write the whole
// conversation to its cache again, so it must not move for the room's state.
// Pins:
//   1. the system prompt stays byte-identical across a rename, an instruction
//      edit, a skill switch, a new file and a reconnect, and carries none of
//      the live sections, only the room-tools stanza after the boot prompt;
//   2. the first turn sends a whole copy after the person's message, a turn
//      with nothing changed sends none, and each change sends one new copy
//      that carries it; the model's Attachments list shows sizes only, while the
//      Attachments panel still shows a parsed PDF's pages;
//   3. instructions A, then B, then A: the last copy names the original ones
//      and no longer carries B;
//   4. Remember's transcript of a conversation that holds copies quotes none;
//   5. a part that cannot be read (the Attachments folder, the instructions) keeps
//      the latest copy's part, also one a compaction removed, and sends no
//      copy on its own;
//   6. one file that cannot be looked up leaves its readable neighbours in
//      the Attachments panel and search_file, and only the model's Attachments list
//      counts that read as unreadable.
// The page's chat and history are checked in a browser by room-state-page-smoke.ts.
import fs from "node:fs";
import path from "node:path";
import { ROOM_STATE_CUSTOM_TYPE } from "@exxeta/exxperts-runtime";
import { nextRoomStateMessage, roomStateMessageFor, type RoomStateParts } from "../src/room-state-message.js";
import { assert, copiesIn, openRoom, personsNewest, rename, requestJson, ROOM_STATE_HEADING, RoomSocket, setInstructions, startRoomStateServer, stopRoomStateServer, tempHome, type SentRequest } from "./room-state-setup.js";

const LIVE_HEADINGS = ["## Current identity", "## Current instructions", "## Current workspace", "## Enabled skills", "## Attachments in this room"];
let passes = 0;
const pass = (label: string) => { passes++; console.log(`  ok ${label}`); };
const failures: string[] = [];
/** Runs one case on its own, so a failure in one still lets the others show theirs. */
async function scenario(label: string, run: () => Promise<void>): Promise<void> {
	try {
		await run();
	} catch (caught) {
		failures.push(label);
		console.error(`  FAILED ${label}: ${(caught as Error).message}`);
	}
}

/** The one request a prompt sent, with its person's message checked. */
function only(sent: SentRequest[], text: string): SentRequest {
	assert(sent.length === 1, `"${text}" should reach the model once, got ${sent.length} requests`);
	assert(personsNewest(sent[0]) === text, `the request should end on "${text}", got ${JSON.stringify(personsNewest(sent[0]))}`);
	return sent[0];
}

/** The copy a request sent right after the person's message, as its last message; fails when there is none. */
function newCopy(request: SentRequest, label: string): string {
	const last = request.messages.at(-1);
	assert(last && copiesIn({ system: "", messages: [last] }).length === 1, `${label}: the request should end on a new room-state copy, got ${JSON.stringify(request.messages.map((message) => `${message.role}: ${message.text.slice(0, 40)}`))}`);
	assert(request.messages.at(-2)?.role === "user" && request.messages.at(-2)?.text === personsNewest(request), `${label}: the copy comes right after the person's message`);
	return last.text;
}

/** A valid one-page PDF with a text layer. */
function onePagePdf(): Buffer {
	const objects = [
		"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
		"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
		"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
		"4 0 obj\n<< /Length 84 >>\nstream\nBT /F1 12 Tf 72 720 Td (Quarterly payment terms are 60 days) Tj ET\nendstream\nendobj\n",
		"5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
	];
	let body = "%PDF-1.4\n";
	const offsets: number[] = [];
	for (const object of objects) {
		offsets.push(Buffer.byteLength(body, "latin1"));
		body += object;
	}
	const xrefOffset = Buffer.byteLength(body, "latin1");
	let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
	body += `${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
	return Buffer.from(body, "latin1");
}

let error: unknown;
const sockets: RoomSocket[] = [];
try {
	await startRoomStateServer();

	// --- 1 and 2: one room through every kind of change ----------------------
	const { roomId, conversationId } = await openRoom("State Room");
	await scenario("every kind of change, then a reconnect", async () => {
		let room = await RoomSocket.connect(roomId, conversationId);
		sockets.push(room);
		const first = only(await room.prompt("Hello one."), "Hello one.");
		const system = first.system;
		assert(system.length > 0 && system.includes("\n\n## Room tools\n\n"), "the system prompt carries the room-tools stanza");
		for (const heading of LIVE_HEADINGS) assert(!system.includes(heading), `the system prompt must not carry "${heading}", the live state rides the copy`);
		const firstCopy = newCopy(first, "the first turn");
		assert(firstCopy.includes("Your name is now **State Room**"), `the first copy names the room, got:\n${firstCopy}`);
		assert(firstCopy.includes("This room has no instructions.") && firstCopy.includes("## Current workspace") && firstCopy.includes("No skills are enabled") && firstCopy.includes("The room has no files"), `the first copy is whole, got:\n${firstCopy}`);
		assert(firstCopy.includes("replaces every earlier room-state message"), "the copy says it replaces earlier room state");
		pass("the first turn sends one whole copy after the person's message, and the system prompt carries no live section");

		const second = only(await room.prompt("Hello two."), "Hello two.");
		assert(second.system === system, "a turn with nothing changed keeps the system prompt");
		assert(copiesIn(second).length === 1 && second.messages.at(-1)?.role === "user" && second.messages.at(-1)?.text === "Hello two.", "a turn with nothing changed sends no new copy");
		pass("a turn with nothing changed sends no copy and the same system prompt");

		const changes: Array<{ label: string; change: () => Promise<void>; carries: (copy: string) => boolean }> = [
			{ label: "a rename", change: () => rename(roomId, "Renamed Room"), carries: (copy) => copy.includes("Your name is now **Renamed Room**") },
			{ label: "an instruction edit", change: () => setInstructions(roomId, "Answer in French."), carries: (copy) => copy.includes("these are the instructions this room follows as they stand now") && copy.includes("Answer in French.") },
			{
				label: "a skill switch",
				change: async () => {
					const created = await requestJson("/api/skills", { method: "POST", body: JSON.stringify({ id: "cite-sources", displayName: "Cite sources", description: "Cite the source of every figure", instructions: "Name the file and page of every figure you quote." }) });
					assert(created.status === 201, `the skill should be created, got ${created.status}: ${JSON.stringify(created.body)}`);
					const enabled = await requestJson(`/api/persistent-agents/${roomId}/skill-settings`, { method: "PUT", body: JSON.stringify({ action: "enable", name: "cite-sources" }) });
					assert(enabled.status === 200, `the skill should be enabled, got ${enabled.status}: ${JSON.stringify(enabled.body)}`);
				},
				carries: (copy) => copy.includes("- cite-sources \u2014 Cite the source of every figure"),
			},
			{
				label: "a new file",
				change: async () => {
					// A PDF, which the upload parses at once: the Attachments panel then knows its pages.
					const added = await requestJson(`/api/persistent-agents/${roomId}/files`, { method: "POST", body: JSON.stringify({ filename: "terms.pdf", contentBase64: onePagePdf().toString("base64") }) });
					assert(added.status === 200 || added.status === 201, `the file should be added, got ${added.status}: ${JSON.stringify(added.body)}`);
					const panel = await requestJson(`/api/persistent-agents/${roomId}/files`);
					const listed = (panel.body?.files ?? []).find((file: any) => file.name === "terms.pdf");
					assert(listed?.pages === 1, `the Attachments panel still shows the PDF's pages, got ${JSON.stringify(panel.body)}`);
				},
				carries: (copy) => /- terms\.pdf · [\d.]+ (B|KB) · added by you/.test(copy) && !/\d+ pages?\b/.test(copy) && copy.includes("it is what the user sees in the Attachments panel") && !copy.includes("exactly what the user sees"),
			},
		];
		let copies = 1;
		for (const [at, { label, change, carries }] of changes.entries()) {
			await change();
			const text = `After ${label}.`;
			const sent = only(await room.prompt(text), text);
			assert(sent.system === system, `${label} must not change the system prompt`);
			const copy = newCopy(sent, label);
			assert(carries(copy), `the copy after ${label} should carry it, got:\n${copy}`);
			copies++;
			assert(copiesIn(sent).length === copies, `${label}: each change adds one copy and the earlier ones stay, got ${copiesIn(sent).length} copies, expected ${copies}`);
			if (at > 0) assert(copy.includes("Your name is now **Renamed Room**"), `${label}: a later copy is still whole and keeps the rename`);
		}
		pass("a rename, an instruction edit, a skill switch and a new file each send one copy carrying the change, under the same system prompt");

		await room.close();
		room = await RoomSocket.connect(roomId, conversationId);
		sockets.push(room);
		const afterReconnect = only(await room.prompt("Hello again."), "Hello again.");
		assert(afterReconnect.system === system, "a reconnect binds the same system prompt, byte for byte");
		assert(copiesIn(afterReconnect).length === copies && afterReconnect.messages.at(-1)?.text === "Hello again.", "a reconnect with nothing changed sends no new copy: the session's latest copy still holds");
		pass("a reconnect keeps the system prompt byte-identical and sends no copy for an unchanged room");

		// Windows keeps a folder readable whatever its mode, and root reads it anyway, so the unreadable case runs elsewhere only.
		const canForceFsRefusal = process.platform !== "win32" && process.getuid?.() !== 0;
		if (!canForceFsRefusal) {
			console.log("  skip a Attachments folder that cannot be read (Windows or root ignores the folder's mode)");
			return;
		}
		const { persistentRoomShelfDirPath } = await import("../src/persistent-room-shelf.js");
		const shelf = persistentRoomShelfDirPath(roomId);
		const mode = fs.statSync(shelf).mode & 0o777;
		// 000: the folder cannot be listed; 400: it can, but its files cannot be looked up.
		for (const refused of [0o000, 0o400]) {
			fs.chmodSync(shelf, refused);
			try {
				const text = `Attachments unreadable at ${refused.toString(8)}.`;
				const unreadable = only(await room.prompt(text), text);
				assert(copiesIn(unreadable).length === copies && unreadable.messages.at(-1)?.text === text, `a Attachments folder that cannot be read (mode ${refused.toString(8)}) is not an empty one: no new copy, got ${JSON.stringify(unreadable.messages.map((message) => `${message.role}: ${message.text.slice(0, 40)}`))}`);
			} finally {
				fs.chmodSync(shelf, mode);
			}
		}
		pass("a Attachments folder that cannot be listed, or whose files cannot be looked up, keeps the latest copy's list and sends no copy");
	});

	// --- 4. Remember skips the copies -----------------------------------------
	await scenario("Remember", async () => {
		for (const socket of sockets) await socket.close();
		// One more copy, saved the way a turn saves one, so the session holds a copy whatever the turns above did.
		const thread = (await requestJson(`/api/persistent-agents/${roomId}/threads/${conversationId}`)).body?.thread;
		const { buildPersistentAgentCheckpointTranscriptSource, openPersistentAgentPiSessionManager } = await import("../src/persistent-agents.js");
		openPersistentAgentPiSessionManager(roomId, thread.runtime, process.cwd()).appendCustomMessageEntry(ROOM_STATE_CUSTOM_TYPE, `${ROOM_STATE_HEADING}\nYour name is now **Saved Copy**.`, false, { parts: {} });
		const transcript = buildPersistentAgentCheckpointTranscriptSource({ agentId: roomId, conversationId, l1b: "" });
		const items: Array<{ kind: string; text?: string }> = (transcript as any).items;
		assert(items.some((item) => item.kind === "user" && item.text === "Hello one."), `Remember's transcript keeps the person's words, got ${JSON.stringify(items.map((item) => item.text?.slice(0, 30)))}`);
		assert(!items.some((item) => String(item.text ?? "").includes("# Room state") || String(item.text ?? "").includes("Your name is now")), "Remember's transcript quotes no room-state copy");
		pass("Remember's transcript of a conversation with copies quotes none of them");
	});

	// --- 3. Instructions A, then B, then A --------------------------------------
	await scenario("instructions A, then B, then A", async () => {
		const booted = await openRoom("Instructions Room", (id) => setInstructions(id, "Open every answer with Hi."));
		const instructed = await RoomSocket.connect(booted.roomId, booted.conversationId);
		sockets.push(instructed);
		const withA = newCopy(only(await instructed.prompt("First."), "First."), "instructions A at boot");
		assert(withA.includes("the original ones above") && !withA.includes("Open every answer with Hi."), `with the booted instructions, the copy points at them and does not repeat them, got:\n${withA}`);
		await setInstructions(booted.roomId, "Close every answer with Bye.");
		const withB = newCopy(only(await instructed.prompt("Second."), "Second."), "instructions B");
		assert(withB.includes("The user changed the instructions") && withB.includes("Close every answer with Bye."), `the copy after the edit carries B in full, got:\n${withB}`);
		await setInstructions(booted.roomId, "Open every answer with Hi.");
		const backToA = only(await instructed.prompt("Third."), "Third.");
		const withAAgain = newCopy(backToA, "back to A");
		assert(withAAgain.includes("the original ones above") && !withAAgain.includes("Close every answer with Bye."), `back to A, the copy names the original instructions and no longer carries B, got:\n${withAAgain}`);
		assert(copiesIn(backToA).length === 3, "A, B and A again: three copies, the latest in force");
		pass("instructions A, then B, then A end on a copy naming the original ones above");

		// A conversation whose record predates the booted fingerprint tells A only from the marker in its prompt,
		// which memory text could imitate: with the instructions cleared, the copy claims nothing about them.
		await setInstructions(booted.roomId, "Close every answer with Bye.");
		await setInstructions(booted.roomId, "");
		const { readPersistentRoomInstructionsNow } = await import("../src/persistent-room-instructions.js");
		const legacy = readPersistentRoomInstructionsNow(booted.roomId, backToA.system);
		assert(legacy.kind === "silent", `cleared instructions without the thread's record claim nothing, got ${legacy.kind}`);
		const latestB = { role: "custom", customType: ROOM_STATE_CUSTOM_TYPE, content: withB, details: { parts: { instructions: "\n\n## Current instructions\n\nClose every answer with Bye." } } };
		const cleared = roomStateMessageFor({ identity: "\n\n## Current identity\n\nYour name is now **Instructions Room**.", instructions: legacy, workspace: null }, [latestB]);
		assert(cleared && !cleared.content.includes("Close every answer with Bye.") && !cleared.content.includes("## Current instructions"), `the copy drops the latest copy's instructions instead of keeping them, got:\n${cleared?.content}`);
		pass("cleared instructions in a conversation without the booted record end the latest copy's instructions without claiming a removal");
	});

	// --- 5. A part that cannot be read, after a compaction removed its copy ------
	await scenario("an unreadable part after a compaction", async () => {
		const withB: RoomStateParts = { identity: "\n\n## Current identity\n\nYour name is now **Kept Room**.", instructions: { kind: "changed", section: "\n\n## Current instructions\n\nClose every answer with Bye." }, workspace: "\n\n## Current workspace\n\nNone." };
		const first = nextRoomStateMessage(withB, { buildSessionContext: () => ({ messages: [] }), getBranch: () => [] });
		assert(first, "the first turn sends a copy");
		// The compaction left the copy out of what the model is sent; the session still holds it.
		const held = [{ type: "custom_message", customType: first.customType, content: first.content, display: false, details: first.details }];
		const after = nextRoomStateMessage({ ...withB, instructions: { kind: "unreadable" } }, { buildSessionContext: () => ({ messages: [] }), getBranch: () => held });
		assert(after?.content.includes("Close every answer with Bye."), `the new copy keeps the instructions the session's latest copy sent, got:\n${after?.content}`);
		pass("an instructions part that cannot be read keeps the session's latest copy's, even one a compaction removed");
	});

	// --- 6. One file that cannot be looked up, beside readable ones -------------
	await scenario("one file whose lookup fails", async () => {
		const { buildShelfManifestSection, listShelfFilesWithOrigin, persistentRoomShelfDirPath } = await import("../src/persistent-room-shelf.js");
		const { createPersistentRoomShelfTools } = await import("../src/persistent-room-shelf-tools.js");
		const storage = { persistentAgentsRoot: path.join(tempHome, "lookup-rooms") };
		const shelf = persistentRoomShelfDirPath("lookup-room", storage);
		fs.mkdirSync(shelf, { recursive: true });
		fs.writeFileSync(path.join(shelf, "kept.md"), "a readable line\n");
		fs.writeFileSync(path.join(shelf, "broken.md"), "never looked up\n");
		// A disk error on one file, the way a failing sector shows it; the shelf's own code reads node:fs at call time.
		const lstatSync = fs.lstatSync;
		(fs as any).lstatSync = (target: fs.PathLike, ...rest: any[]) => {
			if (path.basename(String(target)) === "broken.md") throw Object.assign(new Error("EIO: i/o error, lstat"), { code: "EIO" });
			return (lstatSync as any)(target, ...rest);
		};
		try {
			const rows = listShelfFilesWithOrigin("lookup-room", storage).map((entry) => entry.name);
			assert(rows.length === 1 && rows[0] === "kept.md", `the Attachments panel keeps the readable file beside one it cannot look up, got ${JSON.stringify(rows)}`);
			const search = createPersistentRoomShelfTools({ roomId: "lookup-room", storage }).find((tool) => tool.name === "search_file")!;
			const found = await search.execute("search", { query: "readable line" }, undefined, undefined, undefined as any);
			const foundText = (found.content as Array<{ text?: string }>).map((part) => part.text ?? "").join("");
			assert(!(found as any).isError && foundText.includes("kept.md:1: a readable line"), `search_file still searches the readable file, got: ${foundText}`);
			assert(buildShelfManifestSection("lookup-room", storage) === null, "the model's Attachments list counts a read with one file missing as unreadable, so the room-state copy keeps its latest list");
		} finally {
			(fs as any).lstatSync = lstatSync;
		}
		pass("one file that cannot be looked up leaves its readable neighbours in the Attachments panel and search, and only the model's Attachments list counts the read as unreadable");
	});

	if (failures.length > 0) throw new Error(`${failures.length} case${failures.length === 1 ? "" : "s"} failed`);
	console.log(`room-state-message-smoke: ${passes} checks passed`);
} catch (caught) {
	error = caught;
	console.error(`room-state-message-smoke FAILED: ${(caught as Error).message}`);
	process.exitCode = 1;
} finally {
	for (const socket of sockets) await socket.close().catch(() => {});
	await stopRoomStateServer(error);
}
