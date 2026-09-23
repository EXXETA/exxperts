import { useEffect, useState } from "react";
import { apiFetch } from "../api";
import type { GlobalInstructionsResponse } from "../types";
import { ROOM_INSTRUCTIONS_MAX_CHARS } from "../../../web-server/src/persistent-room-instructions-text";
import { EMPTY_INSTRUCTIONS_BOX, GLOBAL_INSTRUCTIONS_PLACEHOLDER, instructionsClearLink, measureInstructionsDraft, readInstructionsReply, reduceInstructionsBox, savedAtLabel, type InstructionsBoxState } from "./instructions-pane-shared";
import { globalOutcomeAfter } from "../room-instructions-outcome";

async function fetchGlobalInstructions(): Promise<GlobalInstructionsResponse> {
	const response = await apiFetch("/api/settings/instructions");
	return readInstructionsReply<GlobalInstructionsResponse>(response, "Could not load the global instructions");
}

async function saveGlobalInstructions(text: string): Promise<GlobalInstructionsResponse> {
	const response = await apiFetch("/api/settings/instructions", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ text }),
	});
	return readInstructionsReply<GlobalInstructionsResponse>(response, "Could not save the instructions");
}

/**
 * Settings → Instructions: the one text every room follows before its own.
 * The same pane as a room's, one level up: the same counter on the same
 * shared normalization, the same refusals landing verbatim with the draft
 * intact, the same Clear that only empties the box. Which rooms follow it
 * is each room's own switch, in that room's
 * Instructions pane; this pane says so and offers no per-room control. An
 * unsaved draft is reported through onDirtyChange, the way the room's pane
 * does, so leaving Settings → Instructions asks first.
 */
export function GlobalInstructionsSection({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
	const [loaded, setLoaded] = useState<GlobalInstructionsResponse | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [reloadToken, setReloadToken] = useState(0);
	// The box and what Clear took out of it; the rule is in reduceInstructionsBox.
	const [box, setBox] = useState<InstructionsBoxState>(EMPTY_INSTRUCTIONS_BOX);
	const draft = box.draft;
	const [saving, setSaving] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setLoaded(null);
		setLoadError(null);
		setMessage(null);
		setError(null);
		fetchGlobalInstructions()
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
	}, [reloadToken]);

	const stored = loaded?.instructions.text ?? "";
	const unreadable = loaded?.instructions.unreadable ?? null;
	const maxChars = loaded?.maxChars ?? ROOM_INSTRUCTIONS_MAX_CHARS;
	const { measured, over, controls, count } = measureInstructionsDraft(draft, maxChars);
	const dirty = loaded !== null && measured !== stored;
	// A file that cannot be read shows as an empty box, and the empty draft
	// still differs from what is stored: Save replaces or removes it.
	const canSave = loaded !== null && (dirty || !!unreadable) && over === 0 && controls === 0 && !saving;
	const savedAt = savedAtLabel(loaded?.instructions.updatedAt);
	const clearLink = instructionsClearLink(box, saving);

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
			const response = await saveGlobalInstructions(text);
			setLoaded(response);
			setBox((state) => reduceInstructionsBox(state, { type: "reload", value: response.instructions.text }));
			setMessage(globalOutcomeAfter(response.instructions.text));
		} catch (e) {
			setError((e as Error).message || "Could not save the instructions.");
		} finally {
			setSaving(false);
		}
	}

	return (
		<section className="ai-setup-section room-instructions-section" aria-label="Global instructions">
			<header className="rs-pane-head">
				<h3>Global instructions</h3>
			</header>
			<p className="rs-pane-sub">
				Standing guidance for every room that has not switched them off: how to answer, what to prefer, what to avoid.
				Changes apply from the next message.
			</p>
			{loadError && (
				<div className="workspaces-error">
					{loadError}{" "}
					<button className="rs-quiet" type="button" onClick={() => setReloadToken((token) => token + 1)}>Try again</button>
				</div>
			)}
			{unreadable && (
				<div className="workspaces-error">The global instructions cannot be read right now ({unreadable}). New conversations start without them; a conversation that is already open keeps the text it started with.</div>
			)}
			<textarea
				className="launcher-path-input room-instructions-textarea"
				value={draft}
				rows={12}
				placeholder={GLOBAL_INSTRUCTIONS_PLACEHOLDER}
				aria-label="Global instructions"
				aria-describedby="global-instructions-count"
				disabled={loaded === null || saving}
				onChange={(event) => { const value = event.target.value; setBox((state) => reduceInstructionsBox(state, { type: "type", value })); setMessage(null); setError(null); }}
			/>
			<div className="room-instructions-foot">
				<span id="global-instructions-count" className={over > 0 || controls > 0 ? "room-instructions-count over" : "room-instructions-count"} aria-live="polite">{count}</span>
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
		</section>
	);
}
