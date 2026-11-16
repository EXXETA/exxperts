import { isSharedServer } from "../server-hooks.js";

/**
 * Whether commands here run in a box: a person's own Mac, or a person's own
 * Windows PC whose start check (windows/start-check.ts) didn't say off. Nowhere
 * else does anything in room-box/ start. Its own module, importing nothing of
 * the box, so the stored settings can ask it.
 */

/** The Windows box's state as the check at start gave it. Broken still boxes: its commands run nothing. */
export type WindowsBoxState = "on" | "off" | "broken";

/** The computer's box: the Mac's, Windows', not known while Windows' check runs, or none. */
export type RoomBoxComputer = "mac" | "windows" | "unknown" | null;

const WINDOWS_STATES: readonly WindowsBoxState[] = ["on", "off", "broken"];

/** The check's answer once noted, and a promise kept until then. */
function checking() {
	let settle: () => void = () => {};
	const settled = new Promise<void>((resolve) => {
		settle = resolve;
	});
	return { noted: null as WindowsBoxState | null, settled, settle };
}

let check = checking();
let platformForTests: string | null = null;

function platform(): string {
	if (platformForTests !== null) return platformForTests;
	// A smoke acting as another platform (the switch in persistent-room-shell-missing.ts) gets that platform's commands. Refused on a shared server.
	const actedPlatform = process.env.EXXPERTS_TEST_INTROSPECTION === "1" ? process.env.EXXPERTS_TEST_SHELL_PLATFORM : undefined;
	return actedPlatform ?? process.platform;
}

/** A server acting as Windows takes its box's state from EXXPERTS_TEST_WINDOWS_BOX in place of the check; null otherwise. */
export function actedWindowsBoxState(): WindowsBoxState | null {
	if (platformForTests !== null || process.env.EXXPERTS_TEST_INTROSPECTION !== "1" || process.env.EXXPERTS_TEST_SHELL_PLATFORM !== "win32") return null;
	const acted = process.env.EXXPERTS_TEST_WINDOWS_BOX;
	return WINDOWS_STATES.find((state) => state === acted) ?? null;
}

/** Whether this server checks for the Windows box at start: a person's own Windows PC. */
export function windowsBoxChecks(): boolean {
	return platform() === "win32" && !isSharedServer();
}

/** The Windows box's state now: null while the check runs, and anywhere but a person's own Windows PC. */
export function windowsBoxState(): WindowsBoxState | null {
	if (!windowsBoxChecks()) return null;
	return actedWindowsBoxState() ?? check.noted;
}

export function roomBoxComputer(): RoomBoxComputer {
	if (isSharedServer()) return null;
	if (platform() === "darwin") return "mac";
	if (platform() !== "win32") return null;
	const state = windowsBoxState();
	if (state === null) return "unknown";
	return state === "off" ? null : "windows";
}

export function roomBoxAvailable(): boolean {
	const computer = roomBoxComputer();
	return computer === "mac" || computer === "windows";
}

/** The check's answer, noted once at start (index.ts); a later note changes nothing. */
export function noteWindowsBoxState(state: WindowsBoxState): void {
	check.noted ??= state;
	check.settle();
}

/** How long the app waits for Windows' check at start, past which its box is broken for the server's life (start-check.ts), and how long a bind waits for it. */
export const START_WAIT_MS = 20_000;

/** Resolves once the computer's box is known, or after `limitMs`: a bind and a new room wait here for Windows' check. */
export function roomBoxSettled(limitMs = START_WAIT_MS): Promise<void> {
	if (roomBoxComputer() !== "unknown") return Promise.resolve();
	let timer: NodeJS.Timeout | undefined;
	return Promise.race([check.settled, new Promise<void>((resolve) => { timer = setTimeout(resolve, limitMs); })]).finally(() => clearTimeout(timer));
}

/**
 * Smokes in one process act as a platform with this, and as Windows' check:
 * `windows` is its answer, or null while it runs, until noteWindowsBoxState.
 * Null puts the real computer back.
 */
export function setRoomBoxForTests(acted: { platform: string; windows: WindowsBoxState | null } | null): void {
	platformForTests = acted?.platform ?? null;
	check = checking();
	if (acted?.windows) noteWindowsBoxState(acted.windows);
}
