import assert from "node:assert/strict";
import { loadPublicRepository } from "../src/skills-repo-public-api.js";

const revision = "a".repeat(40), rootTree = "b".repeat(40), blob = "c".repeat(40), subtree = "d".repeat(40);
const json = (value: unknown, headers?: HeadersInit) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json", ...headers } });
const githubCommit = { sha: revision, commit: { tree: { sha: rootTree } } };
const entry = (path: string, mode = "100644", type = "blob", sha = blob) => ({ path, mode, type, sha });
function transport(routes: Record<string, () => Response | Promise<Response>>) {
	const calls: string[] = [];
	const fetcher: typeof fetch = async (input, init) => {
		const url = String(input); calls.push(url);
		assert.equal(init?.method, "GET"); assert.equal(init?.credentials, "omit"); assert.equal(init?.redirect, "error");
		const headers = new Headers(init.headers);
		for (const name of ["authorization", "private-token", "cookie"]) assert(!headers.has(name), "API fallback must remain anonymous");
		assert(init.signal); init.signal.throwIfAborted();
		assert(routes[url], `unexpected API request: ${url}`);
		return routes[url]();
	};
	return { fetcher, calls };
}
const githubBase = "https://api.github.com/repos/example/skills";
const standard = (tree: unknown[]) => ({
	[`${githubBase}/commits?per_page=1`]: () => json([githubCommit]),
	[`${githubBase}/git/trees/${rootTree}?recursive=1`]: () => json({ tree, truncated: false }),
});
const github = transport({
	...standard([entry("SKILL.md"), entry("link", "120000"), entry("module", "160000", "commit")]),
	[`${githubBase}/git/blobs/${blob}`]: () => new Response("# Skill"),
});
const repository = await loadPublicRepository({ cloneArg: "https://github.com/example/skills.git" }, {}, undefined, github.fetcher);
assert.equal(repository.revision, revision); assert.equal(repository.files.length, 3);
assert.equal((await repository.readBlob(repository.files[0], 100)).toString(), "# Skill");
for (const file of repository.files.slice(1)) await assert.rejects(repository.readBlob(file, 100), /Symlinks, submodules/);
await assert.rejects(repository.readBlob({ ...repository.files[0], oid: rootTree }, 100), /does not belong/);
repository.files[0].oid = rootTree;
await assert.rejects(repository.readBlob(repository.files[0], 100), /does not belong/);
repository.files[0].oid = blob;
await assert.rejects(repository.readBlob(repository.files[0], 2), /permitted size/);
const scanDeadline = new AbortController();
const laterRead = await loadPublicRepository({ cloneArg: "https://github.com/example/skills" }, {}, scanDeadline.signal, github.fetcher);
scanDeadline.abort();
assert.equal((await laterRead.readBlob(laterRead.files[0], 100, new AbortController().signal)).toString(), "# Skill", "a later blob read has its own budget after the original scan deadline");
const readAccess = new AbortController(); readAccess.abort();
await assert.rejects(laterRead.readBlob(laterRead.files[0], 100, readAccess.signal), { name: "AbortError" });
assert(github.calls.slice(1).every((url) => !url.includes("/HEAD") && !url.includes("ref=main")), "all metadata and blobs use immutable IDs after commit resolution");

const truncated = transport({
	[`${githubBase}/commits/feature%2Fdesign`]: () => json(githubCommit),
	[`${githubBase}/git/trees/${rootTree}?recursive=1`]: () => json({ tree: [entry("incomplete.md")], truncated: true }),
	[`${githubBase}/git/trees/${rootTree}`]: () => json({ tree: [entry("skills", "040000", "tree", subtree), entry("LICENSE")], truncated: false }),
	[`${githubBase}/git/trees/${subtree}`]: () => json({ tree: [entry("SKILL.md")], truncated: false }),
});
const complete = await loadPublicRepository({ cloneArg: "https://github.com/example/skills", ref: "feature/design" }, {}, undefined, truncated.fetcher);
assert.deepEqual(complete.files.map((file) => file.path), ["LICENSE", "skills/SKILL.md"]);

const gitlabBase = "https://gitlab.example.invalid/team/git/api/v4/projects/group%2Fsubgroup%2Fdesign";
const gitlabEntry = (path: string, mode = "100644", type = "blob") => ({ path, mode, type, id: blob });
const gitlab = transport({
	[`${gitlabBase}/repository/commits/main`]: () => json({ id: revision }),
	[`${gitlabBase}/repository/tree?recursive=true&per_page=100&page=1&ref=${revision}`]: () => json([gitlabEntry("skills", "040000", "tree"), gitlabEntry("skills/SKILL.md")], { "x-next-page": "2" }),
	[`${gitlabBase}/repository/tree?recursive=true&per_page=100&page=2&ref=${revision}`]: () => json([gitlabEntry("shared/brand.css"), gitlabEntry("link", "120000"), gitlabEntry("module", "160000", "commit")], { "x-next-page": "" }),
	[`${gitlabBase}/repository/blobs/${blob}/raw`]: () => new Response("body {}"),
});
const design = await loadPublicRepository({ cloneArg: "https://gitlab.example.invalid/team/git/group/subgroup/design.git", ref: "main" }, { provider: "gitlab", apiBaseUrl: "https://gitlab.example.invalid/team/git/api/v4/" }, undefined, gitlab.fetcher);
assert.equal(design.revision, revision);
assert.deepEqual(design.files.map((file) => file.path), ["skills/SKILL.md", "shared/brand.css", "link", "module"]);
assert.equal((await design.readBlob(design.files[1], 100)).toString(), "body {}");

const gitlabPublic = "https://gitlab.com/api/v4/projects/example%2Fskills";
const noPaginationHeaders = transport({
	[`${gitlabPublic}/repository/commits?per_page=1`]: () => json([{ id: revision }]),
	[`${gitlabPublic}/repository/tree?recursive=true&per_page=100&page=1&ref=${revision}`]: () => json(Array.from({ length: 100 }, (_, index) => gitlabEntry(`file-${index}.md`))),
	[`${gitlabPublic}/repository/tree?recursive=true&per_page=100&page=2&ref=${revision}`]: () => json([]),
});
assert.equal((await loadPublicRepository({ cloneArg: "https://gitlab.com/example/skills" }, {}, undefined, noPaginationHeaders.fetcher)).files.length, 100);

for (const source of ["https://token@github.com/example/skills", "https://github.com/example/skills?token=bad", "http://github.com/example/skills", "ssh://git@github.com/example/skills"]) await assert.rejects(loadPublicRepository({ cloneArg: source }, {}, undefined, github.fetcher), /HTTPS/);
await assert.rejects(loadPublicRepository({ cloneArg: "https://example.invalid/group/skills" }, {}, undefined, github.fetcher), /explicitly configured/);
await assert.rejects(loadPublicRepository({ cloneArg: "https://gitlab.example.invalid/other/group/skills" }, { provider: "gitlab", apiBaseUrl: "https://gitlab.example.invalid/team/git/api/v4" }, undefined, github.fetcher), /instance subpath/);
await assert.rejects(loadPublicRepository({ cloneArg: "https://gitlab.example.invalid/group/skills" }, { provider: "gitlab", apiBaseUrl: "https://attacker.invalid/api/v4" }, undefined, github.fetcher), /HTTPS origin/);

for (const status of [401, 403, 404]) {
	const denied = transport({ [`${githubBase}/commits?per_page=1`]: () => new Response("private", { status }) });
	await assert.rejects(loadPublicRepository({ cloneArg: "https://github.com/example/skills" }, {}, undefined, denied.fetcher), { code: "REPOSITORY_AUTH_REQUIRED", statusCode: 403 });
}
for (const [status, headers] of [[429, {}], [403, { "x-ratelimit-remaining": "0" }], [403, { "retry-after": "60" }]] as const) {
	const limited = transport({ [`${githubBase}/commits?per_page=1`]: () => new Response("limited", { status, headers }) });
	await assert.rejects(loadPublicRepository({ cloneArg: "https://github.com/example/skills" }, {}, undefined, limited.fetcher), { code: "REPOSITORY_API_RATE_LIMIT", statusCode: 429 });
}
const secondaryLimit = transport({ [`${githubBase}/commits?per_page=1`]: () => json({ message: "You have exceeded a secondary rate limit." }) });
const secondaryFetcher: typeof fetch = async (input, init) => new Response((await secondaryLimit.fetcher(input, init)).body, { status: 403 });
await assert.rejects(loadPublicRepository({ cloneArg: "https://github.com/example/skills" }, {}, undefined, secondaryFetcher), { code: "REPOSITORY_API_RATE_LIMIT" });
const redirect = transport({ [`${githubBase}/commits?per_page=1`]: () => new Response(null, { status: 302, headers: { location: "https://attacker.invalid/private" } }) });
await assert.rejects(loadPublicRepository({ cloneArg: "https://github.com/example/skills" }, {}, undefined, redirect.fetcher), /HTTP 302/);
assert.equal(redirect.calls.length, 1, "redirect destinations are never followed");
const malformed = transport(standard([entry("../outside.md")]));
await assert.rejects(loadPublicRepository({ cloneArg: "https://github.com/example/skills" }, {}, undefined, malformed.fetcher), /unsafe file path/);
const excessive = transport(standard(Array.from({ length: 20_001 }, (_, index) => entry(`file-${index}.md`))));
await assert.rejects(loadPublicRepository({ cloneArg: "https://github.com/example/skills" }, {}, undefined, excessive.fetcher), /20,000/);
const oversized = transport({ [`${githubBase}/commits?per_page=1`]: () => new Response("{}", { headers: { "content-length": String(9 * 1024 * 1024) } }) });
await assert.rejects(loadPublicRepository({ cloneArg: "https://github.com/example/skills" }, {}, undefined, oversized.fetcher), /permitted size/);
const streamed = transport({ ...standard([entry("SKILL.md")]), [`${githubBase}/git/blobs/${blob}`]: () => new Response(new ReadableStream({ start(stream) { stream.enqueue(Buffer.from("123")); stream.enqueue(Buffer.from("456")); stream.close(); } })) });
const streamedRepository = await loadPublicRepository({ cloneArg: "https://github.com/example/skills" }, {}, undefined, streamed.fetcher);
await assert.rejects(streamedRepository.readBlob(streamedRepository.files[0], 5), /permitted size/);
const controller = new AbortController(); controller.abort();
await assert.rejects(loadPublicRepository({ cloneArg: "https://github.com/example/skills" }, {}, controller.signal, github.fetcher), { name: "AbortError" });
const abortDuringFetch = new AbortController();
const delayed: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => { init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }); queueMicrotask(() => abortDuringFetch.abort()); });
await assert.rejects(loadPublicRepository({ cloneArg: "https://github.com/example/skills" }, {}, abortDuringFetch.signal, delayed), { name: "AbortError" });

console.log("skills-repo-public-api-smoke: OK (anonymous synthetic GitHub/GitLab fixtures only)");
