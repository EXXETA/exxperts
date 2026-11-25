/**
 * Words the skills pages show that their smokes check: a room's Skills page;
 * Settings, Skills, its Add skill menu and the ways to add a skill, and the
 * size a skill may have, which the server checks too; for a skill
 * exxperts does not own (the store tiers builtin, shared and project), why its
 * page cannot delete it and what the library table shows where it came from;
 * and what the review screen says of a skill's files.
 */

/** A room's Skills page: its lead, its two groups (the old settings look) and its search field. */
export const ROOM_SKILLS_LEAD = "Switch a skill on to use it in this room.";
export const ROOM_SKILL_GROUPS = { on: "On in this room", off: "Off in this room" } as const;
/** The new settings look: the way from a room's Skills page to Settings, Skills, at the end of its lead. */
export const ROOM_SKILLS_MANAGE = "Manage skills in Settings";
/** The new settings look: the one heading over a room's skills or connectors, how many of them are on here. */
export function roomListOnCount(on: number, total: number): string {
	return `${on} of ${total} on`;
}
export const ROOM_SKILLS_SEARCH = "Search skills";
export function roomSkillsNoMatch(query: string): string {
	return `No skill matches “${query}”.`;
}
/** The room's page with an empty library, and the link that opens Settings, Skills; on a shared server, the company's library, which only its admin adds to. */
export const ROOM_SKILLS_EMPTY_LIBRARY = { line: "No skills in your library yet.", link: "Add one in Settings, Skills.", company: "Your company's library has no skills yet." } as const;
/** What a screen reader hears for a skill's switch on a room's page. */
export function roomSkillSwitchName(name: string): string {
	return `Use ${name} in this room`;
}
/** The one line when a room's switch could not be saved and went back. */
export function roomSkillSwitchFailedLine(name: string, on: boolean): string {
	return `Couldn't switch ${name} ${on ? "on" : "off"}.`;
}
/** A room's skill whose files can't be opened, where its description would be. */
export const ROOM_SKILL_UNREADABLE_LINE = "This room can't use this skill, because exxperts can't read its files.";
/** After that line, in the target that opens the skill's page. */
export const OPEN_SKILL = "Open skill";

/** The tag beside the name of a skill its author marked to start only by hand, wherever it is listed. */
export const SKILL_BY_HAND_TAG = "Only when you pick it";

/** A room's Skills page, after the description of a by-hand skill that is on in the room: how to use it there. */
export function skillPickHowLine(name: string): string {
	return `Type "/${name}" in the message box to use it.`;
}

/** The heading of the list a "/" at the start of a room's message box opens. */
export const SKILL_PICK_HEADING = "Skills on in this room";

/** Settings, Skills: the line under the title, and the Add skill menu's ways in (Browse featured on the empty page too). */
export const SKILLS_PAGE_LINE = "Know-how your rooms can use: instructions, documents, templates and scripts.";
export const ADD_SKILL_WAYS = { write: "Write it yourself", upload: "Upload a file", repository: "From a repository address", featured: "Browse featured" } as const;
/** The end of the empty page's line, its own way to the featured skills. */
export const BROWSE_FEATURED_LINK = "browse featured skills";
/** The way back to Settings, Skills from a skill's page: its words in the old settings look; in the new, the arrow's name for a screen reader, on each way to add one too. */
export const SKILL_PAGE_BACK = "← Skills";
export const SKILL_PAGE_BACK_NAME = "Back to Skills";

/** Writing a skill, and the description field it shares with an upload's review. */
export const WRITE_SKILL_LEAD = "Write what the assistant should do when this skill is used. Rooms use it once you switch it on there.";
export const SKILL_DESCRIPTION_LABEL = "Description: one line on when to use this skill.";
/** In the new settings look the description field's label and its help under it, in place of the one label. */
export const SKILL_DESCRIPTION_FIELD = { label: "Description", help: "One line on when to use this skill." } as const;
/** In the new settings look, under a name with no letter or number, which can't be saved. */
export const SKILL_NAME_REFUSED_LINE = "Use at least one letter or number in the name.";

/** Adding skills from a repository: the help above the address. */
export const REPOSITORY_HELP = [
	"Paste the address of a repository on GitHub, GitLab or another git host. You review each skill before it's added.",
	"A private repository works only if this computer already has access to it.",
] as const;

/**
 * Why a repository's skills couldn't be listed, one sentence per cause: for an
 * address the person pasted, or in Browse, whose addresses they didn't type. A
 * sign-in or a tool this computer lacks brings the server's own sentence, which
 * says what to do.
 */
export const REPOSITORY_FAILED_LINES = {
	offline: "Couldn't reach this repository. Check your internet connection, then try again.",
	timeout: "This repository took too long to answer. Try again in a moment.",
	shortCommit: "Use the commit's full id in the address, then try again.",
	pasted: "Couldn't get this repository. Check the address, or try again later.",
	browse: "Couldn't load these skills. Try again later.",
} as const;
/** A server found by name that didn't take the connection: on a company's own git server, most often its VPN is off. */
export function repositoryConnectFailedLine(host: string): string {
	return `Couldn't connect to ${host}. If it needs your company's VPN, turn it on and try again, or use the repository's https address.`;
}
export function repositoryRefMissingLine(ref: string): string {
	return `This repository has no branch, tag or commit “${ref}”. Check the address, then try again.`;
}
/** The other way to a repository this computer can't sign in to, on a line of its own after the sentence, for someone who doesn't use git. */
export const REPOSITORY_UPLOAD_INSTEAD_LINE = `Or download the skill's folder as a zip and use ${ADD_SKILL_WAYS.upload}.`;
/** The sentence for a failed fetch of a repository by its reason (the server's `RepoReachReason`) and the ref after `#`. */
export function repositoryFailedLine(failure: { reason: string; message: string; host?: string }, ref: string | undefined, where: "pasted" | "browse"): string {
	if (failure.reason === "sign-in" && where === "pasted") return `${failure.message}\n${REPOSITORY_UPLOAD_INSTEAD_LINE}`;
	if (failure.reason === "sign-in" || failure.reason === "missing-tool") return failure.message;
	if (failure.reason === "offline") return REPOSITORY_FAILED_LINES.offline;
	// Browse's addresses aren't the person's to change, so its own line stays.
	if (failure.reason === "connect-failed" && failure.host && where === "pasted") return repositoryConnectFailedLine(failure.host);
	if (failure.reason === "timeout") return REPOSITORY_FAILED_LINES.timeout;
	if (failure.reason === "ref-missing" && ref) return /^[0-9a-f]{7,39}$/i.test(ref) ? REPOSITORY_FAILED_LINES.shortCommit : repositoryRefMissingLine(ref);
	return REPOSITORY_FAILED_LINES[where];
}

/** The review before a skill is added: its lead and its button. */
export const SKILL_REVIEW_LEAD = "Check what it brings before you add it. Rooms use it only where you switch it on.";
export const ADD_TO_LIBRARY = "Add to library";
/** The review of an upload whose name is already in the library: its question and its button. */
export function replaceSkillQuestion(name: string): string {
	return `Replace ${name}?`;
}
/** Under that question, when the skill there now has another written name: it is a different skill, and Replace puts this one in its place. */
export function replacesOtherSkillLine(existingName: string, id: string): string {
	return `“${existingName}” already uses /${id}. Replacing it puts this skill in its place, in every room where it's on.`;
}
/** The review, when the name a room's "/" picks it by differs from its written name. */
export function skillPickNameLine(id: string): string {
	return `In a room, pick it as /${id}.`;
}
export const REPLACE_SKILL = "Replace";
/** The review, when the skill's instructions reach above its folder by `path`, as written: adding copies its folder alone. */
export function skillOutsideFolderLine(path: string): string {
	return `This skill mentions files outside its folder (${path}). They aren't added with it, so parts of it may not work.`;
}

/**
 * How big a skill may be, by every way in: the files that would be written,
 * its SKILL.md included, and their bytes. The server checks these numbers and
 * answers a refusal with `SKILL_TOO_BIG` and the real count or size.
 */
export const SKILL_LIMITS = { files: 2000, bytes: 8 * 1024 * 1024 } as const;
/**
 * The largest file an upload may be: the limit and 1 MB for a zip's own headers,
 * which are never written. A file past it holds more than 8 MB of skill (short of
 * file names beyond any real skill's), so it is refused as "over 9 MB" unopened.
 */
export const SKILL_UPLOAD_MAX_BYTES = SKILL_LIMITS.bytes + 1024 * 1024;
export const SKILL_TOO_BIG = "skill-too-big";
/** What a refusal carries: the count of files, or the size, `over` when it was measured no further than that. */
export type SkillTooBig = { files: number } | { bytes: number; over?: boolean };

/** A size as the sentences say it: "8 MB", "9.4 MB", "61 MB", never rounded down to the limit. */
export function skillSizeText(bytes: number): string {
	const mb = bytes / (1024 * 1024);
	// A hair under each step first, so 9.4 MB in bytes never reads as 9.5 from the float's last bit.
	const shown = mb < 10 ? Math.ceil(mb * 10 - 1e-9) / 10 : Math.ceil(mb - 1e-9);
	return `${shown} MB`;
}

/** The one line when a skill is past the limit, with its real numbers. */
export function skillTooBigLine(refusal: SkillTooBig): string {
	if ("files" in refusal) return `This skill has ${refusal.files.toLocaleString("en-US")} files, more than the ${SKILL_LIMITS.files.toLocaleString("en-US")} a skill can have, so it can't be added.`;
	return `This skill is ${refusal.over ? "over " : ""}${skillSizeText(refusal.bytes)}, more than the ${skillSizeText(SKILL_LIMITS.bytes)} a skill can have, so it can't be added.`;
}

/** The one line when a skill's new version is past the limit, with its real numbers: the skill stays as it is. */
export function skillUpdateTooBigLine(refusal: SkillTooBig): string {
	if ("files" in refusal) return `Its new version has ${refusal.files.toLocaleString("en-US")} files, more than the ${SKILL_LIMITS.files.toLocaleString("en-US")} a skill can have, so it can't update.`;
	return `Its new version is ${refusal.over ? "over " : ""}${skillSizeText(refusal.bytes)}, more than the ${skillSizeText(SKILL_LIMITS.bytes)} a skill can have, so it can't update.`;
}

/** A name the library already holds where it can't be replaced: a repository's skill, or one exxperts does not own. */
export const SKILL_NAME_TAKEN = "skill-name-taken";
export function skillNameTakenLine(name: string): string {
	return `Your library already has a skill named ${name}, so this one can't be added.`;
}

/** An add or Replace whose uploaded file the server no longer holds: nothing was written. */
export const SKILL_UPLOAD_GONE = "skill-upload-gone";
export const SKILL_UPLOAD_GONE_LINE = "The uploaded file has expired, so upload it again.";
/** A Replace whose review showed another version of the skill than the one there now: nothing is replaced. */
export const SKILL_CHANGED_SINCE_REVIEW = "skill-changed-since-review";
export function skillChangedSinceReviewLine(id: string): string {
	return `Your skill /${id} changed after this review opened, so it wasn't replaced. Add this skill again to see what it would replace.`;
}
/** A Replace that failed: the server's answer, true whether the old skill stayed in place or could not be put back yet. */
export const SKILL_REPLACE_FAILED_LINE = "Couldn't replace this skill.";

/** In the new settings look, the section that lists a skill's files by kind. */
export const SKILL_FILES_HEADING = "Files";
/** The kinds of a skill's files, in the order the review and a skill's page list them. */
export const SKILL_FILE_KIND_NAMES = {
	instructions: "Instructions",
	documents: "Documents",
	templates: "Templates and pictures",
	scripts: "Scripts",
	other: "Other files",
} as const;
export type SkillFileKind = keyof typeof SKILL_FILE_KIND_NAMES;

/**
 * The Scripts line of the review and a skill's page: on the computer itself,
 * what a room may do with them; on a shared server, whose rooms have no
 * commands and no file tools, that they never run. One script reads in the singular.
 */
/**
 * On a Windows computer whose rooms run commands in their protection, a skill whose folder holds a link: the protection
 * isn't given its folder, so a room runs its scripts only from a folder it already opens: its own, or one it was allowed. On the skill's Scripts line and under
 * it on a room's Skills page (the answer's `scriptsReadOnly`).
 */
export const SKILL_SCRIPTS_READ_ONLY_LINE = "Rooms with protection on run its scripts only from a folder they can already open, because the skill's folder holds a link.";

export const SKILL_FILES_LINES = {
	run: { one: "The assistant can run it in rooms where this skill is on and commands are on.", many: "The assistant can run these in rooms where this skill is on and commands are on." },
	sharedServer: { one: "On this server, this file never runs.", many: "On this server, these files never run." },
	readOnly: { one: SKILL_SCRIPTS_READ_ONLY_LINE, many: SKILL_SCRIPTS_READ_ONLY_LINE },
} as const;

/** In the new settings look, the review's message on a skill with scripts: their count before the Scripts line, and its button, which opens Scripts. */
export function skillScriptsCount(count: number): string {
	return count === 1 ? "1 script." : `${count} scripts.`;
}
export const SHOW_SCRIPTS = "Show scripts";

/** The Scripts line for `count` scripts: on the computer (`run`), on a Windows computer where the protection isn't given the skill's folder (`readOnly`), or on a shared server. */
export function skillFilesLine(where: keyof typeof SKILL_FILES_LINES, count: number): string {
	return count === 1 ? SKILL_FILES_LINES[where].one : SKILL_FILES_LINES[where].many;
}

/** A library skill whose written name fits onto a "/" name it can't have (the answer's `nameTaken`): another skill has it, or fits onto it too. */
export function skillNameTakenByOtherLine(id: string): string {
	return `Rooms can't use this skill, because another skill also has the name /${id}. To use it, give it another name where it's kept.`;
}

/** Why rooms use only a skill's instructions from the folder shared with other tools (the answer's `instructionsOnly`): on its page and on a room's Skills page. */
export const SKILL_INSTRUCTIONS_ONLY_LINES = {
	home: "Rooms use only this skill's instructions, because its link leads to your whole home folder or above it. Link it to the skill's own folder to let rooms use its files.",
	"cant-open": "Rooms use only this skill's instructions, because rooms can't open its folder.",
} as const;

/** Where the files of a skill from the folder shared with other tools are, when its link leads outside ~/.agents and rooms open them (the answer's `filesAt`): on its page and on a room's Skills page. */
export function skillFilesAtLine(place: string): string {
	return `Its files are in ${place}.`;
}

/** A library skill whose SKILL.md can't be opened, where its description would be on its row; also a request refused for it. */
export const SKILL_UNREADABLE_LINE = "No room can use this skill, because exxperts can't read its files.";
/** The same on the skill's page, with what to do when its SKILL.md is a link. */
export const SKILL_UNREADABLE_PAGE_LINE = `${SKILL_UNREADABLE_LINE} If its SKILL.md is a link to another file, replace the link with a copy of that file.`;

/** The Delete row's line for a skill exxperts does not own, per store tier. */
export const PROTECTED_SKILL_DELETE_LINES: Readonly<Record<string, string>> = {
	builtin: "It comes with exxperts, so it can't be deleted. To stop a room using it, switch it off in that room's Skills settings.",
	shared: "It lives in ~/.agents/skills, which other tools manage. Delete it there to remove it.",
	project: "It comes with this project's folder. Remove it from .exxeta/skills there.",
};

/** The library table's From cell for a skill with no import record. */
export const SKILL_TIER_LABELS: Readonly<Record<string, string>> = {
	user: "Your skills folder",
	builtin: "Built in",
	shared: "Shared",
	project: "This project",
};

export function protectedSkillDeleteLine(tier: string): string | null {
	return PROTECTED_SKILL_DELETE_LINES[tier] ?? null;
}

export function skillTierLabel(tier: string): string | null {
	return SKILL_TIER_LABELS[tier] ?? null;
}

/** Settings, Skills: the button beside "Last checked" that asks your skills' repositories for new versions, what it says meanwhile, and the row's button that installs one. */
export const CHECK_NOW = "Check now";
export const CHECKING_NOW = "Checking…";
export const UPDATE_SKILL = "Update";

/** Names joined as a sentence says them: "A", "A and B", "A, B and C". */
export function joinWithAnd(names: string[]): string {
	if (names.length <= 1) return names.join("");
	return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The line after a check: how many skills have an update, or that none has. "All
 * up to date" only when no skill from a repository was left out: one that can't
 * update (its version isn't known, or it left or was renamed in its repository)
 * is named, and its page says why.
 */
export function skillUpdatesFoundLine(available: number, cannotUpdate: readonly string[] = []): string {
	if (available > 0) return available === 1 ? "An update is available for 1 skill." : `Updates are available for ${available} skills.`;
	if (cannotUpdate.length === 0) return "All your skills from repositories are up to date.";
	const named = joinWithAnd(cannotUpdate.map((name) => `“${name}”`));
	return cannotUpdate.length === 1 ? `No updates found. ${named} can't update: its page says why.` : `No updates found. ${named} can't update: their pages say why.`;
}

/** Why a repository could not be asked (the server's `SkillCheckFailure`). */
export interface SkillUpdateFailure {
	reason: string;
	message: string;
	host?: string;
}

/** A host that gave no answer, whether it couldn't be found or took too long. */
function noAnswer(failure: SkillUpdateFailure): boolean {
	return (failure.reason === "offline" || failure.reason === "timeout") && failure.host !== undefined;
}

/** The line when a check, or an update that fetches again, could not ask the named skills' repository, on the list. One host without an answer says nothing of the person's own internet. */
export function skillUpdatesFailedLine(failure: SkillUpdateFailure, names: readonly string[], doing: "check" | "update" = "check", hosts: readonly string[] = failure.host ? [failure.host] : []): string {
	const named = joinWithAnd(names.map((name) => `“${name}”`));
	if (noAnswer(failure)) return `Couldn't ${doing} ${named}: ${joinWithAnd([...hosts])} didn't answer.`;
	const what = doing === "check" ? `check ${named} for updates` : `update ${named}`;
	if (failure.reason === "connect-failed" && failure.host) return `Couldn't connect to ${failure.host} to ${what}. If it needs your company's VPN, turn it on and try again.`;
	// A sign-in or a missing tool comes with the server's own advice, which says what to do.
	if (failure.reason === "sign-in" || failure.reason === "missing-tool") return `Couldn't ${what}. ${failure.message.charAt(0).toUpperCase()}${failure.message.slice(1)}`;
	return `Couldn't ${what}. Try again later.`;
}

/** The same on the skill's own page, whose title is its name. */
export function skillPageCheckFailedLine(failure: SkillUpdateFailure, name: string): string {
	return noAnswer(failure) ? `Couldn't check for a new version: ${failure.host} didn't answer.` : skillUpdatesFailedLine(failure, [name]);
}

/** The line when every repository a check asked failed as offline: the one time it speaks of the person's internet. */
export const SKILL_UPDATES_OFFLINE_LINE = "Couldn't check for updates. Check your internet connection, then try again.";

/** The lines for the skills a check of `asked` skills couldn't ask: one naming every skill whose host didn't answer, then one per other cause. */
export function skillUpdatesFailedLines(failed: readonly { name: string; failure: SkillUpdateFailure }[], asked: number): string[] {
	if (failed.length === 0) return [];
	if (failed.length === asked && failed.every(({ failure }) => failure.reason === "offline")) return [SKILL_UPDATES_OFFLINE_LINE];
	const causes = new Map<string, { failure: SkillUpdateFailure; names: string[]; hosts: Set<string> }>();
	for (const { name, failure } of [...failed].sort((a, b) => Number(noAnswer(b.failure)) - Number(noAnswer(a.failure)))) {
		// Without a name the line is the cause alone; hosts that didn't answer share one.
		const cause = noAnswer(failure) ? "" : skillUpdatesFailedLine(failure, []);
		const known = causes.get(cause) ?? { failure, names: [], hosts: new Set<string>() };
		known.names.push(name);
		if (failure.host) known.hosts.add(failure.host);
		causes.set(cause, known);
	}
	return [...causes.values()].map(({ failure, names, hosts }) => skillUpdatesFailedLine(failure, names, "check", [...hosts]));
}

/** When a check last had an answer from a skill's repository; null while none has. */
export function skillUpdatesCheckedLine(when: string | null): string {
	return when ? `Last checked ${when}.` : "Not checked yet.";
}

/** A skill's page: the group that shows another version, and its lines. */
export const SKILL_UPDATE_HEADING = "Update available";
/** The Version row's value in that group: its label says "Version", so the value is the two alone. */
export function skillUpdateVersionsLine(from: string | null, to: string | null): string | null {
	if (!from && !to) return null;
	return `${from ?? "not stated"} → ${to ?? "not stated"}`;
}
/** Over the new version's instructions, shown at the hidden-character stop so they can be reviewed before Update anyway. */
export const SKILL_UPDATE_NEW_INSTRUCTIONS = "New instructions";
export const SKILL_UPDATE_NEW_DESCRIPTION = "New description";
/** Named by the files they list: the facts below have their own "Added" date. */
export const SKILL_UPDATE_CHANGE_GROUPS = { added: "New files", removed: "Removed files", changed: "Changed files" } as const;
/** What a room gets after an update: proved by the room's next message being told to read the skill again. */
export const SKILL_UPDATE_ROOMS_LINE = "Rooms where it's on use the new version from their next message.";
export const SKILL_UPDATE_SCRIPTS_LINE = "Its scripts change too. Rooms where it's on use the new ones from their next message.";
/** The stop for hidden characters in a new version: its button, under the add's own warning. */
export const UPDATE_SKILL_ANYWAY = "Update anyway";
/** The stop for a skill changed on this computer, asked once. */
export function skillChangedHereQuestion(name: string): { title: string; body: string; confirmLabel: string } {
	return { title: `Update ${name}?`, body: "This skill was changed on this computer. Updating replaces those changes with the version from its repository.", confirmLabel: UPDATE_SKILL };
}
/** After an update. */
export function skillUpdatedNotice(name: string): string {
	return `Updated “${name}”.`;
}
/** The heading over what the last update changed; one Update automatically made says so. */
export function skillUpdatedHeading(date: string, automatic = false): string {
	if (automatic) return date ? `Updated automatically on ${date}` : "Updated automatically";
	return date ? `Updated ${date}` : "Updated";
}
/** An update the page could not install as it was shown, so it checked again. */
export const SKILL_UPDATE_RECHECKED_LINE = "This skill or its repository changed since the last check, so it was checked again.";
/** The refusal of an Update whose version had to be fetched again and couldn't be: its details are the failure. */
export const SKILL_UPDATE_NOT_FETCHED = "skill-update-not-fetched";
export const SKILL_UPDATE_FAILED_LINE = "Couldn't update this skill.";
export const SKILL_UPDATE_UNREADABLE_LINE = "Couldn't read the new version. Try again.";

/** A skill's page, for a skill that doesn't update, by why. */
export const SKILL_UPDATE_STATE_LINES = {
	pinned: "This skill is fixed to one version of its repository, so it doesn't update.",
	gone: "This skill is no longer in its repository. It keeps working as it is.",
	renamed: "Its repository now has this skill under another name, so it doesn't update.",
	untracked: "It isn't known which version of its repository this is. Add it again from its repository to get updates.",
	current: "Up to date with its repository.",
} as const;

/** A renamed skill's line, with the name its repository gives it now; where the person can add skills, how to get its updates. */
export function skillRenamedLine(newName: string, canAdd: boolean): string {
	const line = `Its repository now has this skill as “${newName}”, so this one doesn't update.`;
	return canAdd ? `${line} To get its updates, add “${newName}” from its repository.` : line;
}

/** The From row's ref, after the address: which branch, tag or commit the skill follows. */
export function skillRefText(refKind: string, ref: string | undefined): string | null {
	if (!ref) return null;
	// A no-break space keeps the word with what it names when From wraps.
	if (refKind === "branch") return `branch\u00a0${ref}`;
	if (refKind === "tag") return `tag\u00a0${ref}`;
	if (refKind === "commit") return `commit\u00a0${ref.slice(0, 7)}`;
	return null;
}

/** Settings, Skills: the button at the end of the line that says what the check found; it updates, in turn, every skill with an update. */
export const UPDATE_ALL = "Update all";

/**
 * A skill Update all didn't update: it waits for the person (its new version
 * has hidden characters, or it was changed on this computer) or its update
 * failed; and whether its row still has its Update, which it may not by then
 * (taken in another window, renamed, or its repository couldn't be asked).
 */
export interface SkillNotUpdated {
	name: string;
	why: "waits" | "failed";
	hasUpdate: boolean;
}

/**
 * The line after Update all: how many skills it updated, the ones that failed,
 * then the ones that wait for the person. A waiting one's Update shows its stop;
 * a failed one's tries again. The way on names only the ones whose row still
 * has its Update, and a waiting one whose row has none no longer waits, so it
 * reads as one that didn't update.
 */
export function skillUpdateAllLine(updated: number, notUpdated: readonly SkillNotUpdated[] = []): string {
	const done = updated === 0 ? "" : updated === 1 ? "Updated 1 skill." : `Updated ${updated} skills.`;
	const waiting = notUpdated.filter((skill) => skill.why === "waits" && skill.hasUpdate);
	const failed = notUpdated.filter((skill) => !waiting.includes(skill));
	const named = (skills: readonly SkillNotUpdated[]) => joinWithAnd(skills.map((skill) => `“${skill.name}”`));
	const wayOn = (skills: readonly SkillNotUpdated[], to: string) => {
		const withUpdate = skills.filter((skill) => skill.hasUpdate);
		if (withUpdate.length === 0) return "";
		if (skills.length === 1) return ` Use its Update ${to}`;
		return withUpdate.length === skills.length ? ` Use the Update beside each ${to}` : ` Use the Update beside ${named(withUpdate)} ${to}`;
	};
	const notDone = failed.length === 0 ? "" : `${named(failed)} didn't update.${wayOn(failed, "to try again.")}`;
	const waits = waiting.length === 0 ? "" : `${named(waiting)} ${waiting.length === 1 ? "is" : "are"} waiting for you.${wayOn(waiting, "to see why.")}`;
	return [done, notDone, waits].filter(Boolean).join(" ");
}

/** A skill's page: its Update automatically switch and the line under it. */
export const AUTO_UPDATE_LABEL = "Update automatically";
export const AUTO_UPDATE_LINE = "Gets new versions from its repository by itself.";
export const AUTO_UPDATE_SAVE_FAILED_LINE = "Couldn't change Update automatically. Try again.";

/** The notice on Settings, Skills after Update automatically: the skills it updated, and the ones it left for the person. */
export function skillsUpdatedAutomaticallyLine(names: readonly string[]): string {
	return `Updated automatically: ${joinWithAnd(names.map((name) => `“${name}”`))}.`;
}
/** Its way on: the row's Update stops at the same warning or question. */
export function skillsLeftForYouLine(names: readonly string[]): string {
	const named = joinWithAnd(names.map((name) => `“${name}”`));
	return `${named} didn't update automatically. ${names.length === 1 ? "Use its Update to see why." : "Use the Update beside each to see why."}`;
}
/** The notice's button. */
export const CLOSE_NOTICE = "Close";

/** A skill's page, over an update Update automatically left for the person, by why. */
export const SKILL_AUTO_SKIPPED_LINES = {
	hiddenCharacters: "It didn't update automatically: its new version has hidden characters.",
	changedHere: "It didn't update automatically: it was changed on this computer.",
} as const;
