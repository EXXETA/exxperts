import { stateProfileLoginHome, stateProfileRealHome, stateProfiles } from "./server-install-root.js";
import { app } from "./server-app.js";

// Data profiles: which state tree this computer runs. The standard profile
// is always ~/.exxperts (never renamed, never deletable, has no name);
// switching just updates the pointer and restarts the server, and the
// supervisor (the exxperts launcher, desktop shell, dev harness) reads the
// pointer on every start and points the server's env at the profile.
function stateProfilePayload() {
	const home = stateProfileRealHome();
	const active = stateProfiles.readActiveProfile(home);
	return {
		active,
		profiles: stateProfiles.listProfiles(home).filter((p) => p.name !== active),
		home: stateHomePayload(),
	};
}

// The exxperts home: where the whole state family (standard tree + profiles)
// lives, and whether the in-app move is available. Moving needs a supervisor
// that executes the recorded move between server legs, and is refused while
// EXXPERTS_DATA_DIR pins the location: the operator owns it then.
function stateHomePayload() {
	const loginHome = stateProfileLoginHome();
	let source: "env" | "setting" | "default" = "default";
	try {
		source = stateProfiles.resolveStateHome(loginHome, process.env).source;
	} catch {
		source = "setting";
	}
	const reason = source === "env"
		? "The location is pinned by the EXXPERTS_DATA_DIR environment variable; unset it to move the folder from here."
		: !process.env.EXXPERTS_HOME_MOVE_SUPERVISED
			? "Moving needs the app to run under 'exxperts', the desktop app, or the dev harness."
			: null;
	return {
		dir: stateProfileRealHome(),
		defaultDir: loginHome,
		source,
		canMove: reason === null,
		...(reason === null ? {} : { reason }),
	};
}

function stateHomeMoveRefusal(): string | null {
	if (!process.env.EXXPERTS_SWITCH_SUPERVISED || !process.env.EXXPERTS_HOME_MOVE_SUPERVISED) {
		return "Moving the exxperts data needs the app to run under 'exxperts', the desktop app, or the dev harness. This server process has no supervisor to perform the move.";
	}
	if (stateHomePayload().source === "env") {
		return "The data location is pinned by the EXXPERTS_DATA_DIR environment variable. Unset it (where exxperts is started) to move the folder from here.";
	}
	return null;
}

app.get("/api/settings/state-profile", async () => stateProfilePayload());

app.post("/api/settings/state-profile/create", async (req, reply) => {
	const name = String((req.body as { name?: unknown } | null)?.name ?? "");
	const invalid = stateProfiles.validateNewProfileName(name);
	if (invalid) return reply.code(400).send({ error: invalid });
	try {
		stateProfiles.createProfile(stateProfileRealHome(), name);
	} catch (e) {
		return reply.code(409).send({ error: (e as Error).message });
	}
	return stateProfilePayload();
});

app.post("/api/settings/state-profile/delete", async (req, reply) => {
	const name = String((req.body as { name?: unknown } | null)?.name ?? "");
	try {
		stateProfiles.deleteProfile(stateProfileRealHome(), name);
	} catch (e) {
		return reply.code(409).send({ error: (e as Error).message });
	}
	return stateProfilePayload();
});

app.post("/api/settings/state-profile/switch", async (req, reply) => {
	// The restart happens OUTSIDE this process. Without a supervisor that
	// knows the protocol (the exxperts launcher, desktop shell, dev harness,
	// which all set this marker), exiting would just leave a dead app. Refuse
	// while we can still say why.
	if (!process.env.EXXPERTS_SWITCH_SUPERVISED) {
		return reply.code(409).send({ error: "Switching needs the app to run under 'exxperts', the desktop app, or the dev harness. This server process has no supervisor to perform the switch." });
	}
	const rawName = (req.body as { name?: unknown } | null)?.name ?? null;
	const name = rawName === null ? null : String(rawName);
	let nextToken: string;
	try {
		// Points the app at the target and returns its sign-in token (minted
		// now if the profile never ran): the reply carries the new sign-in
		// link so the open page follows the restart on its own. An env-pinned
		// token never rotates.
		const minted = stateProfiles.prepareSwitch(stateProfileRealHome(), name);
		nextToken = process.env.EXXPERTS_AUTH_TOKEN?.trim() || minted;
	} catch (e) {
		return reply.code(409).send({ error: (e as Error).message });
	}
	// Reply first, exit after it flushes. app.close() waits for in-flight
	// replies and runs the onClose hook (scheduler loops); the unref'd timer
	// is the ceiling in case a keep-alive or WS socket refuses to drain. It
	// is tight on purpose: the whole switch must finish inside the
	// connection banner's 12s sustained-outage grace, so every donated
	// second here is a second closer to a false alarm.
	setTimeout(() => process.exit(stateProfiles.SWITCH_EXIT_CODE), 750).unref();
	setImmediate(() => {
		void app.close().finally(() => process.exit(stateProfiles.SWITCH_EXIT_CODE));
	});
	return { ok: true, restarting: true, target: name, signInPath: `/auth/session?token=${encodeURIComponent(nextToken)}` };
});

// Moving the exxperts home: /plan validates a candidate folder and returns
// what a confirmation must disclose (mode "migrate" moves the whole family
// there; mode "adopt" means the folder already holds exxperts data (the
// other-computer case for a cloud-synced folder) and is used as-is, nothing
// moved or merged). /apply re-validates, records the move for the supervisor
// to execute between legs, and exits with the same sentinel a profile switch
// uses; the reply carries the sign-in link the restarted leg will honor.
app.post("/api/settings/state-home/plan", async (req, reply) => {
	const refusal = stateHomeMoveRefusal();
	if (refusal) return reply.code(409).send({ error: refusal });
	const dir = String((req.body as { dir?: unknown } | null)?.dir ?? "");
	try {
		return stateProfiles.planHomeMove(stateProfileRealHome(), dir);
	} catch (e) {
		return reply.code(409).send({ error: (e as Error).message });
	}
});

app.post("/api/settings/state-home/apply", async (req, reply) => {
	const refusal = stateHomeMoveRefusal();
	if (refusal) return reply.code(409).send({ error: refusal });
	const dir = String((req.body as { dir?: unknown } | null)?.dir ?? "");
	let token: string;
	try {
		token = stateProfiles.prepareHomeMove(stateProfileLoginHome(), stateProfileRealHome(), dir).token;
	} catch (e) {
		return reply.code(409).send({ error: (e as Error).message });
	}
	const nextToken = process.env.EXXPERTS_AUTH_TOKEN?.trim() || token;
	// Reply first, exit after it flushes, on the same timing rationale as the
	// profile-switch route above.
	setTimeout(() => process.exit(stateProfiles.SWITCH_EXIT_CODE), 750).unref();
	setImmediate(() => {
		void app.close().finally(() => process.exit(stateProfiles.SWITCH_EXIT_CODE));
	});
	return { ok: true, restarting: true, signInPath: `/auth/session?token=${encodeURIComponent(nextToken)}` };
});
