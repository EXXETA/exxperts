// Trims the desktop app's staged server payload (build/server/app) to what
// the bundled web server, the desktop shell and its Health Check run. The
// release archive also carries the CLI: its launchers, the runtime it runs by
// path, the TypeScript sources and every package those load. The desktop app
// never runs the CLI and starts the bundled server directly, so all of that
// goes; every file costs install and update time on Windows, where the virus
// scanner checks each new file. Only the desktop payload is trimmed; the CLI
// archive ships as built. Tested by scripts/prune-payload.test.mjs.
import fs from "node:fs";
import path from "node:path";

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

// The most files the trimmed app/ folder may hold, the one Windows users
// install. Each file costs install and update time there, as the virus
// scanner checks every new file, so growth has to be a reviewed decision.
// Measured on 2026-09-30 for 0.14.1: 2,145 files on darwin-arm64, and about
// 2,148 on win-x64 estimated from the 0.14.0 zip index; the ceiling sits
// about 16 percent above.
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

// Trims appDir in place and checks the result; throws, naming what is
// missing, when the trimmed payload lacks anything the desktop runs.
export function pruneDesktopPayload(appDir, { log = console.log, maxFiles = DESKTOP_MAX_FILES } = {}) {
	const filesBefore = countFiles(appDir);
	const nodeModulesDir = path.join(appDir, "node_modules");
	const nodeModulesBefore = fs.existsSync(nodeModulesDir) ? countFiles(nodeModulesDir) : 0;
	// The closure is resolved before anything is removed, so a package the
	// release tree lacks shows up in the check below rather than as a crash.
	const { dirs } = shippedPackageDirs(appDir, { exclude: DESKTOP_DROP.map((entry) => entry.name) });
	pruneOutsideKeepList(appDir, "", DESKTOP_KEEP.map((entry) => entry.path));
	if (fs.existsSync(nodeModulesDir)) pruneNodeModules(nodeModulesDir, dirs);

	const problems = DESKTOP_KEEP.filter((entry) => !fs.existsSync(path.join(appDir, ...entry.path.split("/")))).map(
		(entry) => `${entry.path} is missing (${entry.reason})`,
	);
	problems.push(...checkServerFiles(appDir));
	if (problems.length > 0) throw new Error(`the trimmed desktop payload is incomplete:\n  - ${[...new Set(problems)].join("\n  - ")}`);

	const nodeModulesAfter = countFiles(nodeModulesDir);
	const filesAfter = countFiles(appDir);
	log(`[package] desktop payload trimmed: app/ ${filesBefore} -> ${filesAfter} files (node_modules ${nodeModulesBefore} -> ${nodeModulesAfter}, ${dirs.size} packages kept; ceiling ${maxFiles})`);
	if (filesAfter > maxFiles) {
		throw new Error(`the trimmed desktop payload's app/ would carry ${filesAfter} files, over the ceiling of ${maxFiles}. Leave out what the desktop never reads (DESKTOP_KEEP, DESKTOP_DROP), or raise DESKTOP_MAX_FILES in a reviewed commit that states the measured count.`);
	}
}
