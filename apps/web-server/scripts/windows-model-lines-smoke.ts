// What the model reads and gets back for a protected room's commands on
// Windows, on any computer: the room's command tools built with the Windows
// engine, whose box's process runs from its source with the stand-in for
// Microsoft's sandbox kit (windows-box-stand-in.mjs). Rows: the command tool's
// PowerShell 5.1 texts, and no person's bash prefix in a boxed command; the
// Mac's box and no box as before; a long output in the turn's temp with a
// PowerShell way to read it, the Mac's line beside it; each line of
// windows/model-lines.ts, written out here by hand, since words are this
// smoke's job; and the outside tool beside the Windows box with no shell.
//
// The stand-in names this computer's paths as C:\a\b for /a/b, so this needs a
// machine that is not Windows.
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

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

if (process.platform === "win32") {
	console.log("windows-model-lines smoke skipped (the stand-in's paths need a machine that is not Windows)");
	process.exit(0);
}

const show = (value: unknown) => JSON.stringify(value);
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), "windows-model-")));
const folderAt = (name: string) => {
	fs.mkdirSync(path.join(work, name), { recursive: true });
	return fs.realpathSync(path.join(work, name));
};

// The person's own settings name a command prefix: bash text, which a PowerShell command must never carry.
const agentDir = folderAt("agent");
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ shellCommandPrefix: "echo PREFIX-RAN" }));
Object.assign(process.env, { EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: folderAt("agents") });

const { setShellLookupPlatformForTests } = await import("@exxeta/exxperts-runtime");
const { createRoomCommandTools } = await import("../src/room-command-tool.js");
const { enablePersistentRoomSkill } = await import("../src/persistent-room-skill-settings.js");
const { createReadSkillTool } = await import("../src/persistent-room-skill-tool.js");
const { WINDOWS_CERTIFICATE_CHECK, WINDOWS_SITE_UNANSWERED, WINDOWS_SKILL_READ_ONLY_LINE, WINDOWS_SKILL_RUN_LINE, windowsBoxModelLine, WINDOWS_COMMAND_INPUT, WINDOWS_COMMAND_SNIPPET, WINDOWS_OUTSIDE_COMMAND_INPUT, WINDOWS_OUTSIDE_DESCRIPTION, WINDOWS_READ_SPILL_LINE, windowsCommandDescription } = await import("../src/room-box/windows/model-lines.js");
const { BOX_ROOT_NAME } = await import("../src/room-box/windows/box-root.js");
const { COMMAND_VARIABLE } = await import("../src/room-box/windows/box-request.js");
const { runStartCheck } = await import("../src/room-box/windows/start-check.js");
const { WindowsRoomBox } = await import("../src/room-box/windows/windows-engine.js");
// @ts-expect-error: plain JavaScript, loaded as the kit in the worker and for its path helpers here.
const { requestPath } = await import("./windows-box-stand-in.mjs");
const { AFTER, AFTER_TEXT, LOCATION, MARKER, RAW } = await import("./windows-error-samples.js");

// ---- The Windows engine, with the stand-in for the kit ------------------------------------------------

const require = createRequire(import.meta.url);
const configFile = path.join(work, "config.json");
const log = path.join(work, "log.jsonl");
fs.writeFileSync(configFile, JSON.stringify({ log }));
const worker = {
	file: path.join(import.meta.dirname, "../src/room-box/windows/box-worker-windows.ts"),
	execArgv: ["--import", pathToFileURL(require.resolve("tsx/esm")).href, "--import", `${pathToFileURL(path.join(import.meta.dirname, "windows-box-stand-in.mjs")).href}?config=${encodeURIComponent(configFile)}&register`],
};
const answer = await runStartCheck({
	system: { platform: "win32", arch: "x64", release: "10.0.26200", product: "Windows 11 Pro" },
	readMachine: async () => ({
		revision: 9711,
		profile: String.raw`C:\Users\Ana`,
		personal: [String.raw`C:\Users\Ana\Documents`],
		environment: { SystemRoot: String.raw`C:\Windows`, ProgramFiles: String.raw`C:\Program Files`, USERPROFILE: String.raw`C:\Users\Ana`, PATH: String.raw`C:\Windows\System32` },
		pathFolders: [String.raw`C:\Windows\System32`],
		programs: { folder: String.raw`C:\Users\Ana\AppData\Local\Programs`, names: [] },
	}),
	worker,
	root: path.join(work, BOX_ROOT_NAME),
	requestPath,
});
assert(answer.state === "on", show(answer));
const room = folderAt("room");
const windowsBox = (startAnswer: () => Promise<typeof answer> = async () => answer) => new WindowsRoomBox({ roomId: "windows-model", conversationId: () => "c", rights: () => ({ canChangeFiles: true, skillFolders: [] }), warn: () => {}, folders: () => ({ folder: room, alsoAllowed: [] }), roomData: folderAt("room-data"), startAnswer });
/** The model's text of each command the kit was asked to run, the proof's left out. */
const commandsRun = () => fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.call === "spawn").map((entry) => String(entry.request.environment[COMMAND_VARIABLE])).filter((text) => !/^(Set-Content |Remove-Item |Get-Content |& )/.test(text));

/** A Mac box that runs nothing: it notes each command and prints `lines` lines. */
function macBox(lines = 1) {
	const seen: string[] = [];
	const temp = folderAt(`mac-temp-${Math.random().toString(16).slice(2)}`);
	return {
		seen,
		temp,
		box: {
			operations: () => ({
				exec: async (command: string, _cwd: string, options: { onData: (chunk: Buffer) => void }) => {
					seen.push(command);
					options.onData(Buffer.from(Array.from({ length: lines }, (_, at) => `line ${at}\n`).join("")));
					return { exitCode: 0 };
				},
			}),
			privateTemp: async () => temp,
			readsSpills: () => false,
			noteSpill: () => {},
		},
	};
}

type Tool = { name: string; description: string; promptSnippet?: string; parameters: { properties: Record<string, { description?: string }> }; execute: (id: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => Promise<{ content: { type: string; text?: string }[]; details?: { fullOutputPath?: string } }> };
const toolsOf = (tools: { tools: unknown[] }) => tools.tools as Tool[];
const named = (tools: Tool[], name: string) => tools.find((tool) => tool.name === name) as Tool;
const textOf = (result: { content: { text?: string }[] }) => result.content.map((part) => part.text ?? "").join("");
const questions = (watcher: "computer" | "none" = "computer") => {
	const cards: string[] = [];
	return { cards, questions: { watcher: () => watcher, askOutside: async (card: { command: string }) => { cards.push(card.command); return false; } } };
};

// The runtime's own texts, which the Mac's box and no box keep.
const BASH_DESCRIPTION = "Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Commands time out after 600 seconds by default; provide a timeout in seconds to override.";

// ---- The command tool ---------------------------------------------------------------------------------

await row("tools: with the Windows box, bash offers the PowerShell 5.1 texts, and the person's bash prefix never reaches the command", async () => {
	const box = windowsBox();
	const tools = toolsOf(createRoomCommandTools(room, { box, outside: { questions: questions().questions, setOffered: () => {} } }));
	const bash = named(tools, "bash");
	assert(bash.description === "Run a Windows PowerShell 5.1 command in the room's folder. This is PowerShell, not bash: use Get-ChildItem, Get-Content, Select-String, $env:NAME, and ; between commands; && and || don't exist in 5.1. ls, cat, rm, cp and mv are PowerShell's own commands with PowerShell's options: write Remove-Item -Recurse -Force, not rm -rf. curl means Invoke-WebRequest; write curl.exe for curl. To pass text with double quotes to a program, put it in a file first. Text files a command writes are UTF-8 with a byte-order mark; write a file that must have none, such as JSON for Python, with the write tool. Programs a command starts end when it ends. Returns the output and errors. Output is truncated to the last 2000 lines or 50KB (whichever is hit first); the full output is saved to a file. Commands time out after 600 seconds by default; provide a timeout in seconds to override.", bash.description);
	assert(bash.promptSnippet === "Run Windows PowerShell 5.1 commands (Get-ChildItem, Select-String, etc.)", String(bash.promptSnippet));
	assert(bash.parameters.properties.command.description === "Windows PowerShell 5.1 command to run" && bash.parameters.properties.timeout?.description?.startsWith("Timeout in seconds"), show(bash.parameters));
	const result = await bash.execute("windows-1", { command: "Write-Output hello" });
	assert(textOf(result).trim() === "hello", show(result));
	assert(commandsRun().at(-1) === "Write-Output hello", show(commandsRun().slice(-2)));
	await box.endTurn();
});

await row("tools: with the Mac's box and with no box, bash keeps the runtime's texts and the person's prefix", async () => {
	const mac = macBox();
	const boxed = toolsOf(createRoomCommandTools(room, { box: mac.box, outside: { questions: questions().questions, setOffered: () => {} } }));
	const plain = toolsOf(createRoomCommandTools(room));
	for (const [label, bash] of [["the Mac's box", named(boxed, "bash")], ["no box", named(plain, "bash")]] as const) {
		assert(bash.description === BASH_DESCRIPTION && bash.promptSnippet === "Execute bash commands (ls, grep, find, etc.)" && bash.parameters.properties.command.description === "Bash command to execute", `${label}: ${show([bash.description, bash.promptSnippet, bash.parameters])}`);
	}
	await named(boxed, "bash").execute("mac-1", { command: "echo hi" });
	assert(show(mac.seen) === show(["echo PREFIX-RAN\necho hi"]), show(mac.seen));
	const ran = textOf(await named(plain, "bash").execute("plain-1", { command: "echo hi" }));
	assert(ran.includes("PREFIX-RAN") && ran.includes("hi"), ran);
});

await row("tools: through the Windows box's command tool, Stop while the box starts ends the command at once, and a turn that ends then runs none of it", async () => {
	const slowly = (ms: number) => windowsBox(() => new Promise((resolve) => setTimeout(() => resolve(answer), ms)));
	const toolOf = (box: ReturnType<typeof windowsBox>) => named(toolsOf(createRoomCommandTools(room, { box, outside: { questions: questions().questions, setOffered: () => {} } })), "bash");
	const ran = commandsRun().length;
	const stopping = slowly(3_000);
	const stop = new AbortController();
	setTimeout(() => stop.abort(), 100);
	const started = Date.now();
	const stopped = await toolOf(stopping).execute("slow-stop", { command: "Write-Output never" }, stop.signal).then(() => "ran", (error: Error) => error.message);
	assert(stopped.includes("aborted") && Date.now() - started < 1_000, `${stopped} after ${Date.now() - started} ms`);
	await stopping.endTurn();
	const ending = slowly(500);
	const pending = toolOf(ending).execute("slow-end", { command: "Write-Output after-the-end" }).then(() => "ran", (error: Error) => error.message);
	await ending.endTurn();
	assert((await pending).includes("aborted") && commandsRun().length === ran, `${await pending}: ${show(commandsRun().slice(ran))}`);
	await ending.endTurn();
});

await row("errors: after a failed command, what the model reads and what the step shows hold PowerShell's error as plain text, its block cut in two with output between", async () => {
	const box = windowsBox();
	const bash = named(toolsOf(createRoomCommandTools(room, { box, outside: { questions: questions().questions, setOffered: () => {} } })), "bash");
	// The output and the error's block as the PC wrote them, the block cut in two on the error stream, and between its parts a file of CLIXML printed as output.
	const cut = 300;
	const saved = `<Objs Version="1.1.0.1"><S>saved with Export-Clixml</S></Objs>`;
	fs.writeFileSync(path.join(room, "location.txt"), LOCATION);
	fs.writeFileSync(path.join(room, "saved.xml"), saved);
	fs.writeFileSync(path.join(room, "error-1.txt"), MARKER + AFTER.slice(0, cut));
	fs.writeFileSync(path.join(room, "error-2.txt"), AFTER.slice(cut));
	const updates: string[] = [];
	const command = [
		"Get-Content -LiteralPath 'location.txt'",
		"[Console]::Error.Write([IO.File]::ReadAllText('error-1.txt'))",
		"Start-Sleep -Milliseconds 100",
		"Get-Content -LiteralPath 'saved.xml'",
		"Start-Sleep -Milliseconds 100",
		"[Console]::Error.Write([IO.File]::ReadAllText('error-2.txt'))",
		"exit 1",
	].join("\n");
	const failed = await bash.execute("windows-error", { command }, undefined, (update: { content: { text?: string }[] }) => updates.push(textOf(update))).then(() => "ran", (error: Error) => error.message);
	// The file passes as it came, where it came; without it, the rest reads as the output and the error's text.
	assert(failed.split(saved).length === 2 && failed.endsWith("Command exited with code 1"), failed);
	const rest = failed.replace(saved, "");
	assert(rest.includes((LOCATION + AFTER_TEXT).trim()) && !RAW.test(rest), failed);
	const raw = updates.find((update) => RAW.test(update.replace(saved, "")));
	assert(updates.length > 0 && raw === undefined, show(updates));
	await box.endTurn();
});

await row("errors: output that comes while the error stream is inside a record that is dropped stays whole", async () => {
	const box = windowsBox();
	const bash = named(toolsOf(createRoomCommandTools(room, { box, outside: { questions: questions().questions, setOffered: () => {} } })), "bash");
	fs.writeFileSync(path.join(room, "record-1.txt"), `${MARKER}<Objs Version="1.1.0.1"><Obj S="progress" RefId="0"><MS>`);
	fs.writeFileSync(path.join(room, "record-2.txt"), `<S N="Activity">loading</S></MS></Obj><S S="Error">bad_x000D__x000A_</S></Objs>`);
	const inRecord = await bash.execute("windows-record", { command: "[Console]::Error.Write([IO.File]::ReadAllText('record-1.txt'))\nStart-Sleep -Milliseconds 100\nWrite-Output result\nStart-Sleep -Milliseconds 100\n[Console]::Error.Write([IO.File]::ReadAllText('record-2.txt'))\nexit 1" }).then(() => "ran", (error: Error) => error.message);
	assert(inRecord.startsWith("result\nbad\r\n") && !RAW.test(inRecord) && !inRecord.includes("loading"), inRecord);
	await box.endTurn();
});

// ---- Long output ----------------------------------------------------------------------------------------

await row("spills: a long Windows output lands in the turn's temp and names a PowerShell way to read it; the Mac's line is unchanged", async () => {
	const box = windowsBox();
	const bash = named(toolsOf(createRoomCommandTools(room, { box, outside: { questions: questions().questions, setOffered: () => {} } })), "bash");
	// One command under Windows' limit for one variable that prints more lines than the tool shows.
	const result = await bash.execute("windows-long", { command: Array.from({ length: 2100 }, () => "Write-Output a").join(";") });
	const temp = await box.privateTemp();
	const spill = result.details?.fullOutputPath ?? "";
	assert(path.dirname(spill) === temp && fs.readFileSync(spill, "utf8").split("\n").filter(Boolean).length === 2100, `${spill} in ${temp}`);
	assert(textOf(result).endsWith(`Full output: ${spill}]\nRead it with a command, such as Get-Content -Tail 100: the read tool can't open it.`), textOf(result).slice(-300));
	await box.endTurn();
	assert(!fs.existsSync(spill), "the long output outlived its turn");

	const mac = macBox(3000);
	const macResult = await named(toolsOf(createRoomCommandTools(room, { box: mac.box, outside: { questions: questions().questions, setOffered: () => {} } })), "bash").execute("mac-long", { command: "seq 3000" });
	const macSpill = macResult.details?.fullOutputPath ?? "";
	assert(path.dirname(macSpill) === mac.temp && textOf(macResult).endsWith(`Full output: ${macSpill}]\nRead it with a command, such as tail or sed: the read tool can't open it.`), textOf(macResult).slice(-300));
});

// ---- The lines ------------------------------------------------------------------------------------------

await row("lines: each line of model-lines.ts, as written here; none names the switch, protection settings or Room settings, and the box line says nothing about git", async () => {
	const boxLine = windowsBoxModelLine({ folders: [{ path: String.raw`C:\Data`, access: "write" }, { path: String.raw`D:\Reports`, access: "read" }], sites: [{ host: "example.org", port: 443 }] }, true);
	assert(boxLine === `\n\nCommands run in Windows PowerShell 5.1 inside this room's protection: outside the room's folder they can't change files, they can't read the person's other files or keys, and a site needs the person's yes. Windows' own certificate checks reach only a site already allowed, without asking, and curl.exe goes on without them. "Access is denied" may mean the protection refused a place, and a command that fails oddly may have been refused too. Only what the person asked for goes into the room's folder. Helper scripts and other temporary files go under $env:TEMP, which is emptied after this answer. A library you install with pip is kept for this room. The person can allow a folder or a site when the app asks them. If a command fails or gives nothing useful and may have touched a place outside the room's folder, call ask_for_folder for that place first. Also allowed in this room: C:\\Data (read and change), D:\\Reports (read), example.org:443.`, boxLine);
	const bare = windowsBoxModelLine({ folders: [], sites: [] }, false);
	assert(bare === `\n\nCommands run in Windows PowerShell 5.1 inside this room's protection: outside the room's folder they can't change files, they can't read the person's other files or keys, and a site needs the person's yes. Windows' own certificate checks reach only a site already allowed, without asking, and curl.exe goes on without them. "Access is denied" may mean the protection refused a place, and a command that fails oddly may have been refused too. Only what the person asked for goes into the room's folder. Helper scripts and other temporary files go under $env:TEMP, which is emptied after this answer. A library you install with pip is kept for this room. The person can allow a folder or a site when the app asks them. Also allowed in this room: none.`, bare);
	assert(WINDOWS_READ_SPILL_LINE === "Read it with a command, such as Get-Content -Tail 100: the read tool can't open it.", WINDOWS_READ_SPILL_LINE);
	assert(WINDOWS_SKILL_READ_ONLY_LINE === "Read them with the read tool. This room's commands can't run them on this computer: where the instructions call for running one, do its steps with your own commands, or tell the person it can't run here.", WINDOWS_SKILL_READ_ONLY_LINE);
	assert(WINDOWS_SKILL_RUN_LINE === "Read them with the read tool. Run one with this room's commands by naming its program and quoting its full path, never by its name alone: & '<full path>.ps1' for PowerShell, python '<full path>.py' or py '<full path>.py' for Python, node '<full path>.js' for Node. If Python or Node isn't on this computer, don't install it and don't rewrite a long script: tell the person which program the skill needs, and that exxperts must be started again once it's installed. A .sh file can't run on this computer: do its steps with PowerShell commands where they are simple, otherwise tell the person that step can't run here. Write outputs into the room's folder and helper files under $env:TEMP. The skill's folder can't be changed, so never call ask_for_folder for it because a write there was refused.", WINDOWS_SKILL_RUN_LINE);
	assert(WINDOWS_OUTSIDE_DESCRIPTION === "Ask the person to run one command outside this room's protection, with all their rights, when the room's commands can't do it: git push over SSH, git clone in their folder, opening an app. This one runs in Git Bash, not PowerShell, so write it in bash. They see the full command and your reason on a card and must say yes each time. Use this only when a PowerShell command in the room has failed for that reason, never just to get at a place the room's protection keeps closed on purpose, such as the person's keys or a local address, unless the person asks.", WINDOWS_OUTSIDE_DESCRIPTION);
	assert(WINDOWS_OUTSIDE_COMMAND_INPUT === "The one bash command to run outside this room, in Git Bash", WINDOWS_OUTSIDE_COMMAND_INPUT);
	assert(WINDOWS_SITE_UNANSWERED === "the person hadn't answered before the command stopped waiting, which isn't a no; run the command again if the task needs this site, and don't offer run_outside_box to get round it", WINDOWS_SITE_UNANSWERED);
	assert(WINDOWS_CERTIFICATE_CHECK === "Windows wanted to check a certificate there, and such a check reaches only a site already allowed, without asking; if a program won't go on without it, the person can allow this site for this room when a command reaches it and the app asks", WINDOWS_CERTIFICATE_CHECK);
	const lines = [boxLine, bare, WINDOWS_SITE_UNANSWERED, WINDOWS_CERTIFICATE_CHECK, WINDOWS_READ_SPILL_LINE, WINDOWS_SKILL_READ_ONLY_LINE, WINDOWS_SKILL_RUN_LINE, WINDOWS_OUTSIDE_DESCRIPTION, WINDOWS_OUTSIDE_COMMAND_INPUT, WINDOWS_COMMAND_INPUT, WINDOWS_COMMAND_SNIPPET, windowsCommandDescription({ lines: 2000, kilobytes: 50, timeoutSeconds: 600 })];
	for (const line of lines) assert(!/switch|turn (it |protection )?off|protection settings|room settings/i.test(line), `a line names the switch or the settings: ${line}`);
	assert(!/git/i.test(boxLine), "the box line names git");
});

await row("lines: read_skill gives the Windows run line where the protection was given the skill's folder, the read-only line where it wasn't, and the Mac's and an unprotected room's line unchanged", async () => {
	const agentId = "windows-model-skills";
	const manifest = "---\nname: report\ndescription: makes a report\n---\n\nRun scripts/report.ps1.";
	const lookupSkill = (name: string) => (name === "report" ? { manifest, body: "Run scripts/report.ps1.", description: "makes a report" } : null);
	assert(enablePersistentRoomSkill(agentId, "report", () => manifest).ok, "the skill was not enabled");
	const skillDir = String.raw`C:\Users\Ana\.exxperts\agent\skills\report`;
	const read = async (windowsBoxFlag: boolean, windowsRuns?: boolean) => textOf(await (createReadSkillTool({ agentId, lookupSkill, resolveExecutionExposure: () => ({ skillDir, files: ["scripts/report.ps1"], ...(windowsRuns === undefined ? {} : { windowsRuns }) }), windowsBox: windowsBoxFlag }) as unknown as Tool).execute("skill", { name: "report" }));
	const after = "Outputs you write stay in the room's folder on the user's computer and do NOT appear in this room's Attachments panel unless explicitly shelved; when you tell the user where an output landed, name the folder's path, never the Attachments panel. If this approval no longer appears in a later read of this skill, it was withdrawn or the files changed: do not run them from memory.";
	const pinned = "Write any outputs into the room's folder, never into the skill's folder: the approval is pinned to the skill's exact files, so a new file there voids it.";
	const exposure = (line: string) => `The user approved running this skill's bundled files in this room, for exactly this version. They live at:\n${skillDir}\nFiles: "scripts/report.ps1"\n${line} ${after}`;
	const runs = await read(true, true);
	assert(runs.endsWith(exposure(WINDOWS_SKILL_RUN_LINE)) && !runs.includes("bash tool") && !runs.includes(pinned), runs);
	// A skill whose folder the protection wasn't given reads as it did before its folder could be given.
	for (const readOnly of [await read(true, false), await read(true)]) assert(readOnly.endsWith(exposure(`${WINDOWS_SKILL_READ_ONLY_LINE} ${pinned}`)), readOnly);
	// A Mac and an unprotected Windows room, whose commands run in Git Bash: the bash tool's line, whatever windowsRuns says.
	for (const mac of [await read(false), await read(false, true)]) assert(mac.endsWith(exposure(`Read them with the read tool, and run them with the bash tool when the instructions call for it. ${pinned}`)), mac);
});

// ---- The outside tool ----------------------------------------------------------------------------------

await row("outside: beside the Windows box with no shell found, run_outside_box refuses before any card with the Git line; with one it asks; on a Mac nothing changes", async () => {
	// The runtime's lookup walked as on Windows, in an empty Program Files: no Git Bash anywhere.
	const programFiles = folderAt("program-files");
	const saved = { ProgramFiles: process.env.ProgramFiles, "ProgramFiles(x86)": process.env["ProgramFiles(x86)"], LOCALAPPDATA: process.env.LOCALAPPDATA };
	Object.assign(process.env, { ProgramFiles: programFiles, "ProgramFiles(x86)": programFiles, LOCALAPPDATA: programFiles });
	setShellLookupPlatformForTests("win32");
	// The outside tool's long output lands in the turn's temp too, so a call starts the turn's box.
	const box = windowsBox();
	try {
		const call = { command: "git push", reason: "the push needs the person's SSH key" };
		const windows = questions();
		const windowsTools = createRoomCommandTools(room, { box, outside: { questions: windows.questions, setOffered: () => {} } });
		const outside = named(toolsOf(windowsTools), "run_outside_box");
		assert(outside.description === WINDOWS_OUTSIDE_DESCRIPTION && outside.parameters.properties.command.description === WINDOWS_OUTSIDE_COMMAND_INPUT, show([outside.description, outside.parameters]));
		const refused = await outside.execute("outside-1", call).then(() => null, (error: Error) => error.message);
		assert(refused === "On Windows, shell commands need Git for Windows. Install it from gitforwindows.org; the room can run commands as soon as it is installed. If it still says this, restart exxperts.", String(refused));
		assert(windows.cards.length === 0 && !windowsTools.started("outside-1"), show(windows.cards));
		// Git Bash where the lookup looks first: the card comes, and a no runs nothing.
		fs.writeFileSync(`${programFiles}\\Git\\bin\\bash.exe`, "");
		const declined = await outside.execute("outside-2", call).then(() => null, (error: Error) => error.message);
		assert((windows.cards.length as number) === 1 && declined?.startsWith("The user declined"), `${show(windows.cards)} ${declined}`);
		fs.rmSync(`${programFiles}\\Git\\bin\\bash.exe`);
		// The Mac's box with the same lookup: the card comes as it always did.
		const mac = questions();
		const macOutside = named(toolsOf(createRoomCommandTools(room, { box: macBox().box, outside: { questions: mac.questions, setOffered: () => {} } })), "run_outside_box");
		assert(macOutside.parameters.properties.command.description === "The one bash command to run outside this room" && macOutside.description.includes("Use this only when the bash tool has failed for that reason"), show(macOutside.parameters));
		await macOutside.execute("outside-3", call).catch(() => {});
		assert(mac.cards.length === 1, show(mac.cards));
	} finally {
		await box.endTurn();
		setShellLookupPlatformForTests(undefined);
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
});

fs.rmSync(work, { recursive: true, force: true });
console.log("windows-model-lines-smoke: ok");
