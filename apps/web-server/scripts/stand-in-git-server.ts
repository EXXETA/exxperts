// Stand-in git repositories for the skill smokes: bare repositories served over
// git's smart http by git's own http-backend, on this machine only. Every
// request is counted: an ask is the start of a listing of refs (each ls-remote
// and each clone makes one), a fetch is a request for objects. A repository in
// `signedOut` answers as a host does to a request without a sign-in; one in
// `held` answers only once its promise settles.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

/** Runs git in `cwd` with a fixed author; its output, or a thrown error naming the command. */
export function git(cwd: string, args: string[]): string {
	const res = spawnSync("git", ["-c", "user.email=smoke@test", "-c", "user.name=Smoke", ...args], { cwd, encoding: "utf-8" });
	if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
	return res.stdout.trim();
}

/** Whether this git can serve repositories (it ships http-backend). */
export function gitServesHttp(): boolean {
	const execPath = spawnSync("git", ["--exec-path"], { encoding: "utf-8" }).stdout.trim();
	return fs.existsSync(path.join(execPath, "git-http-backend")) || fs.existsSync(path.join(execPath, "git-http-backend.exe"));
}

/** A SKILL.md with its name and description, in `root`/`rel`. */
export function writeSkill(root: string, rel: string, name: string, body: string, description = `The ${name} skill.`, extra = ""): void {
	const dir = path.join(root, rel);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n${body}\n`);
}

export interface StandInRepo {
	work: string;
	bare: string;
	url: string;
	commit: (message: string) => string;
	push: (ref?: string) => void;
}

export interface StandInGitServer {
	/** Every request answered, by repository name. */
	requests: Array<{ repo: string; ask: boolean; fetch: boolean }>;
	signedOut: Set<string>;
	held: Map<string, Promise<void>>;
	/** A working copy in `workRoot` pushed to a bare repository served as /team/<name>.git. */
	makeRepo: (name: string) => StandInRepo;
	/** The asks and fetches answered for one repository since `requests` was cleared. */
	countFor: (repo: string) => { asks: number; fetches: number };
	port: () => number;
	close: () => void;
}

/** Starts the server on a free port of 127.0.0.1, serving the bare repositories under `serveRoot`. */
export async function startStandInGitServer(serveRoot: string, workRoot: string): Promise<StandInGitServer> {
	const requests: StandInGitServer["requests"] = [];
	const signedOut = new Set<string>();
	const held = new Map<string, Promise<void>>();
	const server = http.createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://fixture");
		const repo = url.pathname.match(/^\/team\/([^/]+)\.git\//)?.[1] ?? "";
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", async () => {
			const body = Buffer.concat(chunks);
			requests.push({ repo, ask: req.method === "GET" && url.pathname.endsWith("/info/refs"), fetch: req.method === "POST" && /command=fetch|want [0-9a-f]{40}/.test(body.toString("latin1")) });
			if (signedOut.has(repo)) {
				res.writeHead(401, { "www-authenticate": 'Basic realm="fixture"' }).end("HTTP Basic: Access denied\n");
				return;
			}
			await held.get(repo);
			const cgi = spawn("git", ["http-backend"], {
				env: {
					...process.env,
					GIT_PROJECT_ROOT: serveRoot,
					GIT_HTTP_EXPORT_ALL: "1",
					PATH_INFO: url.pathname,
					QUERY_STRING: url.search.slice(1),
					REQUEST_METHOD: req.method ?? "GET",
					CONTENT_TYPE: String(req.headers["content-type"] ?? ""),
					HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"] ?? ""),
					GIT_PROTOCOL: String(req.headers["git-protocol"] ?? ""),
				},
			});
			// Git asks nothing of a request without a body and may have answered and gone already; even a write of no bytes
			// to it then fails as a broken pipe.
			if (body.length > 0) cgi.stdin.write(body);
			cgi.stdin.end();
			let head = Buffer.alloc(0);
			let headed = false;
			cgi.stdout.on("data", (chunk: Buffer) => {
				if (headed) {
					res.write(chunk);
					return;
				}
				head = Buffer.concat([head, chunk]);
				const at = head.indexOf("\r\n\r\n");
				if (at < 0) return;
				headed = true;
				let status = 200;
				for (const line of head.subarray(0, at).toString().split("\r\n")) {
					const colon = line.indexOf(": ");
					if (line.slice(0, colon).toLowerCase() === "status") status = Number.parseInt(line.slice(colon + 2), 10);
					else res.setHeader(line.slice(0, colon), line.slice(colon + 2));
				}
				res.writeHead(status);
				res.write(head.subarray(at + 4));
			});
			cgi.once("close", () => res.end());
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	return {
		requests,
		signedOut,
		held,
		port: () => port,
		countFor: (repo) => ({ asks: requests.filter((request) => request.repo === repo && request.ask).length, fetches: requests.filter((request) => request.repo === repo && request.fetch).length }),
		makeRepo: (name) => {
			const work = path.join(workRoot, name);
			const bare = path.join(serveRoot, "team", `${name}.git`);
			fs.mkdirSync(work, { recursive: true });
			git(work, ["init", "-q", "-b", "main"]);
			fs.mkdirSync(path.dirname(bare), { recursive: true });
			git(serveRoot, ["init", "-q", "--bare", "-b", "main", bare]);
			git(work, ["remote", "add", "origin", bare]);
			return {
				work,
				bare,
				url: `http://127.0.0.1:${port}/team/${name}.git`,
				commit: (message) => {
					git(work, ["add", "-A"]);
					git(work, ["commit", "-q", "--allow-empty", "-m", message]);
					return git(work, ["rev-parse", "HEAD"]);
				},
				push: (ref = "HEAD:main") => {
					git(work, ["push", "-q", "--force", "origin", ref]);
				},
			};
		},
		close: () => {
			server.closeAllConnections();
			server.close();
		},
	};
}
