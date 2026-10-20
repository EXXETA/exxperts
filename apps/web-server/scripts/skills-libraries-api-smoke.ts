import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { authedFetch, freePort, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer } from "./smoke-server-process.js";
import { REFERENCE_KINDS, type RepositoryFilePolicy } from "../src/skills-file-policy.js";
import { sha256 } from "../src/skills-store.js";
import { persistentRoomSkillSettingsPath } from "../src/persistent-room-skill-settings.js";
import { classifyRemoteRoute } from "../src/remote-route-policy.js";

// HTTP + real room-tool integration with synthetic Git, documents and model gateway only.
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-skill-libraries-api-"));
const fixtureHome = path.join(temporaryRoot, "home");
const fixtureRepo = path.join(temporaryRoot, "repo");
const fixtureProject = path.join(temporaryRoot, "project");
const badRepo = path.join(temporaryRoot, "not-a-git-repo");
const stateHome = path.join(temporaryRoot, "state");
const appRoot = path.join(stateHome, ".exxperts", "app");
const agentDir = path.join(stateHome, ".exxperts", "agent");
const agentsRoot = path.join(appRoot, "personalized-agents");
const webServerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const require = createRequire(import.meta.url);
const loader = pathToFileURL(require.resolve("tsx/esm")).href;
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const policy: RepositoryFilePolicy = { designRepo: true, allowedTypes: [...REFERENCE_KINDS], skillRoot: "skills", referenceRoots: ["brands/a", "extras"] };
const startupAccess = { mode: "anonymous", rememberLocalAccess: false, checkOnStartup: true, consentVersion: 1 };
const libraryInput = { name: "Synthetic brands", source: fixtureRepo, ref: "main", ...policy };
let server: ChildProcessWithoutNullStreams | undefined;
let output = "";
let toolRequest: { name: string; arguments: Record<string, unknown> } = { name: "read_skill_reference", arguments: { name: "brand-a", reference: "brands/a/colors.css" } };
const toolResults: string[] = [];
const toolLists: string[][] = [];
const longSkillName = "a".repeat(49);

function git(...args: string[]): string {
	const result = spawnSync("git", args, { cwd: fixtureRepo, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}
function write(relative: string, bytes: string | Buffer): void {
	const destination = path.join(fixtureRepo, ...relative.split("/"));
	fs.mkdirSync(path.dirname(destination), { recursive: true });
	fs.writeFileSync(destination, bytes);
}
function commit(message: string): void { git("add", "-A"); git("-c", "user.name=Synthetic Smoke", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", message); }
async function json(route: string, body?: unknown, method = body === undefined ? "GET" : "POST", expected = 200): Promise<any> {
	const response = await authedFetch(`${base}${route}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
	const text = await response.text();
	const result = text ? JSON.parse(text) : null;
	assert.equal(response.status, expected, `${method} ${route}: ${text.slice(0, 900)}`);
	return result;
}
async function until<T>(read: () => Promise<T>, accepts: (value: T) => boolean, label: string): Promise<T> {
	const deadline = Date.now() + 25000;
	while (Date.now() < deadline) {
		if (server?.exitCode != null) throw new Error(`Test server exited: ${output.slice(-3000)}`);
		try { const value = await read(); if (accepts(value)) return value; } catch (error) { if (Date.now() + 200 >= deadline) throw error; }
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`Timed out waiting for ${label}: ${output.slice(-1500)}`);
}

const gateway = http.createServer((request, response) => {
	if (request.method !== "POST" || !String(request.url).endsWith("/chat/completions")) { response.writeHead(404).end(); return; }
	let raw = "";
	request.on("data", (part) => { raw += String(part); });
	request.on("end", () => {
		const payload = JSON.parse(raw);
		const toolMessages = (payload.messages ?? []).filter((message: any) => message.role === "tool");
		response.writeHead(200, { "content-type": "text/event-stream" });
		const chunk = (delta: unknown, finish_reason: string | null) => response.write(`data: ${JSON.stringify({ id: "synthetic", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
		if (!toolMessages.length) {
			toolLists.push((payload.tools ?? []).map((tool: any) => tool.function?.name));
			chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_fixture", type: "function", function: { name: toolRequest.name, arguments: "" } }] }, null);
			chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(toolRequest.arguments) } }] }, null);
			chunk({}, "tool_calls");
		} else {
			toolResults.push(toolMessages.map((message: any) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n"));
			chunk({ role: "assistant", content: "Synthetic turn complete." }, null);
			chunk({}, "stop");
		}
		response.end("data: [DONE]\n\n");
	});
});

async function start(): Promise<void> {
	output = "";
	const env = smokeHomeEnv(fixtureHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: fixtureProject, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot, EXXETA_SKILLS_ALLOW_LOCAL_REPO: "1", EXXPERTS_SKILLS_FEATURED_SOURCES: JSON.stringify([{ source: fixtureRepo, author: "synthetic" }]) });
	env.EXXPERTS_STATE_HOME = stateHome;
	env.EXXPERTS_CODING_AGENT_DIR = agentDir;
	env.PI_CODING_AGENT_DIR = agentDir;
	for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY", "EXXETA_AI_API_KEY", "COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "GEMINI_API_KEY", "GOOGLE_CLOUD_API_KEY", "OPENROUTER_API_KEY"]) delete env[key];
	server = spawn(process.execPath, ["--import", loader, "src/index.ts"], { ...SMOKE_SERVER_SPAWN_TREE_OPTIONS, cwd: webServerDir, env: env as NodeJS.ProcessEnv });
	console.log(`skills-libraries-api-smoke: isolated app pid=${server.pid} port=${port}`);
	server.stdout.on("data", (part) => { output = (output + String(part)).slice(-12000); });
	server.stderr.on("data", (part) => { output = (output + String(part)).slice(-12000); });
	await until(() => fetch(`${base}/healthz`), (response) => response.ok, "server startup");
}

async function toolTurn(room: string, requested: typeof toolRequest): Promise<string> {
	toolRequest = requested;
	const thread = `fixture-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
	await json(`/api/persistent-agents/${room}/threads/${thread}`, { state: "active", origin: "launcher", model: { provider: "openai-compatible", model: "fixture-model" }, items: [] }, "PUT");
	const WebSocket = (await import("ws")).default;
	const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?persistentAgentId=${room}&conversationId=${thread}&modelProvider=openai-compatible&model=fixture-model&reattach=1`, { headers: { ...SMOKE_AUTH_HEADERS } });
	const frames: any[] = [];
	socket.on("message", (data: unknown) => { frames.push(JSON.parse(String(data))); });
	const before = toolResults.length;
	try {
		await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
		socket.send(JSON.stringify({ type: "prompt", text: "Read the selected synthetic brand reference." }));
		await until(async () => ({ ended: frames.some((frame) => frame?.event?.type === "agent_end"), error: frames.find((frame) => String(frame.type).includes("error")) }), (state) => {
			if (state.error) throw new Error(JSON.stringify(state.error));
			return state.ended && toolResults.length > before;
		}, "real room reference tool roundtrip");
		assert(toolLists.at(-1)?.includes(requested.name), `the actual runtime must register ${requested.name}`);
		return toolResults.at(-1)!;
	} finally { socket.close(); }
}

function turn(room: string, name = "brand-a", reference = "brands/a/colors.css"): Promise<string> {
	return toolTurn(room, { name: "read_skill_reference", arguments: { name, reference } });
}

function sourceTurn(room: string, libraryId: string, reference?: string): Promise<string> {
	return toolTurn(room, { name: "read_library_reference", arguments: { libraryId, ...(reference !== undefined ? { reference } : {}) } });
}

async function asset(name: string, original: string, expectedBytes: Buffer): Promise<void> {
	const response = await authedFetch(`${base}/api/skills/${name}/references/${encodeURIComponent(original)}`);
	assert.equal(response.status, 200, await response.clone().text());
	assert.equal(response.headers.get("x-content-type-options"), "nosniff");
	assert(response.headers.get("content-disposition")?.startsWith("attachment;"));
	assert.equal(response.headers.get("content-type"), "application/octet-stream");
	assert.deepEqual(Buffer.from(await response.arrayBuffer()), expectedBytes);
}

try {
	for (const folder of [fixtureHome, fixtureRepo, fixtureProject, badRepo, appRoot, agentDir, agentsRoot]) fs.mkdirSync(folder, { recursive: true });
	for (const directory of ["bin", "pi-package", "apps"]) fs.symlinkSync(path.join(repoRoot, directory), path.join(fixtureProject, directory), process.platform === "win32" ? "junction" : "dir");
	const collisionFixtures = [
		{ name: "shared-collision", source: "shared", directory: path.join(fixtureHome, ".agents", "skills", "different-shared-folder") },
		{ name: "project-collision", source: "project", directory: path.join(fixtureProject, ".exxeta", "skills", "different-project-folder") },
	];
	for (const fixture of collisionFixtures) {
		fs.mkdirSync(fixture.directory, { recursive: true });
		fs.writeFileSync(path.join(fixture.directory, "SKILL.md"), `---\nname: ${fixture.name}\ndescription: Existing ${fixture.source} fixture\n---\nOriginal ${fixture.source} instructions must remain visible.\n`);
	}
	git("init", "-q", "-b", "main");
	git("config", "uploadpack.allowFilter", "true");
	for (const name of ["brand-a", "brand-b", "transient-brand", "featured-brand"]) write(`skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: Synthetic ${name}\n---\nUse selected references only.\n`);
	for (const fixture of collisionFixtures) write(`skills/${fixture.name}/SKILL.md`, `---\nname: ${fixture.name}\ndescription: New repository collision\n---\nRemote instructions must not shadow the existing skill.\n`);
	write("skills/too-long/SKILL.md", `---\nname: ${longSkillName}\ndescription: Exceeds the canonical ID limit\n---\nThis skill cannot be imported under its current name.\n`);
	write("skills/design_base_skill/SKILL.md", "---\nname: Design_Base_Skill\ndescription: Synthetic design reference\n---\nRead `brands/a/palette.json`.\n");
	write("brands/a/palette.json", '{"color":"#123456"}');
	write("skills/brand-a/reference.md", "Selected Markdown.\n");
	write("skills/brand-a/unselected.md", "Unselected Markdown.\n");
	write("skills/brand-a/must-not-run.js", "throw new Error('not imported or executed');");
	write("skills/featured-brand/must-not-run.py", "raise Exception('never copied')");
	write("brands/a/colors.css", ":root { --primary: #123456; }\n");
	write("extras/guide.md", "Unassigned source material V1.\n");
	write("extras/tokens.json", '{"color":"#extra123"}');
	write("extras/hidden.md", "Unselected synthetic material must remain private.\n");
	write("unrelated/README.md", "Outside selected directories.\n");
	const documents = new Map<string, Buffer>();
	documents.set("brands/a/logo.svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>'));
	documents.set("brands/a/logo.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6HkAAAAASUVORK5CYII=", "base64"));
	documents.set("brands/a/guide.pdf", Buffer.from("%PDF-1.4\n"));
	const docx = new JSZip();
	docx.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
	docx.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic brand</w:t></w:r></w:p></w:body></w:document>');
	documents.set("brands/a/guide.docx", await docx.generateAsync({ type: "nodebuffer" }));
	const workbook = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["brand", "color"], ["A", "#123456"]]), "Brand");
	documents.set("brands/a/tokens.xlsx", XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
	const font = Buffer.alloc(44); font.write("wOFF"); font.writeUInt32BE(0x00010000, 4); font.writeUInt32BE(44, 8);
	documents.set("brands/a/font.woff", font);
	for (const [original, bytes] of documents) write(original, bytes);
	commit("synthetic initial skills and opt-in assets");
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	const gatewayPort = (gateway.address() as AddressInfo).port;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "openai-compatible": { name: "Synthetic Gateway", baseUrl: `http://127.0.0.1:${gatewayPort}/v1`, api: "openai-completions", models: [{ id: "fixture-model", name: "Fixture Model", contextWindow: 128000, maxTokens: 4096 }] } } }));
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-only" } }));
	fs.writeFileSync(path.join(appRoot, "openai-compatible-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "fixture-model", label: "Fixture Model" }], maintenanceModel: "fixture-model" }));
	fs.writeFileSync(path.join(appRoot, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }));
	const legacyCheckTime = "2026-10-01T00:00:00.000Z";
	fs.writeFileSync(path.join(appRoot, "skill-libraries.json"), JSON.stringify([{ id: "legacy-access-fixture", name: "Legacy access fixture", source: fixtureRepo, ...policy, status: "current", lastCheckedAt: legacyCheckTime }]));
	await start();
	const legacy = (await json("/api/skills/libraries")).libraries.find((item: any) => item.id === "legacy-access-fixture");
	assert.equal(legacy.repositoryAccess, undefined, "old libraries wait for explicit access confirmation");
	assert.equal(legacy.lastCheckedAt, legacyCheckTime, "server startup does not recheck legacy libraries");
	await json("/api/skills/libraries/legacy-access-fixture", undefined, "DELETE");
	for (const route of ["/api/skills/repo/auth/status", "/api/skills/repo/auth/login", "/api/skills/repo/access", "/api/skills/repo/access/revoke"]) assert.equal(classifyRemoteRoute("POST", route), "local");
	await json("/api/skills/repo/auth/status", { source: "http://example.invalid/group/repo" }, "POST", 400);
	await json("/api/skills/repo/auth/login", { source: "http://example.invalid/group/repo", provider: "gitlab" }, "POST", 400);
	await json("/api/skills/repo/auth/login", { source: "https://github.com/fixture/private", provider: "invalid" }, "POST", 400);
	const privateAddress = "https://github.com/synthetic/private";
	const ungranted = await json("/api/skills/repo/auth/status", { source: privateAddress });
	assert.equal(ungranted.mode, "anonymous");
	assert.equal(ungranted.confirmed, false);
	assert.equal(ungranted.setupCommands.length, 0, "anonymous status never inspects local credential-helper setup");
	for (const allowCredentialStorage of [undefined, false, true]) {
		const denied = await json("/api/skills/repo/auth/login", { source: privateAddress, provider: "github", allowCredentialStorage }, "POST", 403);
		assert.equal(denied.code, "REPOSITORY_ACCESS_REQUIRED", "storage consent cannot substitute for a local-access grant");
	}
	const anonymousGrant = await json("/api/skills/repo/access", { source: privateAddress, mode: "anonymous", rememberLocalAccess: true, checkOnStartup: false });
	assert.equal(anonymousGrant.mode, "anonymous");
	assert.equal(anonymousGrant.confirmed, true);
	assert.equal(anonymousGrant.rememberLocalAccess, false);
	assert.equal(anonymousGrant.checkOnStartup, false);
	assert(anonymousGrant.accessId);
	const anonymousLogin = await json("/api/skills/repo/auth/login", { source: privateAddress, provider: "github", accessId: anonymousGrant.accessId, allowCredentialStorage: true }, "POST", 403);
	assert.equal(anonymousLogin.code, "REPOSITORY_ACCESS_REQUIRED");
	const sessionSecret = "synthetic-http-session-token-not-a-real-credential";
	const sessionGrant = await json("/api/skills/repo/access", { source: privateAddress, mode: "session-token", provider: "github", token: sessionSecret });
	assert.equal(sessionGrant.mode, "session-token");
	assert.equal(sessionGrant.confirmed, true);
	assert(!JSON.stringify(sessionGrant).includes(sessionSecret), "token endpoints never return credential contents");
	const sessionStatus = await json("/api/skills/repo/auth/status", { source: privateAddress, accessId: sessionGrant.accessId });
	assert.equal(sessionStatus.granted, true);
	assert(!JSON.stringify(sessionStatus).includes(sessionSecret));
	assert(!fs.readFileSync(path.join(appRoot, "skill-libraries.json"), "utf8").includes(sessionSecret));
	await json("/api/skills/repo/access/revoke", { source: privateAddress });
	const revokedSession = await json("/api/skills/repo/auth/status", { source: privateAddress, accessId: sessionGrant.accessId });
	assert.equal(revokedSession.confirmed, false);
	assert.equal(revokedSession.mode, "anonymous");
	const implicitGrant = await json("/api/skills/libraries", { source: privateAddress, repositoryAccess: startupAccess }, "POST", 403);
	assert.equal(implicitGrant.code, "REPOSITORY_ACCESS_REQUIRED", "ordinary library creation cannot grant repository access");
	await json("/api/skills/libraries", { ...libraryInput, designRepo: false }, "POST", 400);
	const defaultNamed = await json("/api/skills/libraries", { source: "https://github.com/obra/superpowers.git#main" }, "POST", 201);
	assert.equal(defaultNamed.library.name, "superpowers", "a missing custom name uses the repository basename");
	assert.equal(defaultNamed.library.ref, "main");
	assert.notEqual(defaultNamed.library.repositoryAccess?.checkOnStartup, true, "new sources do not implicitly enable startup checks");
	await json(`/api/skills/libraries/${defaultNamed.library.id}`, undefined, "DELETE");
	const blankNamed = await json("/api/skills/libraries", { name: "  ", source: "https://example.invalid/group/subgroup/design-library.git/" }, "POST", 201);
	assert.equal(blankNamed.library.name, "design-library", "trailing slash and nested GitLab groups are handled");
	await json(`/api/skills/libraries/${blankNamed.library.id}`, undefined, "DELETE");
	await json("/api/skills/libraries", { name: 42, source: "https://example.invalid/group/repo" }, "POST", 400);
	const created = await json("/api/skills/libraries", libraryInput, "POST", 201);
	const libraryId = created.library.id as string;
	const libraryRoute = `/api/skills/libraries/${libraryId}`;
	await json(libraryRoute, { ...libraryInput, name: "Renamed synthetic brands" }, "PUT");
	assert.equal((await json("/api/skills/libraries")).libraries[0].name, "Renamed synthetic brands");
	const defaultScan = await json("/api/skills/repo/scan", { source: fixtureRepo });
	assert.deepEqual(defaultScan.policy.allowedTypes, ["markdown"]);
	await json("/api/skills/repo/candidate", { token: defaultScan.token, path: "skills/brand-a", references: ["brands/a/logo.png"] }, "POST", 400);
	const scan = await json(`${libraryRoute}/scan`, {});
	assert.equal(scan.libraryId, libraryId);
	assert.equal(scan.ref, "main");
	assert.equal(scan.skills.length, 8);
	assert.equal(scan.files.find((entry: any) => entry.path.endsWith("must-not-run.js"))?.allowed, false);
	const manifestPreview = await json("/api/skills/repo/preview", { token: scan.token, reference: "skills/brand-a/SKILL.md" });
	assert.equal(manifestPreview.kind, "markdown");
	assert(manifestPreview.text.includes("name: brand-a"));
	await json("/api/skills/repo/preview", { token: scan.token, reference: "skills/brand-a/must-not-run.js" }, "POST", 400);
	await json("/api/skills/repo/preview", { token: defaultScan.token, reference: "brands/a/logo.png" }, "POST", 400);
	await json("/api/skills/repo/preview", { token: scan.token, reference: "../outside.md" }, "POST", 400);
	const canonicalStore = path.join(agentDir, "skills");
	const beforeRejectedImports = fs.existsSync(canonicalStore) ? fs.readdirSync(canonicalStore).sort() : [];
	for (const fixture of collisionFixtures) {
		const existing = await json(`/api/skills/${fixture.name}`);
		assert.equal(existing.source, fixture.source);
		assert(existing.body.includes(`Original ${fixture.source} instructions`));
		const collision = await json("/api/skills/repo/candidate", { token: scan.token, path: `skills/${fixture.name}`, references: [] });
		assert.equal(collision.name, fixture.name);
		await json("/api/skills/repo/import", { token: scan.token, path: `skills/${fixture.name}`, references: [], reviewSha256: collision.reviewSha256 }, "POST", 409);
		assert(!fs.existsSync(path.join(canonicalStore, fixture.name)), "rejected name collisions must not create a canonical package");
		const unchanged = await json(`/api/skills/${fixture.name}`);
		assert.equal(unchanged.source, fixture.source);
		assert.equal(unchanged.body, existing.body);
	}
	const tooLong = await json("/api/skills/repo/candidate", { token: scan.token, path: "skills/too-long", references: [] });
	assert.equal(tooLong.name, longSkillName.slice(0, 48));
	assert.equal(tooLong.originalName, longSkillName);
	await json("/api/skills/repo/import", { token: scan.token, path: "skills/too-long", id: "unreviewed-renaming", references: [], reviewSha256: tooLong.reviewSha256 }, "POST", 400);
	assert.deepEqual(fs.existsSync(canonicalStore) ? fs.readdirSync(canonicalStore).sort() : [], beforeRejectedImports, "rejected imports must leave the canonical store unchanged");
	assert.equal(fs.readdirSync(agentDir).some((name) => name.startsWith(".skill-library-")), false, "name checks reject before package staging");
	const normalizedPath = "skills/design_base_skill";
	const normalized = await json("/api/skills/repo/candidate", { token: scan.token, path: normalizedPath, references: ["brands/a/palette.json"] });
	assert.equal(normalized.name, "design-base-skill");
	assert.equal(normalized.originalName, "Design_Base_Skill");
	await json("/api/skills/repo/import", { token: scan.token, path: normalizedPath, references: ["brands/a/palette.json"], reviewSha256: normalized.reviewSha256 }, "POST", 201);
	assert.equal((await json("/api/skills/design-base-skill")).body, "Read `brands/a/palette.json`.");
	await json("/api/skills/repo/import", { token: scan.token, path: normalizedPath, references: ["brands/a/palette.json"], reviewSha256: normalized.reviewSha256 }, "POST", 409);
	const normalizedUpdate = await json(`${libraryRoute}/updates/design-base-skill/candidate`, { token: scan.token, references: ["brands/a/palette.json"] });
	assert.equal(normalizedUpdate.token, scan.token, "reference updates reuse the reviewed browse snapshot");
	assert.deepEqual(normalizedUpdate.changes, [], "normalization does not cause perpetual updates");
	await json(`${libraryRoute}/updates/design-base-skill/apply`, { token: normalizedUpdate.token, path: normalizedPath, references: ["brands/a/palette.json"], reviewSha256: normalizedUpdate.reviewSha256, localPackageSha256: normalizedUpdate.localPackageSha256 });
	await json(`${libraryRoute}/updates/design-base-skill/candidate`, { token: defaultScan.token }, "POST", 400);
	const selected = ["skills/brand-a/reference.md", "brands/a/colors.css", ...documents.keys()];
	const candidate = await json("/api/skills/repo/candidate", { token: scan.token, path: "skills/brand-a", references: selected });
	await json("/api/skills/repo/import", { token: scan.token, path: "skills/brand-a", references: selected, reviewSha256: "0".repeat(64) }, "POST", 400);
	const imported = await json("/api/skills/repo/import", { token: scan.token, path: "skills/brand-a", references: selected, reviewSha256: candidate.reviewSha256 }, "POST", 201);
	const localPreview = await json(`/api/skills/brand-a/references/${encodeURIComponent("brands/a/logo.svg")}/preview`);
	assert.equal(localPreview.kind, "svg");
	assert(localPreview.text.includes("<svg"));
	await json(`/api/skills/brand-a/references/${encodeURIComponent("skills/brand-a/unselected.md")}/preview`, undefined, "GET", 400);
	assert.equal(imported.provenance.repo.libraryId, libraryId);
	const installedDir = path.join(agentDir, "skills", "brand-a");
	assert(!fs.existsSync(path.join(installedDir, "must-not-run.js")));
	assert(!fs.existsSync(path.join(installedDir, "unselected.md")));
	const brandB = await json("/api/skills/repo/candidate", { token: scan.token, path: "skills/brand-b", references: [] });
	await json("/api/skills/repo/import", { token: scan.token, path: "skills/brand-b", references: [], reviewSha256: brandB.reviewSha256 }, "POST", 201);
	const legacyScan = await json("/api/skills/repo/scan", { source: `${fixtureRepo}#main`, policy });
	const transient = await json("/api/skills/repo/candidate", { token: legacyScan.token, path: "skills/transient-brand", references: [] });
	const transientImport = await json("/api/skills/repo/import", { token: legacyScan.token, path: "skills/transient-brand", references: [], reviewSha256: transient.reviewSha256 }, "POST", 201);
	assert.equal(transientImport.provenance.repo.libraryId, undefined);
	const featured = (await json("/api/skills/featured")).sources[0];
	const featuredCandidate = await json("/api/skills/repo/candidate", { token: featured.token, path: "skills/featured-brand", references: [] });
	await json("/api/skills/repo/import", { token: featured.token, path: "skills/featured-brand", references: [], reviewSha256: featuredCandidate.reviewSha256 }, "POST", 201);
	assert(!fs.existsSync(path.join(agentDir, "skills", "featured-brand", "must-not-run.py")));
	for (const [original, bytes] of documents) await asset("brand-a", original, bytes);
	await json(`/api/skills/brand-a/references/${encodeURIComponent("skills/brand-a/unselected.md")}`, undefined, "GET", 400);
	const roomA = (await json("/api/persistent-agents", { displayName: "Synthetic Brand A", userName: "Synthetic", preferredUserAddress: "Synthetic" }, "POST", 201)).agent.id as string;
	const roomB = (await json("/api/persistent-agents", { displayName: "Synthetic Brand B", userName: "Synthetic", preferredUserAddress: "Synthetic" }, "POST", 201)).agent.id as string;
	const roomRoute = `/api/persistent-agents/${roomA}/skill-settings`;
	const originalDetail = await json("/api/skills/brand-a");
	assert.equal(originalDetail.sha256, sha256(fs.readFileSync(path.join(installedDir, "SKILL.md"), "utf8")));
	assert.match(originalDetail.packageSha256, /^[a-f0-9]{64}$/);
	await json(roomRoute, { action: "enable", name: "brand-a" }, "PUT", 409);
	await json(roomRoute, { action: "enable", name: "brand-a", sha256: originalDetail.sha256, packageSha256: "0".repeat(64) }, "PUT", 409);
	await json(roomRoute, { action: "enable", name: "brand-a", sha256: originalDetail.sha256, packageSha256: originalDetail.packageSha256 }, "PUT");
	await json(roomRoute, { action: "approve-execution", name: "brand-a" }, "PUT", 400);
	const detailB = await json("/api/skills/brand-b");
	await json(`/api/persistent-agents/${roomB}/skill-settings`, { action: "enable", name: "brand-b", sha256: detailB.sha256, packageSha256: detailB.packageSha256 }, "PUT");
	assert((await turn(roomA)).includes("#123456"), "real room tool must return approved CSS");
	assert(!(await turn(roomA)).includes(installedDir), "managed tool results expose no execution path");
	assert((await turn(roomB)).includes("not enabled"), "another brand's room may not read this package");

	// Guided source materials are independent of individual skill references and room consent.
	const discovery = await json("/api/skills/repo/discovery", { token: scan.token, skillPaths: [normalizedPath] });
	assert(discovery.referenced.some((file: any) => file.path === "brands/a/palette.json" && file.selected));
	assert(discovery.additional.some((file: any) => file.path === "extras/guide.md" && !file.selected));
	await json("/api/skills/repo/discovery", { token: scan.token, skillPaths: ["missing-skill"] }, "POST", 400);
	assert.equal((await json(`${libraryRoute}/materials`)).manifest, null);
	const materialPaths = ["brands/a/colors.css", "extras/guide.md", "extras/tokens.json"];
	const prepareMaterials = (token: string, references: string[], expectedCurrentHash: string | null) => json(`${libraryRoute}/materials/candidate`, { token, references, expectedCurrentHash });
	const acceptMaterials = (candidateSha256: string, expected = 200) => json(`${libraryRoute}/materials/accept`, { candidateSha256 }, "POST", expected);
	await json(`${libraryRoute}/materials/candidate`, { token: scan.token, references: materialPaths }, "POST", 400);
	const materialProgressId = "00000000-0000-4000-8000-000000000001";
	await json(`${libraryRoute}/materials/candidate`, { token: scan.token, references: materialPaths, expectedCurrentHash: null, progressId: materialProgressId });
	const progress = (await json(`/api/skills/repo/progress/${materialProgressId}`)).progress;
	assert.equal(progress.status, "complete");
	assert.equal(progress.completed, materialPaths.length);
	assert.equal(progress.total, materialPaths.length);
	await json("/api/skills/repo/progress/invalid", undefined, "GET", 400);
	await json("/api/skills/repo/progress/00000000-0000-4000-8000-000000000002", undefined, "GET", 404);
	assert.equal((await json(`${libraryRoute}/materials`)).manifest, null, "preparation does not publish local materials");
	await json(`${libraryRoute}/materials/candidate`, { token: scan.token, references: ["skills/brand-a/must-not-run.js"], expectedCurrentHash: null }, "POST", 400);
	await json(`${libraryRoute}/materials/candidate`, { token: scan.token, references: ["skills/brand-a/SKILL.md"], expectedCurrentHash: null }, "POST", 400);
	const materialsOne = (await acceptMaterials((await prepareMaterials(scan.token, materialPaths, null)).candidateSha256)).manifest;
	assert.equal(materialsOne.files.length, 3);
	const localSourcePreview = await json(`${libraryRoute}/materials/${materialsOne.materialsSha256}/preview`, { reference: "extras/guide.md" });
	assert(localSourcePreview.text.includes("V1"));
	assert((await sourceTurn(roomA, libraryId, "extras/guide.md")).includes("not enabled"), "saved files alone do not grant room access");
	const sourceReviewRoute = `/api/persistent-agents/${roomA}/skill-sources/${libraryId}/review`;
	const sourceConsent = (review: any) => ({ action: "enable-source", libraryId, materialsSha256: review.materialsSha256, skills: review.skills.map((skill: any) => ({ name: skill.name, sha256: skill.sha256, packageSha256: skill.packageSha256 })), excludedSkills: [] });
	const sourceReviewOne = await json(sourceReviewRoute);
	assert(sourceReviewOne.skills.some((skill: any) => skill.name === "brand-a"));
	assert(sourceReviewOne.skills.some((skill: any) => skill.name === "brand-b"));
	const roomSettingsFile = persistentRoomSkillSettingsPath(roomA, { persistentAgentsRoot: agentsRoot });
	const beforeBadSource = fs.readFileSync(roomSettingsFile);
	await json(roomRoute, { ...sourceConsent(sourceReviewOne), materialsSha256: "0".repeat(64) }, "PUT", 409);
	assert.deepEqual(fs.readFileSync(roomSettingsFile), beforeBadSource, "stale material consent writes nothing");
	const enabledSource = await json(roomRoute, sourceConsent(sourceReviewOne), "PUT");
	assert.equal(enabledSource.settings.enabledSources[0].materialsSha256, materialsOne.materialsSha256);
	assert(enabledSource.settings.enabledSkills.some((skill: any) => skill.name === "brand-a"), "source activation preserves independent consent");
	assert((await sourceTurn(roomA, libraryId)).includes("extras"), "the real runtime lists reviewed source folders");
	assert((await sourceTurn(roomA, libraryId, "extras/guide.md")).includes("Unassigned source material V1"), "unassigned reviewed extras are readable");
	assert((await sourceTurn(roomB, libraryId, "extras/guide.md")).includes("not enabled"), "another room cannot read the source");
	assert((await sourceTurn(roomA, libraryId, "extras/hidden.md")).includes("not in the reviewed source selection"));
	assert((await sourceTurn(roomA, libraryId, "skills/brand-a/SKILL.md")).includes("through read_skill"), "material reads cannot bypass skill consent");
	const materialPointer = path.join(appRoot, "skill-library-materials", libraryId, "current.json");
	write("extras/guide.md", "Unassigned source material V2.\n"); commit("update unassigned source material");
	const materialOnlyCheck = await json(`${libraryRoute}/check`, {});
	assert(materialOnlyCheck.library.materialUpdates.includes("extras/guide.md"), "checks include selected source materials outside skill packages");
	const freshMaterialsScan = await json(`${libraryRoute}/scan`, { forceRefresh: true });
	const nextMaterials = await prepareMaterials(freshMaterialsScan.token, materialPaths, materialsOne.materialsSha256);
	const racingMaterials = await prepareMaterials(freshMaterialsScan.token, ["extras/tokens.json"], materialsOne.materialsSha256);
	const materialsTwo = (await acceptMaterials(nextMaterials.candidateSha256)).manifest;
	assert.equal((await json(`${libraryRoute}/materials`)).manifest.materialsSha256, materialsTwo.materialsSha256);
	assert.equal((await json(`${libraryRoute}/materials?version=${materialsOne.materialsSha256}`)).manifest.materialsSha256, materialsOne.materialsSha256, "room reference metadata stays on its approved version after an import");
	await json(`${libraryRoute}/materials?version=../current`, undefined, "GET", 400);
	await json(`${libraryRoute}/materials?version=${materialsOne.materialsSha256}&version=${materialsTwo.materialsSha256}`, undefined, "GET", 400);
	const pointerAfterAccept = fs.readFileSync(materialPointer);
	await acceptMaterials(racingMaterials.candidateSha256, 409);
	assert.deepEqual(fs.readFileSync(materialPointer), pointerAfterAccept, "stale material CAS preserves the accepted pointer");
	assert.equal((await json(roomRoute)).sources[0].status, "review-required");
	const gitDirectory = path.join(fixtureRepo, ".git");
	const unavailableGitDirectory = path.join(fixtureRepo, ".git-fixture-offline");
	fs.renameSync(gitDirectory, unavailableGitDirectory);
	try {
		assert((await sourceTurn(roomA, libraryId, "extras/guide.md")).includes("V1"), "the real room tool reads its approved older version without an available Git repository");
	} finally { fs.renameSync(unavailableGitDirectory, gitDirectory); }
	const beforeStaleSource = fs.readFileSync(roomSettingsFile);
	await json(roomRoute, sourceConsent(sourceReviewOne), "PUT", 409);
	assert.deepEqual(fs.readFileSync(roomSettingsFile), beforeStaleSource, "stale grouped review writes nothing");
	const oldGuidePath = path.join(appRoot, "skill-library-materials", libraryId, "versions", materialsOne.materialsSha256, "files", "extras", "guide.md");
	const oldGuideBytes = fs.readFileSync(oldGuidePath);
	fs.writeFileSync(oldGuidePath, "Unreviewed changed material.\n");
	assert((await sourceTurn(roomA, libraryId, "extras/guide.md")).includes("changed"), "the real tool refuses altered pinned bytes");
	fs.writeFileSync(oldGuidePath, oldGuideBytes);
	const sourceReviewTwo = await json(sourceReviewRoute);
	assert.equal(sourceReviewTwo.materialsSha256, materialsTwo.materialsSha256);
	const notices = await json("/api/skills/update-notices");
	assert(notices.libraries.find((entry: any) => entry.id === libraryId).rooms.some((room: any) => room.id === roomA && room.reviewRequired), "notices expose stale room material pins");
	await json(`/api/persistent-agents/${roomB}/skill-settings`, { ...sourceConsent(sourceReviewTwo), materialsSha256: materialsOne.materialsSha256 }, "PUT", 409);
	const roomBFile = persistentRoomSkillSettingsPath(roomB, { persistentAgentsRoot: agentsRoot });
	const roomBState = JSON.parse(fs.readFileSync(roomBFile, "utf8"));
	fs.writeFileSync(roomBFile, JSON.stringify({ ...roomBState, enabledSources: [{ ...sourceConsent(sourceReviewOne), excludedSkills: ["brand-a"] }] }));
	const bulkReview = await json(`${libraryRoute}/rooms/review`);
	assert(bulkReview.rooms.some((room: any) => room.id === roomA));
	assert(bulkReview.rooms.some((room: any) => room.id === roomB));
	assert.deepEqual(bulkReview.rooms.find((room: any) => room.id === roomA).changes.references.map((file: any) => [file.path, file.status]), [["extras/guide.md", "changed"]], "room review lists concrete changes against its approved source version");
	assert.equal(bulkReview.rooms.find((room: any) => room.id === roomA).changes.total, 1);
	await json(`${libraryRoute}/rooms/apply`, { reviewSha256: bulkReview.reviewSha256, roomIds: [roomA, "not-reviewed-room"] }, "POST", 409);
	assert.deepEqual(fs.readFileSync(roomSettingsFile), beforeStaleSource, "unreviewed targets prevent every room write");
	const bulkApplied = await json(`${libraryRoute}/rooms/apply`, { reviewSha256: bulkReview.reviewSha256, roomIds: [roomA, roomB] });
	assert.deepEqual(new Set(bulkApplied.updated), new Set([roomA, roomB]));
	assert.deepEqual(bulkApplied.failures, []);
	const roomBAfterBulk = await json(`/api/persistent-agents/${roomB}/skill-settings`);
	assert.deepEqual(roomBAfterBulk.settings.enabledSources[0].excludedSkills, ["brand-a"]);
	assert(roomBAfterBulk.settings.enabledSkills.some((skill: any) => skill.name === "brand-b"), "bulk source updates preserve independent assignments");
	assert.equal((await json(`${libraryRoute}/rooms/review`)).rooms.length, 0, "successful room update clears its notice immediately");
	assert((await sourceTurn(roomA, libraryId, "extras/guide.md")).includes("V2"));
	const brandBManifest = path.join(agentDir, "skills", "brand-b", "SKILL.md");
	const brandBBytes = fs.readFileSync(brandBManifest);
	const beforeChangedSkill = fs.readFileSync(roomSettingsFile);
	fs.writeFileSync(brandBManifest, "---\nname: brand-b\n---\nUnreviewed local alteration.\n");
	await json(roomRoute, sourceConsent(sourceReviewTwo), "PUT", 409);
	assert.deepEqual(fs.readFileSync(roomSettingsFile), beforeChangedSkill, "a changed source skill cannot partly replace grouped consent");
	fs.writeFileSync(brandBManifest, brandBBytes);
	const sourceOff = await json(roomRoute, { action: "disable-source", libraryId }, "PUT");
	assert.equal(sourceOff.settings.enabledSources.length, 0);
	assert(sourceOff.settings.enabledSkills.some((skill: any) => skill.name === "brand-a"));
	assert((await turn(roomA)).includes("#123456"), "source revocation preserves independent skill access");
	assert((await sourceTurn(roomA, libraryId, "extras/guide.md")).includes("not enabled"), "source revocation reaches the actual runtime tool");
	assert.equal((await json(`${libraryRoute}/materials`)).manifest.materialsSha256, materialsTwo.materialsSha256, "revocation preserves saved local materials");
	const check = async () => json(`${libraryRoute}/check`, {});
	const legacyDetail = await json("/api/skills/transient-brand");
	await json(roomRoute, { action: "enable", name: "transient-brand", sha256: legacyDetail.sha256, packageSha256: legacyDetail.packageSha256 }, "PUT");
	const legacyRoomSettings = (await json(roomRoute)).settings;
	write("skills/transient-brand/SKILL.md", "---\nname: transient-brand\ndescription: Updated direct import\n---\nReviewed upstream instructions changed.\n"); commit("change direct import instructions");
	const legacyStatus = (await check()).updates.find((item: any) => item.name === "transient-brand");
	assert.equal(legacyStatus.status, "changed", "an unbound exact-source/ref import is an installed update, not a new skill");
	assert(legacyStatus.changes.some((change: any) => change.path === "[repository library]"), "adopting library ownership is visible in the review");
	const legacyUpdate = await json(`${libraryRoute}/updates/transient-brand/candidate`, {});
	assert.equal((await json("/api/skills/transient-brand")).provenance.repo.libraryId, undefined, "check and preparation never bind a direct import");
	assert.deepEqual((await json(roomRoute)).settings, legacyRoomSettings, "checking does not alter room consent");
	await json(`${libraryRoute}/updates/transient-brand/apply`, { token: legacyUpdate.token, path: legacyUpdate.skillPath, references: [], reviewSha256: legacyUpdate.reviewSha256, localPackageSha256: legacyUpdate.localPackageSha256 });
	assert.equal((await json("/api/skills/transient-brand")).provenance.repo.libraryId, libraryId, "only reviewed apply binds the existing copy");
	assert.deepEqual((await json(roomRoute)).settings, legacyRoomSettings, "adoption never advances room consent");
	assert.equal((await json(roomRoute)).skills.find((item: any) => item.name === "transient-brand").status, "hash-mismatch");
	const otherLibrary = (await json("/api/skills/libraries", { ...libraryInput, name: "Separate library identity" }, "POST", 201)).library;
	await json(`/api/skills/libraries/${otherLibrary.id}/updates/transient-brand/candidate`, {}, "POST", 400);
	await json(`/api/skills/libraries/${otherLibrary.id}`, undefined, "DELETE");
	assert.equal((await check()).updates.find((item: any) => item.name === "brand-a").status, "unchanged");
	write("unrelated/README.md", "Unrelated new commit.\n"); commit("unrelated content");
	assert.equal((await check()).updates.find((item: any) => item.name === "brand-a").status, "unchanged");
	const noopScan = await json(`${libraryRoute}/scan`, { forceRefresh: true });
	const noopReview = await json(`${libraryRoute}/updates/brand-a/candidate`, { token: noopScan.token });
	const noopApplied = await json(`${libraryRoute}/updates/brand-a/apply`, { token: noopReview.token, path: noopReview.skillPath, references: noopReview.references.map((reference: any) => reference.path), reviewSha256: noopReview.reviewSha256, localPackageSha256: noopReview.localPackageSha256 });
	assert.equal(noopApplied.unchanged, true, "accepting unchanged content preserves existing room package pins");
	assert.equal((await json(roomRoute)).skills.find((item: any) => item.name === "brand-a").status, "ok");
	write("brands/a/colors.css", ":root { --primary: #abcdef; }\n"); commit("selected CSS changed");
	assert.equal((await check()).updates.find((item: any) => item.name === "brand-a").status, "changed");
	const updateRoute = `${libraryRoute}/updates/brand-a`;
	const update = await json(`${updateRoute}/candidate`, {});
	assert(update.changes.some((change: any) => change.path === "brands/a/colors.css" && change.status === "modified"));
	assert(update.affectedRooms.some((room: any) => room.id === roomA || room.agentId === roomA));
	const apply = (review: any, refs = selected) => json(`${updateRoute}/apply`, { token: review.token, path: "skills/brand-a", references: refs, reviewSha256: review.reviewSha256, localPackageSha256: review.localPackageSha256 });
	await apply(update);
	assert.equal((await json(roomRoute)).skills.find((item: any) => item.name === "brand-a").status, "hash-mismatch");
	assert((await turn(roomA)).includes("re-review"), "updated bytes are withheld until this room reviews them");
	await json(roomRoute, { action: "enable", name: "brand-a", sha256: originalDetail.sha256, packageSha256: originalDetail.packageSha256 }, "PUT", 409);
	const updatedDetail = await json("/api/skills/brand-a");
	assert.equal(updatedDetail.locallyModified, false);
	await json(roomRoute, { action: "enable", name: "brand-a", sha256: updatedDetail.sha256, packageSha256: updatedDetail.packageSha256 }, "PUT");
	assert((await turn(roomA)).includes("#abcdef"));
	const cssFile = path.join(installedDir, ".skill-references", "brands", "a", "colors.css");
	fs.writeFileSync(cssFile, "Local user edit preserved.\n");
	assert.equal((await json("/api/skills")).find((skill: any) => skill.name === "brand-a").locallyModified, true, "reference edits classify the local copy as custom");
	assert.equal((await check()).updates.find((item: any) => item.name === "brand-a").status, "local-conflict");
	await json(`${updateRoute}/apply`, { token: update.token, path: "skills/brand-a", references: selected, reviewSha256: update.reviewSha256, localPackageSha256: update.localPackageSha256 }, "POST", 409);
	assert.equal(fs.readFileSync(cssFile, "utf8"), "Local user edit preserved.\n");
	fs.writeFileSync(cssFile, ":root { --primary: #abcdef; }\n");
	assert.equal((await json("/api/skills/brand-a")).locallyModified, false, "restoring the reviewed bytes restores repository classification");
	const installedManifest = path.join(installedDir, "SKILL.md");
	const previousManifest = fs.readFileSync(installedManifest);
	const previousBaseline = JSON.parse(fs.readFileSync(path.join(installedDir, "provenance.json"), "utf8"));
	await json("/api/skills/brand-a", { id: "brand-a", displayName: "Brand A locally edited", description: updatedDetail.description, instructions: "Local UI editor changes must never be overwritten." }, "PUT");
	const editedView = await json("/api/skills/brand-a");
	assert.equal(editedView.locallyModified, true);
	assert.equal(editedView.provenance.source, previousBaseline.source, "custom classification preserves original provenance");
	assert.equal(JSON.parse(fs.readFileSync(path.join(installedDir, "provenance.json"), "utf8")).filesSha256, previousBaseline.filesSha256, "UI editing must retain the original import baseline");
	assert.equal((await check()).updates.find((item: any) => item.name === "brand-a").status, "local-conflict", "UI edits are conflicts just like direct file edits");
	await json(`${updateRoute}/apply`, { token: update.token, path: "skills/brand-a", references: selected, reviewSha256: update.reviewSha256, localPackageSha256: update.localPackageSha256 }, "POST", 409);
	assert(fs.readFileSync(installedManifest, "utf8").includes("Local UI editor changes"));
	fs.writeFileSync(installedManifest, previousManifest);
	fs.unlinkSync(path.join(fixtureRepo, "brands", "a", "guide.pdf"));
	write("brands/a/new.scss", "$primary: #abcdef;\n"); commit("remove selected PDF and add unselected SCSS");
	assert.equal((await check()).updates.find((item: any) => item.name === "brand-a").status, "changed");
	const revisedSelection = [...selected.filter((item) => item !== "brands/a/guide.pdf"), "brands/a/new.scss"];
	const adjusted = await json(`${updateRoute}/candidate`, { references: revisedSelection });
	assert(adjusted.changes.some((change: any) => change.path.endsWith("guide.pdf") && change.status === "removed"));
	assert(adjusted.changes.some((change: any) => change.path.endsWith("new.scss") && change.status === "added"));
	await apply(adjusted, revisedSelection);
	assert(!fs.existsSync(path.join(installedDir, ".skill-references", "brands", "a", "guide.pdf")));
	assert(fs.existsSync(path.join(installedDir, ".skill-references", "brands", "a", "new.scss")));

	// Manual/local and ZIP packages retain their existing separate execution approval.
	await json("/api/skills", { id: "local-synthetic", displayName: "Local synthetic", description: "Local instructions", instructions: "Synthetic local guidance." }, "POST", 201);
	await json(roomRoute, { action: "enable", name: "local-synthetic" }, "PUT");
	const archive = new JSZip();
	archive.file("zip-synthetic/SKILL.md", "---\nname: zip-synthetic\ndescription: Uploaded script fixture\n---\nRun an explicitly approved synthetic helper.\n");
	archive.file("zip-synthetic/scripts/helper.py", "print('synthetic only')\n");
	const upload = await json("/api/skills/upload", { filename: "synthetic.zip", contentBase64: (await archive.generateAsync({ type: "nodebuffer" })).toString("base64") });
	await json("/api/skills/accept", { ...upload, displayName: upload.name, instructions: upload.body }, "POST", 201);
	await json(roomRoute, { action: "enable", name: "zip-synthetic" }, "PUT");
	const allowed = await json(roomRoute, { action: "approve-execution", name: "zip-synthetic" }, "PUT");
	assert.equal(allowed.skills.find((item: any) => item.name === "zip-synthetic").executeState, "approved");
	const broken = await json("/api/skills/libraries", { name: "Broken synthetic source", source: badRepo }, "POST", 201);
	// Local paths are test-only sources; seed the explicitly opted-in persisted state before restart.
	const startupConfiguration = path.join(appRoot, "skill-libraries.json");
	const startupRecords = JSON.parse(fs.readFileSync(startupConfiguration, "utf8"));
	for (const record of startupRecords) if (record.id === broken.library.id || record.id === libraryId) record.repositoryAccess = startupAccess;
	fs.writeFileSync(startupConfiguration, JSON.stringify(startupRecords));
	await stopSmokeServer(server); server = undefined;
	await start();
	for (const route of ["/api/skills/repo/candidate", "/api/skills/repo/reference", "/api/skills/repo/import"]) {
		const expired = await json(route, { token: scan.token, path: "skills/brand-a", reference: "brands/a/colors.css", references: selected, reviewSha256: candidate.reviewSha256 }, "POST", 404);
		assert.equal(expired.code, "REPOSITORY_SNAPSHOT_EXPIRED", "lost server snapshots have a recoverable error code, not an auth failure");
	}
	const currentPackage = await json("/api/skills/brand-a");
	const expiredUpdate = await json(`${updateRoute}/apply`, { token: adjusted.token, path: "skills/brand-a", references: revisedSelection, reviewSha256: adjusted.reviewSha256, localPackageSha256: currentPackage.packageSha256 }, "POST", 404);
	assert.equal(expiredUpdate.code, "REPOSITORY_SNAPSHOT_EXPIRED");
	const startupLibraries = await until(() => json("/api/skills/libraries"), (result) => result.libraries.every((item: any) => item.lastCheckedAt && item.status !== "checking" && item.status !== "unchecked"), "startup checks for persisted libraries");
	assert.equal(startupLibraries.libraries.find((item: any) => item.id === broken.library.id).status, "error");
	assert.notEqual(startupLibraries.libraries.find((item: any) => item.id === libraryId).status, "error", "one failing source must not block a healthy source");
	assert.equal(startupLibraries.libraries.find((item: any) => item.id === libraryId).name, "Renamed synthetic brands");
	await json(libraryRoute, undefined, "DELETE");
	assert(fs.existsSync(path.join(installedDir, "SKILL.md")), "deleting a library preserves its installed skills");
	const retainedDetail = await json("/api/skills/brand-a");
	await json(roomRoute, { action: "enable", name: "brand-a", sha256: retainedDetail.sha256, packageSha256: retainedDetail.packageSha256 }, "PUT");
	assert((await turn(roomA)).includes("#abcdef"));
	const configuration = path.join(appRoot, "skill-libraries.json");
	fs.writeFileSync(configuration, "{broken JSON");
	await json("/api/skills/libraries", { name: "Must preserve corrupt config", source: fixtureRepo }, "POST", 400);
	assert.equal(fs.readFileSync(configuration, "utf8"), "{broken JSON");
	console.log("skills-libraries-api-smoke: OK");
} catch (error) {
	console.error(output.slice(-6000));
	throw error;
} finally {
	await stopSmokeServer(server);
	await new Promise<void>((resolve) => gateway.close(() => resolve()));
	assert.equal(path.dirname(temporaryRoot), path.resolve(os.tmpdir()));
	assert(path.basename(temporaryRoot).startsWith("exxperts-skill-libraries-api-"));
	fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
