import { useEffect, useState } from "react";
import { modelDisplayName } from "../model-names";
import { useRemoteClientContext } from "../remote-client-context";
import { fetchRoomModelProviders, putRoomModels, switchConversationModel, switchRoomBusySentence, type ConversationSwitchNotice } from "../room-models-api";
import type { PersistentAgentStatus, RoomModelLock, RoomModelLockView, RoomModelProviderView, RoomModelRowView, RoomModelsView, RoomModelTask } from "../types";
import { PaneHeader } from "./pane-header";
import { RoomModelPicker } from "./room-model-picker";

// Room settings, Model: what this room talks with, and what does its memory
// work. Two rows. A row the room has not set inherits the default for new
// rooms and says so; a row is set by picking, and the picker marks each
// provider's recommended model. A model that cannot run (its provider signed
// out, or no longer offered), the room's own or the default, stays on the
// picker with the reason under it, and the room waits: nothing runs in its
// place until it is ready again or another is picked. A conversation pick applies to the next
// conversation; while one with messages is open on another model, the pane
// offers to switch it too.

const MODEL_PANE_LINE = "What this room talks with, and what does its memory work.";
const CONVERSATION_SUB = "The model this room talks with.";
const MEMORY_SUB = "Runs Remember, Memorize and Review.";

function lockOf(view: { provider: string; model: string } | null | undefined): RoomModelLock | null {
	return view ? { provider: view.provider, model: view.model } : null;
}

function sameLock(a: RoomModelLock | null | undefined, b: RoomModelLock | null | undefined): boolean {
	return !!a && !!b && a.provider === b.provider && a.model === b.model;
}

function lockName(lock: RoomModelLockView): string {
	return modelDisplayName({ model: lock.model, modelLabel: lock.label, provider: lock.provider }) || lock.name;
}

/** Why the row's model cannot run, in the pane's words. */
function unavailableSentence(row: RoomModelRowView): string | null {
	if (!row.chosen || !row.reason || row.effective) return null;
	const named = `${lockName(row.chosen)} on ${row.chosen.providerLabel}`;
	const what = row.source === "default" ? `The default, ${named},` : named;
	return row.reason === "signed-out"
		? `${what} is signed out. This room waits until you sign in again or choose another model.`
		: `${what} is no longer offered. This room waits until you choose another model.`;
}

/** onSwitched: the open conversation continues on `model`, with the line the switch wrote (the pane closes). */
export function RoomModelSection({ status, onRefresh, onSwitched }: { status: PersistentAgentStatus; onRefresh: () => void; onSwitched: (conversationId: string, model: RoomModelLockView, notice: ConversationSwitchNotice) => void }) {
	const remoteClient = useRemoteClientContext();
	const readOnly = remoteClient.remote && remoteClient.capability !== "full";
	const [providers, setProviders] = useState<RoomModelProviderView[]>([]);
	const [models, setModels] = useState<RoomModelsView | null>(status.models ?? null);
	const [saving, setSaving] = useState<RoomModelTask | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [switching, setSwitching] = useState(false);
	const [switchError, setSwitchError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		fetchRoomModelProviders().then((list) => { if (!cancelled) setProviders(list); }, () => {});
		return () => { cancelled = true; };
	}, []);
	useEffect(() => {
		if (status.models) setModels(status.models);
	}, [status.models]);

	const openConversationId = status.runtime.state !== "idle" ? status.runtime.activeThreadId : null;
	const openConversationModel = lockOf(status.runtime.model);
	const openHasMessages = status.activeThread?.hasUserVisibleTurns === true;
	const conversationEffective = lockOf(models?.conversation.effective);
	// Offered whenever a conversation with messages is open on another model
	// than the row's, however the row got there (a pick now, one made before,
	// a default that moved).
	const canOfferSwitch = !!openConversationId && openHasMessages && !!conversationEffective && !sameLock(openConversationModel, conversationEffective);
	// A scheduled run or the CLI working the room holds the switch back; the
	// pane says so instead of offering a button the server would refuse.
	const roomBusy = switchRoomBusySentence(status.activeLock);

	async function save(task: RoomModelTask, lock: RoomModelLock) {
		setSaving(task);
		setError(null);
		setSwitchError(null);
		try {
			const next = await putRoomModels(status.id, { [task]: lock });
			setModels(next);
			onRefresh();
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setSaving(null);
		}
	}

	async function switchOpenConversation() {
		if (!openConversationId || !conversationEffective) return;
		setSwitching(true);
		setSwitchError(null);
		try {
			const switched = await switchConversationModel(status.id, openConversationId, conversationEffective);
			setModels(switched.models);
			onRefresh();
			onSwitched(openConversationId, switched.model, switched.notice ?? null);
		} catch (e) {
			setSwitchError((e as Error).message);
		} finally {
			setSwitching(false);
		}
	}

	function row(task: RoomModelTask, label: string, sub: string) {
		const view = models?.[task];
		const stored = lockOf(view?.stored);
		const effective = lockOf(view?.effective);
		const inherited = !stored;
		const unavailable = view ? unavailableSentence(view) : null;
		// The model the row is set to, even while it waits: never another.
		const shown = unavailable ? lockOf(view?.chosen) : stored ?? effective;
		return (
			<div className="settings-row room-model-row">
				<div className="settings-row-main">
					<span className="settings-row-label">{label}</span>
					<span className={`settings-row-sub${unavailable ? " room-model-unavailable" : ""}`}>{unavailable ?? sub}</span>
				</div>
				<div className="settings-row-value">
					<RoomModelPicker
						providers={providers}
						task={task}
						value={shown}
						inherited={inherited}
						disabled={readOnly || saving !== null || !models}
						ariaLabel={`${label} model`}
						onPick={(lock) => void save(task, lock)}
					/>
				</div>
			</div>
		);
	}

	return (
		<div className="room-model-section">
			<PaneHeader title="Model" line={MODEL_PANE_LINE} />
			<div className="settings-rows">
				{row("conversation", "Conversation", CONVERSATION_SUB)}
				{row("memory", "Memory", MEMORY_SUB)}
			</div>
			{canOfferSwitch && (
				<div className="room-model-switch">
					<p className="room-model-switch-line">Applies to your next conversation.</p>
					{roomBusy ? (
						<p className="room-model-switch-note">{roomBusy}</p>
					) : (
						<>
							<button type="button" className="rs-btn" disabled={switching || readOnly} onClick={() => void switchOpenConversation()}>{switching ? "Switching…" : "Switch the open conversation too"}</button>
							<p className="room-model-switch-note">The first answer after a switch reads the whole conversation again.</p>
						</>
					)}
					{switchError && <p className="room-model-error" role="alert">{switchError}</p>}
				</div>
			)}
			{error && <p className="room-model-error" role="alert">{error}</p>}
		</div>
	);
}
