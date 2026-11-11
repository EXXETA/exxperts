// A Markdown file opened from the workspace tree shows the images it links, and
// saving an edit leaves their Markdown as written. A file dragged from the tree
// onto the composer inserts its path.
// Offline: the room's model is never asked. Throwaway HOME.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort, type AuthedFetchInit } from "./smoke-server-process.js";
import { pairDevice, remoteRequest } from "./smoke-pairing.js";
import { waitEvery } from "./smoke-wait.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("workspace markdown images ui smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-markdown-images-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

const folder = path.join(tempHome, "Projects", "handbook");
fs.mkdirSync(path.join(folder, "docs", "img"), { recursive: true });
const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==", "base64");
fs.writeFileSync(path.join(folder, "docs", "img", "pixel.png"), ONE_PIXEL_PNG);
fs.writeFileSync(path.join(folder, "top pixel.png"), ONE_PIXEL_PNG);
fs.writeFileSync(path.join(folder, "file2.txt"), "two");
fs.writeFileSync(path.join(folder, "file10.txt"), "ten");
fs.writeFileSync(path.join(folder, ".hidden"), "hidden");
fs.writeFileSync(path.join(folder, "demo.pem"), "hidden");
fs.mkdirSync(path.join(folder, "Library", "LaunchAgents"), { recursive: true });
fs.writeFileSync(path.join(folder, "Library", "LaunchAgents", "example.md"), "protected");
fs.mkdirSync(path.join(folder, "node_modules", "hidden"), { recursive: true });
fs.writeFileSync(path.join(folder, "node_modules", "hidden", "secret.md"), "hidden");
fs.symlinkSync(path.join(folder, "docs"), path.join(folder, "shortcut"));
fs.symlinkSync(path.join(folder, "docs", "guide.md"), path.join(folder, "symlink.md"));
fs.symlinkSync(path.join(folder, "docs", "img", "pixel.png"), path.join(folder, "symlink.png"));
const outside = path.join(tempHome, "outside");
fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, "outside.md"), "outside secret");
fs.writeFileSync(path.join(outside, "outside.png"), ONE_PIXEL_PNG);
fs.symlinkSync(outside, path.join(folder, "outside-link"));
fs.symlinkSync(path.join(outside, "outside.md"), path.join(folder, "outside.md"));
fs.symlinkSync(path.join(outside, "outside.png"), path.join(folder, "outside.png"));
fs.writeFileSync(path.join(folder, "docs", "other.md"), "# Other\n");
fs.writeFileSync(path.join(folder, "docs", "third.md"), "# Third\n");
const guide = path.join(folder, "docs", "guide.md");
const IMAGE_LINES = ["![near](img/pixel.png \"Near\")", "![above](<../top pixel.png>)", "[![badge](img/pixel.png)](https://example.invalid)", "[text ![mixed](img/pixel.png)](https://example.invalid)", "![encoded](../top%20pixel.png)", "![missing alt](img/missing.png)", "![blocked alt](../node_modules/hidden/secret.png)", "![remote alt](https://images.invalid/remote.png)", "![relative alt](//images.invalid/relative.png)"];
fs.writeFileSync(guide, `# Guide\n\nFirst line\n\nFind here and find here\n\n${IMAGE_LINES.join("\n\n")}\n`);

// A provider at an address nobody answers: the room only has to open, never answer.
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
	providers: { "fake-claude": { name: "Fake Claude", baseUrl: "http://127.0.0.1:9", api: "anthropic-messages", models: [{ id: "claude-fake", name: "Claude Fake", input: ["text"], contextWindow: 200000, maxTokens: 32000 }] } },
}, null, 2), { mode: 0o600 });
fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "fake-claude": { type: "api_key", key: "synthetic-claude" } }, null, 2), { mode: 0o600 });
fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [
	{ id: "custom-fake-claude", providerId: "fake-claude", label: "Fake Claude", roomModels: ["claude-fake"], learnModel: "claude-fake", reviewMemoryModel: "claude-fake" },
] }, null, 2), { mode: 0o600 });
fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "custom-fake-claude" }, null, 2), { mode: 0o600 });

const waitUntil = waitEvery(150, 15_000);

async function api(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
try {
	server = spawn(process.execPath, ["bin/exxperts-web.cjs", "--port", String(port), "--no-open"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: repoRoot,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot, EXXPERTS_REMOTE_TEST_ADDRESS: "::1" }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready", 60_000);

	const created = await api("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: "Handbook", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	assert(created.status === 201, `the room is created, got ${created.status}`);
	const agentId = String(created.body?.agent?.id ?? "");
	const noFolder = await api(`/api/persistent-agents/${encodeURIComponent(agentId)}/workspace-files?conversationId=empty-room`);
	assert(noFolder.status === 200 && noFolder.body.root === null && noFolder.body.path === "" && noFolder.body.entries.length === 0, "no workspace has an empty root response");
	const saved = await api(`/api/persistent-agents/${encodeURIComponent(agentId)}/workspace-default`, { method: "PUT", body: JSON.stringify({ root: folder, workspaceAccessMode: "localFiles" }) });
	assert(saved.status === 200, `the folder is saved, got ${saved.status} ${JSON.stringify(saved.body)}`);

	const remoteEnabled = await api("/api/remote/enable", { method: "POST" });
	assert(remoteEnabled.status === 200, "mock remote listener enabled");
	const exposed = await api("/api/remote/rooms/exposure", { method: "POST", body: JSON.stringify({ id: agentId, exposed: true }) });
	assert(exposed.status === 200, "demo room exposed to mock devices");
	const devices = [await pairDevice(port, "Demo reader", "read-only"), await pairDevice(port, "Demo writer", "full")];
	const matrixQuery = (route: string, file: string) => `/api/persistent-agents/${encodeURIComponent(agentId)}/${route}?${new URLSearchParams({ conversationId: "matrix-test", path: file })}`;
	const originalContent = fs.readFileSync(guide, "utf8");
	for (const [tools, canList, canRead, canWrite, bash] of [
		[[], false, false, false, true],
		[[], false, false, false, false],
		[["ls"], true, false, false],
		[["read"], false, true, false],
		[["write"], false, false, false],
		[["read", "write"], false, true, true],
	] as const) {
		const configured = await api(`/api/persistent-agents/${encodeURIComponent(agentId)}/workspace-default`, { method: "PUT", body: JSON.stringify({ toolSelection: { kind: "custom", allowedToolNames: tools }, bashEnabled: bash === true }) });
		assert(configured.status === 200, `configure matrix tools ${tools}`);
		const listing = await api(matrixQuery("workspace-files", ""));
		assert(listing.status === 200 && Boolean(listing.body.root) === canList, `tree permission for ${tools}`);
		const markdown = await api(matrixQuery("workspace-markdown", "docs/guide.md"));
		assert((markdown.status === 200) === canRead, `Markdown read permission for ${tools}`);
		const image = await authedFetch(`${baseUrl}${matrixQuery("workspace-image", "docs/img/pixel.png")}`);
		assert((image.status === 200) === canRead, `image read permission for ${tools}`);
		const revision = `sha256:${(await import("node:crypto")).createHash("sha256").update(originalContent).digest("hex")}`;
		const put = await api(matrixQuery("workspace-markdown", "docs/guide.md"), { method: "PUT", body: JSON.stringify({ content: originalContent, revision }) });
		assert((put.status === 200) === canWrite, `Markdown write permission for ${tools}`);
		assert(fs.readFileSync(guide, "utf8") === originalContent, `matrix preserves content for ${tools}`);
		for (const [index, device] of devices.entries()) {
			const headers = { Cookie: device.cookie };
			const remoteTree = await remoteRequest(port, matrixQuery("workspace-files", ""), { headers });
			assert(remoteTree.status === 200 && Boolean(JSON.parse(remoteTree.body).root) === canList, `device ${index} tree permission for ${tools}`);
			const remoteMarkdown = await remoteRequest(port, matrixQuery("workspace-markdown", "docs/guide.md"), { headers });
			assert((remoteMarkdown.status === 200) === canRead, `device ${index} Markdown permission for ${tools}`);
			const remoteImage = await remoteRequest(port, matrixQuery("workspace-image", "docs/img/pixel.png"), { headers });
			assert((remoteImage.status === 200) === canRead, `device ${index} image permission for ${tools}`);
			const remoteWrite = await remoteRequest(port, matrixQuery("workspace-markdown", "docs/guide.md"), { method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ content: originalContent, revision }) });
			assert((remoteWrite.status === 200) === (index === 1 && canWrite), `device ${index} write permission for ${tools}`);
			assert(fs.readFileSync(guide, "utf8") === originalContent, `device ${index} preserves content for ${tools}`);
		}
	}
	const restored = await api(`/api/persistent-agents/${encodeURIComponent(agentId)}/workspace-default`, { method: "PUT", body: JSON.stringify({ toolSelection: { kind: "standard" } }) });
	assert(restored.status === 200, "restore standard tools");

	const policyPath = path.join(agentsRoot, agentId, "runtime", "workspace-default.json");
	const storedPolicy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
	storedPolicy.modes.write = false;
	fs.writeFileSync(policyPath, JSON.stringify(storedPolicy));
	const inconsistentRevision = `sha256:${(await import("node:crypto")).createHash("sha256").update(originalContent).digest("hex")}`;
	const normalizedWrite = await api(matrixQuery("workspace-markdown", "docs/guide.md"), { method: "PUT", body: JSON.stringify({ content: originalContent, revision: inconsistentRevision }) });
	assert(normalizedWrite.status === 200, "selected writer enables writes despite a stale stored flag");
	for (const [index, device] of devices.entries()) {
		const response = await remoteRequest(port, matrixQuery("workspace-markdown", "docs/guide.md"), { method: "PUT", headers: { Cookie: device.cookie, "content-type": "application/json" }, body: JSON.stringify({ content: originalContent, revision: inconsistentRevision }) });
		assert((response.status === 200) === (index === 1), "normalized writer still respects the paired device capability");
	}
	assert(fs.readFileSync(guide, "utf8") === originalContent, "normalization test preserves file contents");
	storedPolicy.modes.read = false;
	fs.writeFileSync(policyPath, JSON.stringify(storedPolicy));
	const disabledTree = await api(matrixQuery("workspace-files", ""));
	assert(disabledTree.status === 200 && disabledTree.body.root === null, "disabled read mode hides the tree");
	for (const route of ["workspace-markdown", "workspace-image"]) {
		const file = route === "workspace-image" ? "docs/img/pixel.png" : "docs/guide.md";
		const local = await authedFetch(`${baseUrl}${matrixQuery(route, file)}`);
		assert(local.status !== 200, `disabled read mode denies local ${route}`);
		for (const device of devices) {
			const remote = await remoteRequest(port, matrixQuery(route, file), { headers: { Cookie: device.cookie } });
			assert(remote.status !== 200 && !remote.body.includes(originalContent), `disabled read mode denies paired ${route}`);
		}
	}
	const disabledPut = await api(matrixQuery("workspace-markdown", "docs/guide.md"), { method: "PUT", body: JSON.stringify({ content: "overwrite", revision: inconsistentRevision }) });
	assert(disabledPut.status !== 200 && fs.readFileSync(guide, "utf8") === originalContent, "disabled read mode denies writes");
	for (const device of devices) {
		const remoteTree = await remoteRequest(port, matrixQuery("workspace-files", ""), { headers: { Cookie: device.cookie } });
		assert(remoteTree.status === 200 && JSON.parse(remoteTree.body).root === null, "disabled read mode hides tree from paired devices");
		const remotePut = await remoteRequest(port, matrixQuery("workspace-markdown", "docs/guide.md"), { method: "PUT", headers: { Cookie: device.cookie, "content-type": "application/json" }, body: JSON.stringify({ content: "overwrite", revision: inconsistentRevision }) });
		assert(remotePut.status !== 200 && fs.readFileSync(guide, "utf8") === originalContent, "disabled read mode denies paired writes");
	}
	storedPolicy.modes.read = true;
	fs.writeFileSync(policyPath, JSON.stringify(storedPolicy));

	const alias = path.join(tempHome, "workspace-alias");
	const other = path.join(tempHome, "workspace-other");
	fs.mkdirSync(other);
	fs.symlinkSync(folder, alias);
	const aliasGrant = await api(`/api/persistent-agents/${encodeURIComponent(agentId)}/workspace-default`, { method: "PUT", body: JSON.stringify({ root: alias, workspaceAccessMode: "localFiles" }) });
	assert(aliasGrant.status === 200, "grant alias root");
	fs.unlinkSync(alias);
	fs.symlinkSync(other, alias);
	const aliasTree = await api(matrixQuery("workspace-files", ""));
	assert(aliasTree.status !== 200 || aliasTree.body.root === null, "retargeted grant must not list the old root");
	const aliasRead = await api(matrixQuery("workspace-markdown", "docs/guide.md"));
	assert(aliasRead.status !== 200, "retargeted grant must not read the old root");
	const aliasImage = await authedFetch(`${baseUrl}${matrixQuery("workspace-image", "docs/img/pixel.png")}`);
	assert(aliasImage.status !== 200, "retargeted grant must not read images");
	const aliasWrite = await api(matrixQuery("workspace-markdown", "docs/guide.md"), { method: "PUT", body: JSON.stringify({ content: "overwrite", revision: `sha256:${(await import("node:crypto")).createHash("sha256").update(originalContent).digest("hex")}` }) });
	assert(aliasWrite.status !== 200 && fs.readFileSync(guide, "utf8") === originalContent, "retargeted grant must not write the old root");
	for (const device of devices) {
		for (const [route, file] of [["workspace-files", ""], ["workspace-markdown", "docs/guide.md"], ["workspace-image", "docs/img/pixel.png"]]) {
			const response = await remoteRequest(port, matrixQuery(route, file), { headers: { Cookie: device.cookie } });
			assert(response.status !== 200 || (route === "workspace-files" && JSON.parse(response.body).root === null), "device cannot read retargeted grant");
			assert(!response.body.includes(folder) && !response.body.includes(originalContent), "device response hides workspace path and content");
		}
	}
	const resetGrant = await api(`/api/persistent-agents/${encodeURIComponent(agentId)}/workspace-default`, { method: "PUT", body: JSON.stringify({ root: folder, workspaceAccessMode: "localFiles" }) });
	assert(resetGrant.status === 200, "restore workspace root");

	const rootListing = await api(matrixQuery("workspace-files", ""));
	assert(rootListing.status === 200 && rootListing.body.root.basename === "handbook" && rootListing.body.path === "", "tree root shape");
	assert(rootListing.body.entries.every((entry: any) => !["node_modules", "shortcut", ".hidden", "demo.pem"].includes(entry.name)), "tree hides denied entries, dotfiles and symlinks");
	const listedNames = rootListing.body.entries.map((entry: any) => entry.name);
	assert(listedNames.indexOf("file2.txt") < listedNames.indexOf("file10.txt"), "tree uses numeric sorting");
	assert(rootListing.body.entries.every((entry: any, index: number, all: any[]) => (entry.kind !== "directory" || all.slice(0, index).every((previous) => previous.kind === "directory")) && typeof entry.relativePath === "string" && typeof entry.modifiedAt === "string" && typeof entry.extension === "string" && (entry.kind === "directory" ? entry.bytes === null && entry.extension === "" : typeof entry.bytes === "number")), "tree entry fields and directory ordering");
	fs.mkdirSync(path.join(folder, "empty"));
	const emptyListing = await api(matrixQuery("workspace-files", "empty"));
	assert(emptyListing.status === 200 && emptyListing.body.entries.length === 0, "empty directory");
	assert((await api(matrixQuery("workspace-files", "../other"))).status === 400, "tree rejects traversal");
	const routeRead = await api(matrixQuery("workspace-markdown", "docs/guide.md"));
	assert(routeRead.status === 200 && routeRead.body.content === originalContent && routeRead.body.encoding === "utf-8" && routeRead.body.bytes === Buffer.byteLength(originalContent) && /^sha256:[a-f0-9]{64}$/.test(routeRead.body.revision) && routeRead.body.readOnly === false, "Markdown response fields");
	for (const [file, expected] of [["../guide.md", 400], ["docs/guide.txt", 400], ["docs/missing.md", 404]] as const) {
		assert((await api(matrixQuery("workspace-markdown", file))).status === expected, `Markdown invalid ${file}`);
	}
	for (const [name, bytes, expected] of [["limit.md", Buffer.alloc(128 * 1024, 65), 200], ["big.md", Buffer.alloc(128 * 1024 + 1, 65), 413], ["binary.md", Buffer.from([65, 0]), 415], ["invalid.md", Buffer.from([255]), 415]] as const) {
		fs.writeFileSync(path.join(folder, name), bytes);
		assert((await api(matrixQuery("workspace-markdown", name))).status === expected, `Markdown validation ${name}`);
	}
	for (const body of [{ content: 3, revision: routeRead.body.revision }, { content: "ok", revision: "bad" }]) {
		assert((await api(matrixQuery("workspace-markdown", "docs/guide.md"), { method: "PUT", body: JSON.stringify(body) })).status === 400, "invalid write body");
	}
	const limitRead = await api(matrixQuery("workspace-markdown", "limit.md"));
	for (const [content, expected] of [["a".repeat(128 * 1024), 200], ["a".repeat(128 * 1024 + 1), 413], ["binary\0text", 415]] as const) {
		const response = await api(matrixQuery("workspace-markdown", "limit.md"), { method: "PUT", body: JSON.stringify({ content, revision: limitRead.body.revision }) });
		assert(response.status === expected, `Markdown PUT boundary: ${expected}`);
	}
	const missingWrite = await api(matrixQuery("workspace-markdown", "docs/missing.md"), { method: "PUT", body: JSON.stringify({ content: "new", revision: routeRead.body.revision }) });
	assert(missingWrite.status === 404 && !fs.existsSync(path.join(folder, "docs", "missing.md")), "PUT does not create a file");
	const changed = await api(matrixQuery("workspace-markdown", "docs/guide.md"), { method: "PUT", body: JSON.stringify({ content: originalContent + "change", revision: routeRead.body.revision }) });
	assert(changed.status === 200 && changed.body.content === originalContent + "change" && changed.body.revision !== routeRead.body.revision, "PUT returns replacement and revision");
	const stale = await api(matrixQuery("workspace-markdown", "docs/guide.md"), { method: "PUT", body: JSON.stringify({ content: "stale", revision: routeRead.body.revision }) });
	assert(stale.status === 409 && stale.body.currentRevision === changed.body.revision && fs.readFileSync(guide, "utf8") === originalContent + "change", "stale PUT retains current bytes and revision");
	assert((await api(matrixQuery("workspace-markdown", "docs/guide.md"), { method: "PUT", body: JSON.stringify({ content: originalContent, revision: changed.body.revision }) })).status === 200, "restore demo content");
	for (const [extension, type] of [["png", "image/png"], ["jpg", "image/jpeg"], ["jpeg", "image/jpeg"], ["gif", "image/gif"], ["webp", "image/webp"], ["svg", "image/svg+xml"]]) {
		fs.writeFileSync(path.join(folder, `demo.${extension}`), ONE_PIXEL_PNG);
		const response = await authedFetch(`${baseUrl}${matrixQuery("workspace-image", `demo.${extension}`)}`);
		assert(response.status === 200 && response.headers.get("content-type")?.startsWith(type), `image content type ${extension}`);
		assert(response.headers.get("content-security-policy") === "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:" && response.headers.get("x-content-type-options") === "nosniff" && response.headers.get("referrer-policy") === "no-referrer" && response.headers.get("cache-control") === "no-store", "image security headers");
	}
	for (const [route, file] of [["workspace-markdown", "symlink.md"], ["workspace-markdown", "shortcut/guide.md"], ["workspace-image", "symlink.png"], ["workspace-image", "shortcut/img/pixel.png"], ["workspace-markdown", "outside.md"], ["workspace-markdown", "outside-link/outside.md"], ["workspace-image", "outside.png"], ["workspace-image", "outside-link/outside.png"]]) {
		const local = await authedFetch(`${baseUrl}${matrixQuery(route, file)}`);
		assert(local.status !== 200, `symlink refused: ${file}`);
		for (const device of devices) {
			const remote = await remoteRequest(port, matrixQuery(route, file), { headers: { Cookie: device.cookie } });
			assert(remote.status !== 200 && !remote.body.includes(folder), `paired symlink refused: ${file}`);
		}
	}
	fs.writeFileSync(path.join(folder, "large.png"), ONE_PIXEL_PNG);
	fs.truncateSync(path.join(folder, "large.png"), 20 * 1024 * 1024);
	const boundaryImage = await authedFetch(`${baseUrl}${matrixQuery("workspace-image", "large.png")}`);
	assert(boundaryImage.status === 200 && (await boundaryImage.arrayBuffer()).byteLength === 20 * 1024 * 1024, "image size boundary accepted");
	fs.truncateSync(path.join(folder, "large.png"), 20 * 1024 * 1024 + 1);
	assert((await authedFetch(`${baseUrl}${matrixQuery("workspace-image", "large.png")}`)).status === 413, "oversized image rejected");
	for (const [file, expected] of [["../demo.png", 400], ["missing.png", 404], ["notes.txt", 400], ["node_modules/hidden/x.png", 403]] as const) {
		assert((await authedFetch(`${baseUrl}${matrixQuery("workspace-image", file)}`)).status === expected, `image validation ${file}`);
	}

	if (process.platform !== "win32") {
		const locked = path.join(folder, "locked");
		fs.mkdirSync(path.join(locked, "child"), { recursive: true });
		fs.writeFileSync(path.join(locked, "child", "secret.md"), "private");
		fs.chmodSync(locked, 0);
		const deniedTree = await api(matrixQuery("workspace-files", "locked/child"));
		const deniedFile = await api(matrixQuery("workspace-markdown", "locked/child/secret.md"));
		fs.chmodSync(locked, 0o700);
		assert(deniedTree.status === 503 && deniedFile.status === 503, "permission errors report unavailable without exposing workspace paths");
		assert(!JSON.stringify(deniedTree.body).includes(folder) && !JSON.stringify(deniedFile.body).includes(folder), "permission errors hide absolute paths");
	}
	const browser = await chromium.launch();
	try {
		const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		const page = await context.newPage();
		let treeMode: "loading" | "no-folder" | "empty" | "error" | "normal" = "loading";
		let releaseTree!: () => void;
		const treeDelay = new Promise<void>((resolve) => { releaseTree = resolve; });
		await page.route("**/workspace-files?**", async (route) => {
			if (treeMode === "loading") { await treeDelay; }
			if (treeMode === "no-folder") return route.fulfill({ json: { root: null, path: "", entries: [] } });
			if (treeMode === "empty") return route.fulfill({ json: { root: { displayLabel: "Demo", basename: "demo" }, path: "", entries: [] } });
			if (treeMode === "error") return route.fulfill({ status: 503, json: { error: "Demo unavailable" } });
			await route.continue();
		});
		let externalRequests = 0;
		await page.route("**/images.invalid/**", async (route) => { externalRequests++; await route.abort(); });
		await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await page.waitForLoadState("networkidle");
		const dismiss = page.locator(".whats-new-close");
		if (await dismiss.count()) await dismiss.click();

		const card = page.locator(".persistent-agent-card").filter({ hasText: "Handbook" });
		await card.waitFor({ timeout: 10_000 });
		await card.getByRole("button", { name: /^(Enter|Resume)$/ }).click();

		const tree = page.locator(".sidebar-workspace-files");
		await tree.getByText("Loading…").waitFor();
		treeMode = "no-folder";
		releaseTree();
		await tree.getByText("No workspace folder connected.").waitFor();
		treeMode = "empty";
		await tree.getByText("The workspace is empty.").waitFor({ timeout: 10000 });
		treeMode = "error";
		await tree.getByText("Demo unavailable").waitFor({ timeout: 10000 });
		treeMode = "normal";
		await tree.locator(".workspace-file-browser-directory", { hasText: "docs" }).click({ timeout: 15_000 });
		fs.writeFileSync(path.join(folder, "docs", "new-invented.md"), "# New\n");
		await tree.locator(".workspace-file-browser-file", { hasText: "new-invented.md" }).waitFor({ timeout: 10000 });
		await tree.locator(".workspace-file-browser-file", { hasText: "guide.md" }).click({ timeout: 15_000 });

		const tabs = page.getByRole("tablist", { name: "Open files" });
		const tab = (name: string) => tabs.getByRole("tab", { name, exact: true });
		await tab("guide.md").waitFor();
		await tree.locator(".workspace-file-browser-file", { hasText: "other.md" }).click();
		await tree.locator(".workspace-file-browser-file", { hasText: "third.md" }).click();
		assert(await tabs.getByRole("tab").count() === 3, "three Markdown files have tabs");
		await tab("other.md").click();
		await tabs.getByRole("button", { name: "Close other.md" }).click();
		await waitUntil(async () => await tab("third.md").getAttribute("aria-selected") === "true", "closing active tab selects right neighbor");
		await tabs.getByRole("button", { name: "Close third.md" }).click();
		await waitUntil(async () => await tab("guide.md").getAttribute("aria-selected") === "true", "closing last-position tab selects left neighbor");
		await tree.locator(".workspace-file-browser-file", { hasText: "other.md" }).click();
		await tab("guide.md").click();
		await tabs.getByRole("button", { name: "Close other.md" }).click();
		assert(await tab("guide.md").getAttribute("aria-selected") === "true", "closing inactive tab preserves selection");
		await tree.locator(".workspace-file-browser-file", { hasText: "other.md" }).click();
		await tab("other.md").locator("..").dragTo(tab("guide.md").locator(".."), { targetPosition: { x: 1, y: 5 } });
		assert((await tabs.getByRole("tab").allTextContents()).join(",") === "other.md,guide.md", "tab dragging reorders open files");
		await tab("guide.md").click();
		await tabs.getByRole("button", { name: "Close other.md" }).click();
		await tabs.getByRole("button", { name: "Close guide.md" }).click();
		await waitUntil(async () => !(await tabs.isVisible()), "closing last tab closes the pane");
		await tree.locator(".workspace-file-browser-file", { hasText: "guide.md" }).click();

		const images = page.locator('.markdown-editor-tiptap .ProseMirror img[alt="near"], .markdown-editor-tiptap .ProseMirror img[alt="above"]');
		await waitUntil(async () => (await images.count()) === 2, "both images are in the editor");
		await waitUntil(() => images.evaluateAll((all) => all.every((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0)), "both images have loaded");
		const imageUrl = new URL(await images.first().evaluate((img) => (img as HTMLImageElement).src));
		const sources = await images.evaluateAll((all) => all.map((img) => new URLSearchParams((img as HTMLImageElement).src.split("?")[1]).get("path")));
		assert(JSON.stringify(sources) === JSON.stringify(["docs/img/pixel.png", "top pixel.png"]), `images resolve against the file, got ${JSON.stringify(sources)}`);
		console.log("  ok  linked images show, near the file and above it");
		for (const alt of ["missing alt", "blocked alt"]) {
			const image = page.locator(`.markdown-editor-tiptap img[alt="${alt}"]`);
			await image.waitFor({ state: "visible" });
			await waitUntil(() => image.evaluate((item) => (item as HTMLImageElement).complete && (item as HTMLImageElement).naturalWidth === 0), `${alt} is shown without image bytes`);
		}
		for (const mode of ["Edit", "Preview"]) {
			await page.getByRole("button", { name: mode, exact: true }).click();
			for (const alt of ["remote alt", "relative alt"]) {
				const image = page.locator(`.markdown-editor-tiptap img[alt="${alt}"]`);
				await image.waitFor({ state: "visible" });
				assert(!(await image.getAttribute("src")), `${alt} has no loadable source in ${mode}`);
			}
		}
		assert(externalRequests === 0, `external images made ${externalRequests} requests`);
		await page.getByRole("button", { name: "RAW", exact: true }).click();
		assert(await page.getByPlaceholder("Find in file…").count() === 0, "find is absent from RAW");
		await page.getByRole("button", { name: "Edit", exact: true }).click();

		await page.getByRole("button", { name: /Find in file/ }).click();
		const find = page.getByPlaceholder("Find in file…");
		await find.fill("FIRST LINE");
		await page.getByText("1 / 1", { exact: true }).waitFor();
		await find.fill("FIND HERE");
		await page.getByText("1 / 2", { exact: true }).waitFor();
		await find.press("Enter");
		await page.getByText("2 / 2", { exact: true }).waitFor();
		await find.press("Enter");
		await page.getByText("1 / 2", { exact: true }).waitFor();
		await find.press("Shift+Enter");
		await page.getByText("2 / 2", { exact: true }).waitFor();
		await find.fill("not present in this file");
		await page.getByText("No results", { exact: true }).waitFor();
		await find.press("Escape");
		assert(await find.count() === 0 && fs.readFileSync(guide, "utf8") === originalContent, "search closes without changing file bytes");

		const anonymous = await fetch(`${baseUrl}${new URL(await images.first().evaluate((img) => (img as HTMLImageElement).src)).pathname}?conversationId=x&path=docs/img/pixel.png`);
		assert(anonymous.status === 401, `images need a session, got ${anonymous.status}`);
		console.log("  ok  images need a session");

		await page.locator(".markdown-editor-tiptap .ProseMirror p", { hasText: "First line" }).click();
		await page.keyboard.press("End");
		await page.keyboard.type(" edited");
		await page.keyboard.press("Control+s");
		await waitUntil(() => fs.readFileSync(guide, "utf8").includes("First line edited"), "the edit is saved");
		const written = fs.readFileSync(guide, "utf8");
		assert(written === originalContent.replace("First line", "First line edited"), `saving preserves every original byte apart from the edit: ${JSON.stringify(written)}`);
		console.log("  ok  saving an edit keeps the images' Markdown");

		await page.route("**/workspace-markdown?**", async (route) => {
			if (route.request().method() === "PUT") await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "mock save failure" }) });
			else await route.continue();
		});
		const paragraph = page.locator(".markdown-editor-tiptap .ProseMirror p", { hasText: "First line edited" });
		await paragraph.click();
		await page.keyboard.press("End");
		await page.keyboard.type(" draft");
		await page.locator(".markdown-editor-error").waitFor({ state: "visible" });
		assert((await paragraph.textContent())?.includes(" draft"), "failed save retains the draft");
		await page.unroute("**/workspace-markdown?**");
		fs.writeFileSync(guide, written.replace("First line edited", "First line external"));
		await page.locator(".markdown-editor-save").click();
		await page.locator(".markdown-editor-conflict").waitFor({ state: "visible" });
		assert((await paragraph.textContent())?.includes(" draft"), "conflict retains the draft");
		await page.getByRole("button", { name: "Keep mine" }).click();
		await waitUntil(() => fs.readFileSync(guide, "utf8").includes("First line edited draft"), "keep mine saves the draft");
		await page.route("**/workspace-markdown?**", async (route) => {
			if (route.request().method() === "PUT") await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "mock save failure" }) });
			else await route.continue();
		});
		await paragraph.click();
		await page.keyboard.press("End");
		await page.keyboard.type(" unsaved");
		await tree.locator(".workspace-file-browser-file", { hasText: "other.md" }).click();
		const prompt = page.getByRole("dialog", { name: "Unsaved Markdown changes" });
		await prompt.getByRole("button", { name: "Cancel" }).click();
		assert((await paragraph.textContent())?.includes(" unsaved"), "cancel retains draft");
		await tree.locator(".workspace-file-browser-file", { hasText: "other.md" }).click();
		await prompt.getByRole("button", { name: "Save and continue" }).click();
		await page.locator(".markdown-editor-error").waitFor({ state: "visible" });
		assert((await paragraph.textContent())?.includes(" unsaved"), "failed navigation save retains editor and draft");
		await tree.locator(".workspace-file-browser-file", { hasText: "other.md" }).click();
		await prompt.getByRole("button", { name: "Discard changes" }).click();
		await page.getByRole("complementary", { name: "Markdown editor: other.md" }).waitFor();
		await page.unroute("**/workspace-markdown?**");
		await tree.locator(".workspace-file-browser-file", { hasText: "guide.md" }).click();
		const reopened = page.locator(".markdown-editor-tiptap .ProseMirror p", { hasText: "First line edited draft" });
		await reopened.waitFor();
		await page.route("**/workspace-markdown?**", async (route) => {
			if (route.request().method() === "PUT") await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "mock save failure" }) });
			else await route.continue();
		});
		await reopened.click();
		await page.keyboard.press("End");
		await page.keyboard.type(" reload draft");
		await page.locator(".markdown-editor-error").waitFor({ state: "visible" });
		await page.unroute("**/workspace-markdown?**");
		fs.writeFileSync(guide, fs.readFileSync(guide, "utf8").replace("First line edited draft", "First line latest"));
		await page.locator(".markdown-editor-save").click();
		await page.locator(".markdown-editor-conflict").waitFor({ state: "visible" });
		await page.getByRole("button", { name: "Reload", exact: true }).click();
		const latest = page.locator(".markdown-editor-tiptap .ProseMirror p", { hasText: "First line latest" });
		await latest.waitFor();
		await latest.click();
		await page.keyboard.press("End");
		await page.keyboard.type(" navigation");
		await tree.locator(".workspace-file-browser-file", { hasText: "other.md" }).click();
		await prompt.getByRole("button", { name: "Save and continue" }).click();
		await page.getByRole("complementary", { name: "Markdown editor: other.md" }).waitFor();
		assert(fs.readFileSync(guide, "utf8").includes("First line latest navigation"), "navigation save writes draft before switching");
		console.log("  ok  failed saves, conflicts, reload and navigation retain or discard drafts as chosen");

		for (const failSecond of [false, true]) {
			await tree.locator(".workspace-file-browser-file", { hasText: "guide.md" }).click();
			const raceParagraph = page.locator(".markdown-editor-tiptap .ProseMirror p", { hasText: "First line latest navigation" });
			await raceParagraph.waitFor();
			let releaseFirst!: () => void;
			let firstStarted!: () => void;
			const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
			const started = new Promise<void>((resolve) => { firstStarted = resolve; });
			let puts = 0;
			await page.route("**/workspace-markdown?**", async (route) => {
				if (route.request().method() !== "PUT") return route.continue();
				puts++;
				if (puts === 1) { firstStarted(); await firstHeld; }
				else if (failSecond) return route.fulfill({ status: 503, json: { error: "mock second save failure" } });
				await route.continue();
			});
			await raceParagraph.click();
			await page.keyboard.press("End");
			const firstEdit = failSecond ? " failed-first" : " saved-first";
			const secondEdit = failSecond ? " failed-second" : " saved-second";
			await page.keyboard.type(firstEdit);
			await page.keyboard.press("Control+s");
			await started;
			await page.keyboard.type(secondEdit);
			await tree.locator(".workspace-file-browser-file", { hasText: "other.md" }).click();
			await prompt.getByRole("button", { name: "Save and continue" }).click();
			releaseFirst();
			if (failSecond) {
				await page.locator(".markdown-editor-error").waitFor({ state: "visible" });
				assert(puts === 2 && (await raceParagraph.textContent())?.includes(firstEdit + secondEdit), "failed second save retains editor and both edits");
				await page.unroute("**/workspace-markdown?**");
				await tree.locator(".workspace-file-browser-file", { hasText: "other.md" }).click();
				await prompt.getByRole("button", { name: "Discard changes" }).click();
			} else {
				await page.getByRole("complementary", { name: "Markdown editor: other.md" }).waitFor();
				assert(puts === 2 && fs.readFileSync(guide, "utf8").includes(firstEdit + secondEdit), "navigation waits for both edits to reach disk");
				await page.unroute("**/workspace-markdown?**");
			}
		}
		console.log("  ok  navigation waits for in-flight and newer saves, retaining the draft on failure");

		const keepMineFailures: string[] = [];
		for (const failSecond of [false, true]) {
			const scenario = failSecond ? "Keep mine retains later edits after a failed subsequent save" : "Keep mine protects later edits before navigation";
			const markdownRoute = `/api/persistent-agents/${encodeURIComponent(agentId)}/workspace-markdown?${new URLSearchParams({ conversationId: imageUrl.searchParams.get("conversationId")!, path: "docs/guide.md" })}`;
			let releaseKeepMine!: () => void;
			const held = new Promise<void>((resolve) => { releaseKeepMine = resolve; });
			try {
				const before = await api(markdownRoute);
				assert(before.status === 200, "read demo file before Keep mine scenario");
				const reset = await api(markdownRoute, { method: "PUT", body: JSON.stringify({ content: "# Guide\n\nKeep mine draft\n", revision: before.body.revision }) });
				assert(reset.status === 200, "reset demo file through the public route");
				await tree.locator(".workspace-file-browser-file", { hasText: "guide.md" }).click();
				const keepParagraph = page.locator(".markdown-editor-tiptap .ProseMirror p", { hasText: "Keep mine draft" });
				await keepParagraph.click();
				await page.keyboard.press("End");
				await page.keyboard.type(" first-edit");
				const external = await api(markdownRoute, { method: "PUT", body: JSON.stringify({ content: "# Guide\n\nExternal revision\n", revision: reset.body.revision }) });
				assert(external.status === 200, "create an external conflict through the public route");
				await page.keyboard.press("Control+s");
				await page.locator(".markdown-editor-conflict").waitFor({ state: "visible" });
				let keepMineStarted = false;
				let puts = 0;
				await page.route("**/workspace-markdown?**", async (route) => {
					if (route.request().method() !== "PUT") return route.continue();
					puts++;
					if (puts === 1) { keepMineStarted = true; await held; }
					else if (failSecond) return route.fulfill({ status: 503, json: { error: "mock subsequent Keep mine save failure" } });
					await route.continue();
				});
				await page.getByRole("button", { name: "Keep mine", exact: true }).click();
				await waitUntil(() => keepMineStarted, "Keep mine PUT is held");
				await keepParagraph.click();
				await page.keyboard.press("End");
				await page.keyboard.type(" late-edit");
				const firstResponse = page.waitForResponse((response) => response.url().includes("/workspace-markdown?") && response.request().method() === "PUT");
				releaseKeepMine();
				assert((await firstResponse).status() === 200, "held Keep mine snapshot reaches the demo server");
				await waitUntil(async () => (await page.locator(".markdown-editor-status").textContent()) !== "Saving…", "Keep mine save settles");
				await tree.locator(".workspace-file-browser-file", { hasText: "other.md" }).click();
				const otherEditor = page.getByRole("complementary", { name: "Markdown editor: other.md", exact: true });
				await waitUntil(async () => await prompt.isVisible() || await otherEditor.isVisible(), "navigation saves the late edit or asks about the draft");
				if (await prompt.isVisible()) {
					await prompt.getByRole("button", { name: "Cancel", exact: true }).click();
					assert((await keepParagraph.textContent())?.includes("first-edit late-edit"), `${scenario}: cancel retains both edits`);
					await tree.locator(".workspace-file-browser-file", { hasText: "other.md" }).click();
					await prompt.getByRole("button", { name: "Save and continue", exact: true }).click();
				}
				if (failSecond) {
					assert(!(await otherEditor.isVisible()), `${scenario}: navigation must retain the editor and both edits`);
					await page.locator(".markdown-editor-error").waitFor({ state: "visible" });
					assert(puts >= 2 && (await keepParagraph.textContent())?.includes("first-edit late-edit"), `${scenario}: both edits remain after the failed save`);
					const persisted = await api(markdownRoute);
					assert(persisted.body.content === "# Guide\n\nKeep mine draft first-edit\n", "failed later save leaves the first snapshot persisted");
				} else {
					await otherEditor.waitFor();
					const persisted = await api(markdownRoute);
					assert(persisted.body.content === "# Guide\n\nKeep mine draft first-edit late-edit\n", `${scenario}: both edits must be persisted before leaving`);
				}
				console.log(`  ok  ${scenario}`);
			} catch (cause) {
				const message = `${scenario}: ${cause instanceof Error ? cause.message : String(cause)}`;
				console.error(`  FAIL  ${message}`);
				keepMineFailures.push(message);
			} finally {
				releaseKeepMine();
				await page.unroute("**/workspace-markdown?**");
				await tree.locator(".workspace-file-browser-file", { hasText: "other.md" }).click();
				await waitUntil(async () => await prompt.isVisible() || await page.getByRole("complementary", { name: "Markdown editor: other.md", exact: true }).isVisible(), "leave the Keep mine scenario");
				if (await prompt.isVisible()) await prompt.getByRole("button", { name: "Discard changes", exact: true }).click();
				await page.getByRole("complementary", { name: "Markdown editor: other.md", exact: true }).waitFor();
			}
		}
		assert(keepMineFailures.length === 0, keepMineFailures.join("\n"));

		const readOnlySetting = await api(`/api/persistent-agents/${encodeURIComponent(agentId)}/workspace-default`, { method: "PUT", body: JSON.stringify({ toolSelection: { kind: "custom", allowedToolNames: ["ls", "read"] } }) });
		assert(readOnlySetting.status === 200, "set demo room read-only");
		await tree.locator(".workspace-file-browser-file", { hasText: "guide.md" }).click();
		await page.getByText("Read-only", { exact: true }).waitFor();
		assert(await page.locator(".markdown-editor-save").isDisabled(), "read-only file cannot be saved");
		const writableSetting = await api(`/api/persistent-agents/${encodeURIComponent(agentId)}/workspace-default`, { method: "PUT", body: JSON.stringify({ toolSelection: { kind: "standard" } }) });
		assert(writableSetting.status === 200, "restore demo writer");
		await tree.locator(".workspace-file-browser-file", { hasText: "other.md" }).click();
		await page.getByRole("complementary", { name: "Markdown editor: other.md" }).waitFor();
		const composer = page.locator("textarea").first();
		await composer.fill("Read REPLACE here");
		await composer.focus();
		await composer.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(5, 12));
		await tree.locator(".workspace-file-browser-file", { hasText: "guide.md" }).dragTo(composer);
		await waitUntil(async () => (await composer.inputValue()) === "Read docs/guide.md here", "drag replaces the selected text at the caret");
		assert(await composer.evaluate((el: HTMLTextAreaElement) => el.selectionStart === 18 && el.selectionEnd === 18), "caret follows the inserted path");
		console.log("  ok  a file dragged onto the composer inserts its path");

		const conversationId = imageUrl.searchParams.get("conversationId")!;
		const treeRoute = (relative: string) => `/api/persistent-agents/${encodeURIComponent(agentId)}/workspace-files?${new URLSearchParams({ conversationId, path: relative })}`;
		for (const denied of ["node_modules", "node_modules/hidden", "shortcut/img", "outside-link"]) {
			const response = await api(treeRoute(denied));
			assert(response.status !== 200, `direct listing of ${denied} must be denied`);
		}
		const fileRoute = (route: string, relative: string) => `/api/persistent-agents/${encodeURIComponent(agentId)}/${route}?${new URLSearchParams({ conversationId, path: relative })}`;
		const protectedRoute = fileRoute("workspace-markdown", "Library/LaunchAgents/example.md");
		const protectedFile = await api(protectedRoute);
		assert(protectedFile.status === 200, "protected file is readable");
		const blockedWrite = await api(protectedRoute, { method: "PUT", body: JSON.stringify({ content: "overwritten", revision: protectedFile.body.revision }) });
		assert(blockedWrite.status === 403 && fs.readFileSync(path.join(folder, "Library", "LaunchAgents", "example.md"), "utf8") === "protected", "write restrictions prevent replacement of a protected file");
		const remoteProtected = await remoteRequest(port, protectedRoute, { method: "PUT", headers: { Cookie: devices[1].cookie, "content-type": "application/json" }, body: JSON.stringify({ content: "overwritten", revision: protectedFile.body.revision }) });
		assert(remoteProtected.status === 403 && fs.readFileSync(path.join(folder, "Library", "LaunchAgents", "example.md"), "utf8") === "protected", "paired writer cannot replace a protected file");
		const beforeSwap = await api(fileRoute("workspace-markdown", "docs/guide.md"));
		assert(beforeSwap.status === 200, "Markdown is readable before the root changes");
		const replacement = path.join(tempHome, "replacement");
		fs.mkdirSync(path.join(replacement, "docs", "img"), { recursive: true });
		fs.writeFileSync(path.join(replacement, "docs", "guide.md"), "replacement private");
		fs.writeFileSync(path.join(replacement, "docs", "img", "pixel.png"), ONE_PIXEL_PNG);
		fs.renameSync(folder, `${folder}-original`);
		fs.symlinkSync(replacement, folder);
		for (const url of [treeRoute(""), fileRoute("workspace-markdown", "docs/guide.md"), fileRoute("workspace-image", "docs/img/pixel.png")]) {
			const response = await authedFetch(`${baseUrl}${url}`);
			const body = await response.text();
			assert(response.status !== 200 || (!body.includes("replacement private") && !body.includes("guide.md") && !body.includes("PNG")), "retargeted root must not expose replacement data");
		}
		const attempt = await api(fileRoute("workspace-markdown", "docs/guide.md"), { method: "PUT", body: JSON.stringify({ content: "overwrite", revision: beforeSwap.body.revision }) });
		assert(attempt.status !== 200 && fs.readFileSync(path.join(replacement, "docs", "guide.md"), "utf8") === "replacement private", "retargeted root must not be written");
		fs.unlinkSync(folder);
		fs.renameSync(`${folder}-original`, folder);
		await page.route("**/workspace-markdown?**", async (route) => {
			if (route.request().method() === "PUT") return route.fulfill({ status: 503, json: { error: "mock save failure" } });
			await route.continue();
		});
		const navigationDraft = page.locator(".markdown-editor-tiptap .ProseMirror");
		await navigationDraft.click();
		await page.keyboard.type(" pending conversation draft");
		await page.getByRole("button", { name: "Forget", exact: true }).first().click();
		await prompt.getByRole("button", { name: "Cancel" }).click();
		assert((await navigationDraft.textContent())?.includes("pending conversation draft"), "cancel preserves draft before conversation replacement");
		await page.getByRole("button", { name: "Forget", exact: true }).first().click();
		await prompt.getByRole("button", { name: "Discard changes" }).click();
		await page.getByRole("alertdialog", { name: "Forget this conversation and start fresh?" }).getByRole("button", { name: "Forget", exact: true }).click();
		await waitUntil(async () => await page.locator(".workspace-tab").count() === 0, "conversation replacement clears old tabs");
		await page.unroute("**/workspace-markdown?**");
		await tree.locator(".workspace-file-browser-directory", { hasText: "docs" }).click();
		await tree.locator(".workspace-file-browser-file", { hasText: "other.md" }).click();
		const newDraft = page.locator(".markdown-editor-tiptap .ProseMirror");
		await newDraft.click();
		await page.route("**/workspace-markdown?**", async (route) => {
			if (route.request().method() === "PUT") return route.fulfill({ status: 503, json: { error: "mock save failure" } });
			await route.continue();
		});
		await page.keyboard.type(" pending room draft");
		const home = page.getByRole("navigation", { name: "Room navigation" }).getByRole("button", { name: "Home", exact: true });
		await home.click();
		await prompt.getByRole("button", { name: "Cancel" }).click();
		assert((await newDraft.textContent())?.includes("pending room draft"), "cancel preserves draft before leaving room");
		await home.click();
		await prompt.getByRole("button", { name: "Discard changes" }).click();
		await card.waitFor();
		assert(!fs.readFileSync(path.join(folder, "docs", "other.md"), "utf8").includes("pending room draft"), "discard leaves file unchanged");
		await page.unroute("**/workspace-markdown?**");
		await context.close();
	} finally {
		await browser.close();
	}
	console.log("workspace-markdown-images-ui smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-4000).replace(/token=[^\s]+/g, "token=<redacted>"));
	throw error;
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
