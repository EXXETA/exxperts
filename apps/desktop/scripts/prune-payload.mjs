// Trims the desktop app's staged server payload (build/server/app) to what
// the bundled web server, the desktop shell and its Health Check run. The
// release archive also carries the CLI: its launchers, the runtime it runs by
// path, the TypeScript sources and every package those load. The desktop app
// never runs the CLI and starts the bundled server directly, so all of that
// goes; every file costs install and update time on Windows, where the virus
// scanner checks each new file. The archive has already left out what nothing
// on its target loads (ARCHIVE_TARGET_DROP in scripts/bundle-release-prune.mjs).
// Tested by scripts/prune-payload.test.mjs.
import fs from "node:fs";
import path from "node:path";

import { ARCHIVE_TARGET_DROP } from "../../../scripts/bundle-release-prune.mjs";
import { checkServerFiles, shippedPackageDirs } from "../../../scripts/bundle-server.mjs";

// Paths under app/ the desktop payload keeps, each with the reason; the rest
// of app/ is removed. node_modules is trimmed to the packages the bundled
// server loads as files and their dependencies (shippedPackageDirs in
// scripts/bundle-server.mjs). A file the server, the shell or the Health
// Check starts reading from the install root has to be listed here.
export const DESKTOP_KEEP = [
	{ path: "package.json", reason: "the server and the Health Check read the product version from it" },
	{ path: "CHANGELOG.md", reason: "What's new reads the release notes from it" },
	{ path: "LICENSE", reason: "the app's own licence travels with every copy" },
	{ path: "NOTICE", reason: "the notice that goes with LICENSE travels with every copy" },
	{ path: "runtime/LICENSE", reason: "the runtime is derived from Pi under the MIT licence, whose notice travels with every copy" },
	{ path: "runtime/NOTICE.md", reason: "the runtime's notice, which NOTICE points to, travels with every copy" },
	{ path: "apps/web-server/dist", reason: "the bundled server, its licences file and the files it reads beside itself" },
	{ path: "apps/web-ui/dist", reason: "the web interface the server serves" },
	{ path: "runtime/packages/coding-agent/package.json", reason: "the runtime reads its name, version and config folder from it" },
	{ path: "runtime/packages/coding-agent/dist/modes/interactive/theme", reason: "the runtime's built-in themes" },
	{ path: "runtime/packages/coding-agent/dist/modes/interactive/assets", reason: "the runtime's interactive assets" },
	{ path: "runtime/packages/coding-agent/dist/core/export-html", reason: "the template for exporting a session as HTML" },
	{ path: "bin/lib/server-entry.cjs", reason: "the desktop app asks it which entry starts the server" },
	{ path: "bin/lib/state-profiles.cjs", reason: "the desktop app, the server and the Health Check load it by path for data profiles" },
	{ path: "bin/lib/room-lock.cjs", reason: "the server loads it by path to share room locks" },
	{ path: "bin/lib/product-state-paths.cjs", reason: "room-lock.cjs requires it" },
	{ path: "scripts/doctor.mjs", reason: "the Health Check menu runs it" },
	{ path: "scripts/searxng.mjs", reason: "the server's web search setup and the Health Check run it" },
	{ path: "node_modules", reason: "trimmed separately to the packages the bundled server loads as files" },
];

// Optional dependencies inside that closure the desktop leaves out, each with
// the reason. Only an optional dependency can be left out this way; one a kept
// package requires stays.
export const DESKTOP_DROP = [
	{ name: "recheck-jar", reason: "recheck's Java fallback (23 MB), used only when the native checker is missing and Java is installed; the native checker ships for both desktop targets, and without the jar recheck falls back to its JavaScript checker" },
];

// The targets the desktop app is built for.
export const DESKTOP_TARGETS = ["darwin-arm64", "win-x64"];

// Packages the bundled server ships that one target's payload leaves out,
// each with the reason; what only they need goes with them, and a package a
// kept package needs stays. Any other package the trim would leave out fails
// it, so each one is named here or in the archive's own list for the target
// (ARCHIVE_TARGET_DROP), which the payload starts without. An entry with
// `from` leaves out a dependency of that kept package which the code the
// desktop runs never loads.
export const DESKTOP_TARGET_DROP = [
	{ target: "win-x64", name: "@anthropic-ai/sandbox-runtime", reason: "the room box's library: only box-worker.mjs loads it, and the server builds the Mac's box on a Mac alone (roomBoxComputer in apps/web-server/src/room-box/box-available.ts), and Windows' box forks box-worker-windows.mjs instead; its own commander, inside its folder, goes with it" },
	{ target: "win-x64", name: "@pondwader/socks5-server", reason: "only the room box's library needs it" },
	{ target: "win-x64", name: "node-forge", reason: "only the room box's library needs it" },
	{ target: "win-x64", name: "zod", reason: "only the room box's library loads it as files; the bundled server carries its own copy" },
	{ target: "win-x64", name: "node-pty", from: "@microsoft/mxc-sdk", reason: "the sandbox kit loads it only for a terminal in the box (dist/bindings/process-container-pty.js), by an import the Windows box never reaches" },
	{ target: "win-x64", name: "node-addon-api", reason: "only node-pty needs it, to build from source" },
];

// Files left out of a kept package, each with the reason: every file but the
// `keep` paths, relative to the folder.
// Nothing loads them, and each one would count against the ceiling below. A
// kept path that is missing fails the trim. The release archive has already
// left out every package's maps, declarations and Markdown but its licence
// (scripts/bundle-release-prune.mjs), the sandbox kit's included.
export const DESKTOP_DROP_FILES = [
	{ folder: "node_modules/zod", keep: ["package.json", "LICENSE", "v3"], reason: "the room box's library, the only package that loads zod as files, imports zod/v3 alone, which loads nothing outside its folder" },
	{
		folder: "node_modules/@microsoft/mxc-sdk/bin",
		keep: ["x64/mxc_ffi.dll"],
		reason: "the Windows box runs, streams and probes through this one library, by koffi (dist/native-library.js); the app is x64, so arm64 goes, and so do the Linux and Mac binaries, the programs the box never starts (wxc-exec.exe serves only a terminal in the box; the others are daemons, a diagnostics console and test proxies), the signed manifests and the .NET bindings",
	},
	{
		folder: "node_modules/@microsoft/mxc-sdk/node_modules/koffi",
		keep: ["package.json", "LICENSE.txt", "index.js", "src/koffi/index.js", "src/koffi/src/static.js"],
		reason: "the files the kit's import of koffi loads, which take its native module from its platform package; its CommonJS twins and its indirect entry are never loaded, and its C sources, headers and build script only build it from source",
	},
];

// The most files the trimmed app/ folder may hold, the one Windows users
// install. Each file costs install and update time there, as the virus
// scanner checks every new file, so growth has to be a reviewed decision.
// Measured: 2,397 files on darwin-arm64, and 2,344 on win-x64, which leaves
// out the room box's library and keeps Microsoft's sandbox kit with semver
// (DESKTOP_TARGET_DROP), measured on the same tree with koffi's win32-x64
// package in place of the Mac's; a real Windows tree differs only by its
// native binaries, 3 files more in an earlier release's zip index. The
// ceiling sits about 4 percent above darwin-arm64 and 7 percent above win-x64.
export const DESKTOP_MAX_FILES = 2_500;

export function countFiles(dir) {
	let count = 0;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		count += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1;
	}
	return count;
}

// Removes every entry under dir that is neither a kept path nor on the way
// to one. rel is the posix path of dir inside app/.
function pruneOutsideKeepList(dir, rel, keep) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const childRel = rel ? `${rel}/${entry.name}` : entry.name;
		const full = path.join(dir, entry.name);
		if (keep.includes(childRel)) continue;
		if (entry.isDirectory() && keep.some((kept) => kept.startsWith(`${childRel}/`))) pruneOutsideKeepList(full, childRel, keep);
		else fs.rmSync(full, { recursive: true, force: true });
	}
}

// Removes every package folder under a node_modules folder that is not kept,
// then looks inside the kept ones for their own node_modules.
function pruneNodeModules(nodeModulesDir, keep) {
	for (const entry of fs.readdirSync(nodeModulesDir, { withFileTypes: true })) {
		const full = path.join(nodeModulesDir, entry.name);
		if (entry.isDirectory() && entry.name.startsWith("@")) {
			pruneNodeModules(full, keep);
			if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
		} else if (!keep.has(full)) {
			fs.rmSync(full, { recursive: true, force: true });
		} else if (fs.existsSync(path.join(full, "node_modules"))) {
			pruneNodeModules(path.join(full, "node_modules"), keep);
			if (fs.readdirSync(path.join(full, "node_modules")).length === 0) fs.rmdirSync(path.join(full, "node_modules"));
		}
	}
}

// The kept paths of an entry whose folder the payload keeps that are missing,
// checked before the entry trims the folder.
function missingKeptFiles(appDir) {
	return DESKTOP_DROP_FILES.filter(({ folder }) => fs.existsSync(path.join(appDir, ...folder.split("/")))).flatMap(({ folder, keep, reason }) =>
		keep.filter((rel) => !fs.existsSync(path.join(appDir, ...folder.split("/"), ...rel.split("/")))).map((rel) => `${folder}/${rel} is missing (${reason})`),
	);
}

// The packages the target's payload leaves out: its own and its archive's.
const targetEntries = (target) => [...DESKTOP_TARGET_DROP, ...ARCHIVE_TARGET_DROP].filter((entry) => entry.target === target);

// The package folders the target's lists leave out of the full closure, each
// with its entry; throws when one is not listed. A package inside a left-out
// package's folder goes with it.
function targetDrops(appDir, target, exclude, kept) {
	const listed = targetEntries(target);
	const left = [...shippedPackageDirs(appDir, { exclude }).dirs].filter((dir) => !kept.has(dir));
	const drops = left
		.filter((dir) => !left.some((outer) => dir.startsWith(`${outer}${path.sep}`)))
		.map((dir) => {
			const { name } = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
			return { name, entry: listed.find((entry) => entry.name === name) };
		});
	const unlisted = drops.filter((drop) => !drop.entry).map((drop) => drop.name);
	if (unlisted.length > 0) {
		// A listed package of the archive's still in the tree: the archive was built before that drop.
		const stale = drops.filter((drop) => ARCHIVE_TARGET_DROP.includes(drop.entry)).map((drop) => drop.name);
		const rebuild = stale.length > 0 ? `; the archive still holds ${stale.join(", ")}, which the ${target} archive leaves out (ARCHIVE_TARGET_DROP), so it was built before that: rebuild it` : "";
		throw new Error(`the ${target} desktop payload would leave out ${unlisted.join(", ")}, which neither DESKTOP_TARGET_DROP nor ARCHIVE_TARGET_DROP lists for it; list each with the reason, or keep what it serves${rebuild}`);
	}
	return drops.map((drop) => drop.entry);
}

// Trims appDir in place for the target and checks the result; throws, naming
// what is missing, when the trimmed payload lacks anything the desktop runs.
export function pruneDesktopPayload(appDir, { target, log = console.log, maxFiles = DESKTOP_MAX_FILES }) {
	if (!DESKTOP_TARGETS.includes(target)) throw new Error(`unknown desktop target "${target}" (${DESKTOP_TARGETS.join(" or ")})`);
	const filesBefore = countFiles(appDir);
	const nodeModulesDir = path.join(appDir, "node_modules");
	const nodeModulesBefore = fs.existsSync(nodeModulesDir) ? countFiles(nodeModulesDir) : 0;
	// The closure is resolved before anything is removed, so a package the
	// release tree lacks shows up in the check below rather than as a crash.
	const exclude = DESKTOP_DROP.map((entry) => entry.name);
	const drops = targetEntries(target);
	const leaveOut = drops.filter((entry) => !entry.from).map((entry) => entry.name);
	const cut = drops.filter((entry) => entry.from);
	const { dirs } = shippedPackageDirs(appDir, { exclude, leaveOut, cut });
	for (const entry of targetDrops(appDir, target, exclude, dirs)) log(`[package] left out of the ${target} payload: ${entry.name} (${entry.reason})`);
	pruneOutsideKeepList(appDir, "", DESKTOP_KEEP.map((entry) => entry.path));
	if (fs.existsSync(nodeModulesDir)) pruneNodeModules(nodeModulesDir, dirs);
	const missingKept = missingKeptFiles(appDir);
	for (const { folder, keep } of DESKTOP_DROP_FILES) {
		const full = path.join(appDir, ...folder.split("/"));
		if (fs.existsSync(full)) pruneOutsideKeepList(full, "", keep);
	}

	const problems = DESKTOP_KEEP.filter((entry) => !fs.existsSync(path.join(appDir, ...entry.path.split("/")))).map(
		(entry) => `${entry.path} is missing (${entry.reason})`,
	);
	problems.push(...missingKept, ...checkServerFiles(appDir, undefined, { leaveOut, cut }));
	if (problems.length > 0) throw new Error(`the trimmed desktop payload is incomplete:\n  - ${[...new Set(problems)].join("\n  - ")}`);

	const nodeModulesAfter = countFiles(nodeModulesDir);
	const filesAfter = countFiles(appDir);
	log(`[package] desktop payload trimmed for ${target}: app/ ${filesBefore} -> ${filesAfter} files (node_modules ${nodeModulesBefore} -> ${nodeModulesAfter}, ${dirs.size} packages kept; ceiling ${maxFiles})`);
	if (filesAfter > maxFiles) {
		throw new Error(`the trimmed desktop payload's app/ would carry ${filesAfter} files, over the ceiling of ${maxFiles}. Leave out what the desktop never reads (DESKTOP_KEEP, DESKTOP_DROP), or raise DESKTOP_MAX_FILES in a reviewed commit that states the measured count.`);
	}
}
