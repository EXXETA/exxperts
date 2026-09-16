import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The folder that holds the `.exxperts` tree, and the ONLY thing a data
 * profile or a moved data folder relocates.
 *
 * EXXPERTS_STATE_HOME names it: the moved folder for the standard profile in a
 * moved data folder, `<home>/.exxperts-<name>` for a loaded profile. Unset, it
 * is the login home, which is what every install that never touched either
 * feature runs with. HOME is deliberately NOT part of this: the browser cache,
 * `~/.agents/skills`, `~/.config/mcp`, the container tools and every dotfile a
 * spawned tool reads stay with the person, not with the profile.
 */
export function stateHome(): string {
	const fromEnv = process.env.EXXPERTS_STATE_HOME;
	if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
	return os.homedir();
}

export function productAppStateRoot(): string {
	return path.join(stateHome(), ".exxperts", "app");
}

export function productAppStatePath(...segments: string[]): string {
	return path.join(productAppStateRoot(), ...segments);
}

export function ensureProductAppStateRoot(): string {
	const root = productAppStateRoot();
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	return root;
}

export function ensureProductAppStateDir(...segments: string[]): string {
	const dir = productAppStatePath(...segments);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

export function ensureProductAppUserDirs(): void {
	ensureProductAppStateRoot();
	ensureProductAppStateDir("agents");
	ensureProductAppStateDir("skills");
}

export function cliLauncherStateDir(): string {
	const fromEnv = process.env.EXXPERTS_LAUNCHER_STATE_DIR;
	if (fromEnv && fromEnv.trim()) return fromEnv;
	return productAppStatePath("run", "cli");
}

export function ensureCliLauncherStateDir(): string {
	const dir = cliLauncherStateDir();
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

export function cliLauncherStatePath(...segments: string[]): string {
	return path.join(cliLauncherStateDir(), ...segments);
}
