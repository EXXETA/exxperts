import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { modelDisplayName, modelTooltipName } from "../model-names";
import type { PersistentAgentAiProfileSelectionStatus, PersistentAgentAiProfileStatus, WebChatModelOption } from "../types";
import { firstWordOfLabel, strandedBySwitchCount } from "./product-shell";

// The room card's model choice, grown up: the old <select> only knew the
// active profile's curated models, so reaching a model on another provider
// meant a detour through the sidebar ⚙ profile radio. This popover lists every
// profile's curated room models grouped under their profile, and picking one
// on a READY non-active profile runs the same switch the sidebar would —
// behind a confirm that names what moves (new threads, Memorize, Review)
// and how many standby rooms the switch strands. Unready profiles stay
// visible but inert: the group header says why, AI setup is the way in.
// Selecting inside the active profile is exactly the old select: local,
// instant, no server call.
//
// Grouping derives from aiProfileStatus ALONE. The model status is a second
// feed that refreshes on its own schedule, and a profile switch made
// elsewhere (sidebar, AI setup) leaves a window where the two disagree —
// mixing them here once rendered the freshly-activated profile as a foldable
// "switches profile" group with a dead header. The server-validated
// roomModels list only substitutes in when it names the same profile.

/** `tooltip` carries the provider; the row itself only ever shows `name`. */
type PickerModel = { key: string; name: string; tooltip: string };

type PickerGroup =
	| { kind: "active"; id: string; label: string; models: PickerModel[] }
	| { kind: "switch"; id: string; label: string; models: PickerModel[]; profile: PersistentAgentAiProfileStatus; strandedCount: number }
	| { kind: "inert"; id: string; label: string; modelCount: number; note: string };

// Above this many selectable entries the popover grows a filter field and
// non-active groups fold to header + count — twelve rows still scan, twenty
// don't. The active group never folds: it is the current selection's home.
const FILTER_THRESHOLD = 12;

function pickerModel(option: { provider: string; model: string; label?: string }): PickerModel {
	const nameInput = { model: option.model, modelLabel: option.label, provider: option.provider };
	return {
		key: `${option.provider}/${option.model}`,
		// One naming path for every group, so the same model reads identically
		// wherever it appears (modelDisplayName prefers the raw id's family
		// name over whatever label era the source carries).
		name: modelDisplayName(nameInput),
		tooltip: modelTooltipName(nameInput),
	};
}

function profileRoomModels(profile: PersistentAgentAiProfileStatus): PickerModel[] {
	return (profile.processes?.persistentRoom.models ?? []).map(pickerModel);
}

function inertGroup(profile: PersistentAgentAiProfileStatus): PickerGroup {
	// Same vocabulary as the sidebar radio: "not signed in" for a signed-out
	// provider, "setup needed" for signed-in-but-broken.
	return {
		kind: "inert",
		id: profile.id,
		label: profile.label,
		modelCount: profile.processes?.persistentRoom.models.length ?? 0,
		note: profile.provider.configured ? "setup needed · finish in AI setup" : "not signed in · connect it in AI setup",
	};
}

// The one profile-switch confirm, shared by the picker's cross-profile pick
// and the stranded card's Switch & resume: same copy, same strand count, same
// failure handling, same focus trap. Escape is the caller's to wire — the
// picker peels its own layers, the card uses useEscapeKey.
export function ProfileSwitchConfirm({ profile, strandedCount, continuation, switching, error, onCancel, onConfirm }: {
	profile: PersistentAgentAiProfileStatus;
	strandedCount: number;
	/** Extra sentence closing the body — e.g. what happens to the thread being resumed. */
	continuation?: string;
	switching: boolean;
	error: string | null;
	onCancel: () => void;
	onConfirm: () => void;
}) {
	const cardRef = useRef<HTMLElement>(null);
	// The moment both buttons disable (switch in flight) the browser blurs the
	// pressed button to body — from there keydown never reaches the backdrop
	// trap and Tab walks the page behind the modal. Park focus on the dialog
	// container instead, where the trap keeps holding it.
	useEffect(() => {
		if (switching) cardRef.current?.focus();
	}, [switching]);
	// The confirm is modal: Tab cycles inside it, nothing behind it is reachable.
	function onKeyDown(e: React.KeyboardEvent) {
		if (e.key !== "Tab") return;
		const card = cardRef.current;
		if (!card) return;
		const focusables = Array.from(card.querySelectorAll<HTMLElement>("button:not(:disabled)"));
		if (focusables.length === 0) {
			// Mid-switch both buttons are disabled: hold focus on the dialog
			// itself rather than letting Tab escape the modal.
			e.preventDefault();
			card.focus();
			return;
		}
		const first = focusables[0];
		const last = focusables[focusables.length - 1];
		if (!card.contains(document.activeElement)) {
			e.preventDefault();
			first.focus();
		} else if (e.shiftKey && document.activeElement === first) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && document.activeElement === last) {
			e.preventDefault();
			first.focus();
		}
	}
	return (
		<div className="checkpoint-preview-backdrop maintain-confirm-backdrop" role="dialog" aria-modal="true" aria-label={`Switch AI profile to ${profile.label}?`} onKeyDown={onKeyDown}>
			<section className="checkpoint-input-card maintain-confirm-card" ref={cardRef} tabIndex={-1}>
				<h2>Switch AI profile to {profile.label}?</h2>
				<p>
					New room threads will start on {profile.label}, and Memorize and Review move with it.
					{strandedCount > 0 && ` ${strandedCount} standby room${strandedCount === 1 ? "" : "s"} can then only resume once you switch back.`}
					{continuation && ` ${continuation}`}
				</p>
				{error && <p className="model-picker-confirm-error">{error}</p>}
				<div className="checkpoint-preview-actions">
					<button className="landing-action secondary" disabled={switching} onClick={onCancel}>Cancel</button>
					<button className="landing-action" autoFocus disabled={switching} onClick={onConfirm}>{switching ? "Switching…" : `Switch to ${firstWordOfLabel(profile.label)}`}</button>
				</div>
			</section>
		</div>
	);
}

export type RoomModelPickerProps = {
	/** The active profile's curated room models — the server-validated list the old select showed. */
	roomModels: WebChatModelOption[];
	/** Which profile the model status believes is active — used only to detect the refetch window. */
	modelStatusProfileId?: string;
	/** Selected model as "provider/model". */
	value: string;
	onChange: (key: string) => void;
	aiProfileStatus: PersistentAgentAiProfileSelectionStatus | null;
	/** Locked models of standby rooms — feeds the strand count on switch groups. */
	standbyLockedModels?: Array<{ provider: string; model: string }>;
	/** Runs the profile switch on a cross-profile pick. Without it (fixtures), only the active group shows. */
	onSelectAiProfile?: (profileId: string) => Promise<void>;
};

export function RoomModelPicker({ roomModels, modelStatusProfileId, value, onChange, aiProfileStatus, standbyLockedModels, onSelectAiProfile }: RoomModelPickerProps) {
	const [open, setOpen] = useState(false);
	const [filter, setFilter] = useState("");
	// Group ids the user explicitly toggled — wins over the size-based default.
	const [toggledGroups, setToggledGroups] = useState<Record<string, boolean>>({});
	const [confirm, setConfirm] = useState<{ profile: PersistentAgentAiProfileStatus; model: PickerModel; strandedCount: number } | null>(null);
	const [switching, setSwitching] = useState(false);
	const [switchError, setSwitchError] = useState<string | null>(null);
	// Combobox highlight (filter mode): id of the entry aria-activedescendant names.
	const [activeDesc, setActiveDesc] = useState<string | null>(null);
	// Measured placement: open upward when the viewport below is short, shift
	// horizontally when a viewport edge would clip the menu.
	const [placement, setPlacement] = useState<{ up: boolean; shift: number; maxHeight: number | null }>({ up: false, shift: 0, maxHeight: null });
	const wrapRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const filterRef = useRef<HTMLInputElement>(null);
	const confirmOpen = confirm !== null;
	const confirmOpenRef = useRef(confirmOpen);
	confirmOpenRef.current = confirmOpen;
	// Where focus goes back to when the confirm is dismissed without switching.
	const confirmReturnFocusRef = useRef<HTMLElement | null>(null);
	const baseId = useId();

	const activeProfile = aiProfileStatus?.activeProfile ?? null;
	// Plain per-render derivation: the inputs are fresh references from the
	// card every render anyway, so a useMemo here would never hit.
	const groups = ((): PickerGroup[] => {
		if (!aiProfileStatus || !activeProfile) {
			// Profile status not loaded (or fixtures): the curated list is all we have.
			return [{ kind: "active", id: "active", label: "Current profile", models: roomModels.map(pickerModel) }];
		}
		const sourcesAgree = !modelStatusProfileId || modelStatusProfileId === activeProfile.id;
		const result: PickerGroup[] = [];
		if (activeProfile.ready) {
			result.push({
				kind: "active",
				id: activeProfile.id,
				label: activeProfile.label,
				models: sourcesAgree && roomModels.length > 0 ? roomModels.map(pickerModel) : profileRoomModels(activeProfile),
			});
		} else {
			// Signed-out active profile: its group is honest about why it offers
			// nothing, while the ready groups below stay reachable (that is the
			// whole point of the picker on a card with no usable models).
			result.push(inertGroup(activeProfile));
		}
		// Cross-profile groups only make sense when the switch can actually run.
		if (!onSelectAiProfile) return result;
		for (const profile of aiProfileStatus.profiles) {
			if (profile.id === activeProfile.id) continue;
			if (profile.ready) {
				const models = profileRoomModels(profile);
				if (models.length === 0) continue;
				result.push({ kind: "switch", id: profile.id, label: profile.label, models, profile, strandedCount: strandedBySwitchCount(standbyLockedModels, activeProfile, profile) });
			} else {
				result.push(inertGroup(profile));
			}
		}
		return result;
	})();

	const totalEntries = groups.reduce((count, group) => count + (group.kind === "inert" ? 0 : group.models.length), 0);
	const showFilter = totalEntries > FILTER_THRESHOLD;
	const query = filter.trim().toLowerCase();

	// Per-group render state, computed once so keyboard order matches DOM order.
	const renderGroups = groups.map((group) => {
		if (group.kind === "inert") return { group, matches: [] as PickerModel[], collapsed: true, collapsible: false, headerId: "" };
		const matches = query ? group.models.filter((model) => model.name.toLowerCase().includes(query)) : group.models;
		// The active group never folds; a filter query overrides toggles so
		// matching groups open to their matches and silent groups fold.
		const collapsed = group.kind === "switch"
			? (query
				? matches.length === 0
				: toggledGroups[group.id] !== undefined
					? !toggledGroups[group.id]
					: showFilter)
			: false;
		const collapsible = group.kind === "switch" && !query;
		return { group, matches, collapsed, collapsible, headerId: `${baseId}-head-${group.id}` };
	});
	const optionId = (group: PickerGroup, model: PickerModel) => `${baseId}-opt-${group.id}-${model.key}`;
	const listboxId = (group: PickerGroup) => `${baseId}-list-${group.id}`;
	// aria-controls must reference the elements that actually carry the
	// listbox role — one per expanded group.
	const visibleListboxIds = renderGroups.filter(({ group, collapsed }) => group.kind !== "inert" && !collapsed).map(({ group }) => listboxId(group)).join(" ") || undefined;
	// Keyboard walk order in filter (combobox) mode: collapsible headers and
	// visible options, in DOM order.
	const navIds = renderGroups.flatMap(({ group, matches, collapsed, collapsible, headerId }) => {
		if (group.kind === "inert") return [];
		return [...(collapsible ? [headerId] : []), ...(collapsed ? [] : matches.map((model) => optionId(group, model)))];
	});

	// The trigger names the selection even during the beat between a profile
	// switch landing and the refreshed model status arriving, when the chosen
	// model is not in `roomModels` yet.
	const trigger = ((): { name: string; tooltip: string } => {
		for (const group of groups) {
			if (group.kind === "inert") continue;
			const match = group.models.find((model) => model.key === value);
			if (match) return { name: match.name, tooltip: match.tooltip };
		}
		const slash = value.indexOf("/");
		if (slash > 0) {
			const nameInput = { model: value.slice(slash + 1), provider: value.slice(0, slash) };
			return { name: modelDisplayName(nameInput), tooltip: modelTooltipName(nameInput) };
		}
		const fallback = value || "Choose model";
		return { name: fallback, tooltip: fallback };
	})();
	const triggerName = trigger.name;

	// A refresh that removed the highlighted entry (group refolded, filter
	// changed under our feet) must not leave aria-activedescendant pointing at
	// a ghost.
	const navKey = navIds.join("\n");
	useEffect(() => {
		if (activeDesc && !navIds.includes(activeDesc)) setActiveDesc(null);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [activeDesc, navKey]);

	function close(returnFocus = true) {
		setOpen(false);
		setFilter("");
		// Each open starts from the size-based defaults — a fold toggled three
		// profile-switches ago must not decide today's layout.
		setToggledGroups({});
		setConfirm(null);
		setSwitchError(null);
		setActiveDesc(null);
		setPlacement({ up: false, shift: 0, maxHeight: null });
		if (returnFocus) triggerRef.current?.focus();
	}

	function dismissConfirm() {
		setConfirm(null);
		setSwitchError(null);
		requestAnimationFrame(() => confirmReturnFocusRef.current?.focus());
	}

	useEffect(() => {
		if (!open) return;
		function onDocMouseDown(e: MouseEvent) {
			if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close(false);
		}
		function onKeyDown(e: KeyboardEvent) {
			if (e.key !== "Escape") return;
			// Escape peels one layer: the confirm first, then the popover.
			if (confirmOpenRef.current) dismissConfirm();
			else close();
		}
		document.addEventListener("mousedown", onDocMouseDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("mousedown", onDocMouseDown);
			document.removeEventListener("keydown", onKeyDown);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	// Opening lands focus where typing is useful: the filter when present,
	// otherwise the current selection.
	useEffect(() => {
		if (!open) return;
		const target = filterRef.current
			?? menuRef.current?.querySelector<HTMLElement>('[data-picker-item][aria-selected="true"]')
			?? menuRef.current?.querySelector<HTMLElement>("[data-picker-item]");
		target?.focus();
	}, [open, showFilter]);

	// Flip up / clamp inside the viewport, measured after the menu exists and
	// re-measured when the window resizes or anything scrolls. The natural
	// height comes from scrollHeight — offsetHeight equals an applied clamp,
	// so measuring it would read "fits" on the next pass and spring the menu
	// back open past the viewport.
	useLayoutEffect(() => {
		if (!open) return;
		function measure() {
			const menu = menuRef.current;
			const anchor = wrapRef.current;
			if (!menu || !anchor) return;
			const anchorRect = anchor.getBoundingClientRect();
			// The design ceiling lives in the stylesheet's max-height; read it
			// with the inline clamp lifted so the applied clamp never masks it.
			const inlineMax = menu.style.maxHeight;
			menu.style.maxHeight = "";
			const cssMax = Number.parseFloat(getComputedStyle(menu).maxHeight);
			menu.style.maxHeight = inlineMax;
			const naturalHeight = Math.min(menu.scrollHeight + 2, Number.isFinite(cssMax) ? cssMax : Number.POSITIVE_INFINITY);
			const spaceBelow = window.innerHeight - anchorRect.bottom - 12;
			const spaceAbove = anchorRect.top - 12;
			const up = naturalHeight > spaceBelow && spaceAbove > spaceBelow;
			// Whatever side wins may still be shorter than the menu — shrink to
			// fit so no viewport ever clips it.
			const room = Math.max(up ? spaceAbove : spaceBelow, 120);
			const maxHeight = naturalHeight > room ? room : null;
			// Right-aligned by default; nudge back inside when either viewport
			// edge would clip it (narrow windows, edge-column cards).
			const left = anchorRect.right - menu.offsetWidth;
			const shift = left < 8 ? 8 - left : anchorRect.right > window.innerWidth - 8 ? window.innerWidth - 8 - anchorRect.right : 0;
			setPlacement((prev) => (prev.up === up && prev.shift === shift && prev.maxHeight === maxHeight ? prev : { up, shift, maxHeight }));
		}
		measure();
		window.addEventListener("resize", measure);
		window.addEventListener("scroll", measure, true);
		return () => {
			window.removeEventListener("resize", measure);
			window.removeEventListener("scroll", measure, true);
		};
		// navIds.length tracks everything that changes the menu's height:
		// group expansion, filtering, profile-status refreshes.
	}, [open, navIds.length]);

	function rovingTarget(e: React.KeyboardEvent): HTMLElement | null | undefined {
		const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>("[data-picker-item]") ?? []);
		if (items.length === 0) return undefined;
		const index = items.indexOf(document.activeElement as HTMLElement);
		if (e.key === "Home") return items[0];
		if (e.key === "End") return items[items.length - 1];
		if (e.key === "ArrowDown") return items[Math.min(index + 1, items.length - 1)];
		return index <= 0 ? filterRef.current ?? items[0] : items[index - 1];
	}

	function onMenuKeyDown(e: React.KeyboardEvent) {
		if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
		if (showFilter && document.activeElement === filterRef.current) return; // combobox path below
		const next = rovingTarget(e);
		if (next === undefined) return;
		e.preventDefault();
		next?.focus();
	}

	// Combobox keyboard path: focus stays in the filter input; arrows move the
	// aria-activedescendant highlight, Enter activates it (an option picks, a
	// folded header expands).
	function onFilterKeyDown(e: React.KeyboardEvent) {
		if (e.key === "Enter") {
			if (!activeDesc) return;
			e.preventDefault();
			document.getElementById(activeDesc)?.click();
			return;
		}
		if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
		if (navIds.length === 0) return;
		e.preventDefault();
		const index = activeDesc ? navIds.indexOf(activeDesc) : -1;
		const next = e.key === "Home"
			? navIds[0]
			: e.key === "End"
				? navIds[navIds.length - 1]
				: e.key === "ArrowDown"
					? navIds[index < 0 ? 0 : Math.min(index + 1, navIds.length - 1)]
					: navIds[Math.max(index - 1, 0)];
		setActiveDesc(next);
		document.getElementById(next)?.scrollIntoView({ block: "nearest" });
	}

	// Tab (or any focus move) that leaves the popover closes it, like a click
	// outside would. relatedTarget is null on programmatic blurs — those are
	// our own focus juggling, never a real departure.
	function onWrapBlur(e: React.FocusEvent) {
		if (!open) return;
		const next = e.relatedTarget as Node | null;
		if (!next || wrapRef.current?.contains(next)) return;
		close(false);
	}

	function pick(group: PickerGroup, model: PickerModel) {
		if (group.kind === "switch") {
			setSwitchError(null);
			confirmReturnFocusRef.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : filterRef.current ?? triggerRef.current;
			setConfirm({ profile: group.profile, model, strandedCount: group.strandedCount });
			return;
		}
		onChange(model.key);
		close();
	}

	async function confirmSwitch() {
		if (!confirm || !onSelectAiProfile || switching) return;
		setSwitching(true);
		setSwitchError(null);
		try {
			await onSelectAiProfile(confirm.profile.id);
			onChange(confirm.model.key);
			close();
		} catch (e) {
			setSwitchError((e as Error).message);
		} finally {
			setSwitching(false);
		}
	}

	return (
		<div className="model-picker" ref={wrapRef} onBlur={onWrapBlur}>
			<button
				type="button"
				ref={triggerRef}
				className="model-picker-trigger"
				aria-label="Room model"
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-controls={open ? visibleListboxIds : undefined}
				title={`Room model: ${trigger.tooltip}`}
				onClick={() => (open ? close() : setOpen(true))}
				onKeyDown={(e) => {
					if (open || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
					e.preventDefault();
					setOpen(true);
				}}
			>
				<span className="model-picker-trigger-name">{triggerName}</span>
			</button>
			{open && (
				<div
					className={`model-picker-menu${placement.up ? " drop-up" : ""}`}
					ref={menuRef}
					onKeyDown={onMenuKeyDown}
					style={placement.shift !== 0 || placement.maxHeight !== null ? { ...(placement.shift !== 0 ? { transform: `translateX(${placement.shift}px)` } : {}), ...(placement.maxHeight !== null ? { maxHeight: placement.maxHeight } : {}) } : undefined}
				>
					{showFilter && (
						<input
							ref={filterRef}
							className="model-picker-filter"
							type="text"
							placeholder="Filter models"
							aria-label="Filter models"
							role="combobox"
							aria-expanded={open}
							aria-controls={visibleListboxIds}
							aria-activedescendant={activeDesc ?? undefined}
							aria-autocomplete="list"
							value={filter}
							onChange={(e) => {
								setFilter(e.target.value);
								setActiveDesc(null);
							}}
							onKeyDown={onFilterKeyDown}
						/>
					)}
					<div>
						{renderGroups.map(({ group, matches, collapsed, collapsible, headerId }) => {
							if (group.kind === "inert") {
								return (
									<div key={group.id} className="model-picker-group inert" role="presentation" title="Sign in from AI setup to use this profile">
										<div className="model-picker-group-head">
											<span className="model-picker-group-text">
												<span className="model-picker-group-name">{group.label}</span>
												<span className="model-picker-group-meta">{group.note}{group.modelCount > 0 && ` · ${group.modelCount} model${group.modelCount === 1 ? "" : "s"}`}</span>
											</span>
										</div>
									</div>
								);
							}
							const meta = group.kind === "switch"
								? `switches profile${group.strandedCount > 0 ? ` · ${group.strandedCount} room${group.strandedCount === 1 ? "" : "s"} affected` : ""}`
								: null;
							// A folded group during filtering has zero matches by
							// construction — say that, not the total. The active group
							// never folds, so its zero-match state says so in place.
							const countText = collapsed
								? (query ? "no matches" : `${group.models.length} model${group.models.length === 1 ? "" : "s"}`)
								: query && matches.length === 0 ? "no matches" : null;
							const metaText = [meta, countText].filter(Boolean).join(" · ");
							const headBody = (
								<span className="model-picker-group-text">
									<span className="model-picker-group-name">{group.label}</span>
									{metaText && <span className="model-picker-group-meta">{metaText}</span>}
								</span>
							);
							return (
								<div key={group.id} className={`model-picker-group${group.kind === "active" ? " current" : ""}`}>
									{collapsible ? (
										<button
											type="button"
											id={headerId}
											className={`model-picker-group-head expandable${activeDesc === headerId ? " kb-active" : ""}`}
											data-picker-item
											tabIndex={showFilter ? -1 : 0}
											aria-expanded={!collapsed}
											title="Show or hide this profile's models"
											onClick={() => setToggledGroups((prev) => ({ ...prev, [group.id]: collapsed }))}
										>
											{headBody}
											<span className="model-picker-group-chevron" aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
										</button>
									) : (
										<div className="model-picker-group-head" role="presentation">{headBody}</div>
									)}
									{!collapsed && (
										<div role="listbox" id={listboxId(group)} aria-label={`${group.label} models`}>
											{matches.map((model) => {
												// A model id duplicated across providers' catalogs must
												// not read as selected twice: only the active group
												// carries the selection.
												const selected = group.kind === "active" && model.key === value;
												const id = optionId(group, model);
												return (
													<button
														type="button"
														key={model.key}
														id={id}
														className={`model-picker-option${selected ? " selected" : ""}${activeDesc === id ? " kb-active" : ""}`}
														role="option"
														aria-selected={selected}
														data-picker-item
														tabIndex={showFilter ? -1 : 0}
														title={group.kind === "switch" ? `${model.tooltip} · switches the AI profile to ${group.label}` : model.tooltip !== model.name ? model.tooltip : undefined}
														onClick={() => pick(group, model)}
													>
														<span className="model-picker-option-name">{model.name}</span>
														{selected && <span className="model-picker-option-check" aria-hidden="true">✓</span>}
													</button>
												);
											})}
										</div>
									)}
								</div>
							);
						})}
					</div>
				</div>
			)}
			{confirm && (
				<ProfileSwitchConfirm
					profile={confirm.profile}
					strandedCount={confirm.strandedCount}
					switching={switching}
					error={switchError}
					onCancel={dismissConfirm}
					onConfirm={() => void confirmSwitch()}
				/>
			)}
		</div>
	);
}
