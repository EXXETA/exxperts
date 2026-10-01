// Unit tests for the desktop payload prune (scripts/prune-payload.mjs).
//
//   npm run test:scripts   (from the repository root)
//
// Each test builds a small staged app/ tree in a temp dir, runs the prune and
// checks what is left.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { BUNDLE_ASSETS, EXTERNAL_PACKAGES, FILE_PACKAGES, LICENCES_FILE } from "../../../scripts/bundle-server.mjs";
import { DESKTOP_MAX_FILES, pruneDesktopPayload } from "./prune-payload.mjs";

const tempDirs = [];
after(() => {
	for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTree(files) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-prune-payload-test-"));
	tempDirs.push(dir);
	for (const [rel, content] of Object.entries(files)) {
		if (content === null) continue;
		const full = path.join(dir, ...rel.split("/"));
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content);
	}
	return dir;
}

function listFiles(dir, rel = "") {
	const files = [];
	for (const entry of fs.readdirSync(path.join(dir, ...rel.split("/").filter(Boolean)), { withFileTypes: true })) {
		const childRel = rel ? `${rel}/${entry.name}` : entry.name;
		if (entry.isDirectory()) files.push(...listFiles(dir, childRel));
		else files.push(childRel);
	}
	return files.sort();
}

const pkg = (name, extra = {}) => JSON.stringify({ name, version: "1.0.0", license: "MIT", ...extra });

// A staged app/ tree as the release archive carries it: the bundled server
// and what the desktop keeps, next to the CLI, the sources and packages only
// the CLI or tsx use.
function stagedApp(overrides = {}) {
	const shipped = Object.fromEntries(
		[...EXTERNAL_PACKAGES.filter((entry) => entry.ships), ...FILE_PACKAGES].map(({ name }) => [`node_modules/${name}/package.json`, pkg(name)]),
	);
	const dist = Object.fromEntries(
		["server.mjs", LICENCES_FILE, ...BUNDLE_ASSETS.map((asset) => asset.file)].map((file) => [`apps/web-server/dist/${file}`, "x"]),
	);
	return makeTree({
		...shipped,
		...dist,
		"package.json": pkg("@exxeta/exxperts-app"),
		"CHANGELOG.md": "# Changelog\n",
		"LICENSE": "Apache-2.0\n",
		"README.md": "readme\n",
		"docs/quickstart.md": "docs\n",
		"docs/assets/logo.png": "png",
		"apps/web-server/src/index.ts": "ts\n",
		"apps/web-server/package.json": pkg("@exxeta/pi-web-server"),
		"apps/web-ui/dist/index.html": "<html></html>\n",
		"apps/web-ui/src/model-names.ts": "ts\n",
		"pi-package/package.json": pkg("@exxeta/pi-exxeta"),
		"pi-package/extensions/mcp/index.ts": "ts\n",
		"runtime/packages/ai/dist/index.js": "js\n",
		"runtime/packages/coding-agent/package.json": pkg("@exxeta/exxperts-runtime"),
		"runtime/packages/coding-agent/dist/cli.js": "js\n",
		"runtime/packages/coding-agent/dist/modes/interactive/theme/dark.json": "{}",
		"runtime/packages/coding-agent/dist/modes/interactive/assets/logo.txt": "x",
		"runtime/packages/coding-agent/dist/core/export-html/template.html": "<html></html>\n",
		"bin/exxperts.cjs": "cli\n",
		"bin/lib/web-launcher.cjs": "cli\n",
		"bin/lib/server-entry.cjs": "entry\n",
		"bin/lib/state-profiles.cjs": "profiles\n",
		"bin/lib/room-lock.cjs": "lock\n",
		"bin/lib/product-state-paths.cjs": "paths\n",
		"bin/lib/persistent-room-create.ts": "ts\n",
		"scripts/doctor.mjs": "doctor\n",
		"scripts/searxng.mjs": "searxng\n",
		"scripts/bundle-release.mjs": "release\n",
		"node_modules/.bin/tsx": "bin\n",
		"node_modules/tsx/package.json": pkg("tsx"),
		"node_modules/esbuild/package.json": pkg("esbuild"),
		"node_modules/@esbuild/darwin-arm64/package.json": pkg("@esbuild/darwin-arm64"),
		"node_modules/@exxeta/exxperts-ai/dist/index.js": "js\n",
		...overrides,
	});
}

test("keeps only the listed paths outside node_modules", () => {
	const dir = stagedApp();
	pruneDesktopPayload(dir, { log: () => {} });
	const outside = listFiles(dir).filter((file) => !file.startsWith("node_modules/"));
	assert.deepEqual(outside, [
		"CHANGELOG.md",
		"LICENSE",
		"apps/web-server/dist/app-bridge.bundle.js",
		"apps/web-server/dist/photon_rs_bg.wasm",
		"apps/web-server/dist/server.mjs",
		`apps/web-server/dist/${LICENCES_FILE}`,
		"apps/web-server/dist/shelf-parse-worker.mjs",
		"apps/web-ui/dist/index.html",
		"bin/lib/product-state-paths.cjs",
		"bin/lib/room-lock.cjs",
		"bin/lib/server-entry.cjs",
		"bin/lib/state-profiles.cjs",
		"package.json",
		"runtime/packages/coding-agent/dist/core/export-html/template.html",
		"runtime/packages/coding-agent/dist/modes/interactive/assets/logo.txt",
		"runtime/packages/coding-agent/dist/modes/interactive/theme/dark.json",
		"runtime/packages/coding-agent/package.json",
		"scripts/doctor.mjs",
		"scripts/searxng.mjs",
	].sort());
});

test("trims node_modules to the packages the bundled server loads as files and their dependencies", () => {
	const dir = stagedApp({
		"node_modules/jsdom/package.json": pkg("jsdom", { dependencies: { "whatwg-url": "^15.0.0", tough: "^5.0.0" } }),
		"node_modules/jsdom/node_modules/tough/package.json": pkg("tough"),
		"node_modules/jsdom/node_modules/tough/node_modules/unused/package.json": pkg("unused"),
		"node_modules/whatwg-url/package.json": pkg("whatwg-url"),
		"node_modules/whatwg-url/LICENSE": "MIT\n",
		"node_modules/@napi-rs/canvas/package.json": pkg("@napi-rs/canvas", { optionalDependencies: { "@napi-rs/canvas-darwin-arm64": "0.1.81", "@napi-rs/canvas-win32-x64-msvc": "0.1.81" } }),
		"node_modules/@napi-rs/canvas-darwin-arm64/package.json": pkg("@napi-rs/canvas-darwin-arm64"),
		"node_modules/@napi-rs/unrelated/package.json": pkg("@napi-rs/unrelated"),
		"node_modules/@scope-only-unused/thing/package.json": pkg("@scope-only-unused/thing"),
	});
	pruneDesktopPayload(dir, { log: () => {} });
	const packages = listFiles(dir)
		.filter((file) => file.startsWith("node_modules/"))
		.map((file) => path.posix.dirname(file));
	for (const kept of ["node_modules/jsdom", "node_modules/jsdom/node_modules/tough", "node_modules/whatwg-url", "node_modules/@napi-rs/canvas", "node_modules/@napi-rs/canvas-darwin-arm64", "node_modules/qrcode-terminal", "node_modules/recheck"]) {
		assert.ok(packages.includes(kept), `${kept} was removed`);
	}
	for (const removed of ["node_modules/.bin", "node_modules/tsx", "node_modules/esbuild", "node_modules/@esbuild/darwin-arm64", "node_modules/@exxeta/exxperts-ai/dist", "node_modules/@napi-rs/unrelated", "node_modules/jsdom/node_modules/tough/node_modules/unused"]) {
		assert.ok(!packages.includes(removed), `${removed} was kept`);
	}
	assert.ok(!fs.existsSync(path.join(dir, "node_modules", "@scope-only-unused")), "an emptied scope folder was kept");
	assert.ok(!fs.existsSync(path.join(dir, "node_modules", "@esbuild")), "an emptied scope folder was kept");
	assert.ok(fs.existsSync(path.join(dir, "node_modules", "whatwg-url", "LICENSE")));
});

test("drops recheck's Java fallback and keeps its native checker", () => {
	const dir = stagedApp({
		"node_modules/recheck/package.json": pkg("recheck", {
			dependencies: { synckit: "0.9.2" },
			optionalDependencies: { "recheck-jar": "4.5.0", "recheck-macos-arm64": "4.5.0", "recheck-windows-x64": "4.5.0" },
		}),
		"node_modules/synckit/package.json": pkg("synckit"),
		"node_modules/recheck-jar/package.json": pkg("recheck-jar"),
		"node_modules/recheck-jar/recheck.jar": "jar",
		"node_modules/recheck-macos-arm64/package.json": pkg("recheck-macos-arm64"),
	});
	pruneDesktopPayload(dir, { log: () => {} });
	assert.ok(!fs.existsSync(path.join(dir, "node_modules", "recheck-jar")), "recheck-jar was kept");
	for (const kept of ["recheck", "synckit", "recheck-macos-arm64"]) {
		assert.ok(fs.existsSync(path.join(dir, "node_modules", kept, "package.json")), `${kept} was removed`);
	}
});

test("keeps a dropped package when a kept package requires it", () => {
	const dir = stagedApp({
		"node_modules/recheck/package.json": pkg("recheck", { dependencies: { "recheck-jar": "4.5.0" } }),
		"node_modules/recheck-jar/package.json": pkg("recheck-jar"),
	});
	pruneDesktopPayload(dir, { log: () => {} });
	assert.ok(fs.existsSync(path.join(dir, "node_modules", "recheck-jar", "package.json")), "a required recheck-jar was removed");
});

test("fails when the trimmed payload misses a file the bundled server or the shell needs", () => {
	assert.throws(() => pruneDesktopPayload(stagedApp({ "apps/web-server/dist/photon_rs_bg.wasm": null }), { log: () => {} }), /photon_rs_bg\.wasm/);
	assert.throws(() => pruneDesktopPayload(stagedApp({ "node_modules/jszip/package.json": null }), { log: () => {} }), /jszip/);
	assert.throws(() => pruneDesktopPayload(stagedApp({ "bin/lib/server-entry.cjs": null }), { log: () => {} }), /server-entry\.cjs/);
});

test("fails when the trimmed payload holds more files than the ceiling", () => {
	const dir = stagedApp();
	assert.throws(() => pruneDesktopPayload(dir, { log: () => {}, maxFiles: 3 }), /app\/ would carry \d+ files, over the ceiling of 3\./);
	assert.ok(DESKTOP_MAX_FILES >= 2_500, "the shipped ceiling leaves room above the measured payload");
	pruneDesktopPayload(stagedApp(), { log: () => {} });
});
