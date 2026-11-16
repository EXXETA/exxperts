import { spawn, spawnSync } from "node:child_process";
import fs, { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { registerOAuthProvider } from "@exxeta/exxperts-ai/oauth";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { clearConfigValueCache } from "../src/core/resolve-config-value.js";
import { SettingsManager } from "../src/core/settings-manager.js";

describe("AuthStorage", () => {
	let tempDir: string;
	let authJsonPath: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-auth-storage-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		authJsonPath = join(tempDir, "auth.json");
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
		clearConfigValueCache();
		vi.restoreAllMocks();
	});

	function writeAuthJson(data: Record<string, unknown>) {
		writeFileSync(authJsonPath, JSON.stringify(data));
	}

	function toShPath(value: string): string {
		return value.replace(/\\/g, "/").replace(/"/g, '\\"');
	}

	describe("API key resolution", () => {
		test("literal API key is returned directly", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "sk-ant-literal-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("sk-ant-literal-key");
		});

		test("apiKey with ! prefix executes command and uses stdout", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo test-api-key-from-command" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("test-api-key-from-command");
		});

		test("apiKey with ! prefix trims whitespace from command output", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo '  spaced-key  '" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("spaced-key");
		});

		test("apiKey with ! prefix handles multiline output (uses trimmed result)", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!printf 'line1\\nline2'" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("line1\nline2");
		});

		test("apiKey with ! prefix returns undefined on command failure", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!exit 1" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey with ! prefix returns undefined on nonexistent command", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!nonexistent-command-12345" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey with ! prefix returns undefined on empty output", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!printf ''" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey as environment variable name resolves to env value", async () => {
			const originalEnv = process.env.TEST_AUTH_API_KEY_12345;
			process.env.TEST_AUTH_API_KEY_12345 = "env-api-key-value";

			try {
				writeAuthJson({
					anthropic: { type: "api_key", key: "TEST_AUTH_API_KEY_12345" },
				});

				authStorage = AuthStorage.create(authJsonPath);
				const apiKey = await authStorage.getApiKey("anthropic");

				expect(apiKey).toBe("env-api-key-value");
			} finally {
				if (originalEnv === undefined) {
					delete process.env.TEST_AUTH_API_KEY_12345;
				} else {
					process.env.TEST_AUTH_API_KEY_12345 = originalEnv;
				}
			}
		});

		test("apiKey as literal value is used directly when not an env var", async () => {
			// Make sure this isn't an env var
			delete process.env.literal_api_key_value;

			writeAuthJson({
				anthropic: { type: "api_key", key: "literal_api_key_value" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("literal_api_key_value");
		});

		test("apiKey command can use shell features like pipes", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo 'hello world' | tr ' ' '-'" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("hello-world");
		});

		describe("caching", () => {
			test("command is only executed once per process", async () => {
				// Use a command that writes to a file to count invocations
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeAuthJson({
					anthropic: { type: "api_key", key: command },
				});

				authStorage = AuthStorage.create(authJsonPath);

				// Call multiple times
				await authStorage.getApiKey("anthropic");
				await authStorage.getApiKey("anthropic");
				await authStorage.getApiKey("anthropic");

				// Command should have only run once
				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(1);
			});

			test("cache persists across AuthStorage instances", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeAuthJson({
					anthropic: { type: "api_key", key: command },
				});

				// Create multiple AuthStorage instances
				const storage1 = AuthStorage.create(authJsonPath);
				await storage1.getApiKey("anthropic");

				const storage2 = AuthStorage.create(authJsonPath);
				await storage2.getApiKey("anthropic");

				// Command should still have only run once
				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(1);
			});

			test("clearConfigValueCache allows command to run again", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeAuthJson({
					anthropic: { type: "api_key", key: command },
				});

				authStorage = AuthStorage.create(authJsonPath);
				await authStorage.getApiKey("anthropic");

				// Clear cache and call again
				clearConfigValueCache();
				await authStorage.getApiKey("anthropic");

				// Command should have run twice
				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(2);
			});

			test("different commands are cached separately", async () => {
				writeAuthJson({
					anthropic: { type: "api_key", key: "!echo key-anthropic" },
					openai: { type: "api_key", key: "!echo key-openai" },
				});

				authStorage = AuthStorage.create(authJsonPath);

				const keyA = await authStorage.getApiKey("anthropic");
				const keyB = await authStorage.getApiKey("openai");

				expect(keyA).toBe("key-anthropic");
				expect(keyB).toBe("key-openai");
			});

			test("failed commands are cached (not retried)", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; exit 1'`;
				writeAuthJson({
					anthropic: { type: "api_key", key: command },
				});

				authStorage = AuthStorage.create(authJsonPath);

				// Call multiple times - all should return undefined
				const key1 = await authStorage.getApiKey("anthropic");
				const key2 = await authStorage.getApiKey("anthropic");

				expect(key1).toBeUndefined();
				expect(key2).toBeUndefined();

				// Command should have only run once despite failures
				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(1);
			});

			test("environment variables are not cached (changes are picked up)", async () => {
				const envVarName = "TEST_AUTH_KEY_CACHE_TEST_98765";
				const originalEnv = process.env[envVarName];

				try {
					process.env[envVarName] = "first-value";

					writeAuthJson({
						anthropic: { type: "api_key", key: envVarName },
					});

					authStorage = AuthStorage.create(authJsonPath);

					const key1 = await authStorage.getApiKey("anthropic");
					expect(key1).toBe("first-value");

					// Change env var
					process.env[envVarName] = "second-value";

					const key2 = await authStorage.getApiKey("anthropic");
					expect(key2).toBe("second-value");
				} finally {
					if (originalEnv === undefined) {
						delete process.env[envVarName];
					} else {
						process.env[envVarName] = originalEnv;
					}
				}
			});
		});
	});

	describe("oauth lock compromise handling", () => {
		test("returns undefined on compromised lock and allows a later retry", async () => {
			const providerId = `test-oauth-provider-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			registerOAuthProvider({
				id: providerId,
				name: "Test OAuth Provider",
				async login() {
					throw new Error("Not used in this test");
				},
				async refreshToken(credentials) {
					return {
						...credentials,
						access: "refreshed-access-token",
						expires: Date.now() + 60_000,
					};
				},
				getApiKey(credentials) {
					return `Bearer ${credentials.access}`;
				},
			});

			writeAuthJson({
				[providerId]: {
					type: "oauth",
					refresh: "refresh-token",
					access: "expired-access-token",
					expires: Date.now() - 10_000,
				},
			});

			authStorage = AuthStorage.create(authJsonPath);

			const realLock = lockfile.lock.bind(lockfile);
			const lockSpy = vi.spyOn(lockfile, "lock");
			lockSpy.mockImplementationOnce(async (file, options) => {
				options?.onCompromised?.(new Error("Unable to update lock within the stale threshold"));
				return realLock(file, options);
			});

			const firstTry = await authStorage.getApiKey(providerId);
			expect(firstTry).toBeUndefined();

			lockSpy.mockRestore();

			const secondTry = await authStorage.getApiKey(providerId);
			expect(secondTry).toBe("Bearer refreshed-access-token");
		});
	});

	describe("a lock its holder left", () => {
		/** The pid of a process that has really ended. */
		const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;
		const lockOf = (file: string) => `${file}.lock`;
		const leaveLock = (file: string, owner: { pid: number; host?: string; run?: string }) =>
			writeFileSync(lockOf(file), JSON.stringify({ host: hostname(), run: "an-earlier-run", note: "tmp-1-1-a", ...owner }));

		function registerRefreshingProvider(): string {
			const providerId = `test-left-lock-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			registerOAuthProvider({
				id: providerId,
				name: "Test OAuth Provider",
				async login() {
					throw new Error("Not used in this test");
				},
				async refreshToken(credentials) {
					return { ...credentials, access: "refreshed-access-token", expires: Date.now() + 60_000 };
				},
				getApiKey: (credentials) => `Bearer ${credentials.access}`,
			});
			writeAuthJson({ [providerId]: { type: "oauth", refresh: "r", access: "old", expires: Date.now() - 10_000 } });
			return providerId;
		}

		test("a dead owner's lock is cleared on the sync path, with no failed read", () => {
			writeAuthJson({ anthropic: { type: "api_key", key: "sk-kept" } });
			leaveLock(authJsonPath, { pid: deadPid() });

			authStorage = AuthStorage.create(authJsonPath);

			expect(authStorage.drainErrors()).toEqual([]);
			expect(authStorage.get("anthropic")).toEqual({ type: "api_key", key: "sk-kept" });
			expect(existsSync(lockOf(authJsonPath))).toBe(false);
		});

		test("a dead owner's lock is cleared on the async path, with no wait", async () => {
			const providerId = registerRefreshingProvider();
			authStorage = AuthStorage.create(authJsonPath);
			leaveLock(authJsonPath, { pid: deadPid() });

			const started = Date.now();
			const key = await authStorage.getApiKey(providerId);

			expect(key).toBe("Bearer refreshed-access-token");
			expect(Date.now() - started).toBeLessThan(1_000);
		});

		test("this pid in another run is a dead owner: a container's server gets the same pid back", () => {
			writeAuthJson({ anthropic: { type: "api_key", key: "sk-kept" } });
			leaveLock(authJsonPath, { pid: process.pid });

			authStorage = AuthStorage.create(authJsonPath);

			expect(authStorage.drainErrors()).toEqual([]);
			expect(authStorage.get("anthropic")).toBeDefined();
		});

		test("a live owner's lock is never taken", async () => {
			writeAuthJson({ anthropic: { type: "api_key", key: "sk-kept" } });
			const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
			try {
				leaveLock(authJsonPath, { pid: holder.pid! });

				authStorage = AuthStorage.create(authJsonPath);

				expect(authStorage.drainErrors().map((error) => (error as NodeJS.ErrnoException).code)).toEqual(["ELOCKED"]);
				expect(JSON.parse(readFileSync(lockOf(authJsonPath), "utf-8")).pid).toBe(holder.pid);
			} finally {
				holder.kill("SIGKILL");
			}
		});

		test("a holder in this very run keeps its lock: a sync read beside its own refresh", async () => {
			const providerId = `test-own-lock-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			let finish: () => void = () => {};
			let refreshing: () => void = () => {};
			const begun = new Promise<void>((resolve) => {
				refreshing = resolve;
			});
			registerOAuthProvider({
				id: providerId,
				name: "Test OAuth Provider",
				async login() {
					throw new Error("Not used in this test");
				},
				async refreshToken(credentials) {
					refreshing();
					await new Promise<void>((resolve) => {
						finish = resolve;
					});
					return { ...credentials, access: "refreshed-access-token", expires: Date.now() + 60_000 };
				},
				getApiKey: (credentials) => `Bearer ${credentials.access}`,
			});
			writeAuthJson({ [providerId]: { type: "oauth", refresh: "r", access: "old", expires: Date.now() - 10_000 } });
			authStorage = AuthStorage.create(authJsonPath);
			const refresh = authStorage.getApiKey(providerId);
			await begun;

			const beside = AuthStorage.create(authJsonPath);

			expect(beside.drainErrors().map((error) => (error as NodeJS.ErrnoException).code)).toEqual(["ELOCKED"]);
			finish();
			expect(await refresh).toBe("Bearer refreshed-access-token");
		});

		test("another computer's lock waits for the stale rule, even with a pid that is dead here", () => {
			writeAuthJson({ anthropic: { type: "api_key", key: "sk-kept" } });
			leaveLock(authJsonPath, { pid: deadPid(), host: "another-computer" });

			authStorage = AuthStorage.create(authJsonPath);
			expect(authStorage.drainErrors().map((error) => (error as NodeJS.ErrnoException).code)).toEqual(["ELOCKED"]);

			const longAgo = new Date(Date.now() - 60_000);
			utimesSync(lockOf(authJsonPath), longAgo, longAgo);
			authStorage = AuthStorage.create(authJsonPath);
			expect(authStorage.drainErrors()).toEqual([]);
			expect(authStorage.get("anthropic")).toBeDefined();
		});

		test("a folder an older version left names no owner, so it waits for the stale rule", () => {
			writeAuthJson({ anthropic: { type: "api_key", key: "sk-kept" } });
			mkdirSync(lockOf(authJsonPath));

			authStorage = AuthStorage.create(authJsonPath);
			expect(authStorage.drainErrors().map((error) => (error as NodeJS.ErrnoException).code)).toEqual(["ELOCKED"]);

			const longAgo = new Date(Date.now() - 60_000);
			utimesSync(lockOf(authJsonPath), longAgo, longAgo);
			authStorage = AuthStorage.create(authJsonPath);
			expect(authStorage.drainErrors()).toEqual([]);
			expect(existsSync(lockOf(authJsonPath))).toBe(false);
		});

		test("while another clears a dead lock, a contender leaves it alone", () => {
			writeAuthJson({ anthropic: { type: "api_key", key: "sk-kept" } });
			leaveLock(authJsonPath, { pid: deadPid() });
			mkdirSync(`${lockOf(authJsonPath)}.lock`);

			authStorage = AuthStorage.create(authJsonPath);

			expect(authStorage.drainErrors().map((error) => (error as NodeJS.ErrnoException).code)).toEqual(["ELOCKED"]);
			expect(existsSync(lockOf(authJsonPath))).toBe(true);
		});

		test("on a disk with no hard links the lock is the plain folder, and works", () => {
			writeAuthJson({ anthropic: { type: "api_key", key: "sk-kept" } });
			vi.spyOn(fs, "linkSync").mockImplementation(() => {
				throw Object.assign(new Error("no hard links here"), { code: "EPERM" });
			});

			authStorage = AuthStorage.create(authJsonPath);
			authStorage.set("openai", { type: "api_key", key: "sk-new" });

			expect(authStorage.drainErrors()).toEqual([]);
			expect(JSON.parse(readFileSync(authJsonPath, "utf-8")).openai.key).toBe("sk-new");
			expect(existsSync(lockOf(authJsonPath))).toBe(false);
		});

		test("the same for settings.json: what is on disk reads at once and a save lands", () => {
			const settingsPath = join(tempDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ defaultThinkingLevel: "high" }));
			leaveLock(settingsPath, { pid: deadPid() });

			const settings = SettingsManager.create(tempDir, tempDir);

			expect(settings.drainErrors()).toEqual([]);
			expect(settings.getDefaultThinkingLevel()).toBe("high");

			leaveLock(settingsPath, { pid: deadPid() });
			settings.setDefaultThinkingLevel("low");
			return settings.flush().then(() => {
				expect(settings.drainErrors()).toEqual([]);
				expect(JSON.parse(readFileSync(settingsPath, "utf-8")).defaultThinkingLevel).toBe("low");
			});
		});
	});

	describe("persistence semantics", () => {
		test("set preserves unrelated external edits", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "old-anthropic" },
				openai: { type: "api_key", key: "openai-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);

			// Simulate external edit while process is running
			writeAuthJson({
				anthropic: { type: "api_key", key: "old-anthropic" },
				openai: { type: "api_key", key: "openai-key" },
				google: { type: "api_key", key: "google-key" },
			});

			authStorage.set("anthropic", { type: "api_key", key: "new-anthropic" });

			const updated = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, { key: string }>;
			expect(updated.anthropic.key).toBe("new-anthropic");
			expect(updated.openai.key).toBe("openai-key");
			expect(updated.google.key).toBe("google-key");
		});

		test("remove preserves unrelated external edits", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
				openai: { type: "api_key", key: "openai-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);

			// Simulate external edit while process is running
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
				openai: { type: "api_key", key: "openai-key" },
				google: { type: "api_key", key: "google-key" },
			});

			authStorage.remove("anthropic");

			const updated = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, { key: string }>;
			expect(updated.anthropic).toBeUndefined();
			expect(updated.openai.key).toBe("openai-key");
			expect(updated.google.key).toBe("google-key");
		});

		test("does not overwrite malformed auth file after load error", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			writeFileSync(authJsonPath, "{invalid-json", "utf-8");

			authStorage.reload();
			authStorage.set("openai", { type: "api_key", key: "openai-key" });

			const raw = readFileSync(authJsonPath, "utf-8");
			expect(raw).toBe("{invalid-json");
		});

		test("reload records parse errors and drainErrors clears buffer", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			writeFileSync(authJsonPath, "{invalid-json", "utf-8");

			authStorage.reload();

			// Keeps previous in-memory data on reload failure
			expect(authStorage.get("anthropic")).toEqual({ type: "api_key", key: "anthropic-key" });

			const firstDrain = authStorage.drainErrors();
			expect(firstDrain.length).toBeGreaterThan(0);
			expect(firstDrain[0]).toBeInstanceOf(Error);

			const secondDrain = authStorage.drainErrors();
			expect(secondDrain).toHaveLength(0);
		});
	});

	describe("auth status", () => {
		test("does not expose stored API keys or OAuth tokens", () => {
			authStorage = AuthStorage.inMemory({
				anthropic: { type: "api_key", key: "secret-api-key" },
				openai: {
					type: "oauth",
					access: "secret-access-token",
					refresh: "secret-refresh-token",
					expires: Date.now() + 1000,
				},
			});

			expect(authStorage.getAuthStatus("anthropic")).toEqual({ configured: true, source: "stored" });
			expect(authStorage.getAuthStatus("openai")).toEqual({ configured: true, source: "stored" });
			expect(JSON.stringify(authStorage.getAuthStatus("anthropic"))).not.toContain("secret-api-key");
			expect(JSON.stringify(authStorage.getAuthStatus("openai"))).not.toContain("secret-access-token");
			expect(JSON.stringify(authStorage.getAuthStatus("openai"))).not.toContain("secret-refresh-token");
		});

		test("reports runtime override as configured without exposing the runtime key", () => {
			authStorage = AuthStorage.inMemory();
			authStorage.setRuntimeApiKey("anthropic", "secret-runtime-key");

			const status = authStorage.getAuthStatus("anthropic");

			expect(status).toEqual({ configured: true, source: "runtime", label: "--api-key" });
			expect(JSON.stringify(status)).not.toContain("secret-runtime-key");
		});

		test("reports present environment variables as configured without exposing the env value", () => {
			const originalEnv = process.env.OPENAI_API_KEY;

			try {
				process.env.OPENAI_API_KEY = "secret-env-key";
				authStorage = AuthStorage.inMemory();

				const status = authStorage.getAuthStatus("openai");

				expect(status).toEqual({ configured: true, source: "environment", label: "OPENAI_API_KEY" });
				expect(JSON.stringify(status)).not.toContain("secret-env-key");
			} finally {
				if (originalEnv === undefined) {
					delete process.env.OPENAI_API_KEY;
				} else {
					process.env.OPENAI_API_KEY = originalEnv;
				}
			}
		});

		test("reports fallback resolver values as configured without exposing the fallback secret", () => {
			authStorage = AuthStorage.inMemory();
			authStorage.setFallbackResolver((provider) =>
				provider === "custom-provider" ? "secret-fallback-key" : undefined,
			);

			const status = authStorage.getAuthStatus("custom-provider");

			expect(status).toEqual({ configured: true, source: "fallback", label: "custom provider config" });
			expect(JSON.stringify(status)).not.toContain("secret-fallback-key");
		});
	});

	describe("runtime overrides", () => {
		test("runtime override takes priority over auth.json", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo stored-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			authStorage.setRuntimeApiKey("anthropic", "runtime-key");

			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("runtime-key");
		});

		test("removing runtime override falls back to auth.json", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo stored-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			authStorage.setRuntimeApiKey("anthropic", "runtime-key");
			authStorage.removeRuntimeApiKey("anthropic");

			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("stored-key");
		});
	});
});
