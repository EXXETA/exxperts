import { type FormEvent, useEffect, useMemo, useState } from "react";
import { CreateRoomPanelView } from "../components/create-room-panel";
import { InRoomChatShellView } from "../components/in-room-chat";
import { PersistentAgentCard } from "../components/launcher-room-card";
import { ProductSidebar, type ProductSidebarActive, type ThemeMode } from "../components/product-shell";
import { Sidebar } from "../components/Sidebar";
import type { PersistentAgentAiProfileSelectionStatus, PersistentAgentStatus, WebChatModelOption, WebChatModelStatus } from "../types";
import { FIXTURE_DEFAULT_AGENT_ID, fixtureStates, type CreateRoomFixtureState, type FixtureState, type HomeFixtureState, type InRoomChatActionItem, type InRoomChatFixtureState, type SidebarFixtureState, type TaskCardsFixtureState } from "./fixture-data";
import { TaskRunView } from "../components/task-run-view";
import { TaskThreadItem } from "../components/Message";
import type { TaskState } from "../task-stream";

const noop = () => {};

function sidebarFixtureFor(active: ProductSidebarActive, theme: ThemeMode, connected = true) {
	return (
		<ProductSidebar
			onHome={noop}
			onAiSetup={noop}
			onDashboard={noop}
			connected={connected}
			theme={theme}
			onToggleTheme={noop}
			active={active}
			aiProfileStatus={null}
			onSelectAiProfile={async () => {}}
			onRefreshAiProfile={() => {}}
		/>
	);
}

function SidebarFixtureScreen({ fixture, theme }: { fixture: SidebarFixtureState; theme: ThemeMode }) {
	return (
		<div className="landing-shell with-product-sidebar">
			{sidebarFixtureFor(fixture.active, theme, fixture.connected)}
			<div className="landing">
				<section className="landing-hero">
					<h1>{fixture.label}</h1>
					<p>{fixture.description}</p>
					<p className="fixture-gallery-note">Navigation callbacks are inert in this static fixture.</p>
				</section>
			</div>
		</div>
	);
}

function sortedRoomStatuses(statuses: PersistentAgentStatus[]): PersistentAgentStatus[] {
	return statuses.slice().sort((a, b) => {
		if (a.id === FIXTURE_DEFAULT_AGENT_ID) return -1;
		if (b.id === FIXTURE_DEFAULT_AGENT_ID) return 1;
		return (a.displayName || "").localeCompare(b.displayName || "");
	});
}

function homeAiProfileStatus(modelStatus: WebChatModelStatus | null, aiProfileStatus: PersistentAgentAiProfileSelectionStatus | null): { message: string; ready: boolean | undefined } | null {
	if (!modelStatus && !aiProfileStatus) return null;
	const configured = aiProfileStatus ? aiProfileStatus.state.source !== "default" : true;
	if (!configured) return { message: "AI setup needed · connect a provider to start", ready: false };
	const activeProfile = aiProfileStatus?.activeProfile;
	const ready = activeProfile ? activeProfile.ready : modelStatus?.ready;
	const label = modelStatus?.activeProfileLabel || activeProfile?.label || "AI profile";
	return { message: ready === false ? `AI profile · ${label} setup needed` : `AI profile · ${label}`, ready };
}

function HomeFixtureScreen({ fixture, theme }: { fixture: HomeFixtureState; theme: ThemeMode }) {
	const roomStatuses = sortedRoomStatuses(fixture.statuses);
	const firstRoomStatus = roomStatuses.find((status) => status.id === FIXTURE_DEFAULT_AGENT_ID) ?? roomStatuses[0] ?? null;
	const additionalRoomStatuses = firstRoomStatus ? roomStatuses.filter((status) => status.id !== firstRoomStatus.id) : [];
	const displayNameCounts = roomStatuses.reduce((counts, status) => {
		const key = (status.displayName || "").trim().toLocaleLowerCase();
		if (!key) return counts;
		counts.set(key, (counts.get(key) ?? 0) + 1);
		return counts;
	}, new Map<string, number>());
	const hasDuplicateDisplayName = (status: PersistentAgentStatus): boolean => {
		const key = (status.displayName || "").trim().toLocaleLowerCase();
		return key ? (displayNameCounts.get(key) ?? 0) > 1 : false;
	};
	const aiProfileStatus = homeAiProfileStatus(fixture.modelStatus, fixture.aiProfileStatus);
	const onEnter = (_status: PersistentAgentStatus, _model: WebChatModelOption) => {};
	const onResume = (_status: PersistentAgentStatus) => {};
	const onMaintain = (_target: { agentId: string; displayName: string }) => {};

	function roomCard(status: PersistentAgentStatus) {
		return (
			<PersistentAgentCard
				key={status.id}
				status={status}
				modelStatus={fixture.modelStatus}
				aiProfileStatus={fixture.aiProfileStatus}
				thread={fixture.thread?.agentId === status.id ? fixture.thread : null}
				live={fixture.live && fixture.thread?.agentId === status.id}
				duplicateDisplayName={hasDuplicateDisplayName(status)}
				onEnter={onEnter}
				onResume={onResume}
				onMaintain={onMaintain}
			/>
		);
	}

	return (
		<div className="landing-shell with-product-sidebar">
			{sidebarFixtureFor("home", theme)}
			<div className="landing home-page">
				<section className="landing-hero">
					<h1>Your exxperts.</h1>
					<p>Enter a room with your exxpert and start working. Each exxpert remembers more context the more you interact.</p>
					{aiProfileStatus && (
						<div className={`home-ai-profile-status${aiProfileStatus.ready === false ? " setup-needed" : ""}`}>
							{aiProfileStatus.message}
						</div>
					)}
				</section>
				<section className="landing-grid" aria-label="exxperts entry points">
					{roomStatuses.length === 0 && (
						<article className="landing-card home-empty-state">
							<div>
								<p className="card-kicker">Home</p>
								<h2>No active rooms yet.</h2>
								<p>Create a room to keep memory, threads, and workspace context separate.</p>
							</div>
							<button className="landing-action" onClick={noop}>Create room</button>
						</article>
					)}
					{firstRoomStatus && roomCard(firstRoomStatus)}
					{additionalRoomStatuses.map(roomCard)}
				</section>
			</div>
		</div>
	);
}

function CreateRoomFixtureScreen({ fixture, theme }: { fixture: CreateRoomFixtureState; theme: ThemeMode }) {
	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
	}

	return (
		<div className="landing-shell with-product-sidebar">
			{sidebarFixtureFor("home", theme)}
			<div className="landing ai-setup-page">
				<section className="landing-hero ai-setup-hero">
					<p className="eyebrow">New room</p>
					<h1>Create a persistent room.</h1>
					<p>Create a new persistent room with its own personal agent and local memory files.</p>
				</section>
				<CreateRoomPanelView
					variant="section"
					open={fixture.open}
					values={fixture.values}
					submitting={fixture.submitting}
					error={fixture.error}
					successName={fixture.successName}
					onOpen={noop}
					onClose={noop}
					onSubmit={submit}
					onChange={noop}
				/>
			</div>
		</div>
	);
}

function fixtureActionButtons(actions: InRoomChatActionItem[] | undefined) {
	return actions?.map((action) => (
		<button key={`${action.label}-${action.title ?? ""}`} className="icon-btn" title={action.title} disabled={action.disabled} onClick={noop}>
			{action.label}
		</button>
	));
}

function InRoomChatFixtureScreen({ fixture, theme }: { fixture: InRoomChatFixtureState; theme: ThemeMode }) {
	const composerPlaceholder = fixture.composerPlaceholder ?? (fixture.busy ? "Working… Enter to queue" : `Ask ${fixture.activeDisplay}…`);
	const onSend = (_text: string) => false;
	const onResolveApproval = (_requestId: string, _value: any, _label: string) => {};
	return (
		<InRoomChatShellView
			sidebar={
				<Sidebar
					onHome={noop}
					connected={fixture.connected}
					theme={theme}
					onToggleTheme={noop}
					onHelp={noop}
				/>
			}
			activeDisplay={fixture.activeDisplay}
			ownerSecondary={fixture.ownerSecondary}
			busy={fixture.busy}
			usage={fixture.usage}
			contextHealth={fixture.contextHealth}
			currentModelLabel={fixture.currentModelLabel}
			topbarActions={fixture.topbarActions?.length ? <>{fixtureActionButtons(fixture.topbarActions)}</> : undefined}
			composerRightActions={fixture.composerRightActions ? <>{fixtureActionButtons(fixture.composerRightActions)}</> : undefined}
			connected={fixture.connected}
			items={fixture.items}
			empty={fixture.items.length === 0}
			onSend={onSend}
			composerPlaceholder={composerPlaceholder}
			sendUnavailable={!fixture.connected}
			initialDraftValue={fixture.inputValue}
			draftResetKey={fixture.id}
			onResolveApproval={onResolveApproval}
			onApprovalPreview={noop}
		/>
	);
}

const TASK_FIXTURE_BASE: TaskState = {
	phase: "running",
	taskId: "tsk-fixture01",
	template: "deck",
	templateVersion: 3,
	templateLabel: "Slide deck",
	title: "Turn the Q3 roadmap notes into a six-slide deck for the steering meeting",
	model: null,
	tail: "I'll open with the two decisions we need.\n[artifact_write_html_deck]\nwriting q3-roadmap-deck.html…",
	summary: "",
	artifacts: [],
	thumbnails: [],
	generatedAt: null,
	usage: null,
	minimized: false,
	stopRequested: false,
	errorMessage: null,
};

const TASK_FIXTURE_DONE: TaskState = {
	...TASK_FIXTURE_BASE,
	phase: "done",
	summary: "Built a six-slide deck: two decision slides up front, then timeline, risks, owners, and a closing action slide. **File:** `tasks/tsk-fixture01/q3-roadmap-deck.html`",
	artifacts: [{ relativePath: "tasks/tsk-fixture01/q3-roadmap-deck.html", bytes: 48_213, extension: ".html" }],
	generatedAt: "2026-07-13T11:00:00.000Z",
};

const TASK_FIXTURE_STOPPED: TaskState = {
	...TASK_FIXTURE_BASE,
	phase: "error",
	stopRequested: true,
	errorMessage: null,
};

function TaskCardsFixtureScreen({ fixture }: { fixture: TaskCardsFixtureState }) {
	void fixture;
	// The done-card is retired (status grammar, 2026-07-18); its surviving
	// surfaces are the run view (running / stopped) and the kept thread item.
	// Done results live in the artifact viewer, exercised by the app itself.
	const stack = [
		{ key: "running", state: TASK_FIXTURE_BASE },
		{ key: "stopped", state: TASK_FIXTURE_STOPPED },
	];
	return (
		<div className="fixture-frame" style={{ display: "flex", flexDirection: "column", gap: 18, padding: 24, maxWidth: 860 }}>
			{stack.map(({ key, state }) => (
				<div key={key} style={{ height: 320, display: "flex" }}>
					<TaskRunView state={state} onStop={noop} onClose={noop} maximized={false} onToggleMaximize={noop} />
				</div>
			))}
			<div className="messages" style={{ overflow: "visible" }}>
				<TaskThreadItem
					item={{
						kind: "task",
						id: "fixture-task-item",
						taskId: "tsk-fixture01",
						template: "deck",
						templateVersion: 3,
						templateLabel: "Slide deck",
						title: "Turn the Q3 roadmap notes into a six-slide deck for the steering meeting",
						summary: TASK_FIXTURE_DONE.summary,
						artifacts: TASK_FIXTURE_DONE.artifacts,
						generatedAt: "2026-07-13T11:00:00.000Z",
						transferred: true,
					}}
				/>
			</div>
		</div>
	);
}

function FixturePreview({ fixture, theme }: { fixture: FixtureState; theme: ThemeMode }) {
	switch (fixture.kind) {
		case "sidebar":
			return <SidebarFixtureScreen fixture={fixture} theme={theme} />;
		case "home":
			return <HomeFixtureScreen fixture={fixture} theme={theme} />;
		case "create-room":
			return <CreateRoomFixtureScreen fixture={fixture} theme={theme} />;
		case "in-room-chat":
			return <InRoomChatFixtureScreen fixture={fixture} theme={theme} />;
		case "task-cards":
			return <TaskCardsFixtureScreen fixture={fixture} />;
	}
}

export function FixtureGallery() {
	const [activeFixtureId, setActiveFixtureId] = useState<string>(fixtureStates[0].id);
	const [theme, setTheme] = useState<ThemeMode>("dark");
	const activeFixture = useMemo(
		() => fixtureStates.find((fixture) => fixture.id === activeFixtureId) ?? fixtureStates[0],
		[activeFixtureId],
	);

	useEffect(() => {
		document.documentElement.dataset.theme = theme;
	}, [theme]);

	return (
		<div className="fixture-gallery" data-fixture-id={activeFixture.id}>
			<header className="fixture-gallery-header" aria-label="Fixture gallery controls">
				<div className="fixture-gallery-title">
					<p className="eyebrow">Static fixtures</p>
					<h1>UI workbench</h1>
					<p>Frontend-only visual states for safe UI iteration. This entrypoint does not import or run the live app.</p>
				</div>
				<nav className="fixture-gallery-nav" aria-label="Fixture states">
					{fixtureStates.map((fixture) => (
						<button key={fixture.id} className={`list-btn ${activeFixture.id === fixture.id ? "active" : ""}`} onClick={() => setActiveFixtureId(fixture.id)}>
							{fixture.label}
						</button>
					))}
				</nav>
				<button className="theme-toggle" onClick={() => setTheme((value) => (value === "dark" ? "light" : "dark"))} title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}>
					{theme === "dark" ? "Light" : "Dark"}
				</button>
			</header>
			<main className="fixture-gallery-main">
				<section className="fixture-gallery-stage" aria-label={`Selected fixture preview: ${activeFixture.label}`}>
					<FixturePreview fixture={activeFixture} theme={theme} />
				</section>
			</main>
		</div>
	);
}
