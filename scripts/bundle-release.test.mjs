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

test("release pruning refuses to remove a dependency newly imported by the CLI", () => {
	const app = makeTree({
		"package.json": JSON.stringify({ dependencies: { exceljs: "1" } }),
		"bin/exxperts.cjs": 'import("exceljs");\n',
		"node_modules/exceljs/package.json": JSON.stringify({ name: "exceljs", version: "1" }),
		"node_modules/exceljs/index.js": "module.exports = {};\n",
		"node_modules/bluebird/package.json": JSON.stringify({ name: "bluebird", version: "1" }),
		"node_modules/lie/package.json": JSON.stringify({ name: "lie", version: "1" }),
	});
	assert.throws(() => pruneNodeModules(path.join(app, "node_modules")), /exceljs.*import|import.*exceljs/i);
	assert.ok(has(app, "node_modules/exceljs/index.js"));
});

test("release pruning refuses an unreviewed computed import in the CLI", () => {
	const app = makeTree({
		"package.json": JSON.stringify({ dependencies: { exceljs: "1" } }),
		"bin/exxperts.cjs": 'const name = process.argv[2]; import(name);\n',
		"node_modules/exceljs/package.json": JSON.stringify({ name: "exceljs", version: "1" }),
		"node_modules/exceljs/index.js": "module.exports = {};\n",
	});
	assert.throws(() => pruneNodeModules(path.join(app, "node_modules")), /computed|dynamic/i);
	assert.ok(has(app, "node_modules/exceljs/index.js"));
});

test("release pruning keeps shared and selectable dependencies and their notices", () => {
	const app = makeTree({
		"package.json": JSON.stringify({ dependencies: { exceljs: "1", shared: "1" } }),
		"node_modules/exceljs/package.json": JSON.stringify({ name: "exceljs", version: "1", dependencies: { shared: "1", worker: "1" } }),
		"node_modules/exceljs/index.js": "module.exports = {};",
		"node_modules/exceljs/NOTICE": "invented notice",
		"apps/web-server/dist/shelf-parse-worker.mjs": "export {};",
		"apps/web-server/src/shelf-parse-worker.mjs": "export {};",
		"node_modules/shared/package.json": JSON.stringify({ name: "shared", version: "1" }),
		"node_modules/shared/index.js": "module.exports = {};",
		"node_modules/worker/package.json": JSON.stringify({ name: "worker", version: "1" }),
		"node_modules/worker/index.js": "module.exports = {};",
		"node_modules/worker/LICENSE": "invented licence",
		"node_modules/bluebird/package.json": JSON.stringify({ name: "bluebird", version: "1" }),
		"node_modules/bluebird/index.js": "module.exports = {};",
		"node_modules/lie/package.json": JSON.stringify({ name: "lie", version: "1" }),
		"node_modules/lie/index.js": "module.exports = {};",
	});
	pruneNodeModules(path.join(app, "node_modules"));
	assert.ok(!has(app, "node_modules/exceljs/index.js"));
	assert.ok(!has(app, "node_modules/worker/index.js"));
	for (const file of ["node_modules/exceljs/NOTICE", "node_modules/worker/LICENSE", "node_modules/shared/index.js", "node_modules/bluebird/index.js", "node_modules/lie/index.js"]) assert.ok(has(app, file), file);
});

test("release pruning resolves same-name dependencies from each caller", () => {
	const app = makeTree({
		"package.json": JSON.stringify({ dependencies: { exceljs: "1", uuid: "1" } }),
		"bin/exxperts.cjs": 'require("uuid");',
		"node_modules/exceljs/package.json": JSON.stringify({ name: "exceljs", version: "1", dependencies: { uuid: "2" } }),
		"node_modules/exceljs/index.js": 'require("uuid");',
		"node_modules/exceljs/node_modules/uuid/package.json": JSON.stringify({ name: "uuid", version: "2" }),
		"node_modules/exceljs/node_modules/uuid/index.js": "module.exports = 2;",
		"apps/web-server/dist/shelf-parse-worker.mjs": "export {};",
		"apps/web-server/src/shelf-parse-worker.mjs": "export {};",
		"node_modules/uuid/package.json": JSON.stringify({ name: "uuid", version: "1" }),
		"node_modules/uuid/index.js": "module.exports = 1;",
	});
	pruneNodeModules(path.join(app, "node_modules"));
	assert.ok(has(app, "node_modules/uuid/index.js"));
	assert.ok(!has(app, "node_modules/exceljs/node_modules/uuid/index.js"));
});

test("release pruning rejects changes at reviewed computed import sites", () => {
	const app = makeTree({
		"package.json": JSON.stringify({ dependencies: { exceljs: "1" } }),
		"node_modules/exceljs/package.json": JSON.stringify({ name: "exceljs", version: "1" }),
		"node_modules/exceljs/index.js": "module.exports = {};",
		"runtime/packages/ai/dist/env-api-keys.js": 'const dynamicImport = (specifier) => import(specifier); dynamicImport("exceljs");',
	});
	assert.throws(() => pruneNodeModules(path.join(app, "node_modules")), /review|computed|dynamic/i);
	assert.ok(has(app, "node_modules/exceljs/index.js"));
});

test("release pruning rejects an unknown computed load in a retained dependency", () => {
	const app = makeTree({
		"package.json": JSON.stringify({ dependencies: { exceljs: "1", shared: "1" } }),
		"node_modules/exceljs/package.json": JSON.stringify({ name: "exceljs", version: "1" }),
		"node_modules/exceljs/index.js": "module.exports = {};",
		"node_modules/shared/package.json": JSON.stringify({ name: "shared", version: "1" }),
		"node_modules/shared/index.js": 'const name = process.env.APP_MODULE; import(name);',
	});
	assert.throws(() => pruneNodeModules(path.join(app, "node_modules")), /computed|dynamic/i);
	assert.ok(has(app, "node_modules/exceljs/index.js"));
});

test("release pruning rejects template and commented computed imports", () => {
	for (const source of ['import(`exceljs`);', 'import(/* computed */ target);']) {
		const app = makeTree({
			"package.json": JSON.stringify({ dependencies: { exceljs: "1" } }),
			"bin/exxperts.cjs": source,
			"node_modules/exceljs/package.json": JSON.stringify({ name: "exceljs", version: "1" }),
			"node_modules/exceljs/index.js": "module.exports = {};",
		});
		assert.throws(() => pruneNodeModules(path.join(app, "node_modules")), /computed|dynamic/i, source);
		assert.ok(has(app, "node_modules/exceljs/index.js"));
	}
});

test("release pruning runs the bundled worker through the shipped source path", async () => {
	const { fork } = await import("node:child_process");
	const app = makeTree({
		"package.json": JSON.stringify({ dependencies: { exceljs: "1" } }),
		"node_modules/exceljs/package.json": JSON.stringify({ name: "exceljs", version: "1" }),
		"node_modules/exceljs/index.js": "module.exports = {};",
		"apps/web-server/dist/shelf-parse-worker.mjs": 'process.send("bundled", () => process.exit(0));',
		"apps/web-server/src/shelf-parse-worker.mjs": 'process.send("source", () => process.exit(0));',
	});
	pruneNodeModules(path.join(app, "node_modules"));
	const message = await new Promise((resolve, reject) => {
		const child = fork(path.join(app, "apps/web-server/src/shelf-parse-worker.mjs"), [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
		child.once("message", resolve);
		child.once("error", reject);
	});
	assert.equal(message, "bundled");
});

test("release pruning permits absent optional platform dependencies", () => {
	const app = makeTree({
		"package.json": JSON.stringify({ dependencies: { exceljs: "1" }, optionalDependencies: { "platform-addon": "1" } }),
		"node_modules/exceljs/package.json": JSON.stringify({ name: "exceljs", version: "1" }),
		"node_modules/exceljs/index.js": "module.exports = {};",
		"apps/web-server/dist/shelf-parse-worker.mjs": "export {};",
		"apps/web-server/src/shelf-parse-worker.mjs": "export {};",
	});
	assert.doesNotThrow(() => pruneNodeModules(path.join(app, "node_modules")));
	assert.ok(!has(app, "node_modules/exceljs/index.js"));
});

test("release pruning rejects a comment between import and its argument", () => {
	const app = makeTree({
		"package.json": JSON.stringify({ dependencies: { exceljs: "1" } }),
		"bin/exxperts.cjs": 'import /* computed */ (target);',
		"node_modules/exceljs/package.json": JSON.stringify({ name: "exceljs", version: "1" }),
		"node_modules/exceljs/index.js": "module.exports = {};",
	});
	assert.throws(() => pruneNodeModules(path.join(app, "node_modules")), /computed|dynamic/i);
	assert.ok(has(app, "node_modules/exceljs/index.js"));
});

test("release pruning rejects omitted dependencies imported by retained packages", () => {
	const app = makeTree({
		"package.json": JSON.stringify({ dependencies: { exceljs: "1", shared: "1" } }),
		"node_modules/exceljs/package.json": JSON.stringify({ name: "exceljs", version: "1" }),
		"node_modules/exceljs/index.js": "module.exports = {};",
		"node_modules/shared/package.json": JSON.stringify({ name: "shared", version: "1" }),
		"node_modules/shared/index.js": 'require("exceljs");',
	});
	assert.throws(() => pruneNodeModules(path.join(app, "node_modules")), /exceljs.*import|import.*exceljs/i);
	assert.ok(has(app, "node_modules/exceljs/index.js"));
});

test("release pruning rejects a commented literal import of an omitted package", () => {
	const app = makeTree({
		"package.json": JSON.stringify({ dependencies: { exceljs: "1" } }),
		"bin/exxperts.cjs": 'import /* loaded later */ ("exceljs");',
		"node_modules/exceljs/package.json": JSON.stringify({ name: "exceljs", version: "1" }),
		"node_modules/exceljs/index.js": "module.exports = {};",
	});
	assert.throws(() => pruneNodeModules(path.join(app, "node_modules")), /exceljs.*import|import.*exceljs/i);
	assert.ok(has(app, "node_modules/exceljs/index.js"));
});

test("release pruning rejects omitted imports through createRequire", () => {
	const app = makeTree({
		"package.json": JSON.stringify({ dependencies: { exceljs: "1" } }),
		"bin/exxperts.cjs": 'const { createRequire } = require("node:module"); const load = createRequire(__filename); load("exceljs");',
		"node_modules/exceljs/package.json": JSON.stringify({ name: "exceljs", version: "1" }),
		"node_modules/exceljs/index.js": "module.exports = {};",
	});
	assert.throws(() => pruneNodeModules(path.join(app, "node_modules")), /exceljs.*import|import.*exceljs/i);
	assert.ok(has(app, "node_modules/exceljs/index.js"));
});

test("release pruning rejects an unreviewed computed createRequire load", () => {
	const app = makeTree({
		"package.json": JSON.stringify({ dependencies: { exceljs: "1" } }),
		"bin/exxperts.cjs": 'const load = createRequire(__filename); load(process.argv[2]);',
		"node_modules/exceljs/package.json": JSON.stringify({ name: "exceljs", version: "1" }),
		"node_modules/exceljs/index.js": "module.exports = {};",
	});
	assert.throws(() => pruneNodeModules(path.join(app, "node_modules")), /computed|dynamic/i);
	assert.ok(has(app, "node_modules/exceljs/index.js"));
});

test("release pruning rejects omitted imports through a require alias", () => {
	const app = makeTree({
		"package.json": JSON.stringify({ dependencies: { exceljs: "1" } }),
		"bin/exxperts.cjs": 'const load = require; load("exceljs");',
		"node_modules/exceljs/package.json": JSON.stringify({ name: "exceljs", version: "1" }),
		"node_modules/exceljs/index.js": "module.exports = {};",
	});
	assert.throws(() => pruneNodeModules(path.join(app, "node_modules")), /exceljs.*import|import.*exceljs/i);
	assert.ok(has(app, "node_modules/exceljs/index.js"));
});

test("release pruning rejects omitted imports through module.require bindings", () => {
	const app = makeTree({
		"package.json": JSON.stringify({ dependencies: { exceljs: "1" } }),
		"bin/exxperts.cjs": 'const load = module.require.bind(module); load("exceljs");',
		"node_modules/exceljs/package.json": JSON.stringify({ name: "exceljs", version: "1" }),
		"node_modules/exceljs/index.js": "module.exports = {};",
	});
	assert.throws(() => pruneNodeModules(path.join(app, "node_modules")), /exceljs.*import|import.*exceljs/i);
	assert.ok(has(app, "node_modules/exceljs/index.js"));
});

test("release pruning retains a worker dependency required by another package", () => {
	const app = makeTree({
		"package.json": JSON.stringify({ dependencies: { exceljs: "1", consumer: "1" } }),
		"node_modules/exceljs/package.json": JSON.stringify({ name: "exceljs", version: "1" }),
		"node_modules/exceljs/index.js": "module.exports = {};",
		"node_modules/consumer/package.json": JSON.stringify({ name: "consumer", version: "1", dependencies: { exceljs: "1" } }),
		"node_modules/consumer/index.js": 'require("exceljs");',
	});
	pruneNodeModules(path.join(app, "node_modules"));
	assert.ok(has(app, "node_modules/exceljs/index.js"));
});

test("release pruning rejects missing required dependencies even if also peers", () => {
	const app = makeTree({
		"package.json": JSON.stringify({ dependencies: { exceljs: "1", consumer: "1" } }),
		"node_modules/exceljs/package.json": JSON.stringify({ name: "exceljs", version: "1" }),
		"node_modules/consumer/package.json": JSON.stringify({ name: "consumer", version: "1", dependencies: { missing: "1" }, peerDependencies: { missing: "1" } }),
	});
	assert.throws(() => pruneNodeModules(path.join(app, "node_modules")), /missing required package missing/);
});

test("release pruning rejects escaped package names in imports", () => {
	const app = makeTree({
		"package.json": JSON.stringify({ dependencies: { exceljs: "1" } }),
		"bin/exxperts.cjs": String.raw`import("excel\u006as");`,
		"node_modules/exceljs/package.json": JSON.stringify({ name: "exceljs", version: "1" }),
		"node_modules/exceljs/index.js": "module.exports = {};",
	});
	assert.throws(() => pruneNodeModules(path.join(app, "node_modules")), /escaped|import/i);
	assert.ok(has(app, "node_modules/exceljs/index.js"));
});

test("release pruning follows a renamed createRequire factory", () => {
	const app = makeTree({
		"package.json": JSON.stringify({ dependencies: { exceljs: "1" } }),
		"bin/exxperts.cjs": 'const { createRequire: factory } = require("node:module"); const load = factory(__filename); load("exceljs");',
		"node_modules/exceljs/package.json": JSON.stringify({ name: "exceljs", version: "1" }),
		"node_modules/exceljs/index.js": "module.exports = {};",
		"apps/web-server/dist/shelf-parse-worker.mjs": "export {};",
		"apps/web-server/src/shelf-parse-worker.mjs": "export {};",
	});
	assert.throws(() => pruneNodeModules(path.join(app, "node_modules")), /exceljs.*import|import.*exceljs/i);
	assert.ok(has(app, "node_modules/exceljs/index.js"));
});

test("release pruning resolves escaped imports of retained packages", () => {
	const app = makeTree({
		"package.json": JSON.stringify({ dependencies: { exceljs: "1", shared: "1" } }),
		"bin/exxperts.cjs": String.raw`import("sh\u0061red");`,
		"node_modules/exceljs/package.json": JSON.stringify({ name: "exceljs", version: "1" }),
		"node_modules/exceljs/index.js": "module.exports = {};",
		"node_modules/shared/package.json": JSON.stringify({ name: "shared", version: "1" }),
		"node_modules/shared/index.js": "module.exports = {};",
		"apps/web-server/dist/shelf-parse-worker.mjs": "export {};",
		"apps/web-server/src/shelf-parse-worker.mjs": "export {};",
	});
	pruneNodeModules(path.join(app, "node_modules"));
	assert.ok(has(app, "node_modules/shared/index.js"));
	assert.ok(!has(app, "node_modules/exceljs/index.js"));
});

test("release pruning rejects computed-property and destructured require calls", () => {
	for (const source of ['module["require"]("exceljs");', 'const { require: load } = module; load("exceljs");']) {
		const app = makeTree({
			"package.json": JSON.stringify({ dependencies: { exceljs: "1" } }),
			"bin/exxperts.cjs": source,
			"node_modules/exceljs/package.json": JSON.stringify({ name: "exceljs", version: "1" }),
			"node_modules/exceljs/index.js": "module.exports = {};",
			"apps/web-server/dist/shelf-parse-worker.mjs": "export {};",
			"apps/web-server/src/shelf-parse-worker.mjs": "export {};",
		});
		assert.throws(() => pruneNodeModules(path.join(app, "node_modules")), /exceljs.*import|import.*exceljs/i, source);
		assert.ok(has(app, "node_modules/exceljs/index.js"));
	}
});

test("release pruning follows module.require aliases", () => {
	const app = makeTree({
		"package.json": JSON.stringify({ dependencies: { exceljs: "1" } }),
		"bin/exxperts.cjs": 'const load = module.require; load("exceljs");',
		"node_modules/exceljs/package.json": JSON.stringify({ name: "exceljs", version: "1" }),
		"node_modules/exceljs/index.js": "module.exports = {};",
		"apps/web-server/dist/shelf-parse-worker.mjs": "export {};",
		"apps/web-server/src/shelf-parse-worker.mjs": "export {};",
	});
	assert.throws(() => pruneNodeModules(path.join(app, "node_modules")), /exceljs.*import|import.*exceljs/i);
	assert.ok(has(app, "node_modules/exceljs/index.js"));
});

test("release pruning follows direct createRequire calls", () => {
	const app = makeTree({
		"package.json": JSON.stringify({ dependencies: { exceljs: "1" } }),
		"bin/exxperts.cjs": 'createRequire(__filename)("exceljs");',
		"node_modules/exceljs/package.json": JSON.stringify({ name: "exceljs", version: "1" }),
		"node_modules/exceljs/index.js": "module.exports = {};",
		"apps/web-server/dist/shelf-parse-worker.mjs": "export {};",
		"apps/web-server/src/shelf-parse-worker.mjs": "export {};",
	});
	assert.throws(() => pruneNodeModules(path.join(app, "node_modules")), /exceljs.*import|import.*exceljs/i);
	assert.ok(has(app, "node_modules/exceljs/index.js"));
});

test("release pruning follows string-named createRequire imports", () => {
	const app = makeTree({
		"package.json": JSON.stringify({ dependencies: { exceljs: "1" } }),
		"bin/exxperts.cjs": 'import { "createRequire" as factory } from "node:module"; const load = factory(import.meta.url); load("exceljs");',
		"node_modules/exceljs/package.json": JSON.stringify({ name: "exceljs", version: "1" }),
		"node_modules/exceljs/index.js": "module.exports = {};",
		"apps/web-server/dist/shelf-parse-worker.mjs": "export {};",
		"apps/web-server/src/shelf-parse-worker.mjs": "export {};",
	});
	assert.throws(() => pruneNodeModules(path.join(app, "node_modules")), /exceljs.*import|import.*exceljs/i);
	assert.ok(has(app, "node_modules/exceljs/index.js"));
});
