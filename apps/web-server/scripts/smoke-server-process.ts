import { spawnSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

// Server-spawning smokes authenticate like a programmatic caller: the smoke
// pins the client auth token by putting EXXPERTS_AUTH_TOKEN in the server env
// (the server then uses the pinned value instead of minting one; enforcement
// is identical) and sends the same value back in the X-Exxperts-Auth header.
export const SMOKE_AUTH_TOKEN = "exxperts-smoke-pinned-auth-token";
export const SMOKE_SERVER_AUTH_ENV = { EXXPERTS_AUTH_TOKEN: SMOKE_AUTH_TOKEN } as const;
export const SMOKE_AUTH_HEADERS = { "X-Exxperts-Auth": SMOKE_AUTH_TOKEN } as const;

// init.headers is deliberately narrowed to a plain object: a Headers instance
// would spread to {} and silently drop the auth header. Explicit caller
// headers win over the auth header, which is what a negative test wants.
// Smokes wrapping authedFetch should type their init as AuthedFetchInit, not
// RequestInit, so the narrowing carries through when scripts are typechecked.
export type AuthedFetchInit = Omit<RequestInit, "headers"> & { headers?: Record<string, string> };
export function authedFetch(url: string | URL, init: AuthedFetchInit = {}): Promise<Response> {
	return fetch(url, { ...init, headers: { ...SMOKE_AUTH_HEADERS, ...init.headers } });
}

// Smokes spawn the web server as npx → tsx → node, so a plain SIGTERM to the
// npx process leaves the actual server running on Linux and Windows (macOS
// happens to tear the tree down). On POSIX the server must therefore run in
// its own process group (detached) so the whole tree can be signalled at once.
export const SMOKE_SERVER_SPAWN_TREE_OPTIONS: { detached?: boolean } =
	process.platform === "win32" ? {} : { detached: true };

function killTree(pid: number, signal: NodeJS.Signals): void {
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
		return;
	}
	try {
		process.kill(-pid, signal);
	} catch {
		try { process.kill(pid, signal); } catch {}
	}
}

// Stop the smoke's server without ever hanging: SIGTERM the tree, wait
// bounded, escalate to SIGKILL. An unbounded wait-for-exit here is exactly
// what turned one leaked server process into a 45-minute CI timeout.
export async function stopSmokeServer(server: ChildProcessWithoutNullStreams | null | undefined): Promise<void> {
	if (!server || server.exitCode != null || server.pid == null) return;
	const exited = new Promise<void>((resolve) => server.once("exit", () => resolve()));
	const waitUpTo = (ms: number) => Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, ms))]);
	killTree(server.pid, "SIGTERM");
	await waitUpTo(10_000);
	if (server.exitCode == null) {
		killTree(server.pid, "SIGKILL");
		await waitUpTo(5_000);
	}
}
