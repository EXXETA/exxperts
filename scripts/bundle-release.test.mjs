// Unit tests for the release payload prune (scripts/bundle-release-prune.mjs).
//
//   npm run test:scripts
//
// Each test builds a small node_modules fixture in a temp dir, runs the prune
// and checks what is left.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { ARCHIVE_TARGET_DROP, dropTargetPackages, findPrunedTypeScriptImports, pruneNodeModules } from "./bundle-release-prune.mjs";
import { BUNDLE_ASSETS, EXTERNAL_PACKAGES, FILE_PACKAGES, LICENCES_FILE } from "./bundle-server.mjs";
import "./bundle-document-tools.test.mjs";

const tempDirs = [];
after(() => {
	for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTree(files) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-prune-test-"));
	tempDirs.push(dir);
	for (const [rel, content] of Object.entries(files)) {
		if (content === null) continue;
		const full = path.join(dir, ...rel.split("/"));
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content);
	}
	return dir;
}

const has = (dir, rel) => fs.existsSync(path.join(dir, ...rel.split("/")));

test("removes source maps and declaration files from third-party packages", () => {
	const dir = makeTree({
		"foo/index.js": "module.exports = 1;\n",
		"foo/index.js.map": "{}",
		"foo/index.d.ts": "export {};\n",
		"foo/esm/index.d.mts": "export {};\n",
		"foo/cjs/index.d.cts": "export {};\n",
		"foo/index.d.ts.map": "{}",
	});
	const result = pruneNodeModules(dir);
	assert.ok(has(dir, "foo/index.js"));
	for (const rel of ["foo/index.js.map", "foo/index.d.ts", "foo/esm/index.d.mts", "foo/cjs/index.d.cts", "foo/index.d.ts.map"]) {
		assert.ok(!has(dir, rel), `${rel} should be pruned`);
	}
	assert.equal(result.filesBefore, 6);
	assert.equal(result.filesAfter, 1);
});

test("removes third-party TypeScript sources and keeps them in protected packages", () => {
	const dir = makeTree({
		"foo/src/index.ts": "export const a = 1;\n",
		"foo/src/util.mts": "export const b = 1;\n",
		"@exxeta/exxperts-runtime/src/index.ts": "export const c = 1;\n",
		"@exxeta/exxperts-runtime/dist/index.js.map": "{}",
		"pi-mcp-adapter/index.ts": "export const d = 1;\n",
	});
	pruneNodeModules(dir);
	assert.ok(!has(dir, "foo/src/index.ts"));
	assert.ok(!has(dir, "foo/src/util.mts"));
	assert.ok(has(dir, "@exxeta/exxperts-runtime/src/index.ts"));
	assert.ok(has(dir, "@exxeta/exxperts-runtime/dist/index.js.map"));
	assert.ok(has(dir, "pi-mcp-adapter/index.ts"));
});

test("keeps licence and notice files whatever their case or extension", () => {
	const dir = makeTree({
		"foo/LICENSE.md": "MIT\n",
		"foo/licence.markdown": "MIT\n",
		"foo/NOTICE.md": "notice\n",
		"foo/Copying.md": "gpl\n",
		"foo/license": "MIT\n",
	});
	pruneNodeModules(dir);
	for (const rel of ["foo/LICENSE.md", "foo/licence.markdown", "foo/NOTICE.md", "foo/Copying.md", "foo/license"]) {
		assert.ok(has(dir, rel), `${rel} should be kept`);
	}
});

test("removes markdown outside protected packages and keeps it inside them", () => {
	const dir = makeTree({
		"foo/README.md": "# foo\n",
		"foo/docs/guide.markdown": "guide\n",
		"@exxeta/exxperts-runtime/README.md": "# runtime\n",
		"@exxeta/exxperts-runtime/docs/extensions.md": "docs\n",
		"pi-mcp-adapter/README.md": "# adapter\n",
	});
	pruneNodeModules(dir);
	assert.ok(!has(dir, "foo/README.md"));
	assert.ok(!has(dir, "foo/docs/guide.markdown"));
	assert.ok(has(dir, "@exxeta/exxperts-runtime/README.md"));
	assert.ok(has(dir, "@exxeta/exxperts-runtime/docs/extensions.md"));
	assert.ok(has(dir, "pi-mcp-adapter/README.md"));
});

test("the static gate names a remaining file that requires a pruned TypeScript source", () => {
	const dir = makeTree({
		"bar/index.js": 'const x = require("./x.ts");\nmodule.exports = x;\n',
		"bar/x.ts": "export const x = 1;\n",
		"bar/ok.mjs": 'import "./kept.js";\n',
		"bar/kept.js": "export {};\n",
	});
	const result = pruneNodeModules(dir);
	const broken = findPrunedTypeScriptImports(dir, result.removed);
	assert.equal(broken.length, 1);
	assert.equal(broken[0].file, path.join(dir, "bar", "index.js"));
	assert.equal(broken[0].specifier, "./x.ts");
});

test("the static gate ignores type-only references to pruned declaration files", () => {
	const dir = makeTree({
		"baz/index.js": "/** @type {import('./types.d.ts').Thing} */\nmodule.exports = {};\n",
		"baz/types.d.ts": "export type Thing = 1;\n",
	});
	const result = pruneNodeModules(dir);
	assert.ok(!has(dir, "baz/types.d.ts"));
	assert.deepEqual(findPrunedTypeScriptImports(dir, result.removed), []);
});

test("the static gate passes when TypeScript imports point into protected packages", () => {
	const dir = makeTree({
		"pi-mcp-adapter/loader.js": 'import("./index.ts");\n',
		"pi-mcp-adapter/index.ts": "export {};\n",
	});
	const result = pruneNodeModules(dir);
	assert.deepEqual(findPrunedTypeScriptImports(dir, result.removed), []);
});

// A staged app/ tree as the archive carries it before the drop: the bundled
// server and the packages it loads as files, which the app depends on,
// fastify with semver, and Microsoft's sandbox kit with its own koffi,
// koffi's platform package for the target, node-pty and node-addon-api.
const manifest = (name, extra = {}) => JSON.stringify({ name, version: "1.0.0", ...extra });
const KOFFI_PLATFORM = { "darwin-arm64": "koffi-darwin-arm64", "linux-x64": "koffi-linux-x64", "win-x64": "koffi-win32-x64" };
function archiveApp(target, overrides = {}) {
	const shipped = [...EXTERNAL_PACKAGES.filter((entry) => entry.ships), ...FILE_PACKAGES].map(({ name }) => name);
	const kit = "node_modules/@microsoft/mxc-sdk";
	return makeTree({
		"package.json": manifest("@exxeta/exxperts-app", { dependencies: Object.fromEntries([...shipped, "fastify"].map((name) => [name, "1.0.0"])) }),
		...Object.fromEntries(shipped.map((name) => [`node_modules/${name}/package.json`, manifest(name)])),
		...Object.fromEntries(["server.mjs", LICENCES_FILE, ...BUNDLE_ASSETS.map((asset) => asset.file)].map((file) => [`apps/web-server/dist/${file}`, "x"])),
		"node_modules/fastify/package.json": manifest("fastify", { dependencies: { semver: "7.0.0" } }),
		"node_modules/semver/package.json": manifest("semver"),
		[`${kit}/package.json`]: manifest("@microsoft/mxc-sdk", { dependencies: { koffi: "3.0.0", "node-pty": "1.0.0", semver: "7.0.0" } }),
		[`${kit}/dist/v1/index.js`]: "x",
		[`${kit}/node_modules/koffi/package.json`]: manifest("koffi", { optionalDependencies: { "@koromix/koffi-darwin-arm64": "3.0.0", "@koromix/koffi-linux-x64": "3.0.0", "@koromix/koffi-win32-x64": "3.0.0" } }),
		[`node_modules/@koromix/${KOFFI_PLATFORM[target]}/package.json`]: manifest(`@koromix/${KOFFI_PLATFORM[target]}`),
		"node_modules/node-pty/package.json": manifest("node-pty", { dependencies: { "node-addon-api": "7.0.0" } }),
		"node_modules/node-addon-api/package.json": manifest("node-addon-api"),
		...overrides,
	});
}

function listFiles(dir, rel = "") {
	return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((entry) => {
		const childRel = rel ? `${rel}/${entry.name}` : entry.name;
		return entry.isDirectory() ? [`${childRel}/`, ...listFiles(dir, childRel)] : [childRel];
	});
}

for (const [target, koffiPlatform] of [["darwin-arm64", "@koromix/koffi-darwin-arm64"], ["linux-x64", "@koromix/koffi-linux-x64"]]) {
	test(`the ${target} archive leaves out the sandbox kit, node-pty and what only they need, each with its reason, and keeps semver for fastify`, () => {
		const dir = archiveApp(target);
		const before = listFiles(dir);
		const leftOut = dropTargetPackages(dir, target);
		assert.deepEqual(leftOut.map((entry) => entry.name).sort(), ["@microsoft/mxc-sdk", koffiPlatform, "node-addon-api", "node-pty"].sort());
		for (const entry of leftOut) assert.ok(entry.reason, `${entry.name} has no reason`);
		const gone = before.filter((file) => !listFiles(dir).includes(file));
		assert.ok(gone.every((file) => /^node_modules\/(@microsoft\/|@koromix\/|node-pty\/|node-addon-api\/)/.test(file)), gone.join("\n"));
		for (const rel of ["node_modules/@microsoft", "node_modules/@koromix", "node_modules/node-pty", "node_modules/node-addon-api"]) assert.ok(!has(dir, rel), `${rel} was kept`);
		for (const rel of ["node_modules/semver/package.json", "node_modules/fastify/package.json", "node_modules/jszip/package.json", "apps/web-server/dist/box-worker-windows.mjs"]) assert.ok(has(dir, rel), `${rel} was removed`);
	});

	test(`the ${target} archive fails, removing nothing, when a kept package still needs a listed one`, () => {
		const dir = archiveApp(target, { "node_modules/fastify/package.json": manifest("fastify", { dependencies: { semver: "7.0.0", "node-pty": "1.0.0" } }) });
		const before = listFiles(dir);
		assert.throws(() => dropTargetPackages(dir, target), new RegExp(`node_modules/node-pty stays in the ${target} archive although ARCHIVE_TARGET_DROP leaves it out`));
		assert.deepEqual(listFiles(dir), before);
	});

	test(`the ${target} archive fails, removing nothing, when the drop would leave out a package the list does not name`, () => {
		const dir = archiveApp(target, {
			"node_modules/@microsoft/mxc-sdk/package.json": manifest("@microsoft/mxc-sdk", { dependencies: { koffi: "3.0.0", "node-pty": "1.0.0", "only-for-the-kit": "1.0.0" } }),
			"node_modules/only-for-the-kit/package.json": manifest("only-for-the-kit"),
		});
		const before = listFiles(dir);
		assert.throws(() => dropTargetPackages(dir, target), new RegExp(`the ${target} archive would leave out only-for-the-kit, which ARCHIVE_TARGET_DROP does not list`));
		assert.deepEqual(listFiles(dir), before);
	});

	test(`the ${target} archive fails when it lacks a package the app or the bundled server needs`, () => {
		assert.throws(() => dropTargetPackages(archiveApp(target, { "node_modules/jszip/package.json": null }), target), /jszip is missing/);
		assert.throws(() => dropTargetPackages(archiveApp(target, { "node_modules/semver/package.json": null }), target), /semver \(needed by fastify\) is missing/);
		assert.throws(() => dropTargetPackages(archiveApp(target, { "apps/web-server/dist/box-worker-windows.mjs": null }), target), /box-worker-windows\.mjs is missing/);
	});
}

test("the win-x64 archive keeps every package it has, the sandbox kit's included", () => {
	const dir = archiveApp("win-x64");
	const before = listFiles(dir);
	assert.deepEqual(dropTargetPackages(dir, "win-x64"), []);
	assert.deepEqual(listFiles(dir), before);
	assert.deepEqual(ARCHIVE_TARGET_DROP.filter((entry) => entry.target === "win-x64"), []);
});
