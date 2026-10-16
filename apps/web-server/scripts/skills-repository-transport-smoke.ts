import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { disposeAllCheckouts, fetchRepoCandidate, loadFeaturedSource, previewRepoFile, readRepoReference, readRepositoryMaterial, repositoryScanFromToken, scanRepository } from "../src/skills-repo-fetch.js";
import { anonymousRepositoryAccess, clearRepositoryAccess, grantRepositoryAccess, repositoryGitAvailable, revokeRepositoryAccess } from "../src/skills-repository-access.js";

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-repository-transport-"));
const originalPath = process.env.PATH, originalState = process.env.EXXPERTS_STATE_HOME, originalFetch = globalThis.fetch;
const installRoots = new Map(["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"].map((name) => [name, process.env[name]]));
const missingGit = path.join(fixture, "empty-path"); fs.mkdirSync(missingGit);
const source = "https://github.com/fixture/transport";
const revision = "1".repeat(40), tree = "2".repeat(40);
const fileBytes = new Map([
	["LICENSE", Buffer.from("MIT License\nPermission is hereby granted, free of charge, to any person obtaining a copy.\n")],
	["skills/brainstorm/SKILL.md", Buffer.from("---\nname: brainstorm\ndescription: A transport fixture\n---\n# Brainstorm\n[Notes](references/notes.md) [Brand](../../assets/brand.css)\n")],
	["skills/brainstorm/references/notes.md", Buffer.from("# Notes\nUse explicit repository access.\n")],
	["assets/brand.css", Buffer.from(":root { --brand: #315; }\n")],
	["assets/run.js", Buffer.from("throw new Error('never fetched');\n")],
	["assets/private.txt", Buffer.from("file type not enabled\n")],
	["elsewhere/hidden.md", Buffer.from("outside approved roots\n")],
	["assets/logo.svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
	["assets/logo.png", Buffer.from("unselected binary asset, never downloaded")],
]);
const oid = (bytes: Buffer) => crypto.createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const digest = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
const blobs = new Map([...fileBytes].map(([, bytes]) => [oid(bytes), bytes]));
const files = [...fileBytes].map(([file, bytes]) => ({ path: file, mode: "100644", type: "blob", sha: oid(bytes) }));
files.push({ path: "danger/SKILL.md", mode: "120000", type: "blob", sha: oid(Buffer.from("../skills/brainstorm/SKILL.md")) });
const policy = { designRepo: true, allowedTypes: ["markdown", "styles"], skillRoot: "skills", referenceRoots: ["assets"] };
const calls: string[] = [];
let nextRevision = revision;
let corruptStyle = false;
const publicFetch: typeof fetch = async (input, init) => {
	const url = new URL(String(input)); calls.push(url.href);
	assert.equal(init?.credentials, "omit"); assert.equal(init?.redirect, "error");
	const headers = new Headers(init.headers);
	for (const key of ["authorization", "cookie", "private-token"]) assert(!headers.has(key), "fallback never sends credentials");
	init.signal?.throwIfAborted();
	if (url.pathname.endsWith("/commits") && url.search === "?per_page=1") return Response.json(url.host === "api.github.com" ? [{ sha: nextRevision, commit: { tree: { sha: tree } } }] : [{ id: nextRevision }]);
	if (url.host === "api.github.com" && url.pathname.endsWith(`/git/trees/${tree}`) && url.search === "?recursive=1") return Response.json({ truncated: false, tree: files });
	if (url.pathname.endsWith("/repository/tree")) {
		assert.equal(url.searchParams.get("ref"), revision, "GitLab tree reads remain pinned to the resolved commit");
		return Response.json(files.map(({ sha, ...file }) => ({ ...file, id: sha })), { headers: { "x-next-page": "" } });
	}
	const blobMatch = url.pathname.match(/\/(?:git|repository)\/blobs\/([a-f0-9]{40})(?:\/raw)?$/);
	if (blobMatch) {
		const bytes = blobs.get(blobMatch[1]); assert(bytes, "only enumerated immutable blobs can be read");
		return new Response(new Uint8Array(corruptStyle && blobMatch[1] === oid(fileBytes.get("assets/brand.css")!) ? Buffer.from("corrupted blob") : bytes));
	}
	assert.fail(`Unexpected API request: ${url.href}`);
};

try {
	process.env.PATH = missingGit; process.env.EXXPERTS_STATE_HOME = path.join(fixture, "profile"); globalThis.fetch = publicFetch;
	for (const name of installRoots.keys()) delete process.env[name];
	assert.equal(await repositoryGitAvailable(), false, "the fixture must not find installed Git");
	const scan = await scanRepository(source, policy);
	assert.equal(scan.transport, "api"); assert.equal(scan.revision, revision);
	assert.deepEqual(scan.skills.map(({ name, path: skillPath, license }) => ({ name, path: skillPath, license })), [{ name: "brainstorm", path: "skills/brainstorm", license: "MIT" }]);
	assert.deepEqual(scan.skills[0].referencePaths?.sort(), ["assets/brand.css", "skills/brainstorm/references/notes.md"]);
	assert(!scan.files.find((file) => file.path === "danger/SKILL.md")?.allowed, "symlink manifests remain unavailable");
	const beforeBlockedPreview = calls.length;
	for (const file of ["assets/run.js", "assets/private.txt", "elsewhere/hidden.md"]) await assert.rejects(previewRepoFile(scan.token, file), /unsupported file type|not enabled|outside approved/);
	assert.equal(calls.length, beforeBlockedPreview, "excluded previews never request their blob bytes");
	await previewRepoFile(scan.token, "skills/brainstorm/SKILL.md");
	const featured = await loadFeaturedSource({ source: "https://github.com/fixture/featured", author: "fixture" });
	assert(!featured.error && featured.skills[0]?.name === "brainstorm", "featured public repositories work without Git using the same selective API pipeline");
	assert(!calls.some((url) => /\/archive\/|codeload\.github\.com/.test(url)), "no full repository archive is requested");
	for (const file of ["assets/run.js", "assets/logo.svg", "assets/logo.png", "assets/private.txt", "elsewhere/hidden.md"]) assert(!calls.some((url) => url.endsWith(`/git/blobs/${oid(fileBytes.get(file)!)}`)), "metadata discovery does not download unselected files or binaries");
	nextRevision = "3".repeat(40);
	const candidate = await fetchRepoCandidate(scan.token, "skills/brainstorm", ["assets/brand.css", "skills/brainstorm/references/notes.md"]);
	assert.equal(candidate.revision, revision); assert.equal(digest(Buffer.from(candidate.manifest)), digest(fileBytes.get("skills/brainstorm/SKILL.md")!));
	assert.deepEqual(candidate.references.map(({ path: file, sha256 }) => ({ file, sha256 })), ["assets/brand.css", "skills/brainstorm/references/notes.md"].map((file) => ({ file, sha256: digest(fileBytes.get(file)!) })));
	const downloaded = await readRepoReference(scan.token, "skills/brainstorm", "assets/brand.css");
	assert.deepEqual(downloaded.bytes, fileBytes.get("assets/brand.css"));
	const beforeCachedRead = calls.length;
	assert.deepEqual((await readRepositoryMaterial(scan.token, "assets/brand.css")).bytes, fileBytes.get("assets/brand.css"));
	const cached = await scanRepository(source, policy);
	assert.equal(cached.accessId, scan.accessId); assert.equal(cached.revision, revision); assert.notEqual(cached.token, scan.token);
	assert.equal(calls.length, beforeCachedRead, "repeated reference and scan reads reuse the same immutable snapshot");

	const privateAccess = grantRepositoryAccess(source, undefined, { ...anonymousRepositoryAccess(), mode: "session-token", provider: "github" }, "synthetic-session-token");
	const beforePrivate = calls.length;
	await assert.rejects(scanRepository(source, policy, undefined, false, { accessId: privateAccess.id }), { code: "GIT_REQUIRED" });
	await assert.rejects(scanRepository(source, policy, undefined, false, { accessId: privateAccess.id, token: scan.token }), /snapshot expired|access was removed|another source, branch or access context/);
	assert.equal(calls.length, beforePrivate, "private mode cannot fall back to the anonymous API or reuse an anonymous snapshot");
	await assert.rejects(readRepositoryMaterial(scan.token, "assets/brand.css"), /snapshot expired|access was removed/);
	const localAccess = grantRepositoryAccess(source, undefined, { ...anonymousRepositoryAccess(), mode: "local-git" });
	await assert.rejects(scanRepository(source, policy, undefined, false, { accessId: localAccess.id }), { code: "GIT_REQUIRED" });
	assert.equal(calls.length, beforePrivate);

	nextRevision = revision;
	const anonymous = await scanRepository(source, policy);
	assert.notEqual(anonymous.accessId, localAccess.id); assert.equal(anonymous.transport, "api");
	assert(calls.length > beforePrivate, "a new anonymous context must enumerate its own snapshot");
	const beforeModeMismatch = calls.length;
	await assert.rejects(scanRepository(source, policy, undefined, false, { accessId: localAccess.id, token: anonymous.token }), /another source, branch or access context/);
	assert.equal(calls.length, beforeModeMismatch, "a live local-Git context cannot reuse a live anonymous context's snapshot");
	const beforeRevoke = calls.length;
	revokeRepositoryAccess(source);
	await assert.rejects(readRepositoryMaterial(anonymous.token, "assets/brand.css"), /snapshot expired|access was removed/);
	assert.equal(calls.length, beforeRevoke, "revoked access cannot make another blob request");
	await assert.rejects(scanRepository(source, policy, undefined, false, { accessId: anonymous.accessId }), { code: "REPOSITORY_ACCESS_REQUIRED" });

	const gitlab = await scanRepository("https://gitlab.com/fixture/transport", policy);
	assert.equal(gitlab.transport, "api"); assert.equal(gitlab.revision, revision);
	assert.deepEqual(gitlab.skills, scan.skills, "GitHub and GitLab discover the same manifest and reference metadata");
	const gitlabCandidate = await fetchRepoCandidate(gitlab.token, "skills/brainstorm", ["assets/brand.css", "skills/brainstorm/references/notes.md"]);
	assert.equal(gitlabCandidate.manifest, candidate.manifest); assert.deepEqual(gitlabCandidate.references, candidate.references);
	assert.equal(repositoryScanFromToken(gitlab.token).revision, revision);
	const customSource = "https://gitlab.example.invalid/internal/git/fixture/transport";
	const customAccess = grantRepositoryAccess(customSource, undefined, { ...anonymousRepositoryAccess(), provider: "gitlab", apiBaseUrl: "https://gitlab.example.invalid/internal/git/api/v4" });
	assert.equal((await scanRepository(customSource, policy, undefined, false, { accessId: customAccess.id })).skills[0].name, "brainstorm");
	assert(calls.some((url) => url.startsWith("https://gitlab.example.invalid/internal/git/api/v4/projects/fixture%2Ftransport/")));
	const integrity = await scanRepository("https://github.com/fixture/integrity", policy);
	corruptStyle = true;
	await assert.rejects(readRepositoryMaterial(integrity.token, "assets/brand.css"), /integrity check/);
	corruptStyle = false;
	assert.deepEqual((await readRepositoryMaterial(integrity.token, "assets/brand.css")).bytes, fileBytes.get("assets/brand.css"), "a corrupted API response must not poison the byte cache");
	console.log("skills-repository-transport-smoke: OK (Git absent; synthetic anonymous APIs, immutable cache, private-mode isolation and revocation)");
} finally {
	globalThis.fetch = originalFetch;
	clearRepositoryAccess(); disposeAllCheckouts();
	if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
	if (originalState === undefined) delete process.env.EXXPERTS_STATE_HOME; else process.env.EXXPERTS_STATE_HOME = originalState;
	for (const [name, value] of installRoots) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
	fs.rmSync(fixture, { recursive: true, force: true });
}
