// What Windows PowerShell 5.1 wrote on a real PC for a missing program, its
// errors redirected (#< CLIXML and its block), and the plain text of each
// block written out by hand: windows-error-text-smoke.ts and
// windows-model-lines-smoke.ts read them.

export const MARKER = "#< CLIXML\r\n";
// `nosuchprogram; Write-Output after-a-failure`: the error's block, as PowerShell wrote it.
export const ALONE = `<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">nosuchprogram : The term 'nosuchprogram' is not recognized as the name of a cmdlet, function, script file, or operable _x000D__x000A_</S><S S="Error">program. Check the spelling of the name, or if a path was included, verify that the path is correct and try again._x000D__x000A_</S><S S="Error">At line:1 char:1_x000D__x000A_</S><S S="Error">+ nosuchprogram; Write-Output after-a-failure_x000D__x000A_</S><S S="Error">+ ~~~~~~~~~~~~~_x000D__x000A_</S><S S="Error">    + CategoryInfo          : ObjectNotFound: (nosuchprogram:String) [], CommandNotFoundException_x000D__x000A_</S><S S="Error">    + FullyQualifiedErrorId : CommandNotFoundException_x000D__x000A_</S><S S="Error"> _x000D__x000A_</S></Objs>`;
export const ALONE_TEXT = [
	"nosuchprogram : The term 'nosuchprogram' is not recognized as the name of a cmdlet, function, script file, or operable ",
	"program. Check the spelling of the name, or if a path was included, verify that the path is correct and try again.",
	"At line:1 char:1",
	"+ nosuchprogram; Write-Output after-a-failure",
	"+ ~~~~~~~~~~~~~",
	"    + CategoryInfo          : ObjectNotFound: (nosuchprogram:String) [], CommandNotFoundException",
	"    + FullyQualifiedErrorId : CommandNotFoundException",
	" ",
	"",
].join("\r\n");
// `Get-Location; nosuchprogram`: its output, then the error's block.
export const LOCATION = "\r\nPath      \r\n----      \r\nC:\\windows\r\n\r\n";
export const AFTER = `<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">nosuchprogram : The term 'nosuchprogram' is not recognized as the name of a cmdlet, function, script file, or operable _x000D__x000A_</S><S S="Error">program. Check the spelling of the name, or if a path was included, verify that the path is correct and try again._x000D__x000A_</S><S S="Error">At line:1 char:15_x000D__x000A_</S><S S="Error">+ Get-Location; nosuchprogram_x000D__x000A_</S><S S="Error">+               ~~~~~~~~~~~~~_x000D__x000A_</S><S S="Error">    + CategoryInfo          : ObjectNotFound: (nosuchprogram:String) [], CommandNotFoundException_x000D__x000A_</S><S S="Error">    + FullyQualifiedErrorId : CommandNotFoundException_x000D__x000A_</S><S S="Error"> _x000D__x000A_</S></Objs>`;
export const AFTER_TEXT = [
	"nosuchprogram : The term 'nosuchprogram' is not recognized as the name of a cmdlet, function, script file, or operable ",
	"program. Check the spelling of the name, or if a path was included, verify that the path is correct and try again.",
	"At line:1 char:15",
	"+ Get-Location; nosuchprogram",
	"+               ~~~~~~~~~~~~~",
	"    + CategoryInfo          : ObjectNotFound: (nosuchprogram:String) [], CommandNotFoundException",
	"    + FullyQualifiedErrorId : CommandNotFoundException",
	" ",
	"",
].join("\r\n");
/** Any piece of a block's raw form. */
export const RAW = /CLIXML|#<|<Obj|<S[ >/]|<\/S|_x00/;
