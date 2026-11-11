import { smallDocx, vmlDocx } from "./workspace-preview-fixtures.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { authedFetch, freePort, type AuthedFetchInit, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, waitForServer } from "./smoke-server-process.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-workspace-default-api-home-"));
const tempAgentsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-workspace-default-api-agents-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const smokeAppDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(smokeAppDir, { recursive: true });
fs.writeFileSync(
	path.join(smokeAppDir, "openai-compatible-ai-profile.json"),
	JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }, { modelId: "claude-opus-4.6" }], maintenanceModel: "claude-opus-4.6" }, null, 2),
);
fs.writeFileSync(path.join(smokeAppDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = tempAgentsRoot;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = process.env.SERIES_PACKAGED_ROOT ? path.resolve(process.env.SERIES_PACKAGED_ROOT, "apps/web-server") : path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function inventedPdf(): Buffer {
	const stream = "0 0 0 rg 10 10 20 20 re f";
	const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
	let body = "%PDF-1.4\n";
	const offsets: number[] = [];
	objects.forEach((object, index) => { offsets.push(body.length); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
	const xref = body.length;
	body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
	return Buffer.from(body + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, "latin1");
}

async function requestJson(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, {
		...init,
		headers: {
			...(init.body ? { "content-type": "application/json" } : {}),
			...(init.headers ?? {}),
		},
	});
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

// On this computer a saved folder's view carries the path the person chose, in
// its root's `path`, and nothing else does: that one field is checked, then
// left out of the search for any other path.
function assertNoPathLeak(value: unknown, label: string, blockedPaths: string[], savedRoot?: string): void {
	let shown = value;
	if (savedRoot !== undefined) {
		const roots: any[] = (value as any)?.policy?.roots ?? [];
		assert(roots.length === 1 && roots[0].path === savedRoot, `${label}: the view carries the saved folder's path, got ${JSON.stringify(roots)}`);
		shown = { ...(value as any), policy: { ...(value as any).policy, roots: roots.map(({ path: _path, ...root }) => root) } };
	}
	const serialized = JSON.stringify(shown);
	for (const blockedPath of blockedPaths) {
		assert(!serialized.includes(blockedPath), `${label}: response must not leak absolute path ${blockedPath}`);
	}
	assert(!serialized.includes("realpath"), `${label}: response must not expose realpath field`);
	assert(!serialized.includes('"path"'), `${label}: response must not expose raw path field`);
}

let server: ChildProcessWithoutNullStreams | null = null;
const serverOutput: string[] = [];

try {
	const productAppStateRoot = path.join(tempHome, ".exxperts", "app");
	const workspaceRoot = path.join(tempHome, "workspace-default-api");
	fs.mkdirSync(productAppStateRoot, { recursive: true });
	fs.mkdirSync(workspaceRoot, { recursive: true });

	const { createCanvas } = await import("@napi-rs/canvas");
	const validJpeg = createCanvas(1, 1).toBuffer("image/jpeg").toString("base64");
	const policyRaceMarker = path.join(tempHome, "policy-race-marker");
	const policyRacePreload = path.join(tempHome, "policy-race-preload.cjs");
	fs.writeFileSync(policyRacePreload, `
const fs = require("node:fs");
const diagnosticMarker = ${JSON.stringify(path.join(tempHome, "diagnostic-mode"))};
const rafMarker = ${JSON.stringify(path.join(tempHome, "raf-marker"))};
const networkMarker = ${JSON.stringify(path.join(tempHome, "network-marker"))};
if (String(process.argv[1]).endsWith("shelf-parse-worker.mjs") && fs.existsSync(networkMarker)) {
 const install = (owner, key, label) => { let value = owner[key]; Object.defineProperty(owner, key, { configurable: true, get: () => value, set: next => { let denied = false; try { next(); } catch { denied = true; } fs.appendFileSync(networkMarker, label + ":control:" + denied + "\\n"); value = function(...args) { fs.appendFileSync(networkMarker, label + ":attempt\\n"); return next.apply(this, args); }; } }); };
 const http = require("node:http"), https = require("node:https"), net = require("node:net"), tls = require("node:tls"), dns = require("node:dns"), dgram = require("node:dgram"), http2 = require("node:http2");
 install(globalThis, "fetch", "fetch"); install(globalThis, "WebSocket", "websocket"); install(http, "request", "http"); install(https, "request", "https"); install(net, "connect", "socket"); install(tls, "connect", "tls"); install(dns, "lookup", "dns"); install(dns.Resolver.prototype, "resolve4", "dns-resolver"); install(dns.promises.Resolver.prototype, "resolve4", "dns-promise-resolver"); install(dgram, "createSocket", "udp"); install(http2, "connect", "http2");
}
if (String(process.argv[1]).endsWith("shelf-parse-worker.mjs") && fs.existsSync(rafMarker)) {
 Object.defineProperty(globalThis, "requestAnimationFrame", { configurable:true, set(next) {
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable:true, value(callback) { fs.appendFileSync(rafMarker, "scheduled\\n"); return next(() => { fs.appendFileSync(rafMarker, "executed\\n"); callback(); }); }});
 }});
}
if (String(process.argv[1]).endsWith("shelf-parse-worker.mjs") && fs.existsSync(diagnosticMarker)) {
 const mode = fs.readFileSync(diagnosticMarker, "utf8");
 Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, set() {
  const error = new TypeError(mode === "known" ? "requestAnimationFrame is not defined" : "invented private marker");
  if (mode === "unknown") error.name = "invented-name";
  throw error;
 }});
}
const originals = { open: fs.openSync, read: fs.readSync };
const realReaddir = fs.readdirSync;
const realReadFile = fs.readFileSync;
fs.readFileSync = function(file, ...args) { if (typeof file === "string" && file.endsWith("private-image.png")) throw new Error("invented private image detail " + file); return realReadFile.call(this, file, ...args); };
fs.readdirSync = function(file, ...args) { if (typeof file === "string" && file.endsWith("private-invented")) throw new Error("invented private detail " + file); return realReaddir.call(this, file, ...args); };
const selected = new Set();
fs.openSync = function(file, ...args) { const fd = originals.open.call(this, file, ...args); if (typeof file === "string" && file.endsWith("race-invented.html")) selected.add(fd); return fd; };
fs.readSync = function(fd, ...args) { if (selected.delete(fd) && fs.existsSync(${JSON.stringify(policyRaceMarker)})) fs.unlinkSync(fs.readFileSync(${JSON.stringify(policyRaceMarker)}, "utf8")); return originals.read.call(this, fd, ...args); };
const cp = require("node:child_process");
const realSpawn = cp.spawn;
const realFork = cp.fork;
let heldCount = 0;
cp.fork = function(file, args, options) {
  let request; try { request = JSON.parse(args?.[0] || "{}"); } catch {}
  if (request?.absolutePath?.endsWith("changing-preview.pdf")) {
   const child = new (require("node:events").EventEmitter)(); child.stderr = new (require("node:events").EventEmitter)();
   fs.writeFileSync(${JSON.stringify(path.join(tempHome, "preview-started"))}, "started");
   const timer = setInterval(() => { if (!fs.existsSync(${JSON.stringify(path.join(tempHome, "preview-release"))})) return; clearInterval(timer); child.emit("message", { ok:true, schemaVersion:1, notices:[], result:{kind:"pdf",totalPages:1,pages:[{page:1,mimeType:"image/jpeg",imageBase64:${JSON.stringify(validJpeg)},widthPx:1,heightPx:1}]} }); }, 10);
   child.kill = () => { clearInterval(timer); setImmediate(() => child.emit("close", 0, null)); return true; };
   return child;
  }
  if (request?.absolutePath?.endsWith("exit-race.pdf")) {
   const child = new (require("node:events").EventEmitter)(); child.stderr = new (require("node:events").EventEmitter)();
   child.kill = () => { setImmediate(() => child.emit("close", 0, null)); return true; };
   setImmediate(() => { child.emit("exit", 0, null); setTimeout(() => child.emit("message", { ok:false, schemaVersion:1, code:"renderer_unavailable" }), 20); });
   return child;
  }
  if (request?.absolutePath?.endsWith("held.pdf")) {
   const child = new (require("node:events").EventEmitter)(); child.stderr = new (require("node:events").EventEmitter)();
   child.kill = () => { setImmediate(() => child.emit("close", 0, null)); return true; };
   heldCount++; fs.writeFileSync(${JSON.stringify(path.join(tempHome, "held-count"))}, String(heldCount));
   if (heldCount > 2) setImmediate(() => child.emit("message", { ok:false, schemaVersion:1, code:"renderer_unavailable" }));
   return child;
  }
  if (request?.absolutePath?.endsWith("diagnostic-fake.docx")) {
   const child = new (require("node:events").EventEmitter)();
   child.stderr = new (require("node:events").EventEmitter)();
   child.kill = () => { setImmediate(() => child.emit("close", 0, null)); return true; };
   const mode = fs.readFileSync(diagnosticMarker, "utf8");
   setImmediate(() => {
    const line = "WORD_PREVIEW_DIAGNOSTIC TypeError|Unexpected renderer error\\n";
    if (mode === "chunked") { child.stderr.emit("data", Buffer.from(line.slice(0, 15))); child.stderr.emit("data", Buffer.from(line.slice(15))); }
    else if (mode === "duplicate") child.stderr.emit("data", Buffer.from(line + line));
    else child.stderr.emit("data", Buffer.from("WORD_PREVIEW_DIAGNOSTIC secret|invented private marker\\n"));
    child.emit("message", { ok:false, schemaVersion:1, code:"damaged_file" });
   });
   return child;
  }
  if (!request?.absolutePath?.endsWith("malformed-invented.xlsx")) return realFork.apply(this, arguments);
  const child = new (require("node:events").EventEmitter)();
  child.stderr = new (require("node:events").EventEmitter)();
  child.kill = () => { setImmediate(() => child.emit("close", 0, null)); return true; };
  const font = { family:"Arial", sizePt:11, color:"#000000", bold:false, italic:false, underline:"none", strike:false };
  const style = { fill:null, font, borders:{top:null,right:null,bottom:null,left:null}, align:{horizontal:"left",vertical:"top",wrap:false} };
  const sheet = { id:"1", name:"Invented", visibility:"visible", showGridLines:"invalid", rowCount:0, columnCount:0, defaultRowHeightPx:20, defaultColumnWidthPx:80, rows:[], columns:[], cells:[], merges:[] };
  setImmediate(() => child.emit("message", { ok:true, schemaVersion:1, notices:[], result:{kind:"spreadsheet",workbook:{dateSystem:"1900",styles:[style],sheets:[sheet]}} }));
  return child;
};
cp.spawn = function(file, args, options) {
  if (file !== "/usr/bin/xdg-open" && file !== "/usr/bin/open") return realSpawn.apply(this, arguments);
  const child = new (require("node:events").EventEmitter)();
  fs.writeFileSync(${JSON.stringify(path.join(tempHome, "fake-opener"))}, JSON.stringify({ file, args, shell: options.shell }));
  child.kill = () => true;
  setImmediate(() => child.emit("close", 0, null));
  return child;
};
require("node:module").syncBuiltinESMExports();
`);
	server = spawn(process.env.SERIES_PACKAGED_ROOT ? process.execPath : "npx", process.env.SERIES_PACKAGED_ROOT ? ["dist/server.mjs"] : ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: {
			...process.env,
			NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${policyRacePreload}`,
			DISPLAY: ":987",
			HOME: tempHome, USERPROFILE: tempHome,
			PORT: String(port),
			...SMOKE_SERVER_AUTH_ENV,
			EXXETA_HOME: repoRoot,
			EXXETA_PERSISTENT_AGENTS_ROOT: tempAgentsRoot,
		},
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server, baseUrl, 15000);
	const { writePersistentAgentThread } = await import("../src/persistent-agents.js");
	const { persistentRoomWorkspacePolicyPath, resolvePersistentRoomCapabilityPolicy } = await import("../src/persistent-room-workspace-policy.js");
	const model = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT 5.5" };

	const created = await requestJson("/api/persistent-agents", {
		method: "POST",
		body: JSON.stringify({
			displayName: "Workspace Default API Smoke",
			userName: "Synthetic User",
			preferredUserAddress: "Synthetic User",
		}),
	});
	assert(created.status === 201, `create room should succeed without workspace default, got ${created.status}: ${JSON.stringify(created.body)}`);
	const agentId = String(created.body?.agent?.agentId ?? "");
	assert(agentId, "created room should return agentId");
	const encodedAgentId = encodeURIComponent(agentId);
	const agentRoot = path.join(tempAgentsRoot, agentId);
	const defaultPath = path.join(agentRoot, "runtime", "workspace-default.json");
	const sentinelSidecarPath = path.join(agentRoot, "runtime", "workspace-policies", "room_default.json");

	let getDefault = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-default`);
	assert(getDefault.status === 200, `initial default GET should succeed, got ${getDefault.status}`);
	assert(getDefault.body?.policy === null, "missing room default should return null");
	assert(!fs.existsSync(defaultPath), "missing room default should not create default sidecar");
	assert(!fs.existsSync(sentinelSidecarPath), "missing room default must not create room_default thread sidecar");

	const putDefault = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-default`, {
		method: "PUT",
		body: JSON.stringify({ root: workspaceRoot, displayLabel: "Smoke Workspace", mode: "read-only" }),
	});
	assert(putDefault.status === 200, `PUT default should succeed, got ${putDefault.status}: ${JSON.stringify(putDefault.body)}`);
	fs.writeFileSync(path.join(workspaceRoot, "invented.txt"), "invented content");
	fs.mkdirSync(path.join(workspaceRoot, "notes"));
	fs.writeFileSync(path.join(workspaceRoot, "notes", "item.txt"), "invented");
	fs.writeFileSync(path.join(workspaceRoot, ".hidden"), "invented");
	fs.symlinkSync(path.join(workspaceRoot, "notes"), path.join(workspaceRoot, "linked-notes"));
	const listing = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-files?conversationId=demo-thread`);
	assert(listing.status === 200 && listing.body.entries.some((entry: { name: string }) => entry.name === "invented.txt"), "workspace listing exposes an allowed file through the public route");
	assert(listing.body.entries[0].kind === "directory" && !listing.body.entries.some((entry: { name: string }) => [".hidden", "linked-notes"].includes(entry.name)), "directories sort first and hidden files and symlinks are omitted");
	const nested = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-files?conversationId=demo-thread&path=notes`);
	assert(nested.status === 200 && nested.body.path === "notes" && nested.body.entries[0].relativePath === "notes/item.txt", "nested listing returns relative file paths");
	for (const blocked of ["../", "linked-notes", ".hidden"]) {
		const response = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-files?conversationId=demo-thread&path=${encodeURIComponent(blocked)}`);
		assert(response.status >= 400, `invalid or linked directory ${blocked} is refused`);
	}
	fs.mkdirSync(path.join(workspaceRoot, "private-invented"));
	const badListing = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-files?conversationId=demo-thread&path=private-invented`);
	assert(badListing.status >= 400 && !JSON.stringify(badListing.body).includes("invented private detail") && !JSON.stringify(badListing.body).includes(workspaceRoot), "unexpected listing failures never expose internal details or absolute paths");
	fs.writeFileSync(path.join(workspaceRoot, "invented.png"), Buffer.from([137, 80, 78, 71]));
	const image = await authedFetch(`${baseUrl}/api/persistent-agents/${encodedAgentId}/workspace-image?conversationId=demo-thread&path=invented.png`);
	assert(image.status === 200 && image.headers.get("content-type") === "image/png" && image.headers.get("x-content-type-options") === "nosniff", "workspace image route serves guarded image bytes with safe headers");
	assert(Buffer.from(await image.arrayBuffer()).equals(Buffer.from([137, 80, 78, 71])), "workspace image route returns the invented file bytes");
	for (const [name, mime] of [["invented.jpg", "image/jpeg"], ["invented.jpeg", "image/jpeg"], ["invented.gif", "image/gif"], ["invented.webp", "image/webp"], ["invented.svg", "image/svg+xml"]]) {
		fs.writeFileSync(path.join(workspaceRoot, name), "invented");
		const response = await authedFetch(`${baseUrl}/api/persistent-agents/${encodedAgentId}/workspace-image?conversationId=demo-thread&path=${name}`);
		assert(response.status === 200 && response.headers.get("content-type")?.startsWith(mime), `image MIME for ${name}`);
		assert(response.headers.get("content-security-policy")?.includes("sandbox") && response.headers.get("cache-control") === "no-store" && response.headers.get("referrer-policy") === "no-referrer", `image headers for ${name}`);
	}
	fs.symlinkSync(path.join(workspaceRoot, "invented.png"), path.join(workspaceRoot, "link.png"));
	for (const blocked of ["../invented.png", ".hidden.png", "link.png"]) {
		const response = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-image?conversationId=demo-thread&path=${encodeURIComponent(blocked)}`);
		assert(response.status >= 400, `blocked image path ${blocked} is refused`);
	}
	fs.writeFileSync(path.join(workspaceRoot, "oversize.png"), "");
	fs.truncateSync(path.join(workspaceRoot, "oversize.png"), 20 * 1024 * 1024 + 1);
	const largeImage = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-image?conversationId=demo-thread&path=oversize.png`);
	assert(largeImage.status === 413 && largeImage.body.code === "file_too_large", "image above 20 MiB is refused");
	fs.writeFileSync(path.join(workspaceRoot, "private-image.png"), "invented");
	const badImage = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-image?conversationId=demo-thread&path=private-image.png`);
	assert(badImage.status === 500 && badImage.body.code === "workspace_file_error" && !JSON.stringify(badImage.body).includes("invented private image detail") && !JSON.stringify(badImage.body).includes(workspaceRoot), "unexpected image failure is private");
	writePersistentAgentThread(agentId, "demo-thread", { state: "standby", origin: "home", model, items: [] });
	fs.writeFileSync(path.join(workspaceRoot, "invented.md"), Buffer.from([35, 32, 65, 0, 0xff]));
	const markdown = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-preview?conversationId=demo-thread&path=invented.md`);
	assert(markdown.status === 200 && markdown.body.kind === "text" && markdown.body.text === "# A\0\ufffd", "Markdown is read-only text with replacement decoding and NUL preserved");
	fs.writeFileSync(path.join(workspaceRoot, "invalid.json"), "{broken json");
	const invalidJson = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-preview?conversationId=demo-thread&path=invalid.json`);
	assert(invalidJson.status === 200 && invalidJson.body.kind === "text" && invalidJson.body.text === "{broken json", "invalid JSON stays available as literal text");
	const plain = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-preview?conversationId=demo-thread&path=invented.txt`);
	assert(plain.status === 200 && plain.body.text === "invented content", "text file is returned as inert text");
	fs.writeFileSync(path.join(workspaceRoot, "empty.md"), "");
	const emptyMarkdown = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-preview?conversationId=demo-thread&path=empty.md`);
	assert(emptyMarkdown.status === 200 && emptyMarkdown.body.text === "", "empty Markdown is available as empty text");
	fs.writeFileSync(path.join(workspaceRoot, "boundary.md"), "");
	fs.truncateSync(path.join(workspaceRoot, "boundary.md"), 16_777_216);
	const boundary = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-preview?conversationId=demo-thread&path=boundary.md`);
	assert(boundary.status === 200 && boundary.body.text.length === 16_777_216, "Markdown accepts its exact size limit");
	fs.truncateSync(path.join(workspaceRoot, "boundary.md"), 16_777_217);
	const tooLarge = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-preview?conversationId=demo-thread&path=boundary.md`);
	assert(tooLarge.status === 413 && tooLarge.body.code === "file_too_large", "Markdown above the size limit is refused");
	const originalMarkdownBytes = fs.readFileSync(path.join(workspaceRoot, "invented.md"));
	const noWrite = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-markdown?conversationId=demo-thread&path=invented.md`, { method: "PUT", body: JSON.stringify({ content: "replacement", revision: "invented" }) });
	if (process.env.SERIES_COMBINED === "1") {
		assert(noWrite.status === 400 && noWrite.body.code === "invalid_body", "combined Markdown route rejects invalid revision");
		assert(fs.readFileSync(path.join(workspaceRoot, "invented.md")).equals(originalMarkdownBytes), "invalid revision leaves original bytes intact");
	} else {
		assert(noWrite.status === 404, "Series 1 has no Markdown write route");
	}
	const movedRoot = `${workspaceRoot}-moved`;
	const replacementRoot = `${workspaceRoot}-replacement`;
	fs.renameSync(workspaceRoot, movedRoot);
	fs.mkdirSync(replacementRoot);
	fs.writeFileSync(path.join(replacementRoot, "invented.md"), "replacement secret");
	fs.symlinkSync(replacementRoot, workspaceRoot);
	try {
		for (const endpoint of ["workspace-files", "workspace-preview?path=invented.md", "workspace-image?path=invented.png"]) {
			const separator = endpoint.includes("?") ? "&" : "?";
			const response = await requestJson(`/api/persistent-agents/${encodedAgentId}/${endpoint}${separator}conversationId=demo-thread`);
			assert(!JSON.stringify(response.body).includes("replacement secret"), `retargeted grant never exposes replacement content on ${endpoint}`);
			assert(response.status >= 400 || response.body.root === null, `retargeted grant refuses ${endpoint}`);
		}
	} finally {
		fs.unlinkSync(workspaceRoot);
		fs.rmSync(replacementRoot, { recursive: true, force: true });
		fs.renameSync(movedRoot, workspaceRoot);
	}
	fs.writeFileSync(path.join(workspaceRoot, "invented.html"), "<p>Invented page</p>");
	const html = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-preview?conversationId=demo-thread&path=invented.html`);
	assert(html.status === 200 && html.body.kind === "html" && html.body.html === "<p>Invented page</p>", "HTML preview returns the guarded invented content");
	const htmlFrame = await authedFetch(`${baseUrl}/api/persistent-agents/${encodedAgentId}/workspace-preview?conversationId=demo-thread&path=invented.html&frame=1`);
	assert(htmlFrame.status === 200 && htmlFrame.headers.get("content-security-policy")?.includes("connect-src 'none'"), "HTML frame is served with a sandboxed network policy");
	fs.writeFileSync(path.join(workspaceRoot, "race-invented.html"), "<p>Private invented content</p>");
	fs.writeFileSync(path.join(workspaceRoot, "invented.pptx"), "invented presentation bytes");
	const deck = await authedFetch(`${baseUrl}/api/persistent-agents/${encodedAgentId}/workspace-preview?conversationId=demo-thread&path=invented.pptx`);
	assert(deck.status === 200 && deck.headers.get("content-type")?.startsWith("application/octet-stream") && await deck.text() === "invented presentation bytes", "presentation bytes travel through the guarded route");
	fs.writeFileSync(path.join(workspaceRoot, "invented.pdf"), inventedPdf());
	const pdf = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-preview?conversationId=demo-thread&path=invented.pdf`);
	fs.writeFileSync(path.join(workspaceRoot, "invented.docx"), await smallDocx());
	const { default: ExcelJS } = await import("exceljs");
	const workbook = new ExcelJS.Workbook();
	workbook.addWorksheet("Invented").getCell("A1").value = "Invented cell";
	fs.writeFileSync(path.join(workspaceRoot, "invented.xlsx"), Buffer.from(await workbook.xlsx.writeBuffer()));
	const networkMarker = path.join(tempHome, "network-marker");
	fs.writeFileSync(networkMarker, "");
	const word = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-preview?conversationId=demo-thread&path=invented.docx`);
	const sheet = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-preview?conversationId=demo-thread&path=invented.xlsx`);
	assert(word.status === 200 && word.body.kind === "word" && typeof word.body.html === "string", "Word travels through the real child and guarded public route");
	assert(word.body.html.includes("External image blocked.") && word.body.notices.some((notice: { code: string }) => notice.code === "external_resources_blocked"), "Word external resources become an inert notice");
	assert(!word.body.html.includes("example.invalid") && !word.body.html.includes("<script>"), "Word preview does not expose active remote resources");
	const networkProbes = fs.readFileSync(networkMarker, "utf8");
	for (const name of ["fetch", "websocket", "http", "https", "socket", "tls", "dns", "dns-resolver", "dns-promise-resolver", "udp", "http2"]) assert(networkProbes.includes(`${name}:control:true`), `${name} deny control is active`);
	assert(!networkProbes.includes(":attempt"), "Word rendering makes no outbound attempts");
	fs.rmSync(networkMarker);
	fs.writeFileSync(path.join(workspaceRoot, "vml.docx"), await vmlDocx());
	const rafMarker = path.join(tempHome, "raf-marker");
	fs.writeFileSync(rafMarker, "");
	const vml = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-preview?conversationId=demo-thread&path=vml.docx`);
	assert(vml.status === 200 && vml.body.kind === "word", "invented VML renders through the guarded route");
	const { JSDOM } = await import("jsdom");
	const dom = new JSDOM(vml.body.html);
	const header = dom.window.document.querySelector("header"), footer = dom.window.document.querySelector("footer");
	assert(dom.window.document.querySelectorAll("section.docx").length === 2, "saved break forms two pages");
	assert(header && footer && header.style.marginTop && header.style.minHeight && footer.style.marginBottom && footer.style.minHeight, "header and footer retain placement");
	assert([...header.querySelectorAll<HTMLElement>("[style*='left:']")].some(node => node.style.left === "72pt"), "header offset accounts for page margin");
	const anchors = [...dom.window.document.querySelectorAll<HTMLElement>("[style*='left:']")].filter(node => node.style.top);
	assert(anchors.some(node => node.style.left === "72pt" && node.style.top === "72pt") && anchors.some(node => node.style.left === "144pt" && node.style.top === "144pt"), "VML anchor offsets are distinct");
	assert([...dom.window.document.querySelectorAll("img")].some(img => img.style.transform.includes("rotate(270deg)")), "rotation is retained");
	assert(!dom.window.document.querySelector("svg,foreignObject,script") && !vml.body.html.includes("example.invalid") && !vml.body.html.includes("inventedHandler") && !vml.body.html.includes("Invented box"), "active VML content is removed");
	assert([...dom.window.document.querySelectorAll("div")].some(node => node.style.borderTopStyle === "double"), "VML line is a double rule");
	dom.window.close();
	const rafOutput = fs.readFileSync(rafMarker, "utf8");
	assert(rafOutput.includes("scheduled") && !rafOutput.includes("executed"), "Word animation callbacks are scheduled but never run");
	fs.rmSync(rafMarker);
	const diagnosticMarker = path.join(tempHome, "diagnostic-mode");
	for (const [mode, line] of [["normal", "TypeError|Unexpected renderer error"], ["known", "TypeError|requestAnimationFrame is not defined"], ["unknown", "UnknownError|Unexpected renderer error"]]) {
		fs.writeFileSync(diagnosticMarker, mode);
		const prior = serverOutput.length;
		const failedWord = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-preview?conversationId=demo-thread&path=invented.docx`);
		assert(failedWord.status === 422 && failedWord.body.code === "damaged_file", `diagnostic ${mode} retains safe response`);
		const output = serverOutput.slice(prior).join("");
		assert(output.includes(`WORD_PREVIEW_DIAGNOSTIC ${line}`), `diagnostic ${mode} is validated and logged`);
		assert(!output.includes("invented private marker") && !JSON.stringify(failedWord.body).includes("invented private marker"), "diagnostics do not expose private details");
		fs.rmSync(diagnosticMarker);
	}
	assert(sheet.status === 200 && sheet.body.kind === "spreadsheet" && sheet.body.workbook.sheets[0].cells[0].text === "Invented cell", "XLSX travels through the real child and guarded public route");
	fs.writeFileSync(path.join(workspaceRoot, "malformed-invented.xlsx"), "invented");
	const malformed = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-preview?conversationId=demo-thread&path=malformed-invented.xlsx`);
	assert(malformed.status === 500 && malformed.body.code === "preview_failed", "the parent rejects a non-boolean spreadsheet gridline field");
	assert(pdf.status === 200 && pdf.body.kind === "pdf" && pdf.body.totalPages === 1 && pdf.body.pages[0].mimeType === "image/jpeg", "PDF travels through the real child and guarded public route");
	for (const [name, expectedStatus, expectedCode] of [["legacy.doc", 415, "legacy_doc"], ["legacy.xls", 415, "unsupported_file_type"], ["broken.pdf", 422, "damaged_file"]] as const) {
		fs.writeFileSync(path.join(workspaceRoot, name), "invented damaged content");
		const response = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-preview?conversationId=demo-thread&path=${name}`);
		assert(response.status === expectedStatus && response.body.code === expectedCode, `${name} receives its controlled preview refusal`);
	}
	fs.writeFileSync(path.join(workspaceRoot, "oversize.pdf"), "");
	fs.truncateSync(path.join(workspaceRoot, "oversize.pdf"), 26_214_401);
	const oversizePdf = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-preview?conversationId=demo-thread&path=oversize.pdf`);
	assert(oversizePdf.status === 413 && oversizePdf.body.code === "file_too_large", "PDF input over the child limit is refused");
	const { default: JSZip } = await import("jszip");
	const encryptedZip = new JSZip();
	encryptedZip.file("invented.txt", "invented");
	const encrypted = Buffer.from(await encryptedZip.generateAsync({ type: "nodebuffer" }));
	const central = encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
	assert(central >= 0, "invented ZIP contains a central directory entry");
	encrypted.writeUInt16LE(encrypted.readUInt16LE(central + 8) | 1, central + 8);
	fs.writeFileSync(path.join(workspaceRoot, "encrypted-invented.xlsx"), encrypted);
	const encryptedPreview = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-preview?conversationId=demo-thread&path=encrypted-invented.xlsx`);
	assert(encryptedPreview.status === 422 && encryptedPreview.body.code === "encrypted_file", "encrypted spreadsheet is refused by the real child");
	fs.writeFileSync(path.join(workspaceRoot, "broken-invented.xlsx"), "invented invalid spreadsheet");
	const brokenSpreadsheet = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-preview?conversationId=demo-thread&path=broken-invented.xlsx`);
	assert(brokenSpreadsheet.status === 422 && brokenSpreadsheet.body.code === "damaged_file", "damaged spreadsheet is refused by the real child");
	const expansionZip = new JSZip();
	expansionZip.file("word/document.xml", "x".repeat(1_000_000));
	fs.writeFileSync(path.join(workspaceRoot, "expansion.docx"), await expansionZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
	const expansion = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-preview?conversationId=demo-thread&path=expansion.docx`);
	assert(expansion.status === 413 && expansion.body.code === "expanded_content_too_large", "Word ZIP expansion is refused before rendering");
	const elementsZip = await JSZip.loadAsync(await smallDocx());
	elementsZip.file("word/custom.xml", `<root>${"<x/>".repeat(200_001)}</root>`);
	fs.writeFileSync(path.join(workspaceRoot, "elements.docx"), await elementsZip.generateAsync({ type: "nodebuffer" }));
	const elements = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-preview?conversationId=demo-thread&path=elements.docx`);
	assert(elements.status === 413 && elements.body.code === "preview_too_complex", "Word XML element budget is enforced");
	fs.writeFileSync(path.join(workspaceRoot, "diagnostic-fake.docx"), "invented");
	for (const mode of ["chunked", "duplicate", "invalid"]) {
		fs.writeFileSync(diagnosticMarker, mode);
		const prior = serverOutput.length;
		const failedWord = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-preview?conversationId=demo-thread&path=diagnostic-fake.docx`);
		const output = serverOutput.slice(prior).join("");
		assert(failedWord.status === 422 && failedWord.body.code === "damaged_file", `fake diagnostic ${mode} retains safe response`);
		assert(output.includes("WORD_PREVIEW_DIAGNOSTIC") === (mode === "chunked"), `only valid single diagnostic ${mode} is logged`);
		assert(!output.includes("invented private marker"), "invalid stderr is never relayed");
		fs.rmSync(diagnosticMarker);
	}
	fs.writeFileSync(path.join(workspaceRoot, "exit-race.pdf"), "invented");
	const exitRace = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-preview?conversationId=demo-thread&path=exit-race.pdf`);
	assert(exitRace.status === 503 && exitRace.body.code === "renderer_unavailable", "late child IPC settles correctly after an exit event");
	fs.writeFileSync(path.join(workspaceRoot, "held.pdf"), "invented");
	const heldUrl = `${baseUrl}/api/persistent-agents/${encodedAgentId}/workspace-preview?conversationId=demo-thread&path=held.pdf`;
	const firstAbort = new AbortController(), secondAbort = new AbortController();
	const pending = [authedFetch(heldUrl, { signal: firstAbort.signal }).catch(() => null), authedFetch(heldUrl, { signal: secondAbort.signal }).catch(() => null)];
	for (let i = 0; i < 100 && (!fs.existsSync(path.join(tempHome, "held-count")) || fs.readFileSync(path.join(tempHome, "held-count"), "utf8") !== "2"); i++) await new Promise(resolve => setTimeout(resolve, 50));
	assert(fs.existsSync(path.join(tempHome, "held-count")) && fs.readFileSync(path.join(tempHome, "held-count"), "utf8") === "2", "two preview children started");
	const busy = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-preview?conversationId=demo-thread&path=held.pdf`);
	assert(busy.status === 503 && busy.body.code === "preview_busy", "third concurrent preview is refused");
	firstAbort.abort(); secondAbort.abort(); await Promise.all(pending);
	let released = false;
	for (let i = 0; i < 100 && !released; i++) {
		const response = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-preview?conversationId=demo-thread&path=held.pdf`);
		released = response.status === 503 && response.body.code === "renderer_unavailable";
		if (!released) await new Promise(resolve => setTimeout(resolve, 50));
	}
	assert(released, "cancelled previews release their slots");
	fs.writeFileSync(path.join(workspaceRoot, "invented.xls"), "invented");
	const openHeaders = { origin: baseUrl, "x-exxperts-local-action": "open-workspace-file" };
	const rejectedXls = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-open`, { method: "POST", headers: openHeaders, body: JSON.stringify({ conversationId: "demo-thread", path: "invented.xls" }) });
	assert(rejectedXls.status === 415 && rejectedXls.body.code === "unsupported_file_type", "legacy XLS is refused by the local open route");
	const openerMarker = path.join(tempHome, "fake-opener");
	const noIntent = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-open`, { method: "POST", headers: { origin: baseUrl }, body: JSON.stringify({ conversationId: "demo-thread", path: "invented.txt" }) });
	assert(noIntent.status === 403 && noIntent.body.code === "local_action_forbidden", "missing local intent refuses opening");
	for (const [file, status, code] of [["../invented.txt", 400, "invalid_path"], ["link.png", 403, "blocked_by_policy"], ["invented.md", 415, "unsupported_file_type"], ["missing.pdf", 404, "file_not_found"]] as const) {
		const refused = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-open`, { method: "POST", headers: openHeaders, body: JSON.stringify({ conversationId: "demo-thread", path: file }) });
		assert(refused.status === status && refused.body.code === code && refused.body.error === "This file could not be opened in another program.", `open refuses ${file} with a safe error`);
		assert(!fs.existsSync(openerMarker), `refused ${file} never calls the opener`);
	}
	if (process.platform === "linux") {
		const opened = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-open`, { method: "POST", headers: openHeaders, body: JSON.stringify({ conversationId: "demo-thread", path: "invented.txt" }) });
		assert(opened.status === 202 && opened.body.accepted === true, "explicit local open accepts the guarded file with the fake opener");
		const call = JSON.parse(fs.readFileSync(path.join(tempHome, "fake-opener"), "utf8"));
		assert(call.file === "/usr/bin/xdg-open" && call.shell === false && call.args[0] === path.join(workspaceRoot, "invented.txt"), "opener receives the guarded path without a shell");
		for (const name of ["macro.xlsm", "diagram.drawio", "diagram.dio"]) {
			fs.writeFileSync(path.join(workspaceRoot, name), "invented");
			const accepted = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-open`, { method: "POST", headers: openHeaders, body: JSON.stringify({ conversationId: "demo-thread", path: name }) });
			assert(accepted.status === 202 && accepted.body.accepted === true, `open-only ${name} is dispatched`);
			const preview = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-preview?conversationId=demo-thread&path=${name}`);
			assert(preview.status === 415 && preview.body.code === "unsupported_file_type", `open-only ${name} has no preview parser`);
		}
	}
	for (const [allowed, listAllowed, readAllowed] of [[[], false, false], [["ls"], true, false], [["read"], false, true]] as const) {
		const updated = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-default`, { method: "PUT", body: JSON.stringify({ workspaceAccessMode: "bounded", toolSelection: { kind: "custom", allowedToolNames: allowed }, bashEnabled: false }) });
		assert(updated.status === 200, "invented workspace tool selection is saved");
		const listed = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-files?conversationId=demo-thread`);
		assert((listed.body.root !== null) === listAllowed, `listing follows ls selection ${allowed}`);
		const preview = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-preview?conversationId=demo-thread&path=invented.md`);
		assert((preview.status === 200) === readAllowed, `preview follows read selection ${allowed}`);
		const selectedImage = await authedFetch(`${baseUrl}/api/persistent-agents/${encodedAgentId}/workspace-image?conversationId=demo-thread&path=invented.png`);
		assert((selectedImage.status === 200) === readAllowed, `image follows read selection ${allowed}`);
	}
	const restoreTools = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-default`, { method: "PUT", body: JSON.stringify({ workspaceAccessMode: "localFiles", toolSelection: { kind: "standard" } }) });
	assert(restoreTools.status === 200, "workspace permissions restored after tool matrix");
	const changingPreview = path.join(workspaceRoot, "changing-preview.pdf");
	const previewStarted = path.join(tempHome, "preview-started"), previewRelease = path.join(tempHome, "preview-release");
	for (const scenario of ["permission", "file"]) {
		fs.writeFileSync(changingPreview, "invented");
		const savedPolicy = fs.readFileSync(defaultPath);
		const pendingPreview = authedFetch(`${baseUrl}/api/persistent-agents/${encodedAgentId}/workspace-preview?conversationId=demo-thread&path=changing-preview.pdf`);
		for (let i = 0; i < 100 && !fs.existsSync(previewStarted); i++) await new Promise(resolve => setTimeout(resolve, 50));
		assert(fs.existsSync(previewStarted), "preview child started before change");
		if (scenario === "permission") {
			const revoked = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-default`, { method: "PUT", body: JSON.stringify({ workspaceAccessMode: "bounded", toolSelection: { kind: "custom", allowedToolNames: [] }, bashEnabled: false }) });
			assert(revoked.status === 200, "workspace access revoked during rendering");
		} else fs.appendFileSync(changingPreview, "changed");
		fs.writeFileSync(previewRelease, "release");
		const response = await pendingPreview;
		const body = await response.json();
		assert(scenario === "permission" ? response.status === 403 && body.code === "workspace_read_forbidden" : response.status === 409 && body.code === "file_changed", `changed ${scenario} is refused after rendering`);
		fs.writeFileSync(defaultPath, savedPolicy);
		fs.rmSync(previewStarted); fs.rmSync(previewRelease);
	}
	const policyBeforeRace = fs.readFileSync(defaultPath);
	for (const suffix of ["", "&frame=1"]) {
		fs.writeFileSync(policyRaceMarker, defaultPath);
		const revoked = await authedFetch(`${baseUrl}/api/persistent-agents/${encodedAgentId}/workspace-preview?conversationId=demo-thread&path=race-invented.html${suffix}`);
		const payload = await revoked.text();
		assert(revoked.status === 403 && payload.includes("workspace_read_forbidden") && !payload.includes("Private invented content"), "HTML preview rechecks revoked policy before returning content");
		fs.writeFileSync(defaultPath, policyBeforeRace);
		fs.rmSync(policyRaceMarker);
	}
	assert(putDefault.body?.storage?.kind === "persistent-agent-runtime-default", "PUT should report room-default storage kind");
	assert(putDefault.body?.policy?.rootCount === 1, "PUT should return one redacted root");
	assert(putDefault.body?.policy?.roots?.[0]?.displayLabel === "Smoke Workspace", "PUT should preserve safe display label");
	assert(putDefault.body?.policy?.workspaceAccessMode === "localFiles", "PUT without explicit mode should default new room workspace to Local files");
	assert(putDefault.body?.policy?.pathAccess === "local-files", "Local files default should expose local-files path access");
	assert(putDefault.body?.policy?.nativePiFilesystemToolsEnabled === true, "Local files default should expose native Pi filesystem tools");
	assert(putDefault.body?.policy?.bashEnabled === false, "Local files default should keep bash disabled");
	assert(putDefault.body?.policy?.allowedToolNames?.join(",") === "read,ls,find,grep,write,edit", "Local files default should expose fixed W5 tool set");
	assertNoPathLeak(putDefault.body, "PUT default", [tempHome, tempAgentsRoot, repoRoot, workspaceRoot, agentRoot], workspaceRoot);
	assert(fs.existsSync(defaultPath), "PUT should write runtime/workspace-default.json");
	assert(!fs.existsSync(sentinelSidecarPath), "PUT default must not create workspace-policies/room_default.json");

	getDefault = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-default`);
	assert(getDefault.status === 200, `saved default GET should succeed, got ${getDefault.status}`);
	assert(getDefault.body?.policy?.rootCount === 1, "saved default GET should return redacted policy view");
	assertNoPathLeak(getDefault.body, "GET saved default", [tempHome, tempAgentsRoot, repoRoot, workspaceRoot, agentRoot], workspaceRoot);
	assert(Array.isArray(getDefault.body?.warnings) && getDefault.body.warnings.length === 0, "saved default GET with existing folder should return no warnings");

	// Migrated/renamed workspace: the granted folder no longer exists on this machine.
	fs.rmSync(workspaceRoot, { recursive: true, force: true });
	const getMissingRoot = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-default`);
	assert(getMissingRoot.status === 200, `missing-folder GET should still succeed, got ${getMissingRoot.status}`);
	assert(getMissingRoot.body?.policy?.rootCount === 1, "missing-folder GET should keep the saved policy");
	const missingWarnings: string[] = getMissingRoot.body?.warnings ?? [];
	assert(missingWarnings.some((warning) => warning.includes("Smoke Workspace")), "missing-folder warning should name the workspace by its safe label");
	assertNoPathLeak(getMissingRoot.body, "GET missing-folder default", [tempHome, tempAgentsRoot, repoRoot, workspaceRoot, agentRoot], workspaceRoot);
	fs.mkdirSync(workspaceRoot, { recursive: true });
	const getRestoredRoot = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-default`);
	assert((getRestoredRoot.body?.warnings ?? []).length === 0, "restored-folder GET should clear the warning");

	const noRootUpdate = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-default`, {
		method: "PUT",
		body: JSON.stringify({ mode: "read-only" }),
	});
	assert(noRootUpdate.status === 200, `PUT no-root default update should succeed, got ${noRootUpdate.status}: ${JSON.stringify(noRootUpdate.body)}`);
	assert(noRootUpdate.body?.policy?.workspaceAccessMode === "localFiles", "no-root default update should preserve existing workspace access mode when omitted");
	assert(noRootUpdate.body?.policy?.allowedToolNames?.join(",") === "read,ls,find,grep,write,edit", "no-root Local files update should keep fixed W5 tools");
	assertNoPathLeak(noRootUpdate.body, "PUT no-root default update", [tempHome, tempAgentsRoot, repoRoot, workspaceRoot, agentRoot], workspaceRoot);

	const enableBashNoRoot = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-default`, {
		method: "PUT",
		body: JSON.stringify({ workspaceAccessMode: "localFiles", mode: "read-only", toolSelection: { kind: "custom", allowedToolNames: [] }, bashEnabled: true }),
	});
	assert(enableBashNoRoot.status === 200, `PUT no-root bash enable should succeed, got ${enableBashNoRoot.status}: ${JSON.stringify(enableBashNoRoot.body)}`);
	assert(enableBashNoRoot.body?.policy?.workspaceAccessMode === "localFiles", "bash enable update should preserve Local files mode");
	assert(enableBashNoRoot.body?.policy?.allowedToolNames?.length === 0, "bash enable update should allow ordinary Local files tools to be all off");
	assert(enableBashNoRoot.body?.policy?.bashEnabled === true, "bash enable update should expose explicit bash enabled");
	assert(enableBashNoRoot.body?.policy?.writeEnabled === false, "bash without writer tools must not report write capability — bash reach is its own flag");
	assertNoPathLeak(enableBashNoRoot.body, "PUT no-root bash enable", [tempHome, tempAgentsRoot, repoRoot, workspaceRoot, agentRoot], workspaceRoot);

	const invalidLocalFilesToolSelection = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-default`, {
		method: "PUT",
		body: JSON.stringify({ workspaceAccessMode: "localFiles", mode: "read-only", toolSelection: { kind: "custom", allowedToolNames: ["read", "bash"] } }),
	});
	assert(invalidLocalFilesToolSelection.status === 400, `Local files bash tool selection should reject, got ${invalidLocalFilesToolSelection.status}: ${JSON.stringify(invalidLocalFilesToolSelection.body)}`);
	assertNoPathLeak(invalidLocalFilesToolSelection.body, "invalid Local files bash tool selection", [tempHome, tempAgentsRoot, repoRoot, workspaceRoot, agentRoot]);
	const invalidLocalFilesBoundedToolSelection = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-default`, {
		method: "PUT",
		body: JSON.stringify({ workspaceAccessMode: "localFiles", mode: "read-only", toolSelection: { kind: "custom", allowedToolNames: ["read", "unknown_tool"] } }),
	});
	assert(invalidLocalFilesBoundedToolSelection.status === 400, `Local files bounded-only tool selection should reject, got ${invalidLocalFilesBoundedToolSelection.status}: ${JSON.stringify(invalidLocalFilesBoundedToolSelection.body)}`);
	assertNoPathLeak(invalidLocalFilesBoundedToolSelection.body, "invalid Local files bounded-only tool selection", [tempHome, tempAgentsRoot, repoRoot, workspaceRoot, agentRoot]);
	const invalidBoundedToolSelection = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-default`, {
		method: "PUT",
		body: JSON.stringify({ workspaceAccessMode: "bounded", mode: "read-only", toolSelection: { kind: "custom", allowedToolNames: ["read", "bash"] } }),
	});
	assert(invalidBoundedToolSelection.status === 400, `bounded bash tool selection should reject, got ${invalidBoundedToolSelection.status}: ${JSON.stringify(invalidBoundedToolSelection.body)}`);
	assertNoPathLeak(invalidBoundedToolSelection.body, "invalid bounded bash tool selection", [tempHome, tempAgentsRoot, repoRoot, workspaceRoot, agentRoot]);

	// Compat: older clients still send a workspace mode string. Garbage keeps
	// failing loudly, but a valid value is discarded — write capability derives
	// from the tool selection alone (the mode:"read-only" bodies above prove
	// the accept-and-ignore half).
	const invalidMode = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-default`, {
		method: "PUT",
		body: JSON.stringify({ workspaceAccessMode: "localFiles", mode: "garbage" }),
	});
	assert(invalidMode.status === 400, `invalid legacy mode string should still reject, got ${invalidMode.status}: ${JSON.stringify(invalidMode.body)}`);
	const readOnlySelection = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-default`, {
		method: "PUT",
		body: JSON.stringify({ workspaceAccessMode: "localFiles", mode: "read-only", toolSelection: { kind: "custom", allowedToolNames: ["read", "ls", "find", "grep"] }, bashEnabled: false }),
	});
	assert(readOnlySelection.status === 200, `PUT read-only selection should succeed, got ${readOnlySelection.status}: ${JSON.stringify(readOnlySelection.body)}`);
	assert(readOnlySelection.body?.policy?.writeEnabled === false, "a selection without writer tools must report writeEnabled false");
	assert(readOnlySelection.body?.policy?.modes?.write === false, "modes.write mirrors the derived writer presence");

	// Live workspace defaults: a mutation applies to the RUNNING conversation
	// from its next message. A thread sidecar that merely mirrors the current
	// default (the old snapshot regime pinned every thread this way) is
	// released by the mutation; a deliberate per-conversation override stays.
	// How the thread then resolves is persistent-room-workspace-live-default-smoke's.
	const legacyThreadId = "legacy_active_workspace_default";
	writePersistentAgentThread(agentId, legacyThreadId, {
		state: "standby",
		origin: "home",
		model,
		items: [{ kind: "user", text: "legacy visible turn from the snapshot regime" }],
	});
	const legacySidecarPath = persistentRoomWorkspacePolicyPath(agentId, legacyThreadId, { persistentAgentsRoot: tempAgentsRoot });
	assert(!fs.existsSync(legacySidecarPath), "legacy active thread fixture should start without a workspace sidecar");
	// Plant an old-regime mirror: a sidecar cloned byte-for-byte in content from
	// the current default (fresh policyId/conversationId, same grants).
	const currentDefaultRaw = JSON.parse(fs.readFileSync(defaultPath, "utf-8"));
	fs.mkdirSync(path.dirname(legacySidecarPath), { recursive: true });
	fs.writeFileSync(legacySidecarPath, JSON.stringify({ ...currentDefaultRaw, policyId: "prcp_legacy_mirror_fixture", conversationId: legacyThreadId }, null, 2) + "\n");
	const changedWorkspaceRoot = path.join(tempHome, "workspace-default-api-changed");
	fs.mkdirSync(changedWorkspaceRoot, { recursive: true });
	const changedDefault = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-default`, {
		method: "PUT",
		body: JSON.stringify({ root: changedWorkspaceRoot, displayLabel: "Changed Workspace", workspaceAccessMode: "bounded", mode: "read-only", bashEnabled: true }),
	});
	assert(changedDefault.status === 200, `PUT changed default should succeed with a message-bearing active thread, got ${changedDefault.status}: ${JSON.stringify(changedDefault.body)}`);
	assert(changedDefault.body?.policy?.workspaceAccessMode === "bounded", "explicit changed default should save bounded workspace mode");
	assert(changedDefault.body?.policy?.pathAccess === "workspace-only", "explicit bounded default should expose workspace-only path access");
	assert(changedDefault.body?.policy?.bashEnabled === false, "explicit bounded default should force bash disabled even when requested");
	assert(changedDefault.body?.policy?.writeEnabled === true, "the standard bounded bundle includes writer tools, so writeEnabled derives true");
	assert(Array.isArray(changedDefault.body?.warnings) && changedDefault.body.warnings.length === 0, "live default change should report no warnings");
	assert(!fs.existsSync(legacySidecarPath), "changing the default should release the active thread's mirror sidecar so the thread follows the live default");
	const changedDefaultJson = fs.readFileSync(defaultPath, "utf-8");
	assert(changedDefaultJson.includes(JSON.stringify(changedWorkspaceRoot).slice(1, -1)), "room default should be updated to changed workspace root");
	assertNoPathLeak(changedDefault.body, "PUT changed default", [tempHome, tempAgentsRoot, repoRoot, workspaceRoot, changedWorkspaceRoot, agentRoot], changedWorkspaceRoot);
	// A deliberate per-conversation override (differing content) survives the
	// next default change.
	const overrideRaw = { ...currentDefaultRaw, policyId: "prcp_deliberate_override_fixture", conversationId: legacyThreadId, bashEnabled: false, workspaceAccessMode: "bounded", toolSelection: { kind: "custom", allowedToolNames: ["ls", "read"] }, allowedToolNames: ["ls", "read"] };
	fs.writeFileSync(legacySidecarPath, JSON.stringify(overrideRaw, null, 2) + "\n");
	const changedAgain = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-default`, {
		method: "PUT",
		body: JSON.stringify({ workspaceAccessMode: "bounded", mode: "read-only" }),
	});
	assert(changedAgain.status === 200, `second default change should succeed, got ${changedAgain.status}: ${JSON.stringify(changedAgain.body)}`);
	assert(fs.existsSync(legacySidecarPath), "a deliberate per-conversation override must survive a default change");
	fs.rmSync(legacySidecarPath, { force: true });

	const invalidRepo = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-default`, {
		method: "PUT",
		body: JSON.stringify({ root: repoRoot, mode: "read-only" }),
	});
	assert(invalidRepo.status === 400, `repo root should reject, got ${invalidRepo.status}`);
	assert(invalidRepo.body?.code === "forbidden_root", `repo root should reject as forbidden_root, got ${JSON.stringify(invalidRepo.body)}`);
	assertNoPathLeak(invalidRepo.body, "invalid repo root", [tempHome, tempAgentsRoot, repoRoot, workspaceRoot, agentRoot]);

	const invalidProductAppRoot = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-default`, {
		method: "PUT",
		body: JSON.stringify({ root: productAppStateRoot, mode: "read-only" }),
	});
	assert(invalidProductAppRoot.status === 400, `~/.exxperts/app root should reject, got ${invalidProductAppRoot.status}`);
	assert(invalidProductAppRoot.body?.code === "forbidden_root", `~/.exxperts/app should reject as forbidden_root, got ${JSON.stringify(invalidProductAppRoot.body)}`);
	assertNoPathLeak(invalidProductAppRoot.body, "invalid product app root", [tempHome, tempAgentsRoot, repoRoot, workspaceRoot, agentRoot]);

	const invalidRoomRoot = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-default`, {
		method: "PUT",
		body: JSON.stringify({ root: agentRoot, mode: "read-only" }),
	});
	assert(invalidRoomRoot.status === 400, `room root should reject, got ${invalidRoomRoot.status}`);
	assert(invalidRoomRoot.body?.code === "forbidden_root", `room root should reject as forbidden_root, got ${JSON.stringify(invalidRoomRoot.body)}`);
	assertNoPathLeak(invalidRoomRoot.body, "invalid room root", [tempHome, tempAgentsRoot, repoRoot, workspaceRoot, agentRoot]);

	const deleted = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-default`, { method: "DELETE" });
	assert(deleted.status === 200, `DELETE default should succeed, got ${deleted.status}`);
	assert(deleted.body?.deleted === true, "DELETE should report existing default deleted");
	assert(deleted.body?.policy === null, "DELETE should return null policy");
	assert(!fs.existsSync(defaultPath), "DELETE should remove runtime/workspace-default.json");
	assert(!fs.existsSync(sentinelSidecarPath), "DELETE must not create room_default thread sidecar");

	// Setting a first-ever default while a conversation with history is running
	// succeeds under the live model: the running thread picks it up from its
	// next message instead of requiring a checkpoint/Memento boundary first.
	const noDefaultThreadId = "legacy_no_default_thread";
	writePersistentAgentThread(agentId, noDefaultThreadId, {
		state: "standby",
		origin: "home",
		model,
		items: [{ kind: "user", text: "visible turn with no workspace default yet" }],
	});
	const noDefaultSidecarPath = persistentRoomWorkspacePolicyPath(agentId, noDefaultThreadId, { persistentAgentsRoot: tempAgentsRoot });
	assert(!fs.existsSync(noDefaultSidecarPath), "no-default active thread fixture should not have a workspace sidecar");
	const firstDefaultSet = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-default`, {
		method: "PUT",
		body: JSON.stringify({ root: workspaceRoot, displayLabel: "First Live Workspace", workspaceAccessMode: "localFiles", mode: "read-only" }),
	});
	assert(firstDefaultSet.status === 200, `setting default from none with message-bearing active thread should succeed live, got ${firstDefaultSet.status}: ${JSON.stringify(firstDefaultSet.body)}`);
	assert(firstDefaultSet.body?.policy?.roots?.[0]?.displayLabel === "First Live Workspace", "first live default should save the new workspace");
	assert(!fs.existsSync(noDefaultSidecarPath), "live default set must not create a thread sidecar");
	const firstLiveResolution = resolvePersistentRoomCapabilityPolicy(agentId, noDefaultThreadId, { persistentAgentsRoot: tempAgentsRoot });
	assert(firstLiveResolution.source === "room-default", "running thread should resolve the newly set default from its next message");
	assertNoPathLeak(firstDefaultSet.body, "first live default set", [tempHome, tempAgentsRoot, repoRoot, workspaceRoot, changedWorkspaceRoot, agentRoot], workspaceRoot);
	const clearedLive = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-default`, { method: "DELETE" });
	assert(clearedLive.status === 200 && clearedLive.body?.deleted === true, "clearing the live default should succeed");
	assert(resolvePersistentRoomCapabilityPolicy(agentId, noDefaultThreadId, { persistentAgentsRoot: tempAgentsRoot }).source === "none", "running thread should resolve to no workspace after the clear");

	const deletedAgain = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-default`, { method: "DELETE" });
	assert(deletedAgain.status === 200, `second DELETE default should succeed, got ${deletedAgain.status}`);
	assert(deletedAgain.body?.deleted === false, "second DELETE should be idempotent no-op");
	getDefault = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-default`);
	assert(getDefault.status === 200 && getDefault.body?.policy === null, "GET after delete should return null policy");

	console.log("persistent-room workspace default API smoke passed");
} catch (error) {
	const output = serverOutput.join("").trim();
	if (output) console.error(output.split("\n").slice(-60).join("\n"));
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp HOME preserved for inspection: ${tempHome}`);
	console.error(`temp agents root preserved for inspection: ${tempAgentsRoot}`);
	process.exitCode = 1;
} finally {
	await stopSmokeServer(server);
	if (process.exitCode == null || process.exitCode === 0) {
		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempAgentsRoot, { recursive: true, force: true });
	}
}
