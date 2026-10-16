import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { agentSkillsDir, readManagedSkillPackage, skillPackageDisplayPin, writeSkillProvenance } from "../src/skills-store.js";
import { checkSkillLibrary, readSkillLibraries, recordSkillLibraryImport, refreshSkillLibraryFromSnapshot, saveSkillLibrary, scanSkillLibrary } from "../src/skills-libraries.js";
import { disposeAllCheckouts, fetchRepoCandidate, importReviewedRepoSkill } from "../src/skills-repo-fetch.js";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-library-fetch-status-"));
const repository = path.join(work, "repository");
const serveRoot = path.join(work, "serve");
const bare = path.join(serveRoot, "team", "skills.git");
const keys = ["EXXPERTS_STATE_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"] as const;
const previous = new Map(keys.map((key) => [key, process.env[key]]));
process.env.EXXPERTS_STATE_HOME = path.join(work, "profile");
process.env.GIT_CONFIG_GLOBAL = path.join(work, "gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, "");
let server: http.Server | undefined;

function git(args: string[], cwd = repository): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}

try {
	fs.mkdirSync(repository);
	fs.mkdirSync(path.join(serveRoot, "team"), { recursive: true });
	fs.writeFileSync(path.join(repository, "SKILL.md"), "---\nname: brand-status\n---\nRead colors.css for brand colors.\n");
	fs.writeFileSync(path.join(repository, "colors.css"), "body { color: #123456; }\n");
	fs.mkdirSync(path.join(repository, "other"));
	fs.writeFileSync(path.join(repository, "other", "SKILL.md"), "---\nname: optional-skill\n---\nNot selected for import.\n");
	git(["init", "-q", "-b", "main"]);
	git(["add", "-A"]);
	git(["-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-qm", "fixture"]);
	const assetOid = git(["rev-parse", "HEAD:colors.css"]);
	const manifestOid = git(["rev-parse", "HEAD:SKILL.md"]);
	git(["clone", "-q", "--bare", repository, bare], work);
	git(["config", "uploadpack.allowFilter", "true"], bare);
	let failSelectedBlob = false;
	let sawManifestAfterFailureEnabled = false;
	let refusedAsset = false;
	server = http.createServer(async (request, response) => {
		const bodyChunks: Buffer[] = [];
		for await (const chunk of request) bodyChunks.push(Buffer.from(chunk));
		const body = Buffer.concat(bodyChunks);
		const fetchingManifest = failSelectedBlob && body.includes(Buffer.from(`want ${manifestOid}`));
		if (failSelectedBlob && body.includes(Buffer.from(`want ${assetOid}`))) {
			refusedAsset = true;
			response.writeHead(503).end("controlled selected-blob fetch failure");
			return;
		}
		const url = new URL(request.url ?? "/", "http://fixture");
		const child = spawn("git", ["http-backend"], { env: { ...process.env, GIT_PROJECT_ROOT: serveRoot, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: request.method ?? "GET", CONTENT_TYPE: String(request.headers["content-type"] ?? ""), CONTENT_LENGTH: String(body.length), GIT_PROTOCOL: String(request.headers["git-protocol"] ?? "") } });
		child.stdin.end(body);
		let head = Buffer.alloc(0);
		let headersSent = false;
		child.stdout.on("data", (chunk: Buffer) => {
			if (headersSent) { response.write(chunk); return; }
			head = Buffer.concat([head, chunk]);
			const boundary = head.indexOf("\r\n\r\n");
			if (boundary < 0) return;
			headersSent = true;
			let status = 200;
			for (const line of head.subarray(0, boundary).toString().split("\r\n")) {
				const separator = line.indexOf(": ");
				if (separator < 0) continue;
				if (line.slice(0, separator).toLowerCase() === "status") status = Number.parseInt(line.slice(separator + 2), 10);
				else response.setHeader(line.slice(0, separator), line.slice(separator + 2));
			}
			response.writeHead(status);
			response.write(head.subarray(boundary + 4));
		});
		child.once("error", () => { if (!response.headersSent) response.writeHead(500); response.end(); });
		child.once("close", (code) => {
			if (fetchingManifest && code === 0) sawManifestAfterFailureEnabled = true;
			response.end();
		});
	});
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	const source = `http://127.0.0.1:${(server.address() as AddressInfo).port}/team/skills.git`;
	const library = saveSkillLibrary({ name: "Selected asset source", source, designRepo: true, allowedTypes: ["markdown", "styles"], skillRoot: "", referenceRoots: [] });
	const scan = await scanSkillLibrary(library.id);
	const candidate = await fetchRepoCandidate(scan.token, "", ["colors.css"]);
	const destination = path.join(agentSkillsDir(), "brand-status");
	const imported = await importReviewedRepoSkill(scan.token, "", ["colors.css"], candidate.reviewSha256, destination);
	writeSkillProvenance(destination, imported.provenance);
	assert.equal(skillPackageDisplayPin(destination)?.packageSha256, readManagedSkillPackage(destination)?.packageSha256, "advisory metadata hashes match verified packages without reading reference bytes");
	const success = await checkSkillLibrary(library.id);
	assert.equal(success.status, "current");
	assert(success.updates?.some((entry) => entry.status === "new"), "unselected skills remain discoverable without a false update badge");
	assert.ok(success.lastSuccessfulCheckAt);
	await refreshSkillLibraryFromSnapshot(library.id, scan.token);
	assert.equal(readSkillLibraries()[0].status, "current", "reconciliation reuses the original reviewed snapshot");
	fs.writeFileSync(path.join(repository, "unrelated.md"), "Unrelated new commit.\n");
	git(["add", "-A"]);
	git(["-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-qm", "unrelated"]);
	git(["push", bare, "main"]);
	const newer = await checkSkillLibrary(library.id);
	assert.notEqual(newer.revision, scan.revision);
	const reconciled = await refreshSkillLibraryFromSnapshot(library.id, scan.token);
	assert.equal(reconciled.revision, newer.revision, "an older import review cannot overwrite a newer checked remote revision");
	failSelectedBlob = true;
	const failed = await checkSkillLibrary(library.id);
	assert.equal(sawManifestAfterFailureEnabled, true, "manifest scanning succeeded before the selected reference failed");
	assert.equal(refusedAsset, true, "controlled failure happened during the selected asset's lazy fetch");
	assert.equal(failed.status, "error", "a source I/O failure is not advertised as a reviewable update");
	assert.equal(failed.lastSuccessfulCheckAt, reconciled.lastSuccessfulCheckAt, "failed reference fetch does not advance successful-check evidence");
	assert.match(failed.error ?? "", /503|could not fetch/i);
	const racingCheck = checkSkillLibrary(library.id);
	recordSkillLibraryImport(library.id, reconciled.revision!, "");
	await racingCheck;
	assert.equal(readSkillLibraries()[0].status, "current", "an older in-flight check cannot overwrite accepted import status");
	assert.equal(fs.readFileSync(path.join(destination, "colors.css"), "utf8"), "body { color: #123456; }\n", "source failure preserves the installed bytes");
	console.log("skills-library-fetch-status-smoke: OK");
} finally {
	disposeAllCheckouts();
	if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
	for (const key of keys) { const value = previous.get(key); if (value === undefined) delete process.env[key]; else process.env[key] = value; }
	fs.rmSync(work, { recursive: true, force: true });
}
