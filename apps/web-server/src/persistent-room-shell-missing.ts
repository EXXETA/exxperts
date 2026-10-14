import { findShellConfig, getAgentDir, isNoShellFoundMessage, SettingsManager, setShellLookupPlatformForTests } from "@exxeta/exxperts-runtime";

/**
 * Shell commands on a computer with no shell to run them in: only Windows
 * without Git for Windows (or another bash) gets here, since macOS and Linux
 * always have one. The person reads one plain line, in the Workspace pane and
 * in the chat; the runtime's own text, which tells a developer to edit
 * settings.json, goes to the server log only.
 *
 * Whether a shell is found is the runtime's own lookup, run fresh each time:
 * a Git installed while the app runs is found by the next command and the
 * next look at the pane, with no restart. The line still names a restart for
 * a bash the running app's PATH cannot see yet; the skills import's Git line
 * says the same.
 */
export const PERSISTENT_ROOM_SHELL_MISSING_SENTENCE = "On Windows, shell commands need Git for Windows. Install it from gitforwindows.org; the room can run commands as soon as it is installed. If it still says this, restart exxperts.";

/**
 * The lookup the room's bash tool makes, with the shell path a settings file
 * may name. Only the runtime's no-shell failure counts as missing: any other
 * (a settings file's shell path that does not exist) is a developer's error,
 * which the bash tool shows as it is.
 */
export function persistentRoomShellFound(runtimeCwd: string): boolean {
	let shellPath: string | undefined;
	try {
		shellPath = SettingsManager.create(runtimeCwd, getAgentDir()).getShellPath();
	} catch {}
	try {
		return findShellConfig(shellPath) !== null;
	} catch {
		return true;
	}
}

/**
 * Test switch: with the server's test introspection on, a smoke on macOS or
 * Linux can have the lookup walk the Windows path. Both variables are needed,
 * so a stray one alone changes nothing.
 */
export function applyShellLookupTestSwitch(env: NodeJS.ProcessEnv = process.env): void {
	if (env.EXXPERTS_TEST_INTROSPECTION === "1" && env.EXXPERTS_TEST_SHELL_PLATFORM === "win32") setShellLookupPlatformForTests("win32");
}

type ToolResultContent = Array<{ type: string; text?: string }>;

/**
 * The room-scoped extension that swaps the no-shell failure of a bash call for
 * the plain line. The swap happens before the result is recorded, so the
 * chat, the transcript and the model all get the line; the model relays it
 * instead of the settings.json advice. Every other result passes untouched.
 */
export function createPersistentRoomShellMissingExtension(logRaw: (raw: string) => void) {
	return async (pi: { on: (event: "tool_result", handler: (event: any) => Promise<{ content: ToolResultContent; isError: true } | undefined>) => void }) => {
		pi.on("tool_result", async (event: any) => {
			if (event?.toolName !== "bash" || event?.isError !== true) return undefined;
			const content: ToolResultContent = Array.isArray(event.content) ? event.content : [];
			const raw = content.map((part) => (part?.type === "text" ? String(part.text ?? "") : "")).join("\n");
			if (!isNoShellFoundMessage(raw)) return undefined;
			logRaw(raw);
			return { content: [{ type: "text", text: PERSISTENT_ROOM_SHELL_MISSING_SENTENCE }], isError: true };
		});
	};
}
