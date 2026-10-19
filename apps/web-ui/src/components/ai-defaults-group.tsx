import { useEffect, useState } from "react";
import { credentialGoneWords, modelCredentialWords } from "../../../web-server/src/model-not-offered";
import { modelDisplayName, modelOnProvider } from "../model-names";
import { SHARED_SERVER_ADMIN_LINE, useRemoteClientContext } from "../remote-client-context";
import { fetchAiDefaults, fetchRoomModelProviders, putAiDefaults } from "../room-models-api";
import type { AiDefaultsView, RoomModelLock, RoomModelLockView, RoomModelProviderView, RoomModelTask } from "../types";
import { GroupHeader } from "./pane-header";
import { RoomModelPicker } from "./room-model-picker";

// AI setup's first group: the models a room uses until it sets its own in
// Room settings, Model. The same two rows and the same picker as the pane. A
// default that cannot run (its provider signed out, or no longer offered) says
// so, and the rooms on it wait: nothing runs in its place.

/** The line under the Memory list while a model is too small for a room on the default (draft). */
const DEFAULT_TOO_SMALL_LINE = "A Memory model must read all of a room's memory at once. To use a smaller one as the default, give that room its own Memory model, or lower its memory budget.";

function lockName(lock: RoomModelLockView): string {
	return modelDisplayName({ model: lock.model, modelLabel: lock.label, provider: lock.provider }) || lock.name;
}

function defaultUnavailableSentence(row: AiDefaultsView[RoomModelTask]): string | null {
	if (!row.stored || !row.reason || row.effective) return null;
	const named = modelOnProvider(lockName(row.stored), row.stored.providerLabel);
	const gone = row.keyGone ? "key-missing" : "signed-out";
	const words = modelCredentialWords(lockName(row.stored), row.stored.providerLabel, named, gone);
	return row.reason === "signed-out"
		? `${words.subject} ${words.state}. Rooms on this default wait until you ${credentialGoneWords(gone).again.toLowerCase()} or choose another here.`
		: `${named} is no longer offered. Rooms on this default wait until you choose another here.`;
}

export function AiDefaultsGroup({ refreshKey }: { refreshKey?: string }) {
	const remoteClient = useRemoteClientContext();
	// A read-only device sees the defaults but cannot change them; on a shared
	// server only its admin may, so they read the same way, with one line.
	const readOnly = (remoteClient.remote && remoteClient.capability !== "full") || remoteClient.sharedServer;
	const [defaults, setDefaults] = useState<AiDefaultsView | null>(null);
	const [providers, setProviders] = useState<RoomModelProviderView[]>([]);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Re-read when the provider set or a sign-in changes (the caller's key).
	useEffect(() => {
		let cancelled = false;
		Promise.all([fetchAiDefaults(), fetchRoomModelProviders()]).then(([nextDefaults, nextProviders]) => {
			if (cancelled) return;
			setDefaults(nextDefaults);
			setProviders(nextProviders);
		}, (e) => { if (!cancelled) setError((e as Error).message); });
		return () => { cancelled = true; };
	}, [refreshKey]);

	async function save(task: RoomModelTask, lock: RoomModelLock) {
		setSaving(true);
		setError(null);
		try {
			setDefaults(await putAiDefaults({ [task]: lock }));
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setSaving(false);
		}
	}

	function row(task: RoomModelTask, label: string) {
		const view = defaults?.[task];
		const unavailable = view ? defaultUnavailableSentence(view) : null;
		const value = view?.stored ?? view?.effective ?? null;
		return (
			<div className="settings-row room-model-row">
				<div className="settings-row-main">
					<span className="settings-row-label">{label}</span>
					{unavailable && <span className="settings-row-sub room-model-unavailable">{unavailable}</span>}
				</div>
				<div className="settings-row-value">
					<RoomModelPicker
						providers={providers}
						task={task}
						value={value ? { provider: value.provider, model: value.model } : null}
						disabled={readOnly || saving || !defaults}
						ariaLabel={`Default ${label.toLowerCase()} model`}
						unpickable={new Map((view?.tooSmall ?? []).map((lock) => [`${lock.provider}/${lock.model}`, `Too small for ${lock.room ?? "a room"}'s memory`]))}
						unpickableLine={DEFAULT_TOO_SMALL_LINE}
						onPick={(lock) => void save(task, lock)}
					/>
				</div>
			</div>
		);
	}

	return (
		<div className="settings-group ai-defaults-group">
			<GroupHeader kicker="Default models" line="Rooms use these until you set their own in Room settings, Model." />
			<div className="settings-rows">
				{row("conversation", "Conversation")}
				{row("memory", "Memory")}
			</div>
			{remoteClient.sharedServer && <p className="cli-note">{SHARED_SERVER_ADMIN_LINE}</p>}
			{error && <p className="room-model-error" role="alert">{error}</p>}
		</div>
	);
}
