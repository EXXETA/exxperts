// The tripwire's drive: everything the Windows design's tripwire lists that exists on main, as a
// person and the model reach it, against the planted test computer. Each step
// must work; a step that fails drove nothing, so it fails the run.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import JSZip from "jszip";

import { markedConnector } from "../smoke-marked-connector.js";
import { assert, type Client, waitUntil } from "./client.js";
import { standInFolderWindow } from "./folder-window.js";
import type { Run } from "./known-sites.js";
import { type Layout, PLANTED_CONNECTOR } from "./layout.js";
import type { Call, Gateway } from "./model.js";

export interface Rooms {
	live: string;
	child: string;
	background: string;
	scratch: string;
	asks: string;
}

export interface Driven {
	/** The folders the rooms were set on, for the trees. */
	roomFolders: string[];
	/** What a room set at, inside or above another tool's connector folder or a moved place got: accepted, or refused with its status. */
	placeRooms: string[];
	/** Values the sweep fills a route's parameters with. */
	params: Record<string, string>;
}

const call = (name: string, args: Record<string, unknown> = {}): Call => ({ name, args });

/** A loop that swaps a folder for a link to elsewhere and back as fast as it can, until stopped: a swap between a check and an open. */
function swapLoop(folder: string, elsewhere: string): () => Promise<void> {
	const kept = `${folder}.kept`;
	let running = true;
	const loop = (async () => {
		while (running) {
			try {
				fs.renameSync(folder, kept);
				fs.symlinkSync(elsewhere, folder);
				await new Promise((resolve) => setImmediate(resolve));
				fs.unlinkSync(folder);
				fs.renameSync(kept, folder);
			} catch {}
			await new Promise((resolve) => setImmediate(resolve));
		}
	})();
	return async () => {
		running = false;
		await loop;
		if (fs.lstatSync(folder, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(folder);
		if (fs.existsSync(kept)) fs.renameSync(kept, folder);
	};
}

export async function drive(run: Run, at: Layout, api: Client, gateway: Gateway, step: (name: string, body: () => Promise<void>) => Promise<void>): Promise<Driven> {
	const { must, send, request } = api;
	const rooms = {} as Rooms;
	const params: Record<string, string> = {};
	const placeRooms: string[] = [];
	const roomPath = (room: string, rest = "") => `/api/persistent-agents/${encodeURIComponent(room)}${rest}`;
	const makeRoom = async (name: string) => String((await must("POST", "/api/persistent-agents", { displayName: name, userName: "Synthetic User", preferredUserAddress: "Synthetic User" })).agent.id);
	const setFolder = (room: string, root: string, bashEnabled = true) => must("PUT", roomPath(room, "/workspace-default"), { root, displayLabel: path.basename(root), workspaceAccessMode: "localFiles", bashEnabled });
	// Given in the protection the room's chip would have read, which the server requires.
	const setAuto = async (room: string, autoApprove: boolean) => must("PUT", roomPath(room, "/bash-settings"), { autoApprove, protection: (await must("GET", roomPath(room, "/bash-settings"))).protection });

	await step("the rooms: a live and a background room with an Also allowed folder, and a nested child room", async () => {
		rooms.live = await makeRoom("Live Room");
		rooms.child = await makeRoom("Child Room");
		rooms.background = await makeRoom("Background Room");
		rooms.scratch = await makeRoom("Scratch Room");
		await setFolder(rooms.live, at.live);
		await setFolder(rooms.child, at.child);
		await setFolder(rooms.background, at.background);
		for (const room of [rooms.live, rooms.child]) await setAuto(room, true);
		// The Also allowed list is the room's own file, written as a person's yes to a box request writes it.
		for (const room of [rooms.live, rooms.background]) {
			const list = path.join(at.agentsRoot, room, "runtime", "also-allowed.json");
			fs.mkdirSync(path.dirname(list), { recursive: true });
			fs.writeFileSync(list, `${JSON.stringify({ folders: [{ path: at.alsoAllowed, access: "write" }], sites: [] })}\n`, { mode: 0o600 });
		}
	});

	await step("the Room settings: the folder's warnings, a conversation's own folder, and its removal", async () => {
		await must("GET", roomPath(rooms.live, "/workspace-default"));
		await must("POST", roomPath(rooms.scratch, "/workspace/validate"), { conversationId: "scratch-conversation", root: at.live, workspaceAccessMode: "localFiles" });
		await must("GET", roomPath(rooms.scratch, "/workspace-policy?conversationId=scratch-conversation"));
		await must("DELETE", roomPath(rooms.scratch, "/workspace-policy?conversationId=scratch-conversation"));
		await must("GET", roomPath(rooms.live, "/bash-settings"));
	});

	// The live conversation: the bind (and the loader's reload), each file tool, a command, a long output, then a rebind.
	let liveConversation = "";
	await step("the live room's bind, each file tool, a command, a command with long output, the Also allowed folder, and a command blocked in another room's folder", async () => {
		const window = await api.openWindow(rooms.live);
		liveConversation = window.conversation;
		const spillOf = (text: string | undefined) => /Full output: (\S+?)\]/.exec(text ?? "")?.[1] ?? "no-spill";
		const results = await window.turn([
			[call("read", { path: "notes.txt" })],
			[call("ls", {})],
			[call("find", { pattern: "*.txt" })],
			[call("grep", { pattern: "needle" })],
			[call("write", { path: "written.txt", content: "written live" })],
			[call("edit", { path: "written.txt", edits: [{ oldText: "written", newText: "edited" }] })],
			[call("read", { path: path.join(at.alsoAllowed, "also.txt") })],
			[call("bash", { command: `cat notes.txt ${JSON.stringify(path.join(at.alsoAllowed, "also.txt"))}` })],
			[call("bash", { command: "seq 1 5000" })],
			(earlier) => [call("read", { path: spillOf(earlier.at(-1)) })],
			// Another room's file: the box blocks it, and the block line raises a folder card.
			[call("bash", { command: `cat ${JSON.stringify(path.join(at.background, "notes.txt"))}` })],
		]);
		assert(results[0]?.includes("needle here"), `the read: ${results[0]}`);
		assert(results[6]?.includes("also allowed") && results[7]?.includes("also allowed"), `the read and the command in the Also allowed folder: ${JSON.stringify(results.slice(6, 8))}`);
		assert(fs.readFileSync(path.join(at.live, "written.txt"), "utf8").includes("edited"), `the write and the edit: ${results.slice(4, 6).join(" | ")}`);
		window.close();
	});

	await step("a rebind after a state change: the room's commands switched off and on between two turns", async () => {
		const window = await api.openWindow(rooms.live);
		await window.turn([[call("read", { path: "notes.txt" })]]);
		await setFolder(rooms.live, at.live, false);
		await window.turn([[call("ls", {})]]);
		await setFolder(rooms.live, at.live, true);
		await window.turn([[call("bash", { command: "ls" })]]);
		window.close();
	});

	await step("the tools beside the folder's: the room's attachments, its memory, web search and fetch, connectors and the way out", async () => {
		await must("POST", roomPath(rooms.live, "/files"), { filename: "brief.md", contentBase64: Buffer.from("# Brief\n\nneedle\n").toString("base64") });
		const window = await api.openWindow(rooms.live);
		await window.turn([
			[call("read_file", { name: "brief.md" })],
			[call("search_file", { query: "needle" })],
			[call("memory_recall", { query: "needle" })],
			[call("web_search", { query: "needle" })],
			[call("fetch_url", { url: "http://127.0.0.1:9/" })],
			[call("mcp", {})],
			...(run === "mac" ? [[call("run_outside_box", { command: "ls", reason: "list the folder" })]] : []),
		]);
		window.close();
	});

	await step("the nested child room's bind, a file tool's read and write, and a command", async () => {
		const window = await api.openWindow(rooms.child);
		if (run !== "mac") {
			// Windows mode has no protection, so on Auto this room asks nothing and its write never reads the git settings: on Ask first, where the write reads them.
			await setAuto(rooms.child, false);
			const asked = await window.turn([[call("write", { path: "asked.txt", content: "written on Ask" })]]);
			assert(fs.readFileSync(path.join(at.child, "asked.txt"), "utf8") === "written on Ask", `the write in the child room on Ask, beside its own git settings: ${asked[0]}`);
			await setAuto(rooms.child, true);
		}
		const results = await window.turn([[call("read", { path: "notes.txt" })], [call("write", { path: "written.txt", content: "written child" })], [call("bash", { command: "ls" })]]);
		assert(fs.readFileSync(path.join(at.child, "written.txt"), "utf8") === "written child", `the write in the child room, beside its own git settings: ${results[1]}`);
		window.close();
	});

	await step("the room's asks: commands turned on by a card, a folder chosen in the computer's window, the same card with access change for a folder it can only read, without protection the same room on Auto asking nothing, and each undone", async () => {
		const room = (rooms.asks = await makeRoom("Asks Room"));
		// A room made before its first folder came with commands on: commands off, and never switched off, so the room may ask for them.
		fs.rmSync(path.join(at.agentsRoot, room, "runtime", "commands-start-on.json"), { force: true });
		await setFolder(room, at.asks, false);
		// Windows mode here has no protection, and a room without it on Auto asks nothing: so there the cards are driven on Ask, and Auto after them.
		if (run === "mac") await setAuto(room, true);
		const list = path.join(at.agentsRoot, room, "runtime", "also-allowed.json");
		fs.writeFileSync(list, `${JSON.stringify({ folders: [{ path: at.readOnly, access: "read" }], sites: [] })}\n`, { mode: 0o600 });
		const folderWindow = standInFolderWindow(at.picked, at.readOnly);
		try {
			const window = await api.openWindow(room);
			const results = await window.turn([
				[call("bash", { command: "cat notes.txt" })],
				[call("ask_for_commands", { reason: "To read the notes with a command." })],
				[call("bash", { command: "cat notes.txt" })],
				[call("ask_for_folder", { access: "change", reason: "To keep the notes in another folder." })],
				[call("write", { path: path.join(at.picked, "picked.txt"), content: "picked" })],
				[call("write", { path: path.join(at.readOnly, "changed.txt"), content: "changed" })],
				[call("ask_for_folder", { access: "change", reason: "To change the notes in that folder." })],
				[call("write", { path: path.join(at.readOnly, "changed.txt"), content: "changed" })],
			]);
			assert(!results[0]?.includes("needle here") && results[2]?.includes("needle here"), `the command before and after the commands card: ${JSON.stringify(results.slice(0, 3))}`);
			assert(results[3]?.includes(at.picked), `the folder card's pick: ${results[3]}`);
			assert(fs.existsSync(path.join(at.picked, "picked.txt")) && results[5]?.includes("can only read") && folderWindow.opened() === 2 && fs.existsSync(path.join(at.readOnly, "changed.txt")), `the writes in the picked folder, and in the one it could only read before and after its card: ${JSON.stringify(results.slice(4))}`);
			if (run !== "mac") {
				// Protection off and Auto: the folder ask opens no card, a write in the folder the card gave the room lands, and a folder it can only read stays closed.
				// The card above let the room change the folder it could only read: the person sets it back to Can read first.
				const reading = await must("POST", roomPath(room, "/also-allowed/access"), { path: at.readOnly, access: "read" });
				assert((reading.list?.folders ?? []).some((entry: any) => entry.path === at.readOnly && entry.access === "read"), `Only allow reading on the folder the card let it change: ${JSON.stringify(reading.list)}`);
				await setAuto(room, true);
				const cards = () => window.frames.filter((frame) => frame.type === "ui_request" && frame.kind === "folder").length;
				const cardsBefore = cards();
				const unasked = await window.turn([
					[call("ask_for_folder", { access: "change", reason: "To keep more notes in another folder." })],
					[call("write", { path: path.join(at.picked, "unasked.txt"), content: "unasked" })],
					[call("write", { path: path.join(at.readOnly, "unasked.txt"), content: "unasked" })],
				]);
				assert(unasked[0]?.startsWith("Nothing needs the person's approval here") && cards() === cardsBefore && folderWindow.opened() === 2, `the folder ask with protection off on Auto: ${unasked[0]}`);
				assert(fs.readFileSync(path.join(at.picked, "unasked.txt"), "utf8") === "unasked" && unasked[2]?.endsWith("Tell the person.") && !fs.existsSync(path.join(at.readOnly, "unasked.txt")), `the writes with protection off on Auto: ${JSON.stringify(unasked.slice(1))}`);
			}
			const answered = (type: string, label: string) => waitUntil(() => window.frames.some((frame) => frame.type === type), label);
			window.send({ type: "room_folder_remove", path: at.picked });
			await answered("room_folder_removed", "Remove after the pick answered");
			window.send({ type: "room_folder_restore", path: at.picked });
			await answered("room_folder_restored", "Undo after Remove answered");
			window.send({ type: "room_commands_off" });
			await answered("room_commands_turned_off", "Turn off after the commands card answered");
			const done = window.frames.filter((frame) => frame.type.startsWith("room_folder_")).map((frame) => frame.done ?? frame.removed ?? frame.restored);
			assert(done.every((one) => one === true), `the ways back: ${JSON.stringify(done)}`);
			window.close();
		} finally {
			folderWindow.stop();
		}
	});

	await step("the Folder pane's Also allowed list: Add a folder… in the computer's window, Allow changes, Only allow reading, Remove and Undo", async () => {
		const list = roomPath(rooms.asks, "/also-allowed");
		const accessOf = (view: any) => (view.folders ?? []).find((entry: any) => entry.path === at.added)?.access ?? "not listed";
		assert(accessOf(await must("GET", list)) === "not listed", "the list before Add a folder…");
		const folderWindow = standInFolderWindow(at.added);
		try {
			const added = await request(`${list}/folders`, { method: "POST", headers: { "x-exxperts-local-action": "choose-folder" }, body: "{}" });
			assert(added.status === 200 && added.body?.state === "added" && accessOf(added.body.list) === "read" && folderWindow.opened() === 1, `Add a folder…: ${added.status} ${JSON.stringify(added.body)}`);
		} finally {
			folderWindow.stop();
		}
		const steps: Array<[string, unknown, string]> = [
			["/access", { path: at.added, access: "write" }, "write"],
			["/access", { path: at.added, access: "read" }, "read"],
			["/remove", { path: at.added }, "not listed"],
			["/restore", { path: at.added }, "read"],
		];
		for (const [rest, body, access] of steps) {
			const answer = await must("POST", `${list}${rest}`, body);
			assert(accessOf(answer.list) === access, `${rest} ${JSON.stringify(body)}: ${JSON.stringify(answer.list)}`);
		}
	});

	await step("the thread routes that read a room's settings: model options (the thinking default) and a model switch (compaction's reserve)", async () => {
		await must("GET", roomPath(rooms.live, `/threads/${liveConversation}/model-options`));
		await must("POST", roomPath(rooms.live, `/threads/${liveConversation}/switch-model`), { provider: "openai-compatible", model: "room-model" });
		await must("GET", roomPath(rooms.live, `/threads/${liveConversation}`));
	});

	await step("Save… to a folder inside a room, with a new name, Keep both and Replace", async () => {
		const headers = { "x-exxperts-local-action": "save-file" };
		const save = (body: unknown) => request(roomPath(rooms.live, "/files/brief.md/save"), { method: "POST", headers, body: JSON.stringify(body) });
		for (const body of [{ targetDir: at.saveTo, saveAs: "saved-brief.md" }, { targetDir: at.saveTo, saveAs: "saved-brief.md", rename: true }, { targetDir: at.saveTo, saveAs: "saved-brief.md", overwrite: true }]) {
			const answer = await save(body);
			assert(answer.status === 200, `Save… ${JSON.stringify(body)}: ${answer.status} ${JSON.stringify(answer.body)}`);
		}
		await must("GET", roomPath(rooms.live, "/files"));
		await must("GET", roomPath(rooms.live, "/files/brief.md"));
	});

	await step("export to the room's folder, with a new name, Keep both and Replace", async () => {
		const task = "tsk-tripwire";
		const store = path.join(at.appRoot, "artifacts", "tasks", task);
		fs.mkdirSync(store, { recursive: true });
		fs.writeFileSync(path.join(store, "exported.md"), "# Exported\n");
		const runtime = path.join(at.agentsRoot, rooms.live, "runtime");
		fs.mkdirSync(path.join(runtime, "task-ledger"), { recursive: true });
		fs.writeFileSync(path.join(runtime, "task-ledger", `${task}.json`), JSON.stringify({ schemaVersion: 1, taskId: task, roomId: rooms.live, conversationId: liveConversation, templateId: "deck", templateVersion: 1, title: "tripwire", startedAt: "2026-11-09T10:00:00.000Z", endedAt: "2026-11-09T10:05:00.000Z", outcome: "ok", artifacts: [{ relativePath: `tasks/${task}/exported.md`, bytes: 11, extension: ".md" }] }));
		if (!fs.existsSync(path.join(runtime, "shelf-migration.json"))) fs.writeFileSync(path.join(runtime, "shelf-migration.json"), JSON.stringify({ schemaVersion: 1, migratedAt: "2026-11-09T10:00:00.000Z", filesMoved: 0 }));
		for (const choice of [{}, { rename: true }, { overwrite: true }]) await must("POST", `/api/artifacts/${task}/export`, { roomId: rooms.live, relativePath: `tasks/${task}/exported.md`, ...choice });
		await must("GET", `/api/artifacts/${task}/exported.md`);
		params.taskId = task;
	});

	await step("the shelf's rename and delete, undone and done", async () => {
		const renamed = await must("POST", roomPath(rooms.live, "/files/brief.md/rename"), { newName: "brief-2.md" });
		const deleting = await must("POST", roomPath(rooms.live, `/files/${encodeURIComponent(renamed.name)}/delete`));
		await must("POST", roomPath(rooms.live, `/files/${encodeURIComponent(renamed.name)}/delete/undo`), { token: deleting.token });
		const again = await must("POST", roomPath(rooms.live, `/files/${encodeURIComponent(renamed.name)}/delete`));
		await must("POST", roomPath(rooms.live, `/files/${encodeURIComponent(renamed.name)}/delete/commit`), { token: again.token });
		params.name = renamed.name;
	});

	const repoGit = (...args: string[]) => {
		const done = spawnSync("git", ["-c", "user.name=Tripwire", "-c", "user.email=tripwire@example.invalid", ...args], { cwd: at.skillRepo, stdio: "ignore" });
		assert(done.status === 0, `git ${args.join(" ")} in the test repository: ${done.status}`);
	};
	await step("the Skills page, a room's bind and read_skill, with the shared store holding linked skills, while a loop swaps a skill's folder", async () => {
		const skill = (folder: string, name: string) => {
			fs.mkdirSync(folder, { recursive: true });
			fs.writeFileSync(path.join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: The ${name} test skill.\n---\nUse ${name}.\n`);
		};
		skill(path.join(at.skillStore, "plain-skill"), "plain-skill");
		skill(path.join(at.skillTargets, "linked-skill"), "linked-skill");
		fs.symlinkSync(path.join(at.skillTargets, "linked-skill"), path.join(at.skillStore, "linked-skill"));
		skill(path.join(at.skillTargets, "file-target"), "linked-file-skill");
		fs.mkdirSync(path.join(at.skillStore, "linked-file-skill"));
		fs.symlinkSync(path.join(at.skillTargets, "file-target", "SKILL.md"), path.join(at.skillStore, "linked-file-skill", "SKILL.md"));
		skill(path.join(at.skillTargets, "swapped-in"), "plain-skill");
		// The test repository: the featured list's one source (EXXPERTS_SKILLS_FEATURED_SOURCES) and the import's.
		fs.mkdirSync(path.join(at.skillRepo, "skills", "repo-skill"), { recursive: true });
		fs.writeFileSync(path.join(at.skillRepo, "skills", "repo-skill", "SKILL.md"), "---\nname: repo-skill\ndescription: A repository skill.\n---\nFrom a repository.\n");
		repoGit("init", "-q");
		repoGit("add", ".");
		repoGit("commit", "-qm", "skills");
		const stop = swapLoop(path.join(at.skillStore, "plain-skill"), path.join(at.skillTargets, "swapped-in"));
		try {
			await must("GET", "/api/skills");
			await must("GET", "/api/skills/featured");
			for (const name of ["plain-skill", "linked-skill", "linked-file-skill"]) {
				await send("GET", `/api/skills/${name}`);
				await send("PUT", roomPath(rooms.live, "/skill-settings"), { action: "enable", name });
			}
			await must("GET", roomPath(rooms.live, "/skill-settings"));
			const window = await api.openWindow(rooms.live);
			await window.turn([[call("read_skill", { name: "plain-skill" })], [call("read_skill", { name: "linked-skill" })], [call("read_skill", { name: "linked-file-skill" })], [call("bash", { command: "ls" })]]);
			window.close();
		} finally {
			await stop();
		}
	});

	await step("a skill made, changed and removed in the library, imported from an upload, a ZIP with a bundled file, and a test repository", async () => {
		await must("POST", "/api/skills", { id: "made-skill", displayName: "Made skill", description: "A made skill.", instructions: "Do it." });
		await must("PUT", "/api/skills/made-skill", { displayName: "Made skill", description: "A changed skill.", instructions: "Do it again." });
		await must("DELETE", "/api/skills/made-skill");
		const upload = await must("POST", "/api/skills/upload", { filename: "SKILL.md", contentBase64: Buffer.from("---\nname: uploaded-skill\ndescription: An uploaded skill.\n---\nUploaded.\n").toString("base64") });
		await must("POST", "/api/skills/accept", { id: "uploaded-skill", displayName: "Uploaded skill", description: upload.description, instructions: upload.body, token: upload.token });
		const zip = new JSZip();
		zip.file("zipped-skill/SKILL.md", "---\nname: zipped-skill\ndescription: A zipped skill.\n---\nZipped.\n");
		zip.file("zipped-skill/reference/notes.md", "# Bundled\n");
		const zipped = await must("POST", "/api/skills/upload", { filename: "zipped-skill.zip", contentBase64: (await zip.generateAsync({ type: "nodebuffer" })).toString("base64") });
		await must("POST", "/api/skills/accept", { id: "zipped-skill", displayName: "Zipped skill", description: zipped.description, instructions: zipped.body, token: zipped.token });
		assert(fs.existsSync(path.join(at.agentDir, "skills", "zipped-skill", "reference", "notes.md")), "the ZIP's bundled file was copied beside the accepted skill");
		const scanned = await must("POST", "/api/skills/repo/scan", { source: at.skillRepo });
		const found = scanned.skills?.[0]?.path ?? "skills/repo-skill";
		await must("POST", "/api/skills/repo/candidate", { token: scanned.token, path: found });
		await must("POST", "/api/skills/repo/import", { token: scanned.token, path: found });
	});

	await step("the imported skill checked for updates before and after its repository moved, and updated", async () => {
		const checked = async () => (await must("POST", "/api/skills/updates/check", { names: ["repo-skill"] })).results?.[0];
		const unmoved = await checked();
		assert(unmoved?.state === "current", `the check before the repository moved: ${JSON.stringify(unmoved)}`);
		const manifest = path.join(at.skillRepo, "skills", "repo-skill", "SKILL.md");
		fs.writeFileSync(manifest, fs.readFileSync(manifest, "utf8").replace("From a repository.", "From a repository, changed."));
		repoGit("commit", "-qam", "changed");
		const moved = await checked();
		assert(moved?.state === "available" && typeof moved.candidate?.id === "string", `the check after the repository moved: ${JSON.stringify(moved)}`);
		await must("POST", "/api/skills/repo-skill/update", { candidate: moved.candidate.id, installedFilesSha256: moved.installedFilesSha256 });
		assert(fs.readFileSync(path.join(at.agentDir, "skills", "repo-skill", "SKILL.md"), "utf8").includes("changed"), "the update swapped in the new version");
	});

	await step("the updated skill's Update automatically switched on and off, and the Skills page's notice closed", async () => {
		const listed = async () => ((await must("GET", "/api/skills")) as any[]).find((skill) => skill.name === "repo-skill");
		for (const on of [true, false]) {
			await must("PUT", "/api/skills/repo-skill/auto-update", { on });
			const shown = (await listed())?.repository?.autoUpdate;
			assert(shown === on, `the library shows the switch ${on ? "on" : "off"}, got ${JSON.stringify(shown)}`);
		}
		const updatedAt = (await listed())?.update?.updated?.at;
		assert(typeof updatedAt === "string", "the library names the update the notice would show");
		await must("POST", "/api/skills/updates/seen", { notices: [{ name: "repo-skill", updatedAt }] });
	});

	await step("every knowledge route on a vault inside a test room, while a loop swaps a note's folder", async () => {
		fs.mkdirSync(path.join(at.vault, "topic"), { recursive: true });
		fs.writeFileSync(path.join(at.vault, "topic", "note.md"), "# Note\n\nneedle\n");
		fs.writeFileSync(path.join(at.vault, "start.md"), "# Start\n");
		fs.mkdirSync(path.join(at.alsoAllowed, "topic-elsewhere"), { recursive: true });
		fs.writeFileSync(path.join(at.alsoAllowed, "topic-elsewhere", "note.md"), "# Elsewhere\n");
		const stop = swapLoop(path.join(at.vault, "topic"), path.join(at.alsoAllowed, "topic-elsewhere"));
		try {
			await must("POST", "/api/knowledge/connect-preflight", { path: at.vault });
			const connected = await must("POST", "/api/knowledge/connect", { path: at.vault, name: "tripwire-vault" });
			const base = String(connected.vault?.name ?? "tripwire-vault");
			const q = (rest: string) => `/api/knowledge/${rest}${rest.includes("?") ? "&" : "?"}base=${encodeURIComponent(base)}`;
			await must("GET", "/api/knowledge/bases");
			await must("GET", q("tree"));
			await send("GET", q("note?path=topic/note.md"));
			await must("GET", q("search?q=needle"));
			await must("POST", "/api/knowledge/file", { base, folder: ".", filename: "new-note.md", content: "# New\n" });
			await must("PUT", "/api/knowledge/file", { base, path: "new-note.md", content: "# Changed\n" });
			await must("DELETE", "/api/knowledge/file", { base, path: "new-note.md" });
			await must("POST", "/api/knowledge/index", { base });
			await must("POST", "/api/knowledge/index", { base, confirm: true });
			await must("POST", "/api/knowledge/disconnect", { name: base });
		} finally {
			await stop();
		}
	});

	const connector = markedConnector();
	const tool = "tripwire_tool";
	connector.tools = [{ name: tool }];
	await new Promise<void>((resolve) => connector.server.listen(0, "127.0.0.1", resolve));
	await step("the Connectors page, a connector edit, a room's grant and bind, a tool's choice, Reset choices and Remove, with every import kind's file in the home", async () => {
		// Each file names a connector of its own, so the room's list shows which imports were read.
		const nameOf = (file: string) => `imported-${path.relative(at.home, file).replace(/[^A-Za-z0-9]+/g, "-")}`;
		for (const file of at.connectorFiles) {
			const entry = { mcpServers: { [nameOf(file)]: { command: "/usr/bin/true", args: [] } } };
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, JSON.stringify(file.endsWith(path.join(".config", "mcp", "mcp.json")) ? { ...entry, imports: ["cursor", "claude-code", "claude-desktop", "codex", "windsurf", "vscode"] } : entry));
		}
		await must("GET", "/api/mcp/status");
		const listed = JSON.stringify(await must("GET", roomPath(rooms.live, "/mcp-connectors")));
		// The claude-code import reads the first of its files that exists, so `~/.claude.json` stays unread beside `~/.claude/mcp.json`.
		const missing = at.connectorFiles.filter((file) => file !== path.join(at.home, ".claude.json")).map(nameOf).filter((name) => !listed.includes(name));
		assert(missing.length === 0, `the room's connector list lacks ${missing.join(", ")}: ${listed}`);
		assert(!listed.includes(PLANTED_CONNECTOR), `the room's connector list holds the connector planted in its folder: ${listed}`);
		await must("POST", "/api/mcp/servers", { name: "tripwire-connector", url: connector.url() });
		await must("PUT", "/api/mcp/servers/tripwire-connector/address", { url: connector.url() });
		await send("POST", "/api/mcp/servers/tripwire-connector/test");
		await send("GET", "/api/mcp/servers/tripwire-connector/login");
		await send("POST", "/api/mcp/servers/tripwire-connector/login");
		await send("DELETE", "/api/mcp/servers/tripwire-connector/login");
		await send("POST", "/api/mcp/servers/tripwire-connector/logout");
		await must("PUT", roomPath(rooms.live, "/mcp-connectors"), { action: "grant", name: "tripwire-connector" });
		await must("GET", roomPath(rooms.live, "/mcp-connectors"));
		const window = await api.openWindow(rooms.live);
		await window.turn([[call("mcp", { server: "tripwire-connector" })]]);
		window.close();
		// A tool's choice writes the choices file; Reset choices sets aside one that can't be read.
		const choices = path.join(at.connectorDir, "mcp-tool-choices.json");
		await must("PUT", "/api/mcp/servers/tripwire-connector/tools", { tools: { [tool]: "blocked" } });
		assert(fs.readFileSync(choices, "utf8").includes(tool), `the choices file holds the tool's choice: ${choices}`);
		fs.writeFileSync(choices, "not the choices\n");
		await must("POST", "/api/mcp/tool-choices/reset", {});
		assert(!fs.existsSync(choices) && fs.readdirSync(at.connectorDir).some((name) => name.startsWith("mcp-tool-choices.json.unreadable-")), "Reset choices set the unreadable file aside");
		await must("DELETE", "/api/mcp/servers/tripwire-connector");
	});
	connector.server.close();

	await step("a room set at, inside and above another tool's connector folder and each place a setting moved", async () => {
		const places: Array<[string, string]> = [
			["at another tool's connector folder", path.join(at.home, ".cursor")],
			["inside another tool's connector folder", path.join(at.home, ".cursor", "inside")],
			["at another tool's connector folder", path.join(at.home, ".codex")],
			["above another tool's connector folder", at.home],
		];
		// Inside the rooms' data, a room's own data folder: a new folder there would read as another room.
		for (const place of at.moved) places.push(["at a moved place", place], ["inside a moved place", place === at.agentsRoot ? path.join(place, rooms.live) : path.join(place, "inside")]);
		if (at.moved.length > 0) places.push(["above the moved places", at.movedParent]);
		for (const [how, folder] of places) {
			fs.mkdirSync(folder, { recursive: true });
			const answer = await send("PUT", roomPath(rooms.scratch, "/workspace-default"), { root: folder, displayLabel: "Test place", workspaceAccessMode: "localFiles" });
			placeRooms.push(`${how}, ${path.relative(at.root, folder)}: ${answer.status === 200 ? "accepted" : `refused (${answer.status})`}`);
		}
		await send("DELETE", roomPath(rooms.scratch, "/workspace-default"));
	});

	await step("a background run in its room's folder and its Also allowed folder, from a schedule due now", async () => {
		gateway.script([[call("read", { path: "notes.txt" })], [call("ls", {})], [call("grep", { pattern: "needle" })], [call("read", { path: path.join(at.alsoAllowed, "also.txt") })]]);
		const made = await must("POST", roomPath(rooms.background, "/schedules"), { name: "Tripwire", schedule: "+1s", prompt: "Read the notes.", type: "once" });
		params.jobId = String(made.job?.id ?? made.id ?? made.schedule?.id ?? "");
		await waitUntil(async () => {
			const runs = await request(roomPath(rooms.background, "/background-runs"));
			return (runs.body?.runs ?? []).some((one: any) => ["succeeded", "completed", "failed", "error"].includes(String(one.status)));
		}, "the background run has ended", 60_000);
		const results = gateway.results();
		assert(results[0]?.includes("needle here") && results[3]?.includes("also allowed"), `the background reads in its folder and its Also allowed folder: ${JSON.stringify(results)}`);
		await must("GET", roomPath(rooms.background, "/schedules"));
		await must("GET", roomPath(rooms.background, "/status"));
	});

	await step("Remember, which reads the room's folder for its worker: an estimate and a proposal", async () => {
		// Remember reads the room's active conversation: the one opened last.
		const window = await api.openWindow(rooms.live);
		await window.turn([[call("read", { path: "notes.txt" })]]);
		window.close();
		const conversation = `conversationId=${encodeURIComponent(window.conversation)}`;
		await must("GET", roomPath(rooms.live, `/checkpoint/estimate?${conversation}`));
		await send("POST", roomPath(rooms.live, "/checkpoint/propose"), { conversationId: window.conversation });
		await must("GET", roomPath(rooms.live, `/checkpoint/progress?${conversation}`));
		await send("GET", roomPath(rooms.live, `/checkpoint/result?${conversation}`));
	});

	await step("a data folder move's plan, to a new folder inside a room", async () => {
		await send("POST", "/api/settings/state-home/plan", { dir: path.join(at.live, "data-here") });
	});

	await step("a room with a folder archived, restored, archived again and purged", async () => {
		const gone = await makeRoom("Gone Room");
		await setFolder(gone, at.background);
		const confirmation = `DELETE ${gone}`;
		await must("POST", roomPath(gone, "/archive"), { confirmation });
		await must("POST", roomPath(gone, "/restore"), {});
		await must("POST", roomPath(gone, "/archive"), { confirmation });
		await must("POST", roomPath(gone, "/purge"), { confirmation: `${confirmation} FOREVER` });
	});

	// The room routes run on a room with a folder, so a touch of it there is recorded.
	params.id = rooms.child;
	params.targetId = rooms.child;
	params.threadId = liveConversation;
	return { roomFolders: [at.live, at.child, at.background, at.asks, at.picked, at.readOnly, at.added, at.saveTo, at.vault], placeRooms, params };
}
