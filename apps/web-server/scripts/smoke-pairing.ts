// The device pairing smokes share: a paired phone's requests come from the
// remote test address, so the server must run with EXXPERTS_REMOTE_TEST_ADDRESS=::1.
import http from "node:http";
import { authedFetch } from "./smoke-server-process.js";

export interface RemoteAnswer { status: number; body: string; setCookie: string }

// One request from the remote address. Its own connection each time: a
// capability flip destroys the device's sockets, and a kept-alive one reused
// right after would reset.
export function remoteRequest(port: number, pathname: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<RemoteAnswer> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ host: "::1", port, path: pathname, method: options.method ?? "GET", agent: false, headers: { Host: `[::1]:${port}`, ...options.headers } },
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk) => chunks.push(chunk as Buffer));
				res.on("error", reject);
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), setCookie: ([] as string[]).concat(res.headers["set-cookie"] ?? []).join("; ") }));
			},
		);
		req.on("error", reject);
		if (options.body != null) req.write(options.body);
		req.end();
	});
}

async function adminJson(port: number, pathname: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`http://127.0.0.1:${port}${pathname}`, { method: init.method ?? "GET", ...(init.body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) }) });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// Pairs a device through the real flow: the computer makes a pairing code, the
// device sends it from the remote address, the computer approves it (with the
// server's default capability when none is given), and the device's status
// poll sets its cookie. Returns the device's id and its Cookie header value.
export async function pairDevice(port: number, name: string, capability?: string): Promise<{ deviceId: string; cookie: string }> {
	const minted = await adminJson(port, "/api/remote/enroll-code", { method: "POST" });
	check(minted.status === 200, `a pairing code was made, got ${minted.status}`);
	const code = new URL(String(minted.body.url)).searchParams.get("code") ?? "";
	const exchange = await remoteRequest(port, "/remote/enroll/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name }) });
	check(exchange.status === 200, `the device sent its pairing code, got ${exchange.status}`);
	const requestId = String(JSON.parse(exchange.body).requestId);
	const approve = await adminJson(port, "/api/remote/enroll-approve", { method: "POST", body: { requestId, ...(capability ? { capability } : {}) } });
	check(approve.status === 200, `the computer approved the device, got ${approve.status}`);
	const key = (await remoteRequest(port, `/remote/enroll/status?requestId=${requestId}`)).setCookie.match(/exxperts_remote_device=([0-9a-f]+)/)?.[1];
	check(key, "the approved device's status poll set its cookie");
	const record = (await adminJson(port, "/api/remote/devices")).body?.devices?.find((device: any) => device.name === name);
	check(record, `the paired device is in the computer's list: ${name}`);
	return { deviceId: String(record.id), cookie: `exxperts_remote_device=${key}` };
}
