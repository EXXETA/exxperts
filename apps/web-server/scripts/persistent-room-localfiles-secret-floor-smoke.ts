// Full access (localFiles) secret floor smoke: the file tools a Full access
// room really gets (a custom tool replaces the native one of the same name)
// refuse secret files and the app's own data by every path shape, and ls, find
// and grep leave them out. Offline, in a throwaway HOME with fake files.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const savedEnvNames = ["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "PI_OFFLINE", "EXXETA_PERSISTENT_AGENTS_ROOT", "EXXETA_BUNDLED_TOOLS_DIR", "EXXPERTS_CODING_AGENT_DIR"] as const;
const savedEnv = savedEnvNames.map((name) => process.env[name]);
const realToolsDirs = [process.env.EXXETA_BUNDLED_TOOLS_DIR, path.join(process.env.EXXPERTS_STATE_HOME || os.homedir(), ".exxperts", "agent", "bin")].filter((dir): dir is string => Boolean(dir));
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-secret-floor-")));
const home = path.join(tmp, "home");
const exxetaStateRoot = path.join(home, ".exxperts", "app");
const persistentAgentsRoot = path.join(exxetaStateRoot, "personalized-agents");

// The runtime fixes its tools folder from HOME when it loads, so the whole
// throwaway profile is in place before the first import of it. fd and rg are
// linked in from wherever they are installed, the real profile included; only
// the binaries are linked and run, and none of its data is read.
const toolsDir = path.join(tmp, "tools");
fs.mkdirSync(toolsDir, { recursive: true });
for (const binary of ["fd", "rg"].map((name) => name + (process.platform === "win32" ? ".exe" : ""))) {
	const found = realToolsDirs.map((dir) => path.join(dir, binary)).find((candidate) => fs.existsSync(candidate));
	if (found) {
		try {
			fs.symlinkSync(found, path.join(toolsDir, binary));
		} catch {
			fs.copyFileSync(found, path.join(toolsDir, binary));
			fs.chmodSync(path.join(toolsDir, binary), 0o755);
		}
	}
}
Object.assign(process.env, {
	HOME: home,
	USERPROFILE: home,
	HOMEDRIVE: path.parse(home).root.replace(/[\\/]+$/, ""),
	HOMEPATH: home.slice(path.parse(home).root.length - 1),
	PI_OFFLINE: "1",
	EXXETA_PERSISTENT_AGENTS_ROOT: persistentAgentsRoot,
	EXXETA_BUNDLED_TOOLS_DIR: toolsDir,
});

const { createEditToolDefinition, createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition, createReadToolDefinition, createWriteToolDefinition } = await import("@exxeta/exxperts-runtime");
const { createPersistentRoomCapabilityPolicy, PERSISTENT_ROOM_WORKSPACE_DEFAULT_CONVERSATION_ID, persistentRoomRuntimeCwdForEffectiveWorkspacePolicy, resolvePersistentRoomEffectiveWorkspacePolicy, writePersistentRoomDefaultCapabilityPolicy } = await import("../src/persistent-room-workspace-policy.js");
const { createPersistentRoomWorkspaceTools } = await import("../src/persistent-room-workspace-tools.js");
const { ROOM_FOLDER_MOVED, ROOM_FOLDER_REFUSED, skillsFolderRefusal } = await import("../src/room-files.js");
const { placeRefused } = await import("../src/path-shapes.js");
const { saveAlsoAllowedFolders } = await import("../src/room-box/also-allowed.js");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function toolOutput(result: any): string {
	return (result?.content ?? []).filter((part: any) => part?.type === "text").map((part: any) => String(part.text ?? "")).join("\n");
}

// One file stored without compression, the way Keynote's single-file decks
// start: a zip's local header, `PK\x03\x04`.
function storedZip(name: string, text: string): Buffer {
	const data = Buffer.from(text);
	let crc = ~0;
	for (const byte of data) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	crc = ~crc >>> 0;
	const fileName = Buffer.from(name);
	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(10, 4);
	local.writeUInt32LE(crc, 14);
	local.writeUInt32LE(data.length, 18);
	local.writeUInt32LE(data.length, 22);
	local.writeUInt16LE(fileName.length, 26);
	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE(10, 4);
	central.writeUInt16LE(10, 6);
	central.writeUInt32LE(crc, 16);
	central.writeUInt32LE(data.length, 20);
	central.writeUInt32LE(data.length, 24);
	central.writeUInt16LE(fileName.length, 28);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(1, 8);
	end.writeUInt16LE(1, 10);
	end.writeUInt32LE(central.length + fileName.length, 12);
	end.writeUInt32LE(local.length + fileName.length + data.length, 16);
	return Buffer.concat([local, fileName, data, central, fileName, end]);
}

const REFUSAL = "looks like a secret file or the app's own data";
const READ_ONLY = "can be read but not changed by rooms";
// A link in the room is refused whatever it points at.
const LINK = "this room doesn't follow links";
const OUTSIDE = "is outside this room's folder and the folders allowed for it";
const LEFT_OUT = "left out: secret files or the app's own data.";
// ls, find and grep end with the count of what they left out, after any other notice.
const endsLeftOut = (text: string, count?: number) => new RegExp(`\\n\\n${count ?? "\\d+"} (entry|entries) ${LEFT_OUT.replace(/[.']/g, "\\$&")}$`).test(text.trimEnd());

try {
	const project = path.join(home, "project");
	const repoRoot = path.join(tmp, "repo");
	for (const dir of [repoRoot, persistentAgentsRoot, path.join(home, ".ssh"), path.join(home, ".aws"), path.join(project, ".git"), path.join(project, "sub")]) fs.mkdirSync(dir, { recursive: true });
	const write = (file: string, text: string) => fs.writeFileSync(file, text);
	write(path.join(home, ".ssh", "id_ed25519"), "FAKE KEY needle\n");
	write(path.join(home, ".aws", "credentials"), "[default] needle\n");
	write(path.join(home, ".netrc"), "machine example needle\n");
	write(path.join(home, ".ssh", "config"), "Host needle\n");
	write(path.join(home, ".npmrc"), "//registry/:_authToken=needle\n");
	write(path.join(home, ".zshrc"), "export TOKEN=needle\n");
	write(path.join(home, ".exxperts.home.json"), "{\"dir\":\"needle\"}\n");
	for (const dir of [path.join(home, ".config", "mcp"), path.join(home, ".config", "git"), path.join(home, "Library", "LaunchAgents"), path.join(project, ".git", "hooks")]) fs.mkdirSync(dir, { recursive: true });
	const runLater: Array<[string, string]> = [
		[path.join(home, ".config", "mcp", "mcp.json"), "{\"env\":{\"TOKEN\":\"needle\"}}\n"],
		[path.join(home, ".gitconfig"), "[core]\n\tpager = needle\n"],
		[path.join(home, ".config", "git", "config"), "[core]\n\tpager = needle\n"],
		[path.join(project, ".git", "config"), "[remote]\n\turl = https://needle@example.invalid/repo.git\n"],
		[path.join(project, ".git", "hooks", "pre-commit"), "echo needle\n"],
	];
	for (const [file, text] of runLater) write(file, text);
	fs.mkdirSync(path.join(home, ".exxperts-work"), { recursive: true });
	write(path.join(home, ".exxperts-work", "notes.txt"), "profile needle\n");
	write(path.join(project, ".envrc"), "export TOKEN=needle\n");
	write(path.join(project, ".env.big"), "needle\n".repeat(200_000));
	write(path.join(exxetaStateRoot, "big.jsonl"), "needle\n".repeat(200_000));
	fs.mkdirSync(path.join(exxetaStateRoot, "many"), { recursive: true });
	for (let index = 0; index < 60; index += 1) write(path.join(exxetaStateRoot, "many", `room-${index}.json`), "{}\n");
	const bulkDir = path.join(project, "bulk");
	fs.mkdirSync(bulkDir, { recursive: true });
	for (let index = 0; index < 30; index += 1) write(path.join(bulkDir, `k${index}.pem`), "FAKE PEM\n");
	write(path.join(exxetaStateRoot, "secret.json"), "{\"needle\":true}\n");
	write(path.join(project, "notes.md"), "hello needle\n");
	write(path.join(project, ".env"), "TOKEN=needle\n");
	write(path.join(project, ".env.example"), "TOKEN=needle-template\n");
	write(path.join(project, "server.pem"), "FAKE PEM needle\n");
	write(path.join(project, ".git", "HEAD"), "ref: needle\n");
	let links = true;
	try {
		fs.symlinkSync(path.join(home, ".ssh", "id_ed25519"), path.join(project, "sub", "link-to-key"));
		fs.symlinkSync(path.join(home, ".exxperts"), path.join(project, "sub", "link-to-state"), "dir");
		fs.symlinkSync(path.join(home, ".ssh", "id_rsa"), path.join(project, "dangling"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EPERM" && (error as NodeJS.ErrnoException).code !== "EACCES") throw error;
		links = false;
		console.log("SKIPPED: the symlink cases (this system does not allow links here)");
	}

	const policy = createPersistentRoomCapabilityPolicy({
		agentId: "localfiles-secret-floor-smoke-room",
		conversationId: "c_localfiles_secret_floor_smoke",
		repoRoot,
		persistentAgentsRoot,
		exxetaStateRoot,
		root: project,
		workspaceAccessMode: "localFiles",
		source: "manual",
		now: new Date("2026-07-01T00:00:00.000Z"),
	});
	const custom = new Map(createPersistentRoomWorkspaceTools(policy, { localFilesCwd: project }).map((tool) => [String(tool.name), tool]));
	const natives: Record<string, any> = {
		read: createReadToolDefinition(project),
		ls: createLsToolDefinition(project),
		find: createFindToolDefinition(project),
		grep: createGrepToolDefinition(project),
		write: createWriteToolDefinition(project),
		edit: createEditToolDefinition(project),
	};
	const tool = (name: string): any => custom.get(name) ?? natives[name];
	const run = async (name: string, params: Record<string, unknown>): Promise<{ text: string; error?: string }> => {
		try {
			return { text: toolOutput(await tool(name).execute(`smoke-${name}`, params, undefined, undefined, {} as any)) };
		} catch (error) {
			return { text: "", error: (error as Error).message };
		}
	};
	// Outside the room's folder every path is refused as outside; inside it, closed names keep their own words.
	const inRoom = (params: Record<string, unknown>) => {
		const raw = String(params.path ?? ".");
		return path.relative(project, raw.startsWith("~") ? path.join(home, raw.slice(1)) : path.resolve(project, raw));
	};
	const insideRoom = (params: Record<string, unknown>) => !inRoom(params).startsWith("..");
	const throughLink = (params: Record<string, unknown>) => {
		const relative = inRoom(params);
		if (relative.startsWith("..")) return false;
		let at = project;
		return relative.split(path.sep).filter(Boolean).some((part) => {
			at = path.join(at, part);
			return fs.lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink() === true;
		});
	};
	const refused = async (name: string, params: Record<string, unknown>, label: string) => {
		const outcome = await run(name, params);
		assert(outcome.error?.includes(REFUSAL) || outcome.error?.includes(READ_ONLY) || outcome.error?.includes(LINK) || (!insideRoom(params) && outcome.error?.includes(OUTSIDE)), `${name} ${label} must be refused, got ${JSON.stringify(outcome).slice(0, 200)}`);
		assert(!outcome.text.includes("needle"), `${name} ${label} must not return content`);
	};
	// The words say what the model may do next: tell the person. No refusal
	// offers a command, so none hands the person a step around the fence.
	const refusedWith = async (name: string, params: Record<string, unknown>, words: string, label: string) => {
		const outcome = await run(name, params);
		const error = outcome.error ?? "";
		assert(error.includes(words) || (!insideRoom(params) && error.includes(OUTSIDE)) || (throughLink(params) && error.includes(LINK)),`${name} ${label} must be refused with "${words}", got ${JSON.stringify(outcome).slice(0, 300)}`);
		assert(!/command/i.test(error) && error.includes("Tell the person"), `${name} ${label}: the refusal must offer no command and say to tell the person, got ${JSON.stringify(error)}`);
		assert(!outcome.text.includes("needle"), `${name} ${label} must not return content`);
	};
	// A colon past the drive names a file's data stream, so its shape is refused before any call on the disk.
	const refusedAsPlace = async (name: string, params: { path: string } & Record<string, unknown>, label: string) => {
		const outcome = await run(name, params);
		assert(outcome.error === placeRefused(params.path), `${name} ${label} must be refused as a place a room can't use, got ${JSON.stringify(outcome).slice(0, 300)}`);
		assert(!outcome.text.includes("needle"), `${name} ${label} must not return content`);
	};
	const open = async (name: string, params: Record<string, unknown>, expected: string, label: string) => {
		const outcome = await run(name, params);
		// A link in the room is refused whatever it points at.
		if (throughLink(params)) {
			assert(outcome.error?.includes(LINK) && !outcome.text.includes("needle"), `${name} ${label} through a link must be refused as a link, got ${JSON.stringify(outcome).slice(0, 200)}`);
			return;
		}
		// Full access no longer reaches past the room's folder: a neighbour outside it is refused as outside.
		if (!insideRoom(params)) {
			assert(outcome.error?.includes(OUTSIDE) && !outcome.text.includes("needle"), `${name} ${label} outside the room's folder must be refused as outside, got ${JSON.stringify(outcome).slice(0, 200)}`);
			return;
		}
		assert(!outcome.error && outcome.text.includes(expected), `${name} ${label} must stay open, got ${JSON.stringify(outcome).slice(0, 200)}`);
	};

	// ---- read: every path shape -------------------------------------------
	await refused("read", { path: ".env" }, "a relative .env");
	await refused("read", { path: ".ENV" }, "a .env in another case");
	await refused("read", { path: path.join(project, ".env") }, "an absolute .env");
	await refused("read", { path: "sub/../.env" }, "a .env through ..");
	await refused("read", { path: "server.pem" }, "a .pem file");
	await refused("read", { path: "~/.ssh/id_ed25519" }, "a key through ~");
	await refused("read", { path: "../.ssh/id_ed25519" }, "a key through ..");
	await refused("read", { path: "~/.exxperts/app/secret.json" }, "the app's own data");
	if (links) {
		await refused("read", { path: "sub/link-to-key" }, "a symlink to a key");
		await refused("read", { path: "sub/link-to-state/app/secret.json" }, "a file through a symlink into the app's folder");
	}
	await refused("read", { path: "~/.exxpertſ/app/secret.json" }, "the app's folder spelled with a long s");
	await refused("read", { path: "~/.ssh/config" }, "any file in .ssh");
	await refused("read", { path: "~/.npmrc" }, ".npmrc");
	await refused("read", { path: ".envrc" }, ".envrc");
	await refused("read", { path: "~/.exxperts-work/notes.txt" }, "another data profile's folder");
	await refused("read", { path: "~/.exxperts.home.json" }, "the pointer to the app's data");
	await refusedWith("read", { path: "~/.config/mcp/mcp.json" }, REFUSAL, "the shared connector settings");
	await refusedWith("write", { path: "~/.config/mcp/mcp.json", content: "x" }, REFUSAL, "the shared connector settings");
	await open("read", { path: ".git/config" }, "url = https://needle", "a project's git config");
	await refused("read", { path: "~/.aws/credentials" }, "the AWS credentials file");
	await refused("read", { path: "~/.netrc" }, "the .netrc file");
	await open("read", { path: "notes.md" }, "hello needle", "a normal file");
	await open("read", { path: ".env.example" }, "needle-template", "a .env template");
	await open("read", { path: ".git/HEAD" }, "ref: needle", ".git");

	// ---- write and edit ----------------------------------------------------
	await refused("write", { path: ".env.local", content: "x" }, "a new .env.* file");
	write(path.join(project, ".env.local"), "TOKEN=needle-local\n");
	await refusedWith("read", { path: ".env.local" }, REFUSAL, "an existing .env.local");
	await refused("write", { path: "~/.exxperts/app/planted.json", content: "x" }, "into the app's folder");
	if (links) {
		await refused("write", { path: "sub/link-to-state/app/planted.json", content: "x" }, "through a symlink into the app's folder");
		await refused("write", { path: "dangling", content: "x" }, "a dangling symlink to a key name");
		assert(!fs.existsSync(path.join(home, ".ssh", "id_rsa")), "a refused write must not create the link's target");
	}
	await refused("write", { path: "~/.ssh/authorized_keys", content: "x" }, "into .ssh");
	await refused("write", { path: "~/.zshrc", content: "x" }, "a shell startup file");
	await refused("write", { path: "~/.zlogin", content: "x" }, "a login shell startup file");
	await refused("write", { path: "~/.exxperts.home-move.json", content: "{\"to\":\"/tmp/drop\"}" }, "an order to move the app's data");
	assert(!fs.existsSync(path.join(home, ".zlogin")) && !fs.existsSync(path.join(home, ".exxperts.home-move.json")), "refused writes must not create .zlogin or a move order");
	for (const [file] of runLater) await refused("write", { path: file, content: "x" }, `${path.relative(home, file)}, which can run code later`);
	await refused("write", { path: "~/Library/LaunchAgents/planted.plist", content: "x" }, "a new launch agent");
	assert(runLater.every(([file, text]) => fs.readFileSync(file, "utf8") === text) && !fs.existsSync(path.join(home, "Library", "LaunchAgents", "planted.plist")), "refused writes must leave git, connector and launch agent files unchanged or absent");
	await open("read", { path: ".git/HEAD" }, "ref: needle", "the rest of .git");
	assert(!fs.existsSync(path.join(home, ".ssh", "authorized_keys")) && fs.readFileSync(path.join(home, ".zshrc"), "utf8") === "export TOKEN=needle\n", "refused writes must leave .ssh and .zshrc alone");
	assert(!fs.existsSync(path.join(exxetaStateRoot, "planted.json")), "a refused write must not land in the app's folder");
	await refused("edit", { path: ".env", edits: [{ oldText: "needle", newText: "x" }] }, "an existing .env");
	await open("write", { path: "new.txt", content: "fresh" }, "", "a normal new file");
	assert(fs.readFileSync(path.join(project, "new.txt"), "utf8") === "fresh", "a normal write must land");
	await open("edit", { path: "notes.md", edits: [{ oldText: "hello", newText: "hi" }] }, "", "a normal file");
	assert(fs.readFileSync(path.join(project, "notes.md"), "utf8") === "hi needle\n", "a normal edit must land");
	assert(fs.readFileSync(path.join(project, ".env"), "utf8") === "TOKEN=needle\n", "a refused edit must leave the file alone");

	// ---- the kinds closed by runs of parts, some with `**` -----------------
	// Each closed file is refused by read and write, and left out by grep and
	// find; each look-alike next to it stays open, so the wider parts close
	// only what they name.
	// Read but never written: they can run code later.
	const kindReadOnly: Array<[string, string]> = [
		[".git/modules/lib/hooks/post-checkout", "submodule hook"],
		[".git/modules/lib/config", "submodule git config"],
		[".git/modules/lib/modules/inner/hooks/pre-push", "nested submodule hook"],
		[".git/modules/lib/modules/inner/config", "nested submodule git config"],
		[".git/config.worktree", "worktree git config"],
		[".git/worktrees/wt/config.worktree", "linked worktree's git config"],
		[".git/modules/lib/config.worktree", "submodule's worktree git config"],
		[".git/modules/lib/worktrees/wt/config.worktree", "submodule worktree's git config"],
		[".git/commondir", "git folder's commondir"],
		[".git/worktrees/wt/commondir", "linked worktree's commondir"],
		[".husky/pre-commit", "husky hook"],
		[".mcp.json", "a project's .mcp.json"],
		["tools/.MCP.JSON", "a project's .mcp.json in another case"],
		["nested/.mcp.json/servers.json", "a file in a folder named .mcp.json"],
		[".yarnrc.yml", "a project's yarn settings"],
		[".npmrc", "a project's npm settings"],
		[".profile", "a project's Heroku .profile"],
		["~/dotfiles/.zshrc", "a dotfiles project's startup file nothing links to"],
	];
	const kindClosed: Array<[string, string]> = [
		["~/.config/fish/config.fish", "fish startup file"],
		["~/.config/fish/conf.d/env.fish", "fish startup snippet"],
		["~/.yarnrc", "yarn classic settings"],
		["~/.yarnrc.yml", "yarn settings"],
		["~/.git-credentials", "git's stored logins"],
		["~/.config/gcloud/application_default_credentials.json", "gcloud credentials"],
		["~/.config/gcloud/access_tokens.db", "gcloud tokens"],
		["~/AppData/Roaming/gcloud/credentials.db", "gcloud tokens on Windows"],
		["~/AppData/Roaming/gcloud/application_default_credentials.json", "gcloud credentials on Windows"],
		["~/proc/4242/environ", "a process environment file"],
		["~/proc/4242/task/4243/environ", "a thread environment file"],
		["~/proc/4242/cmdline", "process command line"],
		["~/proc/4242/task/4243/cmdline", "thread command line"],
	];
	const kindOpen: Array<[string, string]> = [
		[".git/modules/lib/HEAD", "the rest of a submodule's git folder"],
		[".git/worktrees/wt/gitdir", "a linked worktree's pointer back to its folder"],
		["config", "a project's own config file"],
		["src/modules/auth/hooks/use-auth.ts", "a modules folder outside .git"],
		["src/modules/config", "a config file in a modules folder outside .git"],
		["docs/environ", "an environ file outside proc"],
		["docs/cmdline", "a cmdline file outside proc"],
		["proc/readme.md", "another file under a proc folder"],
		[".huskyrc", "a .husky-like name"],
		[".env.dist", "a .env.dist template"],
		["mcp.json", "a project's mcp.json without the dot"],
		["~/.config/fishing/notes.md", "a fish-like folder"],
		["AppData/Local/gcloud/notes.md", "a gcloud folder outside Roaming"],
	];
	const kindFile = (rel: string) => (rel.startsWith("~/") ? path.join(home, rel.slice(2)) : path.join(project, rel));
	for (const [rel] of [...kindReadOnly, ...kindClosed, ...kindOpen]) {
		fs.mkdirSync(path.dirname(kindFile(rel)), { recursive: true });
		write(kindFile(rel), `kindmark ${rel}\n`);
	}
	for (const [rel, label] of kindClosed) {
		await refused("read", { path: rel }, label);
		await refused("write", { path: rel, content: "x" }, label);
		assert(fs.readFileSync(kindFile(rel), "utf8") === `kindmark ${rel}\n`, `a refused write must leave the ${label} alone`);
	}
	for (const [rel, label] of kindOpen) await open("read", { path: rel }, `kindmark ${rel}`, label);
	for (const [rel, label] of kindReadOnly) {
		await open("read", { path: rel }, `kindmark ${rel}`, label);
		await refusedWith("write", { path: rel, content: "x" }, READ_ONLY, label);
		await refusedWith("edit", { path: rel, edits: [{ oldText: "kindmark", newText: "x" }] }, READ_ONLY, label);
		assert(fs.readFileSync(kindFile(rel), "utf8") === `kindmark ${rel}\n`, `a refused write must leave the ${label} alone`);
	}
	if (links) {
		fs.symlinkSync(path.join(project, ".mcp.json"), path.join(project, "sub", "link-to-mcp"));
		await open("read", { path: "sub/link-to-mcp" }, "kindmark .mcp.json", "a link to a project's .mcp.json");
		await refusedWith("write", { path: "sub/link-to-mcp", content: "x" }, READ_ONLY, "a link to a project's .mcp.json");
		fs.symlinkSync(path.join(project, "config"), path.join(project, "sub", ".mcp.json"));
		await refusedWith("write", { path: "sub/.mcp.json", content: "x" }, READ_ONLY, "a link named .mcp.json");
		assert(fs.readFileSync(path.join(project, ".mcp.json"), "utf8") === "kindmark .mcp.json\n" && fs.readFileSync(path.join(project, "config"), "utf8") === "kindmark config\n", "refused writes through links must leave both files alone");
	}
	await refusedWith("write", { path: "fresh-mcp/.mcp.json", content: "x" }, READ_ONLY, "a new .mcp.json");
	assert(!fs.existsSync(path.join(project, "fresh-mcp", ".mcp.json")), "a refused write must not create a .mcp.json");
	if (process.platform === "win32") {
		for (const spelled of [".mcp.json.", ".mcp.json "]) await refusedWith("write", { path: spelled, content: "x" }, READ_ONLY, `${JSON.stringify(spelled)}, which Windows opens as .mcp.json`);
		await refusedAsPlace("write", { path: ".mcp.json::$DATA", content: "x" }, "\".mcp.json::$DATA\", which Windows opens as .mcp.json");
		assert(fs.readFileSync(path.join(project, ".mcp.json"), "utf8") === "kindmark .mcp.json\n", "refused writes must leave .mcp.json alone");
	} else console.log("SKIPPED: the .mcp.json. cases (only Windows opens .mcp.json. as .mcp.json)");
	await refusedWith("read", { path: "~/.zshrc" }, REFUSAL, "the home folder's .zshrc");
	// With the terminal off the room cannot run a command, so the refusals offer none.
	const terminalOffTools = new Map(createPersistentRoomWorkspaceTools(policy, { localFilesCwd: project, terminalOn: () => false }).map((offTool) => [String(offTool.name), offTool as any]));
	for (const [name, params, words, label] of [
		["read", { path: "~/.config/mcp/mcp.json" }, REFUSAL, "the shared connector settings"],
		["write", { path: "fresh-mcp/.mcp.json", content: "x" }, READ_ONLY, "a new .mcp.json"],
	] as const) {
		let error = "";
		try {
			await terminalOffTools.get(name).execute(`smoke-off-${name}`, params, undefined, undefined, {} as any);
		} catch (caught) {
			error = (caught as Error).message;
		}
		assert(error.includes(words) && !error.includes("terminal command") && error.includes("Tell the person"), `${name} ${label} with the terminal off must be refused with no command offered, got ${JSON.stringify(error)}`);
	}
	await refusedWith("read", { path: "~/.ZSHRC" }, REFUSAL, "the home folder's .zshrc in another case");
	await refusedWith("read", { path: "~/.npmrc" }, REFUSAL, "the home folder's .npmrc");
	await refusedWith("write", { path: "~/.npmrc", content: "x" }, REFUSAL, "the home folder's .npmrc");
	await refusedWith("read", { path: ".envrc" }, REFUSAL, "a project's .envrc");
	await refusedWith("read", { path: "~/.ssh/config" }, REFUSAL, "the ssh config");
	await refusedWith("read", { path: "~/.git-credentials" }, REFUSAL, "git's stored logins");
	if (links) {
		write(path.join(home, "dotfiles", ".bashrc"), "kindmark linked bashrc needle\n");
		fs.symlinkSync(path.join(home, "dotfiles", ".bashrc"), path.join(home, ".bashrc"));
		await refusedWith("read", { path: "~/dotfiles/.bashrc" }, REFUSAL, "a dotfiles project's file that the home folder's .bashrc links to");
		await refusedWith("read", { path: "~/.bashrc" }, REFUSAL, "the home folder's .bashrc, a link");
	}
	await open("read", { path: "~/project/.git/hooks/pre-commit" }, "echo needle", "a project's git hook");
	if (process.platform === "linux" && fs.existsSync("/proc/self/environ")) {
		await refused("read", { path: "/proc/self/environ" }, "this process's environment");
		await refused("read", { path: `/proc/${process.pid}/environ` }, "this process's environment by its id");
		await refused("read", { path: "/proc/self/cmdline" }, "this process's command line");
		await refused("read", { path: `/proc/${process.pid}/cmdline` }, "this process's command line by its id");
	}
	// The home folder's kinds are refused above, and grep and find of it below; the room's own are searched here, the git folder from inside it.
	const inProjectKinds = (kinds: Array<[string, string]>, inGit: boolean) => kinds.filter(([rel]) => !rel.startsWith("~/") && rel.startsWith(".git/") === inGit);
	{
		const grepKinds = await run("grep", { pattern: "kindmark", path: "." });
		assert(!grepKinds.error, `grep . must work: ${grepKinds.error}`);
		for (const [rel, label] of inProjectKinds([...kindOpen, ...kindReadOnly], false)) assert(grepKinds.text.includes(`kindmark ${rel}`), `grep must keep ${label}`);
		assert(!grepKinds.text.includes("kindmark .git/"), `grep . must not search the git folder, got ${JSON.stringify(grepKinds.text.slice(0, 300))}`);
		const grepGit = await run("grep", { pattern: "kindmark", path: ".git" });
		for (const [rel, label] of inProjectKinds([...kindOpen, ...kindReadOnly], true)) assert(grepGit.text.includes(`kindmark ${rel}`), `grep in .git must keep ${label}, got ${JSON.stringify(grepGit.text.slice(0, 300))}`);
		assert(!grepGit.text.includes("left out"), `grep in .git leaves nothing out, so it must add no line, got ${JSON.stringify(grepGit.text.slice(-300))}`);
	}
	{
		const findKinds = await run("find", { pattern: "*", path: "." });
		for (const [rel, label] of inProjectKinds([...kindOpen, ...kindReadOnly], false)) assert(findKinds.text.split("\n").includes(rel), `find must keep ${label}`);
		const findGit = await run("find", { pattern: "*", path: ".git" });
		for (const [rel, label] of inProjectKinds([...kindOpen, ...kindReadOnly], true)) assert(findGit.text.split("\n").includes(rel), `find in .git must keep ${label}`);
		assert(endsLeftOut(findKinds.text), `find . must end with the count of what it left out, got ${JSON.stringify(findKinds.text.slice(-300))}`);
	}

	// ---- a .git file: read stays open, write and edit are refused ----------
	fs.mkdirSync(path.join(project, "lib"), { recursive: true });
	write(path.join(project, "lib", ".git"), "gitdir: ../.git/modules/lib\n");
	await open("read", { path: "lib/.git" }, "gitdir: ../.git/modules/lib", "a submodule's .git file");
	await refused("edit", { path: "lib/.git", edits: [{ oldText: "../.git/modules/lib", newText: "../planted" }] }, "a submodule's .git file");
	await refused("write", { path: "lib/.git", content: "gitdir: ../planted\n" }, "a submodule's .git file");
	await refused("write", { path: "lib/.GIT", content: "gitdir: ../planted\n" }, "a .git file in another case");
	await refused("write", { path: "fresh/.git", content: "gitdir: ../planted\n" }, "a new .git file");
	await refused("write", { path: "fresh/.git/.", content: "gitdir: ../planted\n" }, "a new .git file with a trailing /.");
	await refused("write", { path: "lib/.git/.", content: "gitdir: ../planted\n" }, "a submodule's .git file with a trailing /.");
	if (process.platform === "win32") await refused("write", { path: "fresh/.git.", content: "gitdir: ../planted\n" }, "a new .git file with a trailing dot");
	else console.log("SKIPPED: the .git. case (only Windows opens .git. as .git)");
	if (links) {
		fs.symlinkSync(path.join(project, "lib", ".git"), path.join(project, "sub", "link-to-gitfile"));
		await refused("write", { path: "sub/link-to-gitfile", content: "gitdir: ../planted\n" }, "a link to a .git file");
	}
	assert(fs.readFileSync(path.join(project, "lib", ".git"), "utf8") === "gitdir: ../.git/modules/lib\n" && !fs.existsSync(path.join(project, "fresh", ".git")), "refused writes must leave the .git file alone and create none");

	// ---- real git never runs from a git folder the room wrote ---------------
	// The room may write a git folder of its own; every file that points git
	// at a git folder stays closed, so the next `git status` runs nothing of it.
	if (spawnSync("git", ["--version"]).status === 0) {
		const gitRoot = path.join(tmp, "git");
		fs.mkdirSync(gitRoot, { recursive: true });
		write(path.join(gitRoot, "gitconfig"), "");
		const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(gitRoot, "gitconfig"), GIT_CEILING_DIRECTORIES: tmp };
		const git = (cwd: string, ...args: string[]) => {
			const result = spawnSync("git", ["-c", "user.email=smoke@test", "-c", "user.name=Smoke", "-c", "protocol.file.allow=always", ...args], { cwd, env: gitEnv, encoding: "utf8" });
			assert(result.status === 0, `git ${args.join(" ")} failed: ${result.stderr}`);
			return result.stdout.trim();
		};
		const newRepo = (dir: string) => {
			fs.mkdirSync(dir, { recursive: true });
			git(dir, "init", "-q", "-b", "main");
			write(path.join(dir, "a.txt"), "a\n");
			git(dir, "add", "a.txt");
			git(dir, "commit", "-q", "-m", "a");
		};
		const slashes = (file: string) => file.split(path.sep).join("/");
		const plantGitFolder = async (folder: string, from: string, objects: string, marker: string) => {
			const branch = git(from, "rev-parse", "--abbrev-ref", "HEAD");
			const planted: Array<[string, string]> = [
				["HEAD", `ref: refs/heads/${branch}\n`],
				[`refs/heads/${branch}`, `${git(from, "rev-parse", "HEAD")}\n`],
				["objects/info/alternates", `${slashes(objects)}\n`],
				["config", `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = ${slashes(from)}\n\tfsmonitor = "touch ${slashes(marker)}"\n`],
			];
			for (const [rel, content] of planted) await open("write", { path: path.join(folder, rel), content }, "", `a git folder of the room's own (${rel})`);
		};
		const superproject = path.join(gitRoot, "super");
		const submodule = path.join(superproject, "lib");
		newRepo(path.join(gitRoot, "lib"));
		newRepo(superproject);
		git(superproject, "submodule", "add", "-q", path.join(gitRoot, "lib"), "lib");
		const repo = path.join(gitRoot, "repo");
		const worktree = path.join(gitRoot, "wt");
		const worktree2 = path.join(gitRoot, "wt2");
		newRepo(repo);
		git(repo, "worktree", "add", "-q", "-b", "task", worktree);
		git(repo, "worktree", "add", "-q", "-b", "task2", worktree2);
		const ran = { submodule: path.join(gitRoot, "ran-submodule"), worktree: path.join(gitRoot, "ran-worktree"), commondir: path.join(gitRoot, "ran-commondir"), worktreeCommondir: path.join(gitRoot, "ran-worktree-commondir") };

		await plantGitFolder(path.join(superproject, ".planted"), submodule, path.join(superproject, ".git", "modules", "lib", "objects"), ran.submodule);
		await refused("edit", { path: path.join(submodule, ".git"), edits: [{ oldText: "../.git/modules/lib", newText: "../.planted" }] }, "a submodule's .git file");
		await refused("write", { path: path.join(submodule, ".git"), content: "gitdir: ../.planted\n" }, "a submodule's .git file");
		await plantGitFolder(path.join(gitRoot, "planted-wt"), worktree, path.join(repo, ".git", "objects"), ran.worktree);
		await refused("write", { path: path.join(worktree, ".git"), content: `gitdir: ${slashes(path.join(gitRoot, "planted-wt"))}\n` }, "a linked worktree's .git file");
		await plantGitFolder(path.join(repo, ".planted"), repo, path.join(repo, ".git", "objects"), ran.commondir);
		await refused("write", { path: path.join(repo, ".git", "commondir"), content: "../.planted\n" }, "a repository's commondir");
		await plantGitFolder(path.join(gitRoot, "planted-common"), worktree2, path.join(repo, ".git", "objects"), ran.worktreeCommondir);
		await refused("write", { path: path.join(repo, ".git", "worktrees", "wt2", "commondir"), content: `${slashes(path.join(gitRoot, "planted-common"))}\n` }, "a linked worktree's commondir");

		for (const [dir, marker, label] of [[superproject, ran.submodule, "the superproject"], [worktree, ran.worktree, "a linked worktree"], [repo, ran.commondir, "a repository"], [worktree2, ran.worktreeCommondir, "a second linked worktree"]] as const) {
			spawnSync("git", ["status", "--short"], { cwd: dir, env: gitEnv });
			assert(!fs.existsSync(marker), `git status in ${label} must run nothing the room wrote`);
		}
	} else {
		console.log("SKIPPED: the real git cases (git is not installed here)");
	}

	// ---- git's names at the top of a folder the room can change -----------
	// git takes a folder for a repository only with a `HEAD` in it, so only
	// git's layout is closed at the top; every git name is, where the folder
	// already holds that layout. Elsewhere `config`, `hooks` and `modules` are
	// a project's own.
	const GIT_NAMES = ["HEAD", "config", "config.worktree", "hooks", "objects", "refs", "packed-refs", "commondir", "gitdir", "worktrees", "modules", "rebase-merge", "rebase-apply", "sequencer"];
	const topRoom = (name: string, alsoAllowed: Array<{ path: string; access: "read" | "write" }> = []) => {
		const root = path.join(home, name);
		fs.mkdirSync(root, { recursive: true });
		const agentId = `top-names-${name}`;
		saveAlsoAllowedFolders(agentId, alsoAllowed);
		const tools: Map<string, any> = new Map(createPersistentRoomWorkspaceTools(createPersistentRoomCapabilityPolicy({ agentId, conversationId: `c_${agentId}`, repoRoot, persistentAgentsRoot, exxetaStateRoot, root, workspaceAccessMode: "localFiles", source: "manual", now: new Date("2026-07-01T00:00:00.000Z") }), { localFilesCwd: root }).map((topTool) => [String(topTool.name), topTool]));
		assert(tools.has("write") && tools.has("edit"), `the room on ${name} must have its own write and edit`);
		const call = async (tool: string, params: Record<string, unknown>): Promise<{ text: string; error?: string }> => {
			try {
				return { text: toolOutput(await tools.get(tool).execute(`smoke-top-${tool}`, params, undefined, undefined, {} as any)) };
			} catch (error) {
				return { text: "", error: (error as Error).message };
			}
		};
		const writes = async (folder: string, rel: string, label: string) => {
			const target = path.join(folder, rel);
			const wrote = await call("write", { path: target, content: "first\n" });
			assert(!wrote.error && fs.readFileSync(target, "utf8") === "first\n", `${label}: a write of ${rel} must land, got ${JSON.stringify(wrote).slice(0, 300)}`);
			const edited = await call("edit", { path: target, edits: [{ oldText: "first", newText: "second" }] });
			assert(!edited.error && fs.readFileSync(target, "utf8") === "second\n", `${label}: an edit of ${rel} must land, got ${JSON.stringify(edited).slice(0, 300)}`);
		};
		const refuses = async (folder: string, rel: string, label: string) => {
			const target = path.join(folder, rel);
			const state = () => {
				let kind: fs.Stats | undefined;
				// A path under a file is nothing: Node 20 says so by throwing ENOTDIR, a later Node by answering nothing.
				try {
					kind = fs.statSync(target, { throwIfNoEntry: false });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
				}
				return kind?.isFile() ? fs.readFileSync(target, "utf8") : kind?.isDirectory() ? "a folder" : "nothing";
			};
			const before = state();
			const wrote = await call("write", { path: target, content: "planted\n" });
			assert(wrote.error?.includes(READ_ONLY), `${label}: a write of ${rel} must be refused as never changed, got ${JSON.stringify(wrote).slice(0, 300)}`);
			assert(state() === before, `${label}: a refused write of ${rel} must leave it as it was`);
		};
		return { root, call, writes, refuses };
	};
	{
		const plain = topRoom("top-plain");
		for (const rel of ["config/settings.yml", "hooks/use-auth.ts", "modules/auth.js"]) await plain.writes(plain.root, rel, "a project's own folder at the top");
		for (const rel of ["HEAD", "head", "objects/x", "refs/x"]) await plain.refuses(plain.root, rel, "git's layout at the top");
		assert(!fs.existsSync(path.join(plain.root, "HEAD")) && !fs.existsSync(path.join(plain.root, "objects")) && !fs.existsSync(path.join(plain.root, "refs")), "no part of git's layout may land at the top");

		for (const [name, layout] of [["top-head", ["HEAD"]], ["top-common", ["objects/", "refs/"]]] as const) {
			const held = topRoom(name);
			for (const entry of layout) {
				if (entry.endsWith("/")) fs.mkdirSync(path.join(held.root, entry), { recursive: true });
				else write(path.join(held.root, entry), "any content\n");
			}
			for (const gitName of GIT_NAMES) {
				await held.refuses(held.root, gitName, `a folder holding ${layout.join(" and ")}`);
				await held.refuses(held.root, `${gitName}/x`, `a folder holding ${layout.join(" and ")}`);
			}
			await held.writes(held.root, "notes.md", `a folder holding ${layout.join(" and ")}`);
		}

		// An Also allowed folder that can be changed is judged by the same rule as the room's own.
		const alsoPlain = path.join(home, "top-also-plain");
		const alsoHead = path.join(home, "top-also-head");
		for (const folder of [alsoPlain, alsoHead]) fs.mkdirSync(folder, { recursive: true });
		write(path.join(alsoHead, "HEAD"), "ref: refs/heads/main\n");
		const withAlso = topRoom("top-with-also", [{ path: alsoPlain, access: "write" }, { path: alsoHead, access: "write" }]);
		for (const rel of ["config/settings.yml", "hooks/use-auth.ts", "modules/auth.js"]) await withAlso.writes(alsoPlain, rel, "an Also allowed folder");
		for (const rel of ["HEAD", "head", "objects/x", "refs/x"]) await withAlso.refuses(alsoPlain, rel, "an Also allowed folder");
		for (const rel of ["config", "hooks/pre-commit", "modules/x"]) await withAlso.refuses(alsoHead, rel, "an Also allowed folder holding HEAD");
		await withAlso.writes(alsoHead, "notes.md", "an Also allowed folder holding HEAD");

		// Where the folder's own git settings may lead git to `config`, `hooks` or `modules` at its top, every git name stays closed there.
		const put = (file: string, text: string) => {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			write(file, text);
		};
		const settings = (text: string, file = "config") => (root: string) => put(path.join(root, ".git", file), text);
		let settingsRooms = 0;
		const closedBySettings = async (label: string, setUp: (root: string) => void) => {
			const room = topRoom(`top-settings-${(settingsRooms += 1)}`);
			setUp(room.root);
			for (const rel of ["config", "hooks/pre-commit", "modules/x"]) await room.refuses(room.root, rel, label);
			await room.writes(room.root, "notes.md", label);
		};
		const openBySettings = async (label: string, setUp: (root: string) => void) => {
			const room = topRoom(`top-settings-${(settingsRooms += 1)}`);
			setUp(room.root);
			for (const rel of ["config/settings.yml", "hooks/use-auth.ts", "modules/auth.js"]) await room.writes(room.root, rel, label);
			for (const rel of ["HEAD", "objects/x", "refs/x"]) await room.refuses(room.root, rel, label);
		};
		const hooksAt = (value: string) => settings(`[core]\n\trepositoryformatversion = 0\n\thooksPath = ${value}\n`);
		{
			// An existing executable hook, as the person's next commit would run it: its edit is refused too.
			const room = topRoom(`top-settings-${(settingsRooms += 1)}`);
			hooksAt("hooks")(room.root);
			put(path.join(room.root, "hooks", "pre-commit"), "exit 0\n");
			fs.chmodSync(path.join(room.root, "hooks", "pre-commit"), 0o755);
			const edited = await room.call("edit", { path: "hooks/pre-commit", edits: [{ oldText: "exit 0", newText: "touch planted" }] });
			assert(edited.error?.includes(READ_ONLY) && fs.readFileSync(path.join(room.root, "hooks", "pre-commit"), "utf8") === "exit 0\n", `a hooks path of hooks: an edit of an existing hook must be refused, got ${JSON.stringify(edited).slice(0, 300)}`);
		}
		await closedBySettings("a hooks path of hooks", hooksAt("hooks"));
		await closedBySettings("an include", settings("[include]\n\tpath = ../config\n"));
		await closedBySettings("an includeIf", settings("[includeIf \"gitdir:~/\"]\n\tpath = ../config\n"));
		await closedBySettings("a hooks path through src/..", (root) => {
			hooksAt("src/../hooks")(root);
			fs.mkdirSync(path.join(root, "src"), { recursive: true });
		});
		const spellings: Array<[string, string]> = [
			["[CORE] HooksPath=hooks", "[CORE] HooksPath=hooks\n"],
			["a quoted value", "[core]\n\thooksPath = \"hooks\"\n"],
			["./hooks", "[core]\n\thooksPath = ./hooks\n"],
			["hooks/sub", "[core]\n\thooksPath = hooks/sub\n"],
			["a trailing slash", "[core]\n\thooksPath = hooks/\n"],
			["another letter case", "[core]\n\thooksPath = HOOKS\n"],
			["no indent", "[core]\nhooksPath = hooks\n"],
			["a comment after the value", "[core]\n\thooksPath = hooks # the project's hooks\n"],
			["a ; comment after the value", "[core]\n\thooksPath = hooks;old\n"],
			["a core section split in two", "[core]\n\tbare = false\n[user]\n\tname = Smoke\n[core]\n\thooksPath = hooks\n"],
			["a line git can't read", "[core]\n\thooksPath\n"],
			["a value that goes on to the next line", "[core]\n\thooksPath = hooks\\\n\t/sub\n"],
			["a modules hooks path", "[core]\n\thooksPath = modules\n"],
			["an unfinished quote", "[core]\n\thooksPath = \"hooks\n"],
			["a value quoted in part", "[core]\n\thooksPath = \"ho\"oks\n"],
			["a space inside the quotes", "[core]\n\thooksPath = \"hooks \"\n"],
			["a trailing dot", "[core]\n\thooksPath = hooks.\n"],
			// Outside the plainest spelling, whatever it names.
			["with a tab inside the quotes", "[core]\n\thooksPath = \".githooks\t\"\n"],
			["with a backslash escape", "[core]\n\thooksPath = \".git\\\\hooks\"\n"],
			["with a $", "[core]\n\thooksPath = $HOME/.githooks\n"],
			["with a %", "[core]\n\thooksPath = %(prefix)/githooks\n"],
			["with a control character", "[core]\n\thooksPath = .git\u0007hooks\n"],
			["with a letter beyond ASCII", "[core]\n\thooksPath = .githööks\n"],
			["empty", "[core]\n\thooksPath =\n"],
			["as empty quotes", "[core]\n\thooksPath = \"\"\n"],
			["twice, with another value", "[core]\n\thooksPath = .githooks\n\thooksPath = .husky/_\n"],
		];
		for (const [label, text] of spellings) await closedBySettings(`a hooks path spelt ${label}`, settings(text));
		await closedBySettings("a hooks path in config.worktree", settings("[core]\n\thooksPath = hooks\n", "config.worktree"));
		await closedBySettings("another hooks path in config.worktree", (root) => {
			hooksAt(".githooks")(root);
			settings("[core]\n\thooksPath = .husky/_\n", "config.worktree")(root);
		});
		await closedBySettings("an absolute hooks path into the folder", (root) => hooksAt(`${root.split(path.sep).join("/")}/hooks`)(root));
		// Any absolute hooks path, or one in the person's home: another spelling can name the folder's own `hooks`.
		await closedBySettings("a hooks path outside the folder", hooksAt(`${tmp.split(path.sep).join("/")}/shared-hooks`));
		await closedBySettings("a hooks path in the home", hooksAt("~/x"));
		// On a Mac the data volume's spelling of the same place, which its real path leaves as it is.
		const dataVolume = "/System/Volumes/Data";
		if (process.platform === "darwin" && fs.existsSync(`${dataVolume}${tmp}`)) {
			await closedBySettings("a hooks path into the folder through the data volume", (root) => hooksAt(`${dataVolume}${root}/hooks`)(root));
		}
		// A key of `worktree` moves the place git starts a relative hooks path from.
		await closedBySettings("a worktree setting", (root) => settings(`[core]\n\tworktree = ${path.dirname(root).split(path.sep).join("/")}\n\thooksPath = ${path.basename(root)}/hooks\n`)(root));
		await closedBySettings("a worktree setting spelt WorkTree=../..", settings("[core]\n\tWorkTree=../..\n"));
		await closedBySettings("a worktree setting after headers on its line", settings("[x \"]a=1\"] [CORE] worktree = ..\n"));
		await closedBySettings("a .git file", (root) => put(path.join(root, ".git"), "gitdir: ../elsewhere/.git\n"));
		await closedBySettings("a .git folder whose settings live where its commondir says", (root) => {
			put(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
			put(path.join(root, ".git", "commondir"), "../elsewhere/.git\n");
		});
		await closedBySettings("a settings file over the limit", settings(`[core]\n${"# filler line for the size limit\n".repeat(3000)}`));
		await closedBySettings("a settings file that is a folder", (root) => fs.mkdirSync(path.join(root, ".git", "config"), { recursive: true }));
		if (links) {
			await closedBySettings("a link at the top that leads to hooks", (root) => {
				hooksAt("githooks")(root);
				fs.mkdirSync(path.join(root, "hooks"), { recursive: true });
				fs.symlinkSync("hooks", path.join(root, "githooks"), "dir");
			});
			await closedBySettings("a quoted hooks path that starts with a space, a link at the top that leads to hooks", (root) => {
				settings("[core]\n\thooksPath = \" githooks\"\n")(root);
				fs.mkdirSync(path.join(root, "hooks"), { recursive: true });
				fs.symlinkSync("hooks", path.join(root, " githooks"), "dir");
			});
			// git walks `x/L/..` on the disk: with `x/L` a link to the top's `src`, that is the top, and the hooks path is the top's `hooks`.
			await closedBySettings("a hooks path through a link and ..", (root) => {
				hooksAt("x/L/../hooks")(root);
				fs.mkdirSync(path.join(root, "src"), { recursive: true });
				fs.mkdirSync(path.join(root, "x"), { recursive: true });
				fs.symlinkSync(path.join("..", "src"), path.join(root, "x", "L"), "dir");
			});
			const elsewhere = path.join(tmp, "settings-elsewhere");
			put(path.join(elsewhere, ".git", "config"), "[core]\n\tbare = false\n");
			await closedBySettings("a .git that is a link", (root) => fs.symlinkSync(path.join(elsewhere, ".git"), path.join(root, ".git"), "dir"));
			await closedBySettings("a settings file that is a link", (root) => {
				fs.mkdirSync(path.join(root, ".git"), { recursive: true });
				fs.symlinkSync(path.join(elsewhere, ".git", "config"), path.join(root, ".git", "config"));
			});
		}
		if (process.platform !== "win32" && process.getuid?.() !== 0) {
			await closedBySettings("a settings file that can't be read", (root) => {
				settings("[core]\n\tbare = false\n")(root);
				fs.chmodSync(path.join(root, ".git", "config"), 0o000);
			});
		}
		await openBySettings("a husky hooks path", hooksAt(".husky/_"));
		await openBySettings("a .githooks hooks path", hooksAt(".githooks"));
		await openBySettings("a quoted husky hooks path", settings("[core]\n\thooksPath = \".husky/_\"\n"));
		await openBySettings("the same .githooks hooks path twice", settings("[core]\n\thooksPath = .githooks\n[core]\n\thooksPath = \".githooks\"\n"));
		await openBySettings("a quoted .githooks hooks path with a comment", settings("[core]\n\thooksPath = \".githooks\" # the project's hooks\n"));
		await openBySettings("an extensions.worktreeConfig setting", settings("[core]\n\tbare = false\n[extensions]\n\tworktreeConfig = true\n"));
		await openBySettings("a value that holds the word worktree", settings("[remote \"origin\"]\n\turl = https://example.invalid/worktree.git\n"));
		await openBySettings("settings with no hooks path", settings("[core]\n\trepositoryformatversion = 0\n\tbare = false\n[remote \"origin\"]\n\turl = https://example.invalid/hooks.git\n"));
		await openBySettings("a .git folder with no settings", (root) => fs.mkdirSync(path.join(root, ".git"), { recursive: true }));

		// An Also allowed folder is judged by its own `.git`.
		const alsoHooks = path.join(home, "top-also-hooks");
		const alsoHusky = path.join(home, "top-also-husky");
		hooksAt("hooks")(alsoHooks);
		hooksAt(".husky/_")(alsoHusky);
		const withAlsoSettings = topRoom("top-with-also-settings", [{ path: alsoHooks, access: "write" }, { path: alsoHusky, access: "write" }]);
		for (const rel of ["config", "hooks/pre-commit", "modules/x"]) await withAlsoSettings.refuses(alsoHooks, rel, "an Also allowed folder with a hooks path of hooks");
		for (const rel of ["config/settings.yml", "hooks/use-auth.ts", "modules/auth.js"]) await withAlsoSettings.writes(alsoHusky, rel, "an Also allowed folder with a husky hooks path");
		await withAlsoSettings.writes(withAlsoSettings.root, "hooks/use-auth.ts", "the room's own folder beside them");
	}

	// ---- what the top-level names are for, with the real git -----------------
	if (spawnSync("git", ["--version"]).status === 0) {
		const gitRoot = path.join(tmp, "git-top");
		fs.mkdirSync(gitRoot, { recursive: true });
		write(path.join(gitRoot, "gitconfig"), "");
		const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(gitRoot, "gitconfig"), GIT_CEILING_DIRECTORIES: tmp };
		const gitIn = (cwd: string, ...args: string[]) => spawnSync("git", ["-c", "user.email=smoke@test", "-c", "user.name=Smoke", ...args], { cwd, env: gitEnv, encoding: "utf8" });
		const slashes = (file: string) => file.split(path.sep).join("/");
		// git runs the program through the shell with its own arguments after it: the `#` keeps them from it.
		const planted = (marker: string, worktree?: string) => `[core]\n\trepositoryformatversion = 0\n${worktree ? `\tbare = false\n\tworktree = ${slashes(worktree)}\n` : ""}\tfsmonitor = "touch ${slashes(marker)} #"\n`;

		// A folder with git's settings, hooks, objects and refs but no HEAD is no repository, and git runs nothing from it.
		const noHead = path.join(gitRoot, "no-head");
		const tree = path.join(gitRoot, "no-head-tree");
		const marker = path.join(gitRoot, "ran-no-head");
		for (const dir of ["hooks", "objects", "refs/heads"]) fs.mkdirSync(path.join(noHead, dir), { recursive: true });
		fs.mkdirSync(tree, { recursive: true });
		write(path.join(noHead, "config"), planted(marker, tree));
		for (const args of [["status"], ["log"]]) {
			const ran = gitIn(noHead, ...args);
			assert(ran.status !== 0 && /not a git repository/i.test(ran.stderr), `git ${args[0]} in a folder with no HEAD must say it is no repository, got ${JSON.stringify(ran.stderr)}`);
			assert(!fs.existsSync(marker), `git ${args[0]} in a folder with no HEAD must run nothing from its config`);
		}
		write(path.join(noHead, "HEAD"), "ref: refs/heads/main\n");
		gitIn(noHead, "status");
		assert(fs.existsSync(marker), "the control: with a HEAD added, git status must run the program its config names");

		// A common directory with no HEAD: a linked worktree elsewhere reads its config, so a room on it keeps every git name closed.
		const source = path.join(gitRoot, "source");
		fs.mkdirSync(source, { recursive: true });
		for (const args of [["init", "-q", "-b", "main"], ["commit", "-q", "--allow-empty", "-m", "a"]]) assert(gitIn(source, ...args).status === 0, `git ${args[0]} in the source`);
		const common = path.join(home, "top-linked-common");
		const linked = path.join(gitRoot, "linked");
		assert(gitIn(gitRoot, "clone", "-q", "--bare", source, common).status === 0, "git clone --bare");
		assert(gitIn(gitRoot, `--git-dir=${common}`, "worktree", "add", "-q", "-b", "task", linked).status === 0, "git worktree add");
		fs.rmSync(path.join(common, "HEAD"));
		const linkedMarker = path.join(gitRoot, "ran-linked");
		const onCommon = topRoom("top-linked-common");
		const config = fs.readFileSync(path.join(common, "config"), "utf8");
		const edited = await onCommon.call("edit", { path: "config", edits: [{ oldText: "[core]", newText: planted(linkedMarker).trimEnd() }] });
		assert(edited.error?.includes(READ_ONLY) && fs.readFileSync(path.join(common, "config"), "utf8") === config, `an edit of a common directory's config must be refused, got ${JSON.stringify(edited).slice(0, 300)}`);
		await onCommon.refuses(common, "config", "a common directory with no HEAD");
		await onCommon.refuses(common, "hooks/pre-commit", "a common directory with no HEAD");
		await onCommon.writes(common, "notes.md", "a common directory with no HEAD");
		assert(gitIn(linked, "status", "--short").status === 0 && !fs.existsSync(linkedMarker), "git status in the linked worktree must run nothing the room wrote");
		write(path.join(common, "config"), `${config}${planted(linkedMarker)}`);
		gitIn(linked, "status", "--short");
		assert(fs.existsSync(linkedMarker), "the control: a common directory's config naming a program, with no HEAD there, runs it in the linked worktree");

		// A working repository whose own settings lead git to the top's `hooks` or `config`: the room can't plant
		// what git then runs, and the controls show git runs it when the same file is written by hand.
		const hook = (marker: string) => `#!/bin/sh\ntouch ${slashes(marker)}\n`; // portability-ok: git runs a hook through its own sh, Git for Windows' too
		const plantHook = (file: string, marker: string) => {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			write(file, hook(marker));
			fs.chmodSync(file, 0o755);
		};
		// A hooks path that starts with a space names the link ` githooks`, which leads to `hooks`.
		// `x/L/../hooks` with `x/L` a link to the top's `src`: git walks the `..` on the disk, to the top's `hooks`.
		const hooksPaths: Array<[string, string]> = [["top-git-hooks", "hooks"], ["top-git-src-up", "src/../hooks"], ...(links ? [["top-git-spaced-link", " githooks"], ["top-git-link-up", "x/L/../hooks"]] as Array<[string, string]> : [])];
		for (const [name, hooksPath] of hooksPaths) {
			const room = topRoom(name);
			assert(gitIn(room.root, "init", "-q", "-b", "main").status === 0 && gitIn(room.root, "config", "core.hooksPath", hooksPath).status === 0, `git init and the hooks path ${hooksPath}`);
			fs.mkdirSync(path.join(room.root, "src"), { recursive: true });
			fs.mkdirSync(path.join(room.root, "hooks"), { recursive: true });
			if (hooksPath.startsWith(" ")) fs.symlinkSync("hooks", path.join(room.root, hooksPath), "dir");
			if (hooksPath.startsWith("x/L/")) {
				fs.mkdirSync(path.join(room.root, "x"));
				fs.symlinkSync(path.join("..", "src"), path.join(room.root, "x", "L"), "dir");
			}
			const ranHook = path.join(gitRoot, `ran-${name}`);
			const wrote = await room.call("write", { path: "hooks/pre-commit", content: hook(ranHook) });
			assert(wrote.error?.includes(READ_ONLY) && !fs.existsSync(path.join(room.root, "hooks", "pre-commit")), `a hooks path of ${hooksPath}: a room's hook must be refused, got ${JSON.stringify(wrote).slice(0, 300)}`);
			gitIn(room.root, "commit", "-q", "--allow-empty", "-m", "a");
			assert(!fs.existsSync(ranHook), `a hooks path of ${hooksPath}: a commit must run nothing the room wrote`);
			plantHook(path.join(room.root, "hooks", "pre-commit"), ranHook);
			gitIn(room.root, "commit", "-q", "--allow-empty", "-m", "b");
			if (process.platform === "win32" && hooksPath.startsWith("x/L/")) console.log(`SKIPPED: not yet on a real Windows PC: the control for a hooks path of ${hooksPath} (git there reads the .. by its text, not through the link)`);
			else assert(fs.existsSync(ranHook), `the control: with a hooks path of ${hooksPath}, a commit runs the top's hooks/pre-commit`);
		}
		{
			const room = topRoom("top-git-include");
			assert(gitIn(room.root, "init", "-q", "-b", "main").status === 0 && gitIn(room.root, "config", "include.path", "../config").status === 0, "git init and the include");
			const ranInclude = path.join(gitRoot, "ran-include");
			const included = `[core]\n\tfsmonitor = "touch ${slashes(ranInclude)} #"\n`;
			const wrote = await room.call("write", { path: "config", content: included });
			assert(wrote.error?.includes(READ_ONLY) && !fs.existsSync(path.join(room.root, "config")), `an include of ../config: a room's config must be refused, got ${JSON.stringify(wrote).slice(0, 300)}`);
			gitIn(room.root, "status", "--short");
			assert(!fs.existsSync(ranInclude), "an include of ../config: git status must run nothing the room wrote");
			write(path.join(room.root, "config"), included);
			gitIn(room.root, "status", "--short");
			assert(fs.existsSync(ranInclude), "the control: with an include of ../config, git status runs the program the top's config names");
		}
		{
			// A plain `.git` folder whose `commondir` sends git to settings kept elsewhere, with a hooks path of `hooks` there.
			const room = topRoom("top-git-commondir");
			const common = path.join(gitRoot, "moved-common");
			assert(gitIn(room.root, "init", "-q", "-b", "main").status === 0, "git init for the commondir row");
			fs.renameSync(path.join(room.root, ".git"), common);
			fs.mkdirSync(path.join(room.root, ".git"));
			write(path.join(room.root, ".git", "HEAD"), fs.readFileSync(path.join(common, "HEAD"), "utf8"));
			write(path.join(room.root, ".git", "commondir"), `${slashes(common)}\n`);
			assert(gitIn(room.root, `--git-dir=${common}`, "config", "core.hooksPath", "hooks").status === 0, "the hooks path in the common directory");
			const ranCommon = path.join(gitRoot, "ran-commondir");
			const wrote = await room.call("write", { path: "hooks/pre-commit", content: hook(ranCommon) });
			assert(wrote.error?.includes(READ_ONLY) && !fs.existsSync(path.join(room.root, "hooks", "pre-commit")), `a commondir with a hooks path of hooks: a room's hook must be refused, got ${JSON.stringify(wrote).slice(0, 300)}`);
			gitIn(room.root, "commit", "-q", "--allow-empty", "-m", "a");
			assert(!fs.existsSync(ranCommon), "a commondir with a hooks path of hooks: a commit must run nothing the room wrote");
			plantHook(path.join(room.root, "hooks", "pre-commit"), ranCommon);
			gitIn(room.root, "commit", "-q", "--allow-empty", "-m", "b");
			assert(fs.existsSync(ranCommon), "the control: through a commondir with a hooks path of hooks, a commit runs the top's hooks/pre-commit");
		}
	} else {
		console.log("SKIPPED: the real git cases for git's names at the top (git is not installed here)");
	}

	// ---- ls --------------------------------------------------------------
	const lsProject = await run("ls", {});
	assert(!lsProject.error, `ls . must work: ${lsProject.error}`);
	const lsEntries = lsProject.text.split("\n");
	for (const hidden of [".env", ".env.local", "server.pem", ".envrc", ...(links ? ["dangling"] : [])]) assert(!lsEntries.includes(hidden), `ls must leave out ${hidden}`);
	for (const shown of ["notes.md", ".env.example", ".env.dist", ".mcp.json", ".git/", "sub/", ".npmrc", ".husky/"]) assert(lsEntries.includes(shown), `ls must keep ${shown}`);
	assert((await run("ls", { path: "nested" })).text.split("\n").includes(".mcp.json/"), "ls must keep a folder named .mcp.json");
	assert(/\n\d+ entries left out: secret files or the app's own data\.$/.test(lsProject.text.trimEnd()), `ls of a folder holding .env must end with the count line, got ${JSON.stringify(lsProject.text.slice(-200))}`);
	const lsClean = await run("ls", { path: "docs" });
	assert(lsClean.text.includes("environ") && !lsClean.text.includes("left out"), `ls of a folder with nothing closed must add no line, got ${JSON.stringify(lsClean.text)}`);
	fs.mkdirSync(path.join(project, "only-secrets"), { recursive: true });
	write(path.join(project, "only-secrets", ".env"), "TOKEN=needle\n");
	const lsOnlySecrets = await run("ls", { path: "only-secrets" });
	assert(lsOnlySecrets.text.trimEnd() !== "(empty directory)" && lsOnlySecrets.text.trimEnd().endsWith(`1 entry ${LEFT_OUT}`), `ls of a folder holding only .env must not answer empty alone, got ${JSON.stringify(lsOnlySecrets.text)}`);
	if (links) {
		const lsSub = await run("ls", { path: "sub" });
		const lsSubEntries = lsSub.text.split("\n");
		assert(lsSubEntries.includes("link-to-key@") && lsSubEntries.includes("link-to-state@") && !lsSub.text.includes("secret.json"), `ls must mark links to secrets and not follow them, got ${JSON.stringify(lsSub.text)}`);
		await refused("ls", { path: "sub/link-to-state" }, "a link to the app's folder");
	}
	// The home folder holds the app's data, so no room's folder or allowed folder is ever above it.
	await refused("ls", { path: "~" }, "the home folder");
	await refused("ls", { path: "~/.aws" }, "the AWS folder");
	await refused("ls", { path: "~/.exxperts" }, "the app's folder");

	// ---- find and grep (the native fd and ripgrep; smokes never download) --
	{
		const findAll = await run("find", { pattern: "*", path: "." });
		assert(!findAll.error, `find . must work: ${findAll.error}`);
		const findLines = findAll.text.split("\n");
		for (const hidden of [".env", ".env.local", "server.pem", ".envrc"]) assert(!findLines.includes(hidden), `find must leave out ${hidden}`);
		for (const shown of ["notes.md", ".env.example", ".npmrc"]) assert(findLines.includes(shown), `find must keep ${shown}`);
		await refused("find", { pattern: "*", path: "~" }, "from the home folder");
		const findEnv = await run("find", { pattern: ".env*" });
		assert(JSON.stringify(findEnv.text.split("\n").filter((line) => line.startsWith(".env")).sort()) === JSON.stringify([".env.dist", ".env.example"]) && endsLeftOut(findEnv.text), `find .env* must show only the templates and count what it left out, got ${JSON.stringify(findEnv.text)}`);
		const findClean = await run("find", { pattern: "*", path: "docs" });
		assert(findClean.text.includes("environ") && !findClean.text.includes("left out"), `find in a folder with nothing closed must add no line, got ${JSON.stringify(findClean.text)}`);
		await refused("find", { pattern: "*", path: "~/.exxperts" }, "in the app's folder");
		const findBulk = await run("find", { pattern: "*.pem", path: bulkDir, limit: 10 });
		assert(endsLeftOut(findBulk.text, 30), `find must not claim no files alone when it left the files out, got ${JSON.stringify(findBulk.text)}`);
	}
	{
		const grepAll = await run("grep", { pattern: "needle", path: "." });
		assert(!grepAll.error, `grep . must work: ${grepAll.error}`);
		for (const hidden of [".env:", "server.pem", ".envrc", ".env.big", "big.jsonl", "needle-local"]) assert(!grepAll.text.includes(hidden), `grep must leave out ${hidden}`);
		assert(grepAll.text.includes("notes.md:1") && grepAll.text.includes(".env.example:1") && !grepAll.text.includes(".git/"), `grep . must keep normal files and templates and leave the git folder for a search inside it, got ${JSON.stringify(grepAll.text)}`);
		const grepGitFolder = await run("grep", { pattern: "needle", path: ".git" });
		assert(grepGitFolder.text.includes(".git/HEAD:1") && grepGitFolder.text.includes(".git/config:") && grepGitFolder.text.includes(".git/hooks/pre-commit:1"), `grep in .git must search its hooks and settings, got ${JSON.stringify(grepGitFolder.text.slice(0, 600))}`);
		assert(endsLeftOut(grepAll.text), `grep . must end with the count of what it left out, got ${JSON.stringify(grepAll.text.slice(-300))}`);
		await refused("grep", { pattern: "needle", path: "~" }, "from the home folder");
		const grepGlob = await run("grep", { pattern: "needle", glob: ".env" });
		assert(grepGlob.text.startsWith("No matches found") && endsLeftOut(grepGlob.text), `grep with a .env glob must not say "No matches found" alone while it left the .env files out, got ${JSON.stringify(grepGlob.text)}`);
		const grepClean = await run("grep", { pattern: "kindmark", path: "docs" });
		assert(grepClean.text.includes("environ:1") && !grepClean.text.includes("left out"), `grep in a folder with nothing closed must add no line, got ${JSON.stringify(grepClean.text)}`);
		await refused("grep", { pattern: "needle", path: ".env" }, "a .env path");
		await refused("grep", { pattern: "needle", path: "~/.exxperts" }, "the app's folder");
		for (const [label, searchPath] of [["a hidden file with 200,000 matches", "."]] as const) {
			const started = Date.now();
			const timed = await run("grep", { pattern: "needle", path: searchPath });
			const elapsed = Date.now() - started;
			assert(timed.text.includes("notes.md:1") && !timed.text.includes(".env.big") && !timed.text.includes("big.jsonl"), `grep past ${label} must keep only visible matches`);
			assert(elapsed < 3000, `grep past ${label} must stay fast, took ${elapsed} ms`);
		}
	}

	// ---- Keynote decks open, `.key` files that are not zips stay closed ----
	// Keynote saves a deck as a folder or as one zip, both named `*.key`.
	const decks = path.join(project, "decks");
	for (const dir of [path.join(decks, "deck.key", "Index"), path.join(decks, "deck.key", "Metadata"), path.join(decks, "acme.key")]) fs.mkdirSync(dir, { recursive: true });
	write(path.join(decks, "deck.key", "Index", "Document.iwa"), "iwa bytes\n");
	write(path.join(decks, "deck.key", "Metadata", "Properties.plist"), "<plist>keynoteword</plist>\n");
	write(path.join(decks, "acme.key", "notes.md"), "acme keynoteword\n");
	fs.writeFileSync(path.join(decks, "deck-file.key"), storedZip("Index/Slide.iwa", "slide keynoteword\n"));
	const keys = path.join(project, "keys");
	fs.mkdirSync(path.join(keys, "x.key"), { recursive: true });
	// Built from parts, so the secret scan does not take the fakes for keys.
	const fakeKey = (kind: string) => `${["-----BEGIN", ...(kind ? [kind] : []), "PRIVATE", "KEY-----"].join(" ")}\nneedle\n`;
	const closedKeys: Array<[string, string | Buffer]> = [
		["server.key", fakeKey("")],
		["rsa.key", fakeKey("RSA")],
		["openssh.key", fakeKey("OPENSSH")],
		["der.key", Buffer.concat([Buffer.from([0x30, 0x82, 0x04, 0xa4]), Buffer.from("needle\n")])],
		["license.key", "LICENSE needle\n"],
		["UPPER.KEY", fakeKey("")],
		[path.join("x.key", "inner.key"), fakeKey("")],
	];
	for (const [name, content] of closedKeys) fs.writeFileSync(path.join(keys, name), content);
	write(path.join(keys, "x.key", "readme.md"), "x keynoteword\n");
	if (links) fs.symlinkSync(path.join(keys, "server.key"), path.join(keys, "deck-link.key"));
	await open("read", { path: "decks/deck.key/Metadata/Properties.plist" }, "keynoteword", "a file inside a deck saved as a folder");
	await open("read", { path: "decks/deck-file.key" }, "keynoteword", "a deck saved as one zip");
	await open("read", { path: "decks/acme.key/notes.md" }, "acme keynoteword", "a file in a folder named *.key");
	await open("read", { path: "keys/x.key/readme.md" }, "x keynoteword", "a file beside a key in a folder named *.key");
	await open("write", { path: "decks/acme.key/notes.md", content: "acme keynoteword changed\n", overwrite: true }, "", "a file in a folder named *.key");
	assert(fs.readFileSync(path.join(decks, "acme.key", "notes.md"), "utf8") === "acme keynoteword changed\n", "a write into a folder named *.key must land");
	const lsDecks = await run("ls", { path: "decks" });
	assert(["deck.key/", "acme.key/", "deck-file.key"].every((entry) => lsDecks.text.split("\n").includes(entry)) && !lsDecks.text.includes("left out"), `ls must list both decks and the folder with no left-out line, got ${JSON.stringify(lsDecks)}`);
	assert((await run("ls", { path: "decks/deck.key" })).text.split("\n").includes("Metadata/"), "ls must open a deck saved as a folder");
	const closedNames = [...closedKeys.map(([name]) => name).filter((name) => !name.includes(path.sep)), ...(links ? ["deck-link.key"] : [])];
	for (const name of closedNames) {
		await refused("read", { path: `keys/${name}` }, `the .key file ${name}`);
		await refused("write", { path: `keys/${name}`, content: "x" }, `the .key file ${name}`);
	}
	await refused("read", { path: "keys/x.key/inner.key" }, "a key inside a folder named *.key");
	await refused("write", { path: "keys/new.key", content: "x" }, "a new .key file");
	assert(!fs.existsSync(path.join(keys, "new.key")), "a refused write must not create a .key file");
	assert(fs.readFileSync(path.join(keys, "server.key"), "utf8").includes("BEGIN PRIVATE KEY"), "refused writes must leave the keys alone");
	if (process.platform === "win32") {
		await refused("read", { path: "keys/server.key." }, "a key named with a trailing dot");
		await refused("read", { path: "keys/server.key " }, "a key named with a trailing space");
		await refusedAsPlace("read", { path: "keys/server.key::$DATA" }, "a key named by its data stream");
	} else {
		console.log("SKIPPED: the trailing dot, space and stream key names (only Windows opens them as the key)");
	}
	const lsKeys = await run("ls", { path: "keys" });
	assert(lsKeys.text.split("\n").includes("x.key/") && closedNames.every((name) => !lsKeys.text.split("\n").includes(name)) && lsKeys.text.trimEnd().endsWith(`${closedNames.length} entries ${LEFT_OUT}`), `ls must leave out every closed .key file and count them, got ${JSON.stringify(lsKeys)}`);
	{
		const findDecks = await run("find", { pattern: "*.key", path: "decks" });
		assert(findDecks.text.includes("deck.key") && findDecks.text.includes("deck-file.key") && !findDecks.text.includes("left out"), `find *.key must list both decks, got ${JSON.stringify(findDecks)}`);
		const findKeys = await run("find", { pattern: "*.key", path: "keys" });
		assert(closedNames.every((name) => !findKeys.text.split("\n").includes(name)) && endsLeftOut(findKeys.text, closedKeys.length + (links ? 1 : 0)), `find *.key must leave out the keys and say so, got ${JSON.stringify(findKeys)}`);
	}
	{
		const grepDecks = await run("grep", { pattern: "keynoteword", path: "decks" });
		assert(grepDecks.text.includes("deck.key/Metadata/Properties.plist:1") && grepDecks.text.includes("acme.key/notes.md:1") && !grepDecks.text.includes("left out"), `grep must reach the words inside the decks, got ${JSON.stringify(grepDecks)}`);
		const grepKeys = await run("grep", { pattern: "needle", path: "keys" });
		assert(!grepKeys.text.includes("needle") && endsLeftOut(grepKeys.text), `grep must leave out the keys and say so, got ${JSON.stringify(grepKeys)}`);
	}
	// A zip named `*.key` opens whatever it holds, as any zip does: the room
	// gets the zip's bytes.
	fs.writeFileSync(path.join(decks, "bundle.key"), storedZip("server.key", fakeKey("").replace("needle", "zipped")));
	await open("read", { path: "decks/bundle.key" }, "zipped", "a zip named *.key that holds a key");

	// ---- no room changes a skill, wherever the agent folder lives ---------
	// A moved agent folder is the app's data as the ordinary one is, so the model reads the same sentence for both.
	for (const [where, agentDir] of [["at its ordinary place", path.join(home, ".exxperts", "agent")], ["moved", path.join(tmp, "opt", "agent")]] as const) {
		const skill = path.join(agentDir, "skills", "guide");
		fs.mkdirSync(skill, { recursive: true });
		write(path.join(skill, "SKILL.md"), "---\nname: guide\n---\n");
		write(path.join(skill, "provenance.json"), "{\"source\":\"upload\"}\n");
		if (where === "moved") process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
		for (const [name, params, label] of [
			["write", { path: path.join(skill, "provenance.json"), content: "{}\n" }, "writing a skill's provenance.json"],
			["edit", { path: path.join(skill, "provenance.json"), edits: [{ oldText: "upload", newText: "local" }] }, "editing a skill's provenance.json"],
			["write", { path: path.join(agentDir, "skills", "made-here", "provenance.json"), content: "{}\n" }, "writing provenance.json into a new skill"],
			["write", { path: path.join(skill, "SKILL.md"), content: "---\nname: guide\n---\nchanged\n" }, "writing a skill's SKILL.md"],
			["write", { path: path.join(agentDir, "skills", "made-here", "notes.md"), content: "notes\n" }, "writing a new skill's notes"],
		] as const) {
			const outcome = await run(name, params);
			assert(outcome.error === skillsFolderRefusal(params.path), `${name} ${label} with the agent folder ${where} must be refused as the app's skills folder, got ${JSON.stringify(outcome).slice(0, 300)}`);
		}
		assert(fs.readFileSync(path.join(skill, "provenance.json"), "utf8") === "{\"source\":\"upload\"}\n" && fs.readFileSync(path.join(skill, "SKILL.md"), "utf8") === "---\nname: guide\n---\n" && !fs.existsSync(path.join(agentDir, "skills", "made-here")), `refused writes must leave the skills alone with the agent folder ${where}`);
	}
	await open("write", { path: "provenance.json", content: "{\"project\":true}\n" }, "", "a project's own provenance.json");
	assert(fs.readFileSync(path.join(project, "provenance.json"), "utf8") === "{\"project\":true}\n", "a project's own provenance.json must stay writable");
	delete process.env.EXXPERTS_CODING_AGENT_DIR;

	// ---- a relative path resolves from the room's folder, whatever the session's cwd
	const elsewhere = new Map(createPersistentRoomWorkspaceTools(policy, { localFilesCwd: repoRoot }).map((tool) => [String(tool.name), tool as any]));
	const atRepo = { cwd: repoRoot };
	assert(toolOutput(await elsewhere.get("read").execute("smoke-ctx-read", { path: "notes.md" }, undefined, undefined, atRepo)).includes("hi needle"), "read must resolve from the room's folder, not the session's cwd");
	let ctxRefusal = "";
	try {
		await elsewhere.get("read").execute("smoke-ctx-env", { path: "../project/.env" }, undefined, undefined, atRepo);
	} catch (error) {
		ctxRefusal = (error as Error).message;
	}
	assert(ctxRefusal.includes(REFUSAL), "a relative path must be checked from the same folder the tool reads from");

	// ---- a grant that no longer matches its folder keeps the floor --------
	const storeRoomDefault = (agentId: string, root: string, workspaceAccessMode: "localFiles" | "bounded") => writePersistentRoomDefaultCapabilityPolicy(createPersistentRoomCapabilityPolicy({
		agentId,
		conversationId: PERSISTENT_ROOM_WORKSPACE_DEFAULT_CONVERSATION_ID,
		repoRoot,
		persistentAgentsRoot,
		exxetaStateRoot,
		root,
		workspaceAccessMode,
		source: "manual",
		now: new Date("2026-07-01T00:00:00.000Z"),
	}));
	const grantCases: Array<{ agentId: string; label: string; probe: string }> = [];
	if (links) {
		const swapped = path.join(home, "swapped");
		fs.mkdirSync(swapped);
		storeRoomDefault("floor-swap-room", swapped, "localFiles");
		fs.rmSync(swapped, { recursive: true });
		fs.symlinkSync(path.join(home, ".exxperts"), swapped, "dir");
		grantCases.push({ agentId: "floor-swap-room", label: "a folder swapped for a link into the app's folder", probe: "app/secret.json" });
	}
	const moved = path.join(home, "Moved");
	fs.mkdirSync(moved);
	storeRoomDefault("floor-moved-room", moved, "localFiles");
	fs.renameSync(moved, path.join(home, "moved-step"));
	fs.renameSync(path.join(home, "moved-step"), path.join(home, "moved"));
	if (fs.existsSync(moved)) grantCases.push({ agentId: "floor-moved-room", label: "a folder renamed by case", probe: "~/.exxperts/app/secret.json" });
	else console.log("SKIPPED: the case-rename grant (this disk is case-sensitive, so the renamed folder is simply gone)");
	for (const grantCase of grantCases) {
		const effective = resolvePersistentRoomEffectiveWorkspacePolicy(grantCase.agentId, "c_grant_mismatch");
		assert(effective.workspaceToolsEnabled && effective.policy, `${grantCase.label}: the room still gets its file tools`);
		const sessionCwd = persistentRoomRuntimeCwdForEffectiveWorkspacePolicy(effective, repoRoot);
		const wrapped = createPersistentRoomWorkspaceTools(effective.policy, { localFilesCwd: sessionCwd });
		assert(wrapped.map((wrappedTool) => String(wrappedTool.name)).sort().join(",") === [...effective.allowedToolNames].sort().join(","), `${grantCase.label}: every native file tool the room gets must be wrapped`);
		let grantRefusal = "";
		try {
			await wrapped.find((wrappedTool) => wrappedTool.name === "read")!.execute("smoke-grant", { path: grantCase.probe }, undefined, undefined, { cwd: sessionCwd } as any);
		} catch (error) {
			grantRefusal = (error as Error).message;
		}
		// The folder no longer matches the one the person chose, so nothing opens until they choose again.
		assert(grantRefusal === ROOM_FOLDER_MOVED, `${grantCase.label}: the room must open nothing, got ${JSON.stringify(grantRefusal)}`);
	}

	// ---- bounded rooms: templates open, credential files closed -----------
	const boundedTools = (root: string) => new Map(createPersistentRoomWorkspaceTools(createPersistentRoomCapabilityPolicy({
		agentId: "localfiles-secret-floor-smoke-room",
		conversationId: "c_localfiles_secret_floor_smoke_bounded",
		repoRoot,
		persistentAgentsRoot,
		exxetaStateRoot,
		root,
		workspaceAccessMode: "bounded",
		source: "manual",
		now: new Date("2026-07-01T00:00:00.000Z"),
	})).map((boundedTool) => [String(boundedTool.name), boundedTool]));
	const runBounded = async (tools: Map<string, any>, name: string, params: Record<string, unknown>) => {
		try {
			return { text: toolOutput(await tools.get(name).execute(`smoke-bounded-${name}`, params, undefined, undefined, {} as any)) };
		} catch (error) {
			return { text: "", error: (error as Error).message };
		}
	};
	const inProject = boundedTools(project);
	assert((await runBounded(inProject, "read", { path: ".env.example" })).text.includes("needle-template"), "a bounded room must read a .env template");
	assert((await runBounded(inProject, "read", { path: ".env" })).error?.includes(REFUSAL), "a bounded room must still refuse .env");
	const boundedLs = (await runBounded(inProject, "ls", {})).text;
	assert(boundedLs.includes(".env.example") && !/(^|\n)\.env(\n|$)/.test(boundedLs), `bounded ls must show the template and hide .env, got ${JSON.stringify(boundedLs)}`);
	const boundedGrep = await runBounded(inProject, "grep", { pattern: "needle" });
	assert(boundedGrep.text.includes(".env.example:1") && !boundedGrep.text.includes(".env:1"), `bounded grep must search the template and skip .env, got ${JSON.stringify(boundedGrep.text)}`);
	const caseWrite = await runBounded(inProject, "write", { path: ".ENV", content: "x", overwrite: true });
	assert(caseWrite.error?.includes(REFUSAL) && fs.readFileSync(path.join(project, ".env"), "utf8") === "TOKEN=needle\n", "a bounded write of .ENV must not overwrite .env");
	assert((await runBounded(inProject, "read", { path: ".envrc" })).error?.includes(REFUSAL), "a bounded room must refuse .envrc");
	assert((await runBounded(inProject, "read", { path: ".env.dist" })).text.includes("kindmark .env.dist"), "a bounded room must read a .env.dist template");
	// The same fence as Full access: a project's .mcp.json reads and never changes.
	assert((await runBounded(inProject, "read", { path: ".mcp.json" })).text.includes("kindmark .mcp.json"), "a bounded room reads a project's .mcp.json");
	const boundedMcpWrite = await runBounded(inProject, "write", { path: ".mcp.json", content: "x", overwrite: true });
	assert(boundedMcpWrite.error?.includes(READ_ONLY) && fs.readFileSync(path.join(project, ".mcp.json"), "utf8") === "kindmark .mcp.json\n", `a bounded room must not write a project's .mcp.json, got ${JSON.stringify(boundedMcpWrite)}`);
	assert((await runBounded(inProject, "ls", {})).text.split("\n").includes(".mcp.json"), "bounded ls shows a project's .mcp.json");
	for (const rel of [".husky/pre-commit", ".npmrc", ".yarnrc.yml", ".profile"]) {
		assert((await runBounded(inProject, "read", { path: rel })).text.includes(`kindmark ${rel}`), `a bounded room must read a project's ${rel}`);
		const boundedWrite = await runBounded(inProject, "write", { path: rel, content: "x", overwrite: true });
		assert(boundedWrite.error?.includes(READ_ONLY) && fs.readFileSync(path.join(project, rel), "utf8") === `kindmark ${rel}\n`, `a bounded room must not write a project's ${rel}, got ${JSON.stringify(boundedWrite)}`);
	}
	assert((await runBounded(inProject, "read", { path: ".git/config" })).text.length > 0, "a bounded room reads .git, which its stored policy still lists");
	assert(/\d+ entries left out/.test((await runBounded(inProject, "ls", {})).text), "bounded ls must say what it left out");
	assert(!(await runBounded(inProject, "ls", { path: "docs" })).text.includes("left out"), "bounded ls of a folder with nothing closed must add no line");
	const inDotfiles = boundedTools(path.join(home, "dotfiles"));
	if (links) {
		// The home folder's .bashrc links into this project, so it holds a place no room opens: no room may have it as its folder.
		for (const rel of [".zshrc", ".bashrc"]) assert((await runBounded(inDotfiles, "read", { path: rel })).error === ROOM_FOLDER_REFUSED, `a bounded room on a dotfiles project the home's .bashrc links into must refuse ${rel}`);
		const unlinked = path.join(home, "dotfiles-unlinked");
		fs.mkdirSync(unlinked, { recursive: true });
		write(path.join(unlinked, ".zshrc"), "kindmark unlinked zshrc\n");
		assert((await runBounded(boundedTools(unlinked), "read", { path: ".zshrc" })).text.includes("kindmark unlinked zshrc"), "a bounded room granted a dotfiles project nothing links into reads its .zshrc");
	} else assert((await runBounded(inDotfiles, "read", { path: ".zshrc" })).text.includes("kindmark ~/dotfiles/.zshrc"), "a bounded room granted a dotfiles project reads a .zshrc nothing links to");
	// The check runs on the server's one thread before every call, so a long
	// path the model sends must not hold up every other room.
	const longStarted = Date.now();
	const longRead = await runBounded(inProject, "read", { path: `${"proc/".repeat(32_000)}x` });
	const longElapsed = Date.now() - longStarted;
	assert(longRead.error && !longRead.text, `a bounded read of a 32,000-part path must answer with an error, got ${JSON.stringify(longRead).slice(0, 200)}`);
	assert(longElapsed < 1000, `a bounded read of a 32,000-part path must answer fast, took ${longElapsed} ms`);
	const inAws = boundedTools(path.join(home, ".aws"));
	const awsCaseWrite = await runBounded(inAws, "write", { path: "CREDENTIALS", content: "x", overwrite: true });
	// A key folder is a closed place, so no room may have it as its folder: every call stops, the case-folded write included.
	assert(awsCaseWrite.error === ROOM_FOLDER_REFUSED && fs.readFileSync(path.join(home, ".aws", "credentials"), "utf8") === "[default] needle\n", "a bounded write of CREDENTIALS must not overwrite credentials");
	assert((await runBounded(inAws, "read", { path: "credentials" })).error === ROOM_FOLDER_REFUSED, "a bounded room granted .aws must refuse credentials");
	const awsList = await runBounded(inAws, "ls", {});
	assert(awsList.error === ROOM_FOLDER_REFUSED && !awsList.text.includes("credentials"), "a bounded room granted .aws must hide credentials");

	console.log("persistent-room localfiles secret floor smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	process.exitCode = 1;
} finally {
	savedEnvNames.forEach((name, index) => {
		if (savedEnv[index] === undefined) delete process.env[name];
		else process.env[name] = savedEnv[index];
	});
	fs.rmSync(tmp, { recursive: true, force: true });
}
