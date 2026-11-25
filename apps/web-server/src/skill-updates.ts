/**
 * Updating a skill from the repository it was added from (one source): which of
 * the person's skills have another version there (`checkSkillUpdates`), what a
 * skill's row and page say of it (`skillUpdatesReader`), and swapping one in
 * (`updateSkill`).
 *
 * A skill has an update when the files of its folder in the repository differ
 * from the ones it was given, whatever version they state. Its ref is asked
 * first (`listRemoteRefs`), once per repository and ref; only a ref that moved
 * is fetched. A skill fixed to one commit never updates; one added from a
 * repository before its record kept the repository is never matched by a guess.
 *
 * A check's result is stored in the app's state folder, bound to the
 * installation it is about: the skill's identity and its record's repository.
 * Update checks them again, with the installed files' hash, in the same
 * synchronous step as the swap, so a skill deleted and added again, replaced or
 * edited since the check is never overwritten. The new version is the checkout
 * a check fetched, held for 15 minutes (the checkout cache); once it is no longer
 * held (a restart, the time passing, or a check that met the version it already
 * knew) Update fetches it again and goes on only with the version it named
 * (`updateSkill`). Nothing here ever runs a file of a skill.
 *
 * The whole library is checked by the person ("Check now") or by the page as it
 * opens (`checkSkillLibrary`): the page's own check asks only skills last asked
 * over an hour ago, uses no sign-in of the person's, opens no window, and keeps
 * the result of a skill whose repository it couldn't ask.
 *
 * The daily pass (`runSkillAutoUpdatePass`, armed by `startSkillAutoUpdates`):
 * the same check for every skill that follows a branch or a tag, which is all
 * it does for a skill whose "Update automatically" is off. Where the switch is
 * on, then the same Update one click makes, never with a yes, for a version a
 * check first saw at least 12 hours ago. A new version with hidden characters,
 * and a skill changed on this computer, wait for the person's own Update.
 * Never on a shared server.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { productAppStatePath } from "../../../pi-package/product-state-paths.js";
import { scanInvisibleUnicode, skillFileList, SkillTooBigError, type InvisibleUnicodeFinding, type SkillFile } from "./skills-import.js";
import { fetchRepoCheckout, getCheckout, scriptFiles, listRemoteRefs, parseSkillFrontmatter, refCommit, registerCheckout, removeCheckout, repoFailureOf, repoSkillFiles, resolveRepoSource, scanRepoSkills, shownRepositoryAddress, skillVersion, vendorRepoSkill, type RepoAskOptions, type RepoCheckout, type RepoReachReason, type SkillScripts } from "./skills-repo-fetch.js";
import { agentSkillsDir, installedSkillFilesSha256, isSkillId, isSystemFile, listSkillFiles, readSkillFileText, readSkillIdentity, readSkillProvenance, replaceSkillDir, sha256, skillFilesSha256, writeSkillProvenance, type SkillProvenance, type SkillRefKind, type SkillRepository } from "./skills-store.js";
import { SKILL_UPDATE_FAILED_LINE, SKILL_UPDATE_NOT_FETCHED, type SkillTooBig } from "../../web-ui/src/skill-source-copy.js";
import { isSharedServer } from "./server-hooks.js";

/**
 * Local repository paths (file://, absolute paths) are off by default: on, a
 * repository check or add can read any folder of this computer. Smokes turn them
 * on with this setting.
 */
export const SKILLS_ALLOW_LOCAL_REPO = process.env.EXXETA_SKILLS_ALLOW_LOCAL_REPO === "1";

/**
 * Where a skill stands against its repository: the same files; another version
 * there; fixed to one commit; the repository could not be asked; no longer
 * there; there under another name; or added before the record kept its
 * repository.
 */
export type SkillUpdateState = "current" | "available" | "pinned" | "unreachable" | "gone" | "renamed" | "untracked";

/** The files an update adds, removes and changes, each with its kind. */
export interface SkillUpdateChanges {
	added: SkillFile[];
	removed: SkillFile[];
	changed: SkillFile[];
}

/** Another version of a skill, as a check found it. */
export interface SkillUpdateCandidate {
	/** The checkout it was read from, as long as that is held. */
	token: string;
	commit: string;
	/** Its folder in the repository: the stored one, or where a single SKILL.md of the same name moved. */
	path: string;
	filesSha256: string;
	changes: SkillUpdateChanges;
	/** The versions its SKILL.md states, now and in the new version. */
	versions: { from: string | null; to: string | null };
	/** Hidden characters in the new version's instructions or description: Update waits for the person's yes. */
	scanFindings: InvisibleUnicodeFinding[];
	hiddenCharacters: boolean;
	/** The new version's instructions and description, only when they hold hidden characters: the stop shows them where the warning asks to review them. */
	body?: string;
	description?: string;
	/** The installed files differ from the ones it was given: Update replaces those changes only with the person's yes. */
	changedHere: boolean;
}

/** Another version of a skill as the page gets it: Update names it by `id`, a fingerprint of what the page shows of it, whichever checkout it is read from. */
export type SkillUpdateCandidateView = Omit<SkillUpdateCandidate, "token"> & { id: string };

function candidateView(candidate: SkillUpdateCandidate): SkillUpdateCandidateView {
	const { token: _token, ...shown } = candidate;
	return { ...shown, id: candidateId(candidate) };
}

/** Two versions with one id have the same files, change the same ones here and stop at the same questions. */
function candidateId({ filesSha256, changes, versions, scanFindings, changedHere }: SkillUpdateCandidate): string {
	return sha256(JSON.stringify([filesSha256, changes, versions, scanFindings, changedHere]));
}

/** Why a repository could not be asked, and its host. */
export interface SkillCheckFailure {
	reason: RepoReachReason;
	message: string;
	host?: string;
}

/** What the last update changed, which the skill's page keeps. */
interface SkillUpdated {
	at: string;
	changes: SkillUpdateChanges;
	versions: { from: string | null; to: string | null };
	/** The files' hash it installed: the record stops being this installation once it changes. */
	filesSha256: string;
	/** The pass made it, not the person's own Update. */
	automatic?: true;
	/** The person closed the notice that named it. */
	noticeClosed?: true;
}

/** A check's result for one skill, as stored. */
interface SkillCheckEntry {
	state: Exclude<SkillUpdateState, "untracked">;
	/** When its repository last answered a check; absent while it never has (`missed` says when one tried). */
	checkedAt?: string;
	/** The installation it is about: the skill's identity and its record's repository at the check. */
	identity: string | null;
	repository: SkillRepository;
	/** The installed files' hash at the check; null when they could not be read. */
	installedFilesSha256: string | null;
	candidate?: SkillUpdateCandidate;
	renamedTo?: string;
	/** The repository's commit at which the skill was gone or renamed. */
	missingAt?: string;
	failure?: SkillCheckFailure;
	/** A later check that couldn't ask the repository. Its failure is here when it left the result as it was: none when the person's check made it the result, or only theirs can ask. */
	missed?: { at: string; failure?: SkillCheckFailure };
	updated?: SkillUpdated;
	/** When a check first saw the version with these files: the pass takes it 12 hours later. Another version starts again. */
	firstSeen?: { filesSha256: string; at: string };
	/** The pass left this version for the person (hidden characters, or changed here); the notice names it until closed. */
	autoSkipped?: { filesSha256: string; at: string; noticeClosed?: true };
}

/** A skill's repository as the page shows it: the address without any login. */
export interface SkillRepositoryView {
	address: string;
	ref?: string;
	refKind: SkillRefKind;
	path: string;
	commit: string;
	/** Its "Update automatically" switch. */
	autoUpdate: boolean;
	/** Its repository was last asked over an hour ago: the page, as it opens, asks again. */
	checkDue: boolean;
}

/** What a skill's row and page say of its updates. */
export interface SkillUpdateView {
	state: SkillUpdateState;
	checkedAt?: string;
	installedFilesSha256?: string | null;
	candidate?: SkillUpdateCandidateView;
	renamedTo?: string;
	failure?: SkillCheckFailure;
	/** Why the last check since this result couldn't ask the repository. */
	missed?: SkillCheckFailure;
	updated?: { at: string; changes: SkillUpdateChanges; versions: { from: string | null; to: string | null }; automatic?: true; noticeClosed?: true };
	/** The pass left the update found for the person. */
	autoSkipped?: { noticeClosed?: true };
}

/** A skill's check result, as the check route answers it. */
export type SkillCheckResult = { name: string } & SkillUpdateView;

// --- The stored results ------------------------------------------------------

function checksFile(): string {
	return productAppStatePath("skill-updates.json");
}

/** The stored results by skill name; a file that is missing or doesn't parse holds none (each check writes its own again). */
function readEntries(): Record<string, SkillCheckEntry> {
	try {
		const parsed = JSON.parse(fs.readFileSync(checksFile(), "utf-8"));
		const skills = parsed?.skills;
		return skills && typeof skills === "object" && !Array.isArray(skills) ? (skills as Record<string, SkillCheckEntry>) : {};
	} catch {
		return {};
	}
}

/** Reads the stored results, changes them and writes them whole (a temporary file, then a rename), in one synchronous step. */
function changeEntries(change: (entries: Record<string, SkillCheckEntry>) => void): void {
	const entries = readEntries();
	change(entries);
	const file = checksFile();
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.${crypto.randomUUID()}.tmp`;
	try {
		fs.writeFileSync(temp, `${JSON.stringify({ skills: entries }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		fs.renameSync(temp, file);
	} catch (error) {
		fs.rmSync(temp, { force: true });
		throw error;
	}
}

/** A skill added from a repository before its record kept the repository: its source is an address, not "local" or "upload". */
function addedFromRepositoryBefore(record: SkillProvenance): boolean {
	return !record.repository && record.source !== "local" && record.source !== "upload" && record.source.trim() !== "";
}

function sameRepository(a: SkillRepository | undefined, b: SkillRepository | undefined): boolean {
	return Boolean(a && b) && a!.address === b!.address && (a!.ref ?? null) === (b!.ref ?? null) && a!.refKind === b!.refKind && a!.path === b!.path && a!.commit === b!.commit && a!.filesSha256 === b!.filesSha256;
}

/** The stored result still speaks of the installation the record names now. */
function bound(entry: SkillCheckEntry, identity: string | null, repository: SkillRepository | undefined): boolean {
	return entry.identity === identity && sameRepository(entry.repository, repository);
}

function boundEntry(entry: SkillCheckEntry | undefined, identity: string | null, repository: SkillRepository | undefined): SkillCheckEntry | undefined {
	return entry && bound(entry, identity, repository) ? entry : undefined;
}

/** The page's own check asks a repository at most once in this time. */
const CHECK_DUE_MS = 60 * 60_000;

/** No check asked the skill's repository within the last hour, whatever came of it; a time still to come (the clock went back) counts as none. */
function checkDue(entry: SkillCheckEntry | undefined, now: number): boolean {
	const asked = [entry?.checkedAt, entry?.missed?.at].map((at) => (at ? Date.parse(at) : Number.NaN)).filter((at) => at <= now);
	return asked.every((at) => now - at >= CHECK_DUE_MS);
}

/** The installation's identity as a check binds to it: an identity, or none; a record that can't be read binds nothing. */
function bindableIdentity(skillDir: string): string | null | undefined {
	const identity = readSkillIdentity(skillDir);
	return identity === "unreadable" ? undefined : identity;
}

/** A skill's repository and update facts for the library's list and page; one read of the stored results serves a whole list. */
export function skillUpdatesReader(): (name: string) => { repository?: SkillRepositoryView; update?: SkillUpdateView } {
	const entries = readEntries();
	const now = Date.now();
	return (name) => {
		const dir = path.join(agentSkillsDir(), name);
		const record = readSkillProvenance(dir);
		if (!record) return {};
		const repo = record.repository;
		if (!repo) return addedFromRepositoryBefore(record) ? { update: { state: "untracked" } } : {};
		const identity = bindableIdentity(dir);
		const entry = identity === undefined ? undefined : boundEntry(entries[name], identity, repo);
		const view = entry && entryView(entry);
		const repository: SkillRepositoryView = { address: shownRepositoryAddress(repo.address), ...(repo.ref ? { ref: repo.ref } : {}), refKind: repo.refKind, path: repo.path, commit: repo.commit, autoUpdate: record.autoUpdate === true, checkDue: repo.refKind !== "commit" && checkDue(entry, now) };
		if (repo.refKind === "commit") return { repository, update: { state: "pinned", ...(view?.updated ? { updated: view.updated } : {}) } };
		return { repository, ...(view ? { update: view } : {}) };
	};
}

function entryView(entry: SkillCheckEntry): SkillUpdateView {
	const updated = entry.updated && entry.updated.filesSha256 === entry.repository.filesSha256 ? entry.updated : undefined;
	return {
		state: entry.state,
		...(entry.checkedAt ? { checkedAt: entry.checkedAt } : {}),
		installedFilesSha256: entry.installedFilesSha256,
		...(entry.candidate ? { candidate: candidateView(entry.candidate) } : {}),
		...(entry.renamedTo ? { renamedTo: entry.renamedTo } : {}),
		...(entry.failure ? { failure: entry.failure } : {}),
		...(entry.missed?.failure ? { missed: entry.missed.failure } : {}),
		...(updated ? { updated: { at: updated.at, changes: updated.changes, versions: updated.versions, ...(updated.automatic ? { automatic: true as const } : {}), ...(updated.noticeClosed ? { noticeClosed: true as const } : {}) } } : {}),
		...(entry.autoSkipped && entry.candidate?.filesSha256 === entry.autoSkipped.filesSha256 ? { autoSkipped: entry.autoSkipped.noticeClosed ? { noticeClosed: true as const } : {} } : {}),
	};
}

// --- The check ---------------------------------------------------------------

/** One installed skill a check asks about, as it was when the check began. */
interface Tracked {
	name: string;
	dir: string;
	record: SkillProvenance;
	repository: SkillRepository;
	identity: string | null;
	installedFilesSha256: string | null;
}

type Outcome = Pick<SkillCheckEntry, "state" | "candidate" | "renamedTo" | "missingAt" | "failure">;

/** Who a check is for: the person who pressed Check now; the one who pressed Update; the page, by itself as it opens; or the daily pass. */
type CheckFor = "person" | "update" | "page" | "pass";

/** What each asks a repository with. Only a press may open a window; the page's own check uses no sign-in of the person's either. */
const ASKS: Record<CheckFor, RepoAskOptions> = {
	person: {},
	update: {},
	page: { askForDeveloperTools: false, signIns: false },
	pass: { askForDeveloperTools: false },
};

/** The failures the page's own check leaves to the person's: it asked for no sign-in and no tool. */
const ONLY_THE_PERSON: ReadonlySet<RepoReachReason> = new Set(["sign-in", "missing-tool"]);

/** How a check runs, on the pass's own clock for the pass. */
interface CheckOptions {
	allowLocal: boolean;
	/**
	 * Whom it is for (the person when absent). A repository that couldn't be asked
	 * is the result of the person's check; any other keeps the earlier result, and
	 * all but the pass's note that they missed it.
	 */
	for?: CheckFor;
	now?: () => Date;
	/** Fetches a moved ref even when the version there is the one already found: an update needs its files. */
	fetchKnown?: boolean;
	/** Another check took this one's place: it asks nothing more and stores nothing. */
	replaced?: () => boolean;
}

/** At most this many repositories are asked at once. */
const ASKED_AT_ONCE = 6;

/** Runs `run` over the items, at most `limit` at a time. */
async function forEachAtMost<T>(limit: number, items: readonly T[], run: (item: T) => Promise<void>): Promise<void> {
	const left = items.values();
	const worker = async () => {
		for (const item of left) await run(item);
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** A check's answer: when it ran, and each skill's result. */
interface SkillChecksAnswer {
	checkedAt: string;
	results: SkillCheckResult[];
}

// The library checks running now. Only the running check lives here: what it
// found is in the stored results, so a restart loses nothing but the check itself.
let pageCheck: Promise<SkillChecksAnswer> | null = null;
let personCheck: Promise<SkillChecksAnswer> | null = null;

/**
 * Checks the whole library. The page's own check asks only the skills whose
 * check is due; it joins whichever runs, and comes after a running daily pass,
 * which asks the same repositories. The person's asks all of them at once: it
 * joins another person's, and takes the place of one of the page's, which may
 * be waiting for a repository that doesn't answer.
 */
export function checkSkillLibrary(names: readonly string[], options: { allowLocal: boolean; for: "person" | "page" }): Promise<SkillChecksAnswer> {
	if (options.for === "page") {
		const running = pageCheck ?? personCheck;
		if (running) return running;
		const check: Promise<SkillChecksAnswer> = Promise.resolve(passInFlight)
			.catch(() => null)
			.then(() => {
				const updatesOf = skillUpdatesReader();
				return checkSkillUpdates(names.filter((name) => updatesOf(name).repository?.checkDue), { ...options, replaced: () => pageCheck !== check });
			})
			.finally(() => {
				if (pageCheck === check) pageCheck = null;
			});
		pageCheck = check;
		return check;
	}
	pageCheck = null;
	personCheck ??= checkSkillUpdates(names, options).finally(() => {
		personCheck = null;
	});
	return personCheck;
}

/**
 * Checks the given skills of the person's own library (names `skillDirs` resolves
 * to the user store, each already its folder's name) against their
 * repositories. A skill not added from a repository has no result; every failure
 * leaves each skill as it was. Results are stored, bound to each installation;
 * a version's first sight is kept while the same files are found, or while
 * the repository can't be asked.
 */
export async function checkSkillUpdates(names: readonly string[], options: CheckOptions): Promise<SkillChecksAnswer> {
	const checkedAt = (options.now?.() ?? new Date()).toISOString();
	const asker = options.for ?? "person";
	const results: SkillCheckResult[] = [];
	const groups = new Map<string, Tracked[]>();
	for (const name of names) {
		const dir = path.join(agentSkillsDir(), name);
		const record = readSkillProvenance(dir);
		const identity = bindableIdentity(dir);
		if (!record || identity === undefined) continue;
		const repository = record.repository;
		if (!repository) {
			if (addedFromRepositoryBefore(record)) results.push({ name, state: "untracked" });
			continue;
		}
		if (repository.refKind === "commit") {
			results.push({ name, state: "pinned" });
			continue;
		}
		const key = `${repository.address}#${repository.ref ?? ""}`;
		groups.set(key, [...(groups.get(key) ?? []), { name, dir, record, repository, identity, installedFilesSha256: installedSkillFilesSha256(dir) }]);
	}
	const outcomes = new Map<Tracked, Outcome>();
	await forEachAtMost(ASKED_AT_ONCE, [...groups.values()], (members) => checkRepository(members, options, outcomes));
	if (outcomes.size > 0 && !options.replaced?.()) changeEntries((entries) => {
		for (const [skill, outcome] of outcomes) {
			// A skill updated, replaced or deleted while the repository was asked is no longer the installation this result is about: what was stored for it since stays.
			if (!stillInstalled(skill)) continue;
			const previous = entries[skill.name];
			const ours = previous?.identity === skill.identity ? previous : undefined;
			const earlier = boundEntry(previous, skill.identity, skill.repository);
			if (outcome.state === "unreachable" && asker !== "person") {
				if (asker !== "pass") entries[skill.name] = missedEntry(earlier, skill, outcome, asker, checkedAt);
				results.push({ name: skill.name, state: "unreachable", ...(outcome.failure ? { failure: outcome.failure } : {}) });
				continue;
			}
			const updated = ours?.updated && ours.updated.filesSha256 === skill.repository.filesSha256 ? ours.updated : undefined;
			// The same version found again, or no answer at all, keeps when it was first seen and whether the pass left it.
			const sameVersion = <T extends { filesSha256: string }>(kept: T | undefined): T | undefined => (kept && (outcome.state === "unreachable" || kept.filesSha256 === outcome.candidate?.filesSha256) ? kept : undefined);
			const firstSeen = sameVersion(ours?.firstSeen) ?? (outcome.candidate ? { filesSha256: outcome.candidate.filesSha256, at: checkedAt } : undefined);
			const autoSkipped = sameVersion(ours?.autoSkipped);
			// Only an answer moves the time: a check nothing answered is no "Last checked".
			const when: Pick<SkillCheckEntry, "checkedAt" | "missed"> = outcome.state === "unreachable" ? { ...(earlier?.checkedAt ? { checkedAt: earlier.checkedAt } : {}), missed: { at: checkedAt } } : { checkedAt };
			const entry: SkillCheckEntry = { ...outcome, ...when, identity: skill.identity, repository: skill.repository, installedFilesSha256: skill.installedFilesSha256, ...(updated ? { updated } : {}), ...(firstSeen ? { firstSeen } : {}), ...(autoSkipped ? { autoSkipped } : {}) };
			entries[skill.name] = entry;
			results.push({ name: skill.name, ...entryView(entry) });
		}
	});
	return { checkedAt, results: results.sort((a, b) => a.name.localeCompare(b.name)) };
}

/** The stored result after a check that couldn't ask the skill's repository: the earlier one as it was, or none yet, with when it was missed and, where the person can read something into it, why. */
function missedEntry(earlier: SkillCheckEntry | undefined, skill: Tracked, outcome: Outcome, asker: CheckFor, at: string): SkillCheckEntry {
	const failure = asker === "page" && outcome.failure && ONLY_THE_PERSON.has(outcome.failure.reason) ? undefined : outcome.failure;
	const result: SkillCheckEntry = earlier ?? { state: "unreachable", identity: skill.identity, repository: skill.repository, installedFilesSha256: skill.installedFilesSha256 };
	return { ...result, missed: { at, ...(failure ? { failure } : {}) } };
}

/** The installation a check began with is still the one in the store: the same identity and the same record's repository. */
function stillInstalled(skill: Tracked): boolean {
	const identity = bindableIdentity(skill.dir);
	return identity !== undefined && identity === skill.identity && sameRepository(readSkillProvenance(skill.dir)?.repository, skill.repository);
}

/** One repository and ref: its ref asked once, fetched only when it moved to a version not found before, then each of its skills compared. */
async function checkRepository(members: Tracked[], options: CheckOptions, outcomes: Map<Tracked, Outcome>): Promise<void> {
	const all = (outcome: Outcome) => {
		for (const member of members) outcomes.set(member, outcome);
	};
	const replaced = () => options.replaced?.() === true;
	if (replaced()) return;
	const { address, ref, refKind } = members[0].repository;
	const resolved = resolveRepoSource(ref ? `${address}#${ref}` : address, { allowLocal: options.allowLocal, recorded: true });
	if (!resolved.ok) return all({ state: "unreachable", failure: { reason: "failed", message: resolved.error } });
	const asks = ASKS[options.for ?? "person"];
	const failureOf = (err: unknown): SkillCheckFailure => ({ ...(resolved.value.host ? { host: resolved.value.host } : {}), ...repoFailureOf(err) });
	let remote: string | null;
	try {
		remote = refCommit(await listRemoteRefs(resolved.value, asks), refKind, ref);
	} catch (err) {
		return all({ state: "unreachable", failure: failureOf(err) });
	}
	if (replaced()) return;
	if (!remote) return all({ state: "gone" });
	const moved = members.filter((member) => member.repository.commit !== remote);
	for (const member of members) if (!moved.includes(member)) outcomes.set(member, { state: "current" });
	if (moved.length === 0) return;
	if (!options.fetchKnown) {
		const entries = readEntries();
		const found = moved.map((member) => knownOutcome(member, entries[member.name], remote));
		if (found.every((outcome) => outcome !== null)) {
			moved.forEach((member, at) => outcomes.set(member, found[at]!));
			return;
		}
	}
	let checkout: RepoCheckout;
	try {
		checkout = await fetchRepoCheckout(resolved.value, undefined, {}, asks);
	} catch (err) {
		for (const member of moved) outcomes.set(member, { state: "unreachable", failure: failureOf(err) });
		return;
	}
	if (replaced()) {
		fs.rmSync(checkout.dir, { recursive: true, force: true });
		return;
	}
	if (!checkout.origin) {
		fs.rmSync(checkout.dir, { recursive: true, force: true });
		for (const member of moved) outcomes.set(member, { state: "unreachable", failure: failureOf(new Error("could not tell which version of the repository was fetched")) });
		return;
	}
	const origin = checkout.origin;
	const found = scanRepoSkills(checkout.dir, resolved.value.display);
	const available: SkillUpdateCandidate[] = [];
	for (const member of moved) {
		const outcome = compare(member, { dir: checkout.dir, origin }, found);
		outcomes.set(member, outcome);
		if (outcome.candidate) available.push(outcome.candidate);
	}
	if (available.length === 0) {
		fs.rmSync(checkout.dir, { recursive: true, force: true });
		return;
	}
	const token = registerCheckout(checkout.dir, resolved.value.display, checkout.origin);
	for (const candidate of available) candidate.token = token;
}

/** What an earlier check found at this very commit for this very installation, so nothing is fetched again; null when it has to be looked at. */
function knownOutcome(member: Tracked, stored: SkillCheckEntry | undefined, remote: string): Outcome | null {
	const entry = boundEntry(stored, member.identity, member.repository);
	if (entry && (entry.state === "gone" || entry.state === "renamed")) {
		return entry.missingAt === remote ? { state: entry.state, missingAt: remote, ...(entry.renamedTo ? { renamedTo: entry.renamedTo } : {}) } : null;
	}
	if (entry?.state !== "available" || entry.candidate?.commit !== remote) return null;
	if (member.installedFilesSha256 === null || entry.installedFilesSha256 !== member.installedFilesSha256) return null;
	return { state: "available", candidate: entry.candidate };
}

/**
 * Where a skill is in a checkout, by the name the library keeps it under (its
 * folder, a written name fitted): its stored folder when the SKILL.md there
 * fits onto that name; else the one SKILL.md that does elsewhere (a moved
 * folder); else renamed, with its written name, when its folder holds a skill of
 * another; else gone.
 */
function locate(name: string, storedPath: string, found: ReturnType<typeof scanRepoSkills>): { path: string } | { renamedTo: string } | null {
	const atPath = found.find((skill) => skill.path === storedPath);
	if (atPath?.id === name) return { path: storedPath };
	const sameName = found.filter((skill) => skill.id === name);
	if (sameName.length === 1) return { path: sameName[0].path };
	return atPath ? { renamedTo: atPath.name } : null;
}

/** One skill against a fetched checkout of its moved ref. The same files store the new commit quietly. */
function compare(member: Tracked, checkout: Required<RepoCheckout>, found: ReturnType<typeof scanRepoSkills>): Outcome {
	const where = locate(member.name, member.repository.path, found);
	const missingAt = checkout.origin.commit;
	if (!where) return { state: "gone", missingAt };
	if ("renamedTo" in where) return { state: "renamed", renamedTo: where.renamedTo, missingAt };
	const next = repoSkillFiles(checkout.dir, where.path);
	if (!next) return { state: "gone", missingAt };
	const filesSha256 = skillFilesSha256(next.dir, next.files);
	if (filesSha256 === member.repository.filesSha256) {
		storeQuietly(member, { ...member.repository, path: where.path, commit: checkout.origin.commit });
		return { state: "current" };
	}
	const installedFiles = listSkillFiles(member.dir) ?? [];
	const manifest = fs.readFileSync(path.join(next.dir, "SKILL.md"), "utf-8");
	const { fm, body } = parseSkillFrontmatter(manifest);
	const findings = scanInvisibleUnicode(`${body.trim()}\n${(fm.description || "").trim()}`).findings;
	let installedManifest = "";
	try {
		installedManifest = readSkillFileText(member.dir, "SKILL.md");
	} catch {}
	return {
		state: "available",
		candidate: {
			token: "",
			commit: checkout.origin.commit,
			path: where.path,
			filesSha256,
			changes: fileChanges({ dir: member.dir, files: installedFiles, scripts: scriptFiles(member.dir, installedFiles) }, { ...next, scripts: scriptFiles(next.dir, next.files) }),
			versions: { from: installedManifest ? skillVersion(installedManifest) : null, to: skillVersion(manifest) },
			scanFindings: findings,
			hiddenCharacters: findings.length > 0,
			...(findings.length > 0 ? { body: body.trim(), description: (fm.description || "").trim() } : {}),
			changedHere: member.installedFilesSha256 !== member.repository.filesSha256,
		},
	};
}

/** The files added, removed and changed from the installed folder to the new one, by path. */
function fileChanges(from: SkillFilesAt, to: SkillFilesAt): SkillUpdateChanges {
	const { dir: fromDir, files: fromFiles } = from;
	const { dir: toDir, files: toFiles } = to;
	const before = new Set(fromFiles);
	const after = new Set(toFiles);
	// A file that only gains or loses its run mark is a change the review lists: the
	// update installs the new mark. Both sides read a mark by one rule (`keepsRunMark`),
	// so a picture stored with the mark before that rule is no change. An update whose
	// only change is a mark isn't found at all, since the files' fingerprint is their bytes.
	const differs = (file: string) => {
		if ((from.scripts.get(file) === true) !== (to.scripts.get(file) === true)) return true;
		try {
			return !fs.readFileSync(path.join(fromDir, file)).equals(fs.readFileSync(path.join(toDir, file)));
		} catch {
			return true;
		}
	};
	// A file is listed as a script by the side it comes from (`scriptFiles`).
	return {
		added: skillFileList(toFiles.filter((file) => !before.has(file)), to.scripts),
		// A file a system wrote here by itself is no removal. One the repository ships is installed, so it is listed.
		removed: skillFileList(fromFiles.filter((file) => !after.has(file) && !isSystemFile(file)), from.scripts),
		changed: skillFileList(toFiles.filter((file) => before.has(file) && differs(file)), to.scripts),
	};
}

/** A skill's files in a folder, with its scripts. */
interface SkillFilesAt {
	dir: string;
	files: readonly string[];
	scripts: SkillScripts;
}

/** The record takes the new commit (and a moved folder) of files it already has, unless the installation changed since the check began. */
function storeQuietly(member: Tracked, repository: SkillRepository): void {
	const record = readSkillProvenance(member.dir);
	if (!record || bindableIdentity(member.dir) !== member.identity || !sameRepository(record.repository, member.repository)) return;
	writeSkillProvenance(member.dir, { ...record, repository });
	member.repository = repository;
}

// --- The update --------------------------------------------------------------

/** What Update sends: the id of the version it was shown, the installed files' hash it was shown with, and the person's yes to either stop. */
export interface SkillUpdateRequest {
	candidate: string;
	installedFilesSha256: string;
	confirm?: { hiddenCharacters?: boolean; replaceMyChanges?: boolean };
}

/** Why an update was refused; the page words each code. */
export type SkillUpdateRefusal =
	| { status: 409; code: "no-update" | "skill-renamed-upstream" | "skill-changed-since-check" | "candidate-expired" | "skill-update-hidden-characters" | "skill-changed-here" | "auto-update-off"; error: string }
	| { status: 502; code: typeof SKILL_UPDATE_NOT_FETCHED; failure: SkillCheckFailure; error: string }
	| { status: 413; refusal: SkillTooBig }
	| { status: 500 | 502; error: string };

export type SkillUpdateOutcome = { ok: true } | ({ ok: false } & SkillUpdateRefusal);

interface UpdateOptions {
	allowLocal: boolean;
	/** The pass's: the skill's switch must still be on, and the update is stored as the pass's. */
	automatic?: boolean;
	now?: () => Date;
	/** The server's stop: nothing is swapped in after it. */
	stopped?: () => boolean;
}

/**
 * Update in one press: `swapIn`, and where the version it names is no longer
 * held, its repository fetched again first. The same request is then tried once
 * more, with every one of its checks, so it goes on only when the version found
 * now is the one it named; another one is stored as found and refused.
 */
export async function updateSkill(id: string, request: SkillUpdateRequest, options: UpdateOptions): Promise<SkillUpdateOutcome> {
	const outcome = swapIn(id, request, options);
	if (outcome.ok || !("code" in outcome) || outcome.code !== "candidate-expired") return outcome;
	const { results } = await checkSkillUpdates(sameRepositoryNames(id), { allowLocal: options.allowLocal, for: options.automatic ? "pass" : "update", now: options.now, fetchKnown: true });
	if (options.stopped?.()) return outcome;
	const failure = results.find((result) => result.name === id)?.failure;
	if (failure) return { ok: false, status: 502, code: SKILL_UPDATE_NOT_FETCHED, failure, error: "the new version could not be fetched again" };
	return swapIn(id, request, options);
}

/** The skill and the others of its repository and ref, which one fetch serves. */
function sameRepositoryNames(id: string): string[] {
	const own = readSkillProvenance(path.join(agentSkillsDir(), id))?.repository;
	return repositorySkills()
		.filter(({ name, record }) => name === id || (record.repository.address === own?.address && (record.repository.ref ?? null) === (own.ref ?? null)))
		.map(({ name }) => name);
}

/**
 * Swaps in the version a check found for the user skill `id`, keeping its
 * identity, so every room that has it on keeps it on, and stores the new commit
 * and files' hash. Synchronous from the first check to the swap: the stored
 * result, the held checkout, the installation it is bound to (identity, record,
 * installed files) and the two stops are all checked in the same step as the
 * swap, and any refusal writes nothing.
 */
function swapIn(id: string, request: SkillUpdateRequest, options: UpdateOptions): SkillUpdateOutcome {
	const dir = path.join(agentSkillsDir(), id);
	const entry = readEntries()[id];
	if (entry?.state === "renamed") return { ok: false, status: 409, code: "skill-renamed-upstream", error: "its repository has this skill under another name" };
	if (entry?.state !== "available" || !entry.candidate) return { ok: false, status: 409, code: "no-update", error: "there is no update for this skill" };
	const candidate = entry.candidate;
	const changedSinceCheck = { ok: false as const, status: 409 as const, code: "skill-changed-since-check" as const, error: "the skill changed since the check" };
	// The installation the check found: the same identity and the same repository in its record (an upload's Replace keeps none).
	const record = readSkillProvenance(dir);
	const identity = bindableIdentity(dir);
	if (!record?.repository || request.candidate !== candidateId(candidate) || identity === undefined || !bound(entry, identity, record.repository)) return changedSinceCheck;
	if (options.automatic && record.autoUpdate !== true) return { ok: false, status: 409, code: "auto-update-off", error: "the skill's Update automatically is off" };
	const installed = installedSkillFilesSha256(dir);
	if (installed === null || installed !== entry.installedFilesSha256 || request.installedFilesSha256 !== installed) return changedSinceCheck;
	if (candidate.hiddenCharacters && request.confirm?.hiddenCharacters !== true) return { ok: false, status: 409, code: "skill-update-hidden-characters", error: "the new version has hidden characters" };
	if (candidate.changedHere && request.confirm?.replaceMyChanges !== true) return { ok: false, status: 409, code: "skill-changed-here", error: "the skill was changed on this computer" };
	const checkout = getCheckout(candidate.token);
	if (!checkout?.origin) return { ok: false, status: 409, code: "candidate-expired", error: "the update is no longer held" };
	// A held checkout that can't be read is dropped, so the next press fetches it again.
	const unreadable = () => {
		removeCheckout(candidate.token);
		return { ok: false as const, status: 502 as const, error: "the new version can no longer be read" };
	};
	const next = repoSkillFiles(checkout.dir, candidate.path);
	if (!next) return unreadable();
	if (next.tooBig) return { ok: false, status: 413, refusal: next.tooBig };
	const repository: SkillRepository = { ...record.repository, path: candidate.path, commit: candidate.commit, filesSha256: candidate.filesSha256 };
	try {
		replaceSkillDir(id, (fresh) => {
			const vendored = vendorRepoSkill(checkout.dir, candidate.path, fresh);
			// The held checkout is the one the check measured; what landed is checked all the same.
			if (skillFilesSha256(fresh, next.files) !== candidate.filesSha256) throw new UpdateUnreadable();
			const manifest = readSkillFileText(fresh, "SKILL.md");
			writeSkillProvenance(fresh, { ...record, license: vendored.license ?? record.license, sha256: sha256(manifest), repository, ...(identity ? { identity } : {}) });
		});
	} catch (error) {
		if (error instanceof SkillTooBigError) return { ok: false, status: 413, refusal: error.refusal };
		if (error instanceof UpdateUnreadable || (error instanceof Error && error.message === "skill not found in checkout")) return unreadable();
		console.warn(`[skills] updating ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
		return { ok: false, status: 500, error: SKILL_UPDATE_FAILED_LINE };
	}
	// The swap is done and the record names the new version: a result that can't be
	// stored only costs the page what changed, so the update stands.
	try {
		changeEntries((entries) => {
			entries[id] = {
				state: "current",
				...(entry.checkedAt ? { checkedAt: entry.checkedAt } : {}),
				identity,
				repository,
				installedFilesSha256: candidate.filesSha256,
				updated: { at: new Date().toISOString(), changes: candidate.changes, versions: candidate.versions, filesSha256: candidate.filesSha256, ...(options.automatic ? { automatic: true as const } : {}) },
			};
		});
	} catch (error) {
		console.warn(`[skills] ${id} was updated, but what changed could not be stored: ${error instanceof Error ? error.message : String(error)}`);
	}
	return { ok: true };
}

/** The new version's files are not the ones the check measured. */
class UpdateUnreadable extends Error {}

// --- The daily pass: a look at every skill, and Update automatically ---------

/** A version is taken once a check first saw it this long ago, as one editor holds back its own updates: a bad version pulled within the hold is never installed. */
const AUTO_UPDATE_HOLD_MS = 12 * 60 * 60_000;
/** The first pass comes a random 2 to 10 minutes after the start, then one a day. */
const FIRST_PASS_MIN_MS = 2 * 60_000;
const FIRST_PASS_SPREAD_MS = 8 * 60_000;
const PASS_INTERVAL_MS = 24 * 60 * 60_000;

/** Where the pass says what it did: the server's log. Lines name skills and reasons, never an address. */
export interface SkillAutoUpdateLogger {
	info: (line: string) => void;
	warn: (line: string) => void;
}

/** What one pass did, by skill name: updated; left for the person; waiting for the 12 hours; or couldn't ask or update. A skill only looked at is in none, unless its repository couldn't be asked. */
export interface SkillAutoUpdatePassResult {
	updated: string[];
	skipped: string[];
	waiting: string[];
	failed: string[];
}

/** The person's skills that follow a branch or a tag of their repository, with their records, by name. */
function repositorySkills(): { name: string; record: SkillProvenance & { repository: SkillRepository } }[] {
	let names: string[];
	try {
		names = fs.readdirSync(agentSkillsDir());
	} catch {
		return [];
	}
	return names.filter(isSkillId).sort().flatMap((name) => {
		const record = readSkillProvenance(path.join(agentSkillsDir(), name));
		return record?.repository && record.repository.refKind !== "commit" ? [{ name, record: { ...record, repository: record.repository } }] : [];
	});
}

// The pass running now, which a second call joins. Only the running pass lives
// here: what it found and did is in the stored results, so a restart loses
// nothing but the pass itself.
let passInFlight: Promise<SkillAutoUpdatePassResult> | null = null;

/**
 * One daily pass: the check for every skill that follows a branch or a tag;
 * then, for those whose Update automatically is on, for each version a check
 * first saw at least 12 hours ago the same Update one click makes, never with
 * a yes. A new version with hidden
 * characters, or a skill changed on this computer, is left for the person and
 * named for the notice, once per version. A repository that couldn't be asked
 * leaves the skill and its earlier result as they were. On a shared server it
 * does nothing. A call while a pass runs joins it.
 */
export function runSkillAutoUpdatePass(options: { now?: () => Date; logger?: SkillAutoUpdateLogger; stopped?: () => boolean } = {}): Promise<SkillAutoUpdatePassResult> {
	if (isSharedServer()) return Promise.resolve({ updated: [], skipped: [], waiting: [], failed: [] });
	passInFlight ??= autoUpdatePass(options).finally(() => {
		passInFlight = null;
	});
	return passInFlight;
}

async function autoUpdatePass({ now = () => new Date(), logger = console, stopped = () => false }: { now?: () => Date; logger?: SkillAutoUpdateLogger; stopped?: () => boolean }): Promise<SkillAutoUpdatePassResult> {
	const done: SkillAutoUpdatePassResult = { updated: [], skipped: [], waiting: [], failed: [] };
	const names = repositorySkills().map(({ name }) => name);
	if (names.length === 0) return done;
	const { results } = await checkSkillUpdates(names, { allowLocal: SKILLS_ALLOW_LOCAL_REPO, for: "pass", now });
	const at = now();
	for (const result of results) {
		const name = result.name;
		if (result.state === "unreachable") {
			done.failed.push(name);
			logger.warn(`skills: couldn't ask the repository of “${name}” for a new version (${result.failure?.reason ?? "failed"}); it stays as it is`);
			continue;
		}
		// Only looked at: what the check found is stored, for its row to show.
		if (readSkillProvenance(path.join(agentSkillsDir(), name))?.autoUpdate !== true) continue;
		const entry = readEntries()[name];
		const candidate = result.state === "available" ? entry?.candidate : undefined;
		if (!entry || !candidate) continue;
		if (candidate.hiddenCharacters || candidate.changedHere) {
			done.skipped.push(name);
			if (entry.autoSkipped?.filesSha256 !== candidate.filesSha256) leftForThePerson(name, candidate.filesSha256, at);
			logger.info(`skills: “${name}” has a new version that waits for the person's own Update (${candidate.hiddenCharacters ? "hidden characters" : "changed on this computer"})`);
			continue;
		}
		const firstSeen = entry.firstSeen?.filesSha256 === candidate.filesSha256 ? Date.parse(entry.firstSeen.at) : Number.NaN;
		if (Number.isNaN(firstSeen) || at.getTime() - firstSeen < AUTO_UPDATE_HOLD_MS) {
			done.waiting.push(name);
			continue;
		}
		// The server's stop ends the pass before its next swap.
		if (stopped()) break;
		const outcome = await updateSkill(name, { candidate: candidateId(candidate), installedFilesSha256: entry.installedFilesSha256 ?? "" }, { allowLocal: SKILLS_ALLOW_LOCAL_REPO, automatic: true, now, stopped });
		if (!outcome.ok && stopped()) break;
		if (outcome.ok) {
			done.updated.push(name);
			logger.info(`skills: updated “${name}” from its repository automatically`);
		} else {
			done.failed.push(name);
			logger.warn(`skills: couldn't update “${name}” automatically (${"code" in outcome ? outcome.code : outcome.status}); it stays as it is`);
		}
	}
	return done;
}

/** Names the version with these files as left for the person, while it is still the one found. */
function leftForThePerson(name: string, filesSha256: string, at: Date): void {
	changeEntries((entries) => {
		const entry = Object.hasOwn(entries, name) ? entries[name] : undefined;
		if (entry?.candidate?.filesSha256 === filesSha256) entry.autoSkipped = { filesSha256, at: at.toISOString() };
	});
}

/** The timers a start arms: the system's, or a smoke's own. */
export interface SkillAutoUpdateTimers {
	set: (run: () => void, ms: number) => unknown;
	clear: (handle: unknown) => void;
}

const systemTimers: SkillAutoUpdateTimers = {
	set: (run, ms) => setTimeout(run, ms).unref(),
	clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Arms the daily pass after the server listens: the first pass a random 2
 * to 10 minutes from now, each next one 24 hours after the last ends, so two
 * never run at once. `stop` clears what is armed and ends a running pass before
 * its next swap. On a shared server it arms nothing.
 */
export function startSkillAutoUpdates(options: { logger?: SkillAutoUpdateLogger; random?: () => number; timers?: SkillAutoUpdateTimers } = {}): { stop: () => void; isRunning: () => boolean } {
	const { logger = console, random = Math.random, timers = systemTimers } = options;
	if (isSharedServer()) return { stop: () => {}, isRunning: () => false };
	let stopped = false;
	let running = false;
	let armed: unknown = null;
	const run = (): void => {
		armed = null;
		if (stopped) return;
		running = true;
		void runSkillAutoUpdatePass({ logger, stopped: () => stopped })
			.catch((error: unknown) => logger.warn(`skills: the daily update pass stopped (${(error as NodeJS.ErrnoException)?.code ?? "error"}); every skill stays as it is`))
			.finally(() => {
				running = false;
				if (!stopped) armed = timers.set(run, PASS_INTERVAL_MS);
			});
	};
	armed = timers.set(run, FIRST_PASS_MIN_MS + Math.floor(random() * FIRST_PASS_SPREAD_MS));
	return {
		stop() {
			stopped = true;
			if (armed !== null) timers.clear(armed);
			armed = null;
		},
		isRunning: () => running,
	};
}

/** What a notice showed of one skill: the pass's update made at `updatedAt`, and the version with `skippedVersion`'s files it left for the person. */
export interface SkillNoticeShown {
	name: string;
	updatedAt?: string;
	skippedVersion?: string;
}

/**
 * Closes the notice for what it showed: a skill's update by the pass only when it
 * is still the one made at that time, a version left for the person only when it
 * is still that version, so one that came after the notice showed stays named.
 * Anything no longer there is passed over.
 */
export function closeSkillUpdateNotices(shown: readonly SkillNoticeShown[]): void {
	changeEntries((entries) => {
		for (const { name, updatedAt, skippedVersion } of shown) {
			const entry = Object.hasOwn(entries, name) ? entries[name] : undefined;
			if (entry?.updated?.automatic && updatedAt !== undefined && entry.updated.at === updatedAt) entry.updated.noticeClosed = true;
			if (entry?.autoSkipped && skippedVersion !== undefined && entry.autoSkipped.filesSha256 === skippedVersion) entry.autoSkipped.noticeClosed = true;
		}
	});
}

/**
 * Turns a skill's Update automatically on or off, in its record: only for a
 * skill that follows a branch or a tag of its repository. Off takes the field
 * away, as a skill that never had it.
 */
export function setSkillAutoUpdate(id: string, on: boolean): "saved" | "unavailable" {
	const dir = path.join(agentSkillsDir(), id);
	const record = readSkillProvenance(dir);
	if (!record?.repository || record.repository.refKind === "commit") return "unavailable";
	const { autoUpdate: _was, ...rest } = record;
	writeSkillProvenance(dir, on ? { ...rest, autoUpdate: true } : rest);
	return "saved";
}
