# Official exxperts one-line installer (Windows PowerShell):
#
#   irm https://raw.githubusercontent.com/EXXETA/exxperts/main/install.ps1 | iex
#
# What it does: checks prerequisites (Git for Windows with Git Bash, Node.js),
# clones the repo into $HOME\exxperts (override with EXXPERTS_DIR), then runs
# `npm install` and `npm run install:global`. Re-running the same command
# updates an existing install. exxperts is source-distributed, so the install
# builds the app locally; give it a few minutes.
#
# Env overrides:
#   EXXPERTS_DIR   install directory (default: $HOME\exxperts)
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
        Fail "git is not installed. Install Git for Windows 2.40 or newer from https://gitforwindows.org, then re-run this command."
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
        Fail "Node.js is not installed. Install Node.js 20.6 or newer from https://nodejs.org, then re-run this command."
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

function Install-Exxperts {
    Say "official exxperts installer"
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
            Fail "git clone failed. Check your network connection (and proxy settings, if any), then re-run this command."
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
                "exclusion for $dir and re-run.")
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
    # cmd.exe and `exxperts.cmd` work either way.
    $policy = Get-ExecutionPolicy
    if ($policy -in @("Restricted", "AllSigned", "Undefined")) {
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
    Say "To update later, just run this same install command again."
    Say "Installed from: $dir"
}

Install-Exxperts
