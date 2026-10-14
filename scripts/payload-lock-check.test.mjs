// Unit tests for the release payload check (scripts/payload-lock-check.mjs).
//
//   npm run test:scripts
//
// Each test builds a small installed app tree in a temp dir and checks it
// against a small lockfile.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { checkPayloadAgainstLock } from "./payload-lock-check.mjs";

const tempDirs = [];
after(() => {
	for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// packages: { "node_modules/foo": "1.0.0", ... } -> a tree with one
// package.json per entry.
function makeApp(packages) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-lock-check-test-"));
	tempDirs.push(dir);
	for (const [rel, version] of Object.entries(packages)) {
		const full = path.join(dir, ...rel.split("/"));
		fs.mkdirSync(full, { recursive: true });
		const name = rel.slice(rel.lastIndexOf("node_modules/") + "node_modules/".length);
		fs.writeFileSync(path.join(full, "package.json"), JSON.stringify({ name, version }));
	}
	return dir;
}

const lock = {
	lockfileVersion: 3,
	packages: {
		"": { name: "app", version: "1.0.0" },
		"node_modules/@exxeta/own": { resolved: "runtime/own", link: true },
		"runtime/own": { name: "@exxeta/own", version: "0.1.0" },
		"node_modules/basic-ftp": { version: "6.2.1" },
		"node_modules/@scope/pkg": { version: "2.0.0" },
		"node_modules/semver": { version: "7.0.0" },
		"node_modules/a/node_modules/semver": { version: "6.3.1" },
		"node_modules/a": { version: "1.0.0" },
		"node_modules/vite": { version: "6.4.3", dev: true },
		"node_modules/maybe": { version: "1.0.0", devOptional: true },
		"node_modules/both": { version: "3.0.0", dev: true },
		"runtime/own/node_modules/both": { version: "3.0.0" },
	},
};

const check = (app) => checkPayloadAgainstLock(app, lock);

test("a tree that matches the lockfile passes", () => {
	const app = makeApp({
		"node_modules/basic-ftp": "6.2.1",
		"node_modules/@scope/pkg": "2.0.0",
		"node_modules/a": "1.0.0",
		"node_modules/a/node_modules/semver": "6.3.1",
		"node_modules/semver": "7.0.0",
		// Found at a different path than in the lockfile: name and version are
		// what the scan and the SBOM list.
		"node_modules/both": "3.0.0",
	});
	assert.deepEqual(check(app), { checked: 6, problems: [] });
});

test("a wrong version fails and names the lockfile's versions", () => {
	const app = makeApp({ "node_modules/basic-ftp": "5.3.1" });
	assert.deepEqual(check(app).problems, ["node_modules/basic-ftp: basic-ftp 5.3.1 is installed, the lockfile has 6.2.1"]);
});

test("a package the lockfile lacks fails", () => {
	const app = makeApp({ "node_modules/get-uri": "6.0.5" });
	assert.deepEqual(check(app).problems, ["node_modules/get-uri: get-uri 6.0.5 is not in the lockfile"]);
});

test("a dev-only lockfile entry fails", () => {
	const app = makeApp({ "node_modules/vite": "6.4.3" });
	assert.deepEqual(check(app).problems, ["node_modules/vite: vite 6.4.3 is only a dev entry in the lockfile"]);
});

test("a devOptional-only lockfile entry fails", () => {
	const app = makeApp({ "node_modules/maybe": "1.0.0" });
	assert.deepEqual(check(app).problems, ["node_modules/maybe: maybe 1.0.0 is only a devOptional entry in the lockfile"]);
});

test("a package in a nested node_modules is checked", () => {
	const app = makeApp({ "node_modules/a": "1.0.0", "node_modules/a/node_modules/semver": "5.7.2" });
	assert.deepEqual(check(app).problems, ["node_modules/a/node_modules/semver: semver 5.7.2 is installed, the lockfile has 7.0.0, 6.3.1"]);
});

test("a scoped package is checked", () => {
	const app = makeApp({ "node_modules/@scope/pkg": "2.1.0" });
	assert.deepEqual(check(app).problems, ["node_modules/@scope/pkg: @scope/pkg 2.1.0 is installed, the lockfile has 2.0.0"]);
});

test("our own linked package is skipped, what is installed inside it is checked", () => {
	const app = makeApp({
		"runtime/own/node_modules/basic-ftp": "5.3.1",
		"runtime/own/node_modules/both": "3.0.0",
	});
	fs.writeFileSync(path.join(app, "runtime", "own", "package.json"), JSON.stringify({ name: "@exxeta/own", version: "0.1.0" }));
	fs.mkdirSync(path.join(app, "node_modules", "@exxeta"), { recursive: true });
	// A junction works without admin rights on Windows and is a plain
	// symlink elsewhere, like npm's own links.
	fs.symlinkSync(path.join(app, "runtime", "own"), path.join(app, "node_modules", "@exxeta", "own"), "junction");
	assert.deepEqual(check(app), {
		checked: 2,
		problems: ["runtime/own/node_modules/basic-ftp: basic-ftp 5.3.1 is installed, the lockfile has 6.2.1"],
	});
});

test("a copy of our own package at its link's slot is skipped, what is inside it is checked", () => {
	const app = makeApp({
		"node_modules/@exxeta/own": "0.1.0",
		"node_modules/@exxeta/own/node_modules/basic-ftp": "5.3.1",
	});
	fs.mkdirSync(path.join(app, "runtime", "own"), { recursive: true });
	fs.copyFileSync(path.join(app, "node_modules", "@exxeta", "own", "package.json"), path.join(app, "runtime", "own", "package.json"));
	assert.deepEqual(check(app), {
		checked: 1,
		problems: ["node_modules/@exxeta/own/node_modules/basic-ftp: basic-ftp 5.3.1 is installed, the lockfile has 6.2.1"],
	});
});

test("a package named like our own is checked unless it is our copy at the link's slot", () => {
	const app = makeApp({
		"node_modules/@exxeta/own": "9.9.9",
		"node_modules/a": "1.0.0",
		"node_modules/a/node_modules/@exxeta/own": "0.1.0",
	});
	fs.mkdirSync(path.join(app, "runtime", "own"), { recursive: true });
	fs.copyFileSync(path.join(app, "node_modules", "a", "node_modules", "@exxeta", "own", "package.json"), path.join(app, "runtime", "own", "package.json"));
	assert.deepEqual(check(app).problems, [
		"node_modules/@exxeta/own: @exxeta/own 9.9.9 is not in the lockfile",
		"node_modules/a/node_modules/@exxeta/own: @exxeta/own 0.1.0 is not in the lockfile",
	]);
});

test("a link that is not one of the lockfile's links fails", () => {
	const app = makeApp({});
	const outside = makeApp({});
	fs.writeFileSync(path.join(outside, "package.json"), JSON.stringify({ name: "@exxeta/own", version: "0.1.0" }));
	fs.mkdirSync(path.join(app, "node_modules", "@exxeta"), { recursive: true });
	fs.symlinkSync(outside, path.join(app, "node_modules", "@exxeta", "own"), "junction");
	assert.deepEqual(check(app).problems, [`node_modules/@exxeta/own: a link to ${fs.realpathSync(outside)}, not one of the lockfile's links`]);
});

test("a node_modules folder outside any package is checked", () => {
	const app = makeApp({ "runtime/node_modules/vite": "6.4.3" });
	assert.deepEqual(check(app).problems, ["runtime/node_modules/vite: vite 6.4.3 is only a dev entry in the lockfile"]);
});

test("plain files in a node_modules folder are not packages", () => {
	const app = makeApp({ "node_modules/a": "1.0.0" });
	fs.mkdirSync(path.join(app, "node_modules", "a", "test", "node_modules"), { recursive: true });
	fs.writeFileSync(path.join(app, "node_modules", "a", "test", "node_modules", "file1.js"), "");
	assert.deepEqual(check(app), { checked: 1, problems: [] });
});

test("a folder without a package.json fails", () => {
	const app = makeApp({});
	fs.mkdirSync(path.join(app, "node_modules", "stray"), { recursive: true });
	assert.deepEqual(check(app).problems, ["node_modules/stray: no package.json with a name and a version"]);
});
