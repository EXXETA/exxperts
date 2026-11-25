import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, freePort, symlinkOrSkip, waitForServer } from "./smoke-server-process.js";
import { pathInFolder, servedFile } from "../src/static-route-path.js";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-static-security-headers-"));
const tempHome = path.join(tempRoot, "home");
const tempAgentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const tempAgentRuntimeRoot = path.join(tempHome, ".exxperts", "agent");
fs.mkdirSync(tempAgentsRoot, { recursive: true, mode: 0o700 });

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

// Every static answer carries the baseline headers, a 404 included: a
// browser still renders it.
function assertSecurityHeaders(headers: Headers, label: string): void {
	const csp = headers.get("content-security-policy") ?? "";
	assert(csp.length > 0, `${label}: content-security-policy header must be present`);
	for (const directive of [
		"default-src 'self'",
		"script-src 'self'",
		"object-src 'none'",
		"frame-ancestors 'none'",
		"base-uri 'self'",
	]) {
		assert(csp.includes(directive), `${label}: CSP must include "${directive}", got: ${csp}`);
	}
	assert(/connect-src [^;]*ws:\/\/127\.0\.0\.1:\*/.test(csp), `${label}: CSP connect-src must allow loopback websockets, got: ${csp}`);
	assert(!/script-src[^;]*'unsafe-eval'/.test(csp), `${label}: CSP must not allow unsafe-eval, got: ${csp}`);
	assert(headers.get("x-content-type-options") === "nosniff", `${label}: x-content-type-options must be nosniff`);
	assert(headers.get("referrer-policy") === "no-referrer", `${label}: referrer-policy must be no-referrer`);
}

// The page's built folder: its root holds fixtures.html and index.html,
// files no route but `/` names, so they are what a path leaving its route's
// folder would reach. Read, never written.
const page = path.join(repoRoot, "apps", "web-ui", "dist");
assert(fs.existsSync(path.join(page, "fixtures.html")) && fs.existsSync(path.join(page, "index.html")), "the page is not built: run the root npm run build first");
const rootFiles = ["fixtures.html", "index.html"].map((name) => fs.readFileSync(path.join(page, name)));

type RawAnswer = { status: number; headers: Headers; body: Buffer };

// fetch cleans a path before sending it, as a browser does; a script need
// not, so the rows send the path exactly as written.
function rawGet(target: string): Promise<RawAnswer> {
	return new Promise((resolve, reject) => {
		const request = http.request({ host: "127.0.0.1", port, path: target, method: "GET", headers: SMOKE_AUTH_HEADERS }, (response) => {
			const chunks: Buffer[] = [];
			response.on("data", (chunk: Buffer) => chunks.push(chunk));
			response.on("end", () => {
				const headers = new Headers();
				for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
				resolve({ status: response.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
			});
		});
		request.on("error", reject);
		request.end();
	});
}

async function assertRefused(target: string): Promise<void> {
	const answer = await rawGet(target);
	assert(answer.status === 404, `GET ${target}: answers ${answer.status}, not 404`);
	assert(!rootFiles.some((bytes) => answer.body.includes(bytes)), `GET ${target}: the 404 holds a file's bytes`);
	assertSecurityHeaders(answer.headers, `GET ${target}`);
}

async function assertServed(target: string, file: string, type: string): Promise<void> {
	const answer = await rawGet(target);
	assert(answer.status === 200, `GET ${target}: answers ${answer.status}, not 200`);
	assert(answer.body.equals(fs.readFileSync(file)), `GET ${target}: other bytes than ${path.relative(page, file)}`);
	assert(answer.headers.get("content-type") === type, `GET ${target}: content type ${answer.headers.get("content-type")}, not ${type}`);
	assertSecurityHeaders(answer.headers, `GET ${target}`);
}

const firstFile = (folder: string, ending: string): string => {
	const name = fs.readdirSync(path.join(page, folder)).filter((entry) => entry.endsWith(ending)).sort()[0];
	assert(name, `the built page has no ${ending} file under ${folder}/`);
	return name;
};

// Windows path rules, on any computer: a backslash is a separator there,
// encoded or not, and a drive letter is a way out.
{
	const folder = "C:\\exxperts\\apps\\web-ui\\dist\\assets";
	assert(pathInFolder(folder, "app.js", path.win32) === `${folder}\\app.js`, "win32: a file in the folder is named");
	assert(pathInFolder(folder, "chunks/app.js", path.win32) === `${folder}\\chunks\\app.js`, "win32: a file in a folder below is named");
	assert(pathInFolder("/exxperts/apps/web-ui/dist/assets", "chunks/../app.js", path.posix) === null, "posix: a .. segment that stays inside the folder still names no file");
	for (const rest of ["..\\fixtures.html", "%5c..%5cfixtures.html", "..%5Cfixtures.html", "chunks\\app.js", "D:/secret.txt", "%2e%2e/fixtures.html"]) {
		assert(pathInFolder(folder, rest, path.win32) === null, `win32: ${rest} must name no file`);
	}
	for (const rest of ["%E0%A4%A", "app.js%00.png", ""]) assert(pathInFolder(folder, rest, path.posix) === null, `posix: ${JSON.stringify(rest)} must name no file`);
	console.log("windows rules: a backslash, encoded or not, a drive letter, dot segments, a bad encoding and a NUL name no file; files in the folder are named");
}

// A link out of the route's folder, on any computer: a directory link is
// made as a junction, which Windows allows without Developer Mode.
{
	const linkPage = path.join(tempRoot, "page");
	const assets = path.join(linkPage, "assets");
	fs.mkdirSync(path.join(assets, "chunks"), { recursive: true });
	fs.writeFileSync(path.join(linkPage, "fixtures.html"), "outside the assets folder");
	fs.writeFileSync(path.join(assets, "app.js"), "inside");
	fs.writeFileSync(path.join(assets, "chunks", "part.js"), "inside, a folder below");
	fs.symlinkSync(linkPage, path.join(assets, "out"), "junction");
	fs.symlinkSync(path.join(assets, "chunks"), path.join(assets, "below"), "junction");
	assert(servedFile(assets, "out/fixtures.html") === null, "a folder link out of assets serves no file");
	assert(servedFile(assets, "app.js") === fs.realpathSync(path.join(assets, "app.js")), "a file in assets is served");
	assert(servedFile(assets, "below/part.js") === fs.realpathSync(path.join(assets, "chunks", "part.js")), "a folder link that stays inside assets is served");
	assert(servedFile(assets, "missing.js") === null && servedFile(assets, "chunks") === null, "a missing file and a folder serve nothing");
	if (symlinkOrSkip(path.join(linkPage, "fixtures.html"), path.join(assets, "out.js"), "static-security-headers smoke", "the file link row", "file")) {
		assert(servedFile(assets, "out.js") === null, "a file link out of assets serves no file");
	}
	console.log("links: a link out of the route's folder serves nothing; a link that stays inside it is served");
}

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
try {
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: {
			...process.env,
			HOME: tempHome, USERPROFILE: tempHome,
			PORT: String(port),
			...SMOKE_SERVER_AUTH_ENV,
			EXXETA_HOME: repoRoot,
			EXXPERTS_CODING_AGENT_DIR: tempAgentRuntimeRoot,
			EXXETA_PERSISTENT_AGENTS_ROOT: tempAgentsRoot,
		},
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server, baseUrl, 15000);

	// A path that leaves its route's folder: one folder up to the page's
	// root, two folders up and back into the page, and encoded dot segments.
	const leaving = ["assets", "brand", "fonts"].flatMap((folder) => [
		`/${folder}/../fixtures.html`,
		`/${folder}/../index.html`,
		`/${folder}/../../dist/fixtures.html`,
		`/${folder}/%2e%2e/fixtures.html`,
		`/${folder}/%2E%2E%2Ffixtures.html`,
	]);
	for (const target of leaving) await assertRefused(target);
	console.log(`leaving: ${leaving.length} raw requests with dot segments through /assets/, /brand/ and /fonts/ answer 404 with no file`);

	// A file missing under a route answers 404, never the page in its place.
	const missing = ["/assets/does-not-exist.js", "/brand/does-not-exist.png", "/fonts/does-not-exist.ttf", "/assets/"];
	for (const target of missing) await assertRefused(target);
	console.log(`missing: ${missing.length} requests for a missing file answer 404 with no file`);

	// The page still loads: each route's own files, with their bytes and type.
	await assertServed("/", path.join(page, "index.html"), "text/html; charset=utf-8");
	const script = firstFile("assets", ".js");
	await assertServed(`/assets/${script}`, path.join(page, "assets", script), "text/javascript; charset=utf-8");
	await assertServed(`/assets/${script}?v=1`, path.join(page, "assets", script), "text/javascript; charset=utf-8");
	const icon = firstFile("brand", ".png");
	await assertServed(`/brand/${icon}`, path.join(page, "brand", icon), "image/png");
	const font = firstFile("fonts", ".ttf");
	await assertServed(`/fonts/${font}`, path.join(page, "fonts", font), "font/ttf");
	await assertServed("/manifest.webmanifest", path.join(page, "manifest.webmanifest"), "application/manifest+json; charset=utf-8");
	console.log("served: /, /assets/, /brand/, /fonts/ and /manifest.webmanifest answer their files");

	// API responses are out of scope for the static policy — but they must not
	// have silently inherited a document CSP that could mask a future regression
	// in how the static headers are applied.
	const api = await fetch(`${baseUrl}/healthz`);
	assert(api.headers.get("content-security-policy") == null, "GET /healthz: API responses must not carry the static CSP");

	console.log("static security headers smoke passed");
} catch (error) {
	console.error(serverOutput.join(""));
	throw error;
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
