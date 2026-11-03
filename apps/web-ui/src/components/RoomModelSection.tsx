import { useEffect, useState } from "react";
import { credentialGoneWhy, credentialGoneWords, modelCredentialWords, providerCredentialClause, sharedCredentialState } from "../../../web-server/src/model-not-offered";
import { providerAccountName } from "../../../web-server/src/model-not-on-account";
import { modelDisplayName, modelOnProvider } from "../model-names";
import { sharedServerRole, useRemoteClientContext } from "../remote-client-context";
import { fetchRoomModelProviders, keyRefusalGone, keyRefusalMarks, putRoomModels, type KeyRefusal } from "../room-models-api";
import type { PersistentAgentStatus, RoomModelLock, RoomModelLockView, RoomModelProviderView, RoomModelRowView, RoomModelsView, RoomModelTask } from "../types";
import { offersCredentialButton } from "./model-notice";
import { PaneHeader } from "./pane-header";
import { RoomModelPicker, useKeyRefusals } from "./room-model-picker";

// Room settings, Model: what this room talks with, and what does its memory
// work. Two rows. A row the room has not set inherits the default for new
// rooms and says so; a row is set by picking, and the picker marks each
// provider's recommended model. "Default (<model>)" first in the list clears
// the room's own pick, so the row follows the default again. A model that cannot run (its provider signed
// out, or no longer offered), the room's own or the default, stays on the
// picker with the reason under it, and the room waits: nothing runs in its
// place until it is ready again or another is picked. A model whose provider
// refused the saved key at the last call (or found its sign-in gone) gets an
// amber line under its row, with the way to AI setup when the caller can open
// it, and is muted in the picker. A conversation pick is the default for new
// conversations; an open one changes its own model in the message box.

const MODEL_PANE_LINE = "What this room talks with, and what does its memory work.";
const CONVERSATION_SUB = "Default for new conversations.";
const MEMORY_SUB = "Runs Remember, Memorize and Review.";
/** A Memory model too small for this room's memory, greyed out in the picker (drafts). */
const TOO_SMALL_REASON = "Too small for this room's memory";
const TOO_SMALL_LINE = "A Memory model must read all of this room's memory at once. To use a smaller one, lower the memory budget in Memory.";

function lockOf(view: { provider: string; model: string } | null | undefined): RoomModelLock | null {
	return view ? { provider: view.provider, model: view.model } : null;
}

function lockName(lock: RoomModelLockView): string {
	return modelDisplayName({ model: lock.model, modelLabel: lock.label, provider: lock.provider }) || lock.name;
}

/** Why the row's model cannot run, in the pane's words. */
function unavailableSentence(row: RoomModelRowView, task: RoomModelTask): string | null {
	if (!row.chosen || !row.reason || row.effective) return null;
	const named = modelOnProvider(lockName(row.chosen), row.chosen.providerLabel);
	const gone = row.keyGone ? "key-missing" : "signed-out";
	const words = row.reason === "signed-out" ? modelCredentialWords(lockName(row.chosen), row.chosen.providerLabel, named, gone) : { subject: named, state: "is no longer offered" };
	const what = row.source === "default" ? `The default, ${words.subject},` : words.subject;
	return row.reason === "signed-out"
		? `${what} ${words.state}. This room waits until you ${credentialGoneWords(gone).again.toLowerCase()} or choose another model.`
		: `${what} is no longer offered. This room waits until you choose another ${task === "memory" ? "Memory model" : "model"}.`;
}

/**
 * The amber line under a row whose provider's last call was refused for the
 * saved credential, as the room's own notice words it: a refused key is the
 * service's ("Anthropic did not accept the saved key"). `button` is the way to
 * AI setup (Replace key, Sign in), null where this person has none there;
 * `role` is sharedServerRole's.
 */
function refusedLine(lock: RoomModelLockView, refusal: KeyRefusal, role: "member" | "admin" | null): { text: string; button: string | null } {
	const gone = keyRefusalGone(refusal);
	const button = offersCredentialButton(role, gone === "signed-out") ? credentialGoneWords(gone).button : null;
	const subject = (gone === "key-refused" || !button ? providerAccountName(lock.provider) : undefined) ?? lock.providerLabel;
	const cause = gone === "key-no-workspace" ? `${lockName(lock)} ${credentialGoneWhy(gone)}` : role && !button ? `${subject} ${sharedCredentialState(gone)}` : providerCredentialClause(subject, gone);
	return { text: `${cause}.${button ? "" : ` Choose another model${role === "member" ? ", or tell your admin" : ""}.`}`, button };
}

/**
 * onOpenAiSetup: opens Settings, AI setup at a provider's row; without it, a refused key's line offers no Replace key.
 */
export function RoomModelSection({ status, onRefresh, onOpenAiSetup }: { status: PersistentAgentStatus; onRefresh: () => void; onOpenAiSetup?: (providerId: string) => void }) {
	const remoteClient = useRemoteClientContext();
	const readOnly = remoteClient.remote && remoteClient.capability !== "full";
	const role = sharedServerRole(remoteClient);
	const [providers, setProviders] = useState<RoomModelProviderView[]>([]);
	// A failed read of the models to offer says why, with a way to ask again;
	// the pickers wait meanwhile, since an empty list would say no provider is signed in.
	const [providersError, setProvidersError] = useState<string | null>(null);
	const [providersAsk, setProvidersAsk] = useState(0);
	// Read again each time a picker opens, and when the person comes back to
	// this window: a key replaced in another one clears the line under its row
	// with nothing reopened.
	const { refusals, refresh: refreshRefusals } = useKeyRefusals();
	useEffect(() => {
		const recheck = () => { if (document.visibilityState === "visible") refreshRefusals(); };
		window.addEventListener("focus", recheck);
		document.addEventListener("visibilitychange", recheck);
		return () => {
			window.removeEventListener("focus", recheck);
			document.removeEventListener("visibilitychange", recheck);
		};
	}, [refreshRefusals]);
	// "Choose another" opens its row's picker.
	const [chooseAsk, setChooseAsk] = useState<Record<RoomModelTask, number>>({ conversation: 0, memory: 0 });
	const [models, setModels] = useState<RoomModelsView | null>(status.models ?? null);
	const [saving, setSaving] = useState<RoomModelTask | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		fetchRoomModelProviders().then((list) => {
			if (cancelled) return;
			setProviders(list);
			setProvidersError(null);
		}, (e) => { if (!cancelled) setProvidersError((e as Error).message); });
		return () => { cancelled = true; };
	}, [providersAsk]);
	useEffect(() => {
		if (status.models) setModels(status.models);
	}, [status.models]);

	async function save(task: RoomModelTask, lock: RoomModelLock | null) {
		setSaving(task);
		setError(null);
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

	const marks = keyRefusalMarks(refusals);

	function row(task: RoomModelTask, label: string, sub: string) {
		const view = models?.[task];
		const stored = lockOf(view?.stored);
		const inherited = !stored;
		const unavailable = view ? unavailableSentence(view, task) : null;
		// The model the row is set to, even while it waits: never another.
		const shownView = (unavailable ? view?.chosen : view?.stored ?? view?.effective) ?? null;
		const shown = lockOf(shownView);
		const fallback = view?.default ?? null;
		const tooSmall = new Map((view?.tooSmall ?? []).map((lock) => [`${lock.provider}/${lock.model}`, TOO_SMALL_REASON]));
		const refusal = shownView && !unavailable ? refusals.get(shownView.provider) : undefined;
		const refused = shownView && refusal ? refusedLine(shownView, refusal, role) : null;
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
						disabled={readOnly || saving !== null || !models || providersError !== null}
						ariaLabel={`${label} model`}
						unpickable={tooSmall}
						unpickableLine={TOO_SMALL_LINE}
						providerMarks={marks}
						defaultChoice={fallback ? { name: lockName(fallback), reason: tooSmall.get(`${fallback.provider}/${fallback.model}`), mark: marks.get(fallback.provider), onPick: () => void save(task, null) } : undefined}
						openRequest={chooseAsk[task]}
						onOpen={refreshRefusals}
						onPick={(lock) => void save(task, lock)}
					/>
				</div>
				{/* Under the whole row, so on a phone it follows the model button it is about. */}
				{refused && shownView && (
					<div className="room-model-refused" role="status">
						<span>{refused.text}</span>
						{!readOnly && (
							<span className="room-model-refused-actions">
								{refused.button && onOpenAiSetup && <button type="button" className="rs-btn" onClick={() => onOpenAiSetup(shownView.provider)}>{refused.button}</button>}
								<button type="button" className="rs-btn" disabled={saving !== null || !models || providersError !== null} onClick={() => setChooseAsk((ask) => ({ ...ask, [task]: ask[task] + 1 }))}>Choose another</button>
							</span>
						)}
					</div>
				)}
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
			{providersError && (
				<div className="room-model-error" role="alert">
					{providersError}{" "}
					<button className="rs-btn" type="button" onClick={() => setProvidersAsk((ask) => ask + 1)}>Try again</button>
				</div>
			)}
			{error && <p className="room-model-error" role="alert">{error}</p>}
		</div>
	);
}
