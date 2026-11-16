// One turn's box: the sandbox library's proxy, in a small process of its own,
// because the library's network rules are per process and a room has its own
// sites. The server forks this file on a turn's first command and stops it when
// the turn ends, so each turn gets a fresh port and token.
//
// The server builds every rule. This process only hands them to the library and
// asks the server about each site.
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";

const pendingAsks = new Map();
let nextAsk = 1;

/** Sends one message; a server that went away ends this process through `disconnect`. */
function tell(message) {
	if (process.connected) process.send(message);
}

/** The library's ask callback. Every site reaches it: the library's own list stays empty, so the server's check always runs. */
function askServer({ host, port }) {
	return new Promise((resolve) => {
		const id = nextAsk++;
		pendingAsks.set(id, resolve);
		tell({ type: "ask", id, host, port });
	});
}

// The library's line for a dial it refused on the name's address: `deny network-outbound <host>:<port> (resolved to <class> / <class>)`.
// Its words come from the library's resolved-address guard: a library update reruns the Auto rows of room-box-smoke.ts, since a reworded line drops the reason the model reads.
const DIAL_REFUSED = /^deny network-outbound (.+):(\d+) \(resolved to (.+)\)$/;
let violationsSeen = 0;

/**
 * Tells the server each site the library refused at the dial, after a yes, by
 * the address the name led to, with the classes it named, so the model can
 * learn why. Told before the command reads the refusal: the library notes it
 * first. The store hands over its newest entries, up to its own limit.
 */
function tellDialRefusals() {
	const store = SandboxManager.getSandboxViolationStore();
	store.subscribe((violations) => {
		const total = store.getTotalCount();
		const fresh = violations.slice(Math.max(0, violations.length - (total - violationsSeen)));
		violationsSeen = total;
		for (const { line } of fresh) {
			const refused = DIAL_REFUSED.exec(line);
			if (refused) tell({ type: "refused", host: refused[1], port: Number(refused[2]), classes: refused[3].split(" / ") });
		}
	});
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
// The library's NO_PROXY sends local addresses straight out, where the kernel
// refuses them and the command learns nothing. Past the proxy nothing local is
// reachable either way, and through it the model is told why. `env` keeps the last.
const LOCAL_THROUGH_PROXY = "NO_PROXY= no_proxy=";

/**
 * The library's wrapped command with our rules at the end of its profile, where
 * they win. The wrapped text is `env ... /usr/bin/sandbox-exec -p '<profile>' ...`
 * in the library's own quoting, a quote inside being `'"'"'`. A shape that isn't
 * that throws, and the server stops the command: it never runs without the rules.
 */
function withProfileRules(wrapped, rules) {
	const head = `${SANDBOX_EXEC} -p '`;
	const start = wrapped.indexOf(head);
	if (start < 0) throw new Error("the library's wrapped command has no sandbox profile");
	let end = wrapped.indexOf("'", start + head.length);
	while (end >= 0 && wrapped.startsWith(`'"'"'`, end)) end = wrapped.indexOf("'", end + 5);
	if (end < 0) throw new Error("the library's sandbox profile has no end");
	return `${wrapped.slice(0, end)}\n${rules.replaceAll("'", `'"'"'`)}\n${wrapped.slice(end)}`;
}

/** Ends the proxy: every command this box started loses the network from here on. */
async function closeNetwork() {
	for (const resolve of pendingAsks.values()) resolve(false);
	pendingAsks.clear();
	await SandboxManager.reset().catch(() => {});
}

const handlers = {
	/** `deniedResolvedAddresses`: what a name may not lead to beyond the library's own set, the ranges of a room on Auto; for the whole turn. */
	async start({ temp, deniedResolvedAddresses }) {
		// The library reads the private temp's name from here when it builds a command's TMPDIR.
		process.env.CLAUDE_CODE_TMPDIR = temp;
		await SandboxManager.initialize(
			{ network: { allowedDomains: [], deniedDomains: [], ...(deniedResolvedAddresses.length > 0 ? { deniedResolvedAddresses } : {}) }, filesystem: { denyRead: [], allowWrite: [], denyWrite: [], allowGitConfig: true } },
			askServer,
			false,
		);
		tellDialRefusals();
		return {};
	},
	async wrap({ command, filesystem, profileRules }) {
		const wrapped = await SandboxManager.wrapWithSandbox(command, "/bin/bash", { filesystem });
		// The shell that starts this text is outside the box, so the library's bare `env` can't come from PATH, where a folder a command writes may sit.
		if (!wrapped.startsWith("env ")) throw new Error("the sandbox library's command changed shape");
		return { wrapped: `/usr/bin/${withProfileRules(wrapped, profileRules).replace(SANDBOX_EXEC, `${LOCAL_THROUGH_PROXY} ${SANDBOX_EXEC}`)}` };
	},
	closeNetwork,
	/** Answers after every refusal noted so far has been told: messages to the server keep their order. */
	async settle() {
		return {};
	},
};

process.on("message", async (message) => {
	if (message.op === "answer") {
		pendingAsks.get(message.id)?.(message.allow ? true : { allow: false, reason: message.reason });
		pendingAsks.delete(message.id);
		return;
	}
	if (message.op === "stop") {
		await closeNetwork();
		process.exit(0);
	}
	try {
		tell({ type: "reply", id: message.id, ok: true, value: await handlers[message.op](message) });
	} catch (error) {
		tell({ type: "reply", id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
	}
});

// A server that dies takes its boxes with it.
process.on("disconnect", () => {
	void closeNetwork().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
	void closeNetwork().finally(() => process.exit(0));
});

tell({ type: "booted" });
