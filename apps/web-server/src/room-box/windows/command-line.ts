import path from "node:path";

/**
 * One command line from its arguments, by the Microsoft C runtime's rules. The
 * box hands Windows the line as it stands, so it must be exactly what the
 * program parses back: a value with a space, tab, newline or quote is quoted,
 * a quote inside is escaped, and the backslashes before a quote are doubled.
 */
export function joinCommandLine(argv: readonly string[]): string {
	return argv.map((value) => {
		if (value.length > 0 && !/[ \t\n\v"]/.test(value)) return value;
		let out = '"';
		let slashes = 0;
		for (const character of value) {
			if (character === "\\") {
				slashes += 1;
				continue;
			}
			out += character === '"' ? `${"\\".repeat(slashes * 2 + 1)}"` : `${"\\".repeat(slashes)}${character}`;
			slashes = 0;
		}
		return `${out}${"\\".repeat(slashes * 2)}"`;
	}).join(" ");
}

/** PowerShell's `-EncodedCommand` form of a script: its UTF-16LE bytes in base64. */
export function encodedCommand(script: string): string {
	return Buffer.from(script, "utf16le").toString("base64");
}

/** Windows PowerShell 5.1, by its full path under Windows' own folder. */
export function windowsPowerShell(systemRoot: string): string {
	return path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * The wrapper every command runs in: it takes the model's text from
 * `EXXPERTS_COMMAND` (box-request.ts), so the text never meets a quoting layer,
 * and drops the variable before the text runs. The last statement decides
 * whether it worked, as on a Mac: one that worked gives 0, even after a program
 * that failed earlier. One that failed gives the code the last program left, or
 * 1 when none did: PowerShell keeps one `$LASTEXITCODE` for the whole text, not
 * one per statement, so a cmdlet failing after a failed program gives that
 * program's code. `$?` is read by a line run with the text, since
 * `Invoke-Expression`'s own `$?` is not the last statement's. What the text
 * gives is printed by `Out-Default` before `exit`: without it, `exit` ends the
 * script while output PowerShell prints as a table it sizes itself (such as
 * `Get-Location`'s) is still waiting, and that output is lost.
 *
 * Before the text runs, each line in `try`, so a PC in constrained language
 * mode still runs the command:
 * - progress is off first, or a cmdlet's progress lands in the output as XML;
 * - output is UTF-8, both what the command prints and what it hands a program;
 * - every cmdlet that takes `-Encoding` reads and writes UTF-8 by default, `>`
 *   included, so a file tool's file and a command's file read the same;
 * - TEMP and TMP are the turn's temp, from `EXXPERTS_TEMP` (box-request.ts):
 *   the box sets its own over the request's, which no turn's end empties;
 * - when the request names the turn's proxy, PowerShell's own web commands
 *   (`Invoke-WebRequest`, `Invoke-RestMethod`, `WebClient`) use it too, since
 *   they don't read the proxy variables.
 */
export const COMMAND_WRAPPER = `$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; $OutputEncoding = [Console]::OutputEncoding } catch { }
try { $PSDefaultParameterValues['*:Encoding'] = 'utf8' } catch { }
try { if ($env:EXXPERTS_TEMP) { $env:TEMP = $env:EXXPERTS_TEMP; $env:TMP = $env:EXXPERTS_TEMP } } catch { }
try { if ($env:HTTPS_PROXY) { [Net.WebRequest]::DefaultWebProxy = New-Object Net.WebProxy($env:HTTPS_PROXY) } } catch { }
$exxpertsCommand = $env:EXXPERTS_COMMAND
Remove-Item -LiteralPath Env:EXXPERTS_COMMAND -ErrorAction SilentlyContinue
$global:LASTEXITCODE = 0
$exxpertsOk = $false
Invoke-Expression ($exxpertsCommand + "\`n" + '$exxpertsOk = $?') | Out-Default
if ($exxpertsOk) { exit 0 }
if ($LASTEXITCODE) { exit $LASTEXITCODE }
exit 1
`;

/**
 * The fixed line every command runs as. It carries only our wrapper, never the
 * model's text, so no Windows quoting touches what the model wrote, and a
 * policy of signed scripts only doesn't stop it, as it would `-File`. Output
 * is text by `-OutputFormat Text`, but PowerShell's own errors still come as
 * `#< CLIXML` records: the box's process turns them into text
 * (box-worker-windows.ts, error-text.ts).
 */
export function powerShellLine(systemRoot: string, wrapper: string): string {
	return joinCommandLine([windowsPowerShell(systemRoot), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-OutputFormat", "Text", "-EncodedCommand", encodedCommand(wrapper)]);
}
