import path from "node:path";

import { atOrInside, localPath } from "./box-request.js";

const win = path.win32;

/**
 * Asks Windows where the person's own folders are: its known folders, the
 * shell's Downloads with the setting behind it, and every OneDrive folder from
 * its variables and its accounts; and where the places no yes may open are
 * (`windows-places.ts`): AppData's, Startup, her own programs, Program Files,
 * ProgramData and Windows. Only the places are read, never what is in
 * them. Run in Windows PowerShell 5.1 outside the box, with no network. The
 * answer is one line of ASCII JSON, with `\u` escapes, so a folder name in any
 * language survives the pipe.
 */
export const FOLDERS_SCRIPT = `$ErrorActionPreference = 'SilentlyContinue'
$f = [ordered]@{}
function place([string]$Name, [scriptblock]$Get) {
  $p = ''
  try { $p = [string](& $Get) } catch { $p = '' }
  $f[$Name] = $p
}
place 'profile' { [Environment]::GetFolderPath('UserProfile') }
place 'documents' { [Environment]::GetFolderPath('MyDocuments') }
place 'desktop' { [Environment]::GetFolderPath('DesktopDirectory') }
place 'downloads' {
  $d = ''
  try { $d = (New-Object -ComObject Shell.Application).NameSpace('shell:Downloads').Self.Path } catch { $d = '' }
  if (-not $d) {
    $v = (Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders').'{374DE290-123F-4565-9164-39C4925E467B}'
    if ($v) { $d = [Environment]::ExpandEnvironmentVariables($v) }
  }
  $d
}
place 'pictures' { [Environment]::GetFolderPath('MyPictures') }
place 'music' { [Environment]::GetFolderPath('MyMusic') }
place 'videos' { [Environment]::GetFolderPath('MyVideos') }
place 'favorites' { [Environment]::GetFolderPath('Favorites') }
place 'roaming' { [Environment]::GetFolderPath('ApplicationData') }
place 'local' { [Environment]::GetFolderPath('LocalApplicationData') }
place 'locallow' { (New-Object -ComObject Shell.Application).NameSpace('shell:LocalAppDataLow').Self.Path }
place 'startup' { [Environment]::GetFolderPath('Startup') }
place 'programs' { (New-Object -ComObject Shell.Application).NameSpace('shell:UserProgramFiles').Self.Path }
place 'programfiles' { [Environment]::GetFolderPath('ProgramFiles') }
place 'programfilesx86' { [Environment]::GetFolderPath('ProgramFilesX86') }
place 'programdata' { [Environment]::GetFolderPath('CommonApplicationData') }
place 'windows' { [Environment]::GetFolderPath('Windows') }
$od = @()
foreach ($v in @($env:OneDrive, $env:OneDriveConsumer, $env:OneDriveCommercial)) { if ($v) { $od += [string]$v } }
try {
  Get-ChildItem -Path 'HKCU:\\Software\\Microsoft\\OneDrive\\Accounts' -ErrorAction Stop | ForEach-Object {
    $u = (Get-ItemProperty -LiteralPath $_.PSPath).UserFolder
    if ($u) { $od += [string]$u }
  }
} catch { }
$f['onedrive'] = $od
$json = $f | ConvertTo-Json -Compress
$out = New-Object System.Text.StringBuilder
foreach ($ch in $json.ToCharArray()) {
  if ([int]$ch -gt 127) { [void]$out.Append('\\u' + ([int]$ch).ToString('x4')) } else { [void]$out.Append($ch) }
}
$out.ToString()
`;

/** The folders asked of Windows, in this order, with where each usually is in the profile. `.ssh` is the one Windows names no folder for. */
const KNOWN = [
	["documents", "Documents", ["Documents"]],
	["desktop", "Desktop", ["Desktop"]],
	["downloads", "Downloads", ["Downloads"]],
	["pictures", "Pictures", ["Pictures"]],
	["music", "Music", ["Music"]],
	["videos", "Videos", ["Videos"]],
	["favorites", "Favorites", ["Favorites"]],
	["ssh", ".ssh", [".ssh"]],
	["roaming", "AppData\\Roaming", ["AppData", "Roaming"]],
] as const;

/** What a folder's real path is, as the box answers it; `undefined` when nothing is there. */
export type ResolveFolder = (place: string) => { real: string; folder: boolean } | undefined;

export type FolderLeftOut = "on-the-network" | "missing" | "not-a-folder" | "the-profile" | "same-as-another";

export interface PersonalFolders {
	profile: string;
	/** Each found folder by its real path, in the order above, then each OneDrive. */
	found: { key: string; label: string; path: string }[];
	/** The folders that are not shut, and why. */
	leftOut: { key: string; label: string; why: FolderLeftOut }[];
}

export type FoldersAnswer = { ok: true; folders: PersonalFolders } | { ok: false; why: "unreadable" | "no-profile" };

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/**
 * The person's own folders from Windows' answer to `FOLDERS_SCRIPT`. A folder
 * Windows doesn't name is looked for in its usual place in the profile. A path
 * that isn't a full local path, such as a Documents redirected to a share, is
 * never resolved, so nothing dials it, and is left out: no request carries it.
 * A folder redirected off the profile, such as Documents on `D:\Docs`, is still
 * one of hers, and found.
 */
export function readPersonalFolders(answer: string, resolve: ResolveFolder): FoldersAnswer {
	let told: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(answer);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, why: "unreadable" };
		told = parsed as Record<string, unknown>;
	} catch {
		return { ok: false, why: "unreadable" };
	}
	const givenProfile = localPath(text(told.profile));
	const profileReal = givenProfile === undefined ? undefined : resolve(givenProfile);
	const profile = profileReal?.folder ? localPath(profileReal.real) : undefined;
	if (profile === undefined) return { ok: false, why: "no-profile" };

	const folders: PersonalFolders = { profile, found: [], leftOut: [] };
	const consider = (key: string, label: string, given: string) => {
		const leave = (why: FolderLeftOut) => folders.leftOut.push({ key, label, why });
		const place = localPath(given);
		if (place === undefined) return leave("on-the-network");
		const resolved = resolve(place);
		if (resolved === undefined) return leave("missing");
		if (!resolved.folder) return leave("not-a-folder");
		const real = localPath(resolved.real);
		if (real === undefined) return leave("on-the-network");
		if (atOrInside(profile, real)) return leave("the-profile");
		if (folders.found.some((other) => atOrInside(real, other.path) && atOrInside(other.path, real))) return leave("same-as-another");
		folders.found.push({ key, label, path: real });
	};
	for (const [key, label, usual] of KNOWN) {
		const given = key === "ssh" ? "" : text(told[key]);
		consider(key, label, given || win.join(profile, ...usual));
	}
	const oneDrives = ([] as unknown[]).concat(told.onedrive ?? []).map(text).filter(Boolean);
	oneDrives.forEach((given, index) => consider(`onedrive${index + 1}`, oneDrives.length > 1 ? `OneDrive ${index + 1}` : "OneDrive", given));
	return { ok: true, folders };
}
