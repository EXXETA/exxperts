import fs from "node:fs";
import path from "node:path";

// Each static route serves only files inside its own folder of the page. A
// script, unlike a browser, sends a path as it likes, so the rest of the
// path after the route's prefix is checked here, once, before any file is
// read. Kept apart from static-files.ts so its smoke can call it without
// starting the server.

function isInside(folder: string, file: string, rules: path.PlatformPath): boolean {
	const rel = rules.relative(folder, file);
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${rules.sep}`) && !rules.isAbsolute(rel);
}

/**
 * The file `rest` names inside `folder`, or null when it could name anything
 * else. `rest` is the request's path after the route's prefix, still encoded:
 * it is decoded once here, and a malformed encoding, a NUL, a backslash or a
 * `..` segment is refused. `rules` is `path.posix` or `path.win32`, so the
 * Windows rules can be checked on any computer.
 */
export function pathInFolder(folder: string, rest: string, rules: path.PlatformPath = path): string | null {
	let decoded: string;
	try {
		decoded = decodeURIComponent(rest);
	} catch {
		return null;
	}
	if (decoded.includes("\0") || decoded.includes("\\")) return null;
	const segments = decoded.split("/");
	if (segments.includes("..")) return null;
	const file = rules.resolve(folder, ...segments);
	return isInside(folder, file, rules) ? file : null;
}

/** The real path of the file `rest` names inside `folder`, or null when it is missing, not a file, or reached through a link out of `folder`. */
export function servedFile(folder: string, rest: string): string | null {
	const file = pathInFolder(folder, rest);
	if (!file) return null;
	try {
		const real = fs.realpathSync(file);
		if (!isInside(fs.realpathSync(folder), real, path)) return null;
		return fs.statSync(real).isFile() ? real : null;
	} catch {
		return null;
	}
}
