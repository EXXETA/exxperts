# Official exxperts one-line installer (Windows PowerShell):
#
#   irm https://raw.githubusercontent.com/EXXETA/exxperts/main/install.ps1 | iex
#
# What it does: downloads the prebuilt release archive for Windows (app +
# vendored Node.js runtime, no Git/Node/npm needed to run it), verifies its
# checksum, and unpacks it under $env:LOCALAPPDATA\Programs\exxperts. When the
# archive path cannot finish (blocked download, no release yet, ...), it falls
# back to the source install: check prerequisites (Git for Windows with Git
# Bash, Node.js), clone the repo into $HOME\exxperts (override with
# EXXPERTS_DIR), then run `npm install` and `npm run install:global`.
# Re-running the same command updates an existing install either way.
#
# Env overrides:
#   EXXPERTS_INSTALL_METHOD  unset: archive first, source fallback.
#                            "source": skip the archive path entirely.
#                            "archive": archive only; fail instead of falling back.
#   EXXPERTS_ARCHIVE_URL     direct archive URL or local file path; skips the
#                            GitHub release lookup.
#   EXXPERTS_SUMS_URL        matching SHA256SUMS.txt URL or local file path
#                            (default: SHA256SUMS.txt next to the archive).
#   EXXPERTS_DIR   source-install directory (default: $HOME\exxperts). Setting
#                  it means "install from this checkout": the archive path is
#                  skipped and the source flow runs as before.
#   EXXPERTS_REPO  clone URL (default: https://github.com/EXXETA/exxperts.git)

$ErrorActionPreference = "Stop"

$script:RepoUrl = if ($env:EXXPERTS_REPO) { $env:EXXPERTS_REPO } else { "https://github.com/EXXETA/exxperts.git" }
$script:PkgName = "@exxeta/exxperts-app"

function Say([string]$Message) { Write-Host "[exxperts] $Message" }
function Fail([string]$Message) {
    foreach ($line in $Message -split "`n") { Write-Host "[exxperts] $line" -ForegroundColor Red }
    # throw, not exit: under `irm | iex` an exit would close the user's
    # PowerShell window and take the message above with it.
    throw "exxperts install failed (see the message above)"
}

function Test-ExxpertsClone([string]$Dir) {
    $pkg = Join-Path $Dir "package.json"
    if (-not (Test-Path $pkg)) { return $false }
    return (Get-Content $pkg -Raw) -match [regex]::Escape("`"name`": `"$script:PkgName`"")
}

function Test-Prerequisites {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        # Git is often installed but invisible to PowerShell: Git for Windows
        # set up without the "Git from the command line" option never lands on
        # PATH. Probe the standard install roots (machine-wide and per-user)
        # and use a found git for this session instead of demanding a reinstall.
        $gitCmdDirs = @()
        if ($env:ProgramFiles) { $gitCmdDirs += (Join-Path $env:ProgramFiles "Git\cmd") }
        if (${env:ProgramFiles(x86)}) { $gitCmdDirs += (Join-Path ${env:ProgramFiles(x86)} "Git\cmd") }
        if ($env:LOCALAPPDATA) { $gitCmdDirs += (Join-Path $env:LOCALAPPDATA "Programs\Git\cmd") }
        $foundGitDir = $gitCmdDirs | Where-Object { Test-Path (Join-Path $_ "git.exe") } | Select-Object -First 1
        if ($foundGitDir) {
            Say "git is installed at $foundGitDir but not on your PATH; using it for this install."
            Say "To make git available everywhere, reinstall Git for Windows keeping the default"
            Say "option 'Git from the command line and also from 3rd-party software'."
            $env:PATH = "$foundGitDir;$env:PATH"
        }
        else {
            Fail ("git is not installed. Install Git for Windows 2.40 or newer from https://gitforwindows.org,`n" +
                "then re-run this command. No admin rights? Run its installer anyway: it offers an`n" +
                "install just for your user account.")
        }
    }
    # The agent's shell tool runs commands through Git Bash; Git for Windows
    # provides it. bash.exe is deliberately NOT on PATH under Git's recommended
    # setup, and no-admin (per-user) installs live under AppData, not Program
    # Files - so derive bash from git's own location first, then fall back to
    # PATH and both machine-wide and per-user standard locations.
    $bashNearGit = $false
    $gitCommand = Get-Command git -ErrorAction SilentlyContinue
    if ($gitCommand -and $gitCommand.Source) {
        # <install root>\cmd\git.exe -> <install root>\bin\bash.exe
        $gitRoot = Split-Path -Parent (Split-Path -Parent $gitCommand.Source)
        if ($gitRoot) {
            $bashNearGit = Test-Path (Join-Path $gitRoot "bin\bash.exe")
        }
    }
    $bashOnPath = Get-Command bash.exe -ErrorAction SilentlyContinue
    $bashStandard = Test-Path "C:\Program Files\Git\bin\bash.exe"
    if (-not $bashStandard -and $env:LOCALAPPDATA) {
        $bashStandard = Test-Path (Join-Path $env:LOCALAPPDATA "Programs\Git\bin\bash.exe")
    }
    if (-not $bashNearGit -and -not $bashOnPath -and -not $bashStandard) {
        Fail "Git Bash (bash.exe) was not found. exxperts needs Git for Windows 2.40 or newer, which includes it. Install it from https://gitforwindows.org, then re-run this command."
    }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Fail ("Node.js is not installed. Install Node.js 20.6 or newer from https://nodejs.org, then`n" +
            "re-run this command. No admin rights? The ZIP download from nodejs.org needs none:`n" +
            "unpack it into a folder you own and add that folder to your PATH.")
    }
    # npm.cmd, deliberately: plain `npm` resolves to npm's .ps1 shim, which the
    # default Windows execution policy (Restricted) refuses to run. The .cmd
    # shim works under every policy. Same for every npm call below.
    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
        Fail "npm is not installed. It normally ships with Node.js; reinstall Node.js from https://nodejs.org, then re-run this command."
    }

    $nodeVersionRaw = (& node --version).Trim()
    $nodeVersion = [version]($nodeVersionRaw.TrimStart("v"))
    if ($nodeVersion -lt [version]"20.6.0") {
        Fail "Node.js $nodeVersionRaw is too old; exxperts needs Node.js 20.6 or newer. Update it from https://nodejs.org, then re-run this command."
    }

    # npm 12 refuses to run on Node versions outside its own engines range
    # (^22.22.2 || ^24.15.0 || >=26). Catch that mismatch here, before minutes
    # of cloning and building, instead of letting npm hard-fail mid-install.
    $npmVersion = (& npm.cmd --version).Trim()
    $npmMajor = [int]($npmVersion.Split(".")[0])
    if ($npmMajor -ge 12) {
        $nodeOk = ($nodeVersion.Major -ge 26) -or
            ($nodeVersion.Major -eq 24 -and $nodeVersion -ge [version]"24.15.0") -or
            ($nodeVersion.Major -eq 22 -and $nodeVersion -ge [version]"22.22.2")
        if (-not $nodeOk) {
            Fail "You have npm $npmVersion, which requires Node.js 22.22.2+, 24.15.0+ (within 24.x), or 26+, but Node.js $nodeVersionRaw is installed. Update Node.js from https://nodejs.org, then re-run this command."
        }
    }
}

# Fail early, with a plain-language message, when the network cannot reach the
# repo host at all (offline, DNS broken, firewall). Invoke-WebRequest uses the
# system (WinINET) proxy, so a working corporate proxy setup passes this probe;
# an HTTP error status still proves the host is reachable.
function Test-Network {
    $repoHost = ([uri]$script:RepoUrl).Host
    if (-not $repoHost) { return }
    $reachable = $false
    try {
        Invoke-WebRequest -Uri "https://$repoHost" -Method Head -UseBasicParsing -TimeoutSec 20 *> $null
        $reachable = $true
    }
    catch {
        # A response object means the host answered (e.g. 403/405 on HEAD).
        if ($_.Exception.PSObject.Properties["Response"] -and $_.Exception.Response) { $reachable = $true }
    }
    if (-not $reachable) {
        $proxyState = "no proxy variables are set"
        if ($env:HTTPS_PROXY) { $proxyState = "HTTPS_PROXY is set to '$($env:HTTPS_PROXY)'" }
        Fail ("cannot reach https://$repoHost, so the install cannot download anything.`n" +
            "Check your internet connection. If this network needs a proxy, set it first`n" +
            "(currently $proxyState), then re-run this command.")
    }
}

# A fresh install writes roughly 3 GB: the clone with node_modules, the npm
# cache, and a second copy under the global npm prefix. Say so up front
# instead of letting npm die minutes in with a confusing ENOSPC or a locked-
# file error that looks like something else.
function Test-DiskSpace([string]$Dir) {
    try {
        $qualifier = Split-Path -Qualifier $Dir
        if (-not $qualifier) { $qualifier = Split-Path -Qualifier $HOME }
        $free = (Get-PSDrive -Name $qualifier.TrimEnd(":")).Free
    }
    catch { return }
    if ($null -eq $free) { return }
    $freeGB = [math]::Round($free / 1GB, 1)
    if ($free -lt 1GB) {
        Fail ("not enough free disk space: $freeGB GB available where $Dir lives,`n" +
            "but a fresh install needs about 3 GB (clone, build, npm cache, installed copy).`n" +
            "Free up some space, then re-run this command.")
    }
    if ($free -lt 4GB) {
        Say "heads up: only $freeGB GB free where $Dir lives; a fresh install uses about 3 GB."
    }
}

# Bring an existing clone up to date. Skips quietly when the clone has no
# upstream branch to pull from (e.g. a CI checkout on a detached commit).
function Update-Clone([string]$Dir) {
    & git -C $Dir rev-parse --abbrev-ref --symbolic-full-name "@{u}" *> $null
    if ($LASTEXITCODE -ne 0) {
        Say "no upstream branch configured in $Dir; skipping the update pull."
        return
    }
    Say "updating existing clone in $Dir ..."
    & git -C $Dir pull --ff-only
    if ($LASTEXITCODE -ne 0) {
        Fail ("could not update ${Dir}: the clone has local changes or has diverged from the remote.`n" +
            "Either commit/stash your changes and run 'git pull' there yourself,`n" +
            "or install into a fresh directory: set EXXPERTS_DIR to another path and re-run this command.`n" +
            "This installer never overwrites local work.")
    }
}

function Resolve-InstallDir {
    # Running from inside an exxperts clone (e.g. re-running the installer from
    # the install directory) reuses that clone.
    if (Test-ExxpertsClone (Get-Location).Path) { return (Get-Location).Path }
    if ($env:EXXPERTS_DIR) { return $env:EXXPERTS_DIR }
    return (Join-Path $HOME "exxperts")
}

# ---------------------------------------------------------------------------
# Archive install: the fast path. Downloads the prebuilt win-x64 release
# archive (app + vendored Node.js runtime), verifies its sha256 against the
# release's SHA256SUMS.txt, and unpacks it under
# $env:LOCALAPPDATA\Programs\exxperts. Running the app this way needs no Git,
# Node.js, or npm. Anything that stops this path makes the installer fall back
# to the source install below; EXXPERTS_INSTALL_METHOD=archive turns that
# fallback into a hard failure. The install never writes to $HOME\.exxperts:
# that is user state (rooms, memory, logins) and belongs to the app.
# ---------------------------------------------------------------------------

$script:ReleasesApiUrl = "https://api.github.com/repos/EXXETA/exxperts/releases?per_page=15"
$script:ArchiveFailReason = ""

# Turns a user-supplied local path (possibly relative or bare, e.g.
# "exxperts.zip") into an absolute one, or $null when it cannot. Everything is
# guarded: a malformed override must become the contract fallback, never a raw
# terminating error.
function Resolve-LocalArchivePath([string]$RawPath) {
    try {
        $resolved = $RawPath
        if (-not [System.IO.Path]::IsPathRooted($resolved)) {
            $resolved = Join-Path (Get-Location).Path $resolved
        }
        if (-not (Test-Path -LiteralPath $resolved)) { return $null }
        return (Get-Item -LiteralPath $resolved).FullName
    }
    catch { return $null }
}

function Get-ArchiveSource {
    # Returns @{ Archive = <url or path>; Sums = <url or path> }, or $null with
    # $script:ArchiveFailReason set.
    if ($env:EXXPERTS_ARCHIVE_URL) {
        try {
            $archive = $env:EXXPERTS_ARCHIVE_URL
            if ($archive -notmatch '^https?://') {
                $archive = Resolve-LocalArchivePath $archive
                if (-not $archive) {
                    $script:ArchiveFailReason = "EXXPERTS_ARCHIVE_URL points at a local file that does not exist: $($env:EXXPERTS_ARCHIVE_URL)"
                    return $null
                }
            }
            $sums = $env:EXXPERTS_SUMS_URL
            if (-not $sums) {
                if ($archive -match '^https?://') {
                    $sums = $archive -replace '/[^/]+$', '/SHA256SUMS.txt'
                }
                else {
                    $sums = Join-Path (Split-Path -Parent $archive) "SHA256SUMS.txt"
                }
            }
            return @{ Archive = $archive; Sums = $sums }
        }
        catch {
            $script:ArchiveFailReason = "could not resolve EXXPERTS_ARCHIVE_URL ($($env:EXXPERTS_ARCHIVE_URL))"
            return $null
        }
    }
    try {
        $releases = Invoke-RestMethod -Uri $script:ReleasesApiUrl -UseBasicParsing -TimeoutSec 60
    }
    catch {
        $script:ArchiveFailReason = "could not query the GitHub releases API"
        return $null
    }
    # The API returns releases newest first; take the newest one that ships a
    # win-x64 archive (prereleases included, deliberately, while the archive
    # channel is in beta) and derive SHA256SUMS.txt as its sibling, exactly
    # like install.sh. A release missing the sums file surfaces later as the
    # distinct "could not download the checksum file" fallback reason.
    foreach ($release in @($releases)) {
        $asset = @($release.assets) | Where-Object { $_.name -like "exxperts-*-win-x64.zip" } | Select-Object -First 1
        if (-not $asset) { continue }
        $sums = $asset.browser_download_url -replace '/[^/]+$', '/SHA256SUMS.txt'
        return @{ Archive = $asset.browser_download_url; Sums = $sums }
    }
    $script:ArchiveFailReason = "no published release has a win-x64 archive yet"
    return $null
}

# Fetches <Source> (an https URL, or a local file path mostly for CI and
# air-gapped installs via EXXPERTS_ARCHIVE_URL) to <Dest>.
function Get-ArchiveFile([string]$Source, [string]$Dest) {
    if ($Source -notmatch '^https?://') {
        try {
            if (-not (Test-Path -LiteralPath $Source)) {
                Say "file not found: $Source"
                return $false
            }
            Copy-Item -LiteralPath $Source -Destination $Dest -Force
            return $true
        }
        catch {
            Say "could not copy ${Source}: $($_.Exception.Message)"
            return $false
        }
    }
    # $ProgressPreference: Windows PowerShell 5.1 repaints the progress bar per
    # chunk, slowing large -OutFile downloads by an order of magnitude. Scoped
    # here and restored below.
    $oldProgress = $ProgressPreference
    $ProgressPreference = "SilentlyContinue"
    try {
        try {
            Invoke-WebRequest -Uri $Source -OutFile $Dest -UseBasicParsing
        }
        catch {
            Say "download failed once ($($_.Exception.Message)); retrying ..."
            Invoke-WebRequest -Uri $Source -OutFile $Dest -UseBasicParsing
        }
        return $true
    }
    catch {
        Say "download failed: $Source"
        Say ("  " + $_.Exception.Message)
        Say "If the error above mentions an SSL/TLS certificate, your company network inspects"
        Say "TLS: ask IT for the corporate root certificate and import it into the Windows"
        Say "certificate store (certmgr.msc, 'Trusted Root Certification Authorities');"
        Say "Invoke-WebRequest trusts the system store."
        return $false
    }
    finally {
        $ProgressPreference = $oldProgress
    }
}

# sha256 of a file via raw .NET, deliberately NOT Get-FileHash: that cmdlet
# lives in a script module which the default Restricted execution policy
# blocks from autoloading, so it would die raw on exactly the machines this
# installer targets. Assembly and type access are not gated by the policy.
function Get-Sha256([string]$Path) {
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            return ([System.BitConverter]::ToString($sha.ComputeHash($stream)) -replace "-", "").ToLowerInvariant()
        }
        finally { $sha.Dispose() }
    }
    finally { $stream.Dispose() }
}

# Zip extraction without Expand-Archive (script module, blocked under the
# Restricted policy, same story as Get-FileHash). Prefers the stock
# System32 tar.exe (ships with Windows 10 1803+ and handles zip), falls back
# to .NET's ZipFile. Throws on failure; the caller turns that into the
# contract fallback.
function Expand-ZipArchive([string]$ZipPath, [string]$Dest) {
    $sysDir = [Environment]::GetFolderPath([Environment+SpecialFolder]::System)
    if ($sysDir) {
        $tarExe = Join-Path $sysDir "tar.exe"
        if (Test-Path -LiteralPath $tarExe) {
            & $tarExe -xf $ZipPath -C $Dest
            if ($LASTEXITCODE -eq 0) { return }
            Say "tar.exe could not extract the archive; trying the built-in .NET extraction ..."
        }
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($ZipPath, $Dest)
}

# Prepends $Dir to the USER Path (persisted) and to this session's PATH, both
# only when not already present. Prepend, not append: %APPDATA%\npm usually
# precedes any new entry, and an appended dir would lose to a stale npm
# 'exxperts' shim in every NEW terminal. Returns $true when $Dir is (now) on
# the persisted user Path, $false when persisting failed.
function Add-DirToUserPath([string]$Dir) {
    $normalized = $Dir.TrimEnd("\")
    $persisted = $false
    try {
        # Raw registry access instead of [Environment]::Get/SetEnvironmentVariable:
        # the Environment API expands %VAR% references on read and writes plain
        # REG_SZ back, permanently corrupting entries like %OneDrive%\bin.
        # DoNotExpandEnvironmentNames plus preserving the value kind keeps the
        # user's Path byte-for-byte except for the one prepended entry.
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
        if (-not $key) { throw "HKCU\Environment is not available" }
        try {
            $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
            $userPath = ""
            if ($key.GetValueNames() -contains "Path") {
                $userPath = [string]$key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                $existingKind = $key.GetValueKind("Path")
                if ($existingKind -eq [Microsoft.Win32.RegistryValueKind]::String -or
                    $existingKind -eq [Microsoft.Win32.RegistryValueKind]::ExpandString) {
                    $kind = $existingKind
                }
            }
            $present = $false
            foreach ($entry in ($userPath -split ";")) {
                if ($entry.Trim().TrimEnd("\") -ieq $normalized) { $present = $true; break }
            }
            if ($present) {
                $persisted = $true
            }
            else {
                $newPath = if ($userPath.Trim()) { $Dir + ";" + $userPath.TrimStart(";") } else { $Dir }
                $key.SetValue("Path", $newPath, $kind)
                $persisted = $true
                Say "added $Dir to the front of your user PATH; new terminals pick it up automatically."
            }
        }
        finally { $key.Dispose() }
    }
    catch {
        Say "warning: could not persist $Dir to your user PATH ($($_.Exception.Message))."
        Say "Add it yourself (Settings > System > About > Advanced system settings >"
        Say "Environment Variables > User > Path), then open a new terminal."
    }
    $sessionPresent = $false
    foreach ($entry in ($env:Path -split ";")) {
        if ($entry.Trim().TrimEnd("\") -ieq $normalized) { $sessionPresent = $true; break }
    }
    # Prepend for this session so the new command wins over any stale npm shim.
    if (-not $sessionPresent) { $env:Path = "$Dir;$env:Path" }
    return $persisted
}

# Deletes leftover npm 'exxperts' shim files from $BinDir, best effort. npm's
# global bin dir on Windows is the prefix dir itself (usually %APPDATA%\npm).
function Remove-StaleNpmShims([string]$BinDir) {
    foreach ($name in @("exxperts.cmd", "exxperts.ps1", "exxperts")) {
        $shim = Join-Path $BinDir $name
        if (Test-Path -LiteralPath $shim) {
            try {
                Remove-Item -LiteralPath $shim -Force
                Say "removed stale npm shim $shim"
            }
            catch {
                Say "warning: could not remove the stale npm shim $shim."
                Say "Delete it yourself, or it will keep shadowing the new 'exxperts' in new terminals."
            }
        }
    }
}

# After a verified install: carry settings (.env) over from the old npm-based
# global install or the old clone, then remove the old install so a stale
# 'exxperts' shim earlier on PATH cannot shadow the new command. Best effort;
# a failure here never fails the install. Every skip prints a warning naming
# the shim dir: a silently kept shim in %APPDATA%\npm would win over the new
# command in every new terminal. With -PathReady:$false (the new bin dir could
# not be persisted to the user Path) the old install is deliberately kept, so
# the user is never left without a resolvable 'exxperts'.
function Remove-OldNpmInstall([string]$NewTree, [bool]$PathReady) {
    $npmBinDir = if ($env:APPDATA) { Join-Path $env:APPDATA "npm" } else { "" }
    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
        if ($npmBinDir -and (Test-Path -LiteralPath (Join-Path $npmBinDir "exxperts.cmd")) -and $PathReady) {
            Say "npm is not available, but old 'exxperts' shims exist in $npmBinDir; removing them."
            Remove-StaleNpmShims $npmBinDir
        }
        return
    }
    $prefix = ""
    # 'npm prefix -g', not 'npm config get prefix': npm 11.11+ refuses to
    # print protected config values that were set via the environment.
    try { $prefix = (& npm.cmd prefix -g | Out-String).Trim() } catch {}
    if (-not $prefix) {
        Say "warning: could not determine npm's global prefix, so an old npm-based 'exxperts'"
        Say "cannot be cleaned up. If new terminals still run an old version, delete the"
        Say "exxperts shims (exxperts.cmd, exxperts.ps1, exxperts) in $npmBinDir yourself."
        if ($npmBinDir -and $PathReady) { Remove-StaleNpmShims $npmBinDir }
        return
    }
    $binDir = $prefix
    $installedRoot = Join-Path $prefix ("node_modules\" + ($script:PkgName -replace "/", "\"))
    $altInstalledRoot = Join-Path $prefix ("lib\node_modules\" + ($script:PkgName -replace "/", "\"))
    $oldRoot = ""
    if (Test-Path -LiteralPath $installedRoot) { $oldRoot = $installedRoot }
    elseif (Test-Path -LiteralPath $altInstalledRoot) { $oldRoot = $altInstalledRoot }

    # Inherit settings BEFORE the uninstall deletes the old copy: prefer the
    # old global install's .env, else the clone's. Never overwrite an existing
    # new app\.env.
    $newEnv = Join-Path $NewTree "app\.env"
    if (-not (Test-Path -LiteralPath $newEnv)) {
        $envSrc = ""
        if ($oldRoot -and (Test-Path -LiteralPath (Join-Path $oldRoot ".env"))) {
            $envSrc = Join-Path $oldRoot ".env"
        }
        elseif ((Test-ExxpertsClone (Join-Path $HOME "exxperts")) -and (Test-Path -LiteralPath (Join-Path $HOME "exxperts\.env"))) {
            $envSrc = Join-Path $HOME "exxperts\.env"
        }
        if ($envSrc) {
            try {
                Copy-Item -LiteralPath $envSrc -Destination $newEnv
                Say "carried your settings forward: copied $envSrc to $newEnv."
            }
            catch {}
        }
    }

    if (-not $oldRoot) {
        # Package dir gone but shim files can survive a broken uninstall and
        # keep shadowing the new command.
        if ((Test-Path -LiteralPath (Join-Path $binDir "exxperts.cmd")) -or
            (Test-Path -LiteralPath (Join-Path $binDir "exxperts.ps1")) -or
            (Test-Path -LiteralPath (Join-Path $binDir "exxperts"))) {
            if ($PathReady) {
                Say "found stale 'exxperts' shims in $binDir without their package; removing them."
                Remove-StaleNpmShims $binDir
            }
            else {
                Say "warning: old 'exxperts' shims exist in $binDir but were kept, because the new"
                Say "install dir could not be added to your user Path. Fix the Path first (see above),"
                Say "then re-run this install command."
            }
        }
        return
    }
    if (-not $PathReady) {
        Say "IMPORTANT: the new install dir could not be added to your user Path, so removing"
        Say "the old npm-based install now would leave you with NO working 'exxperts' command"
        Say "in new terminals. The old install in $binDir was kept for now."
        Say "Add the new dir to your Path (see above), then re-run this install command;"
        Say "it will then remove the old npm-based install."
        return
    }
    Say "removing the old npm-based global install ..."
    & npm.cmd uninstall -g $script:PkgName
    if ($LASTEXITCODE -ne 0) {
        Say "warning: could not remove the old npm global install of $script:PkgName."
        Say "Run 'npm uninstall -g $script:PkgName' yourself when convenient. Its stale shims in"
        Say "$binDir are removed now so they cannot shadow the new 'exxperts' command:"
        Remove-StaleNpmShims $binDir
    }
    else {
        # npm sometimes leaves the shim files behind; make sure they are gone.
        Remove-StaleNpmShims $binDir
    }
}

# The whole archive path. Returns $false (with $script:ArchiveFailReason set)
# to request the source fallback; only user-actionable states (a locked
# install) fail hard, because falling back would not fix them.
function Install-FromArchive {
    if (-not $env:LOCALAPPDATA) {
        $script:ArchiveFailReason = "LOCALAPPDATA is not set"
        return $false
    }
    # GitHub requires TLS 1.2+; Windows PowerShell 5.1 does not enable it by
    # default for .NET web requests.
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    }
    catch {}

    $source = Get-ArchiveSource
    if (-not $source) { return $false }

    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("exxperts-install-" + [System.IO.Path]::GetRandomFileName())
    try {
        New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    }
    catch {
        $script:ArchiveFailReason = "could not create a temp directory"
        return $false
    }
    try {
        $archiveName = Split-Path -Leaf $source.Archive
        $archivePath = Join-Path $tmp $archiveName
        $sumsPath = Join-Path $tmp "SHA256SUMS.txt"

        Say "downloading $archiveName ..."
        if (-not (Get-ArchiveFile $source.Archive $archivePath)) {
            $script:ArchiveFailReason = "could not download the release archive"
            return $false
        }
        if (-not (Get-ArchiveFile $source.Sums $sumsPath)) {
            $script:ArchiveFailReason = "could not download the checksum file"
            return $false
        }

        $expected = ""
        foreach ($line in (Get-Content $sumsPath)) {
            $parts = $line.Trim() -split "\s+", 2
            if ($parts.Count -eq 2 -and $parts[1].TrimStart("*") -eq $archiveName) {
                $expected = $parts[0].ToLower()
                break
            }
        }
        if (-not $expected) {
            $script:ArchiveFailReason = "SHA256SUMS.txt has no entry for $archiveName"
            return $false
        }
        $actual = ""
        try {
            $actual = Get-Sha256 $archivePath
        }
        catch {
            $script:ArchiveFailReason = "could not compute the download's checksum ($($_.Exception.Message))"
            return $false
        }
        if ($actual -ne $expected) {
            Say "WARNING: checksum mismatch for $archiveName (expected $expected, got $actual)."
            Say "WARNING: the download may be corrupted or tampered with; not installing it."
            $script:ArchiveFailReason = "checksum verification failed"
            return $false
        }
        Say "checksum verified."

        $base = Join-Path $env:LOCALAPPDATA "Programs\exxperts"
        $tree = Join-Path $base "exxperts"
        $binDir = Join-Path $base "bin"
        try {
            New-Item -ItemType Directory -Path $base -Force | Out-Null
        }
        catch {
            $script:ArchiveFailReason = "could not create $base"
            return $false
        }

        # One install at a time: a directory is the mutex (creating it without
        # -Force is atomic and throws when it exists). The finally below
        # releases it on every exit, including the hard Fails.
        $lockDir = Join-Path $base ".install-lock"
        try {
            New-Item -ItemType Directory -Path $lockDir -ErrorAction Stop | Out-Null
        }
        catch {
            Fail ("another exxperts install appears to be running (lock: $lockDir).`n" +
                "If it is not, remove that directory and re-run this command.")
        }
        try {
            # Self-heal after an interrupted previous run: if the live tree is
            # gone but a renamed-aside copy survived (a kill window between
            # 'move aside' and 'restore or delete'), restore the newest one
            # before deciding fresh-vs-update. Then sweep remaining orphans so
            # they cannot accumulate or resurface a stale app\.env later.
            if (-not (Test-Path -LiteralPath $tree)) {
                $aside = @(Get-ChildItem -LiteralPath $base -Directory -Force -ErrorAction SilentlyContinue |
                    Where-Object { $_.Name -like ".old-*" -or $_.Name -like "*.update-probe" } |
                    Sort-Object LastWriteTime -Descending)
                if ($aside.Count -gt 0) {
                    Say "restoring the previous install left aside by an interrupted update ($($aside[0].FullName)) ..."
                    try { Move-Item -LiteralPath $aside[0].FullName $tree } catch {}
                }
            }
            # Sweep only when a live tree exists: if the restore above failed,
            # the aside copy is the only surviving install (and app\.env).
            if (Test-Path -LiteralPath $tree) {
                foreach ($orphan in @(Get-ChildItem -LiteralPath $base -Force -ErrorAction SilentlyContinue |
                    Where-Object { $_.Name -like ".staging-*" -or $_.Name -like ".old-*" -or $_.Name -like "*.update-probe" })) {
                    Remove-Item -LiteralPath $orphan.FullName -Recurse -Force -ErrorAction SilentlyContinue
                }
            }

            # Windows locks files a running app holds open, so replacing the
            # install fails with EBUSY halfway through. Probe the exact operation
            # that breaks (a rename round-trip of the installed dir) BEFORE the
            # extract, and name the real fix: close exxperts first.
            $lockedMessage = ("the installed app at $tree is locked, which usually means exxperts is still running.`n" +
                "Close the exxperts app and any terminal running it, then re-run this command.`n" +
                "If it keeps failing with exxperts closed, an antivirus may be scanning that folder;`n" +
                "add an exclusion for $base and re-run.")
            if (Test-Path -LiteralPath $tree) {
                $probeTarget = "$tree.update-probe"
                $renamedAway = $false
                try {
                    Move-Item -LiteralPath $tree $probeTarget
                    $renamedAway = $true
                    Move-Item -LiteralPath $probeTarget $tree
                    $renamedAway = $false
                }
                catch {
                    if ($renamedAway) {
                        try { Move-Item -LiteralPath $probeTarget $tree; $renamedAway = $false } catch {}
                    }
                    if ($renamedAway) {
                        Fail ("the installed app could not be restored after an update probe.`n" +
                            "Rename `"$probeTarget`" back to `"$tree`" by hand, then re-run this command.")
                    }
                    Fail $lockedMessage
                }
            }

            Say "unpacking to $tree ..."
            $staging = Join-Path $base (".staging-" + [System.IO.Path]::GetRandomFileName())
            try {
                New-Item -ItemType Directory -Path $staging -Force | Out-Null
                Expand-ZipArchive $archivePath $staging
            }
            catch {
                Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
                $script:ArchiveFailReason = "could not extract the archive"
                return $false
            }
            $newTree = Join-Path $staging "exxperts"
            if (-not (Test-Path -LiteralPath (Join-Path $newTree "exxperts.cmd"))) {
                Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
                $script:ArchiveFailReason = "unexpected archive layout (no exxperts\exxperts.cmd inside)"
                return $false
            }

            # Update in place: keep the old tree around (renamed aside) until the
            # new one passes its self-check, and carry the user's app\.env forward.
            # A rename that throws here, right after the probe above succeeded,
            # is the same locked-tree condition; falling back to a 3 GB source
            # build would not fix it, so it is the probe's hard failure instead.
            $old = ""
            if (Test-Path -LiteralPath $tree) {
                Say "updating existing install in $tree ..."
                $old = Join-Path $base (".old-" + [System.IO.Path]::GetRandomFileName())
                try {
                    Move-Item -LiteralPath $tree $old
                }
                catch {
                    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
                    Fail $lockedMessage
                }
                # Read app\.env from the aside-moved tree itself, not a pre-move
                # snapshot: what a failure would restore is exactly what was read.
                $envFile = Join-Path $old "app\.env"
                if ((Test-Path -LiteralPath $envFile) -and -not (Test-Path -LiteralPath (Join-Path $newTree "app\.env"))) {
                    try { Copy-Item -LiteralPath $envFile -Destination (Join-Path $newTree "app\.env") } catch {}
                }
            }
            try {
                Move-Item -LiteralPath $newTree $tree
            }
            catch {
                if ($old) {
                    try { Move-Item -LiteralPath $old $tree } catch {}
                    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
                    Fail $lockedMessage
                }
                Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
                $script:ArchiveFailReason = "could not move the new install into place"
                return $false
            }
            Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue

            # Only <base>\bin goes on PATH, never the tree root: every .cmd at
            # the tree root would otherwise become a global command. The
            # wrapper is written before the self-check so a failure can still
            # clean up or restore a consistent state.
            $wrapperOk = $true
            try {
                New-Item -ItemType Directory -Path $binDir -Force | Out-Null
                $wrapperBody = "@echo off`r`ncall `"%~dp0..\exxperts\exxperts.cmd`" %*`r`nexit /b %ERRORLEVEL%`r`n"
                [System.IO.File]::WriteAllText((Join-Path $binDir "exxperts.cmd"), $wrapperBody, [System.Text.Encoding]::ASCII)
            }
            catch { $wrapperOk = $false }
            if (-not $wrapperOk) {
                Remove-Item -LiteralPath $tree -Recurse -Force -ErrorAction SilentlyContinue
                if ($old) { try { Move-Item -LiteralPath $old $tree } catch {} }
                else { Remove-Item -LiteralPath $binDir -Recurse -Force -ErrorAction SilentlyContinue }
                $script:ArchiveFailReason = "could not create the launcher in $binDir"
                return $false
            }

            # Self-check: the installed launcher must run and report the version
            # packed into the archive, before the old tree is deleted.
            $version = ""
            try { $version = (Get-Content (Join-Path $tree "app\package.json") -Raw | ConvertFrom-Json).version } catch {}
            $reported = ""
            try { $reported = (& (Join-Path $tree "exxperts.cmd") --version | Out-String).Trim() } catch {}
            $selfCheckOk = if ($version) { $reported -eq "exxperts $version" } else { $reported -like "exxperts *" }
            if (-not $selfCheckOk) {
                Say "the installed app failed its self-check (expected 'exxperts $version', got '$reported')."
                Remove-Item -LiteralPath $tree -Recurse -Force -ErrorAction SilentlyContinue
                if ($old) { try { Move-Item -LiteralPath $old $tree } catch {} }
                else { Remove-Item -LiteralPath $binDir -Recurse -Force -ErrorAction SilentlyContinue }
                $script:ArchiveFailReason = "the installed app failed its self-check"
                return $false
            }
            if ($old) { Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue }
        }
        finally {
            Remove-Item -LiteralPath $lockDir -Force -ErrorAction SilentlyContinue
        }

        $pathReady = Add-DirToUserPath $binDir

        Remove-OldNpmInstall $tree $pathReady
        if (Test-ExxpertsClone (Join-Path $HOME "exxperts")) {
            Say "note: the source clone at $HOME\exxperts is no longer needed to run exxperts."
            Say "Keep it for development, or delete it by hand if you want the space back."
        }

        Say ""
        Say "all set. Start exxperts with:"
        Say ""
        Say "  exxperts web"
        Say ""
        $versionShown = if ($version) { $version } else { "unknown" }
        Say "Installed version: $versionShown (check anytime with: exxperts --version)"
        Say "To update later, just run this same install command again."
        Say "Installed to: $tree (prebuilt archive)"
        Say "Your rooms, memory, and logins live in $HOME\.exxperts and are untouched."
        return $true
    }
    finally {
        Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# ---------------------------------------------------------------------------
# Source install: the original flow, unchanged. Runs when EXXPERTS_DIR points
# at a checkout, when EXXPERTS_INSTALL_METHOD=source, or as the fallback when
# the archive path cannot finish.
# ---------------------------------------------------------------------------

function Install-FromSource {
    Test-Prerequisites

    $dir = Resolve-InstallDir

    Test-Network
    Test-DiskSpace $dir

    if (Test-ExxpertsClone $dir) {
        Update-Clone $dir
    }
    elseif (Test-Path $dir) {
        Fail ("$dir already exists but is not an exxperts clone. Move it out of the way,`n" +
            "or pick another directory: set EXXPERTS_DIR to another path and re-run this command.")
    }
    else {
        Say "cloning $script:RepoUrl into $dir ..."
        # Repo-local Git settings from the README's Windows quickstart: long
        # paths (node_modules trees exceed MAX_PATH) and no CRLF rewriting
        # (the repo's .gitattributes manages line endings). Scoped to this
        # clone only; your global Git config is not touched.
        & git clone -c core.longpaths=true -c core.autocrlf=false $script:RepoUrl $dir
        if ($LASTEXITCODE -ne 0) {
            Fail ("git clone failed. Check your network connection (and proxy settings, if any), then re-run`n" +
                "this command. If the error above mentions an SSL certificate, your company network inspects`n" +
                "TLS: ask IT for the corporate root certificate (a .pem file) and point git at it with`n" +
                "  git config --global http.sslCAInfo C:\path\to\corp-root.pem")
        }
    }

    Push-Location $dir
    try {
        Say "installing dependencies (npm install) ..."
        & npm.cmd install
        if ($LASTEXITCODE -ne 0) {
            Fail ("npm install failed. From $dir, run 'npm run doctor'; it checks every layer and prints the fix.`n" +
                "If the error above mentions EPERM, EBUSY, or a file in use: close exxperts if it is`n" +
                "running (Windows locks its files while it runs), then re-run this command. If it keeps`n" +
                "failing with exxperts closed, an antivirus may be scanning the install; add an`n" +
                "exclusion for $dir and re-run.`n" +
                "If it mentions a certificate (UNABLE_TO_VERIFY_LEAF_SIGNATURE, SELF_SIGNED_CERT_IN_CHAIN),`n" +
                "your company network inspects TLS: ask IT for the corporate root certificate (a .pem file),`n" +
                "then run this first and re-run the install command in the same window:`n" +
                "  `$env:NODE_EXTRA_CA_CERTS = 'C:\path\to\corp-root.pem'")
        }

        Say "building and installing the exxperts command (npm run install:global) ..."
        Say "this builds the whole app; give it a few minutes."
        & npm.cmd run install:global
        if ($LASTEXITCODE -ne 0) {
            Fail ("the build-and-install step failed. From $dir, run 'npm run doctor'; it checks every layer and prints the fix.`n" +
                "If the error above mentions EPERM, EBUSY, or a file in use: close exxperts if it is`n" +
                "running (Windows locks its files while it runs), then re-run this command. If it keeps`n" +
                "failing with exxperts closed, an antivirus may be scanning the install; add an`n" +
                "exclusion for $dir and re-run.")
        }

        $script:InstalledVersion = ""
        try { $script:InstalledVersion = (& node -p "require('./package.json').version").Trim() } catch {}
    }
    finally {
        Pop-Location
    }

    if (-not (Get-Command exxperts.cmd -ErrorAction SilentlyContinue)) {
        $npmPrefix = (& npm.cmd config get prefix).Trim()
        Say "exxperts installed, but the 'exxperts' command is not on your PATH yet."
        Say "npm's global bin directory is: $npmPrefix"
        Say "Add it to your PATH (Settings > System > About > Advanced system settings > Environment Variables),"
        Say "then open a new terminal."
    }

    # With the default Restricted policy, `exxperts` in PowerShell resolves to
    # npm's .ps1 shim and is refused. One-time, current-user-only fix below;
    # cmd.exe and `exxperts.cmd` work either way. The documented one-liner runs
    # this script under a process-scope Bypass, so the effective policy here
    # says nothing about the user's NEXT session; inspect the persistent
    # scopes instead (both Undefined means the Restricted default applies).
    $userPolicy = Get-ExecutionPolicy -Scope CurrentUser
    $machinePolicy = Get-ExecutionPolicy -Scope LocalMachine
    $policy = if ($userPolicy -ne "Undefined") { $userPolicy } else { $machinePolicy }
    if ($policy -in @("Restricted", "AllSigned", "Undefined")) {
        if ($policy -eq "Undefined") { $policy = "Restricted, the default" }
        Say ""
        Say "One more thing: your PowerShell execution policy ($policy) blocks npm-installed"
        Say "commands like 'exxperts'. Allow them for your user with:"
        Say ""
        Say "  Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser"
        Say ""
        Say "then open a new terminal. (Alternatively, run 'exxperts.cmd' or use cmd.exe.)"
    }

    Say ""
    Say "all set. Start exxperts with:"
    Say ""
    Say "  exxperts web"
    Say ""
    $versionShown = if ($script:InstalledVersion) { $script:InstalledVersion } else { "unknown" }
    Say "Installed version: $versionShown (check anytime with: exxperts --version)"
    Say "To update later, just run this same install command again."
    Say "Installed from: $dir"
}

function Install-Exxperts {
    Say "official exxperts installer"

    # -eq on strings is case-insensitive in PowerShell, matching install.sh's
    # normalized comparison.
    $method = if ($env:EXXPERTS_INSTALL_METHOD) { $env:EXXPERTS_INSTALL_METHOD } else { "" }

    # EXXPERTS_DIR selects the source flow, EXXPERTS_INSTALL_METHOD=archive
    # rules it out: setting both is a contradiction, not a preference.
    if ($env:EXXPERTS_DIR -and $method -eq "archive") {
        Fail ("EXXPERTS_DIR and EXXPERTS_INSTALL_METHOD=archive contradict each other:`n" +
            "EXXPERTS_DIR means 'install from this checkout' (the source flow), while`n" +
            "EXXPERTS_INSTALL_METHOD=archive rules the source flow out.`n" +
            "Unset one of the two variables and re-run this command.")
    }

    # EXXPERTS_DIR set means "install from this checkout" (developers, CI):
    # the source flow runs exactly as before.
    if (-not $env:EXXPERTS_DIR -and $method -ne "source") {
        if (Install-FromArchive) { return }
        $reason = if ($script:ArchiveFailReason) { $script:ArchiveFailReason } else { "unknown reason" }
        if ($method -eq "archive") {
            Fail "archive install failed ($reason), and EXXPERTS_INSTALL_METHOD=archive rules out the source fallback."
        }
        Say "archive install unavailable ($reason); falling back to the source install."
    }
    Install-FromSource
}

Install-Exxperts
