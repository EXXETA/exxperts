/**
 * The web server's entry. It embeds the exxperts runtime SDK and serves one
 * agent session per WebSocket connection (room-socket.ts, which also
 * describes the wire protocol).
 *
 * The order of the imports below is the order the server's routes and hooks
 * register, since each route module registers while it loads: a module must
 * not import one that comes after it, and a new route module goes in at the
 * place where its routes belong. After the imports come the boot migrations
 * and sweeps, then listen and the graceful stop.
 */

import "dotenv/config";
import "./server-load-order.js";
import { REPO_ROOT } from "./server-install-root.js";
import { app, PORT } from "./server-app.js";
import { remoteMode } from "./request-checks.js";
import "./remote-routes.js";
import "./room-routes.js";
import "./room-schedule-routes.js";
import "./room-runtime-routes.js";
import "./room-thread-routes.js";
import "./room-settings-routes.js";
import "./room-fold-routes.js";
import "./room-remember-routes.js";
import "./provider-auth-routes.js";
import "./model-routes.js";
import { saveGatewayEverywhere } from "./gateways.js";
import "./settings-routes.js";
import "./state-home-routes.js";
import "./gateway-routes.js";
import "./skill-routes.js";
import "./mcp-routes.js";
import "./memory-routes.js";
import "./room-socket.js";
import "./artifact-routes.js";
import "./room-files-routes.js";
import "./static-files.js";
import { AuthStorage } from "@exxeta/exxperts-runtime";
import { migrateBuiltInAiProfiles } from "./built-in-ai-profile-migration.js";
import { PERSISTENT_AGENTS_ROOT, sweepPersistentAgentPurgeTombstones, listPersistentAgents, countPersistentAgentTurnsInFlight } from "./persistent-agents.js";
import { readPersistentRoomDefaultCapabilityPolicy } from "./persistent-room-workspace-policy.js";
import { migratePersistentRoomBashAutoApproveDefaults } from "./persistent-room-bash-settings.js";
import { migrateRoomModels } from "./room-models-migration.js";
import { healShelfMaintenanceAtBoot } from "./persistent-room-shelf.js";
import { migrateTaskArtifactsToShelves } from "./persistent-room-shelf-migration.js";
import { sweepOrphanedTaskLedgerRecords } from "./persistent-room-task-ledger.js";
import { runningSpecialistCountInAllRooms, abortSpecialistTasksInAllRooms } from "./persistent-room-specialist-registry.js";
import { readOpenAiCompatibleGateways, findOpenAiCompatibleGateway } from "./openai-compatible-gateways.js";
import { readGatewayProviderBaseUrl } from "./openai-compatible-gateway-catalog.js";
import { normalizeGatewayBaseUrl, discoverGatewayModels } from "./openai-compatible-gateway-detect.js";
import { type GatewayDeclarationsRefreshLoopHandle, resolveGatewayDeclarationsRefreshOptionsFromEnv, startGatewayDeclarationsRefreshLoop } from "./openai-compatible-gateway-refresh.js";
import { readWebSearchSettings } from "./web-search-settings.js";
import { startPersistentRoomSchedulePreflightLoop, resolvePersistentRoomSchedulePreflightLoopOptionsFromEnv } from "./persistent-room-schedule-preflight-loop.js";
import { startScheduledPromptBackgroundExecutionLoop, resolveScheduledPromptBackgroundExecutionLoopOptionsFromEnv } from "./scheduled-prompt-background-execution-loop.js";
import { artifactRoot } from "../../../pi-package/extensions/artifacts/index.js";
import { ensureRoomScopedMcpGrantsMigration } from "../../../pi-package/extensions/mcp/room-scope.js";
import { ensureProductAppUserDirs } from "../../../pi-package/product-state-paths.js";
import { migrateLegacyUserSkills } from "./skills-store.js";
import { importHistoricalSessionUsage } from "./usage-import.js";
import { updateSearxngOnBoot } from "./searxng-setup.js";
import { isSharedServer, serverHooks } from "./server-hooks.js";
import { installServerStop } from "./server-stop.js";

ensureProductAppUserDirs();

// Unify the skills store (spec §1): move any skills left in the pre-unification
// web dir (~/.exxperts/app/skills) into the canonical loader dir. No overwrite on
// a name collision (canonical wins, the legacy copy is left in place + warned).
try {
	const migrated = migrateLegacyUserSkills((message) => app.log.warn(message));
	if (migrated.moved.length > 0) {
		app.log.info(`skills migration: moved ${migrated.moved.length} skill(s) into the canonical store: ${migrated.moved.join(", ")}`);
	}
} catch (e) {
	app.log.warn({ err: (e as Error).message }, "skills migration failed");
}

// Reconcile the ledger with the pi-session files (CLI-attach turns land there
// from a separate process; disconnect races can also drop rows). Exact-match
// dedupe makes this idempotent, so it runs every boot, before the server
// accepts traffic.
try {
	const imported = importHistoricalSessionUsage(PERSISTENT_AGENTS_ROOT, (message) => app.log.warn(message));
	if (imported && imported.rows > 0) {
		app.log.info(`usage reconcile: recovered ${imported.rows} unrecorded turns (est. ${imported.cost.toFixed(2)}) from session files`);
	}
} catch (e) {
	app.log.warn({ err: (e as Error).message }, "usage reconcile failed");
}

// Task-ledger boot sweep (assets contract §2): a row can only still be
// `running` at boot if the process died before finalizing it.
try {
	const sweptTasks = sweepOrphanedTaskLedgerRecords();
	if (sweptTasks > 0) app.log.info(`task ledger: marked ${sweptTasks} interrupted task(s) orphaned`);
} catch (e) {
	app.log.warn({ err: (e as Error).message }, "task ledger boot sweep failed");
}

// Purge-tombstone sweep: a room purge detaches the room dir by rename before
// removing it, so a crash or a refusing OS can leave a <id>.purging-<ts>
// tombstone — invisible to every listing, reclaimed here.
try {
	const sweptTombstones = sweepPersistentAgentPurgeTombstones();
	if (sweptTombstones > 0) app.log.info(`purge tombstones: removed ${sweptTombstones} leftover room remainder(s)`);
} catch (e) {
	app.log.warn({ err: (e as Error).message }, "purge tombstone boot sweep failed");
}

// Boot settle: a save a crash left half done is finished, or dropped when it
// never reached its commit point, in every room before anything reads it
// (memory-commit.ts). Reading a room's status settles it.
try {
	listPersistentAgents();
} catch (e) {
	app.log.warn({ err: (e as Error).message }, "boot settle of pending saves failed");
}

// Boot heal FIRST: replay any rename journal a crash left mid-rewrite and
// finish any staged delete whose undo window outlived its process. It must run
// BEFORE the migration mutates the shelf namespace: the rename-journal replay
// keys on "oldName gone = the move happened", and the migration allocates
// shelf names by what exists on disk — run after it, a crash-freed oldName
// could already hold an unrelated migrated output, the replay would read the
// name as reclaimed and skip the rewrite, and the renamed file's ledger rows
// would resolve to the wrong bytes forever. Heal reads nothing the migration
// produces (rename journals and trash tokens are shelf-only state), so this
// order is safe — and it is the only order that keeps the replay predicate
// unambiguous.
try { healShelfMaintenanceAtBoot(); } catch (e) { app.log.warn({ err: (e as Error).message }, "shelf boot heal failed; the files listing retries per room"); }

// Shelf migration (files core slice): task-store artifacts move in with their
// room, once, before the server accepts traffic. Idempotent per room (marker)
// and per record (rename + rewrite each heal independently); the orphan sweep
// inside runs only after every room migrated cleanly and logs every removal to
// migration-removed.log next to the store. Runs AFTER the ledger boot sweep so
// interrupted `running` rows are terminal before their folders are walked, and
// AFTER the shelf boot heal (see above) so the shelf namespace it allocates
// into is fully healed.
try {
	const shelfMigration = migrateTaskArtifactsToShelves({ artifactsRoot: artifactRoot(), log: (message) => app.log.info(message) });
	if (shelfMigration.filesMoved > 0 || shelfMigration.orphanEntriesDeleted > 0 || shelfMigration.entriesMovedAside > 0) {
		app.log.info(`shelf migration: ${shelfMigration.roomsMigrated} room(s), ${shelfMigration.filesMoved} file(s) moved, ${shelfMigration.orphanEntriesDeleted} store entr${shelfMigration.orphanEntriesDeleted === 1 ? "y" : "ies"} removed, ${shelfMigration.entriesMovedAside} moved aside`);
	}
	for (const migrationError of shelfMigration.errors) app.log.warn(`shelf migration: ${migrationError}`);
} catch (e) {
	app.log.warn({ err: (e as Error).message }, "shelf migration failed; task-store artifacts stay in place until the next boot");
}

// Built-in AI profile migration (0.13.2): a custom model list saved earlier on
// the Claude or ChatGPT profile is dropped so the curated list shows, and a
// saved active-profile pointer that names a profile which no longer exists is
// cleared. Idempotent; a failure logs and never blocks the start.
try {
	migrateBuiltInAiProfiles({ log: (message) => app.log.info(message) });
} catch (e) {
	app.log.warn({ err: (e as Error).message }, "built-in AI profile migration failed; the saved files stay as they are");
}

// Model per room (0.14): each room's preferred model becomes its conversation
// pick, and the defaults for new rooms are written from the saved profile.
// Idempotent, never removes a file before its replacement reads back, and a
// failure logs and never blocks the start.
try {
	migrateRoomModels({ log: (message) => app.log.info(message) });
} catch (e) {
	app.log.warn({ err: (e as Error).message }, "room models migration failed; the saved files stay as they are");
}

// Per-room MCP update-day migration: before the server accepts traffic, every
// EXISTING room without a grants file receives the full current connector
// list (nothing a room could do before the update stops working), one time
// only (marker-guarded; a room session's registration runs the same guarded
// migration, whichever comes first wins). An unreadable config file ABORTS the
// run without the marker - the adapter would silently read it as "no
// servers" and this migration must never wipe legacy rooms off a corrupt
// file - so the next boot retries.
try {
	const migration = await ensureRoomScopedMcpGrantsMigration();
	if (migration.skipped === "unreadable-config") {
		app.log.warn("per-room MCP migration skipped: a connector config file is unreadable; existing rooms keep no grants file until a boot after the file is fixed");
	} else if (migration.migrated.length > 0) {
		app.log.info(`per-room MCP migration: granted the full connector list to ${migration.migrated.length} existing room(s)`);
	}
} catch (e) {
	app.log.warn({ err: (e as Error).message }, "per-room MCP grants migration failed; rooms without a grants file read as empty until the next boot");
}

let schedulerPreflightLoopHandle: ReturnType<typeof startPersistentRoomSchedulePreflightLoop> | null = null;

let schedulerExecutionLoopHandle: ReturnType<typeof startScheduledPromptBackgroundExecutionLoop> | null = null;

let gatewayDeclarationsRefreshHandle: GatewayDeclarationsRefreshLoopHandle | null = null;

// The loops that start work, stopped at the server's close and at the start of a server stop.
const stopBackgroundLoops = (): void => {
	schedulerExecutionLoopHandle?.stop();
	schedulerExecutionLoopHandle = null;
	schedulerPreflightLoopHandle?.stop();
	schedulerPreflightLoopHandle = null;
	gatewayDeclarationsRefreshHandle?.stop();
	gatewayDeclarationsRefreshHandle = null;
};

app.addHook("onClose", async () => stopBackgroundLoops());

// Rooms that had bash before the approval card ran commands without asking;
// the one-time grant preserves that. A failed sweep only means rooms ask.
try {
	const bashApprovalMigration = migratePersistentRoomBashAutoApproveDefaults(
		listPersistentAgents().map((agent) => ({ id: agent.id, bashEnabled: readPersistentRoomDefaultCapabilityPolicy(agent.id)?.bashEnabled === true })),
	);
	if (bashApprovalMigration.migrated.length > 0) {
		app.log.info({ rooms: bashApprovalMigration.migrated }, "bash auto-approve preserved for rooms predating the approval card");
	}
} catch (error) {
	app.log.warn({ err: error }, "bash auto-approve upgrade sweep failed; affected rooms will ask per command");
}

const schedulerPreflightLoopOptions = resolvePersistentRoomSchedulePreflightLoopOptionsFromEnv(process.env, app.log);

const schedulerExecutionLoopOptions = resolveScheduledPromptBackgroundExecutionLoopOptionsFromEnv(process.env, app.log);

const gatewayDeclarationsRefreshOptions = resolveGatewayDeclarationsRefreshOptionsFromEnv(process.env, app.log);

app.listen({ port: PORT, host: "127.0.0.1" })
	.then(async () => {
		console.log(`exxperts web server on http://localhost:${PORT} (ws: /ws, ui: /, local-only)`);
		// After the loopback listener is up, honor a persisted remote-enable.
		// applyBootState never throws and never touches the primary listener:
		// a bad state file or a missing tailnet address degrades to remote-off
		// with a logged reason. Fire-and-forget on purpose: a boot-time TLS
		// certificate renewal (expired while the app was off) may block for a
		// while, and nothing below depends on remote state, so the scheduler
		// loops must not wait for it. The catch keeps a contract violation
		// from becoming an unhandled rejection.
		void remoteMode.applyBootState().catch((error) => app.log.warn({ err: error }, "remote mode boot apply failed; remote stays off"));
		// The local search engine catches up with the pinned image and settings.
		void (async () => {
			const saved = readWebSearchSettings().saved;
			await updateSearxngOnBoot(REPO_ROOT, saved.provider === "searxng" ? saved.baseUrl ?? null : null);
		})().catch((error) => app.log.warn({ err: error }, "local search engine update skipped"));
		if (schedulerPreflightLoopOptions.enabled !== false) {
			schedulerPreflightLoopHandle = startPersistentRoomSchedulePreflightLoop({
				...schedulerPreflightLoopOptions,
				logger: app.log,
			});
		}
		if (schedulerExecutionLoopOptions.enabled !== false) {
			schedulerExecutionLoopHandle = startScheduledPromptBackgroundExecutionLoop({
				...schedulerExecutionLoopOptions,
				logger: app.log,
			});
		}
		// Saved gateways re-read what they declare (prices, flags, windows) a
		// few seconds from now and once a day after that, through the panel's
		// own resolve, probe and save seams, so the snapshots stop going stale
		// between visits to the panel. Best effort throughout: the loop never
		// throws, and a gateway that cannot be reached keeps what it has.
		gatewayDeclarationsRefreshHandle = startGatewayDeclarationsRefreshLoop({
			readGateways: () => readOpenAiCompatibleGateways().gateways,
			findGateway: (gatewayId) => findOpenAiCompatibleGateway(gatewayId),
			resolveBaseUrl: (gateway) => normalizeGatewayBaseUrl(gateway.baseUrl || readGatewayProviderBaseUrl(gateway.providerId)),
			readKey: async (providerId) => (await AuthStorage.create().getApiKey(providerId)) ?? undefined,
			discover: discoverGatewayModels,
			// The panel's save minus the key: catalog entry first, store second,
			// same order and same failure story as a person pressing Save.
			save: (gateway) => saveGatewayEverywhere(gateway, "", false),
			logger: app.log,
		}, gatewayDeclarationsRefreshOptions);
		// The graceful stop on SIGTERM and SIGINT (server-stop.ts). The scheduler's
		// loops are kept here, so a tick still running is seen after their handles clear.
		const schedulerLoopsForStop = [schedulerPreflightLoopHandle, schedulerExecutionLoopHandle].filter((loop) => loop !== null);
		installServerStop({
			app,
			sharedServer: isSharedServer(),
			waitSeconds: serverHooks().stopWaitSeconds,
			turnsRunning: countPersistentAgentTurnsInFlight,
			specialistTasksRunning: runningSpecialistCountInAllRooms,
			abortSpecialistTasks: abortSpecialistTasksInAllRooms,
			schedulerTickRunning: () => schedulerLoopsForStop.some((loop) => loop.isRunning()),
			stopLoops: stopBackgroundLoops,
		});
	})
	.catch((err: NodeJS.ErrnoException) => {
		if (err?.code === "EADDRINUSE") {
			console.error(`Port ${PORT} is already in use. Is exxperts already running?`);
			console.error(`Stop the other process, or pick another port: exxperts --port <port>`);
		} else {
			console.error(`Could not start the exxperts web server: ${err?.message ?? err}`);
		}
		process.exit(1);
	});
