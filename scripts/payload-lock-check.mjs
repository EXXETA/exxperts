// The release payload check: every third-party npm package in the app tree
// must be a non-dev entry of the root package-lock.json with the same name
// and version, so the release scan reads it and sbom-app.cdx.json lists it.
// (The vendored Node and the patched pi-mcp-adapter bytes are outside any
// lockfile, as before.) scripts/bundle-release.mjs runs it right after the
// install.
//
//   node scripts/payload-lock-check.mjs <appRoot> [--lock <package-lock.json>]
//
// Our own file: packages (the lockfile's link entries, e.g. the runtime
// packages) are our code and are not matched, but whatever is installed
// inside them is. They are known by place, never by name.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// name -> Map(version -> the strongest kind of entry with that version:
// "prod", "devOptional" or "dev").
const RANK = { dev: 0, devOptional: 1, prod: 2 };
function indexLock(lock) {
	const versions = new Map();
	const entries = Object.entries(lock.packages ?? {});
	// A link's slot (node_modules/@exxeta/exxperts-ai) -> its target
	// (runtime/packages/ai): our source, not a package.
	const links = new Map(entries.filter(([, entry]) => entry.link).map(([key, entry]) => [key, entry.resolved]));
	const linkTargets = new Set(links.values());
	for (const [key, entry] of entries) {
		if (key === "" || entry.link || linkTargets.has(key)) continue;
		const name = entry.name ?? key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
		if (!entry.version) continue;
		const kind = entry.dev ? "dev" : entry.devOptional ? "devOptional" : "prod";
		if (!versions.has(name)) versions.set(name, new Map());
		const byVersion = versions.get(name);
		const seen = byVersion.get(entry.version);
		if (!seen || RANK[kind] > RANK[seen]) byVersion.set(entry.version, kind);
	}
	return { versions, links, linkTargets };
}

function readManifest(dir) {
	try {
		return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
	} catch {
		return null;
	}
}

// Returns { checked, problems }: the number of packages matched and one line
// per difference, with the path relative to appRoot. Every node_modules folder
// in the tree is checked, also one outside any package (Node resolves
// runtime/node_modules for runtime/packages/ai). Links are not followed:
// what they point at is checked where it is.
export function checkPayloadAgainstLock(appRoot, lock) {
	const { versions, links, linkTargets } = indexLock(lock);
	const realRoot = fs.realpathSync(appRoot);
	const problems = [];
	let checked = 0;

	const rel = (p) => path.relative(appRoot, p).split(path.sep).join("/");

	const readBytes = (file) => {
		try {
			return fs.readFileSync(file);
		} catch {
			return null;
		}
	};

	function checkPackage(dir, isLink) {
		const manifest = readManifest(dir);
		if (!manifest?.name || !manifest.version) {
			problems.push(`${rel(dir)}: no package.json with a name and a version`);
			return;
		}
		const { name, version } = manifest;
		if (isLink) {
			// npm links our file: packages (a junction on Windows).
			const target = path.relative(realRoot, fs.realpathSync(dir)).split(path.sep).join("/");
			if (!linkTargets.has(target)) problems.push(`${rel(dir)}: a link to ${fs.realpathSync(dir)}, not one of the lockfile's links`);
			return;
		}
		// Our own package, copied in place of its link (the archive has no
		// links): at the link's slot, with the target's own package.json. This
		// attests the manifest, not the code, and only matters for a
		// dereferenced copy (the CLI on an archive); in the build the slot is a
		// link.
		const target = links.get(rel(dir));
		if (target && readBytes(path.join(dir, "package.json")).equals(readBytes(path.join(appRoot, target, "package.json")) ?? Buffer.alloc(0))) return;
		checked++;
		const byVersion = versions.get(name);
		if (!byVersion) {
			problems.push(`${rel(dir)}: ${name} ${version} is not in the lockfile`);
		} else if (!byVersion.has(version)) {
			problems.push(`${rel(dir)}: ${name} ${version} is installed, the lockfile has ${[...byVersion.keys()].join(", ")}`);
		} else if (byVersion.get(version) !== "prod") {
			// devOptional packages do ship; they fail only because how the SBOM's
			// --omit dev treats them is unverified (none exist today).
			problems.push(`${rel(dir)}: ${name} ${version} is only a ${byVersion.get(version)} entry in the lockfile`);
		}
	}

	// Plain files in a node_modules folder (some packages ship test fixtures
	// there) are not packages.
	function checkModules(modules) {
		for (const entry of fs.readdirSync(modules, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1))) {
			if (entry.name.startsWith(".") || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
			const full = path.join(modules, entry.name);
			if (entry.name.startsWith("@") && entry.isDirectory()) {
				for (const scoped of fs.readdirSync(full, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1))) {
					if (scoped.isDirectory() || scoped.isSymbolicLink()) checkPackage(path.join(full, scoped.name), scoped.isSymbolicLink());
				}
			} else {
				checkPackage(full, entry.isSymbolicLink());
			}
		}
	}

	function walk(dir) {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const full = path.join(dir, entry.name);
			if (entry.name === "node_modules") checkModules(full);
			walk(full);
		}
	}

	walk(appRoot);
	return { checked, problems };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	const lockAt = args.indexOf("--lock");
	const lockPath = lockAt === -1 ? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package-lock.json") : args[lockAt + 1];
	const appRoot = args.filter((_, i) => lockAt === -1 || (i !== lockAt && i !== lockAt + 1))[0];
	if (!appRoot || !lockPath) {
		console.error("usage: node scripts/payload-lock-check.mjs <appRoot> [--lock <package-lock.json>]");
		process.exit(2);
	}
	const { checked, problems } = checkPayloadAgainstLock(appRoot, JSON.parse(fs.readFileSync(lockPath, "utf8")));
	for (const line of problems) console.log(line);
	console.log(`${checked} packages checked, ${problems.length} differ from ${lockPath}`);
	process.exit(problems.length ? 1 : 0);
}
