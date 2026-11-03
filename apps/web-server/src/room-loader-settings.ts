import { SettingsManager } from "@exxeta/exxperts-runtime";

type SettingsStorage = Parameters<typeof SettingsManager.fromStorage>[0];

/**
 * The settings a room session's resource loader reads: the real global and
 * project settings.json, without their `packages` lists. The loader resolves
 * `packages` on every reload and installs a missing one with npm or git, but
 * a room loads no package content, so a room never installs anything. Every
 * other setting reads as it does today, from disk on every read, so a reload
 * sees what changed; old `packages` entries stay on disk. Read-only: a write
 * through it is dropped.
 */
export function roomLoaderSettings(cwd: string, agentDir: string): SettingsManager {
	const storage: SettingsStorage = {
		withLock(scope, fn) {
			const files = SettingsManager.create(cwd, agentDir);
			// A file that does not parse fails this read, as the runtime's file
			// storage does, so the session keeps what it last read and records
			// the error.
			const failed = files.drainErrors().find((entry) => entry.scope === scope);
			if (failed) throw failed.error;
			const { packages: _packages, ...rest } = scope === "global" ? files.getGlobalSettings() : files.getProjectSettings();
			fn(JSON.stringify(rest));
		},
	};
	return SettingsManager.fromStorage(storage);
}
