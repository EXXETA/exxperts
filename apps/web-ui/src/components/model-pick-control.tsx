import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { modelDisplayName } from "../model-names";
import { fetchConversationModelOptions, fetchRoomModelProviders, type ConversationModelOption, type EffortRung } from "../room-models-api";
import { sharedServerRole, useRemoteClientContext } from "../remote-client-context";
import type { RoomModelLock, RoomModelProviderView } from "../types";
import { effortDisplayName, EffortSlider, SpeedometerIcon } from "./EffortControl";
import { ChevronDownIcon } from "./icons";
import { containTab } from "./contain-tab";
import { useEscapeKey } from "./use-escape-key";
import { contextWindowShort, lockKey, ModelCheckIcon, noModelsLine, offeredModelGroups } from "./room-model-picker";

/**
 * The mark a model's row carries, from the server's read for the open
 * conversation: none when this conversation switches onto it in place (even
 * when a new conversation would not fit, since an open conversation keeps its
 * own memory snapshot); "new-conversation" when this conversation is too long
 * for it but a new one fits; "too-small" when neither fits. A model the read
 * does not name carries none: the switch route checks it again and refuses
 * with its own sentence.
 */
export type ModelMark = "none" | "new-conversation" | "too-small";

export function modelMarkOf(option: Pick<ConversationModelOption, "fits" | "freshFits"> | undefined): ModelMark {
	if (!option || option.fits) return "none";
	return option.freshFits ? "new-conversation" : "too-small";
}

/** A too-small model's reason: the row's hover text only, never a line in the list. */
export const TOO_SMALL_REASON = "Too small for this room: even a new conversation here does not fit in its context window.";

type EffortState = { level: string; ladder: EffortRung[] };

/**
 * What the panel last read: the offered models (names and groups) and how
 * the open conversation stands against each. A refresh that fails after a
 * good read keeps that list and says so, with Try again.
 */
type PanelRead =
	| { state: "loading" }
	| { state: "failed"; message: string }
	| { state: "ready"; providers: RoomModelProviderView[]; options: ConversationModelOption[]; refreshFailed?: string };

export type ModelPickControlProps = {
	/** Under the message box on wider screens; under the room's name in the phone's header, where the panel is a bottom sheet. */
	placement: "row" | "header";
	agentId: string;
	conversationId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The model the open conversation runs on. */
	current: RoomModelLock & { label?: string };
	/** The server's name for the model the conversation runs, used until the providers list names it. */
	currentName?: string;
	/** A pick not yet confirmed by the room: shown as the conversation's model until the switch lands or is refused, with the level set on its dial meanwhile. */
	held: (RoomModelLock & { level?: string }) | null;
	/** The conversation's effort on the model it runs, as the room's socket reports it. */
	effort: EffortState | null;
	/** The effort travels on the room's socket; the model pick does not. */
	effortDisabled: boolean;
	onPick: (lock: RoomModelLock) => void;
	onEffort: (level: string) => void;
	/** A model this conversation is too long for: the window that remembers and switches. */
	onTooLong: (lock: RoomModelLock, name: string) => void;
};

/** The panel's two views: the effort with the model's name, and the models behind that name. */
type PanelView = "effort" | "models";

function ChevronIcon({ towards }: { towards: "left" | "right" }) {
	return (
		<svg className="ui-icon" width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
			<path d={towards === "right" ? "M6.4 3.8L10.6 8l-4.2 4.2" : "M9.6 3.8L5.4 8l4.2 4.2"} />
		</svg>
	);
}

/** An effort worth a slider: two rungs or more. */
function withRungs(effort: EffortState | null | undefined): EffortState | null {
	return effort && effort.ladder.length >= 2 ? effort : null;
}

/**
 * The conversation's model and effort: a quiet control with the model's name
 * and a speedometer whose needle stands on the effort ("Opus 5.5 ⏲"; the
 * name alone for a model with one rung), and its panel in two views. The
 * effort view: that speedometer opened up into a dial over the model's
 * rungs, the level's name under its hub, then the model's name with its
 * context window as a button. The model's name turns the panel into the
 * models view: the offered models as Room settings groups them, with a check
 * on the one in use, each one's context window and the mark the server's read
 * gives it. A model with one rung has no effort view.
 */
export function ModelPickControl({ placement, agentId, conversationId, open, onOpenChange, current, currentName, held, effort, effortDisabled, onPick, onEffort, onTooLong }: ModelPickControlProps) {
	const [read, setRead] = useState<PanelRead>({ state: "loading" });
	const [readAsk, setReadAsk] = useState(0);
	// The effort the slider's thumb is being dragged over, so the title follows it.
	const [previewLevel, setPreviewLevel] = useState<string | null>(null);
	const [view, setView] = useState<PanelView>("effort");
	// Where focus goes once a view change has drawn: into the list, or back to the model's name.
	const focusAfterView = useRef<"list" | "name" | null>(null);
	const rootRef = useRef<HTMLDivElement | null>(null);
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const panelRef = useRef<HTMLDivElement | null>(null);
	const sliderRef = useRef<HTMLDivElement | null>(null);
	const backdropRef = useRef<HTMLDivElement | null>(null);
	const modelNameRef = useRef<HTMLButtonElement | null>(null);
	const backRef = useRef<HTMLButtonElement | null>(null);
	const aiSetupRole = sharedServerRole(useRemoteClientContext());

	// Read on mount for the control's names, and again on every open, so a
	// provider signed in meanwhile and the conversation's new length show
	// without a reload. Closing reads nothing: what it would bring shows nowhere.
	// A read belongs to its conversation: another conversation (the new one
	// after Remember) never shows the last one's fits, not even when its own
	// read fails.
	const readFor = useRef<string | null>(null);
	useEffect(() => {
		const key = `${agentId}\n${conversationId}`;
		if (!open && readFor.current === key) return;
		if (readFor.current !== null && readFor.current !== key) setRead({ state: "loading" });
		readFor.current = key;
		let cancelled = false;
		Promise.all([fetchRoomModelProviders(), fetchConversationModelOptions(agentId, conversationId)]).then(
			([providers, options]) => { if (!cancelled) setRead({ state: "ready", providers, options }); },
			(e) => {
				if (cancelled) return;
				const message = (e as Error).message;
				setRead((last) => (last.state === "ready" ? { ...last, refreshFailed: message } : { state: "failed", message }));
			},
		);
		return () => { cancelled = true; };
	}, [agentId, conversationId, open, readAsk]);


	const groups = read.state === "ready" ? offeredModelGroups(read.providers, "conversation") : [];
	const options = read.state === "ready" ? read.options : [];
	const optionOf = (lock: RoomModelLock) => options.find((option) => lockKey(option) === lockKey(lock));
	const rowOf = (lock: RoomModelLock) => groups.find((group) => group.provider.id === lock.provider)?.rows.find((row) => row.option.model === lock.model);
	const chosen = held ?? current;
	const chosenKey = lockKey(chosen);
	const chosenOffered = Boolean(rowOf(chosen));
	const chosenName = rowOf(chosen)?.name ?? (!held && currentName ? currentName : undefined) ?? modelDisplayName({ model: chosen.model, modelLabel: held ? undefined : current.label, provider: chosen.provider });
	// A held pick shows the level set on its dial, else the conversation's
	// effort as the picked model would run it, from the server's read; the
	// model in use shows what its socket reports, and the read until the socket has.
	const heldEffort = held && optionOf(held)?.effort;
	const shownEffort = withRungs(held ? heldEffort && { ...heldEffort, level: held.level ?? heldEffort.level } : effort ?? optionOf(current)?.effort);
	const rungIndex = shownEffort ? Math.max(0, shownEffort.ladder.findIndex((rung) => rung.level === shownEffort.level)) : 0;
	const effortWordOf = (level: string) => effortDisplayName(shownEffort?.ladder.find((rung) => rung.level === level)?.label ?? level);
	const effortWord = shownEffort ? effortWordOf(shownEffort.level) : null;
	const titleWord = shownEffort ? effortWordOf(previewLevel ?? shownEffort.level) : null;
	// A model with one rung (or no effort read yet) has nothing to set: the panel is the models alone.
	const shownView: PanelView = shownEffort ? view : "models";
	const backToEffortView = shownView === "models" && shownEffort !== null;

	function close(returnFocus: boolean): void {
		if (returnFocus) triggerRef.current?.focus();
		onOpenChange(false);
	}

	function showModels(): void {
		focusAfterView.current = "list";
		setView("models");
	}
	function showEffort(): void {
		focusAfterView.current = "name";
		setView("effort");
	}

	useEffect(() => {
		if (!open) return;
		function onPointerDown(event: PointerEvent) {
			const target = event.target as Node;
			if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return;
			// The phone's backdrop closes a modal sheet, so focus goes back to the
			// header control: after the tap's own mousedown, which lands once the
			// sheet is gone and would otherwise take the focus to the page.
			if (target === backdropRef.current) { close(false); window.setTimeout(() => triggerRef.current?.focus(), 0); return; }
			close(false);
		}
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);
	// Escape steps back from the models to the effort view, then closes; as the top layer only.
	useEscapeKey(() => (backToEffortView ? showEffort() : close(true)), open);

	// The slider, or the model's name while the slider is off.
	function focusDial(): void {
		((effortDisabled ? null : sliderRef.current) ?? modelNameRef.current ?? panelRef.current)?.focus();
	}

	// The model in use, else the first model; while the list still loads, the
	// back arrow, or the panel itself, so the keys never stay behind the phone's sheet.
	function focusList(): void {
		const panel = panelRef.current;
		(panel?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]') ?? panel?.querySelector<HTMLElement>('[role="option"]') ?? backRef.current ?? panel)?.focus();
	}

	// Every open starts on the effort view, focus on the slider (on the model's
	// name while the slider is off), or on the models alone for a one-rung
	// model. A model in use that is no longer offered opens on the models: the
	// person came to choose another.
	useEffect(() => {
		if (!open) { setView("effort"); focusAfterView.current = null; return; }
		if (shownView === "effort" && read.state === "ready" && !chosenOffered) { showModels(); return; }
		if (shownView === "effort") focusDial();
		else focusList();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	// A change of the view drawn moves focus once it has drawn: into the list
	// on the way in, back to the model's name on the way out. It follows the
	// view drawn, not the one stored: a pick from a one-rung model's list
	// draws the effort view without the stored view changing. A view that
	// changed by itself (the effort read arriving) takes focus only when the
	// focused element went with the old one.
	useEffect(() => {
		const pending = focusAfterView.current;
		focusAfterView.current = null;
		if (!open) return;
		const lost = !panelRef.current?.contains(document.activeElement);
		const target = pending ?? (lost ? (shownView === "effort" ? "name" : "list") : null);
		if (target === "list") focusList();
		else if (target === "name") (modelNameRef.current ?? panelRef.current)?.focus();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [shownView]);

	// The dial is the chosen model's: another model gets a new slider, so a drag
	// begun on the last one (a pick refused under the pointer) ends there and
	// reaches no model. Nor does a drag left mid-way outlive the panel.
	useEffect(() => { setPreviewLevel(null); }, [open, chosenKey]);
	useEffect(() => {
		if (open && shownView === "effort" && !panelRef.current?.contains(document.activeElement)) focusDial();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [chosenKey]);

	// Up and Down move through the models, Home and End to the ends, as Room settings' picker.
	function onListKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
		const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]'));
		const at = rows.indexOf(document.activeElement as HTMLElement);
		const target = event.key === "ArrowDown" ? rows[Math.min(rows.length - 1, at + 1)]
			: event.key === "ArrowUp" ? rows[Math.max(0, at - 1)]
			: event.key === "Home" ? rows[0]
			: event.key === "End" ? rows[rows.length - 1]
			: undefined;
		if (!target) return;
		event.preventDefault();
		target.focus();
	}

	// Try again goes away as the read starts: focus waits on the panel, so the
	// keys never fall behind the phone's sheet, and moves on once the read settles.
	const focusAfterRead = useRef(false);
	useEffect(() => {
		if (!focusAfterRead.current || read.state === "loading") return;
		focusAfterRead.current = false;
		if (!open || document.activeElement !== panelRef.current) return;
		if (shownView === "effort") (modelNameRef.current ?? panelRef.current)?.focus();
		else focusList();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [read]);
	const tryAgain = (
		<button className="rs-btn" type="button" onClick={() => {
			focusAfterRead.current = true;
			panelRef.current?.focus();
			if (read.state === "failed") setRead({ state: "loading" });
			setReadAsk((ask) => ask + 1);
		}}>Try again</button>
	);
	const listBody: ReactNode = read.state === "loading"
		? <p className="model-pick-list-note" role="status">Loading models…</p>
		: read.state === "failed"
		? <div className="room-model-error model-pick-list-note" role="alert">{read.message}{" "}{tryAgain}</div>
		: [read.refreshFailed && (
			<div key="refresh-failed" className="room-model-error model-pick-list-note" role="alert">{read.refreshFailed}{" "}{tryAgain}</div>
		), ...(groups.length === 0 ? [<p key="no-models" className="model-pick-list-note">{noModelsLine(aiSetupRole)}</p>] : groups.map(({ provider, rows }) => (
			<div key={provider.id} className="model-pick-group" role="group" aria-label={provider.label}>
				<p className="room-model-menu-kicker">{provider.label}</p>
				{rows.map(({ option, name }, index) => {
					const key = lockKey(option);
					const selected = chosenKey === key;
					// The list keeps one tab stop: the model in use, or the first row when it is not offered.
					const tabStop = selected || (index === 0 && groups[0]?.provider.id === provider.id && !chosenOffered);
					// The model the conversation runs on needs no fit check: picking it
					// while another pick waits only takes that pick back.
					const mark: ModelMark = selected || lockKey(current) === key ? "none" : modelMarkOf(optionOf(option));
					// After a pick the effort view shows the model picked: its own rungs
					// from the read, or the socket's when the pick takes a held one back.
					const pickedEffort = withRungs(lockKey(current) === key ? effort ?? optionOf(option)?.effort : optionOf(option)?.effort);
					return (
						<button
							key={key}
							type="button"
							role="option"
							aria-selected={selected}
							aria-disabled={mark === "too-small" || undefined}
							tabIndex={tabStop ? 0 : -1}
							className={`model-pick-row${selected ? " is-current" : ""}${mark === "none" ? "" : " is-greyed"}`}
							title={mark === "too-small" ? TOO_SMALL_REASON : undefined}
							onClick={() => {
								if (mark === "too-small") return;
								if (mark === "new-conversation") { close(true); onTooLong({ provider: option.provider, model: option.model }, name); return; }
								// The model in use is picked again too: an empty conversation keeps it then. A held pick picked again needs nothing.
								if (!selected || lockKey(current) === key) onPick({ provider: option.provider, model: option.model });
								// Back to the effort view of the model picked; one with a single rung has none, so the panel closes.
								if (pickedEffort) showEffort();
								else close(true);
							}}
						>
							<span className="model-pick-check">{selected && <ModelCheckIcon />}</span>
							<span className="model-pick-row-name">{name}</span>
							{option.recommended && <span className="room-model-option-tag">Recommended</span>}
							<span className="model-pick-row-end">
								{mark === "new-conversation" && <span className="model-pick-row-hint">New conversation</span>}
								{mark === "too-small" && <span className="model-pick-row-hint">Too small</span>}
								{/* A figure for the eye: the row's accessible name stays the model's. */}
								{contextWindowShort(option.contextWindow) && <span className="model-pick-row-context" aria-hidden="true">{contextWindowShort(option.contextWindow)}</span>}
							</span>
						</button>
					);
				})}
			</div>
		)))];

	const chosenContext = contextWindowShort(rowOf(chosen)?.option.contextWindow);
	const panelBody = shownView === "effort" && shownEffort && titleWord ? (
		<div className="model-pick-effort">
			{/* The slider's own name says it to a screen reader. */}
			<p className="model-pick-effort-kicker" aria-hidden="true">Effort</p>
			<div className="model-pick-effort-dial">
				{/* Drawn under the dial's hub; it follows a drag before the slider's value does.
				    It takes a press itself, so a press on the word never reaches the dial, and
				    keeps the focus where it was (on the slider). */}
				<p className="model-pick-effort-title" onMouseDown={(event) => event.preventDefault()}>{titleWord}</p>
				<EffortSlider key={chosenKey} level={shownEffort.level} ladder={shownEffort.ladder} disabled={effortDisabled} onSelect={onEffort} onPreview={setPreviewLevel} sliderRef={sliderRef} />
			</div>
			<button ref={modelNameRef} type="button" className="model-pick-effort-model" aria-label={`Models: ${chosenName}`} onClick={showModels}>
				<span className="model-pick-effort-model-name">{chosenName}</span>
				{chosenContext && <span className="model-pick-row-context" aria-hidden="true">{chosenContext}</span>}
				<ChevronIcon towards="right" />
			</button>
		</div>
	) : (
		<>
			<div className="model-pick-list-head">
				{shownEffort && (
					<button ref={backRef} type="button" className="model-pick-back" aria-label="Back" onClick={showEffort}>
						<ChevronIcon towards="left" />
					</button>
				)}
				<span className="model-pick-list-title">Models</span>
			</div>
			<div className="model-pick-list" role="listbox" aria-label="Models" onKeyDown={onListKeyDown}>{listBody}</div>
		</>
	);

	const triggerLabel = effortWord ? `Model and effort: ${chosenName} ${effortWord}` : `Model: ${chosenName}`;
	// Tab stays inside the panel on both placements: it moves between the
	// slider and the model's name, and between the list and Back.
	const keepTab = (event: ReactKeyboardEvent) => containTab(event, panelRef.current);
	return (
		<div className={`model-pick-control model-pick-in-${placement}`} ref={rootRef}>
			<button
				ref={triggerRef}
				type="button"
				className="model-pick-trigger"
				aria-label={triggerLabel}
				title={triggerLabel}
				aria-haspopup="dialog"
				aria-expanded={open}
				onClick={() => (open ? close(false) : onOpenChange(true))}
			>
				<span className="model-pick-trigger-name">{chosenName}</span>
				{/* The needle is the effort on screen; the word stays in the label for a screen reader. */}
				{shownEffort && <SpeedometerIcon index={rungIndex} count={shownEffort.ladder.length} />}
				{placement === "header" && <ChevronDownIcon size={12} />}
			</button>
			{open && placement === "row" && (
				<div className="model-pick-panel" role="dialog" aria-label="Model and effort" ref={panelRef} tabIndex={-1} onKeyDown={keepTab}>{panelBody}</div>
			)}
			{open && placement === "header" && createPortal(
				<>
					<div className="model-pick-sheet-backdrop" aria-hidden="true" ref={backdropRef} />
					{/* The phone's sheet covers the room, so it is modal: closing gives focus back to the header control. */}
					<div className="model-pick-panel model-pick-sheet" role="dialog" aria-modal="true" aria-label="Model and effort" ref={panelRef} tabIndex={-1} onKeyDown={keepTab}>{panelBody}</div>
				</>,
				document.body,
			)}
		</div>
	);
}
