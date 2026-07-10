import { spawnSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

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
export async function stopSmokeServer(server: ChildProcessWithoutNullStreams | undefined): Promise<void> {
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
