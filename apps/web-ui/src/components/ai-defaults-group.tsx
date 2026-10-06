import { useEffect, useState } from "react";
import { modelDisplayName } from "../model-names";
import { useRemoteClientContext } from "../remote-client-context";
import { fetchAiDefaults, fetchRoomModelProviders, putAiDefaults } from "../room-models-api";
import type { AiDefaultsView, RoomModelLock, RoomModelLockView, RoomModelProviderView, RoomModelTask } from "../types";
import { GroupHeader } from "./pane-header";
import { RoomModelPicker } from "./room-model-picker";

// AI setup's first group: the models a room uses until it sets its own in
// Room settings, Model. The same two rows and the same picker as the pane. A
// default that cannot run (its provider signed out, or no longer offered) says
// so, and the rooms on it wait: nothing runs in its place.

function lockName(lock: RoomModelLockView): string {
	return modelDisplayName({ model: lock.model, modelLabel: lock.label, provider: lock.provider }) || lock.name;
}

function defaultUnavailableSentence(row: AiDefaultsView[RoomModelTask]): string | null {
	if (!row.stored || !row.reason || row.effective) return null;
	const named = `${lockName(row.stored)} on ${row.stored.providerLabel}`;
	return row.reason === "signed-out"
		? `${named} is signed out. Rooms on this default wait until you sign in again or choose another here.`
		: `${named} is no longer offered. Rooms on this default wait until you choose another here.`;
}

export function AiDefaultsGroup({ refreshKey }: { refreshKey?: string }) {
	const remoteClient = useRemoteClientContext();
	const readOnly = remoteClient.remote && remoteClient.capability !== "full";
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
			{error && <p className="room-model-error" role="alert">{error}</p>}
		</div>
	);
}
