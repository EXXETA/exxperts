// Unit tests for bundling the web server (scripts/bundle-server.mjs) and the
// runtime behaviour it relies on.
//
//   npm run test:scripts
//
// The runtime cases bundle the built runtime (npm run build runs first), so
// they check the code that ships rather than a copy of it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

import { bundleServer, checkServerFiles, EXTERNAL_PACKAGES, FILE_PACKAGES, REVIEWED_DYNAMIC_LOADS, REVIEWED_OWN_LOCATION_READS } from "./bundle-server.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const tempDirs = [];
after(() => {
	for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTree(files) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-bundle-test-"));
	tempDirs.push(dir);
	for (const [rel, content] of Object.entries(files)) {
		if (content === null) continue;
		const full = path.join(dir, ...rel.split("/"));
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content);
	}
	return dir;
}

function runNode(file, extraEnv = {}) {
	const env = { ...process.env, ...extraEnv };
	delete env.PI_PACKAGE_DIR;
	const res = spawnSync(process.execPath, [file], { encoding: "utf8", env });
	assert.equal(res.status, 0, res.stderr);
	return res.stdout.trim();
}

test("the bundled runtime reads its own package.json through the build-time define", async () => {
	// An install root whose own package.json would win the walk up from the
	// bundle folder, and the runtime package the define points at.
	const dir = makeTree({
		"package.json": JSON.stringify({ name: "the-app", version: "9.9.9" }),
		"runtime/packages/coding-agent/package.json": JSON.stringify({
			name: "@exxeta/exxperts-runtime",
			version: "7.7.7",
			piConfig: { name: "exxperts", configDir: ".exxperts" },
		}),
	});
	const configJs = path.join(repoRoot, "runtime", "packages", "coding-agent", "dist", "config.js");
	const outfile = path.join(dir, "apps", "web-server", "dist", "probe.mjs");
	await esbuild.build({
		stdin: {
			contents: `import { getPackageDir, VERSION } from ${JSON.stringify(configJs)}; console.log(JSON.stringify({ dir: getPackageDir(), version: VERSION }));`,
			resolveDir: repoRoot,
			loader: "js",
		},
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		outfile,
		logLevel: "silent",
		banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
		define: { __EXXPERTS_BUNDLED_PACKAGE_DIR__: JSON.stringify("../../../runtime/packages/coding-agent") },
	});
	const result = JSON.parse(runNode(outfile));
	assert.equal(fs.realpathSync.native(result.dir), fs.realpathSync.native(path.join(dir, "runtime", "packages", "coding-agent")));
	assert.equal(result.version, "7.7.7");
});

test("the bundled OAuth page finds the exxperts logo under EXXETA_HOME", async () => {
	// Bundled, the page's own folder is apps/web-server/dist, so its walk up to
	// the repository root overshoots the install root.
	const dir = makeTree({ "apps/web-ui/dist/brand/exxperts-logo-negative.png": "fixture-logo" });
	const pageJs = path.join(repoRoot, "runtime", "packages", "ai", "dist", "utils", "oauth", "oauth-page.js");
	const outfile = path.join(dir, "apps", "web-server", "dist", "probe.mjs");
	await esbuild.build({
		stdin: { contents: `import { oauthSuccessHtml } from ${JSON.stringify(pageJs)}; console.log(oauthSuccessHtml("done"));`, resolveDir: repoRoot, loader: "js" },
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		outfile,
		logLevel: "silent",
	});
	const html = runNode(outfile, { EXXETA_HOME: dir });
	assert.ok(html.includes(`data:image/png;base64,${Buffer.from("fixture-logo").toString("base64")}`), html.slice(0, 400));
});

// A fixture install tree: the entry imports first-party modules that keep
// their adapter specifiers in `as string` constants, the runtime's Bedrock
// helper, and two packages whose files the bundle must copy beside itself.
// Every package that must ship as files is present as an empty package; an
// override set to null leaves a file out.
const SHIPPED_PACKAGE_STUBS = Object.fromEntries(
	[...EXTERNAL_PACKAGES.filter((pkg) => pkg.ships), ...FILE_PACKAGES].map(({ name }) => [
		`node_modules/${name}/package.json`,
		JSON.stringify({ name, version: "1.0.0", license: "MIT" }),
	]),
);

function fixtureTree(overrides = {}) {
	return makeTree({
		...SHIPPED_PACKAGE_STUBS,
		"package.json": JSON.stringify({ name: "the-app", version: "1.0.0", type: "module" }),
		"apps/web-server/src/index.ts": [
			'import { adminConfig } from "./mcp-admin.ts";',
			'import { panel } from "../../../pi-package/extensions/mcp/index.ts";',
			'import { loadBedrock } from "../../../runtime/packages/ai/dist/providers/register-builtins.js";',
			'import { photonName } from "@silvia-odwyer/photon-node";',
			'import { bridge } from "pi-mcp-adapter/ui-server.ts";',
			"console.log(JSON.stringify({ config: await adminConfig(), panel: await panel(), bedrock: await loadBedrock(), photon: photonName, bridge }));",
		].join("\n"),
		"apps/web-server/src/mcp-admin.ts": [
			'const ADAPTER_CONFIG = "pi-mcp-adapter/config.ts" as string;',
			"export async function adminConfig(): Promise<string> { return (await import(ADAPTER_CONFIG)).marker; }",
		].join("\n"),
		"apps/web-server/src/shelf-parse-worker.mjs": "process.exit(0);\n",
		"pi-package/extensions/mcp/index.ts": [
			'const CONNECTORS_PANEL_SPECIFIER = "./connectors-panel.ts" as string;',
			"export async function panel(): Promise<string> { return (await import(CONNECTORS_PANEL_SPECIFIER)).marker; }",
		].join("\n"),
		"pi-package/extensions/mcp/connectors-panel.ts": 'export const marker: string = "panel-inlined";\n',
		"runtime/packages/ai/package.json": JSON.stringify({ name: "@exxeta/exxperts-ai", version: "0.1.0", license: "MIT", type: "module" }),
		"runtime/packages/ai/dist/providers/register-builtins.js": [
			"const importNodeOnlyProvider = (specifier) => import(specifier);",
			'export async function loadBedrock() { return (await importNodeOnlyProvider("./amazon-bedrock.js")).marker; }',
		].join("\n"),
		"runtime/packages/ai/dist/providers/amazon-bedrock.js": 'export const marker = "bedrock-inlined";\n',
		"node_modules/pi-mcp-adapter/package.json": JSON.stringify({ name: "pi-mcp-adapter", version: "2.10.0", license: "MIT" }),
		"node_modules/pi-mcp-adapter/LICENSE": "MIT licence text of the adapter\n",
		"node_modules/pi-mcp-adapter/config.ts": 'export const marker: string = "config-inlined";\n',
		"node_modules/pi-mcp-adapter/ui-server.ts": 'export const bridge: string = "bridge";\n',
		"node_modules/pi-mcp-adapter/app-bridge.bundle.js": "/* app bridge */\n",
		"node_modules/@silvia-odwyer/photon-node/package.json": JSON.stringify({ name: "@silvia-odwyer/photon-node", version: "0.3.4", license: "Apache-2.0", main: "photon.js" }),
		"node_modules/@silvia-odwyer/photon-node/photon.js": 'exports.photonName = "photon";\n',
		"node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm": "wasm",
		...overrides,
	});
}

test("the bundle turns specifier constants and the Bedrock helper into literal imports it can inline", async () => {
	const dir = fixtureTree();
	await bundleServer({ root: dir, log: () => {} });
	const outFile = path.join(dir, "apps", "web-server", "dist", "server.mjs");
	const bundle = fs.readFileSync(outFile, "utf8");
	assert.doesNotMatch(bundle, /import\(ADAPTER_CONFIG\)|import\(CONNECTORS_PANEL_SPECIFIER\)|importNodeOnlyProvider\("\.\/amazon-bedrock\.js"\)/);
	const result = JSON.parse(runNode(outFile));
	assert.equal(result.config, "config-inlined");
	assert.equal(result.panel, "panel-inlined");
	assert.equal(result.bedrock, "bedrock-inlined");
});

test("the bundle fails loudly when the Bedrock helper call changes shape", async () => {
	const dir = fixtureTree({
		"runtime/packages/ai/dist/providers/register-builtins.js": [
			"const importNodeOnlyProvider = (specifier) => import(specifier);",
			'export async function loadBedrock() { return (await importNodeOnlyProvider("./bedrock-v2.js")).marker; }',
		].join("\n"),
	});
	await assert.rejects(bundleServer({ root: dir, log: () => {} }), /register-builtins\.js.*Bedrock/s);
});

test("the bundle copies the files its code reads beside itself, writes the licences and moves the map out", async () => {
	const dir = fixtureTree();
	const mapFile = path.join(makeTree({}), "maps", "server.mjs.map");
	await bundleServer({ root: dir, mapFile, log: () => {} });
	const outDir = path.join(dir, "apps", "web-server", "dist");
	assert.deepEqual(fs.readdirSync(outDir).sort(), ["app-bridge.bundle.js", "photon_rs_bg.wasm", "server.mjs", "server.mjs.licenses.txt", "shelf-parse-worker.mjs"]);
	assert.ok(fs.statSync(mapFile).size > 0);
	const licences = fs.readFileSync(path.join(outDir, "server.mjs.licenses.txt"), "utf8");
	assert.match(licences, /pi-mcp-adapter 2\.10\.0 \(MIT\)[\s\S]*MIT licence text of the adapter/);
	assert.match(licences, /@silvia-odwyer\/photon-node 0\.3\.4 \(Apache-2\.0\)/);
	assert.match(licences, /@exxeta\/exxperts-ai 0\.1\.0 \(MIT\)/);
});

test("the shipped bundle drops whitespace and comments but keeps licence headers, and the checks still see each file", async () => {
	const index = (extra) => ['import "@silvia-odwyer/photon-node";', 'import "pi-mcp-adapter/ui-server.ts";', 'import { notice } from "headed";', ...extra, "console.log(notice);"].join("\n");
	const headed = {
		"node_modules/headed/package.json": JSON.stringify({ name: "headed", version: "1.0.0", license: "Apache-2.0", main: "index.js" }),
		"node_modules/headed/index.js": "/**\n * @license\n * Copyright 2025 Headed Authors\n */\n// an ordinary comment that should not ship\nexports.notice = \"headed\";\n",
	};
	const dir = fixtureTree({ ...headed, "apps/web-server/src/index.ts": index([]) });
	await bundleServer({ root: dir, log: () => {} });
	const outFile = path.join(dir, "apps", "web-server", "dist", "server.mjs");
	const shipped = fs.readFileSync(outFile, "utf8");
	assert.doesNotMatch(shipped, /^\/\/ node_modules\/headed\/index\.js$/m, "the module path comments stay out of the shipped file");
	assert.doesNotMatch(shipped, /an ordinary comment/);
	assert.match(shipped, /Copyright 2025 Headed Authors/);
	assert.equal(runNode(outFile), "headed");
	// The checks read an unminified build, so they still name the file.
	const loads = fixtureTree({ ...headed, "apps/web-server/src/index.ts": index(['import { load } from "./plugin-loader.ts";', "console.log(typeof load);"]), "apps/web-server/src/plugin-loader.ts": "export const load = (name: string) => import(name);\n" });
	await assert.rejects(bundleServer({ root: loads, log: () => {} }), /apps\/web-server\/src\/plugin-loader\.ts/);
});

test("an optional peer that is not installed fails only when loaded, as it does unbundled", async () => {
	const dir = fixtureTree({
		"apps/web-server/src/index.ts": [
			'import { traced } from "sdk";',
			'import "@silvia-odwyer/photon-node";',
			'import "pi-mcp-adapter/ui-server.ts";',
			"console.log(JSON.stringify({ traced: await traced() }));",
		].join("\n"),
		"node_modules/sdk/package.json": JSON.stringify({
			name: "sdk",
			version: "2.7.0",
			license: "Apache-2.0",
			type: "module",
			exports: "./index.js",
			peerDependencies: { "otel-api": "^1.9.0" },
			peerDependenciesMeta: { "otel-api": { optional: true } },
		}),
		"node_modules/sdk/index.js": 'export async function traced() { try { return (await import("./otel.js")).name; } catch (error) { return `no-op: ${error.message}`; } }\n',
		"node_modules/sdk/otel.js": 'import { trace } from "otel-api";\nexport const name = trace.name;\n',
	});
	await bundleServer({ root: dir, log: () => {} });
	const result = JSON.parse(runNode(path.join(dir, "apps", "web-server", "dist", "server.mjs")));
	assert.match(result.traced, /^no-op: .*otel-api/);
});

test("a missing package that is not an optional peer still fails the bundle", async () => {
	const dir = fixtureTree({
		"apps/web-server/src/index.ts": 'import { thing } from "not-installed";\nconsole.log(thing);\n',
	});
	await assert.rejects(bundleServer({ root: dir, log: () => {} }), /not-installed/);
});

test("a computed import() outside the reviewed places fails the bundle and names the file", async () => {
	const dir = fixtureTree({
		"apps/web-server/src/index.ts": [
			'import "@silvia-odwyer/photon-node";',
			'import "pi-mcp-adapter/ui-server.ts";',
			'import { load } from "./plugin-loader.ts";',
			'import { notes } from "./notes.ts";',
			"console.log(typeof load, notes);",
		].join("\n"),
		"apps/web-server/src/plugin-loader.ts": "export const load = (name: string) => import(name);\n",
		"apps/web-server/src/notes.ts": "// an inline `import()` or obj.import(name) in a comment loads nothing\nexport const notes = { import: (name: string) => name }.import(\"x\");\n",
	});
	await assert.rejects(bundleServer({ root: dir, log: () => {} }), (error) => {
		assert.match(error.message, /apps\/web-server\/src\/plugin-loader\.ts/);
		assert.doesNotMatch(error.message, /notes\.ts/);
		return true;
	});
});

test("a read relative to the code's own folder outside the reviewed places fails the bundle", async () => {
	const dir = fixtureTree({
		"apps/web-server/src/index.ts": [
			'import "@silvia-odwyer/photon-node";',
			'import "pi-mcp-adapter/ui-server.ts";',
			'import data from "reads-own-folder";',
			"console.log(data);",
		].join("\n"),
		"node_modules/reads-own-folder/package.json": JSON.stringify({ name: "reads-own-folder", version: "1.0.0", license: "MIT" }),
		"node_modules/reads-own-folder/index.js": 'module.exports = require("node:fs").readFileSync(__dirname + "/data.txt", "utf8");\n',
	});
	await assert.rejects(bundleServer({ root: dir, log: () => {} }), /node_modules\/reads-own-folder\/index\.js/);
});

test("a new read relative to the code's own folder in a reviewed file fails the bundle and names the file and the count", async () => {
	// index.ts is reviewed for a number of own-location places; one more, such
	// as a page read from beside the bundle, would break only the bundle.
	const reviewed = REVIEWED_OWN_LOCATION_READS.find((entry) => entry.file.test("apps/web-server/src/index.ts")).sites;
	const reads = Array.from({ length: reviewed + 1 }, (_, i) => `const page${i} = new URL("./page-${i}.html", import.meta.url);`);
	const dir = fixtureTree({
		"apps/web-server/src/index.ts": ['import "@silvia-odwyer/photon-node";', 'import "pi-mcp-adapter/ui-server.ts";', ...reads, `console.log(${reads.map((_, i) => `page${i}`).join(", ")});`].join("\n"),
	});
	await assert.rejects(bundleServer({ root: dir, log: () => {} }), (error) => {
		assert.match(error.message, new RegExp(`apps/web-server/src/index\\.ts has ${reviewed + 1} places .*${reviewed} reviewed`));
		return true;
	});
});

test("a new computed import() in a reviewed file fails the bundle", async () => {
	const reviewed = REVIEWED_DYNAMIC_LOADS.find((entry) => entry.file.test("node_modules/pi-mcp-adapter/glimpse-ui.ts")).sites;
	const loads = Array.from({ length: reviewed + 1 }, (_, i) => `export const load${i} = (name: string) => import(name);`);
	const dir = fixtureTree({
		"apps/web-server/src/index.ts": 'import "@silvia-odwyer/photon-node";\nimport "pi-mcp-adapter/ui-server.ts";\nimport * as glimpse from "pi-mcp-adapter/glimpse-ui.ts";\nconsole.log(Object.keys(glimpse));\n',
		"node_modules/pi-mcp-adapter/glimpse-ui.ts": `${loads.join("\n")}\n`,
	});
	await assert.rejects(bundleServer({ root: dir, log: () => {} }), new RegExp(`pi-mcp-adapter/glimpse-ui\\.ts has ${reviewed + 1} places that load a module by a computed name`));
});

test("a package loaded by name at run time must ship as files or be reviewed", async () => {
	// The review's reproduction: a createRequire of a package that is inlined
	// nowhere and ships nowhere passes every other check, and only the trimmed
	// desktop payload, which keeps just the shipped packages, would lack it.
	const index = (name) => ['import { createRequire } from "node:module";', 'import "@silvia-odwyer/photon-node";', 'import "pi-mcp-adapter/ui-server.ts";', `console.log(typeof createRequire(import.meta.url)(${JSON.stringify(name)}));`].join("\n");
	await bundleServer({ root: fixtureTree({ "apps/web-server/src/index.ts": index("qrcode-terminal") }), log: () => {} });
	const dir = fixtureTree({
		"apps/web-server/src/index.ts": index("mime-types"),
		"node_modules/mime-types/package.json": JSON.stringify({ name: "mime-types", version: "3.0.1", license: "MIT" }),
	});
	await assert.rejects(bundleServer({ root: dir, log: () => {} }), /mime-types.*(server\.mjs line \d+).*FILE_PACKAGES/s);
});

test("an external that does not ship may not be imported at the top of the bundle", async () => {
	const dir = fixtureTree({
		"apps/web-server/src/index.ts": 'import "@silvia-odwyer/photon-node";\nimport "pi-mcp-adapter/ui-server.ts";\nimport "koffi";\n',
		"node_modules/koffi/package.json": JSON.stringify({ name: "koffi", version: "2.9.0", license: "MIT" }),
	});
	await assert.rejects(bundleServer({ root: dir, log: () => {} }), /koffi/);
});

test("the shelf worker may import only packages that ship as files", async () => {
	const dir = fixtureTree({
		"apps/web-server/src/shelf-parse-worker.mjs": 'const { default: pad } = await import("left-pad");\nconsole.log(pad);\n',
		"node_modules/left-pad/package.json": JSON.stringify({ name: "left-pad", version: "1.3.0", license: "WTFPL" }),
	});
	await assert.rejects(bundleServer({ root: dir, log: () => {} }), /left-pad/);
});

test("a package with neither a licence file nor a license field fails the bundle", async () => {
	const dir = fixtureTree({
		"apps/web-server/src/index.ts": 'import "@silvia-odwyer/photon-node";\nimport "pi-mcp-adapter/ui-server.ts";\nimport { x } from "unlicensed";\nconsole.log(x);\n',
		"node_modules/unlicensed/package.json": JSON.stringify({ name: "unlicensed", version: "0.0.1", main: "index.js" }),
		"node_modules/unlicensed/index.js": "exports.x = 1;\n",
	});
	await assert.rejects(bundleServer({ root: dir, log: () => {} }), /unlicensed/);
});

test("a shipped package or one of its dependencies missing from the tree fails the bundle", async () => {
	await assert.rejects(bundleServer({ root: fixtureTree({ "node_modules/jszip/package.json": null }), log: () => {} }), /jszip/);
	const dir = fixtureTree({
		"node_modules/jsdom/package.json": JSON.stringify({ name: "jsdom", version: "29.1.1", license: "MIT", dependencies: { "whatwg-url": "^15.0.0" } }),
	});
	await assert.rejects(bundleServer({ root: dir, log: () => {} }), /whatwg-url.*jsdom/);
});

test("checkServerFiles finds a pruned package or asset in a payload", async () => {
	const dir = fixtureTree();
	await bundleServer({ root: dir, log: () => {} });
	assert.deepEqual(checkServerFiles(dir), []);
	fs.rmSync(path.join(dir, "node_modules", "qrcode-terminal"), { recursive: true });
	fs.rmSync(path.join(dir, "apps", "web-server", "dist", "photon_rs_bg.wasm"));
	const problems = checkServerFiles(dir).join("\n");
	assert.match(problems, /qrcode-terminal/);
	assert.match(problems, /photon_rs_bg\.wasm/);
});

test("reviewed runtime places pass whether the runtime is linked from its workspace or copied into node_modules", async () => {
	for (const runtimeDir of ["runtime/packages/ai", "node_modules/@exxeta/exxperts-ai"]) {
		const dir = fixtureTree({
			"apps/web-server/src/index.ts": [
				'import "@silvia-odwyer/photon-node";',
				'import "pi-mcp-adapter/ui-server.ts";',
				'import { loadBuiltin } from "@exxeta/exxperts-ai/env-api-keys";',
				"console.log(typeof loadBuiltin);",
			].join("\n"),
			[`${runtimeDir}/package.json`]: JSON.stringify({ name: "@exxeta/exxperts-ai", version: "0.74.0", license: "MIT", type: "module", exports: { "./env-api-keys": "./dist/env-api-keys.js" } }),
			[`${runtimeDir}/dist/env-api-keys.js`]: 'const fsModule = "node:fs";\nexport const loadBuiltin = () => import(fsModule);\n',
			...(runtimeDir.startsWith("runtime/") ? { "node_modules/@exxeta/exxperts-ai": null } : {}),
		});
		if (runtimeDir.startsWith("runtime/")) {
			fs.mkdirSync(path.join(dir, "node_modules", "@exxeta"), { recursive: true });
			fs.symlinkSync(path.join(dir, "runtime", "packages", "ai"), path.join(dir, "node_modules", "@exxeta", "exxperts-ai"), "junction");
		}
		await bundleServer({ root: dir, log: () => {} });
	}
});

test("the launchers start the bundle in an installed tree and the TypeScript source in a checkout", () => {
	const { serverLaunchArgs } = createRequire(import.meta.url)("../bin/lib/server-entry.cjs");
	const dir = makeTree({
		"package.json": JSON.stringify({ name: "the-app", version: "1.0.0" }),
		"apps/web-server/src/index.ts": "export {};\n",
		"node_modules/tsx/package.json": JSON.stringify({ name: "tsx", exports: { "./cli": "./dist/cli.mjs", "./package.json": "./package.json" } }),
		"node_modules/tsx/dist/cli.mjs": "",
		"node_modules/tsx/dist/preflight.cjs": "",
		"node_modules/tsx/dist/loader.mjs": "",
	});
	// Real paths on both sides: require.resolve returns them (/private/var on
	// macOS, long names on Windows).
	const real = (args) => args.map((arg) => (arg.startsWith("--") || arg.startsWith("file:") ? arg : fs.realpathSync.native(arg)));
	const source = path.join(dir, "apps", "web-server", "src", "index.ts");
	const bundled = path.join(dir, "apps", "web-server", "dist", "server.mjs");
	const tsxCli = real([path.join(dir, "node_modules", "tsx", "dist", "cli.mjs"), source]);

	// No bundle: the source through tsx, as the CLI wrapper or as loader flags.
	assert.deepEqual(real(serverLaunchArgs(dir, { env: {} })), tsxCli);
	const loader = real(serverLaunchArgs(dir, { env: {}, tsxLoader: true }));
	assert.deepEqual([loader[0], loader[1], loader[2], loader[4]], real(["--require", path.join(dir, "node_modules", "tsx", "dist", "preflight.cjs"), "--import", source]));
	assert.match(loader[3], /^file:.*loader\.mjs$/);

	// An installed tree with the bundle: plain node over the bundle.
	fs.mkdirSync(path.dirname(bundled), { recursive: true });
	fs.writeFileSync(bundled, "");
	assert.deepEqual(serverLaunchArgs(dir, { env: {} }), [bundled]);
	assert.deepEqual(serverLaunchArgs(dir, { env: {}, tsxLoader: true }), [bundled]);

	// A checkout (a .git folder, or the file a worktree has) keeps the source,
	// unless EXXPERTS_SERVER_BUNDLE=1 asks for the bundle.
	fs.writeFileSync(path.join(dir, ".git"), "gitdir: elsewhere\n");
	assert.deepEqual(real(serverLaunchArgs(dir, { env: {} })), tsxCli);
	assert.deepEqual(serverLaunchArgs(dir, { env: { EXXPERTS_SERVER_BUNDLE: "1" } }), [bundled]);
});

test("the bundle checks never take a package from above the install root", async () => {
	// A required dependency that exists only in a node_modules folder above the
	// root, as a checkout holding a staged payload has, must count as missing.
	const outer = makeTree({ "node_modules/whatwg-url/package.json": JSON.stringify({ name: "whatwg-url", version: "15.0.0", license: "MIT" }) });
	const root = path.join(outer, "app");
	fs.renameSync(
		fixtureTree({ "node_modules/jsdom/package.json": JSON.stringify({ name: "jsdom", version: "29.1.1", license: "MIT", dependencies: { "whatwg-url": "^15.0.0" } }) }),
		root,
	);
	await assert.rejects(bundleServer({ root, log: () => {} }), /whatwg-url \(needed by jsdom\) is missing/);
	assert.match(checkServerFiles(root).join("\n"), /whatwg-url \(needed by jsdom\) is missing/);
});
