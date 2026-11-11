import { useState, useRef, useEffect, useLayoutEffect } from "react";
import { shownRoomName } from "../../../web-server/src/room-name";
import { CreateRoomPanel } from "./create-room-panel";
import { Help, useFirstRunGuide } from "./Help";
import { CloseIcon } from "./icons";
import { useEscapeKey } from "./use-escape-key";
import { PersistentAgentCard, noModelSentence } from "./launcher-room-card";
import { ROOM_SORT_MIN_ROOMS, RoomSortControl, ROOM_ARRANGE_HINT_ID } from "./RoomSortControl";
import type { HomeRoomOrderView } from "../home-room-order";
import { type RoomOrderChoice, orderRooms, type RoomOrderMode } from "../../../web-server/src/room-order";
import { type RoomArrangement, createRoomArrangement, moveByKey, confirmLeavingArrangement } from "../home-room-arrange";
import { type CardDrag, createCardDrag, type CardDragView, type Rect, type SlotLayout, ROOM_LONG_PRESS_MS } from "../home-room-drag";
import { arrangeSlots, slotRestBox, useArrangeEdgeScroll, useRoomArrangeMotion } from "../use-room-arrange-motion";
import { type ThemeMode, type AppearancePreference, ProductSidebar } from "./product-shell";
import type { SettingsSection } from "./settings-overlay";
import { roomFilesSentence } from "./RoomDangerZone";
import { aiSetupLocked, sharedServerRole, useRemoteClientContext } from "../remote-client-context";
import { type SettingsPane, RoomSettingsModal } from "./RoomSettingsModal";
import { REMEMBER_SAVED_REOPEN_SENTENCE, REMEMBER_SAVED_ELSEWHERE_SENTENCE } from "../remember-read";
import type { PersistentAgentStatus, PersistentAgentCreateRequest, PersistentAgentCreateResponse, PersistentAgentId, PersistentAgentArchiveResponse, PersistentAgentPurgeResponse, WebChatModelStatus, PersistentAgentAiProfileSelectionStatus, ArchivedPersistentAgentSummary } from "../types";
import { fetchArchivedPersistentRooms, restorePersistentRoom, purgePersistentRoom } from "../persistent-room-management-api";
import type { MaintainTarget, PersistentAgentThread } from "../room-thread-items";
import { homeAiProfileStatus } from "./ai-profile-switcher";

export function Landing({ roomOrder, onChooseRoomOrder, onArrangingChange, onOpenSettings, onOpenDashboard, onOpenMemory, onOpenPersistentAgent, onResumePersistentAgent, onMaintainPersistentAgent, onCreatePersistentAgent, onArchiveRoom, onPurgeRoom, onMementoForget, modelStatus, persistentAgentStatuses, persistentThread, persistentLive, persistentResumeError, onRefreshPersistentAgent, theme, appearance, onSetAppearance, aiProfileStatus: aiProfileSelection, backgroundReadyRooms, purgingRooms, serviceBack }: { roomOrder: HomeRoomOrderView; onChooseRoomOrder: (choice: RoomOrderChoice) => Promise<boolean>; /** Told whenever arrange mode has unsaved moves or stops having them, and false when the screen goes; the app asks the leave question at its own exits. */ onArrangingChange: (dirty: boolean) => void; onOpenSettings: (section?: SettingsSection) => void; onOpenDashboard: () => void; onOpenMemory: () => void; onOpenPersistentAgent: (status: PersistentAgentStatus) => Promise<void> | void; onResumePersistentAgent: (status: PersistentAgentStatus) => Promise<void> | void; onMaintainPersistentAgent: (target: MaintainTarget) => void; onCreatePersistentAgent: (request: PersistentAgentCreateRequest) => Promise<PersistentAgentCreateResponse>; onArchiveRoom: (agentId: PersistentAgentId, confirmation: string) => Promise<PersistentAgentArchiveResponse | null>; onPurgeRoom: (agentId: PersistentAgentId, confirmation: string) => Promise<PersistentAgentPurgeResponse | null>; onMementoForget: (agentId: PersistentAgentId) => void; modelStatus: WebChatModelStatus | null; persistentAgentStatuses: PersistentAgentStatus[]; persistentThread: PersistentAgentThread | null; persistentLive: boolean; persistentResumeError: string | null; onRefreshPersistentAgent: () => void; theme: ThemeMode; appearance: AppearancePreference; onSetAppearance: (pref: AppearancePreference) => void; aiProfileStatus: PersistentAgentAiProfileSelectionStatus | null; backgroundReadyRooms?: ReadonlySet<PersistentAgentId>; purgingRooms?: ReadonlySet<PersistentAgentId>; /** Counts the page's reconnects after an outage. */ serviceBack: number }) {
	const [createOpen, setCreateOpen] = useState(false);
	useEscapeKey(() => setCreateOpen(false), createOpen);
	const [settingsRoomId, setSettingsRoomId] = useState<PersistentAgentId | null>(null);
	const [settingsRoomPane, setSettingsRoomPane] = useState<SettingsPane | undefined>(undefined);
	// The modal must track the LIVE status for its room: a snapshot taken when
	// it opened could carry stale mid-stream inFlight/working flags and e.g.
	// keep Memento disabled forever (the home screen's arrival refreshes the
	// statuses once, home-room-order.ts, not while the modal is open), and
	// onRefresh must be able to update what the open modal shows.
	const settingsRoom = settingsRoomId ? persistentAgentStatuses.find((status) => status.id === settingsRoomId) ?? null : null;
	const openRoomSettings = (status: PersistentAgentStatus, pane?: SettingsPane): void => {
		setSettingsRoomId(status.id);
		setSettingsRoomPane(pane);
		onRefreshPersistentAgent();
	};

	// The ONE ordering (room-order.ts). While the saved order is withheld
	// (home-room-order.ts: on every arrival, until that arrival's read has
	// settled) nothing is drawn in the grid, the "New room" card included, so
	// no card appears in one place and moves to another. With no rooms there
	// is nothing to order, so the order holds nothing back.
	const roomStatuses = persistentAgentStatuses;
	// On a shared server the order is A to Z and cannot be changed (use-home-room-order.ts).
	const remoteClientContext = useRemoteClientContext();
	const { sharedServer } = remoteClientContext;
	const orderedRoomStatuses = roomOrder.order ? orderRooms(persistentAgentStatuses, roomOrder.order, roomOrder.lastUsed) : [];
	const gridDrawn = roomOrder.order !== null || roomStatuses.length === 0;

	// Arrange mode. The arrangement itself is home-room-arrange.ts (plain,
	// immutable); this screen holds it as ONE piece of state that dies with
	// the screen. While arranging the grid is drawn from the arrangement, not
	// from the saved order: the cards are the set at entry, minus rooms gone
	// meanwhile (retain, below). Save is one choice handed to the controller
	// (mode custom + the ids); Cancel and Escape drop the arrangement, and
	// nothing is written. Moves, Cancel and Escape are not taken while a save
	// is in flight: what was sent is what closes, and a write already sent
	// cannot be cancelled.
	const [arrangement, setArrangement] = useState<RoomArrangement | null>(null);
	const [announcement, setAnnouncement] = useState("");
	const arranging = arrangement !== null;
	const arrangeDirty = arrangement?.dirty() ?? false;
	const onArrangingChangeRef = useRef(onArrangingChange);
	onArrangingChangeRef.current = onArrangingChange;
	useEffect(() => { onArrangingChangeRef.current(arrangeDirty); }, [arrangeDirty]);
	useEffect(() => () => onArrangingChangeRef.current(false), []);
	useEffect(() => {
		if (!arrangement) return;
		const kept = arrangement.retain(new Set(persistentAgentStatuses.map((status) => status.id)));
		if (kept !== arrangement) setArrangement(kept);
	}, [arrangement, persistentAgentStatuses]);
	// The live region is emptied whenever arrange mode closes (Cancel, Escape,
	// a Save that landed): a sentence identical to the last one announced is
	// not a change to the DOM and would be read by nobody, and the same
	// position can come round again in a later arrange session.
	const startArranging = (): void => setArrangement(createRoomArrangement(orderedRoomStatuses.map((status) => status.id)));
	const cancelArranging = (): void => { if (!roomOrder.saving) { setAnnouncement(""); setArrangement(null); } };
	// Registered once for the whole arrange session, never re-registered: the
	// Escape stack is in enabling order, so an entry pushed again after a
	// failed save would sit above an overlay opened during the save (the
	// guide, Settings) and take the Escape meant for it. While saving the
	// handler itself does nothing.
	useEscapeKey(cancelArranging, arranging);
	async function saveArrangement(): Promise<void> {
		if (!arrangement || roomOrder.saving) return;
		if (await onChooseRoomOrder({ mode: "custom", customOrder: arrangement.ids() })) { setAnnouncement(""); setArrangement(null); }
	}
	// Custom with nothing arranged yet opens arrange mode on the order on
	// screen and writes nothing: Save is the first write, and a Cancel leaves
	// the saved mode as it was. With an arrangement saved, Custom is a choice
	// like any other.
	const chooseMode = (mode: RoomOrderMode): Promise<boolean> => {
		if (mode === "custom" && roomOrder.order && roomOrder.order.mode !== "custom" && roomOrder.order.customOrder.length === 0) {
			startArranging();
			return Promise.resolve(true);
		}
		return onChooseRoomOrder({ mode });
	};
	// The keyboard: each card is focusable while arranging, and a key moves
	// the focused card (moveByKey: the arrows one place, Home and End to the
	// ends), animated like a drag. The focus stays with the moved card: it is
	// found again after the render, because the card's DOM node moves with it
	// and a moved node loses focus. No key is taken while a card is held or a
	// save is in flight.
	const pendingFocusRef = useRef<string | null>(null);
	// The ONE name a room has in arrange mode: its display name, and its id
	// as well when another room shows the same name, so two rooms' cards
	// never share a label and two consecutive moves never produce the same
	// announcement (a repeated sentence is no change to the live region).
	const arrangeName = (status: PersistentAgentStatus): string => `${shownRoomName(status.displayName) || status.id}${hasDuplicateDisplayName(status) ? ` (room ${status.id})` : ""}`;
	// The ONE announcement of a move, whichever way it was made (a key, a drop).
	const announceMoved = (status: PersistentAgentStatus, next: RoomArrangement): void => setAnnouncement(`${arrangeName(status)}, position ${next.positionOf(status.id)} of ${next.count()}`);
	const moveByKeyboard = (status: PersistentAgentStatus, event: React.KeyboardEvent<HTMLDivElement>): void => {
		if (!arrangement || event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
		const next = moveByKey(arrangement, status.id, event.key);
		if (next === null) return;
		event.preventDefault(); // the arrows, Home and End are the card's while it has the focus, not the page's scroll
		if (next === arrangement || roomOrder.saving || cardDrag.activeId() !== null) return;
		pendingFocusRef.current = status.id;
		setArrangement(next);
		announceMoved(status, next);
	};
	useLayoutEffect(() => {
		const pending = pendingFocusRef.current;
		if (!pending) return;
		pendingFocusRef.current = null;
		const slot = arrangeSlots(gridRef.current).find((element) => element.dataset.arrangeSlot === pending);
		slot?.focus({ preventScroll: true });
		slot?.scrollIntoView({ block: "nearest" }); // a card moved off screen (End) is brought into view
	}, [arrangement]);
	const statusById = new Map(persistentAgentStatuses.map((status) => [status.id, status]));
	const leaveGuarded = (leave: () => void) => (): void => { if (confirmLeavingArrangement(arrangeDirty)) leave(); };
	// Dragging a card (slice 4). The gesture is home-room-drag.ts;
	// this screen feeds it the pointer events of the card's slot (the wrapper
	// around the card, whose own controls are inert while arranging) and the
	// slots' boxes at rest, and draws what it says: while a card is held the grid is
	// the arrangement as it would be after the drop (a moveTo preview, nothing
	// written), so the others step aside and the gap is where it lands; the
	// motion is use-room-arrange-motion.ts. The preview is drawn with the
	// slots' CSS order, never by moving them in the DOM: a moved node loses
	// the pointer capture (and the drag with it), and the focus. A drop ends
	// in ONE moveTo and the same announcement as a button move; focus stays
	// where it was. A finger or a pen picks a card up with a long press (the
	// timer is this screen's, the rule the module's); moving sooner scrolls
	// the page, and once a card is held the page does not scroll under the
	// finger (touchmove is refused while held, and the long press's menu is
	// refused while arranging). Near the top or bottom edge a held card
	// scrolls the page slowly (use-room-arrange-motion.ts). Escape while a card is
	// held puts it back and nothing else: its entry is enabled only while held,
	// so it sits above arrange mode's and leaves the stack with the drag. A
	// gesture the browser takes away (pointercancel, a lost capture) puts the
	// card back too, as does the card's room vanishing or arrange mode closing
	// under it (Escape, Enter on the focused Cancel, a save landing), for a
	// press not yet held as well, whose handle unmounts with its release still
	// to come; left in the module, the next session's first move would lift
	// the card pressed before. Another pointer changes nothing while one
	// holds a card: its release and its cancel are its own. A press while a save is in flight starts nothing, and a drop that
	// lands during one is refused, as a key is.
	const cardDragRef = useRef<CardDrag | null>(null);
	if (!cardDragRef.current) cardDragRef.current = createCardDrag();
	const cardDrag = cardDragRef.current;
	const [dragView, setDragView] = useState<CardDragView | null>(null);
	const dragging = dragView !== null;
	const gridRef = useRef<HTMLElement | null>(null);
	// The held card's box on screen at the press: it is drawn where the pointer carries it from there.
	const grabRef = useRef<{ id: string; box: Rect } | null>(null);
	const slotLayout = (heldId: string): SlotLayout => {
		const grid = gridRef.current;
		// In the order drawn: the preview's CSS order, the DOM's where none is set (a stable sort).
		const slotElements = arrangeSlots(grid).sort((a, b) => Number(a.style.order || 0) - Number(b.style.order || 0));
		const gridBox = grid?.getBoundingClientRect();
		return {
			slots: grid ? slotElements.map((element) => slotRestBox(grid, element, gridBox)) : [],
			held: slotElements.findIndex((element) => element.dataset.arrangeSlot === heldId),
		};
	};
	const pointOf = (event: React.PointerEvent): { x: number; y: number } => ({ x: event.clientX, y: event.clientY });
	const longPressRef = useRef<number | null>(null);
	const stopLongPress = (): void => { if (longPressRef.current !== null) window.clearTimeout(longPressRef.current); longPressRef.current = null; };
	useEffect(() => stopLongPress, []);
	// The pressing pointer and where it is, for the edge scroll.
	const pointerRef = useRef<{ id: number; x: number; y: number } | null>(null);
	const cancelDrag = (pointerId?: number): void => { cardDrag.cancel(pointerId); if (cardDrag.activeId() === null) stopLongPress(); setDragView(cardDrag.view()); };
	const cancelByPointer = (event: React.PointerEvent<HTMLDivElement>): void => cancelDrag(event.pointerId);
	const pressCard = (status: PersistentAgentStatus, event: React.PointerEvent<HTMLDivElement>): void => {
		if (!arrangement || roomOrder.saving) return;
		if (!cardDrag.press(status.id, pointOf(event), event.pointerType, event.button, event.pointerId)) return;
		event.currentTarget.setPointerCapture(event.pointerId);
		pointerRef.current = { id: event.pointerId, ...pointOf(event) };
		const box = event.currentTarget.getBoundingClientRect();
		grabRef.current = { id: status.id, box: { left: box.left, top: box.top, width: box.width, height: box.height } };
		if (event.pointerType === "mouse") return;
		const pointerId = event.pointerId;
		stopLongPress();
		longPressRef.current = window.setTimeout(() => { longPressRef.current = null; const held = cardDrag.hold(pointerId, slotLayout); if (held) setDragView(held); }, ROOM_LONG_PRESS_MS);
	};
	const carryCard = (event: React.PointerEvent<HTMLDivElement>): void => {
		if (event.pointerId === pointerRef.current?.id) pointerRef.current = { id: event.pointerId, ...pointOf(event) };
		setDragView(cardDrag.move(pointOf(event), event.pointerId, slotLayout));
		if (cardDrag.activeId() === null) stopLongPress(); // a finger that moved before the long press: the page scrolls
	};
	const dropCard = (event: React.PointerEvent<HTMLDivElement>): void => {
		// The drop is read first: releasing the capture may end the gesture (lostpointercapture) before a release read after it could land.
		const landed = cardDrag.release(pointOf(event), event.pointerId, slotLayout);
		if (cardDrag.activeId() === null) stopLongPress();
		setDragView(cardDrag.view()); // null once the gesture ended; still the held card when another pointer went up
		try { event.currentTarget.releasePointerCapture(event.pointerId); } catch {}
		if (!landed || !arrangement || roomOrder.saving) return;
		const status = statusById.get(landed.id);
		const next = arrangement.moveTo(landed.id, landed.position);
		if (!status || next === arrangement) return;
		setArrangement(next);
		announceMoved(status, next);
	};
	useEscapeKey(cancelDrag, dragging);
	useEffect(() => {
		const active = cardDrag.activeId(); // pressed or held: a press under the threshold is a gesture too
		if (active !== null && (!arrangement || arrangement.positionOf(active) === null)) cancelDrag();
	}, [arrangement, dragView]);
	useEffect(() => {
		if (!dragging) return;
		const onScroll = (): void => { setDragView(cardDrag.scrolled(slotLayout)); };
		// Registered by hand: React's touchmove is passive and could not refuse the page's scroll.
		const onTouchMove = (event: TouchEvent): void => { if (event.cancelable) event.preventDefault(); };
		document.addEventListener("scroll", onScroll, { capture: true, passive: true });
		document.addEventListener("touchmove", onTouchMove, { passive: false });
		return () => {
			document.removeEventListener("scroll", onScroll, { capture: true });
			document.removeEventListener("touchmove", onTouchMove);
		};
	}, [dragging]);
	useArrangeEdgeScroll(gridRef, dragging, pointerRef);
	const arrangedStatuses = arrangement ? arrangement.ids().map((id) => statusById.get(id)).filter((status): status is PersistentAgentStatus => status !== undefined) : null;
	// While a card is held, the arrangement after its drop, drawn by each slot's CSS order. The orders are
	// negative so the "New room" card (order 0) stays last.
	const preview = arrangement && dragView ? arrangement.moveTo(dragView.id, dragView.position) : null;
	const previewOrder = (id: string): number | undefined => (preview ? (preview.positionOf(id) ?? 0) - 1 - preview.count() : undefined);
	const grab = grabRef.current;
	useRoomArrangeMotion(gridRef, arranging, dragView && grab?.id === dragView.id ? { id: dragView.id, grab: grab.box, dx: dragView.dx, dy: dragView.dy } : null);
	const displayNameCounts = roomStatuses.reduce((counts, status) => {
		const key = shownRoomName(status.displayName).toLocaleLowerCase();
		if (!key) return counts;
		counts.set(key, (counts.get(key) ?? 0) + 1);
		return counts;
	}, new Map<string, number>());
	const hasDuplicateDisplayName = (status: PersistentAgentStatus): boolean => {
		const key = shownRoomName(status.displayName).toLocaleLowerCase();
		return key ? (displayNameCounts.get(key) ?? 0) > 1 : false;
	};
	const aiReadiness = homeAiProfileStatus(modelStatus, aiProfileSelection);
	// An empty Home leads with what comes next: connecting an AI while nothing
	// can answer, then the first room once a new room could talk. Null once
	// rooms exist, before the model status is read (so no line shows that
	// turns out wrong a moment later), and while an AI is connected but the
	// default for new rooms cannot run, which the setup pill points to.
	const emptyHome = roomStatuses.length > 0 ? null : aiReadiness === "no-model" ? "connect-first" : aiReadiness === "ready" ? "create-first" : null;
	const showSetupPill = roomStatuses.length > 0 ? aiReadiness === "no-model" : aiReadiness === "default-unavailable";
	// Where AI setup is read-only, Home says who connects one: a paired device
	// is offered a look at it, and a shared server's member is sent to the
	// admin, with nothing to press.
	const aiSetupRole = sharedServerRole(remoteClientContext);
	const aiSetupReadOnly = aiSetupLocked(remoteClientContext);
	const connectLine = aiSetupRole ? noModelSentence(aiSetupRole) : aiSetupReadOnly ? "Connect one on the computer this app runs on, in Settings, AI setup." : "Use a subscription you already pay for, an API key, your company's gateway, or a model running on this computer.";
	// The empty Home with nothing to answer offers only the way to connect one,
	// and waits to know that before it draws New room, so no box comes and goes.
	const aiKnown = modelStatus !== null || aiProfileSelection !== null;
	const newRoomShown = gridDrawn && (roomStatuses.length > 0 || (aiKnown && emptyHome !== "connect-first"));
	const firstRunGuide = useFirstRunGuide();
	const providerLabels = Object.fromEntries((modelStatus?.providers ?? []).map((provider) => [provider.id, provider.label]));
	const offeredModels = (modelStatus?.providers ?? []).flatMap((provider) => [...provider.conversation, ...provider.memory]);
	// A room is created to be talked to: after Create, enter it the way its
	// card's Enter would, on the room's conversation model. Without a model
	// that can run (no provider signed in) the new card simply waits on Home.
	const openCreatedRoom = (created: PersistentAgentCreateResponse | null): void => {
		setCreateOpen(false);
		onRefreshPersistentAgent();
		if (created?.status?.models?.conversation.effective) void onOpenPersistentAgent(created.status);
	};

	return (
		<div className="landing-shell with-product-sidebar">
			<ProductSidebar onHome={() => {}} onSettings={onOpenSettings} onDashboard={leaveGuarded(onOpenDashboard)} onMemory={leaveGuarded(onOpenMemory)} theme={theme} appearance={appearance} onSetAppearance={onSetAppearance} active="home" />
			<div className="landing home-page">
			<section className="landing-hero">
				<div className={`landing-hero-head${arranging ? " is-arranging" : ""}`}>
					<div>
						<h1>Your rooms.</h1>
						{roomStatuses.length > 0 ? <p>Pick up where you left off, or start a new room.</p> : emptyHome === "create-first" ? <p>You're set up. Create your first room.</p> : null}
					</div>
					<div className="landing-hero-actions">
						{roomOrder.order && !sharedServer && (arranging || roomStatuses.length >= ROOM_SORT_MIN_ROOMS) && (
							<RoomSortControl order={roomOrder.order} saving={roomOrder.saving} saveError={roomOrder.saveError} onChoose={chooseMode} onArrange={startArranging} arranging={arrangement ? { onSave: () => void saveArrangement(), onCancel: cancelArranging } : null} />
						)}
						<div className="room-arrange-live" role="status" aria-live="polite">{announcement}</div>
					</div>
				</div>
				{emptyHome === "connect-first" && (
					<div className="home-connect-card">
						<h2>Connect an AI to get started</h2>
						<p>{connectLine}</p>
						{aiSetupRole !== "member" && <button type="button" className={`landing-action${aiSetupReadOnly ? " secondary" : ""}`} onClick={() => onOpenSettings("ai-setup")}>{aiSetupReadOnly ? "See AI setup" : "Connect AI"}</button>}
					</div>
				)}
				{showSetupPill && (
					<button type="button" className="home-ai-profile-status setup-needed" onClick={() => onOpenSettings("ai-setup")} title={sharedServer ? "Open Settings to see the AI setup" : "Open Settings to finish AI setup"}>
						AI setup needed
					</button>
				)}
				{persistentResumeError && (persistentResumeError === REMEMBER_SAVED_REOPEN_SENTENCE || persistentResumeError === REMEMBER_SAVED_ELSEWHERE_SENTENCE
					? <div className="home-resume-status" role="status">{persistentResumeError}</div>
					: <div className="home-resume-error" role="alert">{persistentResumeError}</div>
				)}
			</section>
			<section ref={gridRef} className={`landing-grid${roomStatuses.length === 0 ? " landing-grid--empty" : ""}${arranging ? " is-arranging" : ""}`} aria-label="Rooms">
				{(arrangedStatuses ?? orderedRoomStatuses).map((status, index, list) => {
					const card = <PersistentAgentCard key={status.id} status={status} arranging={arranging} thread={persistentThread?.agentId === status.id ? persistentThread : null} live={persistentLive && persistentThread?.agentId === status.id} duplicateDisplayName={hasDuplicateDisplayName(status)} backgroundReady={backgroundReadyRooms?.has(status.id) ?? false} purging={purgingRooms?.has(status.id) ?? false} onEnter={onOpenPersistentAgent} onResume={onResumePersistentAgent} onMaintain={onMaintainPersistentAgent} onOpenSettings={() => openRoomSettings(status)} onOpenModelSettings={() => openRoomSettings(status, "model")} providerLabels={providerLabels} offeredModels={offeredModels} />;
					if (!arrangedStatuses) return card;
					const held = dragView?.id === status.id;
					return (
						<div
							className={`room-arrange-slot${held ? " is-dragging" : ""}`}
							key={status.id}
							data-arrange-slot={status.id}
							style={{ order: previewOrder(status.id) }}
							tabIndex={0}
							role="button"
							aria-roledescription="movable room"
							aria-label={`${arrangeName(status)}, position ${index + 1} of ${list.length}`}
							aria-describedby={ROOM_ARRANGE_HINT_ID}
							onKeyDown={(event) => moveByKeyboard(status, event)}
							onPointerDown={(event) => pressCard(status, event)}
							onPointerMove={carryCard}
							onPointerUp={dropCard}
							onPointerCancel={cancelByPointer}
							onLostPointerCapture={cancelByPointer}
							onContextMenu={(event) => event.preventDefault()}
						>
							{card}
						</div>
					);
				})}
				{newRoomShown && (
					<button type="button" className={`landing-card add-room-card${emptyHome === "create-first" ? " is-primary" : ""}`} disabled={arranging} onClick={() => setCreateOpen(true)} aria-label="Create a new room" aria-describedby={aiReadiness === "no-model" ? "add-room-hint" : undefined}>
						<span className="add-room-plus" aria-hidden="true">+</span>
						<span className="add-room-label">New room</span>
						{aiReadiness === "no-model" && <span className="add-room-hint" id="add-room-hint">{aiSetupRole === "member" ? "Ask your admin for a model first" : "Connect an AI first"}</span>}
					</button>
				)}
			</section>
			{!arranging && <ArchivedRoomsSection activeRoomCount={roomStatuses.length} serviceBack={serviceBack} onRestored={onRefreshPersistentAgent} />}
			</div>
			{firstRunGuide.open && <Help onClose={firstRunGuide.close} />}
			{createOpen && (
				<div className="room-settings-overlay create-room-overlay" role="dialog" aria-modal="true" aria-label="Create room" onClick={() => setCreateOpen(false)}>
					<div className="room-settings-modal create-room-modal" onClick={(e) => e.stopPropagation()}>
						<div className="room-settings-head">
							<div className="room-settings-title-block">
								<div className="room-settings-title-row">
									<h2>Create a room</h2>
								</div>
							</div>
							<button className="settings-dialog-close" onClick={() => setCreateOpen(false)} aria-label="Close"><CloseIcon size={16} /></button>
						</div>
						<div className="room-settings-body">
							<CreateRoomPanel onCreate={onCreatePersistentAgent} initialOpen variant="section" onCreated={openCreatedRoom} onCancel={() => setCreateOpen(false)} />
						</div>
					</div>
				</div>
			)}
			{settingsRoom && (
				<RoomSettingsModal status={settingsRoom} initialPane={settingsRoomPane} onClose={() => setSettingsRoomId(null)} onArchive={onArchiveRoom} onPurge={onPurgeRoom} onRefresh={onRefreshPersistentAgent} onMementoForget={() => onMementoForget(settingsRoom.id)} onOpenSkillsLibrary={() => onOpenSettings("skills")} onOpenConnectors={() => onOpenSettings("connectors")} />
			)}
		</div>
	);
}

// Archived rooms live below the grid, folded away: they left Home on purpose,
// so they only take up one line until asked. Hidden entirely when empty —
// but a FAILED load is not "empty": this section is the only way back to an
// archived room, so a fetch failure shows itself with a retry.
function ArchivedRoomsSection({ activeRoomCount, serviceBack, onRestored }: { activeRoomCount: number; serviceBack: number; onRestored: () => void }) {
	const [rooms, setRooms] = useState<ArchivedPersistentAgentSummary[] | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);
	const [retryNonce, setRetryNonce] = useState(0);
	const [open, setOpen] = useState(false);
	const [armedId, setArmedId] = useState<PersistentAgentId | null>(null);
	const [busy, setBusy] = useState<{ id: PersistentAgentId; action: "restore" | "purge" } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [note, setNote] = useState<string | null>(null);
	// Set by this section's own restore/delete right before they trigger a
	// refetch: their status note must survive that one refetch, while any
	// OTHER cause (a room archived elsewhere, a retry) clears stale notes.
	const keepNoteThroughRefetchRef = useRef(false);
	useEscapeKey(() => setArmedId(null), armedId !== null);

	// The active-room count changing means a room was archived, restored, or
	// created somewhere — refetch so this section and the grid never disagree.
	// A reconnect after an outage asks again too: a load that failed meanwhile
	// would otherwise wait for Try again. That ask keeps what the section was
	// saying: a restore's note or a failed restore is still true.
	const serviceBackSeenRef = useRef(serviceBack);
	useEffect(() => {
		const reconnectAsk = serviceBackSeenRef.current !== serviceBack;
		serviceBackSeenRef.current = serviceBack;
		if (keepNoteThroughRefetchRef.current) {
			keepNoteThroughRefetchRef.current = false;
		} else if (!reconnectAsk) {
			setNote(null);
			setError(null);
		}
		let cancelled = false;
		fetchArchivedPersistentRooms()
			.then((rows) => {
				if (cancelled) return;
				setRooms(rows);
				setLoadFailed(false);
			})
			.catch(() => { if (!cancelled) setLoadFailed(true); });
		return () => { cancelled = true; };
	}, [activeRoomCount, retryNonce, serviceBack]);

	async function restoreRoom(room: ArchivedPersistentAgentSummary): Promise<void> {
		setBusy({ id: room.id, action: "restore" });
		setArmedId(null);
		setError(null);
		setNote(null);
		const name = shownRoomName(room.displayName) || room.id;
		try {
			const response = await restorePersistentRoom(room.id);
			setRooms((rows) => (rows ?? []).filter((row) => row.id !== room.id));
			const parts = [`${name} is back on Home.`];
			if (response.enabledSchedules > 0) parts.push(`Its ${response.enabledSchedules} scheduled task${response.enabledSchedules === 1 ? "" : "s"} resume${response.enabledSchedules === 1 ? "s" : ""} at the usual time${response.enabledSchedules === 1 ? "" : "s"}.`);
			if (response.missedOnceSchedules > 0) parts.push(`${response.missedOnceSchedules} one-time task${response.missedOnceSchedules === 1 ? "" : "s"} missed ${response.missedOnceSchedules === 1 ? "its" : "their"} time while archived and need${response.missedOnceSchedules === 1 ? "s" : ""} a new one.`);
			if (response.scheduleNotice) parts.push(response.scheduleNotice);
			setNote(parts.join(" "));
			keepNoteThroughRefetchRef.current = true;
			onRestored();
		} catch (e) {
			setError((e as Error).message || "Failed to restore room.");
		} finally {
			setBusy(null);
		}
	}

	async function deleteForever(room: ArchivedPersistentAgentSummary): Promise<void> {
		if (armedId !== room.id) {
			setArmedId(room.id);
			setError(null);
			setNote(null);
			return;
		}
		setBusy({ id: room.id, action: "purge" });
		setError(null);
		try {
			// Direct call: an archived room has no card, draft, badge, or bound
			// session for the App-level purge handler to clean up.
			const response = await purgePersistentRoom(room.id, `DELETE ${room.id} FOREVER`);
			setRooms((rows) => (rows ?? []).filter((row) => row.id !== room.id));
			setNote(
				response.failed.length > 0
					? `${shownRoomName(room.displayName) || room.id} was deleted, but ${response.failed.length} item${response.failed.length === 1 ? "" : "s"} on this machine could not be removed.`
					: `${shownRoomName(room.displayName) || room.id} was deleted from this machine.`,
			);
		} catch (e) {
			setError((e as Error).message || "Failed to delete room.");
		} finally {
			setBusy(null);
			setArmedId(null);
		}
	}

	// A failed load with nothing cached must not read as "no archived rooms".
	if (loadFailed && (!rooms || rooms.length === 0)) {
		return (
			<section className="archived-rooms" aria-label="Archived rooms">
				<div className="archived-rooms-note" role="alert">
					Archived rooms could not be loaded.{" "}
					<button type="button" className="rs-quiet archived-rooms-retry" onClick={() => setRetryNonce((n) => n + 1)}>Try again</button>
				</div>
			</section>
		);
	}
	// The note must survive the last row disappearing, so the section only
	// hides once the list is empty AND there is nothing left to say.
	if (!rooms || (rooms.length === 0 && !note && !error)) return null;

	const archivedDate = (archivedAt: number): string => new Date(archivedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

	return (
		<section className="archived-rooms" aria-label="Archived rooms">
			{rooms.length > 0 && (
				<button type="button" className="archived-rooms-summary" aria-expanded={open} title="Show or hide archived rooms" onClick={() => { setOpen((v) => !v); setArmedId(null); }}>
					<span className="archived-rooms-title">Archived rooms ({rooms.length})</span>
					<span className="archived-rooms-toggle" aria-hidden="true">{open ? "▾" : "▸"}</span>
				</button>
			)}
			{open && rooms.length > 0 && (
				<div className="archived-rooms-panel">
					{rooms.map((room) => (
						<div key={room.id} className="archived-room-row">
							<div className="archived-room-main">
								<span className="archived-room-name" {...(room.archivedReason ? { title: room.archivedReason } : {})}>{shownRoomName(room.displayName) || room.id}</span>
								<span className="archived-room-meta">
									archived {archivedDate(room.archivedAt)} · {room.counts.memories} {room.counts.memories === 1 ? "memory" : "memories"} · {room.counts.files} file{room.counts.files === 1 ? "" : "s"}
								</span>
								{armedId === room.id && (
									<span className="archived-room-meta archived-room-armed" role="alert">
										Delete {shownRoomName(room.displayName) || room.id} forever? {roomFilesSentence(room.counts)}Everything is removed from this machine.
									</span>
								)}
							</div>
							<div className="archived-room-actions">
								{armedId === room.id && <button type="button" className="rs-quiet" disabled={busy?.id === room.id} onClick={() => setArmedId(null)} title="Cancel — keep this room archived">Keep it</button>}
								<button type="button" className="rs-btn" disabled={busy?.id === room.id} title="Bring this room back to Home" onClick={() => void restoreRoom(room)}>
									{busy?.id === room.id && busy.action === "restore" ? "Restoring…" : "Restore"}
								</button>
								<button type="button" className="rs-btn rs-btn-danger" disabled={busy?.id === room.id} title="Erase this room and its files from this machine" onClick={() => void deleteForever(room)}>
									{busy?.id === room.id && busy.action === "purge" ? "Deleting…" : "Delete forever"}
								</button>
							</div>
						</div>
					))}
				</div>
			)}
			{note && <p className="archived-rooms-note" role="status">{note}</p>}
			{error && <div className="workspaces-error archived-rooms-note">{error}</div>}
		</section>
	);
}
