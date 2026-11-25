// What a connector's own page learns about its tools: the adapter's saved
// tool list keeps each tool's title and marks as the connector gave them,
// whoever writes it (a check, a room's connect, call and session end, a
// scheduled run's), and the status answer reads them by the rule the room's
// gate uses (marked read-only, strictly true, and not marked destructive): it
// sends each tool's description as the connector gave it, its title and the
// names it marks read-only, and nothing else rides with them. A saved list
// from before the marks were kept still loads as a cache hit, its tools all
// under "may change things", and one a check wrote with its own read-only mark
// reads as it did. On a shared server the answer sends no description, as one
// can repeat a key. The adapter patch that keeps them applies to the package's
// own text, once, and fails the install when the code around it changed. The
// connector is a real one on this computer, checked and used by the real
// adapter and the real room extension.
//
// Offline: no provider, no network beyond 127.0.0.1.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { markedConnector } from "./smoke-marked-connector.js";

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "connector-tool-facts-"));
process.env.HOME = agentDir;
process.env.USERPROFILE = agentDir;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = path.join(agentDir, "rooms");
delete process.env.MCP_DIRECT_TOOLS;

const { addMcpServer, testMcpServer, logoutMcpServer, removeMcpServer } = await import("../src/mcp-admin.js");
const { getMcpConnectorsStatus } = await import("../src/mcp-status.js");
const { registerServerHooks } = await import("../src/server-hooks.js");
const { writePersistentRoomMcpSettings } = await import("../src/persistent-room-mcp-settings.js");
const { createRoomScopedMcpExtension } = await import("../../../pi-package/extensions/mcp/index.js");
const cacheMod = await import("pi-mcp-adapter/metadata-cache.ts" as string);
const { prepareRoomScopedMcpSessionCache, buildRoomScopedProxyDescription } = await import("../../../pi-package/extensions/mcp/room-scope.js");
const { closeConnectorEverywhere } = await import("../src/connector-close-all.js");

/** A room's page, as the extension uses it: it shows nothing here and answers no question. */
const ROOM_PAGE = { notify() {}, setStatus() {}, select: async () => undefined, confirm: async () => false, input: async () => undefined, theme: { fg: (_color: string, text: string) => text } };

/**
 * A session of a room, or of a scheduled run, through the real extension: it connects, calls a tool and ends; `during`
 * runs before it ends. `page`: a room's session with its page, which declares what a room's connection declares.
 */
async function sessionUsing(extension: (pi: unknown) => unknown, server: string, tool: string, during?: (mcp: any, ctx: unknown) => Promise<void>, page?: typeof ROOM_PAGE): Promise<string> {
	const tools = new Map<string, any>();
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const pi = {
		registerTool(one: any) { tools.set(String(one.name), one); },
		registerCommand() {},
		registerFlag() {},
		getFlag() { return undefined; },
		getAllTools() { return [...tools.values()]; },
		sendMessage() {},
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
	};
	const ctx = { cwd: agentDir, hasUI: page !== undefined, ui: page, modelRegistry: undefined, model: undefined, signal: undefined, reload: async () => {} };
	await extension(pi);
	for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
	try {
		await tools.get("mcp").execute("facts-connect", { connect: server }, undefined, undefined, ctx);
		const called = await tools.get("mcp").execute("facts-call", { tool, server }, undefined, undefined, ctx);
		await during?.(tools.get("mcp"), ctx);
		return String(called?.content?.[0]?.text ?? "");
	} finally {
		for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
	}
}

const KEY = "synthetic-wiki-key";
const connector = markedConnector();
connector.tools = [
	{ name: "search_pages", description: "Search pages by the words in their title or text.", annotations: { readOnlyHint: true } } as never,
	{ name: "get_page", description: "Read one page.", annotations: { readOnlyHint: true, destructiveHint: false } } as never,
	{ name: "create_page", description: "Create a page in a space." } as never,
	// Read-only and destructive at once: the gate asks, so it is not read-only here either.
	{ name: "wipe_space", description: "Empty a space.", annotations: { readOnlyHint: true, destructiveHint: true } } as never,
	// Not destructive, but not marked read-only either. (A mark that isn't true or false never gets here: the protocol's client refuses the whole list.)
	{ name: "odd_mark", annotations: { destructiveHint: false } } as never,
	{ name: "update_page", title: "Update page", description: "Change a page.", annotations: { readOnlyHint: false } } as never,
];
await new Promise<void>((resolve) => connector.server.listen(0, "127.0.0.1", resolve));

const statusOf = async (name: string) => {
	const server = (await getMcpConnectorsStatus()).servers.find((row) => row.name === name);
	assert.ok(server, `${name} is in the status answer`);
	return server;
};

try {
	// A key in a header of its own: it must never ride along with the tools' facts.
	await addMcpServer({ name: "Team wiki", url: connector.url(), headers: { "X-Api-Key": KEY } });
	assert.equal((await statusOf("team-wiki")).tools, null, "never checked: no tools");

	const checked = await testMcpServer("team-wiki");
	assert.equal(checked.ok, true, `the check reaches the connector: ${JSON.stringify(checked)}`);

	// The cache: each tool's marks and title as the connector gave them, and no mark of the app's own.
	const savedTools = () => JSON.parse(fs.readFileSync(cacheMod.getMetadataCachePath(), "utf-8")).servers["team-wiki"].tools as Array<Record<string, unknown>>;
	const cached = savedTools();
	assert.deepEqual(Object.fromEntries(cached.map((tool) => [tool.name, tool.annotations ?? null])), Object.fromEntries(connector.tools.map((tool) => [tool.name, tool.annotations ?? null])), `the cache keeps each tool's marks as given, got ${JSON.stringify(cached)}`);
	assert.ok(cached.every((tool) => !("readOnly" in tool)), "the app adds no mark of its own");
	assert.equal(cached.find((tool) => tool.name === "update_page")?.title, "Update page", "the title stays beside it");

	// The status answer: the description as given, the titles, the read-only names, nothing else.
	const tools = (await statusOf("team-wiki")).tools!;
	assert.deepEqual(tools.titles, { update_page: "Update page" }, "the tool's own title");
	assert.deepEqual(Object.keys(tools).sort(), ["cachedAt", "count", "descriptions", "documents", "excluded", "names", "readOnly", "resources", "titles"], `the tools' answer carries only its fields, got ${Object.keys(tools)}`);
	assert.deepEqual(tools.descriptions, {
		search_pages: "Search pages by the words in their title or text.",
		get_page: "Read one page.",
		create_page: "Create a page in a space.",
		wipe_space: "Empty a space.",
		update_page: "Change a page.",
		get_notes: "Read resource: smoke://notes",
	}, "each description is sent as the connector gave it, and one with none sends none");
	assert.deepEqual(tools.resources, ["get_notes"], "the resource the connector lists is named apart from its tools");
	assert.deepEqual([...tools.readOnly].sort(), ["get_page", "search_pages"], "the read-only names are the cache's");
	const sent = JSON.stringify(tools);
	assert.ok(!sent.includes(KEY) && !sent.includes(Buffer.from(KEY).toString("base64")) && !sent.includes("X-Api-Key") && !sent.includes(connector.url()), "no key, header or address rides with the tools");

	// A room's use, then a scheduled run's: each connects, calls a read-only tool and ends,
	// and each of those rewrites the connector's whole saved entry. The page still groups and titles its tools.
	const savedAt = () => JSON.parse(fs.readFileSync(cacheMod.getMetadataCachePath(), "utf-8")).servers["team-wiki"].cachedAt as number;
	const checkedAt = savedAt();
	const room = "facts-room";
	writePersistentRoomMcpSettings(room, ["team-wiki"]);
	const roomRan = await sessionUsing(createRoomScopedMcpExtension(room, { onBoundGrants: () => {} }), "team-wiki", "team_wiki_search_pages");
	const scheduledRan = await sessionUsing(createRoomScopedMcpExtension(room), "team-wiki", "team_wiki_get_page");
	assert.deepEqual(connector.called, ["search_pages", "get_page"], `the room's call and the scheduled run's reached the connector (room said ${JSON.stringify(roomRan.slice(0, 120))}, run said ${JSON.stringify(scheduledRan.slice(0, 120))})`);
	assert.ok(savedAt() > checkedAt, "the room's and the run's sessions wrote the entry again");
	const afterUse = (await statusOf("team-wiki")).tools!;
	assert.deepEqual([...afterUse.readOnly].sort(), ["get_page", "search_pages"], `after a room and a scheduled run used it, the read-only tools are still read-only, got ${JSON.stringify(afterUse.readOnly)}`);
	assert.deepEqual(afterUse.titles, { update_page: "Update page" }, "and the tool keeps its own title");

	// A saved list in the shape it had before the marks were kept (a room's or the adapter's, the
	// shape the hosted smokes write): still a cache hit, read as no marks, its tools all under "may change things".
	const config = JSON.parse(fs.readFileSync(path.join(agentDir, "mcp.json"), "utf-8"));
	const entry = config.mcpServers["team-wiki"];
	const oldEntry = { configHash: cacheMod.computeServerHash(entry), cachedAt: Date.now(), resources: [], tools: [{ name: "search_pages", description: "Search pages." }, { name: "create_page" }] };
	fs.writeFileSync(cacheMod.getMetadataCachePath(), JSON.stringify({ version: 1, servers: { "team-wiki": oldEntry } }));
	assert.equal(cacheMod.isServerCacheValid(cacheMod.loadMetadataCache().servers["team-wiki"], entry), true, "an old entry is still a cache hit");
	assert.deepEqual(cacheMod.reconstructToolMetadata("team-wiki", oldEntry, "server", entry).map((tool: { originalName: string }) => tool.originalName), ["search_pages", "create_page"], "and the adapter rebuilds its tools from it");
	const old = (await statusOf("team-wiki")).tools!;
	assert.deepEqual(old.names, ["search_pages", "create_page"], "an old cache still lists its tools");
	assert.deepEqual(old.readOnly, [], "an old cache marks none read-only");
	assert.deepEqual(old.titles, {}, "and gives no titles");
	assert.deepEqual(old.descriptions, { search_pages: "Search pages." }, "an old cache still sends its descriptions");

	// One a check wrote before the marks were kept, with its own read-only mark and title, read as it was; saved marks
	// by the gate's rule, so a mark in words or one beside destructive is not read-only; a title in the marks counts.
	fs.writeFileSync(cacheMod.getMetadataCachePath(), JSON.stringify({
		version: 1,
		servers: {
			"team-wiki": {
				...oldEntry,
				tools: [
					{ name: "search_pages", readOnly: true },
					{ name: "update_page", title: "Update page" },
					{ name: "create_page" },
					{ name: "saved_read", annotations: { readOnlyHint: true, title: "Saved read" } },
					{ name: "text_mark", annotations: { readOnlyHint: "true" } },
					{ name: "both_marks", annotations: { readOnlyHint: true, destructiveHint: true } },
				],
			},
		},
	}));
	const checkedBefore = (await statusOf("team-wiki")).tools!;
	assert.deepEqual(checkedBefore.readOnly, ["search_pages", "saved_read"], "a check's own read-only mark still reads, and saved marks read by the gate's rule");
	assert.deepEqual(checkedBefore.titles, { update_page: "Update page", saved_read: "Saved read" }, "and the titles");

	// A check again keeps the marks once more.
	await testMcpServer("team-wiki");
	assert.deepEqual([...(await statusOf("team-wiki")).tools!.readOnly].sort(), ["get_page", "search_pages"], "a new check marks them again");

	// A program never checked shows no tools: opening its page starts nothing.
	await addMcpServer({ name: "Office files", commandLine: "never-started-program --stdio" });
	assert.equal((await statusOf("office-files")).tools, null, "a program never checked has no tools");

	// The adapter patch, on scratch copies of the installed adapter: it gives the installed file from the
	// package's own text, passes once applied, and fails the install, the file unchanged, when serializeTools changed.
	const installed = path.dirname(createRequire(import.meta.url).resolve("pi-mcp-adapter/package.json"));
	const patchScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "patch-mcp-adapter.mjs");
	const patchedCache = fs.readFileSync(path.join(installed, "metadata-cache.ts"), "utf8");
	// Patch 16's line pair, as the package has it and as the patch leaves it, written here by hand.
	const PRISTINE = "      uiStreamMode: extractToolUiStreamMode(t._meta),\n    }));\n}\n";
	const PATCHED = "      uiStreamMode: extractToolUiStreamMode(t._meta),\n      title: t.title,\n      annotations: (t as { annotations?: unknown }).annotations,\n    }));\n}\n";
	assert.equal(patchedCache.split(PATCHED).length, 2, "the installed adapter holds patch 16 as this smoke knows it");
	const pristineCache = patchedCache.replace(PATCHED, PRISTINE);
	let scratches = 0;
	const scratch = (cacheText: string): string => {
		const adapter = path.join(agentDir, `patch-${(scratches += 1)}`, "node_modules", "pi-mcp-adapter");
		fs.cpSync(installed, adapter, { recursive: true });
		// Patch 11 looks for the AI library copy beside the adapter.
		const aiCopy = path.join(installed, "..", "@earendil-works", "pi-ai");
		if (fs.existsSync(aiCopy)) fs.cpSync(aiCopy, path.join(adapter, "..", "@earendil-works", "pi-ai"), { recursive: true });
		fs.writeFileSync(path.join(adapter, "metadata-cache.ts"), cacheText);
		return adapter;
	};
	const runPatch = (adapter: string) => {
		const result = spawnSync(process.execPath, [patchScript, "--adapter-dir", adapter], { cwd: agentDir, encoding: "utf8", env: { PATH: process.env.PATH, HOME: agentDir } });
		return { status: result.status, errors: `${result.stdout}${result.stderr}`.split("\n").filter((line) => line.includes("ERROR")), out: result.stdout };
	};
	const cacheTextOf = (adapter: string) => fs.readFileSync(path.join(adapter, "metadata-cache.ts"), "utf8");
	const fresh = scratch(pristineCache);
	const freshRun = runPatch(fresh);
	assert.ok(freshRun.status === 0 && freshRun.errors.length === 0 && cacheTextOf(fresh) === patchedCache, `patch 16 applies to the package's own text, giving the installed file (status ${freshRun.status}, ${freshRun.errors.join(" | ")})`);
	const againRun = runPatch(fresh);
	assert.ok(againRun.status === 0 && againRun.out.includes("patch 16 (a saved tool's title and marks) already patched") && cacheTextOf(fresh) === patchedCache, `run again, it passes and changes nothing (status ${againRun.status})`);
	const changed = scratch(pristineCache.replace("      uiStreamMode: extractToolUiStreamMode(t._meta),\n", "      uiStreamMode: extractToolUiStreamMode(t._meta) ?? \"eager\",\n"));
	const changedBefore = cacheTextOf(changed);
	const changedRun = runPatch(changed);
	assert.ok(changedRun.status === 1 && changedRun.errors.length === 1 && changedRun.errors[0].includes("patch 16") && cacheTextOf(changed) === changedBefore, `an adapter whose serializeTools changed fails the install on patch 16, one error line, the file unchanged (status ${changedRun.status}, ${changedRun.errors.join(" | ")})`);

	// --- A connector's own instructions, what a room's connection declares, and a changed list (stand-in program).
	{
		const standIn = path.join(path.dirname(fileURLToPath(import.meta.url)), "connector-call-stand-in.mjs");
		const standInLog = path.join(agentDir, "stand-in.log");
		const logged = (name: string, event: string) => (fs.existsSync(standInLog) ? fs.readFileSync(standInLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []).filter((entry) => entry.name === name && entry.event === event);
		const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
		const until = async (done: () => boolean, what: string, ms = 10_000) => {
			const end = Date.now() + ms;
			while (!done()) {
				assert.ok(Date.now() < end, what);
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
		};
		const LONG = `Use toy space with care. ${"x".repeat(5_000)}`;
		const entryFor = (name: string, env: Record<string, string> = {}) => ({ command: process.execPath, args: [standIn], env: { STAND_IN_LOG: standInLog, STAND_IN_NAME: name, ...env } });
		const config = JSON.parse(fs.readFileSync(path.join(agentDir, "mcp.json"), "utf-8"));
		config.mcpServers.toy = entryFor("toy", { STAND_IN_INSTRUCTIONS: LONG });
		config.mcpServers.hidden = entryFor("hidden", { STAND_IN_INSTRUCTIONS: "Hidden connector's own words." });
		config.mcpServers.slow = entryFor("slow", { STAND_IN_START_MS: "30000" });
		config.mcpServers.older = entryFor("older", { STAND_IN_INSTRUCTIONS: "Older connector's own words." });
		config.mcpServers.pair = entryFor("pair", { STAND_IN_RELIST_MS: "1500" });
		config.mcpServers.twice = entryFor("twice", { STAND_IN_INSTRUCTIONS: "Twice connector's own words.", STAND_IN_START_MS: "1500" });
		config.mcpServers.slowlist = entryFor("slowlist", { STAND_IN_FIRST_LIST_MS: "30000" });
		config.mcpServers.stall = entryFor("stall", { STAND_IN_FIRST_LIST_MS: "120000" });
		config.mcpServers.gone = entryFor("gone");
		config.mcpServers.mate = entryFor("mate", { STAND_IN_START_MS: "3000" });
		fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify(config, null, 2));
		const saved = () => JSON.parse(fs.readFileSync(cacheMod.getMetadataCachePath(), "utf-8")).servers as Record<string, any>;
		const toyRoom = "instructions-room";
		writePersistentRoomMcpSettings(toyRoom, ["toy"]);

		// A fresh home, nobody pressed Check connection: the room's warm-up is the first to reach the connector.
		fs.rmSync(cacheMod.getMetadataCachePath(), { force: true });
		await prepareRoomScopedMcpSessionCache(toyRoom);
		const warmed = saved().toy;
		assert.ok(warmed?.instructions === LONG.slice(0, 4096), `the warm-up saves the connector's instructions cut at 4,096 characters, got ${String(warmed?.instructions).length} characters`);
		const warmedTools = (warmed?.tools ?? []).map((tool: { name: string }) => tool.name).sort();
		assert.ok(warmedTools.includes("form_only"), `the warm-up declares forms as a room does, so it saves the tool offered only then, got ${warmedTools}`);
		const warmUpHello = logged("toy", "initialize").at(-1);
		assert.ok(warmUpHello?.forms === true && warmUpHello?.sampling === false, `the warm-up declares forms and offers no model, got ${JSON.stringify(warmUpHello)}`);
		assert.equal(saved().hidden, undefined, "a connector the room hasn't on is not reached");
		const described = await buildRoomScopedProxyDescription(toyRoom);
		assert.ok(described.includes(LONG.slice(0, 4096)) && !described.includes(LONG.slice(0, 4097)), "the room's description carries the instructions, cut");
		assert.ok(!described.includes("Hidden connector's own words."), "and never those of a connector the room hasn't on");
		// A live room connection lists what the warm-up saved: its session end writes the entry again.
		writePersistentRoomMcpSettings(toyRoom, ["toy", "hidden"]);
		const liveRan = await sessionUsing(createRoomScopedMcpExtension(toyRoom, { onBoundGrants: () => {} }), "toy", "toy_work", undefined, ROOM_PAGE);
		assert.deepEqual(saved().toy.tools.map((tool: { name: string }) => tool.name).sort(), warmedTools, `a live room connection lists what the warm-up saved (it said ${JSON.stringify(liveRan.slice(0, 120))})`);
		assert.ok(saved().toy.instructions === LONG.slice(0, 4096), `a room's session keeps the instructions in the entry it writes, got ${String(saved().toy.instructions).length} characters`);
		const bothDescribed = await buildRoomScopedProxyDescription(toyRoom);
		assert.ok(bothDescribed.includes("Hidden connector's own words."), "once on in the room, its instructions are there too");

		// An entry saved before the instructions were kept: the first warm-up of a run reaches the connector once for them.
		const { instructions: _kept, ...fromBefore } = saved().toy;
		const olderEntry = { ...fromBefore, configHash: cacheMod.computeServerHash(config.mcpServers.older) };
		cacheMod.saveMetadataCache({ version: 1, servers: { older: olderEntry } });
		writePersistentRoomMcpSettings("older-room", ["older"]);
		await prepareRoomScopedMcpSessionCache("older-room");
		assert.equal(saved().older.instructions, "Older connector's own words.", "an entry from before gains the instructions at the next warm-up");
		assert.equal(logged("older", "initialize").length, 1, "reaching the connector once");
		cacheMod.saveMetadataCache({ version: 1, servers: { older: olderEntry } });
		await prepareRoomScopedMcpSessionCache("older-room");
		assert.equal(logged("older", "initialize").length, 1, "and only once while the server runs, whatever comes of it");

		// A second conversation starts while the first one's warm-up is still reaching the connector: it waits for it, and its first request has the instructions.
		writePersistentRoomMcpSettings("twice-a", ["twice"]);
		writePersistentRoomMcpSettings("twice-b", ["twice"]);
		const firstWarmUp = prepareRoomScopedMcpSessionCache("twice-a");
		await until(() => logged("twice", "start").length === 1, "the first warm-up started the connector");
		await prepareRoomScopedMcpSessionCache("twice-b");
		assert.ok((await buildRoomScopedProxyDescription("twice-b")).includes("Twice connector's own words."), "the second conversation's description carries the instructions");
		await firstWarmUp;
		assert.equal(logged("twice", "start").length, 1, "the connector was started once for both");

		// Reached this run, then its entry has run out or gone (as an address change drops it): a later conversation's warm-up reaches it again.
		const aged = saved().twice;
		cacheMod.saveMetadataCache({ version: 1, servers: { ...saved(), twice: { ...aged, cachedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 } } });
		await prepareRoomScopedMcpSessionCache("twice-b");
		assert.equal(logged("twice", "start").length, 2, "an entry that ran out is reached again");
		assert.ok((await buildRoomScopedProxyDescription("twice-b")).includes("Twice connector's own words."), "and the description carries the instructions again");
		const { twice: _dropped, ...withoutTwice } = saved();
		fs.writeFileSync(cacheMod.getMetadataCachePath(), JSON.stringify({ version: 1, servers: withoutTwice }));
		await prepareRoomScopedMcpSessionCache("twice-b");
		assert.equal(logged("twice", "start").length, 3, "an entry that was dropped is reached again");
		assert.ok((await buildRoomScopedProxyDescription("twice-b")).includes("Twice connector's own words."), "and the description carries the instructions");

		// The connector adds a tool and says so: the session lists again, and the saved list holds it with its title and marks.
		const countBefore = (await statusOf("toy")).tools!.count;
		const addRan = await sessionUsing(createRoomScopedMcpExtension(toyRoom, { onBoundGrants: () => {} }), "toy", "toy_add_tool", async (mcp, ctx) => {
			await until(() => saved().toy.tools.some((tool: { name: string }) => tool.name === "added"), "the saved list holds the added tool");
			const found = await mcp.execute("facts-added", { tool: "toy_added", server: "toy" }, undefined, undefined, ctx);
			assert.notEqual(found?.details?.error, "tool_not_found", `the added tool is found, got ${JSON.stringify(found?.details)}`);
		}, ROOM_PAGE);
		assert.ok(addRan.includes("A tool was added"), `the call that added it answered, got ${addRan}`);
		const addedTool = saved().toy.tools.find((tool: { name: string }) => tool.name === "added");
		assert.equal(addedTool?.title, "Added Tool", "the added tool keeps its title");
		assert.equal((await statusOf("toy")).tools!.count, countBefore + 1, "the row counts it");

		// Two notices 700 ms apart, the first listing answering late: the newer list stays, not the late answer.
		writePersistentRoomMcpSettings("pair-room", ["pair"]);
		const pairTools = () => (saved().pair?.tools ?? []).map((tool: { name: string }) => tool.name);
		await sessionUsing(createRoomScopedMcpExtension("pair-room", { onBoundGrants: () => {} }), "pair", "pair_add_two", async () => {
			await until(() => pairTools().includes("second"), "the saved list holds the second tool", 10_000);
			await new Promise((resolve) => setTimeout(resolve, 2_500));
			assert.ok(pairTools().includes("added") && pairTools().includes("second"), `a late answer to an older listing leaves the newer list, got ${pairTools()}`);
		}, ROOM_PAGE);

		// Signed out while a conversation has it connected: that conversation's end doesn't write the entry back.
		const pairStarts = logged("pair", "start").length;
		await sessionUsing(createRoomScopedMcpExtension("pair-room", { onBoundGrants: () => {} }), "pair", "pair_work", async () => {
			assert.ok(saved().pair, "the open conversation's connection saved the entry");
			await logoutMcpServer("pair");
			assert.equal(saved().pair, undefined, "signing out drops the entry");
		}, ROOM_PAGE);
		assert.equal(saved().pair, undefined, `the conversation's end leaves it dropped, got ${JSON.stringify(saved().pair?.tools?.length)} tools`);
		const pairPid = logged("pair", "start").at(-1)!.pid as number;
		assert.ok(logged("pair", "start").length === pairStarts + 1 && !alive(pairPid), "and its program has ended");

		// A warm-up attempt that runs past 8 s is ended: the slow program exits with it and never starts answering.
		writePersistentRoomMcpSettings("slow-room", ["slow"]);
		fs.rmSync(cacheMod.getMetadataCachePath(), { force: true });
		const warmUpAt = Date.now();
		await prepareRoomScopedMcpSessionCache("slow-room");
		const tookMs = Date.now() - warmUpAt;
		const slowPids = logged("slow", "start").map((entry) => entry.pid as number);
		assert.ok(slowPids.length === 1 && tookMs < 14_500, `the slow program started once and the warm-up ended within its limits, took ${tookMs} ms`);
		await until(() => !alive(slowPids[0]!), "the slow program has exited once the warm-up is done", 5_000);
		assert.equal(logged("slow", "ready").length, 0, "and it never got to answer");

		// A program that answers its handshake and then never its first tool list: the warm-up's limit ends it too, and nothing is saved for it.
		writePersistentRoomMcpSettings("stall-room", ["stall"]);
		const stallAt = Date.now();
		const stallWarmUp = prepareRoomScopedMcpSessionCache("stall-room");
		await until(() => logged("stall", "list").length === 1, "the warm-up asked for the stalled program's tools");
		const stallPid = logged("stall", "start")[0]!.pid as number;
		await until(() => !alive(stallPid), "the program stalled on its first tool list has exited within the warm-up's limit", Math.max(0, stallAt + 9_500 - Date.now()));
		console.log(`  the program stalled on its first tool list exited ${Date.now() - stallAt} ms after the warm-up started`);
		await stallWarmUp;
		assert.equal(saved().stall, undefined, "and nothing is saved for it");

		// Removed while its room's warm-up is under way, its list already in hand and the room's other connector still starting:
		// no program of it runs afterwards, and the saved list its removal dropped doesn't come back.
		writePersistentRoomMcpSettings("gone-room", ["gone", "mate"]);
		const goneWarmUp = prepareRoomScopedMcpSessionCache("gone-room");
		const managers = () => [...((globalThis as { exxpertsConnectorManagers?: Set<{ getConnection(name: string): { status?: string } | undefined }> }).exxpertsConnectorManagers ?? [])];
		await until(() => managers().some((manager) => manager.getConnection("gone")?.status === "connected"), "the warm-up has the connector's list in hand");
		assert.equal(logged("mate", "ready").length, 0, "while the room's other connector is still starting");
		await removeMcpServer("gone");
		await goneWarmUp;
		const gonePid = logged("gone", "start")[0]!.pid as number;
		await until(() => !alive(gonePid), "the removed connector's program has exited", 3_000);
		assert.equal(logged("gone", "start").length, 1, "and nothing started it again");
		assert.equal(saved().gone, undefined, "no saved list of the removed connector came back");
		assert.ok(saved().mate, "and the room's other connector's list is saved");

		// Removed while Check connection waits for it to start: its program exits at once, not when its start runs out.
		const checking = testMcpServer("slow");
		await until(() => logged("slow", "start").length === 2, "the check started the slow program");
		const checkPid = logged("slow", "start")[1]!.pid as number;
		const removedAt = Date.now();
		await closeConnectorEverywhere("slow");
		await until(() => !alive(checkPid), "the slow program has exited soon after its removal", 3_000);
		console.log(`  the starting program exited ${Date.now() - removedAt} ms after its removal`);
		assert.equal((await checking).ok, false, "the check reads as not connected");
		assert.equal(logged("slow", "ready").length, 0, "and the program never got to answer");

		// Removed while Check connection waits for its first tool list, after the handshake: its program exits at once too.
		const listing = testMcpServer("slowlist");
		await until(() => logged("slowlist", "list").length === 1, "the check asked for the slow program's tools");
		const listPid = logged("slowlist", "start")[0]!.pid as number;
		const removedListAt = Date.now();
		await closeConnectorEverywhere("slowlist");
		await until(() => !alive(listPid), "the program waiting to list has exited soon after its removal", 3_000);
		console.log(`  the program waiting to list exited ${Date.now() - removedListAt} ms after its removal`);
		assert.equal((await listing).ok, false, "the check reads as not connected");
	}

	// The new patches: one that must apply fails the install when its lines changed; one rooms work without warns.
	{
		const managerOf = (adapter: string) => path.join(adapter, "server-manager.ts");
		const required = scratch(patchedCache);
		fs.writeFileSync(managerOf(required), fs.readFileSync(managerOf(required), "utf8").replace("  async closeAll(): Promise<void> {\n    connectorManagers().delete(this);\n", "  async closeEverything(): Promise<void> {\n"));
		const requiredRun = runPatch(required);
		assert.ok(requiredRun.status === 1 && requiredRun.errors.some((line) => line.includes("patch 21")), `a changed manager fails the install on patch 21 (status ${requiredRun.status}, ${requiredRun.errors.join(" | ")})`);
		const optional = scratch(patchedCache);
		const initOf = path.join(optional, "init.ts");
		fs.writeFileSync(initOf, fs.readFileSync(initOf, "utf8").replace(/  \/\/ A connector's changed tools and documents reach this session[^\n]*\n  manager\.onListChanged = \(serverName\) => \{\n    updateServerMetadata\(state, serverName\);\n    updateMetadataCache\(state, serverName\);\n  \};\n\n  lifecycle\.setReconnectCallback/, "  lifecycle.setReconnectCallbacks"));
		const optionalRun = spawnSync(process.execPath, [patchScript, "--adapter-dir", optional], { cwd: agentDir, encoding: "utf8", env: { PATH: process.env.PATH, HOME: agentDir } });
		assert.ok(optionalRun.status === 0 && `${optionalRun.stdout}${optionalRun.stderr}`.includes("patch 23 (a session takes a connector's changed list) anchors not found once"), `a changed session start only warns on patch 23 (status ${optionalRun.status})`);
	}

	// A description is the service's words, and can repeat a key, as it is or encoded: here it is sent as given;
	// on a shared server none is, whatever it holds. Last, as the switch stays on for the rest of this process.
	const echoes = { echo_plain: `Uses ${KEY} for you.`, echo_encoded: `Uses ${Buffer.from(KEY).toString("base64")} for you.` };
	connector.tools = Object.entries(echoes).map(([name, description]) => ({ name, description }) as never);
	assert.equal((await testMcpServer("team-wiki")).ok, true, "the check reaches the connector again");
	assert.deepEqual((await statusOf("team-wiki")).tools!.descriptions, { ...echoes, get_notes: "Read resource: smoke://notes" }, "here each description is sent as the connector gave it");
	registerServerHooks({});
	const shared = await statusOf("team-wiki");
	assert.deepEqual(shared.tools!.names, Object.keys(echoes), "a shared server still lists the tools");
	assert.deepEqual(shared.tools!.descriptions, {}, "a shared server sends no description");
	assert.deepEqual(Object.keys(shared.tools!).sort(), ["cachedAt", "count", "descriptions", "documents", "names", "readOnly", "titles"], `a shared server sends main's tool fields alone, got ${Object.keys(shared.tools!).join(", ")}`);
	const sharedSent = JSON.stringify(shared);
	assert.ok(!sharedSent.includes(KEY) && !sharedSent.includes(Buffer.from(KEY).toString("base64")), `a shared server's answer holds no form of the key, got ${sharedSent}`);

	console.log("connector-tool-facts-smoke: the saved tool list keeps each tool's title and marks whoever writes it, and the status sends descriptions, titles and marks alone");
} finally {
	connector.server.closeAllConnections();
	connector.server.close();
	fs.rmSync(agentDir, { recursive: true, force: true });
}
