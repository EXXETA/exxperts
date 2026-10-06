import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolated HOME: the saved order lives under the product state path, so
// nothing here touches the developer's own home screen.
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-room-order-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
delete process.env.EXXPERTS_STATE_HOME;

const { compareRoomsByName, compareRoomsByRecentUse, isRoomOrderMode, orderRooms, roomLastUsedTimes, ROOM_ORDER_CUSTOM_MAX, ROOM_ORDER_DEFAULT_MODE, ROOM_ORDER_MODES, sanitizeRoomOrderCustomOrder, validateRoomOrderMode, mergeRoomOrderCustomOrder, reconcileRoomsByCustomOrder, validateRoomOrderCustomOrder } = await import("../src/room-order.js");
const { readRoomOrder, ROOM_ORDER_FILENAME, ROOM_ORDER_SAVE_FAILED_SENTENCE, roomOrderPath, roomOrderPayload, saveRoomOrder } = await import("../src/room-order-store.js");
const { classifyRemoteRoute } = await import("../src/remote-route-policy.js");
const { productAppStatePath } = await import("../../../pi-package/product-state-paths.js");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function assertThrows(fn: () => unknown, expectedMessage: string, label: string): Error {
	try {
		fn();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		assert(message.includes(expectedMessage), `${label}: expected error to include "${expectedMessage}", got "${message}"`);
		return error as Error;
	}
	throw new Error(`${label}: expected an error`);
}

// A failed save's sentence is kept on the home screen until the next save, so
// it must not state anything in the present tense about the disk: by the time
// it is read, the folder may be gone or another door may have saved.
const speaksOfTheAttempt = (sentence: string): boolean => !/\b(there is|is unchanged|are unchanged|remains|still)\b/i.test(sentence) && /\b(was|were|failed)\b/i.test(sentence);

const stamp = new Date("2026-09-17T18:00:00.000Z");
const ids = (rooms: Array<{ id: string }>): string => rooms.map((room) => room.id).join(",");

try {
	const file = roomOrderPath();
	assert(file === productAppStatePath(ROOM_ORDER_FILENAME), "the saved order lives in the app's state folder");

	// --- The modes: a list, a default that is the order the home screen always had ---
	assert(ROOM_ORDER_DEFAULT_MODE === "name-asc" && isRoomOrderMode(ROOM_ORDER_DEFAULT_MODE), "the default is A to Z and is a mode");
	for (const mode of ROOM_ORDER_MODES) assert(validateRoomOrderMode(mode) === mode, `${mode} validates as itself`);
	for (const bad of [undefined, null, "", "NAME-ASC", "frequency", 1, ["name-asc"], { mode: "name-asc" }]) {
		const refused = assertThrows(() => validateRoomOrderMode(bad), "mode must be one of", `mode ${JSON.stringify(bad)} is refused`);
		assert((refused as any).statusCode === 400, "as the client's to fix");
	}

	// --- Nothing saved: the default, no timestamp, no complaint, and no file made by reading ---
	const nothing = readRoomOrder();
	assert(nothing.preference.mode === "name-asc" && nothing.preference.customOrder.length === 0 && nothing.updatedAt === null && nothing.unreadable === undefined, "no file reads as the default");
	assert(!fs.existsSync(file), "reading creates nothing");

	// --- Save and read back ---
	const saved = saveRoomOrder({ mode: "name-desc" }, {}, stamp);
	assert(saved.preference.mode === "name-desc" && saved.updatedAt === stamp.toISOString(), "a save returns what it saved");
	const readBack = readRoomOrder();
	assert(readBack.preference.mode === "name-desc" && readBack.updatedAt === stamp.toISOString() && readBack.unreadable === undefined, "and reads back the same");
	const document = JSON.parse(fs.readFileSync(file, "utf-8"));
	assert(document.schemaVersion === 1 && document.mode === "name-desc" && Array.isArray(document.customOrder) && document.updatedAt === stamp.toISOString(), "the file has the brief's shape");
	assert(fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".tmp-")).length === 0, "no temp file is left behind");

	// --- A refused save leaves the file alone ---
	assertThrows(() => saveRoomOrder({ mode: "frequency" }), "mode must be one of", "an unknown mode is refused");
	assert(readRoomOrder().preference.mode === "name-desc", "and the saved order is unchanged");

	// --- The arrangement rides along untouched through every change of mode ---
	fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, mode: "name-asc", customOrder: ["room-c", "room-a", "room-b"], updatedAt: stamp.toISOString() }));
	saveRoomOrder({ mode: "name-desc" }, {}, stamp);
	saveRoomOrder({ mode: "name-asc" }, {}, stamp);
	assert(readRoomOrder().preference.customOrder.join(",") === "room-c,room-a,room-b", "A to Z, Z to A and back keep the arrangement as it was left");

	// --- A mode from a newer build: A to Z, no complaint, the file left exactly as it is ---
	const newer = JSON.stringify({ schemaVersion: 1, mode: "by-moon-phase", customOrder: ["room-b", "room-a"], updatedAt: stamp.toISOString() });
	fs.writeFileSync(file, newer);
	const unknownMode = readRoomOrder();
	assert(unknownMode.preference.mode === "name-asc" && unknownMode.unreadable === undefined, "an unknown mode reads as A to Z and is not a broken file");
	assert(unknownMode.preference.customOrder.join(",") === "room-b,room-a", "its arrangement is still read");
	assert(fs.readFileSync(file, "utf-8") === newer, "and a read never rewrites the file");

	// --- An arrangement somebody else wrote: well-formed ids once, the rest dropped ---
	assert(sanitizeRoomOrderCustomOrder(["a", "b", "a", 7, null, "../etc", "", "c d", "c"]).join(",") === "a,b,c", "duplicates, non-strings and ill-formed ids are dropped, order kept");
	assert(sanitizeRoomOrderCustomOrder("a,b").length === 0 && sanitizeRoomOrderCustomOrder(undefined).length === 0, "anything but a list is no arrangement");
	assert(sanitizeRoomOrderCustomOrder(Array.from({ length: ROOM_ORDER_CUSTOM_MAX + 50 }, (_, i) => `room-${i}`)).length === ROOM_ORDER_CUSTOM_MAX, "the ceiling bounds what is read");
	fs.writeFileSync(file, JSON.stringify({ mode: "name-desc", customOrder: "nonsense", updatedAt: "yesterday-ish" }));
	const partial = readRoomOrder();
	assert(partial.preference.mode === "name-desc" && partial.preference.customOrder.length === 0 && partial.updatedAt === null && partial.unreadable === undefined, "a usable mode is used even when the rest is not");

	// --- Contents the app did not save: the third state, in words, without a path ---
	for (const contents of ["{ not json", "[]", "\"name-desc\"", "null", "42", ""]) {
		fs.writeFileSync(file, contents);
		const broken = readRoomOrder();
		assert(broken.unreadable === "its contents are not what the app saved", `contents ${JSON.stringify(contents)} are unreadable, got ${JSON.stringify(broken.unreadable)}`);
		assert(broken.preference.mode === "name-asc" && broken.preference.customOrder.length === 0, "and the rooms show A to Z");
		assert(broken.saveBlocked === undefined, "a save can replace it, and the read does not say otherwise");
		assert(!String(broken.unreadable).includes(tempHome), "never a path");
	}
	// Choosing an order is the way out: the save replaces the file.
	assert(saveRoomOrder({ mode: "name-desc" }, {}, stamp).preference.mode === "name-desc" && readRoomOrder().unreadable === undefined, "a save replaces contents that could not be understood");

	// --- A folder at the path: said on read, refused on save with the remedy, as the client's to fix ---
	fs.rmSync(file);
	fs.mkdirSync(file);
	try {
		const folder = readRoomOrder();
		assert(folder.unreadable === "it is a folder, not a file" && folder.preference.mode === "name-asc", "a folder reads as the third state");
		assert(folder.saveBlocked === true, "and the read says a save would be refused, so the home screen does not offer one as the way out");
		const overFolder = assertThrows(() => saveRoomOrder({ mode: "name-desc" }), "Remove that folder, then choose the order again.", "a save over a folder names the remedy");
		// The home screen keeps a failed save's sentence until the next save; this
		// one must still be true once the folder is gone, so it speaks of the attempt.
		assert(overFolder.message.startsWith("The order was not saved: a folder was found where") && speaksOfTheAttempt(overFolder.message), "and speaks of the attempt, not of the disk as it is");
		assert((overFolder as any).statusCode === 400 && !overFolder.message.includes(tempHome), "as a 400, without a path");
	} finally {
		fs.rmSync(file, { recursive: true });
	}

	// --- A link that points nowhere, a link to a folder: said on read, replaced by a save ---
	if (process.platform !== "win32") {
		const realFolder = path.join(tempHome, "a-real-folder");
		fs.mkdirSync(realFolder);
		fs.symlinkSync(realFolder, file);
		const linked = readRoomOrder();
		assert(linked.unreadable === "it is a folder, not a file" && linked.saveBlocked === undefined, "a link to a folder reads like a folder, but a save is not blocked: the same words, told apart by the flag");
		saveRoomOrder({ mode: "name-desc" }, {}, stamp);
		assert(readRoomOrder().unreadable === undefined && fs.statSync(realFolder).isDirectory(), "the save replaces the link and leaves the folder it pointed at alone");
		fs.rmSync(file);
		fs.symlinkSync(path.join(tempHome, "nowhere.json"), file);
		assert(readRoomOrder().unreadable === "it is a link that points nowhere", "a dangling link is the third state, not 'nothing saved'");
		saveRoomOrder({ mode: "name-asc" }, {}, stamp);
		assert(readRoomOrder().unreadable === undefined && !fs.lstatSync(file).isSymbolicLink(), "and a save replaces the link itself");
	}

	// --- A write that fails on the file system: the server's failure, tagged 500, the previous order intact ---
	saveRoomOrder({ mode: "name-desc" }, {}, stamp);
	const failAt = new Date("2026-09-17T18:05:00.000Z");
	const blockedTmp = `${file}.tmp-${process.pid}-${failAt.getTime()}`;
	fs.mkdirSync(blockedTmp); // the temp file's own path is taken by a folder
	try {
		const failed = assertThrows(() => saveRoomOrder({ mode: "name-asc" }, {}, failAt), "", "a write that cannot land fails the save");
		assert((failed as any).statusCode === 500, `a failed write is a server error, got ${(failed as any).statusCode}`);
		const after = readRoomOrder();
		assert(after.preference.mode === "name-desc" && after.updatedAt === stamp.toISOString(), "and the previous order is still the saved one");
	} finally {
		fs.rmSync(blockedTmp, { recursive: true, force: true });
	}

	// --- The route's own failure sentence: the same rule as the folder refusal, and never a path ---
	assert(speaksOfTheAttempt(ROOM_ORDER_SAVE_FAILED_SENTENCE) && ROOM_ORDER_SAVE_FAILED_SENTENCE.startsWith("Saving the order failed"), `the 500 sentence speaks of the attempt: ${ROOM_ORDER_SAVE_FAILED_SENTENCE}`);
	assert(!speaksOfTheAttempt("Saving the order failed because of a server error. The previous order is unchanged."), "the check itself refuses the wording it replaced");

	// --- A save states its mode; the arrangement is optional and strict ---
	for (const body of [undefined, null, {}, [], "name-asc", { customOrder: ["a"] }]) {
		const refused = assertThrows(() => saveRoomOrder(body), "mode must be one of", `a save without a mode is refused: ${JSON.stringify(body)}`);
		assert((refused as any).statusCode === 400, "as the client's to fix");
	}
	assert(validateRoomOrderCustomOrder([]).length === 0 && validateRoomOrderCustomOrder(["b", "a"]).join(",") === "b,a", "an arrangement validates as sent, empty included");
	assert(validateRoomOrderCustomOrder(Array.from({ length: ROOM_ORDER_CUSTOM_MAX }, (_, i) => `r${i}`)).length === ROOM_ORDER_CUSTOM_MAX, "exactly the ceiling is allowed");
	for (const [bad, words] of [
		["a,b", "must be a list"], [null, "must be a list"], [{ 0: "a" }, "must be a list"],
		[["a", 7], "well-formed"], [["a", ""], "well-formed"], [["a", "../b"], "well-formed"], [["a", "b c"], "well-formed"], [["a", "x".repeat(161)], "well-formed"],
		[["a", "b", "a"], "twice"],
		[Array.from({ length: ROOM_ORDER_CUSTOM_MAX + 1 }, (_, i) => `r${i}`), "at most"],
	] as Array<[unknown, string]>) {
		const refused = assertThrows(() => validateRoomOrderCustomOrder(bad), words, `arrangement ${JSON.stringify(bad).slice(0, 40)} is refused`);
		assert((refused as any).statusCode === 400 && !/\b(there is|remains|still)\b/i.test(refused.message), "as the client's to fix, in words about the request");
		assertThrows(() => saveRoomOrder({ mode: "name-asc", customOrder: bad }), words, "and the save refuses it the same way");
	}

	// --- Merge on write: sent ids take the slots they held, everything else keeps its slot ---
	const merge = (saved: string, sent: string): string => mergeRoomOrderCustomOrder(saved ? saved.split(",") : [], sent ? sent.split(",") : []).join(",");
	assert(merge("", "") === "" && merge("", "b,a") === "b,a" && merge("a,b,c", "") === "a,b,c", "both ends: nothing into nothing, an arrangement into nothing, nothing into an arrangement");
	assert(merge("a,b,c,d", "d,c,b,a") === "d,c,b,a" && merge("a,b,c,d", "a,b,c,d") === "a,b,c,d", "a full client's arrangement is taken as sent");
	assert(merge("a,b,c,d", "c,a") === "c,b,a,d", "a client that saw a subset (a remote device, a stale list) moves only within the slots it saw");
	assert(merge("a,b,c,d", "d,a") === "d,b,c,a" && merge("a,b,c,d", "a,d") === "a,b,c,d", "both ends of the list are slots like any other");
	assert(merge("a,b,c", "e,a,c") === "e,b,a,c" && merge("a,b,c", "a,c,e") === "a,b,c,e", "an id the list never held is appended, then arranged like the rest: it can be moved to the front");
	assert(merge("a,b,c", "e,f") === "a,b,c,e,f" && merge("a,b,c", "f,e") === "a,b,c,f,e", "ids the list never held keep the order sent");
	assert(merge("a,b,c", "b") === "a,b,c", "a single id has nowhere else to go");
	assert(merge("a,b,c", "x") === "a,b,c,x", "a single unknown id joins at the end");
	{
		// Two tabs from the same saved list: both land, neither drops an id.
		const first = mergeRoomOrderCustomOrder(["a", "b", "c", "d"], ["d", "c", "b", "a"]);
		const second = mergeRoomOrderCustomOrder(first, ["a", "b"]);
		assert(second.join(",") === "d,c,a,b" && new Set(second).size === 4, "a later subset save wins within its own slots and drops nothing");
		const stale = mergeRoomOrderCustomOrder(first, ["b", "a", "c", "d"]);
		assert(stale.join(",") === "b,a,c,d", "a later FULL save wins wherever it sent ids: every slot, moves it never made included (the recorded limit)");
	}
	{
		const saved = Array.from({ length: ROOM_ORDER_CUSTOM_MAX }, (_, i) => `r${i}`);
		const merged = mergeRoomOrderCustomOrder(saved, ["r1999", "r0"]);
		assert(merged.length === ROOM_ORDER_CUSTOM_MAX && merged[0] === "r1999" && merged[1999] === "r0", "the ceiling: the first and the last slot swap, nothing grows");
		// At the ceiling, what is sent survives and unsent ids make room from the end: what a read keeps (the head) holds the arrangement just made.
		const over = mergeRoomOrderCustomOrder(saved, ["new-b", "r5", "new-a"]);
		assert(over.length === ROOM_ORDER_CUSTOM_MAX && over.includes("new-a") && over.includes("new-b") && over[5] === "new-b" && !over.includes("r1999") && !over.includes("r1998") && over.includes("r1997"), `at the ceiling the sent ids survive and the unsent tail makes room: ${over.slice(-3)}`);
		assert(sanitizeRoomOrderCustomOrder(over).join(",") === over.join(","), "so a read keeps exactly what was written");
		const oneUnder = mergeRoomOrderCustomOrder(saved.slice(0, ROOM_ORDER_CUSTOM_MAX - 1), ["new-a"]);
		assert(oneUnder.length === ROOM_ORDER_CUSTOM_MAX && oneUnder[ROOM_ORDER_CUSTOM_MAX - 1] === "new-a", "one under the ceiling: the new id fits, nothing is dropped");
		const allSent = mergeRoomOrderCustomOrder(saved, saved.slice().reverse());
		assert(allSent.length === ROOM_ORDER_CUSTOM_MAX && allSent[0] === "r1999", "a full save at the ceiling drops nothing");
	}

	// --- Reconcile on read: listed rooms in list order, the rest after A to Z, stale ids skipped ---
	const r = (id: string, name?: string) => ({ id, displayName: name });
	const reconcile = (rooms: Array<{ id: string; displayName?: string }>, list: string): string => ids(reconcileRoomsByCustomOrder(rooms, list ? list.split(",") : []));
	const five = [r("a", "Echo"), r("b", "Delta"), r("c", "Charlie"), r("d", "Bravo"), r("e", "Alpha")];
	assert(reconcile(five, "") === "e,d,c,b,a", "an empty arrangement is A to Z: nothing jumps");
	assert(reconcile([], "a,b") === "" && reconcile([r("a")], "a") === "a" && reconcile([r("a")], "") === "a", "both ends: no rooms, one room listed, one room unlisted");
	assert(reconcile(five, "c,a") === "c,a,e,d,b", "listed rooms first in list order, the rest after A to Z");
	assert(reconcile(five, "gone,c,archived,a") === "c,a,e,d,b", "an id that names no room here is skipped, and the list is not the order's to clean");
	assert(reconcile(five, "c,a,c") === "c,a,e,d,b", "an id twice in a list somebody else wrote counts once");
	assert(reconcile(five, "e,d,c,b,a") === "e,d,c,b,a" && reconcile(five, "a,b,c,d,e") === "a,b,c,d,e", "a total list is the order as it stands");
	assert(reconcile([r("a", "Room 10"), r("b", "Room 2"), r("c", "Room 1")], "a") === "a,c,b", "the tail is the name order the home screen uses: numbers as numbers");
	for (const rotation of [0, 1, 2, 3, 4]) {
		const rotated = [...five.slice(rotation), ...five.slice(0, rotation)];
		assert(reconcile(rotated, "c,a") === "c,a,e,d,b", `the input order never shows: rotation ${rotation}`);
	}
	{
		// A fresh array, out of name order: an in-place sort would leave it A to Z.
		const given = [r("b", "Bravo"), r("a", "Alpha"), r("c", "Charlie")];
		assert(reconcile(given, "c") === "c,a,b" && ids(given) === "b,a,c", "the rooms given are not reordered in place");
	}

	// --- The saved arrangement: merged into the file, never put in its place; a mode change alone leaves it ---
	fs.rmSync(file, { force: true });
	const arranged = saveRoomOrder({ mode: "name-asc", customOrder: ["c", "a", "b"] }, {}, stamp);
	assert(arranged.preference.customOrder.join(",") === "c,a,b" && arranged.preference.mode === "name-asc", "the first arrangement is saved as sent, with the mode the save states");
	assert(readRoomOrder().preference.customOrder.join(",") === "c,a,b", "and reads back the same");
	saveRoomOrder({ mode: "name-desc", customOrder: ["b", "c"] }, {}, stamp);
	assert(readRoomOrder().preference.customOrder.join(",") === "b,a,c", "a subset moves only within its own slots (a remote device, a second tab)");
	saveRoomOrder({ mode: "name-asc" }, {}, stamp);
	assert(readRoomOrder().preference.customOrder.join(",") === "b,a,c", "a choice without an arrangement leaves the arrangement as it was");
	fs.writeFileSync(file, "{ not json");
	saveRoomOrder({ mode: "name-asc", customOrder: ["z"] }, {}, stamp);
	assert(readRoomOrder().preference.customOrder.join(",") === "z" && readRoomOrder().unreadable === undefined, "over a file that cannot be understood there is nothing to merge into: the arrangement sent is what is saved");
	fs.rmSync(file);
	fs.mkdirSync(file);
	try {
		const overFolder = assertThrows(() => saveRoomOrder({ mode: "name-asc", customOrder: ["a"] }), "Remove that folder, then choose the order again.", "an arrangement over a folder is refused like a mode");
		assert(speaksOfTheAttempt(overFolder.message), "with the same sentence about the attempt");
	} finally {
		fs.rmSync(file, { recursive: true });
	}

	// --- A remote device: told the arrangement without its hidden rooms, may arrange only what it sees ---
	saveRoomOrder({ mode: "name-asc", customOrder: ["a", "hidden-1", "b", "hidden-2", "c"] }, {}, stamp);
	const hidden = (id: string): boolean => id.startsWith("hidden-");
	const everyone = roomOrderPayload(readRoomOrder());
	assert(everyone.order.customOrder.join(",") === "a,hidden-1,b,hidden-2,c" && everyone.order.mode === "name-asc" && everyone.order.updatedAt === stamp.toISOString() && everyone.modes.join(",") === ROOM_ORDER_MODES.join(","), "the computer's own screen gets the whole arrangement");
	assert(roomOrderPayload(readRoomOrder(), hidden).order.customOrder.join(",") === "a,b,c", "a remote device gets it without its hidden rooms");
	assert(roomOrderPayload(readRoomOrder(), () => true).order.customOrder.length === 0 && roomOrderPayload(readRoomOrder(), () => false).order.customOrder.length === 5, "both ends: every room hidden, none hidden");
	// A room hidden since the device drew its cards: its id is left out of what the device sent, the merge places the rest, the hidden room keeps its slot, and the answer never names it.
	const hiddenSent = saveRoomOrder({ mode: "name-asc", customOrder: ["hidden-1", "c", "a"] }, {}, stamp, hidden);
	assert(hiddenSent.preference.customOrder.join(",") === "c,hidden-1,b,hidden-2,a" && roomOrderPayload(hiddenSent, hidden).order.customOrder.join(",") === "c,b,a", "a hidden id in a remote save is dropped before the merge: the hidden room keeps its slot, the rest is arranged, the answer is filtered");
	assert(saveRoomOrder({ mode: "name-asc", customOrder: ["hidden-1", "hidden-2"] }, {}, stamp, hidden).preference.customOrder.join(",") === "c,hidden-1,b,hidden-2,a", "only hidden ids sent: nothing moves");
	saveRoomOrder({ mode: "name-asc", customOrder: ["a", "hidden-1", "b", "hidden-2", "c"] }, {}, stamp);
	const fromDevice = saveRoomOrder({ mode: "name-asc", customOrder: ["c", "b", "a"] }, {}, stamp, hidden);
	assert(fromDevice.preference.customOrder.join(",") === "c,hidden-1,b,hidden-2,a", "what it sends is merged: the hidden rooms keep their places");
	assert(roomOrderPayload(fromDevice, hidden).order.customOrder.join(",") === "c,b,a", "and the answer it gets is again without them");
	assert(saveRoomOrder({ mode: "name-asc", customOrder: ["hidden-1"] }, {}, stamp).preference.customOrder.join(",") === "c,hidden-1,b,hidden-2,a", "the computer's own screen may name any room");
	{
		const unreadableThenRemote = roomOrderPayload({ preference: { mode: "name-asc", customOrder: [] }, updatedAt: null, unreadable: "it is a folder, not a file", saveBlocked: true }, hidden);
		assert(unreadableThenRemote.order.unreadable === "it is a folder, not a file" && unreadableThenRemote.order.saveBlocked === true && unreadableThenRemote.order.customOrder.length === 0, "the third state and the flag travel unchanged");
	}

	// --- Ordering: numbers as numbers, the id when there is no name ---
	const rooms = [
		{ id: "r10", displayName: "Room 10" },
		{ id: "r2", displayName: "Room 2" },
		{ id: "beta", displayName: "beta" },
		{ id: "alpha", displayName: "Alpha" },
		{ id: "eclair", displayName: "\xc9clair" },
		{ id: "delta" },
		{ id: "nameless", displayName: "" },
	];
	const before = ids(rooms);
	const asc = orderRooms(rooms, { mode: "name-asc" });
	assert(ids(asc) === "alpha,beta,delta,eclair,nameless,r2,r10", `A to Z, got ${ids(asc)}`);
	assert(ids(rooms) === before, "the input list is not reordered in place");
	assert(ids(orderRooms(rooms, { mode: "name-desc" })) === ids(asc.slice().reverse()), "Z to A is A to Z read backwards");

	// --- Totality: same names, names that differ only by case, any input order gives one answer ---
	const twins = [
		{ id: "twin-b", displayName: "Notes" },
		{ id: "twin-a", displayName: "Notes" },
		{ id: "lower", displayName: "notes" },
		{ id: "upper", displayName: "NOTES" },
	];
	const expectedTwins = ids(orderRooms(twins, { mode: "name-asc" }));
	for (let shift = 0; shift < twins.length; shift++) {
		const rotated = [...twins.slice(shift), ...twins.slice(0, shift)];
		assert(ids(orderRooms(rotated, { mode: "name-asc" })) === expectedTwins, `the order does not depend on the input order (rotation ${shift})`);
		assert(ids(orderRooms(rotated.slice().reverse(), { mode: "name-desc" })) === ids(orderRooms(twins, { mode: "name-asc" }).reverse()), `nor does its mirror (rotation ${shift})`);
	}
	assert(expectedTwins.indexOf("twin-a") < expectedTwins.indexOf("twin-b"), "two rooms with one name are ordered by id");
	for (const a of twins) for (const b of twins) {
		const ab = compareRoomsByName(a, b);
		assert(a === b ? ab === 0 : ab !== 0 && Math.sign(ab) === -Math.sign(compareRoomsByName(b, a)), `two different rooms never compare equal (${a.id}, ${b.id})`);
	}
	assert(orderRooms([], { mode: "name-desc" }).length === 0, "no rooms, no order");

	// --- Custom: the ONE ordering reads the arrangement through the reconcile rule and nothing else ---
	{
		const custom = [{ id: "a", displayName: "Echo" }, { id: "b", displayName: "Delta" }, { id: "c", displayName: "Charlie" }];
		assert(ids(orderRooms(custom, { mode: "custom", customOrder: ["c", "a"] })) === ids(reconcileRoomsByCustomOrder(custom, ["c", "a"])) && ids(orderRooms(custom, { mode: "custom", customOrder: ["c", "a"] })) === "c,a,b", "custom is the reconcile rule");
		assert(ids(orderRooms(custom, { mode: "custom" })) === "c,b,a" && ids(orderRooms(custom, { mode: "custom", customOrder: [] })) === "c,b,a", "without an arrangement, custom is A to Z: nothing jumps");
		assert(ids(orderRooms(custom, { mode: "name-asc", customOrder: ["c", "a"] })) === "c,b,a", "a name order ignores the arrangement");
		assert(ids(orderRooms(custom, { mode: "custom", customOrder: ["a"] }, new Map([["b", 5]]))) === "a,c,b", "and custom ignores the times");
		assert(ids(custom) === "a,b,c", "the input list is not reordered in place");
	}

	// --- Recently used: the newest first, the never-used after them A to Z, and
	// every time read ONCE, so a record that does not parse cannot unsettle it ---
	const used = [
		{ id: "r-old", displayName: "Alpha", lastUsedAt: "2026-09-01T10:00:00.000Z" },
		{ id: "r-new", displayName: "Zulu", lastUsedAt: "2026-09-17T10:00:00.000Z" },
		{ id: "r-mid", displayName: "Mike", lastUsedAt: "2026-09-10T10:00:00.000Z" },
		{ id: "r-never-b", displayName: "Bravo", lastUsedAt: null },
		{ id: "r-never-a", displayName: "alpha 2" },
		{ id: "r-bad", displayName: "Charlie", lastUsedAt: "yesterday" },
		{ id: "r-tie-b", displayName: "Tie", lastUsedAt: "2026-09-05T10:00:00.000Z" },
		{ id: "r-tie-a", displayName: "Tie", lastUsedAt: "2026-09-05T10:00:00.000+00:00" },
		{ id: "r-number", displayName: "Delta", lastUsedAt: 2026 as unknown as string },
	];
	const times = roomLastUsedTimes(used);
	assert([...times.keys()].sort().join(",") === "r-mid,r-new,r-old,r-tie-a,r-tie-b", "only a time that is a string and parses counts as use");
	assert([...times.values()].every((time) => Number.isFinite(time)), "no time in the map is a NaN");
	assert(times.get("r-tie-a") === times.get("r-tie-b"), "fixture: one instant written two ways is one time");
	const expectedRecent = "r-new,r-mid,r-tie-a,r-tie-b,r-old,r-never-a,r-never-b,r-bad,r-number";
	const byRecentUse = compareRoomsByRecentUse(times);
	for (let shift = 0; shift < used.length; shift += 1) {
		const rotated = [...used.slice(shift), ...used.slice(0, shift)];
		assert(ids(rotated.slice().sort(byRecentUse)) === expectedRecent, `recently used does not depend on the input order (rotation ${shift})`);
		assert(ids(rotated.slice().reverse().sort(byRecentUse)) === expectedRecent, `nor on its mirror (rotation ${shift})`);
	}
	for (const a of used) for (const b of used) {
		const ab = byRecentUse(a, b);
		assert(a === b ? ab === 0 : ab !== 0 && Math.sign(ab) === -Math.sign(byRecentUse(b, a)), `recently used: two different rooms never compare equal (${a.id}, ${b.id})`);
	}
	// The order reads the map it was given, never the rooms: the home screen
	// holds one map still for a visit while the rooms change under it.
	const movedOn = used.map((room) => room.id === "r-old" ? { ...room, lastUsedAt: "2026-09-18T10:00:00.000Z" } : room);
	assert(ids(movedOn.slice().sort(byRecentUse)) === expectedRecent, "a room whose own time moved keeps its place under a map taken earlier");
	assert(ids(movedOn.slice().sort(compareRoomsByRecentUse(roomLastUsedTimes(movedOn)))).startsWith("r-old,r-new"), "and leads under a map taken after");
	assert(ids(used.slice().sort(compareRoomsByRecentUse(new Map()))) === ids(orderRooms(used, { mode: "name-asc" })), "with no room ever used, recently used is A to Z");
	// The mode: first in the list the menu is drawn from, saved and read back like
	// the others, the arrangement riding along; ordered by the map it is given.
	assert(ROOM_ORDER_MODES.join(",") === "recent,name-asc,name-desc,custom" && isRoomOrderMode("recent") && isRoomOrderMode("custom"), "recently used is a mode and leads the list; custom is a mode and closes it (the menu is drawn from this list)");
	assert(ids(orderRooms(used, { mode: "recent" }, times)) === expectedRecent, "orderRooms in recently used is the comparison over the map it is given");
	assert(ids(orderRooms(movedOn, { mode: "recent" }, times)) === expectedRecent, "never over the rooms' own times");
	assert(ids(orderRooms(used, { mode: "recent" })) === ids(orderRooms(used, { mode: "name-asc" })), "and with no map, A to Z");
	assert(ids(orderRooms(used, { mode: "name-asc" }, times)) === ids(orderRooms(used, { mode: "name-asc" })), "a name order does not read the map");
	{
		const before = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null;
		fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, mode: "name-asc", customOrder: ["room-c", "room-a"], updatedAt: stamp.toISOString() }));
		const savedRecent = saveRoomOrder({ mode: "recent" }, {}, stamp);
		assert(savedRecent.preference.mode === "recent" && readRoomOrder().preference.mode === "recent", "recently used is saved and read back");
		assert(readRoomOrder().preference.customOrder.join(",") === "room-c,room-a", "and the arrangement rides along");
		if (before === null) fs.rmSync(file); else fs.writeFileSync(file, before);
	}

	// --- Upgrade day: with nothing saved, the order is the one the home screen
	// always had (its own line, kept here as the reference), except that a
	// number in a name now counts as a number. Same names, same ids, so the
	// reference's lack of a tie-break cannot show. ---
	const homeScreenBefore = (list: Array<{ id: string; displayName?: string }>) => list.slice().sort((a, b) => (a.displayName || a.id).localeCompare(b.displayName || b.id));
	const digitFree = [
		// The twins' ids run AGAINST the order the old line gives their names: a
		// comparison that stopped telling case or accents apart would fall back
		// to the ids and fail here, where matching ids would let it pass.
		{ id: "n4", displayName: "notes" }, { id: "n3", displayName: "Notes" }, { id: "n2", displayName: "NOTES" }, { id: "n1", displayName: "n\xf6tes" },
		{ id: "m", displayName: "Marketing" }, { id: "l", displayName: "legal" }, { id: "e", displayName: "\xc9lan" }, { id: "z", displayName: "Zeta" },
		{ id: "s", displayName: " leading space" }, { id: "w", displayName: "   " }, { id: "plain-id" }, { id: "q", displayName: "Q plan" },
	];
	for (let shift = 0; shift < digitFree.length; shift++) {
		const rotated = [...digitFree.slice(shift), ...digitFree.slice(0, shift)];
		assert(ids(orderRooms(rotated, { mode: ROOM_ORDER_DEFAULT_MODE })) === ids(homeScreenBefore(rotated)), `names without digits keep the order they had before the feature (rotation ${shift})`);
	}
	const numbered = [{ id: "r1", displayName: "Room 1" }, { id: "r10", displayName: "Room 10" }, { id: "r2", displayName: "Room 2" }];
	assert(ids(homeScreenBefore(numbered)) === "r1,r10,r2" && ids(orderRooms(numbered, { mode: "name-asc" })) === "r1,r2,r10", "the one difference: 10 no longer sorts before 2");

	// --- Route policy: every device sees the order, a full-capability device may choose it ---
	assert(classifyRemoteRoute("GET", "/api/settings/room-order") === "read", "reading the order is a read");
	assert(classifyRemoteRoute("PUT", "/api/settings/room-order") === "write", "choosing it is a write");

	console.log("room-order smoke: ok");
} finally {
	fs.rmSync(tempHome, { recursive: true, force: true });
}
