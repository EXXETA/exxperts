import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { PersistentAgentStatus } from "../types";
import { apiErrorCode } from "../api";
import { fetchPersistentRoomSkillSettings, updatePersistentRoomSkillSetting, type PersistentRoomEnabledSkillStatus, type PersistentRoomSkillSettingsResponse } from "../persistent-room-management-api";
import { fetchSkills, type SkillListItem } from "../skills-api";
import { sharedServerNonAdmin, useRemoteClientContext } from "../remote-client-context";
import { OPEN_SKILL, ROOM_SKILL_GROUPS, ROOM_SKILL_UNREADABLE_LINE, ROOM_SKILLS_EMPTY_LIBRARY, ROOM_SKILLS_LEAD, ROOM_SKILLS_MANAGE, ROOM_SKILLS_SEARCH, roomListOnCount, roomSkillsNoMatch, roomSkillSwitchFailedLine, roomSkillSwitchName, SKILL_INSTRUCTIONS_ONLY_LINES, SKILL_SCRIPTS_READ_ONLY_LINE, skillNameTakenByOtherLine, skillPickHowLine } from "../skill-source-copy";
import { GroupHeader, PaneHeader } from "./pane-header";
import { SkillByHandTag, SkillFilesAt } from "./skill-facts";
import { useSettingsLookNext } from "../settings-look";
import { ROOM_SKILL_FILES_LINES } from "../../../web-server/src/room-box/card-text";

/** One library skill as this room has it. */
interface RoomSkillRow {
	name: string;
	label: string;
	description: string;
	on: boolean;
	/** Its author marked it to start only when picked. */
	byHand: boolean;
	/** Its files can't be opened: it can be switched off, never on. */
	unreadable: boolean;
	/** The "/" name another skill has, which it would need: it has no switch here. */
	nameTaken?: string;
	/** Why rooms use only its instructions, for a skill from the folder shared with other tools. */
	instructionsOnly?: SkillListItem["instructionsOnly"];
	/** Where its files are, for a skill from the folder shared with other tools whose link leads outside ~/.agents. */
	filesAt?: string;
	/** On this Windows computer, its scripts run in a protected room only from a folder the room already opens. */
	scriptsReadOnly?: boolean;
	/** In the library, so its name opens its page. */
	inLibrary: boolean;
}

/** The library's skills, in its order, each on or off here; then any skill the room has on that the library no longer lists. */
function roomSkillRows(library: SkillListItem[], enabled: PersistentRoomEnabledSkillStatus[]): RoomSkillRow[] {
	const onByName = new Map(enabled.map((state) => [state.name, state] as const));
	const rows: RoomSkillRow[] = library.map((skill) => {
		const state = onByName.get(skill.name);
		return {
			name: skill.name,
			label: skill.displayName || skill.name,
			description: skill.description,
			on: state !== undefined,
			byHand: skill.disableModelInvocation === true || state?.manualOnly === true,
			unreadable: skill.unreadable === true || state?.status === "unreadable",
			nameTaken: skill.nameTaken,
			instructionsOnly: skill.instructionsOnly,
			filesAt: skill.filesAt,
			scriptsReadOnly: skill.scriptsReadOnly,
			inLibrary: true,
		};
	});
	const listed = new Set(library.map((skill) => skill.name));
	for (const state of enabled) {
		if (listed.has(state.name)) continue;
		rows.push({ name: state.name, label: state.displayName || state.name, description: "", on: true, byHand: state.manualOnly === true, unreadable: state.status === "unreadable", inLibrary: false });
	}
	return rows;
}

/** Where each row sits, by name: on or off as the room had it when the page opened or the search last changed. */
type Placement = ReadonlyMap<string, boolean>;

/**
 * Room settings, Skills: every library skill with its switch, the ones on in
 * this room first, and a search field over names and descriptions. A switch
 * saves on its click; one the server refuses goes back and says so on its row.
 * A row keeps its place while its switch is used, so nothing moves under the
 * finger; it moves when the search changes or the page opens again. The old
 * settings look puts the rows in an On and an Off group and opens a skill's
 * page in Settings, Skills from its name; the new look shows one list under
 * how many are on, opens a skill's page only from a row that can't be used,
 * and has one way to Settings, Skills at the end of the lead. Under the
 * lead, one line says when the room's skills can't read their files or can't
 * run their scripts, read again each time the page is shown, since the Folder
 * page beside it changes that.
 */
export function RoomSkillsSection({ status, visible, onOpenSkillsLibrary }: { status: PersistentAgentStatus; /** The page is the one shown in Room settings. */ visible: boolean; /** Opens Settings, Skills, at a skill's page when given its name. */ onOpenSkillsLibrary?: (skillName?: string) => void }) {
	const [library, setLibrary] = useState<SkillListItem[] | null>(null);
	const [enabled, setEnabled] = useState<PersistentRoomEnabledSkillStatus[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [skillFiles, setSkillFiles] = useState<PersistentRoomSkillSettingsResponse["skillFiles"]>(undefined);
	// A switch being saved, shown at the place it was moved to until the room's answer comes back.
	const [saving, setSaving] = useState<{ name: string; on: boolean } | null>(null);
	// A switch that did not take; `line` is the server's own sentence when a remote device may not save here.
	const [failed, setFailed] = useState<{ name: string; on: boolean; line?: string } | null>(null);
	const [query, setQuery] = useState("");
	const idBase = useId();
	const [placement, setPlacement] = useState<Placement | null>(null);
	// The switch to give the keyboard back to once its save is done, or its name when that switch can't be used.
	const [refocus, setRefocus] = useState<string | null>(null);
	const sectionRef = useRef<HTMLDivElement | null>(null);
	// Counts saves, so the read after one is dropped once a later save has started.
	const saveCount = useRef(0);
	const remoteClient = useRemoteClientContext();
	const canAddSkills = !remoteClient.remote && !sharedServerNonAdmin(remoteClient);
	const lookNext = useSettingsLookNext();

	// Both reads of the files line take a number, and an answer shows only when no later read has answered: a first read that lands after a later one never brings back an old line.
	const filesRead = useRef(0);
	const filesShown = useRef(0);
	const showFiles = (read: number, answer: PersistentRoomSkillSettingsResponse["skillFiles"]) => {
		if (read <= filesShown.current) return;
		filesShown.current = read;
		setSkillFiles(answer);
	};

	useEffect(() => {
		let cancelled = false;
		const read = ++filesRead.current;
		setLibrary(null);
		setEnabled(null);
		setPlacement(null);
		setLoadError(null);
		setFailed(null);
		setSkillFiles(undefined);
		Promise.all([fetchSkills(), fetchPersistentRoomSkillSettings(status.id)])
			.then(([skills, response]) => {
				if (cancelled) return;
				setLibrary(skills);
				setEnabled(response.skills);
				showFiles(read, response.skillFiles);
			})
			.catch((e) => {
				if (!cancelled) setLoadError((e as Error).message);
			});
		return () => {
			cancelled = true;
		};
	}, [status.id]);

	// Shown again after another page: the Folder page may have changed what the skills can do, so only the files line is read again and no row moves.
	const shownBefore = useRef(visible);
	useEffect(() => {
		const wasShown = shownBefore.current;
		shownBefore.current = visible;
		if (!visible || wasShown) return;
		let cancelled = false;
		const read = ++filesRead.current;
		fetchPersistentRoomSkillSettings(status.id)
			.then((response) => {
				if (!cancelled) showFiles(read, response.skillFiles);
			})
			.catch(() => {
				// A failed read keeps the line as it was.
			});
		return () => {
			cancelled = true;
		};
	}, [visible, status.id]);

	async function flip(name: string, on: boolean) {
		const hadFocus = document.activeElement instanceof HTMLInputElement && document.activeElement.dataset.skill === name;
		const save = ++saveCount.current;
		setSaving({ name, on });
		setFailed(null);
		try {
			setEnabled((await updatePersistentRoomSkillSetting(status.id, on ? "enable" : "disable", name)).skills);
		} catch (e) {
			setSaving(null);
			if (hadFocus) setRefocus(name);
			// A remote device may not switch a room's skills (only the computer itself saves them):
			// nothing was saved, and the server's sentence says why. Any other failure gets the plain line.
			if (apiErrorCode(e) === "remote_local_only") {
				setFailed({ name, on, line: (e as Error).message });
				return;
			}
			// A save whose answer was lost may still have reached the room: what the room says now wins,
			// and the failure line stays only where the switch did not take.
			try {
				const read = (await fetchPersistentRoomSkillSettings(status.id)).skills;
				if (save !== saveCount.current) return;
				setEnabled(read);
				if (read.some((state) => state.name === name) !== on) setFailed({ name, on });
			} catch {
				if (save === saveCount.current) setFailed({ name, on });
			}
			return;
		}
		setSaving(null);
		if (hadFocus) setRefocus(name);
		// The save's answer carries no author's mark; the full view adds it, and a failed read keeps what was saved.
		try {
			const read = (await fetchPersistentRoomSkillSettings(status.id)).skills;
			if (save === saveCount.current) setEnabled(read);
		} catch {
			// The switch already shows what the room saved.
		}
	}

	useEffect(() => {
		if (!refocus) return;
		// A switch that can't be used now (a skill switched off whose files can't be opened) hands the keyboard to its row's name.
		const input = sectionRef.current?.querySelector<HTMLInputElement>(`input[data-skill="${CSS.escape(refocus)}"]`);
		(input?.disabled ? input.closest(".room-skill")?.querySelector<HTMLButtonElement>("button.room-skill-open") : input)?.focus();
		setRefocus(null);
	}, [refocus, enabled, failed]);

	const rows = useMemo(() => (library && enabled ? roomSkillRows(library, enabled) : null), [library, enabled]);
	const placeRows = (from: RoomSkillRow[]): Placement => new Map(from.map((row) => [row.name, row.on] as const));
	// The first read places the rows; later reads only change their switches.
	useEffect(() => {
		if (rows && !placement) setPlacement(placeRows(rows));
	}, [rows, placement]);
	const placedOn = (row: RoomSkillRow) => placement?.get(row.name) ?? row.on;
	const shown = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!rows || !q) return rows ?? [];
		return rows.filter((row) => `${row.label} ${row.name} ${row.description}`.toLowerCase().includes(q));
	}, [rows, query]);
	const anyOn = (rows ?? []).some(placedOn);
	// Only where a skill that is on has files beside SKILL.md that rooms open: the person's own, or a shared-folder skill's that list them. Other skills' files open in no room.
	const filesLine = skillFiles && skillFiles !== "run" && !remoteClient.sharedServer && library && enabled
		&& library.some((skill) => (skill.source === "user" || skill.source === "shared") && skill.fileCount > 1 && enabled.some((state) => state.name === skill.name))
		? ROOM_SKILL_FILES_LINES[skillFiles]
		: null;

	function renderRow(row: RoomSkillRow) {
		const checked = saving?.name === row.name ? saving.on : row.on;
		const opens = row.inLibrary && (!lookNext || row.unreadable || row.nameTaken) && onOpenSkillsLibrary;
		// Where the description is: why the room can't use it, when it can't.
		// The name names the button that opens the skill's page; the line under it describes it.
		const nameId = `${idBase}-${row.name}-name`;
		const lineId = `${idBase}-${row.name}-line`;
		// In the new look the reason says what pressing its target does: open the skill's page.
		// A by-hand skill that is on says how to use it, and a shared-folder skill says why rooms can't open its
		// files, or where they are when its link leads outside ~/.agents, after its description and never cut with it.
		const how = row.byHand && row.on ? skillPickHowLine(row.name) : null;
		const kept = row.instructionsOnly ? SKILL_INSTRUCTIONS_ONLY_LINES[row.instructionsOnly] : row.filesAt ? <SkillFilesAt place={row.filesAt} /> : null;
		// On Windows, where Commands on would not let this skill's scripts run from outside the room's folder.
		const runs = row.scriptsReadOnly ? SKILL_SCRIPTS_READ_ONLY_LINE : null;
		const line = row.unreadable || row.nameTaken
			? <span id={lineId} className="settings-row-sub room-skill-problem">{row.unreadable ? ROOM_SKILL_UNREADABLE_LINE : skillNameTakenByOtherLine(row.nameTaken!)}{lookNext && opens && <>{" "}<span className="room-skill-open-link">{OPEN_SKILL}</span></>}</span>
			: how || kept || runs
				? <span id={lineId} className="settings-row-sub">{row.description && <span className="settings-row-clamp" title={row.description}>{row.description}</span>}{how && <span className="room-skill-how">{how}</span>}{kept && <span className="room-skill-how">{kept}</span>}{runs && <span className="room-skill-how">{runs}</span>}</span>
				: row.description && <span id={lineId} className="settings-row-sub settings-row-clamp" title={row.description}>{row.description}</span>;
		const head = (
			<span className="room-skill-head">
				{/* The chevron belongs to the name: one inline group, so it stays on the name's last word, before any tag. */}
				<span className="room-skill-label">
					<span id={nameId} className="settings-row-label room-skill-name">{row.label}</span>
					{opens && <span className="room-skill-chevron" aria-hidden="true">{"\u00a0›"}</span>}
				</span>
				{row.byHand && <SkillByHandTag />}
			</span>
		);
		return (
			<div key={row.name} className="settings-row room-skill">
				<div className="settings-row-main">
					{/* The name and its line are one target that opens the skill's page; the switch is its own. */}
					{opens
						? <button type="button" className="rs-text-btn room-skill-open" aria-labelledby={nameId} aria-describedby={line ? lineId : undefined} onClick={() => onOpenSkillsLibrary(row.name)}>{head}{line}</button>
						: <>{head}{line}</>}
					{failed?.name === row.name && <span className="settings-row-sub room-skill-problem" role="alert">{failed.line ?? roomSkillSwitchFailedLine(row.label, failed.on)}</span>}
				</div>
				{/* The label around the switch widens what a finger can hit, the drawn switch unchanged. A skill whose name another has can't be on here: no switch. */}
				{!row.nameTaken && <label className="room-skill-switch">
					<input
						className="workspaces-tool-switch"
						type="checkbox"
						role="switch"
						checked={checked}
						disabled={saving !== null || (!row.on && row.unreadable)}
						data-skill={row.name}
						onChange={() => void flip(row.name, !row.on)}
						aria-label={roomSkillSwitchName(row.label)}
					/>
				</label>}
			</div>
		);
	}

	// The new look: one list, the ones on first, how many are on now beside the title, and on a phone, which has no title, over the list. The old look: while nothing is on, one
	// list with no headings; otherwise a group shows its heading only when it has rows.
	const groups = lookNext
		? [{ id: "all", kicker: null, rows: [...shown.filter(placedOn), ...shown.filter((row) => !placedOn(row))] }]
		: anyOn
			? [{ id: "on", kicker: ROOM_SKILL_GROUPS.on, rows: shown.filter(placedOn) }, { id: "off", kicker: ROOM_SKILL_GROUPS.off, rows: shown.filter((row) => !placedOn(row)) }].filter((group) => group.rows.length > 0)
			: [{ id: "all", kicker: null, rows: shown }];
	const onCount = lookNext && rows && rows.length > 0 ? roomListOnCount(rows.filter((row) => row.on).length, rows.length) : null;
	const manage = lookNext && canAddSkills && onOpenSkillsLibrary
		? <>{" "}<button type="button" className="rs-text-btn pane-lead-link" onClick={() => onOpenSkillsLibrary()}>{ROOM_SKILLS_MANAGE}</button></>
		: null;

	return (
		<div className="room-skills-section" ref={sectionRef}>
			{/* The files line ends the lead. A folder and Commands are chosen at the computer, so a phone gets what can't happen alone. */}
			<PaneHeader
				title="Skills"
				beside={onCount}
				line={<>{ROOM_SKILLS_LEAD}{manage}{filesLine && <>{lookNext ? " " : <br />}<span className="room-skills-files">{remoteClient.remote ? filesLine.what : `${filesLine.what} ${filesLine.how}`}</span></>}</>}
			/>
			{loadError && <div className="checkpoint-proposal-error">{loadError}</div>}
			{!rows && loadError === null && <p className="ai-setup-copy">Loading skills…</p>}
			{rows && rows.length === 0 && (
				<p className="settings-empty">
					{remoteClient.sharedServer ? ROOM_SKILLS_EMPTY_LIBRARY.company : ROOM_SKILLS_EMPTY_LIBRARY.line}
					{/* The new look's way there is at the end of the lead. */}
					{!lookNext && canAddSkills && onOpenSkillsLibrary && <> <button type="button" className="rs-text-btn" onClick={() => onOpenSkillsLibrary()}>{ROOM_SKILLS_EMPTY_LIBRARY.link}</button></>}
				</p>
			)}
			{rows && rows.length > 0 && (
				<>
					<input
						type="search"
						className="room-skills-search"
						placeholder={ROOM_SKILLS_SEARCH}
						aria-label={ROOM_SKILLS_SEARCH}
						value={query}
						onChange={(e) => {
							setQuery(e.target.value);
							if (rows) setPlacement(placeRows(rows));
						}}
					/>
					{shown.length === 0 && <p className="ai-setup-copy room-skills-empty">{roomSkillsNoMatch(query.trim())}</p>}
					{shown.length > 0 && groups.map((group) => (
						<div key={group.id} className="settings-group room-skills-group">
							{group.kicker && <GroupHeader kicker={group.kicker} />}
							{onCount && <p className="room-list-count">{onCount}</p>}
							<div className="settings-rows">{group.rows.map(renderRow)}</div>
						</div>
					))}
				</>
			)}
		</div>
	);
}
