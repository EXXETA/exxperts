// A room's three command modes, Ask, Semi and Auto, without a box: the stored
// mode through every writer and write-back, the writes the server refuses, the
// move at the update from an older app's Run without asking, where Auto is in
// effect (`roomReachesFreely`, and `unprotectedRoomOnAuto` without protection),
// Windows' site decision in Auto, and the lines
// the model reads per mode. The real sandbox's rows are in room-box-smoke.ts,
// the assembled messages in room-protection-smoke.ts, Windows' proxy in
// windows-box-proxy-smoke.ts and the reader in room-web-reader-smoke.ts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function row(name: string, body: () => Promise<void> | void): Promise<void> {
	try {
		await body();
		console.log(`ok: ${name}`);
	} catch (error) {
		console.error(`FAIL: ${name}\n${(error as Error).stack}`);
		process.exit(1);
	}
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-command-modes-"));
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = path.join(tempRoot, "rooms");
const folder = path.join(tempRoot, "project");
fs.mkdirSync(folder, { recursive: true });
const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");

const bashSettings = await import("../src/persistent-room-bash-settings.js");
const protectionMod = await import("../src/persistent-room-protection.js");
const policyMod = await import("../src/persistent-room-workspace-policy.js");
const boxAvailable = await import("../src/room-box/box-available.js");
const { registerServerHooks } = await import("../src/server-hooks.js");
const { windowsSiteDecision } = await import("../src/room-box/windows/site-decision.js");
const { windowsBoxModelLine, WINDOWS_CERTIFICATE_CHECK, WINDOWS_FILE_HOMES_LINE } = await import("../src/room-box/windows/model-lines.js");
const cardText = await import("../src/room-box/card-text.js");
const { setRoomCommands } = await import("../src/room-box/folder-question.js");

type Protection = import("../src/persistent-room-protection.js").PersistentRoomProtection;
const ON: Protection = { state: "on" };
const PERSON_OFF: Protection = { state: "off" };
const COMPUTER: Protection = { state: "off", cause: "computer" };
const FOLDER: Protection = { state: "off", cause: "folder" };
const UNKNOWN: Protection = { state: "off", cause: "unknown" };
const show = (value: unknown) => JSON.stringify(value);

/** A Mac: every room's protection runs, unless the person turned it off. */
const actAsMac = () => boxAvailable.setRoomBoxForTests({ platform: "darwin", windows: null });
actAsMac();

const settingsFile = (room: string) => bashSettings.persistentRoomBashSettingsPath(room);
const stored = (room: string) => JSON.parse(fs.readFileSync(settingsFile(room), "utf-8"));
/** The file as an older app, or this version, left it. */
function storeRaw(room: string, body: Record<string, unknown>): void {
	fs.mkdirSync(path.dirname(settingsFile(room)), { recursive: true });
	fs.writeFileSync(settingsFile(room), JSON.stringify({ schemaVersion: 1, updatedAt: "2026-01-01T00:00:00.000Z", ...body }));
}
/** The mode the chip shows for what the server returns, in a protected room unless `roomProtected` is false. */
const modeOf = (settings: { autoApprove: boolean; free?: true }, roomProtected = true) => cardText.commandModeOf(settings, roomProtected);
/** A write as the chip makes it: given in the protection it read. */
const write = (room: string, input: { autoApprove?: unknown; free?: unknown }) => bashSettings.writePersistentRoomBashSettings(room, { ...input, protection: protectionMod.persistentRoomProtection(room) });
function refusal(run: () => unknown): { message: string; statusCode?: number; code?: string } | null {
	try {
		run();
		return null;
	} catch (error) {
		return { message: (error as Error).message, statusCode: (error as any).statusCode, code: (error as any).code };
	}
}
/** A room with its folder and commands on (or off), as the Folder page saves it. */
function roomWithFolder(room: string, bashEnabled: boolean): void {
	policyMod.writePersistentRoomDefaultCapabilityPolicy(policyMod.createPersistentRoomDefaultCapabilityPolicy({
		agentId: room, repoRoot, root: folder, workspaceAccessMode: "localFiles", displayLabel: "Project", source: "manual", bashEnabled,
	}));
}

try {
	await row("Auto through every writer: stored as the person's own, kept by a field-less write, through protection off and an unprotected yes and no, and back on; an older app reads the file as asking", () => {
		const room = "free-writers";
		roomWithFolder(room, true);
		const chosen = write(room, { autoApprove: true, free: true });
		assert(modeOf(chosen) === "auto" && chosen.autoApprove === true, `the chip's Auto: ${show(chosen)}`);
		assert(stored(room).runWithoutAsking === "free" && stored(room).autoApprove === false, `the file: ${show(stored(room))}`);
		assert(modeOf(write(room, {})) === "auto", "a write that names no mode changed it");
		protectionMod.writePersistentRoomProtection(room, "off");
		const off = bashSettings.readPersistentRoomBashSettings(room);
		assert(modeOf(off, false) === "ask" && off.free === undefined, `with protection off, Auto isn't in effect and each command asks: ${show(off)}`);
		assert(stored(room).runWithoutAsking === "free", `the read with protection off kept Auto: ${show(stored(room))}`);
		assert(modeOf(write(room, { autoApprove: true }), false) === "auto" && stored(room).runWithoutAsking === "free" && stored(room).unprotectedYes === "person", `an unprotected yes, Auto there, keeps the protected Auto beside it: ${show(stored(room))}`);
		assert(modeOf(write(room, { autoApprove: false }), false) === "ask" && stored(room).runWithoutAsking === "free", `an unprotected no keeps Auto: ${show(stored(room))}`);
		protectionMod.writePersistentRoomProtection(room, "on");
		const back = bashSettings.readPersistentRoomBashSettings(room);
		assert(modeOf(back) === "auto" && back.autoApprove === true, `protection on again brings Auto back: ${show(back)}`);
		// Leaving Auto: Semi, then Ask, each as stored.
		assert(modeOf(write(room, { autoApprove: true })) === "semi" && stored(room).runWithoutAsking === "yes", `Semi after Auto: ${show(stored(room))}`);
		assert(modeOf(write(room, { autoApprove: true, free: false })) === "semi", "free false with a yes is Semi");
		assert(modeOf(write(room, { autoApprove: false })) === "ask" && stored(room).runWithoutAsking === "no", `Ask: ${show(stored(room))}`);
		assert(modeOf(write(room, { autoApprove: true, free: true })) === "auto", "Auto again");
	});

	await row("the writes the server refuses store nothing: free not a yes or no, Auto's free without the yes, free while protection is off, and a write given in another protection", () => {
		const room = "free-refusals";
		roomWithFolder(room, true);
		write(room, { autoApprove: true });
		const before = fs.readFileSync(settingsFile(room), "utf-8");
		const notBoolean = refusal(() => write(room, { autoApprove: true, free: "yes" }));
		assert(notBoolean?.message === "free must be a boolean" && notBoolean.statusCode === undefined, show(notBoolean));
		const withoutYes = refusal(() => write(room, { autoApprove: false, free: true }));
		assert(withoutYes?.message === "free needs autoApprove", show(withoutYes));
		assert(refusal(() => write(room, { free: true }))?.message === "free needs autoApprove", "free with no autoApprove");
		const stale = refusal(() => bashSettings.writePersistentRoomBashSettings(room, { autoApprove: true, free: true, protection: PERSON_OFF }));
		assert(stale?.statusCode === 409 && stale.code === "protection_changed" && stale.message === cardText.CHANGE_SAVE_FAILED, show(stale));
		assert(refusal(() => bashSettings.writePersistentRoomBashSettings(room, { autoApprove: true, free: true }))?.statusCode === 409, "a write with no protection");
		protectionMod.writePersistentRoomProtection(room, "off");
		const unprotected = refusal(() => write(room, { autoApprove: true, free: true }));
		assert(unprotected?.message === "free needs the room's protection", show(unprotected));
		protectionMod.writePersistentRoomProtection(room, "on");
		assert(fs.readFileSync(settingsFile(room), "utf-8") === before, "a refused write changed the file");
		assert(modeOf(bashSettings.readPersistentRoomBashSettings(room)) === "semi", "the room left Semi");
	});

	await row("the move at the update: an older app's own yes is Auto where protection runs and its commands are on, also turned off by the person, and Semi where its commands are off; an unprotected yes of its cause, Auto there, where the computer or the folder is why; automatic stays Semi; asking stays asking; this version's yes stays Semi; a state not known yet waits, also through a save then, and moves once known", () => {
		const olderYes = { autoApprove: true };
		const cases: Array<{ name: string; body: Record<string, unknown>; protection: Protection; mode: string; file: Record<string, unknown> | null; commandsOff?: true }> = [
			{ name: "an older yes, protected", body: olderYes, protection: ON, mode: "auto", file: { runWithoutAsking: "free", perProtection: true } },
			{ name: "an older yes, turned off by the person", body: olderYes, protection: PERSON_OFF, mode: "ask", file: { runWithoutAsking: "free", perProtection: true } },
			{ name: "an older yes, protected, commands off", body: olderYes, protection: ON, mode: "semi", file: { runWithoutAsking: "yes", perProtection: true }, commandsOff: true },
			{ name: "an older yes, turned off by the person, commands off", body: olderYes, protection: PERSON_OFF, mode: "ask", file: { runWithoutAsking: "yes", perProtection: true }, commandsOff: true },
			{ name: "an older yes, this computer", body: olderYes, protection: COMPUTER, mode: "auto", file: { runWithoutAsking: "no", perProtection: true, unprotectedYes: "computer" } },
			{ name: "an older yes, the folder", body: olderYes, protection: FOLDER, mode: "auto", file: { runWithoutAsking: "no", perProtection: true, unprotectedYes: "folder" } },
			{ name: "an older automatic yes", body: { autoApprove: true, automatic: true }, protection: ON, mode: "semi", file: { runWithoutAsking: "automatic", perProtection: true } },
			{ name: "an older no", body: { autoApprove: false }, protection: ON, mode: "ask", file: { runWithoutAsking: "no", perProtection: true } },
			{ name: "this version's yes, kept per protection", body: { autoApprove: false, runWithoutAsking: "yes", perProtection: true }, protection: ON, mode: "semi", file: null },
			{ name: "this version's yes, before protection was kept per room", body: { autoApprove: false, runWithoutAsking: "yes" }, protection: ON, mode: "semi", file: { runWithoutAsking: "yes", perProtection: true } },
			{ name: "an older yes, state not known yet", body: olderYes, protection: UNKNOWN, mode: "ask", file: null },
		];
		for (const [n, each] of cases.entries()) {
			const room = `moved-${n}`;
			roomWithFolder(room, each.commandsOff !== true);
			storeRaw(room, each.body);
			const before = fs.readFileSync(settingsFile(room), "utf-8");
			const read = bashSettings.readPersistentRoomBashSettingsIn(room, each.protection);
			const mode = modeOf(read, each.protection.state === "on");
			assert(mode === each.mode, `${each.name}: reads ${mode}, where ${each.mode} was due (${show(read)})`);
			if (each.file === null) {
				assert(fs.readFileSync(settingsFile(room), "utf-8") === before, `${each.name}: the file was written again: ${fs.readFileSync(settingsFile(room), "utf-8")}`);
				continue;
			}
			const after = stored(room);
			const kept = { runWithoutAsking: after.runWithoutAsking, perProtection: after.perProtection, ...(after.unprotectedYes ? { unprotectedYes: after.unprotectedYes } : {}) };
			assert(show(kept) === show(each.file) && after.autoApprove === false, `${each.name}: the file holds ${show(after)}`);
			// Read again in the same state: the same mode, the file as it was.
			const settled = fs.readFileSync(settingsFile(room), "utf-8");
			assert(modeOf(bashSettings.readPersistentRoomBashSettingsIn(room, each.protection), each.protection.state === "on") === each.mode && fs.readFileSync(settingsFile(room), "utf-8") === settled, `${each.name}: a second read moved it again`);
		}
		// The person's own off, and on again: the moved room is on Auto.
		assert(modeOf(bashSettings.readPersistentRoomBashSettingsIn("moved-1", ON)) === "auto", "turned on again, the moved yes isn't Auto");
		// The room's first save in this version's fields moves it too.
		const saved = "moved-at-save";
		roomWithFolder(saved, true);
		storeRaw(saved, olderYes);
		bashSettings.storeRunWithoutAskingAsOwn(saved);
		assert(stored(saved).runWithoutAsking === "free" && stored(saved).autoApprove === false, `the first save: ${show(stored(saved))}`);
		// A save while Windows' check still runs: the file is this version's, asking, and still moves once the state is known.
		const early = "moved-at-early-save";
		roomWithFolder(early, true);
		storeRaw(early, olderYes);
		boxAvailable.setRoomBoxForTests({ platform: "win32", windows: null });
		try {
			assert(show(protectionMod.persistentRoomProtection(early)) === show(UNKNOWN), `the state isn't unknown while the check runs: ${show(protectionMod.persistentRoomProtection(early))}`);
			bashSettings.storeRunWithoutAskingAsOwn(early);
			assert(stored(early).autoApprove === false && modeOf(bashSettings.readPersistentRoomBashSettingsIn(early, UNKNOWN), false) === "ask", `saved before the state was known: ${show(stored(early))}`);
		} finally {
			actAsMac();
		}
		assert(modeOf(bashSettings.readPersistentRoomBashSettingsIn(early, ON)) === "auto" && stored(early).runWithoutAsking === "free" && stored(early).perProtection === true, `once known, the early save didn't move: ${show(stored(early))}`);
	});

	await row("an older app's yes in a room whose commands are off stays Semi when the commands card or a Folder save turns them on with no read before it; a room whose commands were on is Auto through a save", () => {
		const olderYes = { autoApprove: true };
		const card = "moved-by-card";
		roomWithFolder(card, false);
		storeRaw(card, olderYes);
		setRoomCommands(card, "conversation-card", true);
		const byCard = bashSettings.readPersistentRoomBashSettingsIn(card, ON);
		assert(modeOf(byCard) === "semi" && stored(card).runWithoutAsking === "yes", `the card turned commands on, then: ${show(stored(card))} (${show(byCard)})`);
		const saved = "moved-by-save";
		roomWithFolder(saved, false);
		storeRaw(saved, olderYes);
		roomWithFolder(saved, true);
		assert(modeOf(bashSettings.readPersistentRoomBashSettingsIn(saved, ON)) === "semi", `a Folder save turned commands on, then: ${show(stored(saved))}`);
		const on = "kept-on-by-save";
		roomWithFolder(on, true);
		storeRaw(on, olderYes);
		roomWithFolder(on, false);
		assert(stored(on).runWithoutAsking === "free", `commands on before the save that turned them off: ${show(stored(on))}`);
	});

	await row("Auto is in effect only where the chip shows it: protected, still in the protection the answer was bound in, with commands on and a folder; Semi stored never is", () => {
		const room = "reaches-freely";
		roomWithFolder(room, true);
		write(room, { autoApprove: true, free: true });
		const reaches = (bound?: Protection) => bashSettings.roomReachesFreely(room, "conversation-1", bound);
		assert(reaches() === true && reaches(ON) === true, "a protected room on Auto with commands and a folder");
		assert(reaches(PERSON_OFF) === false, "an answer bound before Turn on");
		protectionMod.writePersistentRoomProtection(room, "off");
		assert(reaches() === false && reaches(ON) === false, "protection off");
		protectionMod.writePersistentRoomProtection(room, "on");
		assert(reaches() === true, "protection on again");
		roomWithFolder(room, false);
		assert(reaches() === false, "commands off");
		roomWithFolder(room, true);
		assert(reaches() === true, "commands on again");
		policyMod.deletePersistentRoomDefaultCapabilityPolicy(room);
		assert(reaches() === false, "no folder");
		roomWithFolder(room, true);
		boxAvailable.setRoomBoxForTests({ platform: "linux", windows: null });
		try {
			assert(reaches() === false, "a computer with no protection");
		} finally {
			actAsMac();
		}
		write(room, { autoApprove: true });
		assert(reaches() === false, "Semi");
		write(room, { autoApprove: false });
		assert(reaches() === false, "Ask");
		write(room, { autoApprove: true, free: true });
		assert(reaches() === true, "Auto again");
	});

	await row("Auto without protection is in effect for each cause, turned off, this computer and the folder, still in the protection the answer was bound in, with commands on and a folder; Ask, a cause not known yet and a protected Auto never are", () => {
		const room = "unprotected-auto";
		roomWithFolder(room, true);
		const onAuto = (bound?: Protection) => bashSettings.unprotectedRoomOnAuto(room, "conversation-1", bound);
		write(room, { autoApprove: true, free: true });
		assert(onAuto() === false, "a protected room on Auto");
		protectionMod.writePersistentRoomProtection(room, "off");
		assert(onAuto() === false, "turned off, with only the protected Auto kept");
		write(room, { autoApprove: true });
		assert(onAuto() === true && onAuto(PERSON_OFF) === true, "turned off, on Auto");
		assert(onAuto(ON) === false, "an answer bound while protected");
		write(room, { autoApprove: false });
		assert(onAuto() === false, "turned off, on Ask");
		write(room, { autoApprove: true });
		roomWithFolder(room, false);
		assert(onAuto() === false, "commands off");
		policyMod.deletePersistentRoomDefaultCapabilityPolicy(room);
		assert(onAuto() === false, "no folder");
		roomWithFolder(room, true);
		assert(onAuto() === true, "commands on with a folder again");
		protectionMod.writePersistentRoomProtection(room, "on");
		assert(onAuto() === false, "protection on again");
		const computer = "unprotected-auto-computer";
		roomWithFolder(computer, true);
		boxAvailable.setRoomBoxForTests({ platform: "linux", windows: null });
		try {
			write(computer, { autoApprove: true });
			assert(bashSettings.unprotectedRoomOnAuto(computer, "conversation-1") === true, "a computer with no protection, on Auto");
			assert(bashSettings.unprotectedRoomOnAuto(computer, "conversation-1", PERSON_OFF) === false, "an answer bound in another cause");
			write(computer, { autoApprove: false });
			assert(bashSettings.unprotectedRoomOnAuto(computer, "conversation-1") === false, "a computer with no protection, on Ask");
		} finally {
			actAsMac();
		}
		// The folder's cause is judged on Windows alone, so it is read in that protection as Windows would.
		const share = "unprotected-auto-folder";
		roomWithFolder(share, true);
		storeRaw(share, { autoApprove: false, runWithoutAsking: "no", perProtection: true, unprotectedYes: "folder" });
		assert(bashSettings.unprotectedRoomOnAutoIn(share, "conversation-1", FOLDER) === true, "a folder no protection can keep, on Auto");
		assert(bashSettings.unprotectedRoomOnAutoIn(share, "conversation-1", FOLDER, ON) === false, "an answer bound while protected");
		assert(bashSettings.unprotectedRoomOnAutoIn(share, "conversation-1", UNKNOWN) === false, "a cause not known yet");
		storeRaw(share, { autoApprove: false, runWithoutAsking: "no", perProtection: true, unprotectedYes: "computer" });
		assert(bashSettings.unprotectedRoomOnAutoIn(share, "conversation-1", FOLDER) === false, "a yes of another cause");
	});

	await row("Windows' decision in Auto: every site allowed for public addresses alone, with no card, a certificate check too, the next turn as well; in Semi a certificate check is refused at once", async () => {
		const cards: string[] = [];
		const questions = {
			watcher: () => "computer" as const,
			askSite: async (card: { host: string }) => {
				cards.push(card.host);
				return { choice: "once" as const, answeredBy: "computer" as const };
			},
			closeSiteCards: () => {},
		};
		let free = true;
		const decision = windowsSiteDecision({ roomId: "windows-free", questions: questions as any, free: () => free });
		assert(show(await decision.ask({ host: "example.com", port: 443 })) === show({ allow: true, publicOnly: true }), "a site in Auto");
		assert(show(await decision.ask({ host: "crl.example", port: 80 }, { certificateCheck: true })) === show({ allow: true, publicOnly: true }), "a certificate check in Auto");
		assert(cards.length === 0, `Auto raised a card: ${show(cards)}`);
		free = false;
		const check = await decision.ask({ host: "crl.example", port: 80 }, { certificateCheck: true });
		assert(show(check) === show({ allow: false, reason: WINDOWS_CERTIFICATE_CHECK }) && cards.length === 0, `a certificate check in Semi: ${show(check)}`);
		assert(show(await decision.ask({ host: "example.com", port: 443 })) === show({ allow: true }) && show(cards) === show(["example.com"]), "Semi asks the person");
		free = true;
		decision.endTurn();
		assert(show(await decision.ask({ host: "intranet.example", port: 443 })) === show({ allow: true, publicOnly: true }) && show(cards) === show(["example.com"]), "the next turn in Auto");
	});

	await row("the lines the model reads per mode, on a Mac and on Windows: Auto says public websites without a yes and what stays closed, Semi and Ask that a site needs a yes; the refusal names the modes as the person sees them; none says where a switch is", () => {
		const list = { folders: [], sites: [{ host: "intranet.example", port: 443 }] };
		const mac = { free: cardText.boxModelLine(list, true, true), asks: cardText.boxModelLine(list, true, false) };
		const windows = { free: windowsBoxModelLine(list, true, true), asks: windowsBoxModelLine(list, true, false) };
		for (const [where, lines] of Object.entries({ mac, windows })) {
			assert(lines.free.includes(cardText.boxSitesClause(true)) && lines.free.includes(cardText.ALLOW_FOLDER_WHEN_ASKED) && !lines.free.includes(cardText.ALLOW_WHEN_ASKED), `${where}, Auto: ${lines.free}`);
			assert(lines.asks.includes(cardText.boxSitesClause(false)) && lines.asks.includes(cardText.ALLOW_WHEN_ASKED), `${where}, Semi and Ask: ${lines.asks}`);
			assert(lines.free.includes("intranet.example:443") && lines.asks.includes("intranet.example:443"), `${where}: the room's list`);
		}
		assert(cardText.boxSitesClause(true) === "and they reach public websites without the person's yes, but not this computer's own addresses, raw addresses or sites on the person's own network", cardText.boxSitesClause(true));
		assert(windows.free.includes("Windows' own certificate checks reach public sites like any other.") && windows.asks.includes("Windows' own certificate checks reach only a site already allowed, without asking"), windows.free);
		assert(cardText.FREE_READER_LINE === "\n\nIn this room fetch_url opens a public address without asking the person; addresses on this computer or on the person's own network stay closed.", cardText.FREE_READER_LINE);
		assert(cardText.FREE_PRIVATE_REFUSAL === "this site is on the person's own network, and a room on Auto reaches public websites only; on Semi it can be reached after their yes", cardText.FREE_PRIVATE_REFUSAL);
		for (const line of [mac.free, windows.free, cardText.FREE_READER_LINE, cardText.FREE_PRIVATE_REFUSAL]) {
			assert(!/chip|switch|setting|folder page|selector|click|menu/i.test(line), `a line says where a switch is: ${line}`);
		}
	});

	await row("the line the model reads in a protected room says where each kind of file goes, on a Mac and on Windows, in every mode", () => {
		const list = { folders: [], sites: [] };
		// The file tools can't open a command's temp, so a file they must open goes into the room's folder.
		for (const [line, temp] of [[cardText.BOX_FILE_HOMES_LINE, "$TMPDIR"], [WINDOWS_FILE_HOMES_LINE, "$env:TEMP"]] as const) {
			assert(line.startsWith("Write what the person asked for, and any file you need to open with the file tools, into the room's folder.") && line.includes(`go under ${temp}, which only commands can open`), line);
		}
		for (const [asks, free] of [[true, false], [false, false], [true, true]] as const) {
			const mac = cardText.boxModelLine(list, asks, free);
			const windows = windowsBoxModelLine(list, asks, free);
			assert(mac.includes(` ${cardText.BOX_FILE_HOMES_LINE} `) && !mac.includes("$env:TEMP"), `Mac: ${mac}`);
			assert(windows.includes(` ${WINDOWS_FILE_HOMES_LINE} `) && !windows.includes("$TMPDIR"), `Windows: ${windows}`);
		}
	});

	// Last: a shared server stays one for the rest of this process.
	await row("on a shared server a stored Auto changes nothing: the room doesn't reach freely, and an unprotected Auto isn't in effect", () => {
		const room = "shared-free";
		roomWithFolder(room, true);
		write(room, { autoApprove: true, free: true });
		// The yes for the computer's cause, which is how a shared server reads its rooms' protection: only the shared server's own check refuses it.
		const unprotected = "shared-unprotected-auto";
		roomWithFolder(unprotected, true);
		storeRaw(unprotected, { autoApprove: false, runWithoutAsking: "no", perProtection: true, unprotectedYes: "computer" });
		assert(bashSettings.roomReachesFreely(room, "conversation-1") === true, "before the shared server, Auto is in effect");
		assert(bashSettings.unprotectedRoomOnAutoIn(unprotected, "conversation-1", COMPUTER) === true, "before the shared server, the unprotected Auto is in effect");
		registerServerHooks({});
		assert(bashSettings.roomReachesFreely(room, "conversation-1") === false, "a shared server read the stored Auto");
		assert(bashSettings.unprotectedRoomOnAutoIn(unprotected, "conversation-1", COMPUTER) === false, "a shared server read the stored unprotected Auto");
	});
} finally {
	boxAvailable.setRoomBoxForTests(null);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
console.log("room-command-modes-smoke: ok");
