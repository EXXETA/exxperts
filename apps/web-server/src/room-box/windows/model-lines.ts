import { ALLOW_FOLDER_WHEN_ASKED, ALLOW_WHEN_ASKED, alsoAllowedSentence, boxSitesClause, type AlsoAllowedForModel, ASK_AGAIN_FROM_COMPUTER, ASK_FOR_FOLDER_TOOL_NAME, RUN_OUTSIDE_BOX_TOOL_NAME } from "../card-text.js";

/**
 * What the model reads about a protected room's commands on Windows, where
 * they run in Windows PowerShell 5.1: the command tool's texts, the box's line,
 * the long-output line, the skill line and the outside tool's texts. The Mac's
 * are in ../card-text.ts, ../spill.ts and the runtime's bash tool.
 */

/** The command tool's description; the limits are the runtime's bash tool's own. */
export const windowsCommandDescription = (limits: { lines: number; kilobytes: number; timeoutSeconds: number }): string =>
	`Run a Windows PowerShell 5.1 command in the room's folder. This is PowerShell, not bash: use Get-ChildItem, Get-Content, Select-String, $env:NAME, and ; between commands; && and || don't exist in 5.1. ls, cat, rm, cp and mv are PowerShell's own commands with PowerShell's options: write Remove-Item -Recurse -Force, not rm -rf. curl means Invoke-WebRequest; write curl.exe for curl. To pass text with double quotes to a program, put it in a file first. Text files a command writes are UTF-8 with a byte-order mark; write a file that must have none, such as JSON for Python, with the write tool. Programs a command starts end when it ends. Returns the output and errors. Output is truncated to the last ${limits.lines} lines or ${limits.kilobytes}KB (whichever is hit first); the full output is saved to a file. Commands time out after ${limits.timeoutSeconds} seconds by default; provide a timeout in seconds to override.`;

export const WINDOWS_COMMAND_SNIPPET = "Run Windows PowerShell 5.1 commands (Get-ChildItem, Select-String, etc.)";

export const WINDOWS_COMMAND_INPUT = "Windows PowerShell 5.1 command to run";

/**
 * In the box's line for the model on Windows, where each kind of file goes: TEMP
 * is the turn's temp (command-line.ts), removed when the turn ends, and pip's
 * user place is under APPDATA, which is the room's caches (box-request.ts).
 */
export const WINDOWS_FILE_HOMES_LINE = "Only what the person asked for goes into the room's folder. Helper scripts and other temporary files go under $env:TEMP, which is emptied after this answer. A library you install with pip is kept for this room.";

/**
 * What the model is told each answer on Windows, as boxModelLine (../card-text.ts)
 * is on a Mac: what the box refuses, and the room's list as it stands. `free`: the answer reaches public websites without asking. No word
 * about git: the Windows box makes no promise about git's folders. `asks`: the room's folder ask is offered, so a failure that may be the
 * box's sends the model to it first.
 */
export function windowsBoxModelLine(alsoAllowed: AlsoAllowedForModel, asks: boolean, free = false): string {
	const askFirst = asks ? ` If a command fails or gives nothing useful and may have touched a place outside the room's folder, call ${ASK_FOR_FOLDER_TOOL_NAME} for that place first.` : "";
	const checks = free ? "Windows' own certificate checks reach public sites like any other." : "Windows' own certificate checks reach only a site already allowed, without asking, and curl.exe goes on without them.";
	return `\n\nCommands run in Windows PowerShell 5.1 inside this room's protection: outside the room's folder they can't change files, they can't read the person's other files or keys, ${boxSitesClause(free)}. ${checks} "Access is denied" may mean the protection refused a place, and a command that fails oddly may have been refused too. ${WINDOWS_FILE_HOMES_LINE} ${free ? ALLOW_FOLDER_WHEN_ASKED : ALLOW_WHEN_ASKED}${askFirst}${alsoAllowedSentence(alsoAllowed)}`;
}

/** After a long output's file name: the file tools can't open the turn's temp on Windows. */
export const WINDOWS_READ_SPILL_LINE = "Read it with a command, such as Get-Content -Tail 100: the read tool can't open it.";

/** In a skill's text, where a Mac says to run its files with the bash tool, when the protection wasn't given the skill's folder (`windowsSkillFolder`). */
export const WINDOWS_SKILL_READ_ONLY_LINE = "Read them with the read tool. This room's commands can't run them on this computer: where the instructions call for running one, do its steps with your own commands, or tell the person it can't run here.";

/**
 * In a skill's text, where a Mac says to run its files with the bash tool and
 * where to write, when the protection was given the skill's folder: read and
 * run, never written. It takes the place of the Mac's sentence on what a write
 * there does to the approval, since no command can write there.
 */
export const WINDOWS_SKILL_RUN_LINE = `Read them with the read tool. Run one with this room's commands by naming its program and quoting its full path, never by its name alone: & '<full path>.ps1' for PowerShell, python '<full path>.py' or py '<full path>.py' for Python, node '<full path>.js' for Node. If Python or Node isn't on this computer, don't install it and don't rewrite a long script: tell the person which program the skill needs, and that exxperts must be started again once it's installed. A .sh file can't run on this computer: do its steps with PowerShell commands where they are simple, otherwise tell the person that step can't run here. Write outputs into the room's folder and helper files under $env:TEMP. The skill's folder can't be changed, so never call ${ASK_FOR_FOLDER_TOOL_NAME} for it because a write there was refused.`;

/** The outside tool's description on Windows: it still runs Git Bash, so its command is bash while the room's are PowerShell. */
export const WINDOWS_OUTSIDE_DESCRIPTION = "Ask the person to run one command outside this room's protection, with all their rights, when the room's commands can't do it: git push over SSH, git clone in their folder, opening an app. This one runs in Git Bash, not PowerShell, so write it in bash. They see the full command and your reason on a card and must say yes each time. Use this only when a PowerShell command in the room has failed for that reason, never just to get at a place the room's protection keeps closed on purpose, such as the person's keys or a local address, unless the person asks.";

export const WINDOWS_OUTSIDE_COMMAND_INPUT = "The one bash command to run outside this room, in Git Bash";

// The site decision's reasons, word for word as the Mac's box gives them (../box-session.ts): a row of
// windows-switch-on-smoke.ts reads that file and fails when one differs. Each ends a refusal line.

export const WINDOWS_SITE_TURN_ENDED = "the turn that started this has ended";

export const WINDOWS_SITE_NOBODY_THERE = `nobody is here to allow this site; ${ASK_AGAIN_FROM_COMPUTER}`;

export const WINDOWS_SITE_TOO_MANY = "too many sites were asked for in this turn; the person can allow them, then run it again";

export const WINDOWS_SITE_DECLINED = "the person declined this site";

export const WINDOWS_SITE_STOPPED = "the person stopped this";

// Windows' own reasons, with no copy on a Mac: a card nobody waits for any more closes, and Windows' certificate checks never ask.

export const WINDOWS_SITE_UNANSWERED = `the person hadn't answered before the command stopped waiting, which isn't a no; run the command again if the task needs this site, and don't offer ${RUN_OUTSIDE_BOX_TOOL_NAME} to get round it`;

export const WINDOWS_CERTIFICATE_CHECK = "Windows wanted to check a certificate there, and such a check reaches only a site already allowed, without asking; if a program won't go on without it, the person can allow this site for this room when a command reaches it and the app asks";

/** After the command that asked, once per site and reason: what the model reads of a refused site. */
export const windowsSiteRefusedLine = (host: string, reason: string): string => `The room's protection refused ${host}: ${reason}.`;
