// A room whose last answer is still stopping says so in plain words, in every
// place the server refuses for it: Home's banner after leaving the room, after
// opening it, the Archive or delete pane
// and Home's banner when it is archived or deleted from inside, and the
// message sent meanwhile. Nowhere is the server's own error text shown.
//
// The turn is a real one: a real server, a gateway that begins an answer and
// never ends it, and a preload only this smoke writes, which holds the Stop of
// a running answer open, so the server's turn stays cancelling. Two states no
// page reaches by itself are set up: a stopping conversation parked on disk
// (the server itself refuses to open it), and an empty prepared
// conversation with a turn in it (the smoke answers that one request as the
// server does).
//
// A room with no answer running, beside it, is left, opened and archived with
// no line at all.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, type Page } from "playwright";
import { homeTurnRunningLine, isTurnRunningRefusal, removalTurnRunningLine, ROOM_TURN_RUNNING_LINE, TURN_RUNNING_LINE } from "../../web-ui/src/turn-running-words.js";
import { SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, authedFetch, freePort, smokeHomeEnv, stopSmokeServer, waitForServer, withoutSignInTokens } from "./smoke-server-process.js";
import { sendFromBox, waitEvery } from "./smoke-wait.js";

const waitUntil = waitEvery(150);

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const failures: string[] = [];
async function row(id: string, what: string, body: () => Promise<void>): Promise<void> {
	try {
		await body();
		console.log(`ok ${id}: ${what}`);
	} catch (error) {
		failures.push(`${id}: ${what}: ${(error as Error).message}`);
		console.error(`FAIL ${id}: ${what}: ${(error as Error).message}`);
	}
}

// The words themselves, by hand: every other row imports them.
await row("W", "the sentences are these", async () => {
	assert(TURN_RUNNING_LINE === "The last answer is still finishing; send your message in a moment.", `the message's line: ${TURN_RUNNING_LINE}`);
	assert(ROOM_TURN_RUNNING_LINE === "The last answer in this room is still finishing. Try again when it's done.", `the room's line: ${ROOM_TURN_RUNNING_LINE}`);
	assert(homeTurnRunningLine("Harbor") === "The last answer in Harbor is still finishing. Open the room again when it's done.", `Home's line: ${homeTurnRunningLine("Harbor")}`);
	assert(homeTurnRunningLine("") === "The last answer in this room is still finishing. Open the room again when it's done.", `Home's line for a room with no name: ${homeTurnRunningLine("")}`);
	assert(removalTurnRunningLine("archived", "Harbor") === "Harbor wasn't archived: its last answer is still finishing. Try again when it's done.", `Home's line for archiving: ${removalTurnRunningLine("archived", "Harbor")}`);
	assert(removalTurnRunningLine("deleted") === "This room wasn't deleted: its last answer is still finishing. Try again when it's done.", `the pane's line for deleting: ${removalTurnRunningLine("deleted")}`);
	assert(isTurnRunningRefusal("turn_running") && isTurnRunningRefusal("turn_in_flight"), "the server's code and archive's reason are known");
	for (const other of ["room_lock", "detached_cooking", "specialist_running", "conversation_moved", undefined, null]) assert(!isTurnRunningRefusal(other), `another refusal (${String(other)}) keeps its own words`);
});

const chromiumPath = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
if (!chromiumPath || !fs.existsSync(chromiumPath)) {
	console.log("turn stopping words smoke: the page's rows skipped (Chromium not installed)");
	process.exit(failures.length ? 1 : 0);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-turn-stopping-"));
const tempHome = path.join(tempRoot, "home");
const appDir = path.join(tempHome, ".exxperts", "app");
const agentsRoot = path.join(appDir, "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

/** A message with this word gets the first words of an answer and no end. */
const HELD = "[held]";
const FIRST_WORDS = "The first words of the answer.";

const gateway = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		const body = JSON.parse(raw || "{}");
		const frame = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
		const base = { id: "cmpl_stopping", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model };
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		frame({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: FIRST_WORDS }, finish_reason: null }] });
		if (raw.includes(HELD)) return;
		frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

// The server's own words: none of them may be on screen.
const SERVER_WORDS = /activeThread|runtime boundar|is cancelling|response in flight|\(409\)/;

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];

try {
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	const gatewayPort = (gateway.address() as AddressInfo).port;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "fake-gpt": { name: "Fake GPT", baseUrl: `http://127.0.0.1:${gatewayPort}/v1`, api: "openai-completions", models: [{ id: "gpt-fake", name: "GPT Fake", input: ["text"], contextWindow: 128000, maxTokens: 16000 }] } } }), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "fake-gpt": { type: "api_key", key: "synthetic-gpt" } }), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [{ id: "custom-fake-gpt", providerId: "fake-gpt", label: "Fake GPT", roomModels: ["gpt-fake"], learnModel: "gpt-fake", reviewMemoryModel: "gpt-fake" }] }), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "custom-fake-gpt" }), { mode: 0o600 });
	const preload = path.join(tempRoot, "held-stop-preload.mjs");
	fs.writeFileSync(preload, `const { AgentSession } = await import(${JSON.stringify(import.meta.resolve("@exxeta/exxperts-runtime"))});
const abort = AgentSession.prototype.abort;
AgentSession.prototype.abort = function (...args) { return this.isStreaming ? new Promise(() => {}) : abort.apply(this, args); };
`);

	const agents = await import("../src/persistent-agents.js");
	const roomModels = await import("../src/room-models.js");
	const makeRoom = (displayName: string): string => {
		const { agentId } = agents.createPersistentAgentFromScaffoldInput({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent;
		roomModels.writeRoomModels(agentId, { conversation: { provider: "fake-gpt", model: "gpt-fake" } });
		return agentId;
	};
	const harbor = makeRoom("Harbor");
	const meadow = makeRoom("Meadow");
	makeRoom("Quiet");

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${pathToFileURL(preload).href}`.trim() }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server, baseUrl, { tries: 400 });

	type Status = { id: string; activeLock?: unknown; runtime: { state: string; activeThreadId: string | null }; activeThread?: { threadId: string; inFlight?: boolean; cancelling?: boolean } | null };
	const statusOf = async (id: string): Promise<Status> => {
		const status = (await authedFetch(`${baseUrl}/api/persistent-agents`).then((r) => r.json()) as Status[]).find((candidate) => candidate.id === id);
		assert(status, `the server lists ${id}`);
		return status;
	};
	const lockFree = (id: string) => waitUntil(async () => !(await statusOf(id)).activeLock, `${id}'s lock is free`);

	const browser = await chromium.launch();
	try {
		const page: Page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
		await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		const card = (name: string) => page.locator(".persistent-agent-card").filter({ hasText: name });
		const door = (name: string) => card(name).getByRole("button", { name: /^(Enter|Resume)$/ });
		const alert = page.locator(".home-resume-error");
		await card("Harbor").waitFor({ timeout: 20_000 });
		const dismiss = page.locator(".whats-new-close");
		if (await dismiss.count()) await dismiss.click();

		const openRoom = async (name: string) => {
			await waitUntil(() => door(name).isEnabled(), `${name} is offered`);
			await door(name).click();
			await page.locator(".topbar-actions").getByRole("button", { name: "Room settings", exact: true }).waitFor({ timeout: 15_000 });
		};
		const send = async (text: string) => {
			await page.locator("textarea").first().fill(text);
			await sendFromBox(page);
		};
		const answered = async (name: string) => {
			await page.getByText(FIRST_WORDS).last().waitFor({ timeout: 20_000 });
			await waitUntil(async () => (await page.locator(".stop-btn").count()) === 0, `${name}'s answer has ended`);
		};
		const leave = async (name: string) => {
			await page.goBack();
			await card(name).waitFor({ timeout: 15_000 });
		};
		const says = async (where: ReturnType<Page["locator"]>, words: string) => {
			await waitUntil(async () => (await where.count()) > 0, "a line shows");
			const read = (await where.first().innerText()).trim();
			assert(read === words, `the line reads ${JSON.stringify(read)}, not ${JSON.stringify(words)}`);
			const screen = await page.locator("body").innerText();
			assert(!SERVER_WORDS.test(screen), `the screen shows the server's own words: ${JSON.stringify(SERVER_WORDS.exec(screen)?.[0])}`);
		};
		const openDanger = async (from: ReturnType<Page["locator"]>) => {
			await from.getByRole("button", { name: "Room settings", exact: true }).click();
			await page.getByRole("button", { name: "Archive or delete" }).click();
			await page.locator(".room-danger-zone").waitFor();
		};
		const archive = () => page.locator(".room-danger-zone").getByRole("button", { name: "Archive", exact: true }).click();
		const remove = async (name: string) => {
			await page.locator(".room-danger-zone").getByRole("button", { name: "Delete room", exact: true }).click();
			await page.getByRole("alertdialog", { name: `Delete ${name}?` }).getByRole("button", { name: "Delete room", exact: true }).click();
		};
		const closeSettings = async () => {
			await page.keyboard.press("Escape");
			await page.locator(".settings-dialog").waitFor({ state: "detached" });
		};
		// The conversation's state on disk, as the server reads it: a parked conversation with a turn in it is refused at the door.
		const setThreadState = (id: string, threadId: string, state: "active" | "standby") => {
			const file = agents.createPersistentAgentInstance(id).runtimeThreadPath(threadId);
			fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), state }, null, 2));
		};

		// The neighbour first: a room with no answer running is left and opened with no line.
		await row("N1", "a room whose answer has ended is left and opened again with no line", async () => {
			await openRoom("Quiet");
			await send("A question.");
			await answered("Quiet");
			await leave("Quiet");
			await waitUntil(() => door("Quiet").isEnabled(), "Quiet is offered again");
			assert(await alert.count() === 0, `leaving says nothing, got ${JSON.stringify(await alert.allInnerTexts())}`);
			await openRoom("Quiet");
			await leave("Quiet");
			assert(await alert.count() === 0, "opening it again says nothing");
		});

		await openRoom("Harbor");
		await send(`A question ${HELD}`);
		await page.getByText(FIRST_WORDS).first().waitFor({ timeout: 20_000 });
		await page.locator(".stop-btn").first().click();
		await waitUntil(async () => (await statusOf(harbor)).activeThread?.cancelling === true, "Harbor's answer is stopping");
		const threadId = (await statusOf(harbor)).activeThread!.threadId;

		await row("L", "leaving the room: Home's banner", async () => {
			await leave("Harbor");
			await says(alert, homeTurnRunningLine("Harbor"));
		});
		await lockFree(harbor);

		for (const [id, removal, press] of [["A1", "archived", archive], ["D1", "deleted", () => remove("Harbor")]] as const) {
			await row(id, `${removal} from Home: the pane`, async () => {
				await openDanger(card("Harbor"));
				try {
					await press();
					await says(page.locator(".room-danger-zone .workspaces-error"), removalTurnRunningLine(removal));
				} finally {
					await closeSettings();
				}
			});
		}

		await row("R", "opening it while it is parked: Home's banner", async () => {
			// Leaving says the same line: a fresh page has none.
			await page.reload();
			await card("Harbor").waitFor({ timeout: 20_000 });
			assert(await alert.count() === 0, "a fresh Home says nothing");
			setThreadState(harbor, threadId, "standby");
			try {
				await door("Harbor").click();
				await says(alert, homeTurnRunningLine("Harbor"));
			} finally {
				setThreadState(harbor, threadId, "active");
			}
		});

		await row("S", "a message sent in it: the line in the conversation, the message back in the box", async () => {
			await openRoom("Harbor");
			await send("Another question.");
			await says(page.getByText(TURN_RUNNING_LINE), TURN_RUNNING_LINE);
			await waitUntil(async () => (await page.locator("textarea").first().inputValue()) === "Another question.", "the message is back in the box");
		});

		await row("A2", "archiving it from inside: Home's banner", async () => {
			await openDanger(page.locator(".topbar-actions"));
			await archive();
			await says(alert, removalTurnRunningLine("archived", "Harbor"));
		});
		await row("D2", "deleting it from inside: Home's banner", async () => {
			await lockFree(harbor);
			await openRoom("Harbor");
			await openDanger(page.locator(".topbar-actions"));
			await remove("Harbor");
			await says(alert, removalTurnRunningLine("deleted", "Harbor"));
			assert((await statusOf(harbor)).activeThread?.cancelling === true, "Harbor is still there, still stopping");
		});

		// Meadow's conversation after a Forget: empty, and prepared by the server.
		const refuseDiscard = async (body: () => Promise<void>) => {
			const discard = `**/api/persistent-agents/${meadow}/runtime/discard-empty-prepared-boundary`;
			await page.route(discard, (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: `persistent-agent activeThread is cancelling; stop it or wait for completion before changing runtime boundaries: ${meadow}/postmem_1`, code: "turn_running" }) }));
			try {
				await body();
			} finally {
				await page.unroute(discard);
			}
		};
		await row("P1", "opening the room on it by its address: Home's banner", async () => {
			await openRoom("Meadow");
			await send("A question.");
			await answered("Meadow");
			await leave("Meadow");
			await lockFree(meadow);
			const forgot = await authedFetch(`${baseUrl}/api/persistent-agents/${meadow}/memento`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: (await statusOf(meadow)).runtime.activeThreadId }) });
			assert(forgot.ok, `Forget prepares Meadow's next conversation, got ${forgot.status}`);
			await page.reload();
			await card("Meadow").waitFor({ timeout: 20_000 });
			await refuseDiscard(async () => {
				await page.evaluate((id) => { window.location.hash = `#/room/${id}`; }, meadow);
				await says(alert, homeTurnRunningLine("Meadow"));
			});
		});
		await row("P2", "leaving it: Home's banner", async () => {
			await page.goto(`${baseUrl}/`);
			await openRoom("Meadow");
			await refuseDiscard(async () => {
				await leave("Meadow");
				await says(alert, homeTurnRunningLine("Meadow"));
			});
		});

		await row("N2", "a room with no answer running is archived", async () => {
			await openDanger(card("Quiet"));
			await archive();
			await card("Quiet").waitFor({ state: "detached", timeout: 15_000 });
		});
	} finally {
		await browser.close();
	}
} catch (error) {
	console.error(withoutSignInTokens(serverOutput.join("")).slice(-6000));
	throw error;
} finally {
	try { (gateway as any).closeAllConnections?.(); } catch {}
	try { gateway.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}

if (failures.length) {
	console.error(`turn stopping words smoke: ${failures.length} failed`);
	process.exit(1);
}
console.log("turn stopping words smoke: ok");
