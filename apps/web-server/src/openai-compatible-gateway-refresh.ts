import { isDeepStrictEqual } from "node:util";
import type { GatewayDiscovery, GatewayModelDetection } from "./openai-compatible-gateway-detect.js";
import { parseGatewayDetectedSnapshot, type GatewayModelDetected, type OpenAiCompatibleGateway } from "./openai-compatible-gateways.js";

/**
 * Saved gateways re-read their declarations on their own.
 *
 * Every approved gateway model carries a snapshot of what the gateway said
 * about it: whether it takes images, which thinking rungs exist, how wide the
 * window is, and what a million tokens cost. That snapshot used to change only
 * when somebody opened the Add Provider panel, pressed reload and saved. Prices
 * move, deployments gain and lose flags, and nobody visits that panel for
 * weeks, so the wallet was multiplying by last month's rate and the effort
 * dial was offering rungs the gateway had since withdrawn. Worse, a field that
 * detection learned to read for the first time (the price was the latest)
 * stayed unknown on every existing setup until each owner made that trip.
 *
 * So the server does the trip itself: once shortly after it starts listening,
 * and once a day while it runs. The rules are the ones a careful person would
 * follow at the panel:
 *
 *   - A gateway that cannot be reached, rejects the key, or answers nonsense
 *     is left exactly as it was. A gateway being down for a night must never
 *     erase what we knew about it in the morning.
 *   - Only the detection half of a model moves. The person's overrides are
 *     their decisions, and a refresh has no business revisiting them.
 *   - Within that half, only what the gateway answered this time moves. A
 *     live gateway has been seen answering null for both prices on one fetch
 *     and the real prices again seconds later; a refresh that replaced the
 *     whole snapshot would have erased a known price over that blip, and
 *     every turn until the next day's run would have booked at zero. So a
 *     field the gateway did not answer keeps its previous value, and the
 *     ladder and the price move as whole blocks only when answered. This is
 *     deliberately more conservative than the panel's reload, which replaces
 *     the snapshot outright: a person pressing reload is asking for the
 *     gateway's current word, silences included, and is there to see what
 *     came back. Nobody is watching a background run, so it must never lose
 *     a fact over a silent answer.
 *   - A model the gateway no longer lists keeps its row and its old snapshot.
 *     Dropping an approval behind somebody's back is a removal nobody asked
 *     for; the panel is where that happens, in front of them.
 *   - Nothing is written when nothing changed. models.json takes a timestamped
 *     backup on every write, and a daily backup of an identical file is noise
 *     in a folder the person owns.
 *
 * The core is pure so it can be proven without a server: given a gateway and
 * a discovery, it says what the gateway would become. The runner around it
 * owns the reading, probing and saving through injected seams, and the
 * scheduler on top owns only the clock.
 */

/**
 * Where the maintenance model's snapshot lives when the model has no room row
 * of its own; it is a room model's own snapshot otherwise. Named so a summary
 * can say which entry moved.
 */
const MAINTENANCE_MODEL_ENTRY = "maintenanceModel";

export type GatewayDeclarationsUpdate = {
	/** The gateway with every listed model's snapshot replaced by what the gateway now declares. Same object as the input when nothing moved. */
	gateway: OpenAiCompatibleGateway;
	/** Which entries changed: room model ids, plus "maintenanceModel" for a maintenance model with no row of its own. */
	changed: string[];
	/** Room and maintenance models the gateway no longer lists; kept as they were. */
	unlisted: string[];
};

/**
 * The store's snapshot of one discovered model, read through the same strict
 * parser the store file and the approve form go through. Discovery already
 * returns well-typed fields, so this is mostly a formality, but it is the
 * formality that keeps a refresh from writing anything a reload could not.
 */
export function snapshotFromDetection(detection: GatewayModelDetection): GatewayModelDetected {
	const { id: _id, ...declared } = detection;
	return parseGatewayDetectedSnapshot(declared as Record<string, unknown>);
}

/** Two snapshots are the same declaration when every field agrees; an absent snapshot is an empty one. */
function sameSnapshot(before: GatewayModelDetected | undefined, after: GatewayModelDetected): boolean {
	return isDeepStrictEqual(before ?? {}, after);
}

/**
 * The snapshot after this discovery: everything the gateway answered now, on
 * top of everything it had answered before. The fresh snapshot carries only
 * answered fields, so the spread is the per-field merge; the ladder and the
 * price are single fields here and move as whole blocks or not at all.
 */
function mergedSnapshot(before: GatewayModelDetected | undefined, fresh: GatewayModelDetected): GatewayModelDetected {
	return { ...(before ?? {}), ...fresh };
}

/**
 * The gateway as it would be saved after one discovery, and the list of what
 * that would change. Pure: reads nothing, writes nothing, and hands back the
 * very same gateway object when the discovery adds nothing to the snapshots
 * already held, so a caller can tell "nothing to do" apart from "saved".
 * A merge, not a replacement: see the module comment for why a background
 * run keeps every field the gateway left unanswered.
 */
export function applyGatewayDeclarations(gateway: OpenAiCompatibleGateway, discovery: GatewayDiscovery): GatewayDeclarationsUpdate {
	const listed = new Map<string, GatewayModelDetection>();
	for (const model of discovery.models) listed.set(model.id, model);
	const changed: string[] = [];
	const unlisted: string[] = [];

	const roomModels = gateway.roomModels.map((model) => {
		const detection = listed.get(model.modelId);
		if (!detection) {
			unlisted.push(model.modelId);
			return model;
		}
		const snapshot = mergedSnapshot(model.detected, snapshotFromDetection(detection));
		if (sameSnapshot(model.detected, snapshot)) return model;
		changed.push(model.modelId);
		// Only the detection half moves. Every override field on the row is the
		// person's, and the spread keeps each of them exactly as it was.
		return { ...model, detected: snapshot };
	});

	let maintenanceModelDetected = gateway.maintenanceModelDetected;
	let maintenanceChanged = false;
	const maintenanceHasOwnRow = gateway.roomModels.some((model) => model.modelId === gateway.maintenanceModel);
	if (gateway.maintenanceModel && !maintenanceHasOwnRow) {
		const detection = listed.get(gateway.maintenanceModel);
		if (!detection) {
			unlisted.push(gateway.maintenanceModel);
		} else {
			const snapshot = mergedSnapshot(gateway.maintenanceModelDetected, snapshotFromDetection(detection));
			if (!sameSnapshot(gateway.maintenanceModelDetected, snapshot)) {
				maintenanceChanged = true;
				changed.push(MAINTENANCE_MODEL_ENTRY);
				maintenanceModelDetected = snapshot;
			}
		}
	}

	if (changed.length === 0) return { gateway, changed, unlisted };
	const next: OpenAiCompatibleGateway = { ...gateway, roomModels };
	if (maintenanceChanged && maintenanceModelDetected) next.maintenanceModelDetected = maintenanceModelDetected;
	return { gateway: next, changed, unlisted };
}

export interface GatewayDeclarationsRefreshLogger {
	info?: (value: unknown, message?: string) => void;
	warn?: (value: unknown, message?: string) => void;
	debug?: (value: unknown, message?: string) => void;
}

/**
 * Everything a refresh touches outside itself, as seams. The server wires the
 * real store, key storage, discovery and save path; a smoke wires fakes and
 * counts the writes.
 */
export interface GatewayDeclarationsRefreshDeps {
	/** Every saved gateway, as the store reads them now. */
	readGateways: () => OpenAiCompatibleGateway[];
	/** One gateway by id, read again after the probe so a save in the meantime is not overwritten with a stale copy. */
	findGateway: (gatewayId: string) => OpenAiCompatibleGateway | undefined;
	/** The address to probe, resolved exactly as the panel resolves it; empty when the gateway has none anywhere. */
	resolveBaseUrl: (gateway: OpenAiCompatibleGateway) => string;
	/** The stored key for the gateway's provider, or nothing. */
	readKey: (providerId: string) => Promise<string | undefined>;
	/** The probe. Throws for anything that is not a usable model list. */
	discover: (baseUrl: string, key: string) => Promise<GatewayDiscovery>;
	/** The panel's own save path minus the key: catalog entry and store, in that order. */
	save: (gateway: OpenAiCompatibleGateway) => void;
	logger?: GatewayDeclarationsRefreshLogger;
}

export type GatewayDeclarationsRefreshOutcome =
	| { gatewayId: string; label: string; status: "skipped"; reason: string }
	| { gatewayId: string; label: string; status: "unreachable"; reason: string }
	| { gatewayId: string; label: string; status: "unchanged"; unlisted: string[] }
	| { gatewayId: string; label: string; status: "refreshed"; changed: string[]; unlisted: string[] }
	| { gatewayId: string; label: string; status: "failed"; reason: string };

export type GatewayDeclarationsRefreshRun = {
	startedAt: string;
	finishedAt: string;
	outcomes: GatewayDeclarationsRefreshOutcome[];
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * One gateway, start to finish. Every early return here is a reason the
 * gateway stays exactly as it was, and each one is logged once, at the level
 * it deserves: a gateway with no key or no address is a setup in progress and
 * not worth a warning; a gateway that could not be probed is worth exactly
 * one, with the reason, so a wrong key or a moved endpoint is noticed without
 * a log full of retries.
 */
async function refreshOneGateway(deps: GatewayDeclarationsRefreshDeps, gateway: OpenAiCompatibleGateway): Promise<GatewayDeclarationsRefreshOutcome> {
	const identity = { gatewayId: gateway.id, label: gateway.label };
	const baseUrl = deps.resolveBaseUrl(gateway);
	if (!/^https?:\/\//.test(baseUrl)) {
		deps.logger?.debug?.({ gatewayId: gateway.id }, `gateway declarations: no base URL for ${gateway.label}; skipped`);
		return { ...identity, status: "skipped", reason: "no base URL" };
	}
	const key = (await deps.readKey(gateway.providerId))?.trim();
	if (!key) {
		deps.logger?.debug?.({ gatewayId: gateway.id }, `gateway declarations: no stored key for ${gateway.label}; skipped`);
		return { ...identity, status: "skipped", reason: "no stored key" };
	}
	let discovery: GatewayDiscovery;
	try {
		discovery = await deps.discover(baseUrl, key);
	} catch (error) {
		const reason = errorMessage(error);
		deps.logger?.warn?.({ gatewayId: gateway.id, baseUrl }, `gateway declarations: could not reach ${gateway.label}, keeping what is saved (${reason})`);
		return { ...identity, status: "unreachable", reason };
	}
	// The probe took a while, and a person may have saved the panel in the
	// meantime. What gets the fresh declarations is the gateway as it is now,
	// not as it was when the probe started; a gateway removed in between is
	// simply gone.
	const current = deps.findGateway(gateway.id);
	if (!current) return { ...identity, status: "skipped", reason: "removed while probing" };
	const update = applyGatewayDeclarations(current, discovery);
	if (update.changed.length === 0) {
		deps.logger?.info?.({ gatewayId: gateway.id, unlisted: update.unlisted }, `gateway declarations unchanged for ${gateway.label}`);
		return { ...identity, status: "unchanged", unlisted: update.unlisted };
	}
	try {
		deps.save(update.gateway);
	} catch (error) {
		const reason = errorMessage(error);
		deps.logger?.warn?.({ gatewayId: gateway.id }, `gateway declarations: could not save the refreshed declarations for ${gateway.label} (${reason})`);
		return { ...identity, status: "failed", reason };
	}
	deps.logger?.info?.(
		{ gatewayId: gateway.id, changed: update.changed, unlisted: update.unlisted },
		`refreshed ${update.changed.length} model declaration${update.changed.length === 1 ? "" : "s"} for ${gateway.label}`,
	);
	return { ...identity, status: "refreshed", changed: update.changed, unlisted: update.unlisted };
}

/**
 * Every saved gateway, one after the other. Sequential on purpose: the
 * gateways share one models.json and one store file, and the save path is a
 * read-modify-write of both. A gateway that throws anywhere outside the
 * guarded steps above is recorded as failed and the next one still runs.
 */
export async function refreshGatewayDeclarations(deps: GatewayDeclarationsRefreshDeps): Promise<GatewayDeclarationsRefreshRun> {
	const startedAt = new Date().toISOString();
	const outcomes: GatewayDeclarationsRefreshOutcome[] = [];
	let gateways: OpenAiCompatibleGateway[] = [];
	try {
		gateways = deps.readGateways();
	} catch (error) {
		deps.logger?.warn?.({ err: errorMessage(error) }, "gateway declarations: could not read the saved gateways; nothing refreshed");
	}
	for (const gateway of gateways) {
		try {
			outcomes.push(await refreshOneGateway(deps, gateway));
		} catch (error) {
			const reason = errorMessage(error);
			deps.logger?.warn?.({ gatewayId: gateway.id, err: reason }, `gateway declarations: refresh failed for ${gateway.label}; keeping what is saved`);
			outcomes.push({ gatewayId: gateway.id, label: gateway.label, status: "failed", reason });
		}
	}
	return { startedAt, finishedAt: new Date().toISOString(), outcomes };
}

const DEFAULT_REFRESH_ENABLED = true;
/** Long enough for the listener and the boot migrations to be out of the way; short enough that a fresh install sees prices on its first day. */
const DEFAULT_REFRESH_INITIAL_DELAY_MS = 5_000;
const DEFAULT_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MIN_REFRESH_INTERVAL_MS = 1_000;
/** setTimeout's own ceiling; anything longer fires immediately, which is the opposite of what a longer interval means. */
const MAX_REFRESH_INTERVAL_MS = 2_147_483_647;

const ENV_ENABLED = "EXXPERTS_GATEWAY_REFRESH_ENABLED";
const ENV_INITIAL_DELAY_MS = "EXXPERTS_GATEWAY_REFRESH_INITIAL_DELAY_MS";
const ENV_INTERVAL_MS = "EXXPERTS_GATEWAY_REFRESH_INTERVAL_MS";

export interface GatewayDeclarationsRefreshLoopOptions {
	enabled?: boolean;
	initialDelayMs?: number;
	intervalMs?: number;
}

function parseBooleanEnv(raw: string | undefined, defaultValue: boolean, name: string, logger?: GatewayDeclarationsRefreshLogger): boolean {
	if (raw === undefined || raw.trim() === "") return defaultValue;
	const value = raw.trim().toLowerCase();
	if (["1", "true", "on", "yes"].includes(value)) return true;
	if (["0", "false", "off", "no"].includes(value)) return false;
	logger?.warn?.({ name, value: raw, defaultValue }, "Invalid gateway refresh boolean env value; using default");
	return defaultValue;
}

function parseIntegerEnv(raw: string | undefined, defaultValue: number, name: string, min: number, max: number, logger?: GatewayDeclarationsRefreshLogger): number {
	if (raw === undefined || raw.trim() === "") return defaultValue;
	const value = Number(raw.trim());
	if (!Number.isSafeInteger(value) || value < min || value > max) {
		logger?.warn?.({ name, value: raw, defaultValue, min, max }, "Invalid gateway refresh integer env value; using default");
		return defaultValue;
	}
	return value;
}

/**
 * The same three knobs the scheduler loops expose, under the same naming, so
 * the one switch an operator already knows (`..._ENABLED=false`) works here
 * too. A smoke that must not touch the network sets it off; a test that wants
 * the refresh sooner shortens the delay.
 */
export function resolveGatewayDeclarationsRefreshOptionsFromEnv(env: NodeJS.ProcessEnv = process.env, logger?: GatewayDeclarationsRefreshLogger): Required<GatewayDeclarationsRefreshLoopOptions> {
	return {
		enabled: parseBooleanEnv(env[ENV_ENABLED], DEFAULT_REFRESH_ENABLED, ENV_ENABLED, logger),
		initialDelayMs: parseIntegerEnv(env[ENV_INITIAL_DELAY_MS], DEFAULT_REFRESH_INITIAL_DELAY_MS, ENV_INITIAL_DELAY_MS, 0, MAX_REFRESH_INTERVAL_MS, logger),
		intervalMs: parseIntegerEnv(env[ENV_INTERVAL_MS], DEFAULT_REFRESH_INTERVAL_MS, ENV_INTERVAL_MS, MIN_REFRESH_INTERVAL_MS, MAX_REFRESH_INTERVAL_MS, logger),
	};
}

export interface GatewayDeclarationsRefreshLoopHandle {
	stop(): void;
	/** Run now, or join the run already in progress. Never rejects. */
	runNow(): Promise<GatewayDeclarationsRefreshRun>;
	isRunning(): boolean;
}

/**
 * The clock. One run shortly after start, then one per interval, never two at
 * once: a run that is still probing a slow gateway when the next tick lands
 * simply is that tick. Both timers are unref'd, so a process that is
 * otherwise done exiting does not stay alive for tomorrow's refresh, and
 * every run is wrapped so nothing in here can ever take the server down.
 */
export function startGatewayDeclarationsRefreshLoop(deps: GatewayDeclarationsRefreshDeps, options: GatewayDeclarationsRefreshLoopOptions = {}): GatewayDeclarationsRefreshLoopHandle {
	const enabled = options.enabled ?? DEFAULT_REFRESH_ENABLED;
	const initialDelayMs = options.initialDelayMs ?? DEFAULT_REFRESH_INITIAL_DELAY_MS;
	const intervalMs = options.intervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
	let stopped = !enabled;
	let inFlight: Promise<GatewayDeclarationsRefreshRun> | null = null;
	let firstRun: ReturnType<typeof setTimeout> | null = null;
	let ticker: ReturnType<typeof setInterval> | null = null;

	const runNow = (): Promise<GatewayDeclarationsRefreshRun> => {
		if (inFlight) return inFlight;
		inFlight = refreshGatewayDeclarations(deps)
			.catch((error: unknown) => {
				deps.logger?.warn?.({ err: errorMessage(error) }, "gateway declarations: refresh run failed; nothing changed");
				const now = new Date().toISOString();
				return { startedAt: now, finishedAt: now, outcomes: [] };
			})
			.finally(() => {
				inFlight = null;
			});
		return inFlight;
	};

	if (!stopped) {
		firstRun = setTimeout(() => {
			firstRun = null;
			if (stopped) return;
			void runNow();
			ticker = setInterval(() => {
				if (stopped) return;
				void runNow();
			}, intervalMs);
			ticker.unref?.();
		}, initialDelayMs);
		firstRun.unref?.();
	}

	return {
		stop() {
			stopped = true;
			if (firstRun) clearTimeout(firstRun);
			firstRun = null;
			if (ticker) clearInterval(ticker);
			ticker = null;
		},
		runNow,
		isRunning: () => inFlight !== null,
	};
}
