/** Anonymous API fallback. Only metadata is enumerated; callers still apply the import file policy. */
export interface PublicRepositoryTreeFile { path: string; mode: string; oid: string }
export interface PublicRepository {
	revision: string;
	files: PublicRepositoryTreeFile[];
	readBlob(file: PublicRepositoryTreeFile, maxBytes: number, signal?: AbortSignal): Promise<Buffer>;
}

type Provider = "github" | "gitlab";
type Fetch = typeof fetch;
const MAX_ENTRIES = 20_000;
const MAX_REQUESTS = 512;
const METADATA_BYTES = 8 * 1024 * 1024;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const fileModes = new Set(["100644", "100755", "120000", "160000"]);

function failure(message: string, code = "REPOSITORY_API_FAILED", statusCode = 502): Error {
	return Object.assign(new Error(message), { code, statusCode });
}

function httpsUrl(raw: string): URL {
	let url: URL;
	try { url = new URL(raw); } catch { throw failure("A valid HTTPS repository URL is required.", "REPOSITORY_API_UNSUPPORTED", 400); }
	if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw failure("Anonymous API access requires an HTTPS URL without credentials, query parameters or fragments.", "REPOSITORY_API_UNSUPPORTED", 400);
	return url;
}

function target(source: { cloneArg: string; ref?: string }, config: { provider?: Provider; apiBaseUrl?: string }): { provider: Provider; base: string } {
	const url = httpsUrl(source.cloneArg);
	const known = url.hostname === "github.com" ? "github" : url.hostname === "gitlab.com" ? "gitlab" : undefined;
	const provider = config.provider ?? known;
	if ((provider !== "github" && provider !== "gitlab") || (known && known !== provider) || (provider === "github" && (url.origin !== "https://github.com" || config.apiBaseUrl))) throw failure("Anonymous API fallback supports GitHub.com, GitLab.com and explicitly configured GitLab instances.", "REPOSITORY_API_UNSUPPORTED", 400);
	let api = provider === "github" ? new URL("https://api.github.com") : new URL("https://gitlab.com/api/v4");
	if (provider === "gitlab") {
		if (!known && !config.apiBaseUrl) throw failure("Set the GitLab API base URL, including any instance subpath, to use anonymous API fallback.", "REPOSITORY_API_UNSUPPORTED", 400);
		if (config.apiBaseUrl) api = httpsUrl(config.apiBaseUrl);
		if (api.origin !== url.origin || !/\/api\/v4\/?$/.test(api.pathname)) throw failure("The GitLab API base URL must use this repository's HTTPS origin and end in /api/v4.", "REPOSITORY_API_UNSUPPORTED", 400);
	}
	const prefix = provider === "gitlab" ? api.pathname.replace(/\/api\/v4\/?$/, "") : "";
	if (!url.pathname.startsWith(`${prefix}/`)) throw failure("The repository is outside the configured GitLab instance subpath.", "REPOSITORY_API_UNSUPPORTED", 400);
	let parts: string[];
	try { parts = url.pathname.slice(prefix.length + 1).replace(/\/$/, "").replace(/\.git$/, "").split("/").map(decodeURIComponent); } catch { throw failure("Invalid encoded repository path.", "REPOSITORY_API_UNSUPPORTED", 400); }
	if (parts.length < 2 || (provider === "github" && parts.length !== 2) || parts.some((part) => !part || part === "." || part === ".." || /[\\/\x00-\x20\x7f]/.test(part))) throw failure("Expected a repository path with namespace and repository name.", "REPOSITORY_API_UNSUPPORTED", 400);
	if (source.ref !== undefined && (!source.ref || source.ref.length > 2048 || /[\x00-\x20\x7f]/.test(source.ref))) throw failure("Invalid repository ref.", "REPOSITORY_API_UNSUPPORTED", 400);
	const base = provider === "github" ? `${api.origin}/repos/${parts.map(encodeURIComponent).join("/")}` : `${api.href.replace(/\/$/, "")}/projects/${encodeURIComponent(parts.join("/"))}`;
	return { provider, base };
}

async function boundedBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
	const declared = response.headers.get("content-length");
	if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) { await response.body?.cancel(); throw failure("Repository API response exceeds the permitted size.", "REPOSITORY_API_LIMIT", 413); }
	if (!response.body) return Buffer.alloc(0);
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			signal.throwIfAborted();
			const part = await reader.read();
			if (part.done) break;
			size += part.value.byteLength;
			if (size > maxBytes) throw failure("Repository API response exceeds the permitted size.", "REPOSITORY_API_LIMIT", 413);
			chunks.push(part.value);
		}
		return Buffer.concat(chunks, size);
	} finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** The optional fetch argument exists for deterministic, credential-free transport tests. */
export async function loadPublicRepository(source: { cloneArg: string; ref?: string }, config: { provider?: Provider; apiBaseUrl?: string } = {}, signal?: AbortSignal, fetcher: Fetch = fetch): Promise<PublicRepository> {
	const { provider, base } = target(source, config);
	const enumerationSignal = AbortSignal.any([AbortSignal.timeout(90_000), ...(signal ? [signal] : [])]);
	let requests = 0;
	const request = async (suffix: string, maxBytes: number, requestSignal: AbortSignal, raw = false): Promise<{ bytes: Buffer; headers: Headers }> => {
		requestSignal.throwIfAborted();
		let response: Response;
		try {
			response = await fetcher(`${base}${suffix}`, {
				method: "GET", credentials: "omit", redirect: "error", signal: requestSignal,
				headers: { Accept: raw && provider === "github" ? "application/vnd.github.raw+json" : "application/json", "User-Agent": "EXXPERTS-public-repository" },
			});
		} catch (error) {
			requestSignal.throwIfAborted();
			throw failure("The anonymous repository API could not be reached. Check the network, certificate and repository URL.");
		}
		if (!response.ok) {
			let limited = response.status === 429 || (response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")));
			if (response.status === 403 && !limited) {
				try { limited = /(?:secondary |api )?rate limit/i.test((await boundedBody(response, 16 * 1024, requestSignal)).toString("utf8")); } catch { requestSignal.throwIfAborted(); }
			} else await response.body?.cancel();
			if (limited) throw failure("The anonymous repository API rate limit was reached. Retry later; no local sign-in was used.", "REPOSITORY_API_RATE_LIMIT", 429);
			if (response.status === 401 || response.status === 403 || response.status === 404) throw failure("The repository or ref is not publicly accessible. Check its URL and permissions, or explicitly choose a private repository sign-in.", "REPOSITORY_AUTH_REQUIRED", 403);
			throw failure(`The anonymous repository API returned HTTP ${response.status}.`);
		}
		return { bytes: await boundedBody(response, maxBytes, requestSignal), headers: response.headers };
	};
	const json = async (suffix: string): Promise<{ value: any; headers: Headers }> => {
		if (++requests > MAX_REQUESTS) throw failure("Repository API enumeration exceeds the request limit. Choose a smaller repository or use Git.", "REPOSITORY_API_LIMIT", 413);
		const result = await request(suffix, METADATA_BYTES, enumerationSignal);
		try { return { value: JSON.parse(result.bytes.toString("utf8")), headers: result.headers }; } catch { throw failure("The repository API returned invalid JSON."); }
	};
	const commitSuffix = source.ref ? `${provider === "github" ? "/commits/" : "/repository/commits/"}${encodeURIComponent(source.ref)}` : `${provider === "github" ? "/commits" : "/repository/commits"}?per_page=1`;
	const commitResult = (await json(commitSuffix)).value;
	const commit = source.ref ? commitResult : Array.isArray(commitResult) ? commitResult[0] : undefined;
	const revision = provider === "github" ? commit?.sha : commit?.id;
	if (typeof revision !== "string" || !SHA.test(revision)) throw failure("The repository API did not return a full commit ID. The repository may be empty.");
	const files: PublicRepositoryTreeFile[] = [];
	const paths = new Set<string>();
	let entries = 0;
	const add = (entry: any, prefix = "", singleName = false): { path: string; oid: string } | undefined => {
		if (++entries > MAX_ENTRIES) throw failure("Repository API file tree exceeds 20,000 entries. Choose a smaller repository or use Git.", "REPOSITORY_API_LIMIT", 413);
		if (!entry || typeof entry.path !== "string" || !entry.path || entry.path.length > 4096 || /[\\\x00-\x1f\x7f]/.test(entry.path) || entry.path.split("/").some((part: string) => !part || part === "." || part === "..") || (singleName && entry.path.includes("/"))) throw failure("The repository API returned an unsafe file path.");
		const fullPath = prefix + entry.path;
		if (fullPath.length > 4096 || fullPath.split("/").length > 128 || paths.has(fullPath)) throw failure("The repository API returned a duplicate or overly deep file path.");
		paths.add(fullPath);
		const oid = provider === "github" ? entry.sha : entry.id;
		if (typeof oid !== "string" || !SHA.test(oid)) throw failure("The repository API returned an invalid object ID.");
		if (entry.type === "tree" && entry.mode === "040000") return { path: fullPath, oid };
		if (!fileModes.has(entry.mode) || ((entry.type !== "blob") && !(entry.type === "commit" && entry.mode === "160000"))) throw failure("The repository API returned an unsupported file entry.");
		files.push({ path: fullPath, mode: entry.mode, oid });
		return undefined;
	};
	if (provider === "github") {
		const rootTree = commit?.commit?.tree?.sha;
		if (typeof rootTree !== "string" || !SHA.test(rootTree)) throw failure("The repository API did not return a valid commit tree.");
		const recursive = (await json(`/git/trees/${rootTree}?recursive=1`)).value;
		if (!Array.isArray(recursive?.tree) || typeof recursive.truncated !== "boolean") throw failure("The repository API returned an invalid tree.");
		if (!recursive.truncated) recursive.tree.forEach((entry: unknown) => add(entry));
		else {
			// GitHub's recursive tree can truncate; enumerate immutable subtrees instead of accepting missing files.
			const queue = [{ path: "", oid: rootTree }];
			for (let index = 0; index < queue.length; index++) {
				const node = queue[index];
				const result = (await json(`/git/trees/${node.oid}`)).value;
				if (!Array.isArray(result?.tree) || result.truncated !== false) throw failure("The repository API returned an incomplete directory. Use Git for this repository.", "REPOSITORY_API_LIMIT", 413);
				for (const entry of result.tree) {
					const directory = add(entry, node.path ? `${node.path}/` : "", true);
					if (directory) queue.push(directory);
				}
			}
		}
	} else {
		for (let page = 1; ; page++) {
			const result = await json(`/repository/tree?recursive=true&per_page=100&page=${page}&ref=${revision}`);
			if (!Array.isArray(result.value)) throw failure("The repository API returned an invalid tree.");
			result.value.forEach((entry: unknown) => add(entry));
			const nextPage = result.headers.get("x-next-page");
			if (nextPage !== null) {
				if (nextPage === "") break;
				if (nextPage !== String(page + 1)) throw failure("The repository API returned inconsistent pagination.");
			} else if (result.value.length < 100) break;
		}
	}
	const knownFiles = new Map(files.map((file) => [file.path, { ...file }]));
	return {
		revision, files,
		async readBlob(file, maxBytes, readSignal) {
			if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw failure("Invalid repository blob size limit.", "REPOSITORY_API_LIMIT", 400);
			const known = knownFiles.get(file.path);
			if (!known || known.oid !== file.oid || known.mode !== file.mode) throw failure("This file does not belong to the reviewed repository tree.", "REPOSITORY_API_FAILED", 400);
			if (file.mode !== "100644" && file.mode !== "100755") throw failure("Symlinks, submodules and special entries are not permitted.", "REPOSITORY_API_FAILED", 400);
			const combined = AbortSignal.any([AbortSignal.timeout(30_000), ...(readSignal ? [readSignal] : [])]);
			return (await request(`${provider === "github" ? "/git/blobs/" : "/repository/blobs/"}${file.oid}${provider === "gitlab" ? "/raw" : ""}`, maxBytes, combined, true)).bytes;
		},
	};
}
