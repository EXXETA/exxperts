import { sha256 } from "./skills-store.js";
import type { EnabledSkillSource, PersistentRoomSkillSettings } from "./persistent-room-skill-settings.js";
import type { LibraryMaterialsManifest } from "./skills-library-materials.js";

/** Changes to each room's own pins, including excluded source skills and independent owners. */
export function describeRoomLibraryChanges(settings: PersistentRoomSkillSettings, current: EnabledSkillSource, previousMaterials: LibraryMaterialsManifest | null, materials: LibraryMaterialsManifest) {
	const source = settings.enabledSources?.find((entry) => entry.libraryId === current.libraryId);
	const independent = settings.enabledSkills.filter((old) => current.skills.some((pin) => pin.name === old.name));
	const names = new Set([...(source?.skills.map((pin) => pin.name) ?? []), ...independent.map((pin) => pin.name), ...(source ? current.skills.map((pin) => pin.name) : [])]);
	const skills = [...names].sort().flatMap((name) => {
		const before = [...(source?.skills.filter((pin) => pin.name === name) ?? []), ...independent.filter((pin) => pin.name === name)];
		const after = current.skills.find((pin) => pin.name === name);
		if (after && before.length && before.every((pin) => pin.sha256 === after.sha256 && pin.packageSha256 === after.packageSha256)) return [];
		return [{ name, status: !after ? "removed" as const : !before.length ? "added" as const : "changed" as const, instructionsChanged: Boolean(after && before.some((pin) => pin.sha256 !== after.sha256)), enabled: Boolean(after && (independent.some((pin) => pin.name === name) || (source?.skills.some((pin) => pin.name === name) && !source.excludedSkills.includes(name)))) }];
	});
	const beforeFiles = new Map(previousMaterials?.files.map((file) => [file.path, file]));
	const afterFiles = new Map(materials.files.map((file) => [file.path, file]));
	const references = source ? [...new Set([...beforeFiles.keys(), ...afterFiles.keys()])].sort().flatMap((path) => {
		const before = beforeFiles.get(path);
		const after = afterFiles.get(path);
		if (before && after && before.sha256 === after.sha256 && before.kind === after.kind && before.size === after.size && before.mimeType === after.mimeType) return [];
		return [{ path, status: !previousMaterials ? "review" as const : !before ? "added" as const : !after ? "removed" as const : "changed" as const, ...(before ? { beforeVersion: source.materialsSha256 } : {}), ...(after ? { afterVersion: materials.materialsSha256 } : {}) }];
	}) : [];
	const referenceVersionChanged = Boolean(source && source.materialsSha256 !== current.materialsSha256 && !references.length);
	return { skills, references, referenceVersionChanged, previousReferencesUnavailable: Boolean(source && !previousMaterials), total: skills.length + references.length + Number(referenceVersionChanged) };
}

export interface LibraryRoomUpdate {
	id: string;
	name: string;
	settings: PersistentRoomSkillSettings;
	busy: boolean;
}

/** Display comparison only; the apply route rechecks the real packages and room grants. */
export function roomNeedsLibraryUpdate(settings: PersistentRoomSkillSettings, current: EnabledSkillSource): boolean {
	const source = settings.enabledSources?.find((entry) => entry.libraryId === current.libraryId);
	if (source && (source.materialsSha256 !== current.materialsSha256 || source.skills.length !== current.skills.length || source.skills.some((old) => !current.skills.some((pin) => pin.name === old.name && pin.sha256 === old.sha256 && pin.packageSha256 === old.packageSha256)))) return true;
	return settings.enabledSkills.some((old) => current.skills.some((pin) => pin.name === old.name && (pin.sha256 !== old.sha256 || pin.packageSha256 !== old.packageSha256)));
}

export function libraryRoomsReviewHash(source: EnabledSkillSource, rooms: LibraryRoomUpdate[]): string {
	return sha256(JSON.stringify({ source, rooms: rooms.map(({ id, settings }) => ({ id, settings })).sort((a, b) => a.id.localeCompare(b.id)) }));
}
