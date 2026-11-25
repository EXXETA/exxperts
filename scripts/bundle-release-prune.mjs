// Trims the staged app/node_modules tree of files the app never reads at run
// time, before bundle-release.mjs archives it. The count matters more than the
// bytes: an installer writes every file, and a virus scanner checks each new
// file on its own, so a Windows install or update slows down with every file
// shipped. Only app/node_modules is trimmed; app/ outside it holds the
// TypeScript sources the server and the extensions run through tsx and jiti.
//
// Removed: source maps (*.map), declaration files (*.d.ts, *.d.mts, *.d.cts),
// third-party TypeScript sources (*.ts, *.mts, *.cts) and markdown (*.md,
// *.markdown). Tested by scripts/bundle-release.test.mjs.
//
// It also leaves out, per target, the packages nothing on that system loads
// (ARCHIVE_TARGET_DROP).
import fs from "node:fs";
import path from "node:path";

import { checkServerFiles, packageDirs } from "./bundle-server.mjs";

const KIT_REASON =
	"Microsoft's sandbox kit for the Windows box: only box-worker-windows.mjs loads it, and the server starts that only on Windows (windowsBoxChecks in apps/web-server/src/room-box/box-available.ts); its own koffi, inside its folder, goes with it";

// Packages one target's archive leaves out, each with the reason. What only
// they need goes with them, and a package a kept package needs stays, which
// fails the build. Any other package the drop would leave out fails it too,
// so each one is named here. The desktop payload, built from the same
// target's archive, reads this list as already left out
// (apps/desktop/scripts/prune-payload.mjs).
export const ARCHIVE_TARGET_DROP = [
	{ target: "darwin-arm64", name: "@microsoft/mxc-sdk", reason: KIT_REASON },
	{ target: "darwin-arm64", name: "@koromix/koffi-darwin-arm64", reason: "only the sandbox kit's own koffi needs it" },
	{ target: "darwin-arm64", name: "node-pty", reason: "only the sandbox kit needs it" },
	{ target: "darwin-arm64", name: "node-addon-api", reason: "only node-pty needs it, to build from source" },
	{ target: "linux-x64", name: "@microsoft/mxc-sdk", reason: KIT_REASON },
	{ target: "linux-x64", name: "@koromix/koffi-linux-x64", reason: "only the sandbox kit's own koffi needs it" },
	{ target: "linux-x64", name: "node-pty", reason: "only the sandbox kit needs it" },
	{ target: "linux-x64", name: "node-addon-api", reason: "only node-pty needs it, to build from source" },
];

// Packages the prune never touches, as path prefixes relative to
// app/node_modules. Everything inside them ships as installed.
export const PROTECTED_PACKAGES = [
	// Our own runtime packages. The runtime reads its own README, CHANGELOG,
	// docs and examples at run time (getPackageDir in
	// runtime/packages/coding-agent/src/config.ts).
	"@exxeta/",
	// The MCP extension is a pi package whose TypeScript sources the runtime
	// imports by name at run time.
	"pi-mcp-adapter/",
];

// We redistribute these packages, so their licence and notice files must
// travel with every copy, whatever their case or extension.
const LICENCE_FILE = /^(licen[cs]e|notice|copying)/i;

const JS_FILE = /\.[cm]?js$/;
const DECLARATION_FILE = /\.d\.[cm]?ts$/i;

// A relative import, dynamic import, require or re-export whose specifier
// names a TypeScript file.
const RELATIVE_TS_SPECIFIER =
	/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"'\n]+?\.[cm]?ts)\1/g;

function pruneKind(name) {
	if (LICENCE_FILE.test(name)) return null;
	const lower = name.toLowerCase();
	if (lower.endsWith(".map")) return "maps";
	if (DECLARATION_FILE.test(lower)) return "declarations";
	if (/\.[cm]?ts$/.test(lower)) return "typescript";
	if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
	return null;
}

function isProtected(rel) {
	return PROTECTED_PACKAGES.some((prefix) => `${rel}/`.startsWith(prefix));
}

// Calls visit(fullPath, relPosixPath, name) for every file under dir.
function walkFiles(dir, visit, rel = "") {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		const childRel = rel ? `${rel}/${entry.name}` : entry.name;
		if (entry.isDirectory()) walkFiles(full, visit, childRel);
		else visit(full, childRel, entry.name);
	}
}

export function pruneNodeModules(nodeModulesDir) {
	const removed = new Set();
	const counts = { maps: 0, declarations: 0, typescript: 0, markdown: 0 };
	let filesBefore = 0;
	walkFiles(nodeModulesDir, (full, rel, name) => {
		filesBefore++;
		if (isProtected(rel)) return;
		const kind = pruneKind(name);
		if (!kind) return;
		fs.rmSync(full);
		removed.add(full);
		counts[kind]++;
	});
	return { filesBefore, filesAfter: filesBefore - removed.size, removed, counts };
}

// The static gate: every remaining JavaScript file that imports or requires a
// TypeScript file the prune removed, as { file, specifier }. Empty when the
// trimmed tree is safe to ship. A declaration file holds no run-time code, so
// a reference to one is a type annotation (JSDoc such as
// `@type {import('./list.d.ts').X}`, seen in undici and side-channel-list)
// and never fails the gate.
export function findPrunedTypeScriptImports(nodeModulesDir, removed) {
	const broken = new Map();
	walkFiles(nodeModulesDir, (full) => {
		if (!JS_FILE.test(full)) return;
		const text = fs.readFileSync(full, "utf8");
		for (const match of text.matchAll(RELATIVE_TS_SPECIFIER)) {
			const specifier = match[2];
			if (DECLARATION_FILE.test(specifier)) continue;
			if (removed.has(path.resolve(path.dirname(full), specifier))) broken.set(`${full}\0${specifier}`, { file: full, specifier });
		}
	});
	return [...broken.values()];
}

const packageName = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name;

// Leaves the target's listed packages out of the staged app/ tree, with what
// only they need, and returns their entries. The walk starts from the app's
// own dependencies, as everything the CLI and the server load hangs on them.
// Throws, before removing anything, when the drop would leave out a package
// the list does not name or keep a listed one; and after, naming it, when the
// tree lacks anything the app or the bundled server needs.
export function dropTargetPackages(appDir, target) {
	const listed = ARCHIVE_TARGET_DROP.filter((entry) => entry.target === target);
	if (listed.length === 0) return [];
	const leaveOut = listed.map((entry) => entry.name);
	const manifest = JSON.parse(fs.readFileSync(path.join(appDir, "package.json"), "utf8"));
	const start = [
		...Object.keys(manifest.dependencies ?? {}).map((name) => ({ name, from: appDir })),
		...Object.keys(manifest.optionalDependencies ?? {}).map((name) => ({ name, from: appDir, optional: true })),
	];
	const keptStart = start.filter(({ name }) => !leaveOut.includes(name));
	const kept = packageDirs(appDir, keptStart).dirs;
	const left = [...packageDirs(appDir, start).dirs].filter((dir) => !kept.has(dir));
	// A package inside a left-out package's folder goes with it.
	const drops = left
		.filter((dir) => !left.some((outer) => dir.startsWith(`${outer}${path.sep}`)))
		.map((dir) => ({ dir, entry: listed.find((entry) => entry.name === packageName(dir)) }));
	const unlisted = drops.filter((drop) => !drop.entry).map((drop) => packageName(drop.dir));
	const stays = [...kept].filter((dir) => leaveOut.includes(packageName(dir))).map((dir) => path.relative(appDir, dir).split(path.sep).join("/"));
	if (unlisted.length > 0 || stays.length > 0) {
		throw new Error(
			[
				...unlisted.map((name) => `the ${target} archive would leave out ${name}, which ARCHIVE_TARGET_DROP does not list for it; list it with the reason, or keep what it serves`),
				...stays.map((rel) => `${rel} stays in the ${target} archive although ARCHIVE_TARGET_DROP leaves it out: a kept package needs it`),
			].join("\n"),
		);
	}

	for (const { dir } of drops) {
		fs.rmSync(dir, { recursive: true, force: true });
		const scope = path.dirname(dir);
		if (path.basename(scope).startsWith("@") && fs.readdirSync(scope).length === 0) fs.rmdirSync(scope);
	}
	const problems = [...packageDirs(appDir, keptStart).missing, ...checkServerFiles(appDir, undefined, { leaveOut })];
	if (problems.length > 0) throw new Error(`the ${target} archive lacks what the app needs:\n  - ${[...new Set(problems)].join("\n  - ")}`);
	return drops.map((drop) => drop.entry);
}
