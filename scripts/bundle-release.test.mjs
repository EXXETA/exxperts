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

import { findPrunedTypeScriptImports, pruneNodeModules } from "./bundle-release-prune.mjs";

const tempDirs = [];
after(() => {
	for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTree(files) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-prune-test-"));
	tempDirs.push(dir);
	for (const [rel, content] of Object.entries(files)) {
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
