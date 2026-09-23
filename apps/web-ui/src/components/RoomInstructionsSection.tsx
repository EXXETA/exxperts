import { useEffect, useState } from "react";
import { apiFetch } from "../api";
import type { PersistentAgentStatus, PersistentRoomInstructionsResponse } from "../types";
import { ROOM_INSTRUCTIONS_MAX_CHARS } from "../../../web-server/src/persistent-room-instructions-text";
import { EMPTY_INSTRUCTIONS_BOX, instructionsClearLink, measureInstructionsDraft, readInstructionsReply, reduceInstructionsBox, ROOM_INSTRUCTIONS_PLACEHOLDER, savedAtLabel, type InstructionsBoxState } from "./instructions-pane-shared";
import { outcomeAfter, switchHint } from "../room-instructions-outcome";

async function fetchInstructions(agentId: string): Promise<PersistentRoomInstructionsResponse> {
	const response = await apiFetch(`/api/persistent-agents/${encodeURIComponent(agentId)}/instructions`);
	return readInstructionsReply<PersistentRoomInstructionsResponse>(response, "Could not load this room's instructions");
}

async function saveInstructions(agentId: string, text: string): Promise<PersistentRoomInstructionsResponse> {
	const response = await apiFetch(`/api/persistent-agents/${encodeURIComponent(agentId)}/instructions`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ text }),
	});
	return readInstructionsReply<PersistentRoomInstructionsResponse>(response, "Could not save the instructions");
}

async function saveGlobalSwitch(agentId: string, enabled: boolean): Promise<PersistentRoomInstructionsResponse> {
	const response = await apiFetch(`/api/persistent-agents/${encodeURIComponent(agentId)}/instructions/global`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ enabled }),
	});
	return readInstructionsReply<PersistentRoomInstructionsResponse>(response, "Could not change the switch");
}

/**
 * Room settings → Instructions: the user's standing text for how this room
 * works. The draft lives here so it survives switching panes (the modal keeps
 * every pane mounted); the modal asks before closing over an unsaved draft
 * through onDirtyChange, the way the Workspace pane does. The counter measures
 * the draft with the server's own normalization (one shared module), so Save
 * is disabled before the server would refuse, and a refusal from the server
 * (room held by a scheduled task or a CLI session) lands here verbatim with
 * the draft intact. Clear only empties the box; Save stores the draft, and
 * the server treats an empty text as no instructions. Above the room's
 * own text sits the one per-room control
 * for the global instructions: the switch, on by default, and under
 * it the global text folded to one line, read-only, edited in Settings.
 */
export function RoomInstructionsSection({ status, onDirtyChange }: { status: PersistentAgentStatus; onDirtyChange?: (dirty: boolean) => void }) {
	const [loaded, setLoaded] = useState<PersistentRoomInstructionsResponse | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [reloadToken, setReloadToken] = useState(0);
	// The box and what Clear took out of it; the rule is in reduceInstructionsBox.
	const [box, setBox] = useState<InstructionsBoxState>(EMPTY_INSTRUCTIONS_BOX);
	const draft = box.draft;
	const [saving, setSaving] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [switching, setSwitching] = useState(false);
	const [globalOpen, setGlobalOpen] = useState(false);

	useEffect(() => {
		let cancelled = false;
		setLoaded(null);
		setLoadError(null);
		setMessage(null);
		setError(null);
		fetchInstructions(status.id)
			.then((response) => {
				if (cancelled) return;
				setLoaded(response);
				setBox((state) => reduceInstructionsBox(state, { type: "reload", value: response.instructions.text }));
			})
			.catch((e) => {
				if (!cancelled) setLoadError((e as Error).message);
			});
		return () => {
			cancelled = true;
		};
	}, [status.id, reloadToken]);

	const stored = loaded?.instructions.text ?? "";
	const unreadable = loaded?.instructions.unreadable ?? null;
	const maxChars = loaded?.maxChars ?? ROOM_INSTRUCTIONS_MAX_CHARS;
	const { measured, over, controls, count } = measureInstructionsDraft(draft, maxChars);
	const dirty = loaded !== null && measured !== stored;
	// A file that cannot be read shows as an empty box, and the empty draft
	// still differs from what is stored: Save replaces or removes it.
	const canSave = loaded !== null && (dirty || !!unreadable) && over === 0 && controls === 0 && !saving && !switching;
	const savedAt = savedAtLabel(loaded?.instructions.updatedAt);
	const clearLink = instructionsClearLink(box, saving);
	// The global text and this room's switch, as the server reports them.
	// An older server reports neither; then the row says so and offers nothing.
	const global = loaded?.global ?? null;
	const globalEnabled = global?.enabled ?? true;
	const globalText = global?.instructions.text ?? "";
	const globalUnreadable = global?.instructions.unreadable ?? null;
	const globalHint = switchHint(loaded);

	useEffect(() => {
		onDirtyChange?.(dirty);
	}, [dirty, onDirtyChange]);
	useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

	async function submit(text: string): Promise<void> {
		setSaving(true);
		setBox((state) => reduceInstructionsBox(state, { type: "save" }));
		setError(null);
		setMessage(null);
		try {
			const response = await saveInstructions(status.id, text);
			setLoaded(response);
			setBox((state) => reduceInstructionsBox(state, { type: "reload", value: response.instructions.text }));
			setMessage(outcomeAfter(response, response.instructions.text ? "save" : "saveEmpty"));
		} catch (e) {
			// The server's sentence carries the remedy (wait for the scheduled
			// task, close the CLI session, shorten the text); the draft stays.
			setError((e as Error).message || "Could not save the instructions.");
		} finally {
			setSaving(false);
		}
	}

	// The switch saves on the flip and re-renders from the view the server
	// returns; the room's draft is not touched by it. A refusal (the room held
	// by a scheduled task or a CLI session) lands as the error line.
	async function flipGlobal(enabled: boolean): Promise<void> {
		setSwitching(true);
		setError(null);
		setMessage(null);
		try {
			const response = await saveGlobalSwitch(status.id, enabled);
			setLoaded(response);
			setMessage(outcomeAfter(response, enabled ? "on" : "off"));
		} catch (e) {
			setError((e as Error).message || "Could not change the switch.");
		} finally {
			setSwitching(false);
		}
	}

	return (
		<div className="room-instructions-section">
			<header className="rs-pane-head">
				<h3>Instructions</h3>
			</header>
			<p className="rs-pane-sub">
				Standing guidance this room follows in every conversation: how to answer, what to prefer, what to avoid.
				Changes apply from the next message.
			</p>
			{loadError && (
				<div className="workspaces-error">
					{loadError}{" "}
					<button className="rs-quiet" type="button" onClick={() => setReloadToken((token) => token + 1)}>Try again</button>
				</div>
			)}
			<label className="workspaces-tool-row room-instructions-global-row">
				<span className="room-instructions-global-main">
					<span className="room-instructions-global-title">Use the global instructions in this room</span>
					{globalHint && <span className="rs-row-hint">{globalHint}</span>}
				</span>
				<input
					className="workspaces-tool-switch"
					type="checkbox"
					checked={globalEnabled}
					disabled={loaded === null || !global || switching || saving}
					onChange={() => void flipGlobal(!globalEnabled)}
					aria-label="Use the global instructions in this room"
				/>
			</label>
			{global && globalEnabled && globalText && !globalUnreadable && (
				<div className="room-instructions-global">
					<button type="button" className="approval-details-toggle room-instructions-global-toggle" aria-expanded={globalOpen} aria-controls="room-instructions-global-text" onClick={() => setGlobalOpen((open) => !open)}>
						{globalOpen ? "Hide" : "Show"} the global instructions, {globalText.length.toLocaleString()} characters
					</button>
					{globalOpen && (
						<>
							<pre id="room-instructions-global-text" className="room-instructions-global-text">{globalText}</pre>
							<p className="rs-row-footnote">Read-only here. Edit in Settings → Instructions.</p>
						</>
					)}
				</div>
			)}
			{unreadable && (
				<div className="workspaces-error">This room's instructions cannot be read right now ({unreadable}). New conversations start without them; a conversation that is already open keeps the text it started with.</div>
			)}
			<textarea
				className="launcher-path-input room-instructions-textarea"
				value={draft}
				rows={12}
				placeholder={ROOM_INSTRUCTIONS_PLACEHOLDER}
				aria-label="Room instructions"
				aria-describedby="room-instructions-count"
				disabled={loaded === null || saving}
				onChange={(event) => { const value = event.target.value; setBox((state) => reduceInstructionsBox(state, { type: "type", value })); setMessage(null); setError(null); }}
			/>
			<div className="room-instructions-foot">
				<span id="room-instructions-count" className={over > 0 || controls > 0 ? "room-instructions-count over" : "room-instructions-count"} aria-live="polite">{count}</span>
				<div className="rs-pane-actions">
					{clearLink && (
						<button className="rs-quiet" type="button" disabled={clearLink.disabled} onClick={() => { setBox((state) => reduceInstructionsBox(state, { type: "link" })); setMessage(null); setError(null); }}>{clearLink.label}</button>
					)}
					<button className="rs-btn" type="button" disabled={!canSave} onClick={() => void submit(measured)}>{saving ? "Saving…" : "Save"}</button>
				</div>
			</div>
			{savedAt && !dirty && <p className="rs-row-footnote">Last saved {savedAt}.</p>}
			{dirty && !saving && <p className="rs-row-footnote">Unsaved changes.</p>}
			{message && <div className="workspaces-success">{message}</div>}
			{error && <div className="workspaces-error">{error}</div>}
		</div>
	);
}
