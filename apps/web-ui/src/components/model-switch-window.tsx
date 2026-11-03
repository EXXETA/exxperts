import { useEffect, useRef } from "react";
import { useEscapeKey } from "./use-escape-key";
import { containTab } from "./contain-tab";
import { REMEMBER_WAIT_SENTENCE } from "./remember-dialog";
import { RECENT_SESSIONS_BLOCK_CAP, recentSessionsHeadsUp, rememberFillsRoomHeadsUp } from "../remember-read";

/**
 * What the window offers. A switch: Remember, then a new conversation on the
 * model. Remember alone, with Remember's own sentence for the count, when
 * this Remember fills the room or the room is already full: a save that
 * fills the room opens no new conversation (Memorize comes first).
 */
export type ModelSwitchWindowCase = { kind: "switch" } | { kind: "remember-only"; sentence: string };

/** The window's case for the room's waiting conversations before this Remember (null: not known, as a room that never said). */
export function modelSwitchWindowCase(waitingConversations: number | null, roomName: string): ModelSwitchWindowCase {
	if (waitingConversations === null || waitingConversations + 1 < RECENT_SESSIONS_BLOCK_CAP) return { kind: "switch" };
	const sentence = waitingConversations >= RECENT_SESSIONS_BLOCK_CAP ? recentSessionsHeadsUp(waitingConversations, roomName) : rememberFillsRoomHeadsUp(waitingConversations, roomName);
	return sentence ? { kind: "remember-only", sentence } : { kind: "switch" };
}

export type ModelSwitchWindowProps = {
	modelName: string;
	roomName: string;
	/** The room answers: the window still opens, and its Remember waits under Remember's own sentence. */
	answering: boolean;
	waitingConversations: number | null;
	onCancel: () => void;
	/** "Remember and switch": Remember starts as its own button starts it, the switch kept with its job. */
	onSwitch: () => void;
	/** "Remember" alone, for a room this save fills. */
	onRemember: () => void;
};

/**
 * The first step of switching to a model the open conversation is too long
 * for: it asks, then hands over to Remember, whose screens stay as they are.
 * The click checks the room again, so an answer that ended meanwhile goes on.
 */
export function ModelSwitchWindow({ modelName, roomName, answering, waitingConversations, onCancel, onSwitch, onRemember }: ModelSwitchWindowProps) {
	const cardRef = useRef<HTMLElement | null>(null);
	const confirmRef = useRef<HTMLButtonElement | null>(null);
	const cancelRef = useRef<HTMLButtonElement | null>(null);
	useEscapeKey(onCancel);
	const shown = modelSwitchWindowCase(waitingConversations, roomName);
	// Focus is placed once, when the window opens, and goes back to where it
	// was (the model control) when it closes; Remember, opening in the same
	// commit, takes it over into its own window.
	useEffect(() => {
		const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		(answering ? cancelRef.current : confirmRef.current)?.focus();
		return () => { if (returnTo && returnTo.isConnected) returnTo.focus(); };
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	// A window that cannot switch asks no switch question.
	const title = shown.kind === "switch" ? `Switch to ${modelName}?` : `${modelName} needs a new conversation`;
	return (
		<div className="checkpoint-preview-backdrop" role="dialog" aria-modal="true" aria-label={title} onKeyDown={(event) => containTab(event, cardRef.current)}>
			<section className="checkpoint-input-card maintain-confirm-card model-switch-card" ref={cardRef} tabIndex={-1}>
				<div className="checkpoint-input-heading">
					<p className="card-kicker">Remember</p>
					<h2>{title}</h2>
					<p>{shown.kind === "switch"
						? `This conversation is too long for ${modelName}. Remember it first, then continue in a new conversation on ${modelName}.`
						: `This conversation is too long for ${modelName}. ${shown.sentence}`}</p>
				</div>
				<div className="checkpoint-preview-actions">
					{answering && <span className="proposal-approve-blocked-reason" role="status">{REMEMBER_WAIT_SENTENCE}</span>}
					<button ref={cancelRef} type="button" className="rs-btn" onClick={onCancel}>Cancel</button>
					<button ref={confirmRef} type="button" className="rs-btn rs-btn-primary" disabled={answering} title={answering ? REMEMBER_WAIT_SENTENCE : undefined} onClick={shown.kind === "switch" ? onSwitch : onRemember}>
						{shown.kind === "switch" ? "Remember and switch" : "Remember"}
					</button>
				</div>
			</section>
		</div>
	);
}
