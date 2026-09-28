import fs from "node:fs";
import path from "node:path";
import { AuthStorage, getAgentDir } from "@exxeta/exxperts-runtime";
import { DEFAULT_PERSISTENT_AGENT_AI_PROFILE_ID, getAvailablePersistentAgentAiProfiles, getPersistentAgentAiProfile, isPersistentAgentAiProfileId } from "./persistent-agent-ai-profiles.js";
import type { PersistentAgentAiProfile, PersistentAgentAiProfileId } from "./persistent-agent-ai-profiles.js";
import { productAppStatePath } from "../../../pi-package/product-state-paths.js";

// Global platform state: one active persistent-agent AI profile is shared by all
// persistent agents. Do not copy this file into personalized-agents/* room objects.
export const PERSISTENT_AGENT_AI_PROFILE_FILE = productAppStatePath("persistent-agent-ai-profile.json");

// "auto": no usable explicit selection, so the profile follows whichever provider
// is signed in — signing in is enough, no extra profile click required.
export type PersistentAgentAiProfileStateSource = "file" | "auto" | "default" | "invalid";

export type PersistentAgentAiProfileState = {
	profileId: PersistentAgentAiProfileId;
	profile: PersistentAgentAiProfile;
	path: string;
	source: PersistentAgentAiProfileStateSource;
	message: string | null;
};

function defaultPersistentAgentAiProfileState(source: PersistentAgentAiProfileStateSource, message: string | null = null): PersistentAgentAiProfileState {
	return {
		profileId: DEFAULT_PERSISTENT_AGENT_AI_PROFILE_ID,
		profile: getPersistentAgentAiProfile(DEFAULT_PERSISTENT_AGENT_AI_PROFILE_ID),
		path: PERSISTENT_AGENT_AI_PROFILE_FILE,
		source,
		message,
	};
}

function isProviderSignedIn(authStorage: AuthStorage | null, providerId: string): boolean {
	try {
		return authStorage?.hasAuth(providerId) ?? false;
	} catch {
		return false;
	}
}

// First profile (in declaration order) whose provider has credentials. Returns
// null when nothing is signed in or auth state is unreadable.
function firstSignedInProfile(): PersistentAgentAiProfile | null {
	const authStorage = safeCreateAuthStorage();
	if (!authStorage) return null;
	for (const profile of getAvailablePersistentAgentAiProfiles()) {
		if (isProviderSignedIn(authStorage, profile.providerId)) return profile;
	}
	return null;
}

function autoResolvedPersistentAgentAiProfileState(message: string | null = null): PersistentAgentAiProfileState | null {
	const profile = firstSignedInProfile();
	if (!profile) return null;
	return {
		profileId: profile.id,
		profile,
		path: PERSISTENT_AGENT_AI_PROFILE_FILE,
		source: "auto",
		message,
	};
}

export function readPersistentAgentAiProfileState(): PersistentAgentAiProfileState {
	try {
		if (!fs.existsSync(PERSISTENT_AGENT_AI_PROFILE_FILE)) {
			// No explicit choice yet: follow whichever provider is signed in.
			return autoResolvedPersistentAgentAiProfileState() ?? defaultPersistentAgentAiProfileState("default");
		}
		const raw = JSON.parse(fs.readFileSync(PERSISTENT_AGENT_AI_PROFILE_FILE, "utf-8"));
		const profileId = String(raw?.profileId ?? raw?.id ?? "").trim();
		// The file may hold only the defaults for new rooms: no choice was made,
		// so the profile follows the signed-in provider, as with no file at all.
		if (!profileId) return autoResolvedPersistentAgentAiProfileState() ?? defaultPersistentAgentAiProfileState("default");
		if (!isPersistentAgentAiProfileId(profileId)) {
			return (
				autoResolvedPersistentAgentAiProfileState("Saved persistent-agent AI profile is unknown; using the signed-in profile.")
				?? defaultPersistentAgentAiProfileState("invalid", "Saved persistent-agent AI profile is unknown; using the default profile.")
			);
		}
		const profile = getPersistentAgentAiProfile(profileId);
		// An explicit choice whose provider is signed out is a dead end (rooms cannot
		// run on it); fall back to a signed-in profile until the user picks again.
		if (!isProviderSignedIn(safeCreateAuthStorage(), profile.providerId)) {
			const fallback = autoResolvedPersistentAgentAiProfileState(`${profile.label} is not signed in; using the signed-in profile.`);
			if (fallback) return fallback;
		}
		return {
			profileId,
			profile,
			path: PERSISTENT_AGENT_AI_PROFILE_FILE,
			source: "file",
			message: null,
		};
	} catch {
		return (
			autoResolvedPersistentAgentAiProfileState("Saved persistent-agent AI profile state could not be read; using the signed-in profile.")
			?? defaultPersistentAgentAiProfileState("invalid", "Saved persistent-agent AI profile state could not be read; using the default profile.")
		);
	}
}

function safeCreateAuthStorage(): AuthStorage | null {
	try {
		// No auth file = nothing signed in. Checked before AuthStorage.create(),
		// which materializes auth.json — profile state is resolved on read-only
		// paths (schedule due scans, background preflights) that must not create
		// runtime auth state.
		if (!fs.existsSync(path.join(getAgentDir(), "auth.json"))) return null;
		return AuthStorage.create();
	} catch {
		return null;
	}
}

// The saved pointer as written, without resolving it: null when no file exists
// or the file does not parse. Used to decide whether a pointer is stale.
export function readSavedPersistentAgentAiProfileId(): string | null {
	try {
		if (!fs.existsSync(PERSISTENT_AGENT_AI_PROFILE_FILE)) return null;
		const raw = JSON.parse(fs.readFileSync(PERSISTENT_AGENT_AI_PROFILE_FILE, "utf-8"));
		const profileId = String(raw?.profileId ?? raw?.id ?? "").trim();
		return profileId || null;
	} catch {
		return null;
	}
}

// Drops the explicit choice: the state becomes "auto" and follows the signed-in
// provider. Called when the profile the pointer names no longer exists, so the
// pointer never stays stale from the app's own actions. The defaults for new
// rooms kept in the same file stay. Returns true when a choice was dropped.
export function clearSavedPersistentAgentAiProfileState(): boolean {
	if (!fs.existsSync(PERSISTENT_AGENT_AI_PROFILE_FILE)) return false;
	const rest = readProfileStateFileWithout(["profileId", "id"]);
	if (!rest || Object.keys(rest).length === 0) {
		fs.rmSync(PERSISTENT_AGENT_AI_PROFILE_FILE, { force: true });
		return true;
	}
	writeProfileStateFile(rest);
	return true;
}

// The state file's other keys (the defaults for new rooms), or null when it
// does not parse, in which case there is nothing to keep.
function readProfileStateFileWithout(keys: string[]): Record<string, unknown> | null {
	try {
		const raw = JSON.parse(fs.readFileSync(PERSISTENT_AGENT_AI_PROFILE_FILE, "utf-8"));
		if (!raw || typeof raw !== "object") return null;
		const rest: Record<string, unknown> = { ...raw };
		for (const key of keys) delete rest[key];
		return rest;
	} catch {
		return null;
	}
}

function writeProfileStateFile(payload: Record<string, unknown>): void {
	fs.mkdirSync(path.dirname(PERSISTENT_AGENT_AI_PROFILE_FILE), { recursive: true, mode: 0o700 });
	const tmpPath = `${PERSISTENT_AGENT_AI_PROFILE_FILE}.${process.pid}.tmp`;
	fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
	fs.renameSync(tmpPath, PERSISTENT_AGENT_AI_PROFILE_FILE);
}

export function getActivePersistentAgentAiProfileId(): PersistentAgentAiProfileId {
	return readPersistentAgentAiProfileState().profileId;
}

export function getActivePersistentAgentAiProfile(): PersistentAgentAiProfile {
	return readPersistentAgentAiProfileState().profile;
}

export function writePersistentAgentAiProfileState(profileId: PersistentAgentAiProfileId): PersistentAgentAiProfileState {
	// Resolve before writing: an unknown id must throw without persisting.
	const profile = getPersistentAgentAiProfile(profileId);
	// The defaults for new rooms share the file and are kept.
	const rest = fs.existsSync(PERSISTENT_AGENT_AI_PROFILE_FILE) ? readProfileStateFileWithout(["profileId", "id"]) ?? {} : {};
	writeProfileStateFile({ profileId, ...rest });
	return {
		profileId,
		profile,
		path: PERSISTENT_AGENT_AI_PROFILE_FILE,
		source: "file",
		message: null,
	};
}
