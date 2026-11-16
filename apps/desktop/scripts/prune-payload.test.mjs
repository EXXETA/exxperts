// Unit tests for the desktop payload prune (scripts/prune-payload.mjs).
//
//   npm run test:scripts   (from the repository root)
//
// Each test builds a small staged app/ tree in a temp dir, runs the prune and
// checks what is left.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { pruneNodeModules as pruneArchiveNodeModules } from "../../../scripts/bundle-release-prune.mjs";
import { BUNDLE_ASSETS, bundleEntryAssets, EXTERNAL_PACKAGES, FILE_PACKAGES, LICENCES_FILE } from "../../../scripts/bundle-server.mjs";
import { countFiles, DESKTOP_DROP_FILES, DESKTOP_MAX_FILES, DESKTOP_TARGET_DROP, pruneDesktopPayload } from "./prune-payload.mjs";

const { serverLaunchArgs } = createRequire(import.meta.url)("../../../bin/lib/server-entry.cjs");

const MAC = "darwin-arm64";
const WINDOWS = "win-x64";

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
		"NOTICE": "notice\n",
		"runtime/LICENSE": "MIT\n",
		"runtime/NOTICE.md": "notice\n",
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
	pruneDesktopPayload(dir, { target: MAC, log: () => {} });
	const outside = listFiles(dir).filter((file) => !file.startsWith("node_modules/"));
	assert.deepEqual(outside, [
		"CHANGELOG.md",
		"LICENSE",
		"NOTICE",
		"apps/web-server/dist/app-bridge.bundle.js",
		"apps/web-server/dist/box-worker-windows.mjs",
		"apps/web-server/dist/box-worker.mjs",
		"apps/web-server/dist/file-worker.mjs",
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
		"runtime/LICENSE",
		"runtime/NOTICE.md",
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
	pruneDesktopPayload(dir, { target: MAC, log: () => {} });
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
	pruneDesktopPayload(dir, { target: MAC, log: () => {} });
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
	pruneDesktopPayload(dir, { target: MAC, log: () => {} });
	assert.ok(fs.existsSync(path.join(dir, "node_modules", "recheck-jar", "package.json")), "a required recheck-jar was removed");
});

test("keeps only zod's v3 folder, which the room box's library imports, and fails without it", () => {
	const zod = {
		"node_modules/@anthropic-ai/sandbox-runtime/package.json": pkg("@anthropic-ai/sandbox-runtime", { dependencies: { zod: "1.0.0" } }),
		"node_modules/zod/package.json": pkg("zod"),
		"node_modules/zod/LICENSE": "MIT\n",
		"node_modules/zod/index.js": "x",
		"node_modules/zod/index.cjs": "x",
		"node_modules/zod/v4/core/index.js": "x",
		"node_modules/zod/v3/index.js": "x",
		"node_modules/zod/v3/helpers/util.js": "x",
	};
	const dir = stagedApp(zod);
	pruneDesktopPayload(dir, { target: MAC, log: () => {} });
	assert.deepEqual(listFiles(path.join(dir, "node_modules", "zod")), ["LICENSE", "package.json", "v3/helpers/util.js", "v3/index.js"]);
	assert.throws(() => pruneDesktopPayload(stagedApp({ ...zod, "node_modules/zod/v3/index.js": null, "node_modules/zod/v3/helpers/util.js": null }), { target: MAC, log: () => {} }), /node_modules\/zod\/v3 is missing/);
});

test("fails when the trimmed payload misses a file the bundled server or the shell needs", () => {
	assert.throws(() => pruneDesktopPayload(stagedApp({ "apps/web-server/dist/photon_rs_bg.wasm": null }), { target: MAC, log: () => {} }), /photon_rs_bg\.wasm/);
	assert.throws(() => pruneDesktopPayload(stagedApp({ "node_modules/jszip/package.json": null }), { target: MAC, log: () => {} }), /jszip/);
	assert.throws(() => pruneDesktopPayload(stagedApp({ "bin/lib/server-entry.cjs": null }), { target: MAC, log: () => {} }), /server-entry\.cjs/);
});

test("fails when the trimmed payload holds more files than the ceiling", () => {
	const dir = stagedApp();
	assert.throws(() => pruneDesktopPayload(dir, { target: MAC, log: () => {}, maxFiles: 3 }), /app\/ would carry \d+ files, over the ceiling of 3\./);
	assert.ok(DESKTOP_MAX_FILES >= 2_500, "the shipped ceiling leaves room above the measured payload");
	pruneDesktopPayload(stagedApp(), { target: MAC, log: () => {} });
});

// The room box's library as the release tree carries it: its own copy of
// commander inside its folder, and three packages only it needs, zod among
// them, which the root overrides lift to the top.
const BOX = "node_modules/@anthropic-ai/sandbox-runtime";
const boxLibrary = (overrides = {}) => ({
	[`${BOX}/package.json`]: pkg("@anthropic-ai/sandbox-runtime", { dependencies: { "@pondwader/socks5-server": "1.0.0", commander: "12.0.0", "node-forge": "1.0.0", zod: "4.0.0" } }),
	[`${BOX}/dist/index.js`]: "x",
	[`${BOX}/node_modules/commander/package.json`]: pkg("commander"),
	"node_modules/zod/package.json": pkg("zod"),
	"node_modules/zod/LICENSE": "MIT\n",
	"node_modules/zod/v3/index.js": "x",
	"node_modules/@pondwader/socks5-server/package.json": pkg("@pondwader/socks5-server"),
	"node_modules/node-forge/package.json": pkg("node-forge"),
	"node_modules/node-forge/lib/forge.js": "x",
	...overrides,
});

function trimmed(target, overrides) {
	const dir = stagedApp(boxLibrary(overrides));
	const lines = [];
	pruneDesktopPayload(dir, { target, log: (line) => lines.push(line) });
	return { files: listFiles(dir), lines };
}

test("a win-x64 trim leaves out exactly the room box's library and the packages only it needs, each with its reason", () => {
	const windows = trimmed(WINDOWS);
	const mac = trimmed(MAC);
	const gone = mac.files.filter((file) => !windows.files.includes(file));
	assert.deepEqual(gone, [
		"node_modules/@anthropic-ai/sandbox-runtime/dist/index.js",
		"node_modules/@anthropic-ai/sandbox-runtime/node_modules/commander/package.json",
		"node_modules/@anthropic-ai/sandbox-runtime/package.json",
		"node_modules/@pondwader/socks5-server/package.json",
		"node_modules/node-forge/lib/forge.js",
		"node_modules/node-forge/package.json",
		"node_modules/zod/LICENSE",
		"node_modules/zod/package.json",
		"node_modules/zod/v3/index.js",
	]);
	assert.deepEqual(windows.files.filter((file) => !mac.files.includes(file)), [`${KIT}/package.json`], "only the sandbox kit, which the Mac leaves out, is Windows only");
	const leftOut = windows.lines.filter((line) => line.includes("left out of the win-x64 payload"));
	assert.equal(leftOut.length, 4, leftOut.join("\n"));
	for (const name of ["@anthropic-ai/sandbox-runtime", "@pondwader/socks5-server", "node-forge", "zod"]) {
		const entry = DESKTOP_TARGET_DROP.find((drop) => drop.target === WINDOWS && drop.name === name);
		assert.ok(entry?.reason, `${name} has no reason`);
		assert.ok(leftOut.some((line) => line.includes(`: ${name} (${entry.reason})`)), `${name} is not logged with its reason`);
	}
	assert.match(windows.lines.at(-1), /trimmed for win-x64: app\/ \d+ -> \d+ files/);
});

test("a darwin-arm64 trim keeps the room box's library and its packages", () => {
	const mac = trimmed(MAC);
	for (const kept of [`${BOX}/dist/index.js`, `${BOX}/node_modules/commander/package.json`, "node_modules/zod/v3/index.js", "node_modules/@pondwader/socks5-server/package.json", "node_modules/node-forge/lib/forge.js"]) {
		assert.ok(mac.files.includes(kept), `${kept} was removed`);
	}
	assert.deepEqual(mac.lines.filter((line) => line.includes("left out")).map((line) => line.split(": ")[1].split(" (")[0]), ["@microsoft/mxc-sdk"]);
});

test("a win-x64 trim keeps a listed package that a kept package also needs", () => {
	const windows = trimmed(WINDOWS, { "node_modules/jsdom/package.json": pkg("jsdom", { dependencies: { "node-forge": "1.0.0" } }) });
	assert.ok(windows.files.includes("node_modules/node-forge/lib/forge.js"), "node-forge was removed although jsdom needs it");
	assert.ok(!windows.files.includes(`${BOX}/package.json`), "the room box's library was kept");
	assert.equal(windows.lines.filter((line) => line.includes("left out")).length, 3);
});

test("a win-x64 trim fails when it would leave out a package the list does not name", () => {
	const library = pkg("@anthropic-ai/sandbox-runtime", { dependencies: { "node-forge": "1.0.0", "only-for-the-box": "1.0.0" } });
	const dir = stagedApp(boxLibrary({ [`${BOX}/package.json`]: library, "node_modules/only-for-the-box/package.json": pkg("only-for-the-box") }));
	assert.throws(() => pruneDesktopPayload(dir, { target: WINDOWS, log: () => {} }), /win-x64 desktop payload would leave out only-for-the-box, which DESKTOP_TARGET_DROP does not list/);
	assert.ok(fs.existsSync(path.join(dir, ...BOX.split("/"), "package.json")), "a refused trim removed files");
});

test("a win-x64 trim still fails when any other file the server needs is missing", () => {
	for (const [missing, message] of [
		["apps/web-server/dist/box-worker.mjs", /box-worker\.mjs/],
		["apps/web-server/dist/photon_rs_bg.wasm", /photon_rs_bg\.wasm/],
		["node_modules/jszip/package.json", /jszip is missing/],
		["bin/lib/server-entry.cjs", /server-entry\.cjs/],
	]) {
		assert.throws(() => pruneDesktopPayload(stagedApp(boxLibrary({ [missing]: null })), { target: WINDOWS, log: () => {} }), message, missing);
	}
	const needsForge = { "node_modules/jsdom/package.json": pkg("jsdom", { dependencies: { "node-forge": "1.0.0" } }), "node_modules/node-forge/package.json": null, "node_modules/node-forge/lib/forge.js": null };
	assert.throws(() => pruneDesktopPayload(stagedApp(boxLibrary(needsForge)), { target: WINDOWS, log: () => {} }), /node-forge \(needed by jsdom\) is missing/);
	pruneDesktopPayload(stagedApp(boxLibrary()), { target: WINDOWS, log: () => {} });
});

// Microsoft's sandbox kit as the release tree carries it, after the archive's
// own trim: its JavaScript, its licence, every platform's binaries, its own
// koffi with the sources it builds from, koffi's platform package (the
// target's, as npm installs only that one), semver at the top, which nothing
// else the Mac keeps needs, and node-pty, which only its terminal path loads.
const KIT = "node_modules/@microsoft/mxc-sdk";
const KOFFI = `${KIT}/node_modules/koffi`;
const KOFFI_KEEP = DESKTOP_DROP_FILES.find((entry) => entry.folder === KOFFI).keep;
const KIT_BIN_LEFT_OUT = ["x64/wxc-exec.exe", "x64/libmxc_ffi.so", "x64/lxc-exec", "x64/plm.exe", "x64/wxc-test-proxy.exe", "x64/_manifest/spdx_2.2/manifest.spdx.json", "x64/dotnet/NativeMethods.g.cs", "arm64/mxc_ffi.dll", "arm64/wxc-exec.exe"];
const KOFFI_LEFT_OUT = ["cnoke.cjs", "lib/native/base/base.cc", "src/koffi/CMakeLists.txt", "src/koffi/src/call.cc", "src/koffi/src/abi/x64win_asm.asm", "vendor/node-api-headers/include/node_api.h", "vendor/node-addon-api/LICENSE.md"];
const sandboxKit = (platformPackage, overrides = {}) => ({
	[`${KIT}/package.json`]: pkg("@microsoft/mxc-sdk", { dependencies: { koffi: "^3.2.1", "node-pty": "^1.1.0", semver: "^7.7.4" } }),
	[`${KIT}/LICENSE.md`]: "MIT\n",
	[`${KIT}/dist/native-library.js`]: "x",
	[`${KIT}/dist/v1/index.js`]: "x",
	[`${KIT}/bin/x64/mxc_ffi.dll`]: "dll",
	...Object.fromEntries(KIT_BIN_LEFT_OUT.map((rel) => [`${KIT}/bin/${rel}`, "x"])),
	...Object.fromEntries(KOFFI_KEEP.filter((rel) => rel !== "package.json").map((rel) => [`${KOFFI}/${rel}`, "x"])),
	...Object.fromEntries(KOFFI_LEFT_OUT.map((rel) => [`${KOFFI}/${rel}`, "x"])),
	[`${KOFFI}/package.json`]: pkg("koffi", { optionalDependencies: { "@koromix/koffi-win32-x64": "3.3.7", "@koromix/koffi-darwin-arm64": "3.3.7" } }),
	[`node_modules/@koromix/${platformPackage}/package.json`]: pkg(`@koromix/${platformPackage}`),
	[`node_modules/@koromix/${platformPackage}/koffi.node`]: "node",
	"node_modules/node-pty/package.json": pkg("node-pty", { dependencies: { "node-addon-api": "^7.1.0" } }),
	"node_modules/node-pty/lib/index.js": "x",
	"node_modules/node-addon-api/package.json": pkg("node-addon-api"),
	"node_modules/semver/package.json": pkg("semver"),
	...overrides,
});

const filesUnder = (files, folder) => files.filter((file) => file.startsWith(`${folder}/`)).map((file) => file.slice(folder.length + 1));

test("a win-x64 trim keeps the sandbox kit's JavaScript, licence and x64 library, and koffi's run-time files and Windows package", () => {
	const dir = stagedApp(sandboxKit("koffi-win32-x64"));
	const lines = [];
	pruneDesktopPayload(dir, { target: WINDOWS, log: (line) => lines.push(line) });
	const files = listFiles(dir);
	assert.deepEqual(filesUnder(files, KIT).filter((rel) => !rel.startsWith("node_modules/")), ["LICENSE.md", "bin/x64/mxc_ffi.dll", "dist/native-library.js", "dist/v1/index.js", "package.json"]);
	assert.deepEqual(filesUnder(files, KOFFI), [...KOFFI_KEEP].sort());
	assert.deepEqual(filesUnder(files, "node_modules/@koromix"), ["koffi-win32-x64/koffi.node", "koffi-win32-x64/package.json"]);
	assert.ok(!fs.existsSync(path.join(dir, ...KIT.split("/"), "bin", "arm64")), "the emptied arm64 folder was kept");
	for (const name of ["node-pty", "node-addon-api"]) {
		assert.ok(!fs.existsSync(path.join(dir, "node_modules", name)), `${name} was kept`);
		const entry = DESKTOP_TARGET_DROP.find((drop) => drop.target === WINDOWS && drop.name === name);
		assert.ok(lines.some((line) => line.includes(`left out of the win-x64 payload: ${name} (${entry.reason})`)), `${name} is not logged with its reason`);
	}
});

test("a darwin-arm64 trim leaves out the sandbox kit whole, each package with its reason, and its count stays as without the kit", () => {
	const withKit = trimmed(MAC, sandboxKit("koffi-darwin-arm64"));
	const without = trimmed(MAC);
	assert.deepEqual(withKit.files, without.files.filter((file) => file !== `${KIT}/package.json`));
	const leftOut = withKit.lines.filter((line) => line.includes("left out of the darwin-arm64 payload"));
	assert.equal(leftOut.length, 5, leftOut.join("\n"));
	for (const entry of DESKTOP_TARGET_DROP.filter((drop) => drop.target === MAC)) {
		assert.ok(leftOut.some((line) => line.includes(`: ${entry.name} (${entry.reason})`)), `${entry.name} is not logged with its reason`);
	}
});

test("a win-x64 trim fails when the sandbox kit's library or a koffi run-time file is missing", () => {
	for (const [missing, message] of [
		[`${KIT}/bin/x64/mxc_ffi.dll`, /node_modules\/@microsoft\/mxc-sdk\/bin\/x64\/mxc_ffi\.dll is missing/],
		[`${KOFFI}/src/koffi/src/static.js`, /koffi\/src\/koffi\/src\/static\.js is missing/],
	]) {
		assert.throws(() => pruneDesktopPayload(stagedApp(sandboxKit("koffi-win32-x64", { [missing]: null })), { target: WINDOWS, log: () => {} }), message, missing);
	}
	// The Mac leaves the kit out, so its missing library is no fault there.
	pruneDesktopPayload(stagedApp(sandboxKit("koffi-darwin-arm64", { [`${KIT}/bin/x64/mxc_ffi.dll`]: null })), { target: MAC, log: () => {} });
});

// The launch test. On this computer it builds a win-x64 payload from the
// checkout's own install: the packages the Windows box worker loads, the
// archive's trim, the worker bundled from its source, then the desktop trim.
// With DESKTOP_PAYLOAD set to a staged desktop server folder (app/ and
// vendor/, as apps/desktop/scripts/package.mjs leaves it), it takes that
// payload and its Node instead; the release's Windows job does so. Either way
// the payload is copied away from the checkout, so nothing outside it can
// stand in for a file it lacks, and the worker must answer with the kit's
// version, contract and platform answer, which on Windows x64 reads.
const REPO = path.resolve(import.meta.dirname, "..", "..", "..");
const KIT_PACKAGES = ["@microsoft/mxc-sdk", "@koromix", "node-pty", "node-addon-api", "semver"];

async function launchPayload() {
	if (process.env.DESKTOP_PAYLOAD) {
		const server = path.resolve(process.env.DESKTOP_PAYLOAD);
		const app = path.join(makeTree({}), "app");
		fs.cpSync(path.join(server, "app"), app, { recursive: true });
		const node = process.platform === "win32" ? path.join(server, "vendor", "node", "node.exe") : path.join(server, "vendor", "node", "bin", "node");
		return { app, node };
	}
	const app = stagedApp();
	for (const name of KIT_PACKAGES) {
		fs.cpSync(path.join(REPO, "node_modules", ...name.split("/")), path.join(app, "node_modules", ...name.split("/")), { recursive: true, dereference: true });
	}
	pruneArchiveNodeModules(path.join(app, "node_modules"));
	assert.deepEqual(await bundleEntryAssets(REPO, path.join(app, "apps", "web-server", "dist")), []);
	pruneDesktopPayload(app, { target: WINDOWS, log: () => {} });
	return { app, node: process.execPath };
}

/**
 * Where the payload's server looks for the worker: beside the entry the
 * desktop starts (bin/lib/server-entry.cjs), as `defaultWorker` in
 * apps/web-server/src/room-box/windows/start-check.ts reads its own folder.
 */
function serverWorker(app) {
	const source = fs.readFileSync(path.join(REPO, "apps", "web-server", "src", "room-box", "windows", "start-check.ts"), "utf8");
	assert.match(source, /file: path\.join\(path\.dirname\(fileURLToPath\(import\.meta\.url\)\), "box-worker-windows\.mjs"\)/, "defaultWorker no longer looks beside the server's own file");
	const [entry, ...rest] = serverLaunchArgs(app);
	assert.ok(rest.length === 0 && entry === path.join(app, "apps", "web-server", "dist", "server.mjs") && fs.existsSync(entry), `the desktop doesn't start the bundled server: ${entry}`);
	return path.join(path.dirname(entry), "box-worker-windows.mjs");
}

/** Forks the payload's worker with node, asks `check` and resolves its reply once it has exited. */
function askCheck(app, node) {
	const worker = serverWorker(app);
	assert.ok(fs.existsSync(worker), `no worker where the server looks for it: ${worker}`);
	// The kit takes its library and programs from MXC_FFI_DIR and MXC_BIN_DIR
	// when set (dist/native-library.js), so none of its settings reach the fork.
	const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("NODE_") && !name.startsWith("MXC_")));
	return new Promise((resolve, reject) => {
		const child = fork(worker, [], { cwd: path.dirname(app), execPath: node, execArgv: [], env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
		let stderr = "";
		let reply = null;
		child.stderr.on("data", (chunk) => (stderr += chunk));
		const timer = setTimeout(() => child.kill(), 60_000);
		child.on("message", (message) => {
			if (message.type === "booted") child.send({ op: "check", id: 1 });
			else if (message.type === "reply") {
				reply = message;
				child.disconnect();
			}
		});
		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			if (reply) resolve(reply);
			else reject(new Error(`the worker ended (${signal ?? code}) before it answered:\n${stderr}`));
		});
	});
}

test("the launch test: the Windows box worker, forked from a pruned win-x64 payload where its server looks for it, with no checkout file in reach, answers its check", { timeout: 180_000 }, async () => {
	const { app, node } = await launchPayload();
	for (let dir = path.dirname(app); ; dir = path.dirname(dir)) {
		assert.ok(!fs.existsSync(path.join(dir, "node_modules")), `${dir} holds a node_modules folder the worker could load from`);
		if (path.dirname(dir) === dir) break;
	}
	const kitFiles = listFiles(path.join(app, ...KIT.split("/"))).filter((rel) => !rel.startsWith("node_modules/"));
	const installedScripts = listFiles(path.join(REPO, ...KIT.split("/"))).filter((rel) => /^dist\/.*\.js$/.test(rel));
	assert.deepEqual(kitFiles, [...installedScripts, "LICENSE.md", "bin/x64/mxc_ffi.dll", "package.json"].sort());
	assert.deepEqual(listFiles(path.join(app, ...KOFFI.split("/"))), [...KOFFI_KEEP].sort());
	for (const name of ["node-pty", "node-addon-api"]) assert.ok(!fs.existsSync(path.join(app, "node_modules", name)), `${name} was kept`);
	const files = countFiles(app);
	assert.ok(files <= DESKTOP_MAX_FILES, `${files} files`);

	const reply = await askCheck(app, node);
	assert.equal(reply.ok, true, reply.error);
	assert.equal(reply.value.version, "1.0.1");
	assert.equal(reply.value.contract, "1.0.0");
	assert.equal(typeof reply.value.platform.ok, "boolean", JSON.stringify(reply.value));
	if (process.platform === "win32" && process.arch === "x64") {
		assert.equal(reply.value.platform.ok, true, reply.value.platform.error);
		assert.equal(typeof reply.value.platform.value.isSupported, "boolean");
		assert.ok(Array.isArray(reply.value.platform.value.availableMethods), JSON.stringify(reply.value.platform.value));
	}
	console.log(`launch test: ${files} files in app/, the worker answered ${JSON.stringify(reply.value)}`);
});

// The trim keeps the files of this one version (DESKTOP_DROP_FILES), so a
// new version is a reviewed change: both package files pin it exactly, and
// the lock holds it.
test("the sandbox kit is pinned at 1.0.1 in both package files and in the lock", () => {
	const read = (...parts) => JSON.parse(fs.readFileSync(path.join(REPO, ...parts), "utf8"));
	assert.equal(read("package.json").dependencies["@microsoft/mxc-sdk"], "1.0.1");
	assert.equal(read("apps", "web-server", "package.json").dependencies["@microsoft/mxc-sdk"], "1.0.1");
	assert.equal(read("package-lock.json").packages[KIT].version, "1.0.1");
});

test("a trim needs a desktop target", () => {
	assert.throws(() => pruneDesktopPayload(stagedApp(), { log: () => {} }), /unknown desktop target "undefined"/);
	assert.throws(() => pruneDesktopPayload(stagedApp(), { target: "linux-x64", log: () => {} }), /unknown desktop target "linux-x64"/);
});
