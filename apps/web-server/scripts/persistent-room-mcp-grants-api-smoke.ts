// Per-room MCP grants API smoke, against a really spawned web server:
//
//  1. boot migration - a legacy room seeded WITHOUT a grants file receives the
//     full current connector list at startup, and the one-time marker lands;
//  2. scaffold default - a room created through the API starts with an
//     explicit EMPTY grant list;
//  3. the GET/PUT /api/persistent-agents/:id/mcp-connectors round trip -
//     grant validates against the live configured list (unknown connector is
//     a 400), revoke stays permissive;
//  4. revoke-on-delete - DELETE /api/mcp/servers/:name revokes the connector
//     from every room that held it and names those rooms in its response.
//
// Offline: connectors are URL entries nobody ever connects to.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authedFetch, freePort, type AuthedFetchInit, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, waitForServer } from "./smoke-server-process.js";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-mcp-grants-home-"));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
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

async function requestJson(pathname: string, init?: AuthedFetchInit): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, init);
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

function putGrant(roomId: string, action: "grant" | "revoke", name: string): Promise<{ status: number; body: any }> {
	return requestJson(`/api/persistent-agents/${roomId}/mcp-connectors`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ action, name }),
	});
}

let server: ChildProcessWithoutNullStreams | null = null;
const serverOutput: string[] = [];

try {
	// Seed the world BEFORE boot: a configured connector and a legacy room
	// (agent.json, no grants file) that must be migrated on startup.
	fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	fs.mkdirSync(productAppRoot, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { "legacy-connector": { url: "http://127.0.0.1:9/mcp" } } }, null, 2));
	const legacyRoomId = "legacy-mcp-room";
	fs.mkdirSync(path.join(agentsRoot, legacyRoomId), { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(agentsRoot, legacyRoomId, "agent.json"), JSON.stringify({ agentId: legacyRoomId }), { mode: 0o600 });
	// Minimal AI profile so room creation works (no turn ever runs).
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
		providers: { "openai-compatible": { name: "Dead Gateway", baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", models: [{ id: "room-model", name: "Room Model", contextWindow: 128000, maxTokens: 16384 }] } },
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-mcp-grants-key" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(productAppRoot, "openai-compatible-ai-profile.json"), JSON.stringify({
		profileId: "openai-compatible",
		providerId: "openai-compatible",
		label: "Dead Gateway",
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
	await waitForServer(server, baseUrl, 30_000);

	// 1. Boot migration: the legacy room got the FULL current connector list.
	const legacySettingsPath = path.join(agentsRoot, legacyRoomId, "runtime", "mcp-settings.json");
	assert(fs.existsSync(legacySettingsPath), "boot migration must write a grants file into the legacy room");
	const legacySettings = JSON.parse(fs.readFileSync(legacySettingsPath, "utf-8"));
	assert(Array.isArray(legacySettings.grantedConnectors) && legacySettings.grantedConnectors.join(",") === "legacy-connector", `the legacy room must hold the full connector list, got ${JSON.stringify(legacySettings.grantedConnectors)}`);
	assert(fs.existsSync(path.join(agentsRoot, ".mcp-grants-migration.json")), "boot migration must write its one-time marker");

	// 2. Scaffold default: a NEW room starts with an explicit empty list.
	const created = await requestJson("/api/persistent-agents", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ displayName: "Grants Smoke Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }),
	});
	assert(created.status === 201, `room creation should return 201, got ${created.status}: ${JSON.stringify(created.body)}`);
	const roomId = String(created.body?.agent?.id ?? "");
	assert(roomId, "room creation should return an agent id");
	const newSettingsPath = path.join(agentsRoot, roomId, "runtime", "mcp-settings.json");
	assert(fs.existsSync(newSettingsPath), "the scaffold must write an explicit grants file");
	assert(JSON.parse(fs.readFileSync(newSettingsPath, "utf-8")).grantedConnectors.length === 0, "a new room must start with an empty grant list");

	// 3. GET/PUT round trip.
	const fresh = await requestJson(`/api/persistent-agents/${roomId}/mcp-connectors`);
	assert(fresh.status === 200, `GET mcp-connectors should return 200, got ${fresh.status}: ${JSON.stringify(fresh.body)}`);
	assert(fresh.body.settings.grantedConnectors.length === 0, "a new room's grants must read empty");
	assert(fresh.body.configuredConnectors.join(",") === "legacy-connector", `the configured list should carry the seeded connector, got ${JSON.stringify(fresh.body.configuredConnectors)}`);
	const grantedNew = await putGrant(roomId, "grant", "legacy-connector");
	assert(grantedNew.status === 200 && grantedNew.body.granted.length === 1 && grantedNew.body.granted[0].name === "legacy-connector" && grantedNew.body.granted[0].configured === true, `granting a configured connector should succeed, got ${JSON.stringify(grantedNew.body)}`);
	const grantedGhost = await putGrant(roomId, "grant", "ghost-connector");
	assert(grantedGhost.status === 400, `granting an unconfigured connector must 400, got ${grantedGhost.status}: ${JSON.stringify(grantedGhost.body)}`);
	const badAction = await putGrant(roomId, "detach" as unknown as "grant", "legacy-connector");
	assert(badAction.status === 400, "an unknown action must 400");

	// 4. Revoke-on-delete: deleting the connector sweeps every room's grant.
	const deleted = await requestJson("/api/mcp/servers/legacy-connector", { method: "DELETE" });
	assert(deleted.status === 200, `connector delete should return 200, got ${deleted.status}: ${JSON.stringify(deleted.body)}`);
	const revokedFromRooms: string[] = Array.isArray(deleted.body?.revokedFromRooms) ? deleted.body.revokedFromRooms : [];
	assert(revokedFromRooms.includes(roomId) && revokedFromRooms.includes(legacyRoomId), `the delete must name every room it revoked from, got ${JSON.stringify(revokedFromRooms)}`);
	const afterDelete = await requestJson(`/api/persistent-agents/${roomId}/mcp-connectors`);
	assert(afterDelete.body.settings.grantedConnectors.length === 0, "the deleted connector's grant must be gone from the room");
	assert(afterDelete.body.configuredConnectors.length === 0, "the deleted connector must be gone from the configured list");
	assert(JSON.parse(fs.readFileSync(legacySettingsPath, "utf-8")).grantedConnectors.length === 0, "the legacy room's grant must be gone too");

	// 5. The room's own answer names each connector as the person typed it,
	// without its address: a member on a shared server reads only this.
	const address = "http://127.0.0.1:9/team-wiki-mcp";
	const added = await requestJson("/api/mcp/servers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Team wiki", url: address }) });
	assert(added.status === 200 && added.body.name === "team-wiki", `adding a named connector should succeed, got ${added.status}: ${JSON.stringify(added.body)}`);
	const named = await requestJson(`/api/persistent-agents/${roomId}/mcp-connectors`);
	assert(JSON.stringify(named.body.displayNames) === JSON.stringify({ "team-wiki": "Team wiki" }), `the room's answer names the connector as typed, got ${JSON.stringify(named.body.displayNames)}`);
	assert(!JSON.stringify(named.body).includes(address), "the room's answer never carries a connector's address");
	const grantedNamed = await putGrant(roomId, "grant", "team-wiki");
	assert(grantedNamed.status === 200 && grantedNamed.body.displayNames?.["team-wiki"] === "Team wiki", `a grant's answer names it too, got ${JSON.stringify(grantedNamed.body)}`);

	// 5b. The room's list of old yeses shows only the tools with no choice on
	// the connector's page, a yes the clearing missed included, and goes when
	// none is left.
	const roomBefore = fs.readFileSync(newSettingsPath, "utf-8");
	const seedYeses = (tools: string[]) => fs.writeFileSync(newSettingsPath, `${JSON.stringify({ schemaVersion: 1, grantedConnectors: ["team-wiki"], allowedTools: { "team-wiki": tools.map((tool) => ({ tool, addressPin: "b".repeat(64) })) }, updatedAt: "2026-11-19T00:00:00.000Z" }, null, 2)}\n`, { mode: 0o600 });
	const listedYeses = async () => JSON.stringify(((await requestJson(`/api/persistent-agents/${roomId}/mcp-connectors`)).body.allowedTools ?? {})["team-wiki"]?.map((entry: { tool: string }) => entry.tool).sort() ?? null);
	const choose = async (tools: Record<string, string | null>) => {
		const answer = await requestJson("/api/mcp/servers/team-wiki/tools", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ tools }) });
		assert(answer.status === 200, `the connector's page saves ${JSON.stringify(tools)}, got ${answer.status}: ${JSON.stringify(answer.body)}`);
	};
	seedYeses(["read_page", "edit_page"]);
	assert((await listedYeses()) === JSON.stringify(["edit_page", "read_page"]), `both old yeses are listed, got ${await listedYeses()}`);
	await choose({ read_page: "ask" });
	assert((await listedYeses()) === JSON.stringify(["edit_page"]), `a tool with a choice leaves the list, got ${await listedYeses()}`);
	seedYeses(["read_page", "edit_page"]);
	assert((await listedYeses()) === JSON.stringify(["edit_page"]), `a yes the clearing missed stays off the list, got ${await listedYeses()}`);
	await choose({ edit_page: "blocked" });
	assert((await listedYeses()) === "null", `with none left, the connector has no list, got ${await listedYeses()}`);
	await choose({ read_page: null, edit_page: null });
	fs.writeFileSync(newSettingsPath, roomBefore, { mode: 0o600 });

	// 6. Removing a connector is all or nothing: a delete that does not answer
	// 200 leaves the connector configured and every room's file as it was.
	// Both rooms hold team-wiki; the legacy room also holds a yes to one of its tools.
	const yes = { "team-wiki": [{ tool: "read_page", addressPin: "a".repeat(64) }] };
	fs.writeFileSync(legacySettingsPath, `${JSON.stringify({ schemaVersion: 1, grantedConnectors: ["team-wiki"], allowedTools: yes, updatedAt: "2026-11-19T00:00:00.000Z" }, null, 2)}\n`, { mode: 0o600 });
	const roomSettingsPaths = [newSettingsPath, legacySettingsPath];
	// Every file the delete could write: the app's own files and each room's settings.
	const filesNow = (): Record<string, string> => {
		const files: Record<string, string> = {};
		const walk = (dir: string) => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else files[full] = fs.readFileSync(full, "utf-8");
			}
		};
		walk(agentDir);
		for (const settings of roomSettingsPaths) files[settings] = fs.readFileSync(settings, "utf-8");
		return files;
	};
	const unchangedSince = (before: Record<string, string>, what: string) => {
		const after = filesNow();
		const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((file) => before[file] !== after[file]);
		assert(changed.length === 0, `${what} changes no file, changed ${changed.map((file) => path.relative(tempHome, file)).join(", ")}`);
	};
	const deleteConnector = (name: string) => requestJson(`/api/mcp/servers/${encodeURIComponent(name)}`, { method: "DELETE" });
	// Each row says whether it held, so one run shows every row that fails.
	const failedRows: string[] = [];
	const row = async (what: string, check: () => Promise<void>) => {
		try {
			await check();
		} catch (error) {
			failedRows.push(`${what}: ${(error as Error).message}`);
		}
	};

	// A name that is only a built-in property of every object is no connector:
	// each route that looks one up by name answers 404 and writes nothing.
	for (const ghost of ["constructor", "__proto__", "toString"]) await row(`"${ghost}" is no connector`, async () => {
		const before = filesNow();
		const answers = {
			delete: await deleteConnector(ghost),
			address: await requestJson(`/api/mcp/servers/${encodeURIComponent(ghost)}/address`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "http://127.0.0.1:9/elsewhere-mcp" }) }),
			login: await requestJson(`/api/mcp/servers/${encodeURIComponent(ghost)}/login`, { method: "POST" }),
			test: await requestJson(`/api/mcp/servers/${encodeURIComponent(ghost)}/test`, { method: "POST" }),
			tools: await requestJson(`/api/mcp/servers/${encodeURIComponent(ghost)}/tools`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ tools: { read_page: "blocked" } }) }),
		};
		for (const [route, answer] of Object.entries(answers)) assert(answer.status === 404, `${route} of "${ghost}" answers 404, got ${answer.status}: ${JSON.stringify(answer.body)}`);
		// Sign-out names no connector it looks up: it answers as for any name, and writes nothing either.
		const logout = await requestJson(`/api/mcp/servers/${encodeURIComponent(ghost)}/logout`, { method: "POST" });
		assert(logout.status === 200, `logout of "${ghost}" answers as for any name, got ${logout.status}: ${JSON.stringify(logout.body)}`);
		unchangedSince(before, `a request about "${ghost}"`);
	});

	// A refusal (409): a connector only another app's file defines leaves every room's grant.
	fs.mkdirSync(path.join(tempHome, ".cursor"), { recursive: true });
	fs.writeFileSync(path.join(tempHome, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { "from-cursor": { url: "http://127.0.0.1:9/cursor-mcp" } } }, null, 2));
	const ownConfigPath = path.join(agentDir, "mcp.json");
	fs.writeFileSync(ownConfigPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(ownConfigPath, "utf-8")), imports: ["cursor"] }, null, 2));
	for (const settings of roomSettingsPaths) {
		const current = JSON.parse(fs.readFileSync(settings, "utf-8"));
		fs.writeFileSync(settings, `${JSON.stringify({ ...current, grantedConnectors: [...current.grantedConnectors, "from-cursor"] }, null, 2)}\n`, { mode: 0o600 });
	}
	await row("a refused removal", async () => {
		const beforeRefusal = filesNow();
		const refusedImported = await deleteConnector("from-cursor");
		assert(refusedImported.status === 409, `removing a connector of another app is refused, got ${refusedImported.status}: ${JSON.stringify(refusedImported.body)}`);
		unchangedSince(beforeRefusal, "a refused removal");
	});

	// A folder's refusal can be forced only off Windows and not as root.
	const canForceFsRefusal = process.platform !== "win32" && process.getuid?.() !== 0;
	if (canForceFsRefusal) {
		await row("a removal whose own write fails", async () => {
			// The connector's own file can't be written: the rooms keep what they had.
			const beforeWriteFails = filesNow();
			fs.chmodSync(agentDir, 0o500);
			let ownWriteFails;
			try {
				ownWriteFails = await deleteConnector("team-wiki");
			} finally {
				fs.chmodSync(agentDir, 0o700);
			}
			assert(ownWriteFails.status === 500, `a removal whose own write fails answers 500, got ${ownWriteFails.status}: ${JSON.stringify(ownWriteFails.body)}`);
			unchangedSince(beforeWriteFails, "a removal whose own write fails");
		});

		await row("a room that can't be read", async () => {
			// A room whose settings can't be read stops the removal: its grant can't be known.
			const beforeUnreadable = filesNow();
			fs.chmodSync(legacySettingsPath, 0o000);
			let unreadable;
			try {
				unreadable = await deleteConnector("team-wiki");
			} finally {
				fs.chmodSync(legacySettingsPath, 0o600);
			}
			assert(unreadable.status === 500 && JSON.stringify((unreadable.body?.revokeFailures ?? []).map((failure: { agentId: string }) => failure.agentId)) === JSON.stringify([legacyRoomId]), `a room that can't be read stops the removal and is named, got ${unreadable.status}: ${JSON.stringify(unreadable.body)}`);
			unchangedSince(beforeUnreadable, "a removal a room's unreadable settings stopped");
		});

		await row("the same delete once it can be read", async () => {
			// Once it can be read, the same delete takes it from the app and every room.
			const removed = await deleteConnector("team-wiki");
			assert(removed.status === 200 && [...(removed.body?.revokedFromRooms ?? [])].sort().join(",") === [legacyRoomId, roomId].sort().join(","), `the same delete then succeeds in every room, got ${removed.status}: ${JSON.stringify(removed.body)}`);
			for (const settings of roomSettingsPaths) assert(!fs.readFileSync(settings, "utf-8").includes("team-wiki"), `no room names the removed connector, ${path.relative(tempHome, settings)} does`);
			assert(!fs.readFileSync(ownConfigPath, "utf-8").includes("team-wiki"), "the removed connector is gone from the app's file");
		});
	}
	assert(failedRows.length === 0, `removal rows failed:\n${failedRows.join("\n")}`);

	console.log("persistent-room-mcp-grants-api-smoke: OK");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp home preserved for inspection: ${tempHome}`);
	console.error(serverOutput.slice(-40).join(""));
	process.exitCode = 1;
} finally {
	await stopSmokeServer(server);
	if (process.exitCode !== 1) fs.rmSync(tempHome, { recursive: true, force: true });
}
