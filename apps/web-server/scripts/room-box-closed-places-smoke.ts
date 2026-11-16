// The places outside any home where a person keeps data of their own and the
// Mac's own services that hold the person's secrets, all closed to a room's
// commands; inside the room's folders, the secret files the file tools keep
// closed are the commands' to read, move and remove.
// Each row reaches a place through a real box and reads what it got; each refused
// call has an allowed neighbour beside it, outside the box. It writes nothing
// outside its home but one marker on the Find pasteboard, which it puts back. A
// place this Mac doesn't have is skipped, by name.
//
// The room it makes lives under the home it runs under, so it refuses to start
// anywhere but the throwaway home `npm run smokes` makes.
// Run: npm run smokes -- room-box-closed-places
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { addAlsoAllowedFolder } from "../src/room-box/also-allowed.js";
import { RoomBox } from "../src/room-box/box-session.js";
import { createPersistentRoomDefaultCapabilityPolicy, persistentAgentRootPath, writePersistentRoomDefaultCapabilityPolicy } from "../src/persistent-room-workspace-policy.js";

const ROWS = {
	brew: "Homebrew's var: closed by its path, the data volume's path and its file number; brew lists its packages and raises no card",
	appSupport: "/Library/Application Support: closed; /Library beside it still lists",
	automount: "the automounter's places: closed where this Mac has them; / still lists",
	mail: "the local mail folder is closed; the system's log folder beside it still lists",
	keychain: "the Keychain: a lookup is refused, not merely empty: the keychains it searches are refused, and a lookup that finds an item outside finds none inside",
	clipboard: "the clipboard: pbpaste and pbcopy are refused, and a marker on the pasteboard never shows",
};

if (process.platform !== "darwin") {
	for (const name of Object.values(ROWS)) console.log(`SKIPPED: ${name} (macOS only)`);
	process.exit(0);
}

const home = fs.realpathSync(os.homedir());
if (path.dirname(home) !== fs.realpathSync(os.tmpdir()) || !path.basename(home).startsWith("exxperts-smoke-home-")) {
	console.error(`room box closed places smoke refused: ${home} is not a throwaway smoke home. Run it with: npm run smokes -- room-box-closed-places`);
	process.exit(1);
}

let passed = 0;
const failures: string[] = [];

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

/** A row's body returns why it couldn't run on this Mac, or nothing when it ran. */
async function row(name: string, body: () => Promise<string | void>): Promise<void> {
	try {
		const skipped = await body();
		if (skipped) {
			console.log(`SKIPPED: ${name} (${skipped})`);
			return;
		}
		passed += 1;
		console.log(`  ok   ${name}`);
	} catch (error) {
		failures.push(name);
		console.log(`  FAIL ${name}: ${(error as Error).message}`);
	}
}

const ROOM_ID = "box-closed-places-room";
fs.mkdirSync(persistentAgentRootPath(ROOM_ID), { recursive: true });
const folder = fs.realpathSync(fs.mkdtempSync(path.join(home, "room-folder-")));
writePersistentRoomDefaultCapabilityPolicy(createPersistentRoomDefaultCapabilityPolicy({ agentId: ROOM_ID, repoRoot: path.resolve(import.meta.dirname, "..", "..", ".."), root: folder, workspaceAccessMode: "localFiles", displayLabel: "Room Folder", source: "manual" }));
const questions = {
	watcher: () => "computer" as const,
	askSite: async () => ({ choice: "decline" as const, answeredBy: "computer" as const }),
	closeSiteCards: () => {},
	askOutside: async () => false,
};
const box = new RoomBox({ roomId: ROOM_ID, conversationId: () => "conversation-a", questions: questions as any, rights: () => ({ canChangeFiles: true, skillFolders: [] }), warn: () => {} });

const quoted = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
async function boxed(command: string): Promise<{ code: number | null; out: string }> {
	let out = "";
	const run = await box.operations().exec(command, folder, { onData: (chunk: Buffer) => { out += chunk.toString(); }, env: process.env, timeout: 60 });
	return { code: run.exitCode, out };
}
async function refused(command: string): Promise<void> {
	const { code, out } = await boxed(command);
	assert(code !== 0 && out.includes("Operation not permitted"), `${command} was not refused: exit ${code}: ${out.trim()}`);
}
async function allowed(command: string, expected: string): Promise<void> {
	const { code, out } = await boxed(command);
	assert(code === 0 && out.includes(expected), `${command} was refused: exit ${code}: ${out.trim()}`);
}
/** A command's result as the rows below read it. */
async function bash(command: string): Promise<{ failed: boolean; text: string }> {
	const { code, out } = await boxed(command);
	return { failed: code !== 0, text: out };
}
const inRoom = (...names: string[]) => path.join(folder, ...names);
/** A folder outside the room, on the room's Also allowed list with this access. */
function elsewhere(name: string, access: "read" | "write"): string {
	const place = fs.realpathSync(fs.mkdtempSync(path.join(home, `${name}-`)));
	addAlsoAllowedFolder(ROOM_ID, place, access);
	return place;
}
const git = (cwd: string, ...args: string[]) => spawnSync("git", ["-c", "user.name=s", "-c", "user.email=s@s", ...args], { cwd, encoding: "utf8" });
/** The first name a folder holds, read outside the box: what a listing inside must show. */
const firstName = (place: string) => fs.readdirSync(place).sort()[0] ?? "";

async function main(): Promise<void> {
	console.log("room box closed places smoke");

	await row(ROWS.brew, async () => {
		const prefixes = ["/opt/homebrew", "/usr/local"].filter((prefix) => fs.existsSync(path.join(prefix, "var")));
		if (prefixes.length === 0) return "no Homebrew var folder on this Mac";
		for (const prefix of prefixes) {
			const brew = path.join(prefix, "bin", "brew");
			if (fs.existsSync(brew)) {
				await allowed(`${quoted(brew)} --version`, "Homebrew");
				const cellar = path.join(prefix, "Cellar");
				await allowed(`${quoted(brew)} list --formula`, fs.existsSync(cellar) ? firstName(cellar) : "");
			}
			const bin = path.join(prefix, "bin");
			if (fs.existsSync(bin)) await allowed(`ls ${quoted(bin)}`, firstName(bin));
			const real = fs.realpathSync(path.join(prefix, "var"));
			await refused(`ls ${quoted(real)}`);
			const onDataVolume = path.join("/System/Volumes/Data", real);
			if (fs.existsSync(onDataVolume)) await refused(`ls ${quoted(onDataVolume)}`);
			const { dev, ino } = fs.statSync(real);
			await refused(`ls /.vol/${dev}/${ino}`);
		}
	});

	await row(ROWS.appSupport, async () => {
		if (!fs.existsSync("/Library/Application Support")) return "no /Library/Application Support on this Mac";
		await refused("ls '/Library/Application Support'");
		await allowed("ls /Library", "Application Support");
	});

	await row(ROWS.automount, async () => {
		const present = ["/home", "/Network", "/net"].filter((place) => fs.existsSync(place));
		if (present.length === 0) return "no automounter place on this Mac";
		for (const place of present) await refused(`ls ${place}/`);
		await allowed("ls /", "Library");
	});

	await row(ROWS.mail, async () => {
		if (!fs.existsSync("/private/var/mail")) return "no mail folder on this Mac";
		await refused("ls /var/mail/");
		await allowed("ls /var/log/", firstName("/private/var/log"));
	});

	// The names the file tools keep closed, planted from outside in the room's folder and in an Also allowed folder of each kind.
	const closedNames = [".env", ".env.local", "sub/deep/.env.production", ".ssh/id_rsa", ".ssh/.env.example", ".aws/credentials", "id_ed25519", ".netrc", ".pi/settings.json", "proc/123/environ"];
	const secret = (name: string) => `closed-secret:${name}`;
	const plantClosed = (root: string) => {
		for (const name of closedNames) {
			fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
			fs.writeFileSync(path.join(root, name), secret(name));
		}
	};
	const unplantClosed = (root: string) => {
		for (const top of new Set(closedNames.map((name) => name.split("/")[0]))) fs.rmSync(path.join(root, top), { recursive: true, force: true });
	};
	const noSecretIn = (text: string) => !text.includes("closed-secret:");
	const extraFolder = elsewhere("extra", "write");
	const readOnlyFolder = elsewhere("read-only", "read");

	await row("secret names: a command reads the .env files and keys the file tools keep closed, in the room and in each Also allowed folder", async () => {
		for (const root of [folder, extraFolder, readOnlyFolder]) plantClosed(root);
		try {
			for (const name of [...closedNames.map((name) => inRoom(name)), ...[extraFolder, readOnlyFolder].flatMap((root) => [path.join(root, ".env"), path.join(root, ".aws/credentials"), path.join(root, "sub/deep/.env.production")])]) {
				const read = await bash(`/bin/cat ${quoted(name)}`);
				assert(!read.failed && read.text.includes("closed-secret:"), `${name} was refused: ${read.text}`);
			}
		} finally {
			for (const root of [folder, extraFolder, readOnlyFolder]) unplantClosed(root);
		}
	});

	await row("secret names: the person's keys, credential folders, the app's data and start-up files outside the room stay closed to commands", async () => {
		const outside = [".aws/credentials", ".ssh/id_rsa", ".kube/config", ".docker/config.json", ".config/gh/hosts.yml", ".exxperts/settings.json", ".zshrc"];
		for (const name of outside) {
			fs.mkdirSync(path.dirname(path.join(home, name)), { recursive: true });
			fs.writeFileSync(path.join(home, name), secret(name));
		}
		fs.writeFileSync(inRoom("beside.txt"), "beside");
		try {
			for (const name of outside) {
				const read = await bash(`/bin/cat ${quoted(path.join(home, name))}`);
				assert(read.failed && noSecretIn(read.text), `~/${name} was read: ${read.text}`);
			}
			const beside = await bash("/bin/cat beside.txt");
			assert(!beside.failed && beside.text.includes("beside"), `the room's own file: ${beside.text}`);
		} finally {
			for (const name of outside) fs.rmSync(path.join(home, name), { force: true });
			fs.rmSync(inRoom("beside.txt"), { force: true });
		}
	});

	await row("closed names: templates, ordinary files, a virtual environment's cacert.pem and a Keynote deck stay readable, and a listing still shows a closed name", async () => {
		const open = [".env.example", ".env.sample", "sub/.env.template", "plain.txt", "venv/lib/python3.12/site-packages/certifi/cacert.pem", "venv/lib/python3.12/site-packages/pip/_vendor/certifi/cacert.pem", "Talk.key", "Deck.key/Index.zip", ".environment", "env.txt"];
		for (const root of [folder, extraFolder, readOnlyFolder]) {
			for (const name of open) {
				fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
				fs.writeFileSync(path.join(root, name), `open:${name}`);
			}
		}
		plantClosed(folder);
		try {
			const elsewhereToo = [".env.example", "venv/lib/python3.12/site-packages/certifi/cacert.pem", "Talk.key"];
			for (const [root, name] of [...open.map((name) => [folder, name]), ...[extraFolder, readOnlyFolder].flatMap((root) => elsewhereToo.map((name) => [root, name]))]) {
				const read = await bash(`/bin/cat ${quoted(path.join(root, name))}`);
				assert(!read.failed && read.text.includes(`open:${name}`), `${path.join(root, name)}: ${read.text}`);
			}
			// The names show, so `ls` and `git status` work; a closed folder's own listing stays closed with what it holds.
			const listing = await bash("ls -a");
			assert(!listing.failed && listing.text.includes(".env\n") && listing.text.includes(".ssh\n") && noSecretIn(listing.text), `listing: ${listing.text}`);
		} finally {
			unplantClosed(folder);
			for (const root of [folder, extraFolder, readOnlyFolder]) for (const top of new Set(open.map((name) => name.split("/")[0]))) fs.rmSync(path.join(root, top), { recursive: true, force: true });
		}
	});

	await row("secret names: a command moves and removes them, and rm -rf over a folder holding a .env works", async () => {
		plantClosed(folder);
		plantClosed(extraFolder);
		fs.mkdirSync(inRoom("gone", "inner"), { recursive: true });
		fs.writeFileSync(inRoom("gone", ".env"), secret("gone/.env"));
		fs.writeFileSync(inRoom("gone", "inner", "a.txt"), "ordinary");
		try {
			for (const command of ["mv .env moved && /bin/cat moved", "mv .aws aws-moved && /bin/cat aws-moved/credentials", `mv ${quoted(path.join(extraFolder, ".env"))} ${quoted(path.join(extraFolder, "moved"))}`, "rm -rf gone"]) {
				const run = await bash(command);
				assert(!run.failed, `${command}: ${run.text}`);
			}
			assert(!fs.existsSync(inRoom(".env")) && fs.readFileSync(inRoom("moved"), "utf8") === secret(".env"), "the room's .env didn't move");
			assert(!fs.existsSync(path.join(extraFolder, ".env")) && fs.existsSync(path.join(extraFolder, "moved")), "the Also allowed folder's .env didn't move");
			assert(!fs.existsSync(inRoom("gone")), "rm -rf left the folder holding a .env");
		} finally {
			unplantClosed(folder);
			unplantClosed(extraFolder);
			for (const name of ["moved", "aws-moved", "gone"]) fs.rmSync(inRoom(name), { recursive: true, force: true });
			fs.rmSync(path.join(extraFolder, "moved"), { force: true });
		}
	});

	await row("git: a clone into the box's temp is refused, as no repository may be made there, and the repository it came from still reads", async () => {
		fs.mkdirSync(inRoom("plain-repo"), { recursive: true });
		fs.writeFileSync(inRoom("plain-repo", "a.txt"), "cloned-plain");
		git(inRoom("plain-repo"), "init", "-q");
		git(inRoom("plain-repo"), "add", "-A");
		git(inRoom("plain-repo"), "commit", "-q", "-m", "first");
		try {
			const cloned = await bash('git clone -q plain-repo "$TMPDIR/plain-repo"');
			assert(cloned.failed, `the clone: ${cloned.text}`);
			const log = await bash("git -C plain-repo log --oneline");
			assert(!log.failed && log.text.includes("first"), `the repository's log: ${log.text}`);
		} finally {
			fs.rmSync(inRoom("plain-repo"), { recursive: true, force: true });
		}
	});

	await row("closed names: a command can't make one in its temp or caches to move into the room, and an ordinary folder made there moves in", async () => {
		const planted = ["x/.vscode/tasks.json", "x/deep/.envrc", "x/team.code-workspace"];
		try {
			for (const place of ["$TMPDIR", "$XDG_CACHE_HOME"]) {
				for (const name of planted) {
					const made = await bash(`mkdir -p "$(dirname "${place}/${name}")" && echo '{}' > "${place}/${name}" && mv "${place}/x" carried`);
					assert(made.failed && made.text.includes("Operation not permitted"), `${place}/${name} was made: ${made.text}`);
					assert(!fs.existsSync(inRoom("carried", ...name.split("/").slice(1))), `${name} reached the room from ${place}`);
					fs.rmSync(inRoom("carried"), { recursive: true, force: true });
					await bash(`rm -rf "${place}/x"`);
				}
			}
			const ordinary = await bash('mkdir -p "$TMPDIR/ok/sub" && echo moved-in > "$TMPDIR/ok/sub/a.txt" && mv "$TMPDIR/ok" ok-moved && /bin/cat ok-moved/sub/a.txt');
			assert(!ordinary.failed && ordinary.text.includes("moved-in"), `the ordinary folder: ${ordinary.text}`);
		} finally {
			for (const name of ["carried", "ok-moved"]) fs.rmSync(inRoom(name), { recursive: true, force: true });
		}
	});

	await row("closed names: pip into a virtual environment in the room and an npm install still work", async () => {
		fs.mkdirSync(inRoom("npm-pkg"), { recursive: true });
		fs.writeFileSync(inRoom("npm-pkg", "package.json"), JSON.stringify({ name: "box-smoke-pkg", version: "1.0.0", main: "index.js" }));
		fs.writeFileSync(inRoom("npm-pkg", "index.js"), "module.exports = 'npm-installed';\n");
		// A wheel built by hand, so pip installs with no network.
		const wheel = [
			"import zipfile",
			"z = zipfile.ZipFile('box_smoke_wheel-0.1-py3-none-any.whl', 'w')",
			"z.writestr('box_smoke_wheel.py', 'VALUE = \"pip-installed\"\\n')",
			"z.writestr('box_smoke_wheel-0.1.dist-info/METADATA', 'Metadata-Version: 2.1\\nName: box-smoke-wheel\\nVersion: 0.1\\n')",
			"z.writestr('box_smoke_wheel-0.1.dist-info/WHEEL', 'Wheel-Version: 1.0\\nGenerator: smoke\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n')",
			"z.writestr('box_smoke_wheel-0.1.dist-info/RECORD', '')",
			"z.close()",
		].join("\n");
		try {
			const pip = await bash(`python3 -c ${quoted(wheel)} && python3 -m venv venv && venv/bin/pip install -q --no-index --disable-pip-version-check box_smoke_wheel-0.1-py3-none-any.whl && venv/bin/python -c "import box_smoke_wheel; print(box_smoke_wheel.VALUE)" && venv/bin/python -c "from pip._vendor import certifi; print('pem', len(open(certifi.where()).read()) > 0)"`);
			assert(!pip.failed && pip.text.includes("pip-installed") && pip.text.includes("pem True"), `pip: ${pip.text}`);
			const npm = await bash("cd npm-pkg && npm pack --silent && cd .. && mkdir -p npm-app && cd npm-app && npm init -y >/dev/null && npm install --offline --no-audit --no-fund ../npm-pkg/box-smoke-pkg-1.0.0.tgz && node -e \"console.log(require('box-smoke-pkg'))\"");
			assert(!npm.failed && npm.text.includes("npm-installed"), `npm: ${npm.text}`);
		} finally {
			for (const name of ["npm-pkg", "npm-app", "venv", "box_smoke_wheel-0.1-py3-none-any.whl"]) fs.rmSync(inRoom(name), { recursive: true, force: true });
		}
	});


	// A lookup of a name nobody has says "could not be found" in the box as outside it, since the Keychain
	// skips a keychain it can't open. What tells a refusal apart: the keychain itself, which the box can't
	// open ("UNIX[Operation not permitted]"), and a lookup of any item, which finds one outside and none
	// inside. Only exit codes are read, so no item of the person's is ever printed.
	await row(ROWS.keychain, async () => {
		const login = path.join(os.userInfo().homedir, "Library/Keychains/login.keychain-db");
		const keychains = [login, "/Library/Keychains/System.keychain"].filter((keychain) => fs.existsSync(keychain));
		if (!keychains.includes(login)) return "no login keychain for this account";
		const anyItem = ["find-generic-password", login];
		if (spawnSync("/usr/bin/security", anyItem, { stdio: "ignore" }).status !== 0) return "no item in the login keychain to tell a refusal from an empty answer";
		const inside = await boxed(`/usr/bin/security ${anyItem.map(quoted).join(" ")} >/dev/null 2>&1; echo "found:$?"`);
		assert(inside.out.includes("found:44"), `a lookup of any item wasn't refused: ${inside.out.trim()}`);
		for (const keychain of keychains) {
			// Outside, a locked keychain over a remote login answers without opening its settings: reached, not refused.
			const outside = spawnSync("/usr/bin/security", ["show-keychain-info", keychain], { encoding: "utf8" });
			assert(!outside.stderr.includes("Operation not permitted"), `outside the box ${keychain} was refused: ${outside.stderr}`);
			const inside = await boxed(`/usr/bin/security show-keychain-info ${quoted(keychain)}`);
			assert(inside.code !== 0 && inside.out.includes("UNIX[Operation not permitted]"), `${keychain} was not refused: exit ${inside.code}: ${inside.out.trim()}`);
		}
		const lookup = await boxed("/usr/bin/security find-generic-password -s exxperts-smoke-made-up-name -g");
		assert(lookup.code !== 0 && !lookup.out.includes("keychain:") && !lookup.out.includes("password:"), `the lookup found something: exit ${lookup.code}: ${lookup.out.trim()}`);
	});

	// The Find pasteboard, not the general one, so the person's clipboard stays as it was.
	await row(ROWS.clipboard, async () => {
		const paste = () => spawnSync("/usr/bin/pbpaste", ["-pboard", "find"], { encoding: "utf8" });
		const copy = (text: string) => spawnSync("/usr/bin/pbcopy", ["-pboard", "find"], { input: text });
		const before = paste();
		if (before.status !== 0) return "no pasteboard for this login";
		const marker = `exxperts-smoke-pasteboard-${process.pid}`;
		try {
			assert(copy(marker).status === 0 && paste().stdout === marker, "outside the box the marker didn't land");
			for (const command of ["/usr/bin/pbpaste -pboard find", "/usr/bin/pbpaste", "pbpaste"]) {
				const inside = await boxed(command);
				assert(inside.code !== 0 && !inside.out.includes(marker), `${command} wasn't refused: exit ${inside.code}: ${inside.out.trim()}`);
			}
			const wrote = await boxed("echo planted | /usr/bin/pbcopy -pboard find");
			assert(wrote.code !== 0 && paste().stdout === marker, `pbcopy wasn't refused: exit ${wrote.code}: ${wrote.out.trim()}`);
		} finally {
			copy(before.stdout);
		}
	});
}

main().catch((error) => {
	failures.push(`crashed: ${(error as Error).stack}`);
}).finally(async () => {
	await box.endTurn().catch(() => {});
	fs.rmSync(folder, { recursive: true, force: true });
	console.log(`room box closed places smoke: ${passed} passed, ${failures.length} failed`);
	for (const failure of failures) console.log(`  failed: ${failure}`);
	process.exit(failures.length ? 1 : 0);
});
