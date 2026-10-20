import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { credentialSectionApplies, readGitConfigListing, resolveRepoSource, signInArgsFromConfigListing } from "./skills-repo-fetch.js";
import { resolveGitCommand } from "./skills-repository-access.js";

type Provider = "github" | "gitlab";
interface Command { args: string[]; env?: NodeJS.ProcessEnv; input?: string; signal?: AbortSignal; timeoutMs?: number }
type Run = (command: Command) => Promise<boolean>;
const DOCUMENTATION = "https://github.com/git-ecosystem/git-credential-manager/blob/main/docs/gitlab.md";

/** stdout can contain a credential: discard both streams instead of collecting or logging them. */
async function runManager({ args, env = process.env, input, signal, timeoutMs = 5000 }: Command): Promise<boolean> {
	if (signal?.aborted) throw new Error("Repository sign-in cancelled.");
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-repository-auth-"));
	try {
		return await new Promise<boolean>((resolve, reject) => {
			const clean = { ...env };
			for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "SSLKEYLOGFILE", "GIT_CURL_VERBOSE"]) delete clean[key];
			for (const key of Object.keys(clean)) if (key.startsWith("GIT_TRACE")) clean[key] = "0";
			Object.assign(clean, { GCM_TRACE: "0", GCM_TRACE_SECRETS: "0", GCM_TRACE_MSAUTH: "0", GCM_DEBUG: "0", GIT_TRACE: "0" });
			const child = spawn(resolveGitCommand(process.platform, clean), ["credential-manager", ...args], { cwd, env: clean, stdio: ["pipe", "ignore", "ignore"], detached: process.platform !== "win32" });
			let failure: string | undefined;
			const stop = (message: string) => {
				if (failure) return;
				failure = message;
				clearTimeout(timer); signal?.removeEventListener("abort", cancel);
				if (child.pid) {
					if (process.platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).once("error", () => child.kill());
					else { try { process.kill(-child.pid, "SIGTERM"); } catch {} }
				}
				child.stdin.destroy();
				reject(new Error(message));
			};
			const cancel = () => stop("Repository sign-in cancelled.");
			const timer = setTimeout(() => stop("Repository sign-in timed out. Finish or cancel the browser page, then try again."), timeoutMs);
			signal?.addEventListener("abort", cancel, { once: true });
			child.stdin.on("error", () => {});
			child.stdin.end(input ?? "");
			const finish = (ok: boolean) => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); if (!failure) resolve(ok); };
			child.once("error", () => finish(false));
			child.once("close", (code) => finish(code === 0));
			if (signal?.aborted) cancel();
		});
	} finally { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {} }
}

function target(source: unknown): URL {
	if (typeof source !== "string") throw new Error("Repository address is required.");
	const resolved = resolveRepoSource(source);
	if (!resolved.ok) throw new Error(resolved.error);
	if (resolved.value.kind !== "git" || resolved.value.cloneArg !== resolved.value.display) throw new Error("Use a repository HTTPS address without credentials for browser sign-in.");
	const url = new URL(resolved.value.cloneArg);
	if (url.protocol !== "https:") throw new Error("Browser sign-in requires an HTTPS repository address. SSH keys are managed separately.");
	return url;
}

function settings(listing: string, url: URL): Map<string, string> {
	const result = new Map<string, string>();
	const fields = listing.split("\0");
	for (let i = 0; i + 1 < fields.length; i += 2) {
		if (!["system", "unknown", "global"].includes(fields[i])) continue;
		const split = fields[i + 1].indexOf("\n");
		const key = split < 0 ? fields[i + 1] : fields[i + 1].slice(0, split);
		const match = key.match(/^credential\.(?:(.+)\.)?([^.]+)$/);
		if (match && (!match[1] || credentialSectionApplies(match[1], url))) result.set(match[2], split < 0 ? "" : fields[i + 1].slice(split + 1));
	}
	return result;
}

export interface RepositorySignInStatus {
	host: string;
	provider: Provider | null;
	ready: boolean;
	issues: string[];
	setupCommands: string[];
	documentation: string;
}

/** Only explicit local login requests reach this service; scans never call it. */
export class RepositorySignIn {
	private active = false;
	private controller: AbortController | null = null;
	constructor(private run: Run = runManager, private readConfig = readGitConfigListing) {}
	cancel(): void { this.controller?.abort(); }
	async status(source: unknown, requested?: unknown): Promise<RepositorySignInStatus> {
		const url = target(source);
		if (requested !== undefined && requested !== "github" && requested !== "gitlab") throw new Error("Choose GitHub or GitLab.");
		const listing = await this.readConfig();
		const config = settings(listing, url);
		const known = url.hostname === "github.com" ? "github" : url.hostname === "gitlab.com" ? "gitlab" : undefined;
		if (known && requested && requested !== known) throw new Error("The selected provider does not match this repository host.");
		const configured = config.get("provider");
		const candidate = known ?? requested ?? (configured === "github" || configured === "gitlab" ? configured : undefined) ?? (/gitlab/i.test(url.hostname) ? "gitlab" : /github/i.test(url.hostname) ? "github" : undefined);
		const provider = candidate === "github" || candidate === "gitlab" ? candidate : null;
		const issues: string[] = [];
		const setupCommands: string[] = [];
		if (!await this.run({ args: ["--version"] })) { issues.push("Git Credential Manager is missing. Install it with Git for Windows or from its official distribution."); }
		if (!signInArgsFromConfigListing(listing, url.href).some((arg) => arg.includes("credential-manager"))) {
			issues.push("Configure Git Credential Manager as a Git credential helper before signing in."); setupCommands.push("git credential-manager configure");
		}
		if (!provider) issues.push("Choose the provider used by this repository host.");
		if (!known && provider && configured !== provider) {
			issues.push(`Configure this host's ${provider === "gitlab" ? "GitLab" : "GitHub"} provider so ordinary repository requests reuse the browser sign-in.`);
			setupCommands.push(`git config --global credential.${url.origin}.provider ${provider}`);
		}
		const store = process.env.GCM_CREDENTIAL_STORE || config.get("credentialstore");
		if (store && !["wincredman", "dpapi", "keychain", "secretservice", "gpg"].includes(store.toLowerCase())) issues.push("Configure a protected credential store; plaintext, cache and disabled stores are not used for this login.");
		if (!store && process.platform === "linux") { issues.push("Choose a protected credential store for Git Credential Manager on Linux."); setupCommands.push("git config --global credential.credentialStore secretservice"); }
		if (provider === "gitlab" && url.hostname !== "gitlab.com" && (!config.get("gitlabdevclientid") || !config.get("gitlabdevclientsecret"))) {
			issues.push("This GitLab instance needs its own OAuth application: non-confidential, redirect URI http://127.0.0.1/, scopes read_repository and write_repository. Ask your GitLab administrator to register or approve it, then configure this computer.");
			setupCommands.push(`git config --global credential.${url.origin}.gitLabDevClientId <APPLICATION_ID>`, `git config --global credential.${url.origin}.gitLabDevClientSecret <APPLICATION_SECRET>`);
		}
		return { host: url.host, provider, ready: issues.length === 0, issues, setupCommands, documentation: provider === "gitlab" ? DOCUMENTATION : "https://github.com/git-ecosystem/git-credential-manager" };
	}
	async login(source: unknown, provider: unknown, signal?: AbortSignal, allowCredentialStorage = false): Promise<void> {
		if (allowCredentialStorage !== true) throw Object.assign(new Error("Confirm that Git Credential Manager may save this sign-in in the system credential store, shared with other Git applications."), { code: "REPOSITORY_ACCESS_REQUIRED", statusCode: 403 });
		if (this.active) throw Object.assign(new Error("A repository sign-in is already in progress. Finish or cancel it first."), { statusCode: 409 });
		this.active = true;
		const controller = new AbortController(); this.controller = controller;
		const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
		try {
			const status = await this.status(source, provider);
			if (!status.ready || !status.provider) throw new Error(status.issues.join(" "));
			const url = target(source);
			const env = { ...process.env, GCM_INTERACTIVE: "true", GCM_GUI_PROMPT: "true", GIT_TERMINAL_PROMPT: "0", GCM_PROVIDER: status.provider, GCM_GITHUB_AUTHMODES: "browser", GCM_GITLAB_AUTHMODES: "browser" };
			// GitLab get stores fresh OAuth tokens itself; stdout must never leave GCM.
			const command = status.provider === "github" ? { args: ["github", "login", "--url", url.origin, "--browser", "--force"] } : { args: ["get"], input: `protocol=https\nhost=${url.host}\npath=${url.pathname.slice(1)}\nusername=oauth2\n\n` };
			if (combined.aborted) throw new Error("Repository sign-in cancelled.");
			if (!await this.run({ ...command, env, signal: combined, timeoutMs: 300000 })) throw new Error("Browser sign-in did not complete. It may have been cancelled, denied or blocked by the provider. Check the host configuration and try again.");
		} finally { this.active = false; this.controller = null; }
	}
}
