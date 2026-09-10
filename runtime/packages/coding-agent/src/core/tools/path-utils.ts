import { accessSync, constants } from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import type { PlatformPath } from "node:path";
import { normalizeWindowsShellPath } from "../../utils/paths.js";

/** Host pieces path resolution depends on. Injectable so tests can emulate Windows with path.win32. */
export interface PathPlatform {
	platform: NodeJS.Platform;
	path: PlatformPath;
	homedir: () => string;
	tmpdir: () => string;
}

function hostPlatform(): PathPlatform {
	return { platform: process.platform, path: nodePath, homedir: os.homedir, tmpdir: os.tmpdir };
}

const POSIX_TEMP_ROOT = /^\/(?:var\/)?tmp(?:\/(.*))?$/;

/**
 * On Windows, map a bare POSIX temp root (/tmp/..., /var/tmp/...) to os.tmpdir().
 * Our divergence from upstream, which leaves bare /tmp alone: a Git Bash session
 * resolves /tmp to the user's temp directory, but a native Windows API resolves it
 * against the current drive (C:\tmp), so the write tool and bash would disagree on
 * where /tmp is on that machine.
 */
function mapPosixTempRoot(filePath: string, platform: PathPlatform): string {
	const match = filePath.match(POSIX_TEMP_ROOT);
	if (!match) return filePath;
	return match[1] ? platform.path.join(platform.tmpdir(), match[1]) : platform.tmpdir();
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const NARROW_NO_BREAK_SPACE = "\u202F";
function normalizeUnicodeSpaces(str: string): string {
	return str.replace(UNICODE_SPACES, " ");
}

function tryMacOSScreenshotPath(filePath: string): string {
	return filePath.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`);
}

function tryNFDVariant(filePath: string): string {
	// macOS stores filenames in NFD (decomposed) form, try converting user input to NFD
	return filePath.normalize("NFD");
}

function tryCurlyQuoteVariant(filePath: string): string {
	// macOS uses U+2019 (right single quotation mark) in screenshot names like "Capture d'écran"
	// Users typically type U+0027 (straight apostrophe)
	return filePath.replace(/'/g, "\u2019");
}

function fileExists(filePath: string): boolean {
	try {
		accessSync(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function normalizeAtPrefix(filePath: string): string {
	return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}

export function expandPath(filePath: string, platform: PathPlatform = hostPlatform()): string {
	let normalized = normalizeUnicodeSpaces(normalizeAtPrefix(filePath));
	if (platform.platform === "win32") {
		// Git Bash, MSYS, Cygwin, and WSL drive paths (upstream #7064, #7547), then bare POSIX temp roots.
		normalized = mapPosixTempRoot(normalizeWindowsShellPath(normalized), platform);
	}
	if (normalized === "~") {
		return platform.homedir();
	}
	if (normalized.startsWith("~/")) {
		return platform.homedir() + normalized.slice(1);
	}
	return normalized;
}

/**
 * Resolve a path relative to the given cwd.
 * Handles ~ expansion and absolute paths.
 */
export function resolveToCwd(filePath: string, cwd: string, platform: PathPlatform = hostPlatform()): string {
	const expanded = expandPath(filePath, platform);
	if (platform.path.isAbsolute(expanded)) {
		return expanded;
	}
	return platform.path.resolve(cwd, expanded);
}

export function resolveReadPath(filePath: string, cwd: string): string {
	const resolved = resolveToCwd(filePath, cwd);

	if (fileExists(resolved)) {
		return resolved;
	}

	// Try macOS AM/PM variant (narrow no-break space before AM/PM)
	const amPmVariant = tryMacOSScreenshotPath(resolved);
	if (amPmVariant !== resolved && fileExists(amPmVariant)) {
		return amPmVariant;
	}

	// Try NFD variant (macOS stores filenames in NFD form)
	const nfdVariant = tryNFDVariant(resolved);
	if (nfdVariant !== resolved && fileExists(nfdVariant)) {
		return nfdVariant;
	}

	// Try curly quote variant (macOS uses U+2019 in screenshot names)
	const curlyVariant = tryCurlyQuoteVariant(resolved);
	if (curlyVariant !== resolved && fileExists(curlyVariant)) {
		return curlyVariant;
	}

	// Try combined NFD + curly quote (for French macOS screenshots like "Capture d'écran")
	const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
	if (nfdCurlyVariant !== resolved && fileExists(nfdCurlyVariant)) {
		return nfdCurlyVariant;
	}

	return resolved;
}
