// The person's git name and e-mail for a protected Windows command, on any
// computer: the reader of their git settings (git-identity.ts), the file it
// writes as the real git reads it back, and the file in the box root with a
// stand-in profile, through to a command's request: named in
// GIT_CONFIG_GLOBAL, its folder only read, nothing else of the settings, and
// left out of the turn when there is nothing to give or anything fails.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { atOrInside, commandRequest } from "../src/room-box/windows/box-request.js";
import { gitIdentity, openBoxRoot, type BoxRoot } from "../src/room-box/windows/box-root.js";
import { gitIdentityText, readGitIdentity, type GitIdentity } from "../src/room-box/windows/git-identity.js";
import { machineRules, type Machine } from "../src/room-box/windows/start-check.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function row(name: string, body: () => Promise<void> | void): Promise<void> {
	try {
		await body();
		console.log(`ok: ${name}`);
	} catch (error) {
		console.error(`FAIL: ${name}\n${(error as Error).stack}`);
		process.exit(1);
	}
}

const show = (value: unknown) => JSON.stringify(value);
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "windows-git-identity-")));
process.on("exit", () => fs.rmSync(work, { recursive: true, force: true }));

/** The reader's answer for these files, in the order git reads them. */
const read = (...files: (string | undefined)[]) => readGitIdentity(files);
const same = (got: GitIdentity, want: GitIdentity, label: string) => assert(show(got) === show(want), `${label}: ${show(got)}`);

await row("reader: plain and quoted values, any case, comments, a header with its key on one line, the second file alone, both files, a [user] twice (the last wins); [user \"x\"], [user.x], username and a key before any section not taken", () => {
	same(read("[user]\n\tname = Ana Lopez\n\temail = ana@example.com\n"), { name: "Ana Lopez", email: "ana@example.com" }, "plain");
	same(read('[user]\n  name = "  Ana \\"the\\" Lopez # ; "  \n  email="ana@example.com"\n'), { name: '  Ana "the" Lopez # ; ', email: "ana@example.com" }, "quoted");
	same(read("[USER]\n\tNAME = Ana\n[User]\n\tEmail = ana@example.com\n"), { name: "Ana", email: "ana@example.com" }, "upper and mixed case");
	same(read("# mine\n; also mine\n[user] ; the person\n\tname = Ana Lopez # her name\n\temail = ana@example.com;work\n"), { name: "Ana Lopez", email: "ana@example.com" }, "comments");
	same(read("[user] name = Ana\r\n\temail = ana@example.com\r\n"), { name: "Ana", email: "ana@example.com" }, "a key on the header's line, Windows line ends");
	same(read("\uFEFF[user]\n\tname = Ana"), { name: "Ana" }, "a byte order mark, no last line end");
	same(read(undefined, "[user]\n\temail = ana@example.com\n"), { email: "ana@example.com" }, "the second file alone");
	same(read("[user]\n\tname = Ana\n", undefined), { name: "Ana" }, "the first file alone");
	same(read("[user]\n\tname = First\n\temail = first@example.com\n", "[user]\n\tname = Second\n"), { name: "Second", email: "first@example.com" }, "both files: the later wins, key by key");
	same(read("[user]\n\tname = One\n[core]\n\tautocrlf = true\n[user]\n\tname = Two\n"), { name: "Two" }, "a [user] twice");
	same(read('[user "x"]\n\tname = Sub\n[user.y]\n\temail = sub@example.com\n[user]\n\tusername = ana\n\tnames = no\n'), {}, "subsections and other keys");
	same(read('name = Before\n[user "x"]\n\tname = Sub\n'), {}, "a key before any section");
	same(read("[user]\n\tname =\n\temail\n"), {}, "an empty value, and a key with no value");
	same(read("[user]\n\tname = Ana\n", "[user]\n\tname = \n"), {}, "an empty value last hides an earlier one, as git takes the last");
});

await row("reader: a continued line, a NUL, a newline or another control character, an include, and a file git can't read give nothing", () => {
	same(read("[user]\n\tname = Ana \\\n Lopez\n\temail = ana@example.com\n"), { email: "ana@example.com" }, "a continued line");
	same(read("[user]\n\tname = An\u0000a\n"), {}, "a NUL");
	same(read("[user]\n\tname = Ana\\nLopez\n"), {}, "a newline written as \\n");
	same(read("[user]\n\tname = Ana\\tLopez\n\temail = ana\u0007@example.com\n"), {}, "a tab and a bell");
	same(read("[user]\n\tname = First\n", "[user]\n\tname = Ana \\\n Lopez\n"), {}, "a continued line last hides an earlier value");
	for (const include of ["[include]\n\tpath = more.gitconfig\n", '[includeIf "gitdir:~/work/"]\n\tpath = work.gitconfig\n', "[Include]\n\tPath = more\n"]) {
		same(read(`[user]\n\tname = Ana\n\temail = ana@example.com\n${include}`), {}, `an include: ${include}`);
		same(read(include, "[user]\n\tname = Ana\n"), {}, `an include in the other file: ${include}`);
	}
	for (const broken of ["[user\n\tname = Ana\n", '[user]\n\tname = "Ana\n', "[user]\n\tname = Ana \\q\n", "[user]\n\t1name = Ana\n", "[]\n", "[user]\n\tname Ana\n"]) {
		same(read(broken, "[user]\n\temail = ana@example.com\n"), {}, `a file git can't read: ${show(broken)}`);
	}
	// The allowed neighbour of each: the same file without the fault gives the value.
	same(read("[user]\n\tname = Ana Lopez\n"), { name: "Ana Lopez" }, "the neighbour");
});

await row("the file: a [user] section with the keys found and nothing else; neither gives none", () => {
	assert(gitIdentityText({ name: "Ana Lopez", email: "ana@example.com" }) === '[user]\n\tname = "Ana Lopez"\n\temail = "ana@example.com"\n', show(gitIdentityText({ name: "Ana Lopez", email: "ana@example.com" })));
	assert(gitIdentityText({ name: "Ana" }) === '[user]\n\tname = "Ana"\n', "a name only");
	assert(gitIdentityText({ email: "ana@example.com" }) === '[user]\n\temail = "ana@example.com"\n', "an e-mail only");
	assert(gitIdentityText({}) === undefined, "neither");
	const settings = '[user]\n\tname = Ana\n\temail = ana@example.com\n[url "https://x:TOKEN-ONE@host/"]\n\tinsteadOf = https://host/\n[http]\n\textraheader = AUTHORIZATION: bearer TOKEN-TWO\n[alias]\n\tst = status\n[core]\n\tsshCommand = ssh -i key\n';
	const text = gitIdentityText(read(settings))!;
	assert(text === '[user]\n\tname = "Ana"\n\temail = "ana@example.com"\n' && !/TOKEN|alias|core|url|http/i.test(text), text);
});

// ---- The real git reads the file back -----------------------------------------------------------------

const gitHome = path.join(work, "git-home");
fs.mkdirSync(gitHome);
const gitEnvironment = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: gitHome, XDG_CONFIG_HOME: gitHome };
/** The Mac's or the PC's own git, with the written file as its global settings and nothing of this computer's. */
function git(file: string, args: string[], cwd = work): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...gitEnvironment, GIT_CONFIG_GLOBAL: file } }).replace(/\n$/, "");
}
const init = (repo: string) => execFileSync("git", ["init", "-q", repo], { env: gitEnvironment });
function written(identity: GitIdentity, name: string): string {
	const file = path.join(work, name);
	fs.writeFileSync(file, gitIdentityText(identity)!);
	return file;
}

await row("real git: a name with a quote, a backslash, a # and a ; comes back unchanged; a repository's own name wins; a name only or an e-mail only joins the repository's other key", () => {
	const name = String.raw`Ana "the" Lopez \ #1 ; ok  `;
	const both = written({ name, email: "ana@example.com" }, "both.gitconfig");
	assert(git(both, ["config", "--global", "--get", "user.name"]) === name, `the name: ${show(git(both, ["config", "--global", "--get", "user.name"]))}`);
	assert(git(both, ["config", "--global", "--get", "user.email"]) === "ana@example.com", "the e-mail");
	// Read back through the reader too: what the file says is what was found.
	same(read(fs.readFileSync(both, "utf8")), { name, email: "ana@example.com" }, "the file read again");
	const repo = path.join(work, "repo");
	init(repo);
	git(both, ["config", "user.name", "Repo Name"], repo);
	assert(git(both, ["config", "--get", "user.name"], repo) === "Repo Name" && git(both, ["config", "--get", "user.email"], repo) === "ana@example.com", "the repository's own name");
	const nameOnly = written({ name: "Ana" }, "name.gitconfig");
	const emailOnly = written({ email: "ana@example.com" }, "email.gitconfig");
	const withEmail = path.join(work, "with-email");
	init(withEmail);
	git(nameOnly, ["config", "user.email", "repo@example.com"], withEmail);
	assert(/^Ana <repo@example\.com> \d+ [+-]\d{4}$/.test(git(nameOnly, ["var", "GIT_COMMITTER_IDENT"], withEmail)), git(nameOnly, ["var", "GIT_COMMITTER_IDENT"], withEmail));
	const withName = path.join(work, "with-name");
	init(withName);
	git(emailOnly, ["config", "user.name", "Repo Name"], withName);
	assert(/^Repo Name <ana@example\.com> \d+ [+-]\d{4}$/.test(git(emailOnly, ["var", "GIT_COMMITTER_IDENT"], withName)), git(emailOnly, ["var", "GIT_COMMITTER_IDENT"], withName));
});

// ---- The file in the box root, from a stand-in profile, through to a command's request ----------------------------

// A request names C:\a\b where this computer has /a/b, as the box's stand-in does.
const requestPath = (native: string) => (process.platform === "win32" ? native : `C:${native.replaceAll("/", "\\")}`);
let profiles = 0;
/** A fresh stand-in profile with these settings files, and a box root of its own. */
function stand(files: { gitconfig?: string; xdg?: string }): { profile: string; root: BoxRoot } {
	profiles += 1;
	const profile = path.join(work, `profile-${profiles}`);
	fs.mkdirSync(profile);
	if (files.gitconfig !== undefined) fs.writeFileSync(path.join(profile, ".gitconfig"), files.gitconfig);
	if (files.xdg !== undefined) {
		fs.mkdirSync(path.join(profile, ".config", "git"), { recursive: true });
		fs.writeFileSync(path.join(profile, ".config", "git", "config"), files.xdg);
	}
	return { profile, root: openBoxRoot(path.join(work, `box-${profiles}`, ".exxperts.box")) };
}
const environmentOf = (profile: string) => ({ SystemRoot: String.raw`C:\Windows`, USERPROFILE: profile, PATH: String.raw`C:\Windows\System32` });
/** A command's request for a room in the stand-in, with this turn's file when there is one. */
function requestFor(profile: string, gitConfig: string | undefined) {
	const room = path.join(path.dirname(profile), `room-${path.basename(profile)}`);
	fs.mkdirSync(room, { recursive: true });
	const machine: Machine = { revision: 9711, profile: String.raw`C:\Users\Ana`, personal: [], environment: environmentOf(profile), pathFolders: [], programs: { folder: String.raw`C:\Users\Ana\AppData\Local\Programs`, names: [] } };
	const places = { temp: path.join(room, "temp"), caches: path.join(room, "caches"), ...(gitConfig === undefined ? {} : { gitConfig }) };
	const built = commandRequest(machineRules({ machine, requestPath }, { folder: room, canChangeFiles: true }, [], places), { wrapper: "Write-Output ok", text: "git commit -m x", timeoutMs: 10_000 });
	assert(built.ok, show(built));
	return built.request;
}
function turn(profile: string, root: BoxRoot) {
	const why: string[] = [];
	const file = gitIdentity(root, environmentOf(profile), (reason) => why.push(reason));
	return { file, why };
}
const SETTINGS = '[user]\n\tname = Ana Lopez\n\temail = ana@example.com\n[url "https://x:TOKEN-ONE@host/"]\n\tinsteadOf = https://host/\n[http]\n\textraheader = AUTHORIZATION: bearer TOKEN-TWO\n';

await row("box root: with a name and an e-mail the command's request names the file in GIT_CONFIG_GLOBAL and reads its folder only; the file holds the two keys and no token; with neither, no file, no variable and no grant", () => {
	const { profile, root } = stand({ gitconfig: SETTINGS });
	const { file, why } = turn(profile, root);
	assert(file === path.join(root.path, "git", "config") && why.length === 0, show({ file, why }));
	assert(fs.readFileSync(file, "utf8") === '[user]\n\tname = "Ana Lopez"\n\temail = "ana@example.com"\n' && fs.readdirSync(path.dirname(file)).join() === "config", fs.readFileSync(file, "utf8"));
	const request = requestFor(profile, file);
	assert(request.environment.GIT_CONFIG_GLOBAL === requestPath(file), show(request.environment));
	assert(request.filesystem.readonlyPaths.includes(requestPath(path.dirname(file))) && !request.filesystem.readwritePaths.some((place) => atOrInside(requestPath(file), place)), show(request.filesystem));
	assert(!show(request).includes("TOKEN"), "a token reached the request");
	for (const [label, files] of [["no settings", {}], ["settings without a name or an e-mail", { gitconfig: SETTINGS.replace(/\tname.*\n\temail.*\n/, "") }], ["an include", { gitconfig: `${SETTINGS}[include]\n\tpath = more\n` }]] as const) {
		const none = stand(files);
		const nothing = turn(none.profile, none.root);
		assert(nothing.file === undefined && nothing.why.length === 0 && !fs.existsSync(path.join(none.root.path, "git")), `${label}: ${show(nothing)}`);
		const without = requestFor(none.profile, nothing.file);
		assert(without.environment.GIT_CONFIG_GLOBAL === undefined && !show(without.filesystem).includes(show(requestPath(path.join(none.root.path, "git"))).slice(1, -1)), `${label}: ${show(without)}`);
	}
	// A home that is not a full path, as a Windows one reads on another computer, or none: nothing, and no failure.
	for (const environment of [{ USERPROFILE: "profile" }, {}]) {
		const why: string[] = [];
		assert(gitIdentity(root, environment, (reason) => why.push(reason)) === undefined && why.length === 0, show(environment));
	}
});

await row("box root: a name only, an e-mail only, the second file only; missing or changed, the file is written again, leaving nothing aside", () => {
	for (const [files, text] of [
		[{ gitconfig: "[user]\n\tname = Ana\n" }, '[user]\n\tname = "Ana"\n'],
		[{ gitconfig: "[user]\n\temail = ana@example.com\n" }, '[user]\n\temail = "ana@example.com"\n'],
		[{ xdg: "[user]\n\tname = Ana\n\temail = ana@example.com\n" }, '[user]\n\tname = "Ana"\n\temail = "ana@example.com"\n'],
	] as const) {
		const { profile, root } = stand(files);
		const { file } = turn(profile, root);
		assert(file !== undefined && fs.readFileSync(file, "utf8") === text, `${show(files)}: ${file && fs.readFileSync(file, "utf8")}`);
	}
	const { profile, root } = stand({ gitconfig: SETTINGS });
	const file = turn(profile, root).file!;
	for (const spoil of [() => fs.rmSync(file), () => fs.writeFileSync(file, "[user]\n\tname = Someone Else\n[alias]\n\tx = !rm -rf .\n")]) {
		spoil();
		assert(turn(profile, root).file === file && fs.readFileSync(file, "utf8") === '[user]\n\tname = "Ana Lopez"\n\temail = "ana@example.com"\n' && fs.readdirSync(path.dirname(file)).join() === "config", fs.readFileSync(file, "utf8"));
	}
	// The person changes their name: the next turn's file says the new one.
	fs.writeFileSync(path.join(profile, ".gitconfig"), "[user]\n\tname = Ana Maria Lopez\n");
	assert(turn(profile, root).file === file && fs.readFileSync(file, "utf8") === '[user]\n\tname = "Ana Maria Lopez"\n', fs.readFileSync(file, "utf8"));
});

await row("box root: a link at the folder or the file, or any other failure, leaves the turn without the file, told by a reason with no path, and writes nothing through the link nor removes it", () => {
	const elsewhere = path.join(work, "git-elsewhere");
	fs.mkdirSync(elsewhere);
	const target = path.join(elsewhere, "config");
	fs.writeFileSync(target, "kept\n");
	// Each case, what it leaves where, and the reason the log gets.
	const cases: [string, (root: BoxRoot, profile: string) => string, RegExp][] = [
		["a link at the file", (root) => {
			fs.mkdirSync(path.join(root.path, "git"));
			fs.symlinkSync(target, path.join(root.path, "git", "config"));
			return path.join(root.path, "git", "config");
		}, /^git's settings in the box root are a link$/],
		["a link at the folder", (root) => {
			fs.symlinkSync(elsewhere, path.join(root.path, "git"));
			return path.join(root.path, "git");
		}, /^git's settings folder in the box root is a link$/],
		["a folder where the file belongs", (root) => {
			fs.mkdirSync(path.join(root.path, "git", "config"), { recursive: true });
			return path.join(root.path, "git", "config");
		}, /^git's settings in the box root are not a file$/],
		["a file where the folder belongs", (root) => {
			fs.writeFileSync(path.join(root.path, "git"), "");
			return path.join(root.path, "git");
		}, /^git's settings folder in the box root is not a folder$/],
		["the person's settings can't be read", (_root, profile) => {
			fs.rmSync(path.join(profile, ".gitconfig"));
			fs.mkdirSync(path.join(profile, ".gitconfig"));
			return path.join(profile, ".gitconfig");
		}, /^EISDIR$/],
		["the person's settings are not UTF-8", (_root, profile) => {
			fs.writeFileSync(path.join(profile, ".gitconfig"), Buffer.from("[user]\n\tname = Jos\xe9\n", "latin1"));
			return path.join(profile, ".gitconfig");
		}, /^the person's git settings are not UTF-8$/],
	];
	for (const [label, spoil, says] of cases) {
		const { profile, root } = stand({ gitconfig: SETTINGS });
		// A good turn first, as a turn after a good one meets it.
		assert(turn(profile, root).file !== undefined, `${label}: the good turn`);
		fs.rmSync(path.join(root.path, "git"), { recursive: true });
		const at = spoil(root, profile);
		const { file, why } = turn(profile, root);
		assert(file === undefined && why.length === 1 && says.test(why[0]) && !why[0].includes(work), `${label}: ${show({ file, why })}`);
		const request = requestFor(profile, file);
		assert(request.environment.GIT_CONFIG_GLOBAL === undefined && !show(request).includes("git\\\\config") && !show(request.filesystem).includes(show(requestPath(path.join(root.path, "git"))).slice(1, -1)), `${label}: ${show(request)}`);
		assert(fs.readFileSync(target, "utf8") === "kept\n" && fs.readdirSync(elsewhere).join() === "config", `${label}: what the link leads to: ${fs.readdirSync(elsewhere)}`);
		assert(fs.lstatSync(at, { throwIfNoEntry: false }) !== undefined && (!label.startsWith("a link") || fs.lstatSync(at).isSymbolicLink()), `${label}: what was there went`);
	}
});

console.log("windows-git-identity-smoke: ok");
