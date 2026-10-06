import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { modelDisplayName } from "../model-names";
import type { RoomModelLock, RoomModelProviderView, RoomModelTask } from "../types";

// The one model picker, used by a room's Model pane and by the defaults for
// new rooms. One list grouped by provider, only providers that are signed in
// or hold a key, in AI setup's order; each model a row with its name, and
// "Recommended" on the provider's recommended one. Nothing about effort: that
// is the composer's dial. The trigger names the model, with the provider as a
// muted suffix when more than one provider is ready. The list is portaled to
// the page (the settings dialog scrolls and its backdrop would capture a fixed
// layer), placed under the trigger or above it when the space below is short;
// on a phone it opens as a full-width sheet.

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
	onPick: (lock: RoomModelLock) => void;
};

function lockKey(lock: RoomModelLock): string {
	return `${lock.provider}/${lock.model}`;
}

export function RoomModelPicker({ providers, task, value, inherited = false, disabled = false, ariaLabel, onPick }: RoomModelPickerProps) {
	const [open, setOpen] = useState(false);
	const [position, setPosition] = useState<{ top?: number; bottom?: number; right: number } | null>(null);
	const wrapRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const listId = useId();
	const ready = providers.filter((provider) => provider.ready && provider[task].length > 0);
	const showProvider = ready.length > 1;
	const valueProvider = value ? providers.find((provider) => provider.id === value.provider) : undefined;
	const valueOption = value && valueProvider ? valueProvider[task].find((option) => option.model === value.model) ?? valueProvider.conversation.find((option) => option.model === value.model) : undefined;
	const valueName = value ? modelDisplayName({ model: value.model, modelLabel: valueOption?.label, provider: value.provider }) : "Choose a model";

	function close(returnFocus = true) {
		setOpen(false);
		if (returnFocus) triggerRef.current?.focus();
	}

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

	// Placed from the trigger's live rect, re-measured on scroll and resize;
	// focus lands on the current model. The phone sheet's CSS overrides the
	// placement.
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
			setPosition(up ? { bottom: window.innerHeight - rect.top + 6, right } : { top: rect.bottom + 6, right });
		}
		measure();
		const menu = menuRef.current;
		(menu?.querySelector<HTMLElement>('[aria-selected="true"]') ?? menu?.querySelector<HTMLElement>("[role=option]"))?.focus();
		window.addEventListener("resize", measure);
		window.addEventListener("scroll", measure, true);
		return () => {
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
					<div className="room-model-menu" ref={menuRef} role="listbox" id={listId} aria-label={ariaLabel} onKeyDown={onMenuKeyDown} style={position ? { top: position.top, bottom: position.bottom, right: position.right } : { visibility: "hidden" }}>
						{ready.length === 0 && <p className="room-model-menu-empty">Sign in to an AI provider in Settings, AI setup, to choose a model.</p>}
						{ready.map((provider) => (
							<div key={provider.id} className="room-model-menu-group" role="group" aria-label={provider.label}>
								<p className="room-model-menu-kicker">{provider.label}</p>
								{provider[task].map((option) => {
									const selected = !!value && lockKey(value) === lockKey(option);
									return (
										<button
											type="button"
											key={lockKey(option)}
											role="option"
											aria-selected={selected}
											className={`room-model-option${selected ? " selected" : ""}`}
											onClick={() => {
												close();
												if (!selected || inherited) onPick({ provider: option.provider, model: option.model });
											}}
										>
											<span className="room-model-option-name">{modelDisplayName({ model: option.model, modelLabel: option.label, provider: option.provider })}</span>
											{option.recommended && <span className="room-model-option-tag">Recommended</span>}
										</button>
									);
								})}
							</div>
						))}
					</div>
				</>,
				document.body,
			)}
		</div>
	);
}
