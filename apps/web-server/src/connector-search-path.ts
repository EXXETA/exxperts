/**
 * Where a connector program is looked for. An app opened from the Dock gets
 * the system's short PATH, without the folders Homebrew, Volta, asdf, mise,
 * pyenv or Docker install programs in, so `npx` or `uvx` that run in the
 * person's terminal wouldn't be found. The server's own PATH comes first, then
 * each of those folders that exists. The connector's start, the adapter's npx
 * lookup and the start check (connector-start-check.ts) all read this one
 * function, so the check judges the program that really runs. On Windows
 * programs install onto the system's PATH, which the server has from its start;
 * a check that found no program adds what was installed since
 * (room-box/windows/windows-search-path.ts).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The usual install folders, under the home folder or absolute. */
function installFolders(home: string): string[] {
	return [
		"/opt/homebrew/bin",
		"/opt/homebrew/sbin",
		"/usr/local/bin",
		"/usr/local/sbin",
		"/home/linuxbrew/.linuxbrew/bin",
		path.join(home, ".volta", "bin"),
		path.join(home, ".asdf", "shims"),
		path.join(home, ".local", "share", "mise", "shims"),
		path.join(home, ".pyenv", "shims"),
		path.join(home, ".local", "bin"),
		path.join(home, ".docker", "bin"),
		"/Applications/Docker.app/Contents/Resources/bin",
	];
}

/**
 * The PATH a connector program starts with: the server's own, then each usual
 * install folder that exists now, each folder once. Undefined on Windows,
 * where it is the server's own PATH alone.
 */
export function connectorSearchPath(serverPath: string | undefined = process.env.PATH, home: string = os.homedir(), platform: NodeJS.Platform = process.platform): string | undefined {
	if (platform === "win32") return undefined;
	const own = (serverPath ?? "").split(path.delimiter).filter(Boolean);
	const added = installFolders(home).filter((folder) => !own.includes(folder) && fs.existsSync(folder));
	return [...own, ...added].join(path.delimiter);
}
