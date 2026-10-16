import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { productAppStateRoot } from "../../../pi-package/product-state-paths.js";

export interface RepositoryAccessSettings {
	mode: "anonymous" | "local-git" | "session-token";
	rememberLocalAccess: boolean;
	checkOnStartup: boolean;
	consentVersion: 1;
	provider?: "github" | "gitlab";
	apiBaseUrl?: string;
}
export interface RepositoryAccessContext {
	confirmed: boolean;
	id: string;
	source: string;
	libraryId?: string;
	settings: RepositoryAccessSettings;
	controller: AbortController;
	token?: string;
}
const contexts = new Map<string, RepositoryAccessContext>();
const revoked = new Set<(context: RepositoryAccessContext) => void>();
let profile = productAppStateRoot();
export const anonymousRepositoryAccess = (): RepositoryAccessSettings => ({ mode: "anonymous", rememberLocalAccess: false, checkOnStartup: false, consentVersion: 1 });
export function repositoryAccessError(message = "Repository access needs your confirmation."): Error {
	return Object.assign(new Error(message), { code: "REPOSITORY_ACCESS_REQUIRED", statusCode: 403 });
}
export function normalizeRepositoryAccess(value: unknown): RepositoryAccessSettings | undefined {
	if (value === undefined) return undefined;
	const input = value as Partial<RepositoryAccessSettings> | null;
	if (!input || input.consentVersion !== 1 || !["anonymous", "local-git", "session-token"].includes(input.mode!)) throw new Error("Invalid repository access settings.");
	if (input.rememberLocalAccess !== undefined && typeof input.rememberLocalAccess !== "boolean" || input.checkOnStartup !== undefined && typeof input.checkOnStartup !== "boolean") throw new Error("Repository access choices must be boolean.");
	if (input.provider !== undefined && input.provider !== "github" && input.provider !== "gitlab") throw new Error("Choose GitHub or GitLab.");
	let apiBaseUrl: string | undefined;
	if (input.apiBaseUrl !== undefined && typeof input.apiBaseUrl !== "string") throw new Error("API base URL must be text.");
	if (input.apiBaseUrl) {
		const url = new URL(input.apiBaseUrl);
		if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !url.pathname.replace(/\/$/, "").endsWith("/api/v4")) throw new Error("Use the GitLab instance's HTTPS API base URL ending in /api/v4, without credentials.");
		apiBaseUrl = url.href.replace(/\/$/, "");
	}
	return { mode: input.mode!, rememberLocalAccess: input.mode === "local-git" && input.rememberLocalAccess === true, checkOnStartup: input.checkOnStartup === true, consentVersion: 1, ...(input.provider ? { provider: input.provider } : {}), ...(apiBaseUrl ? { apiBaseUrl } : {}) };
}
export function repositoryAccessSource(source: string): string {
	const value = source.split("#")[0];
	try { const url = new URL(value); url.hash = ""; url.pathname = url.pathname.replace(/\/+$/, "").replace(/\.git$/, ""); return url.href; }
	catch { return value.startsWith("git@") ? value.replace(/\.git$/, "") : path.resolve(value); }
}
function syncProfile(): void {
	if (profile !== productAppStateRoot()) { clearRepositoryAccess(); profile = productAppStateRoot(); }
}
export function onRepositoryAccessRevoked(listener: (context: RepositoryAccessContext) => void): void { revoked.add(listener); }
function discard(context: RepositoryAccessContext): void {
	context.token = undefined;
	context.controller.abort(); contexts.delete(context.id);
	for (const listener of revoked) listener(context);
}
export function clearRepositoryAccess(): void { for (const context of [...contexts.values()]) discard(context); }
export function revokeRepositoryAccess(source: string, libraryId?: string): void {
	syncProfile();
	for (const context of [...contexts.values()]) if (context.source === repositoryAccessSource(source) && context.libraryId === libraryId) discard(context);
}
function create(source: string, libraryId: string | undefined, settings: RepositoryAccessSettings, token?: string, confirmed = true): RepositoryAccessContext {
	const context = { id: crypto.randomUUID(), source: repositoryAccessSource(source), libraryId, settings, token, confirmed, controller: new AbortController() };
	contexts.set(context.id, context); return context;
}
export function grantRepositoryAccess(source: string, libraryId: string | undefined, raw: unknown, token?: unknown): RepositoryAccessContext {
	syncProfile();
	const settings = normalizeRepositoryAccess(raw)!;
	if (!settings) throw new Error("Choose repository access.");
	if (settings.mode === "session-token" && token === undefined) token = [...contexts.values()].find((context) => context.source === repositoryAccessSource(source) && context.libraryId === libraryId && context.settings.mode === "session-token")?.token;
	if (settings.mode === "session-token" && (typeof token !== "string" || !token.trim() || token.length > 8192 || /[\r\n\0]/.test(token))) throw new Error("Enter a personal access token for this session.");
	if (settings.mode === "session-token" && !source.startsWith("https://")) throw new Error("Session tokens require an HTTPS repository address.");
	revokeRepositoryAccess(source, libraryId);
	return create(source, libraryId, settings, settings.mode === "session-token" ? (token as string).trim() : undefined);
}
export function resolveRepositoryAccess(source: string, libraryId?: string, settings?: RepositoryAccessSettings, accessId?: string): RepositoryAccessContext {
	syncProfile();
	const canonical = repositoryAccessSource(source);
	if (accessId !== undefined) {
		const context = contexts.get(accessId);
		if (!context || context.source !== canonical || context.libraryId !== libraryId || context.controller.signal.aborted) throw repositoryAccessError("Repository access expired or belongs to another source. Confirm access again.");
		return context;
	}
	const desired = settings ?? anonymousRepositoryAccess();
	const existing = [...contexts.values()].find((context) => context.source === canonical && context.libraryId === libraryId && context.settings.mode === desired.mode && (libraryId !== undefined || desired.mode === "anonymous"));
	if (existing) return existing;
	if (desired.mode === "session-token" || desired.mode === "local-git" && !desired.rememberLocalAccess) throw repositoryAccessError("This repository's session access has ended. Confirm access or enter a session token again.");
	return create(source, libraryId, desired, undefined, settings !== undefined);
}
export function assertRepositoryAccess(context: RepositoryAccessContext): void {
	syncProfile();
	if (context.controller.signal.aborted || contexts.get(context.id) !== context) throw repositoryAccessError("Repository access was removed. Confirm access again.");
}
export function repositoryTokenGit(context: RepositoryAccessContext): { args: string[]; env: NodeJS.ProcessEnv } {
	assertRepositoryAccess(context);
	if (context.settings.mode !== "session-token" || !context.token) throw repositoryAccessError();
	const username = context.settings.provider === "gitlab" || /gitlab/i.test(context.source) ? "oauth2" : "x-access-token";
	const url = new URL(context.source);
	const literal = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
	const bound = `https|${url.host}|${url.pathname.slice(1)}`;
	const helper = `!f() { test "$1" = get || return 0; while IFS='=' read -r key value && test -n "$key"; do case "$key" in protocol) protocol=$value;; host) host=$value;; path) path=$value;; esac; done; case "$protocol|$host|$path" in ${literal(bound)}|${literal(bound + ".git")}) printf 'username=${username}\\npassword=%s\\n' "$EXXPERTS_REPOSITORY_TOKEN";; esac; }; f`;
	return { args: ["-c", "credential.helper=", "-c", "credential.useHttpPath=true", "-c", `credential.helper=${helper}`, "-c", "http.followRedirects=false"], env: { EXXPERTS_REPOSITORY_TOKEN: context.token } };
}
/** Git for Windows may be installed after the app inherited its PATH. */
export function resolveGitCommand(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = fs.existsSync): string {
	if (platform !== "win32") return "git";
	const onPath = (env.PATH ?? env.Path ?? "").split(";").some((directory) => directory.trim() && exists(path.win32.join(directory.trim(), "git.exe")));
	if (onPath) return "git";
	const candidates = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, "Programs")]
		.filter((root): root is string => Boolean(root)).map((root) => path.win32.join(root, "Git", "cmd", "git.exe"));
	return candidates.find((candidate) => exists(candidate)) ?? "git";
}

export function gitMissingMessage(platform: NodeJS.Platform = process.platform): string {
	if (platform === "darwin") return "Private or local repository access needs Apple's command line tools. Install them on this Mac, then try again. Supported public HTTPS repositories can use the anonymous API.";
	if (platform === "win32") return "Private or local repository access needs Git. Install Git for Windows from gitforwindows.org, then try again. Supported public HTTPS repositories can use the anonymous API.";
	return "Private or local repository access needs Git. Install it with your system's software manager, then try again. Supported public HTTPS repositories can use the anonymous API.";
}

export function repositoryGitAvailable(): Promise<boolean> {
	return new Promise((resolve) => {
		const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "/dev/null" : os.devNull };
		delete env.GIT_CONFIG_PARAMETERS; delete env.GIT_CONFIG_COUNT;
		const child = spawn(resolveGitCommand(process.platform, env), ["--version"], { cwd: os.tmpdir(), env, stdio: "ignore", windowsHide: true });
		const timer = setTimeout(() => { child.kill(); resolve(false); }, 5000);
		child.once("error", () => { clearTimeout(timer); resolve(false); });
		child.once("close", (code) => { clearTimeout(timer); resolve(code === 0); });
	});
}
