import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import type { BoxProcess } from "./box-process.js";
import { boxEnvironment, type BoxPlaces, boxRules } from "./box-rules.js";

// A library update or a macOS change can leave the box running and not holding.
// Each row runs a real command in a real box; a row that doesn't read as it must
// is a box that failed, so commands stop. Checked once per server start: what
// these rows prove changes only with a new release or a macOS update.
let proved = false;

function runBoxed(box: BoxProcess, places: BoxPlaces, room: string, command: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; output: string }> {
	return box.request<{ wrapped: string }>("wrap", { command, ...boxRules({ folder: room, canChangeFiles: true, alsoAllowed: [], skillFolders: [], places }) }).then(({ wrapped }) => new Promise((resolve, reject) => {
		// In its own group, as every command is.
		const child = spawn("/bin/bash", ["-c", wrapped], { cwd: room, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		child.stdout.on("data", (data) => { output += data; });
		child.stderr.on("data", (data) => { output += data; });
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, output }));
	}));
}

/**
 * Proves the box holds, with fixed rows: a write and a delete in the room work;
 * a read and a write outside it are refused; a site the room refuses is refused
 * through the proxy, and a direct connection that skips the proxy is refused.
 */
export async function runBoxProbe(box: BoxProcess, places: BoxPlaces): Promise<void> {
	if (proved) return;
	const room = path.join(places.temp, "probe");
	fs.mkdirSync(room, { recursive: true });
	fs.writeFileSync(path.join(room, "deleted.txt"), "");
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-box-probe-"));
	const closedFile = path.join(outside, "closed");
	fs.writeFileSync(closedFile, "");
	const listener = net.createServer();
	await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
	const { port } = listener.address() as net.AddressInfo;
	let reached = false;
	listener.on("connection", (socket) => {
		reached = true;
		socket.destroy();
	});
	const env = boxEnvironment(process.env, places);
	try {
		const run = (command: string) => runBoxed(box, places, room, command, env);
		const [written, deleted, read, wroteOutside, site, direct] = await Promise.all([
			run("echo ok > written.txt"),
			run("rm deleted.txt"),
			run(`/bin/cat ${JSON.stringify(closedFile)}`),
			run(`echo x > ${JSON.stringify(path.join(outside, "planted"))}`),
			// Through the proxy, which the box sends every connection to: the room refuses a local address, with no card.
			run(`/usr/bin/curl -fsS --max-time 10 http://localhost:${port}/`),
			run(`exec 3<>/dev/tcp/127.0.0.1/${port}`),
		]);
		const failed = [
			written.code !== 0 || !fs.existsSync(path.join(room, "written.txt")) ? "a write in the room" : "",
			deleted.code !== 0 || fs.existsSync(path.join(room, "deleted.txt")) ? "a delete in the room" : "",
			read.code === 0 ? "a read outside" : "",
			wroteOutside.code === 0 || fs.existsSync(path.join(outside, "planted")) ? "a write outside" : "",
			site.code === 0 ? "a site the room refuses" : "",
			direct.code === 0 ? "a direct connection" : "",
			reached ? "a connection reached this computer" : "",
		].filter(Boolean);
		if (failed.length > 0) throw new Error(`the box did not hold: ${failed.join(", ")}`);
		proved = true;
	} finally {
		listener.close();
		fs.rmSync(outside, { recursive: true, force: true });
		fs.rmSync(room, { recursive: true, force: true });
	}
}
