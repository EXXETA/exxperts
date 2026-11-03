import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { distinctModelNames, modelDisplayName } from "../model-names";
import { fetchKeyRefusals, type KeyRefusal } from "../room-models-api";
import type { RoomModelLock, RoomModelProviderView, RoomModelTask, WebChatModelOption } from "../types";
import { sharedServerRole, useRemoteClientContext } from "../remote-client-context";

// The model picker of a room's Model pane and of the defaults for new rooms;
// the message box's model control lists the same groups. One list grouped by provider, only providers that are signed in
// or hold a key, in AI setup's order; each model a row with its name, and
// "Recommended" on the provider's recommended one. Nothing about effort: that
// is the composer's dial. The trigger names the model, with the provider as a
// muted suffix when more than one provider is ready. The list is portaled to
// the page (the settings dialog scrolls and its backdrop would capture a fixed
// layer), placed under the trigger or above it when the space below is short;
// on a phone it opens as a full-width sheet. A model the caller marks
// unpickable stays in the list, greyed out with its reason, and picks nothing;
// the caller's line then explains it under the list. A provider the caller
// marks (its saved key refused at the last call) has its models muted with the
// mark, still pickable: the mark is the last call's, and the row says so again
// once picked.

export type RoomModelPickerProps = {
	providers: RoomModelProviderView[];
	/** Which list: the models rooms talk with, or the models memory work may use. */
	task: RoomModelTask;
	/** The model the trigger names. */
	value: RoomModelLock | null;
	/** The trigger's text when the value is inherited ("Default · …"), muted. */
	inherited?: boolean;
	/** Read-only (a remote device that may only read). */
	disabled?: boolean;
	ariaLabel: string;
	/** Models that stay in the list greyed out, each with its reason, keyed `provider/model`. */
	unpickable?: Map<string, string>;
	/** The line under the list while any model is greyed out. */
	unpickableLine?: string;
	/** Providers whose models show muted with a mark ("Key refused") and stay pickable, keyed by provider id. */
	providerMarks?: Map<string, string>;
	/** A room's row: "Default (<name>)" first in the list, which clears the room's own pick; its reason when it cannot be picked, its mark when its provider has one. */
	defaultChoice?: { name: string; reason?: string; mark?: string; onPick: () => void };
	/** Opens the list each time it changes (a "Choose another" beside the row). */
	openRequest?: number;
	/** Told each time the list opens (the caller reads the refusals again). */
	onOpen?: () => void;
	onPick: (lock: RoomModelLock) => void;
};

/** A model's context window, short, as every model menu shows it at a row's right: "1M", "128K", "4K". */
export function contextWindowShort(tokens: number | undefined): string | null {
	if (!tokens || tokens <= 0) return null;
	if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
	return `${Math.round(tokens / 1000)}K`;
}

/** The tick on the chosen model, in every model menu. */
export function ModelCheckIcon() {
	return (
		<svg className="ui-icon" width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
			<path d="M3.5 8.4l2.9 2.9 6.1-6.6" />
		</svg>
	);
}

export function lockKey(lock: RoomModelLock): string {
	return `${lock.provider}/${lock.model}`;
}

export type OfferedModelGroup = { provider: RoomModelProviderView; rows: Array<{ option: WebChatModelOption; name: string }> };

/**
 * The offered models as every model menu lists them: only providers that are
 * signed in or hold a key and offer this task, in AI setup's order, each
 * model under the name that tells it apart from its neighbours.
 */
export function offeredModelGroups(providers: RoomModelProviderView[], task: RoomModelTask): OfferedModelGroup[] {
	return providers
		.filter((provider) => provider.ready && provider[task].length > 0)
		.map((provider) => {
			const names = distinctModelNames(provider[task].map((option) => ({ model: option.model, modelLabel: option.label, provider: option.provider })));
			return { provider, rows: provider[task].map((option, index) => ({ option, name: names[index] })) };
		});
}

/** What a model list with nothing to offer says, by who may add a model here. */
export function noModelsLine(aiSetupRole: ReturnType<typeof sharedServerRole>): string {
	return aiSetupRole === "member" ? "No models yet. Ask your admin to add one in Settings, AI setup." : aiSetupRole === "admin" ? "No models yet. Add an API key or a gateway in Settings, AI setup." : "Sign in to an AI provider in Settings, AI setup, to choose a model.";
}

export function RoomModelPicker({ providers, task, value, inherited = false, disabled = false, ariaLabel, unpickable, unpickableLine, providerMarks, defaultChoice, openRequest, onOpen, onPick }: RoomModelPickerProps) {
	const [open, setOpen] = useState(false);
	const [position, setPosition] = useState<{ top?: number; bottom?: number; right: number; room: number } | null>(null);
	const wrapRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const listId = useId();
	// On a shared server nobody signs in, and only the admin adds a model.
	const aiSetupRole = sharedServerRole(useRemoteClientContext());
	const emptyLine = noModelsLine(aiSetupRole);
	const groups = offeredModelGroups(providers, task);
	const showProvider = groups.length > 1;
	const valueProvider = value ? providers.find((provider) => provider.id === value.provider) : undefined;
	const valueOption = value && valueProvider ? valueProvider[task].find((option) => option.model === value.model) ?? valueProvider.conversation.find((option) => option.model === value.model) : undefined;
	const valueRow = value ? groups.find((group) => group.provider.id === value.provider)?.rows.find((row) => row.option.model === value.model) : undefined;
	const valueName = value ? valueRow?.name ?? modelDisplayName({ model: value.model, modelLabel: valueOption?.label, provider: value.provider }) : "Choose a model";

	function close(returnFocus = true) {
		setOpen(false);
		if (returnFocus) triggerRef.current?.focus();
	}

	// An open menu is portaled out of the control: when the control is switched off (an admin's role taken away) it closes too.
	useEffect(() => {
		if (disabled && open) close(false);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [disabled]);

	useEffect(() => {
		if (open) onOpen?.();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	useEffect(() => {
		if (openRequest && !disabled) setOpen(true);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [openRequest]);

	useEffect(() => {
		if (!open) return;
		function onDocMouseDown(e: MouseEvent) {
			const target = e.target as Node;
			if (wrapRef.current?.contains(target) || menuRef.current?.contains(target)) return;
			close(false);
		}
		function onKeyDown(e: KeyboardEvent) {
			if (e.key === "Escape") {
				e.stopPropagation();
				close();
			}
		}
		document.addEventListener("mousedown", onDocMouseDown);
		document.addEventListener("keydown", onKeyDown, true);
		return () => {
			document.removeEventListener("mousedown", onDocMouseDown);
			document.removeEventListener("keydown", onKeyDown, true);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	// Placed from the trigger's live rect, re-measured on scroll, resize and
	// whenever the menu's own size changes (marks that arrive after it opened
	// make it taller), and never taller than the room on its side of the
	// trigger: past that it scrolls inside. Focus lands on the current model.
	// The phone sheet's CSS overrides the placement.
	useLayoutEffect(() => {
		if (!open) return;
		function measure() {
			const menu = menuRef.current;
			const anchor = triggerRef.current;
			if (!menu || !anchor) return;
			const rect = anchor.getBoundingClientRect();
			const below = window.innerHeight - rect.bottom - 12;
			const up = menu.scrollHeight > below && rect.top > below;
			const right = Math.max(8, window.innerWidth - rect.right);
			const room = Math.max(0, Math.floor((up ? rect.top - 12 : below) - 6));
			const next = up ? { bottom: window.innerHeight - rect.top + 6, right, room } : { top: rect.bottom + 6, right, room };
			setPosition((current) => (current && current.top === next.top && current.bottom === next.bottom && current.right === next.right && current.room === next.room ? current : next));
		}
		measure();
		const menu = menuRef.current;
		const resized = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
		if (resized && menu) for (const box of [menu, ...Array.from(menu.children)]) resized.observe(box);
		(menu?.querySelector<HTMLElement>('[aria-selected="true"]') ?? menu?.querySelector<HTMLElement>("[role=option]"))?.focus();
		window.addEventListener("resize", measure);
		window.addEventListener("scroll", measure, true);
		return () => {
			resized?.disconnect();
			window.removeEventListener("resize", measure);
			window.removeEventListener("scroll", measure, true);
		};
	}, [open]);

	function onMenuKeyDown(e: React.KeyboardEvent) {
		if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
		const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>("[role=option]") ?? []);
		if (items.length === 0) return;
		e.preventDefault();
		const index = items.indexOf(document.activeElement as HTMLElement);
		const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : e.key === "ArrowDown" ? Math.min(index + 1, items.length - 1) : Math.max(index - 1, 0);
		items[next]?.focus();
	}

	return (
		<div className="room-model-picker" ref={wrapRef}>
			<button
				type="button"
				ref={triggerRef}
				className={`room-model-pick${inherited ? " inherited" : ""}`}
				aria-label={`${ariaLabel}: ${inherited ? "default, " : ""}${valueName}`}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-controls={open ? listId : undefined}
				disabled={disabled}
				onClick={() => (open ? close() : setOpen(true))}
			>
				<span className="room-model-pick-name">{inherited ? `Default · ${valueName}` : valueName}</span>
				{showProvider && valueProvider && <span className="room-model-pick-provider">{valueProvider.label}</span>}
				{!disabled && <span className="disclosure-chevron" aria-hidden="true" />}
			</button>
			{open && createPortal(
				<>
					<div className="room-model-sheet-backdrop" aria-hidden="true" onClick={() => close(false)} />
					<div className="room-model-menu" ref={menuRef} role="listbox" id={listId} aria-label={ariaLabel} onKeyDown={onMenuKeyDown} style={position ? { top: position.top, bottom: position.bottom, right: position.right, "--room-model-menu-room": `${position.room}px` } as React.CSSProperties : { visibility: "hidden" }}>
						{groups.length === 0 && <p className="room-model-menu-empty">{emptyLine}</p>}
						{defaultChoice && (
							<div className="room-model-menu-group">
								<button
									type="button"
									role="option"
									aria-selected={inherited}
									aria-disabled={defaultChoice.reason ? true : undefined}
									className={`room-model-option${inherited ? " selected" : ""}${defaultChoice.reason ? " unpickable" : defaultChoice.mark ? " marked" : ""}`}
									onClick={() => {
										if (defaultChoice.reason) return;
										close();
										if (!inherited) defaultChoice.onPick();
									}}
								>
									<span className="room-model-option-check">{inherited && <ModelCheckIcon />}</span>
									<span className="room-model-option-main">
										<span className="room-model-option-name">{`Default (${defaultChoice.name})`}</span>
										{(defaultChoice.reason ?? defaultChoice.mark) && <span className="room-model-option-reason">{defaultChoice.reason ?? defaultChoice.mark}</span>}
									</span>
								</button>
							</div>
						)}
						{groups.map(({ provider, rows }) => (
							<div key={provider.id} className="room-model-menu-group" role="group" aria-label={provider.label}>
								<p className="room-model-menu-kicker">{provider.label}</p>
								{rows.map(({ option, name }) => {
									const selected = !!value && lockKey(value) === lockKey(option);
									const reason = unpickable?.get(lockKey(option));
									const mark = reason ? undefined : providerMarks?.get(provider.id);
									const context = contextWindowShort(option.contextWindow);
									return (
										<button
											type="button"
											key={lockKey(option)}
											role="option"
											aria-selected={selected}
											aria-disabled={reason ? true : undefined}
											className={`room-model-option${selected ? " selected" : ""}${reason ? " unpickable" : mark ? " marked" : ""}`}
											onClick={() => {
												if (reason) return;
												close();
												if (!selected || inherited) onPick({ provider: option.provider, model: option.model });
											}}
										>
											<span className="room-model-option-check">{selected && !inherited && <ModelCheckIcon />}</span>
											<span className="room-model-option-main">
												<span className="room-model-option-head">
													<span className="room-model-option-name">{name}</span>
													{option.recommended && <span className="room-model-option-tag">Recommended</span>}
													{/* A figure for the eye on the name's line: the row's accessible name stays the model's. */}
													{context && <span className="room-model-option-context" aria-hidden="true">{context}</span>}
												</span>
												{(reason ?? mark) && <span className="room-model-option-reason">{reason ?? mark}</span>}
											</span>
										</button>
									);
								})}
							</div>
						))}
						{unpickableLine && unpickable && unpickable.size > 0 && groups.some(({ rows }) => rows.some(({ option }) => unpickable.has(lockKey(option)))) && <p className="room-model-menu-note">{unpickableLine}</p>}
					</div>
				</>,
				document.body,
			)}
		</div>
	);
}

/**
 * The providers whose saved key was refused at the last call, for a picker's
 * marks: read on mount, and again by `refresh` each time a picker opens, so a
 * key saved again elsewhere clears them without a reload. A failed read keeps
 * what was shown, and only the newest read's answer is kept: a slower older
 * one never overwrites it.
 */
export function useKeyRefusals(): { refusals: Map<string, KeyRefusal>; refresh: () => void } {
	const [refusals, setRefusals] = useState<Map<string, KeyRefusal>>(new Map());
	const latest = useRef(0);
	const refresh = useCallback(() => {
		const ask = ++latest.current;
		fetchKeyRefusals().then((next) => { if (ask === latest.current) setRefusals(next); }, () => {});
	}, []);
	useEffect(() => {
		refresh();
		// Unmounted: an answer still on its way is dropped.
		return () => { latest.current += 1; };
	}, [refresh]);
	return { refusals, refresh };
}
