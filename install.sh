#!/usr/bin/env bash
# Official exxperts one-line installer (macOS / Linux):
#
#   curl -fsSL https://raw.githubusercontent.com/EXXETA/exxperts/main/install.sh | bash
#
# What it does: downloads the prebuilt release archive for this machine
# (app + vendored Node.js runtime, no git/Node/npm needed), verifies its
# checksum, and unpacks it under ~/.local/share/exxperts. When no prebuilt
# archive fits (other platforms, blocked download, ...), it falls back to the
# source install: check prerequisites (git, Node.js), clone the repo into
# ~/exxperts (override with EXXPERTS_DIR), then run `npm install` and
# `npm run install:global`. Re-running the same command updates an existing
# install either way.
#
# Env overrides:
#   EXXPERTS_INSTALL_METHOD  unset: archive first, source fallback.
#                            "source": skip the archive path entirely.
#                            "archive": archive only; fail instead of falling back.
#   EXXPERTS_ARCHIVE_URL     direct archive URL or local file path; skips the
#                            GitHub release lookup.
#   EXXPERTS_SUMS_URL        matching SHA256SUMS.txt URL or local file path
#                            (default: SHA256SUMS.txt next to the archive).
#   EXXPERTS_DIR   source-install directory (default: ~/exxperts). Setting it
#                  means "install from this checkout": the archive path is
#                  skipped and the source flow runs as before.
#   EXXPERTS_REPO  clone URL (default: https://github.com/EXXETA/exxperts.git)
set -euo pipefail

REPO_URL="${EXXPERTS_REPO:-https://github.com/EXXETA/exxperts.git}"
PKG_NAME="@exxeta/exxperts-app"

say() { printf '[exxperts] %s\n' "$*"; }
fail() { printf '[exxperts] %s\n' "$*" >&2; exit 1; }

# True when $1 is the root of an exxperts clone.
is_exxperts_clone() {
	[ -f "$1/package.json" ] && grep -q "\"name\": \"$PKG_NAME\"" "$1/package.json"
}

check_prerequisites() {
	if ! command -v git >/dev/null 2>&1; then
		fail "git is not installed. Install it from https://git-scm.com (macOS: 'xcode-select --install' also works), then re-run this command."
	fi
	if ! command -v node >/dev/null 2>&1; then
		fail "Node.js is not installed. Install Node.js 20.6 or newer from https://nodejs.org, then re-run this command."
	fi
	if ! command -v npm >/dev/null 2>&1; then
		fail "npm is not installed. It normally ships with Node.js; reinstall Node.js from https://nodejs.org, then re-run this command."
	fi

	local node_version node_major node_minor node_patch
	node_version="$(node --version)"
	node_version="${node_version#v}"
	IFS=. read -r node_major node_minor node_patch <<EOF
$node_version
EOF
	node_major=${node_major:-0}; node_minor=${node_minor:-0}; node_patch=${node_patch:-0}

	if [ "$node_major" -lt 20 ] || { [ "$node_major" -eq 20 ] && [ "$node_minor" -lt 6 ]; }; then
		fail "Node.js $node_version is too old; exxperts needs Node.js 20.6 or newer. Update it from https://nodejs.org, then re-run this command."
	fi

	# npm 12 refuses to run on Node versions outside its own engines range
	# (^22.22.2 || ^24.15.0 || >=26). Catch that mismatch here, before minutes
	# of cloning and building, instead of letting npm hard-fail mid-install.
	local npm_major
	npm_major="$(npm --version | cut -d. -f1)"
	if [ "${npm_major:-0}" -ge 12 ]; then
		local node_ok=0
		if [ "$node_major" -ge 26 ]; then node_ok=1; fi
		if [ "$node_major" -eq 24 ] && [ "$node_minor" -ge 15 ]; then node_ok=1; fi
		if [ "$node_major" -eq 22 ] && { [ "$node_minor" -gt 22 ] || { [ "$node_minor" -eq 22 ] && [ "$node_patch" -ge 2 ]; }; }; then node_ok=1; fi
		if [ "$node_ok" -ne 1 ]; then
			fail "You have npm $(npm --version), which requires Node.js 22.22.2+, 24.15.0+ (within 24.x), or 26+, but Node.js $node_version is installed. Update Node.js from https://nodejs.org, then re-run this command."
		fi
	fi
}

# Fail early, with a plain-language message, when the network cannot reach the
# repo host at all (offline, DNS broken, firewall). curl honors the same
# HTTPS_PROXY environment as git, so a working proxy setup passes this probe.
check_network() {
	local host
	host="$(printf '%s' "$REPO_URL" | sed -E 's#^[a-z+]+://##; s#^[^/@]*@##; s#[:/].*$##')"
	[ -n "$host" ] || return 0
	if ! curl -sSI -o /dev/null --max-time 20 "https://$host" 2>/dev/null; then
		local proxy_state="no proxy variables are set"
		[ -n "${HTTPS_PROXY:-}${https_proxy:-}" ] && proxy_state="HTTPS_PROXY is set to '${HTTPS_PROXY:-$https_proxy}'"
		fail "cannot reach https://$host, so the install cannot download anything.
[exxperts] Check your internet connection. If this network needs a proxy, set it first
[exxperts] (currently $proxy_state), e.g.:
[exxperts]   export HTTPS_PROXY=http://proxy.your-company.com:8080
[exxperts] then re-run this command."
	fi
}

# A fresh install writes roughly 3 GB: the clone with node_modules, the npm
# cache, and a second copy under the global npm prefix. Say so up front
# instead of letting npm die minutes in with a confusing ENOSPC.
check_disk_space() {
	local target="$1" probe avail_kb
	probe="$target"
	[ -e "$probe" ] || probe="$(dirname "$probe")"
	[ -e "$probe" ] || probe="$HOME"
	avail_kb="$(df -Pk "$probe" 2>/dev/null | awk 'NR==2 {print $4}')"
	case "$avail_kb" in ''|*[!0-9]*) return 0;; esac
	if [ "$avail_kb" -lt 1048576 ]; then
		fail "not enough free disk space: $((avail_kb / 1024)) MB available where $target lives,
[exxperts] but a fresh install needs about 3 GB (clone, build, npm cache, installed copy).
[exxperts] Free up some space, then re-run this command."
	fi
	if [ "$avail_kb" -lt 4194304 ]; then
		say "heads up: only $((avail_kb / 1048576)) GB free where $target lives; a fresh install uses about 3 GB."
	fi
}

# Bring an existing clone up to date. Skips quietly when the clone has no
# upstream branch to pull from (e.g. a CI checkout on a detached commit).
update_clone() {
	local dir="$1"
	if ! git -C "$dir" rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
		say "no upstream branch configured in $dir; skipping the update pull."
		return 0
	fi
	say "updating existing clone in $dir ..."
	if ! git -C "$dir" pull --ff-only; then
		fail "could not update $dir: the clone has local changes or has diverged from the remote.
[exxperts] Either commit/stash your changes and run 'git pull' there yourself,
[exxperts] or install into a fresh directory: EXXPERTS_DIR=~/exxperts-fresh and re-run this command.
[exxperts] This installer never overwrites local work."
	fi
}

resolve_install_dir() {
	# Running from inside an exxperts clone (e.g. re-running the installer from
	# the install directory) reuses that clone.
	if is_exxperts_clone "$PWD"; then
		printf '%s' "$PWD"
		return 0
	fi
	printf '%s' "${EXXPERTS_DIR:-$HOME/exxperts}"
}

# ---------------------------------------------------------------------------
# Archive install: the fast path. Downloads the prebuilt release archive for
# this machine (app + vendored Node.js runtime), verifies its sha256 against
# the release's SHA256SUMS.txt, and unpacks it under ~/.local/share/exxperts.
# Running the app this way needs no git, Node.js, or npm. Anything that stops
# this path makes the installer fall back to the source install below;
# EXXPERTS_INSTALL_METHOD=archive turns that fallback into a hard failure.
# The install never writes to ~/.exxperts: that is user state (rooms, memory,
# logins) and belongs to the app, not the installer.
# ---------------------------------------------------------------------------

RELEASES_API_URL="https://api.github.com/repos/EXXETA/exxperts/releases?per_page=15"
ARCHIVE_FAIL_REASON=""
ARCHIVE_URL=""
ARCHIVE_SUMS_URL=""
ARCHIVE_TMP_DIR=""
ARCHIVE_LOCK_DIR=""

archive_cleanup() {
	[ -n "$ARCHIVE_TMP_DIR" ] && rm -rf "$ARCHIVE_TMP_DIR"
	[ -n "$ARCHIVE_LOCK_DIR" ] && rmdir "$ARCHIVE_LOCK_DIR" 2>/dev/null
	return 0
}
trap archive_cleanup EXIT

# Releases the install mutex taken in try_archive_install. Safe to call twice;
# the EXIT trap covers hard-fail paths.
release_install_lock() {
	[ -n "$ARCHIVE_LOCK_DIR" ] && rmdir "$ARCHIVE_LOCK_DIR" 2>/dev/null
	ARCHIVE_LOCK_DIR=""
	return 0
}

# Prints the release target name for this machine, matching the archive names
# the release workflow publishes. Platforms without a prebuilt archive return
# nonzero and take the source path; that fallback IS the support story there.
archive_target() {
	case "$(uname -s)-$(uname -m)" in
		Darwin-arm64) printf 'darwin-arm64' ;;
		Linux-x86_64) printf 'linux-x64' ;;
		*) return 1 ;;
	esac
}

say_curl_tls_hint() {
	say "If the error above mentions an SSL certificate, your company network inspects TLS:"
	say "ask IT for the corporate root certificate (a .pem file) and point curl at it, then"
	say "re-run this command in the same terminal:"
	say "  export CURL_CA_BUNDLE=/path/to/corp-root.pem"
}

# fetch_asset <source> <dest>: <source> is an https URL or a local file path
# (the latter mostly for CI and air-gapped installs via EXXPERTS_ARCHIVE_URL).
fetch_asset() {
	local src="$1" dest="$2"
	case "$src" in
		http://*|https://*)
			if ! command -v curl >/dev/null 2>&1; then
				say "curl is not installed, so $src cannot be downloaded."
				return 1
			fi
			if ! curl -fSL --retry 2 --connect-timeout 20 -o "$dest" "$src"; then
				say "download failed: $src"
				say_curl_tls_hint
				return 1
			fi
			;;
		*)
			[ -f "$src" ] || { say "file not found: $src"; return 1; }
			cp "$src" "$dest" || return 1
			;;
	esac
}

# Sets ARCHIVE_URL and ARCHIVE_SUMS_URL for this machine's target, either from
# the env overrides or from the newest GitHub release that ships the target
# archive (prereleases included, deliberately, while the archive channel is in
# beta). Sets ARCHIVE_FAIL_REASON and returns nonzero when it cannot.
resolve_archive_urls() {
	local target="$1"
	if [ -n "${EXXPERTS_ARCHIVE_URL:-}" ]; then
		ARCHIVE_URL="$EXXPERTS_ARCHIVE_URL"
		ARCHIVE_SUMS_URL="${EXXPERTS_SUMS_URL:-$(dirname "$ARCHIVE_URL")/SHA256SUMS.txt}"
		return 0
	fi
	if ! command -v curl >/dev/null 2>&1; then
		ARCHIVE_FAIL_REASON="curl is not installed"
		return 1
	fi
	local releases
	if ! releases="$(curl -fsSL --max-time 60 "$RELEASES_API_URL")"; then
		ARCHIVE_FAIL_REASON="could not query the GitHub releases API"
		return 1
	fi
	# The API returns releases newest first, so the first download URL matching
	# this target belongs to the newest release that ships it.
	ARCHIVE_URL="$(printf '%s' "$releases" \
		| grep -o '"browser_download_url": *"[^"]*"' \
		| cut -d'"' -f4 \
		| grep -- "-$target\.\(tar\.gz\|zip\)$" \
		| head -n 1)"
	if [ -z "$ARCHIVE_URL" ]; then
		ARCHIVE_FAIL_REASON="no published release has a $target archive yet"
		return 1
	fi
	ARCHIVE_SUMS_URL="$(dirname "$ARCHIVE_URL")/SHA256SUMS.txt"
}

sha256_of() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk '{print $1}'
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$1" | awk '{print $1}'
	else
		return 1
	fi
}

# After a verified install: carry settings (.env) over from the old npm-based
# global install or the old clone, then remove the old npm-based global
# install so a stale 'exxperts' shim earlier on PATH cannot shadow the new
# command. Best effort; a failure here never fails the install. When
# ~/.local/bin is NOT on PATH the old install is deliberately kept (removing
# it would leave no resolvable 'exxperts' in new terminals); re-running the
# installer after fixing PATH completes the migration.
# PATH self-service: the one-liner promises a working `exxperts` command, so
# when ~/.local/bin is missing from PATH the installer appends the export line
# to the user's shell startup file itself, exactly once (a marker comment makes
# re-runs a no-op, and a pre-existing .local/bin line is respected). Opt out
# with EXXPERTS_NO_MODIFY_PATH=1. A child process can never fix the CURRENT
# shell's PATH, so the closing message asks for a new terminal instead of
# claiming "all set" beside a command that would not resolve.
# PATH_STATE after the call: active (usable in this terminal), appended (usable
# after a new terminal / source), manual (user must add it themselves).
PATH_STATE="active"
PATH_RC_FILE=""
ensure_local_bin_on_path() {
	case ":$PATH:" in
		*":$HOME/.local/bin:"*) PATH_STATE="active"; return 0 ;;
	esac
	if [ "${EXXPERTS_NO_MODIFY_PATH:-}" = "1" ]; then
		PATH_STATE="manual"
		say "note: $HOME/.local/bin is not on your PATH, and EXXPERTS_NO_MODIFY_PATH=1 is set,"
		say "so nothing was changed. Add it yourself, e.g. append this line to your ~/.zshrc or ~/.bashrc:"
		say "  export PATH=\"\$HOME/.local/bin:\$PATH\""
		return 0
	fi
	local rc
	case "$(basename "${SHELL:-}")" in
		zsh) rc="$HOME/.zshrc" ;;
		bash) rc="$HOME/.bashrc" ;;
		*) rc="$HOME/.profile" ;;
	esac
	if [ -f "$rc" ] && grep -qs -e 'added by the exxperts installer' -e '\.local/bin' "$rc"; then
		# Already configured (by us or by hand); this terminal just predates it.
		PATH_STATE="appended"
		PATH_RC_FILE="$rc"
		say "$rc already puts $HOME/.local/bin on your PATH; a new terminal will pick it up."
		return 0
	fi
	if printf '\n%s\n' 'export PATH="$HOME/.local/bin:$PATH" # added by the exxperts installer' >> "$rc" 2>/dev/null; then
		PATH_STATE="appended"
		PATH_RC_FILE="$rc"
		say "added $HOME/.local/bin to your PATH (one line appended to $rc)."
	else
		PATH_STATE="manual"
		say "note: $HOME/.local/bin is not on your PATH yet, and $rc could not be written."
		say "Add it yourself, e.g. append this line to your shell startup file:"
		say "  export PATH=\"\$HOME/.local/bin:\$PATH\""
	fi
	return 0
}

migrate_from_source_install() {
	local tree="$1"
	local launcher_dir="$HOME/.local/bin"
	local prefix="" old_root=""
	if command -v npm >/dev/null 2>&1; then
		# 'npm prefix -g', not 'npm config get prefix': npm 11.11+ refuses to
		# print protected config values that were set via the environment.
		prefix="$(npm prefix -g 2>/dev/null || true)"
		if [ -n "$prefix" ]; then
			if [ -d "$prefix/lib/node_modules/$PKG_NAME" ]; then
				old_root="$prefix/lib/node_modules/$PKG_NAME"
			elif [ -d "$prefix/node_modules/$PKG_NAME" ]; then
				old_root="$prefix/node_modules/$PKG_NAME"
			fi
		fi
	fi

	# Inherit settings BEFORE any uninstall can delete the old copy: prefer the
	# old global install's .env, else the clone's. Never overwrite an existing
	# new app/.env.
	if [ ! -f "$tree/app/.env" ]; then
		local env_src=""
		if [ -n "$old_root" ] && [ -f "$old_root/.env" ]; then
			env_src="$old_root/.env"
		elif is_exxperts_clone "$HOME/exxperts" && [ -f "$HOME/exxperts/.env" ]; then
			env_src="$HOME/exxperts/.env"
		fi
		if [ -n "$env_src" ]; then
			if cp "$env_src" "$tree/app/.env" 2>/dev/null; then
				say "carried your settings forward: copied $env_src to $tree/app/.env."
			fi
		fi
	fi

	if [ -n "$old_root" ]; then
		case ":$PATH:" in
			*":$launcher_dir:"*)
				say "removing the old npm-based global install ..."
				if ! npm uninstall -g "$PKG_NAME"; then
					say "warning: could not remove the old npm global install of $PKG_NAME."
					say "Run 'npm uninstall -g $PKG_NAME' yourself when convenient; until then an old"
					say "'exxperts' command may shadow the new one on your PATH."
				fi
				;;
			*)
				say "IMPORTANT: this terminal does not have $launcher_dir on its PATH, so removing"
				say "the old npm-based install now could leave you with no working 'exxperts' command."
				say "The old npm-based install was kept for now. To finish migrating:"
				if [ "$PATH_STATE" = "appended" ]; then
					say "  open a new terminal and re-run this install command;"
					say "  it will then remove the old npm-based install."
				else
					say "  1. add this line to your ~/.zshrc or ~/.bashrc:"
					say "     export PATH=\"\$HOME/.local/bin:\$PATH\""
					say "  2. open a new terminal and re-run this install command;"
					say "     it will then remove the old npm-based install."
				fi
				;;
		esac
	fi

	if is_exxperts_clone "$HOME/exxperts"; then
		say "note: the source clone at $HOME/exxperts is no longer needed to run exxperts."
		say "Keep it for development, or delete it by hand if you want the space back."
	fi
	return 0
}

# The whole archive path. Returns nonzero (with ARCHIVE_FAIL_REASON set) to
# request the source fallback; only user-actionable states (a locked install)
# fail hard, because falling back would not fix them.
try_archive_install() {
	local target
	if ! target="$(archive_target)"; then
		ARCHIVE_FAIL_REASON="no prebuilt archive for $(uname -s)/$(uname -m)"
		return 1
	fi
	command -v tar >/dev/null 2>&1 || { ARCHIVE_FAIL_REASON="tar is not installed"; return 1; }

	resolve_archive_urls "$target" || return 1

	ARCHIVE_TMP_DIR="$(mktemp -d)" || { ARCHIVE_FAIL_REASON="could not create a temp directory"; return 1; }
	local archive_name archive_path
	archive_name="$(basename "$ARCHIVE_URL")"
	archive_path="$ARCHIVE_TMP_DIR/$archive_name"

	say "downloading $archive_name ..."
	fetch_asset "$ARCHIVE_URL" "$archive_path" || { ARCHIVE_FAIL_REASON="could not download the release archive"; return 1; }
	fetch_asset "$ARCHIVE_SUMS_URL" "$ARCHIVE_TMP_DIR/SHA256SUMS.txt" || { ARCHIVE_FAIL_REASON="could not download the checksum file"; return 1; }

	local expected actual
	expected="$(awk -v name="$archive_name" '$2 == name || $2 == "*" name {print $1; exit}' "$ARCHIVE_TMP_DIR/SHA256SUMS.txt")"
	[ -n "$expected" ] || { ARCHIVE_FAIL_REASON="SHA256SUMS.txt has no entry for $archive_name"; return 1; }
	if ! actual="$(sha256_of "$archive_path")"; then
		ARCHIVE_FAIL_REASON="no sha256sum or shasum tool available to verify the download"
		return 1
	fi
	if [ "$expected" != "$actual" ]; then
		say "WARNING: checksum mismatch for $archive_name (expected $expected, got $actual)."
		say "WARNING: the download may be corrupted or tampered with; not installing it."
		ARCHIVE_FAIL_REASON="checksum verification failed"
		return 1
	fi
	say "checksum verified."

	local base="$HOME/.local/share/exxperts"
	local tree="$base/exxperts"

	mkdir -p "$base" || { ARCHIVE_FAIL_REASON="could not create $base"; return 1; }

	# One install at a time: a directory is the mutex (mkdir is atomic). The
	# EXIT trap and every return path below release it.
	local lock="$base/.install-lock"
	if ! mkdir "$lock" 2>/dev/null; then
		fail "another exxperts install appears to be running (lock: $lock).
[exxperts] If it is not, remove that directory and re-run this command:
[exxperts]   rmdir \"$lock\""
	fi
	ARCHIVE_LOCK_DIR="$lock"

	# Self-heal after an interrupted previous run: if the live tree is gone but
	# a renamed-aside copy survived (a kill window between 'move aside' and
	# 'restore or delete'), restore the newest one before deciding
	# fresh-vs-update. Then sweep any remaining orphans so they cannot
	# accumulate or resurface a stale app/.env later.
	if [ ! -d "$tree" ]; then
		local leftover
		# shellcheck disable=SC2012
		leftover="$(cd "$base" 2>/dev/null && ls -dt .old* ./*.update-probe 2>/dev/null | head -n 1)"
		if [ -n "$leftover" ] && [ -d "$base/$leftover" ]; then
			say "restoring the previous install left aside by an interrupted update ($base/$leftover) ..."
			mv "$base/$leftover" "$tree" 2>/dev/null || true
		fi
	fi
	# Sweep only when a live tree exists: if the restore above failed, the
	# aside copy is the only surviving install (and app/.env) and must stay.
	if [ -d "$tree" ]; then
		rm -rf "$base"/.staging* "$base"/.old* "$base"/*.update-probe 2>/dev/null || true
	fi

	local staging="$base/.staging.$$"

	say "unpacking to $tree ..."
	if ! mkdir -p "$staging"; then
		release_install_lock
		ARCHIVE_FAIL_REASON="could not create $staging"
		return 1
	fi
	if ! tar -xzf "$archive_path" -C "$staging"; then
		rm -rf "$staging"
		release_install_lock
		ARCHIVE_FAIL_REASON="could not extract the archive"
		return 1
	fi
	if [ ! -x "$staging/exxperts/exxperts" ]; then
		rm -rf "$staging"
		release_install_lock
		ARCHIVE_FAIL_REASON="unexpected archive layout (no exxperts/exxperts launcher inside)"
		return 1
	fi

	# Update in place: keep the old tree around (renamed aside) until the new
	# one passes its self-check, and carry the user's app/.env forward.
	local old=""
	if [ -d "$tree" ]; then
		say "updating existing install in $tree ..."
		old="$base/.old.$$"
		if ! mv "$tree" "$old"; then
			rm -rf "$staging"
			release_install_lock
			ARCHIVE_FAIL_REASON="could not move the existing install aside"
			return 1
		fi
		# Read app/.env from the aside-moved tree itself, not a pre-move
		# snapshot: what a failure would restore is exactly what was read.
		if [ -f "$old/app/.env" ] && [ ! -f "$staging/exxperts/app/.env" ]; then
			cp "$old/app/.env" "$staging/exxperts/app/.env" || true
		fi
	fi
	if ! mv "$staging/exxperts" "$tree"; then
		[ -n "$old" ] && mv "$old" "$tree"
		rm -rf "$staging"
		release_install_lock
		ARCHIVE_FAIL_REASON="could not move the new install into place"
		return 1
	fi
	rm -rf "$staging"

	# A wrapper script, not a symlink: the archive's launcher locates its app
	# tree from its own path and does not resolve symlinks, so a symlinked
	# launcher would look for the app under ~/.local/bin.
	local launcher="$HOME/.local/bin/exxperts"
	if ! mkdir -p "$HOME/.local/bin" \
		|| ! printf '#!/bin/sh\nexec "%s" "$@"\n' "$tree/exxperts" >"$launcher" \
		|| ! chmod +x "$launcher"; then
		if [ -n "$old" ]; then
			rm -rf "$tree"
			mv "$old" "$tree"
		else
			# One deterministic outcome: never leave a fresh half-install
			# behind while falling back to a second, source-built install.
			rm -rf "$tree"
			rm -f "$launcher"
		fi
		release_install_lock
		ARCHIVE_FAIL_REASON="could not create the launcher in $HOME/.local/bin"
		return 1
	fi

	# Self-check: the installed launcher must run and report the version packed
	# into the archive, before the old tree is deleted.
	local version reported ok=0
	version="$(sed -n 's/.*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$tree/app/package.json" 2>/dev/null | head -n 1)"
	reported="$("$launcher" --version 2>/dev/null || true)"
	if [ -n "$version" ]; then
		[ "$reported" = "exxperts $version" ] && ok=1
	else
		case "$reported" in "exxperts "*) ok=1 ;; esac
	fi
	if [ "$ok" -ne 1 ]; then
		say "the installed app failed its self-check (expected 'exxperts ${version:-<version>}', got '${reported:-nothing}')."
		rm -rf "$tree"
		if [ -n "$old" ]; then
			mv "$old" "$tree"
		else
			rm -f "$HOME/.local/bin/exxperts"
		fi
		release_install_lock
		ARCHIVE_FAIL_REASON="the installed app failed its self-check"
		return 1
	fi
	[ -n "$old" ] && rm -rf "$old"
	release_install_lock

	ensure_local_bin_on_path

	migrate_from_source_install "$tree"

	say ""
	case "$PATH_STATE" in
		active)
			say "all set. Start exxperts with:"
			;;
		appended)
			say "one last step: open a new terminal (or run: source $PATH_RC_FILE), then start exxperts with:"
			;;
		*)
			say "after adding it to your PATH (see the note above), open a new terminal and start exxperts with:"
			;;
	esac
	say ""
	say "  exxperts web"
	say ""
	say "Installed version: ${version:-unknown} (check anytime with: exxperts --version)"
	say "To update later, just run this same install command again."
	say "Installed to: $tree (prebuilt archive)"
	say "Your rooms, memory, and logins live in ~/.exxperts and are untouched."
	return 0
}

# ---------------------------------------------------------------------------
# Source install: the original flow, unchanged. Runs when EXXPERTS_DIR points
# at a checkout, when EXXPERTS_INSTALL_METHOD=source, or as the fallback when
# the archive path cannot finish.
# ---------------------------------------------------------------------------

source_install() {
	check_prerequisites

	local dir
	dir="$(resolve_install_dir)"

	check_network
	check_disk_space "$dir"

	if is_exxperts_clone "$dir"; then
		update_clone "$dir"
	elif [ -e "$dir" ]; then
		fail "$dir already exists but is not an exxperts clone. Move it out of the way,
[exxperts] or pick another directory: EXXPERTS_DIR=/some/other/dir and re-run this command."
	else
		say "cloning $REPO_URL into $dir ..."
		if ! git clone "$REPO_URL" "$dir"; then
			fail "git clone failed. Check your network connection (and proxy settings, if any).
[exxperts] If the error above mentions an SSL certificate, your company network inspects TLS:
[exxperts] ask IT for the corporate root certificate (a .pem file) and point git at it with
[exxperts]   git config --global http.sslCAInfo /path/to/corp-root.pem
[exxperts] then re-run this command."
		fi
	fi

	say "installing dependencies (npm install) ..."
	if ! (cd "$dir" && npm install); then
		fail "npm install failed. From $dir, run 'npm run doctor'; it checks every layer and prints the fix.
[exxperts] If the error above mentions a certificate (UNABLE_TO_VERIFY_LEAF_SIGNATURE or
[exxperts] SELF_SIGNED_CERT_IN_CHAIN), your company network inspects TLS: ask IT for the
[exxperts] corporate root certificate (a .pem file), then run this first and re-run the
[exxperts] install command in the same terminal:
[exxperts]   export NODE_EXTRA_CA_CERTS=/path/to/corp-root.pem"
	fi

	say "building and installing the exxperts command (npm run install:global) ..."
	say "this builds the whole app; give it a few minutes."
	if ! (cd "$dir" && npm run install:global); then
		fail "the build-and-install step failed. From $dir, run 'npm run doctor'; it checks every layer and prints the fix."
	fi

	if ! command -v exxperts >/dev/null 2>&1; then
		local npm_prefix
		npm_prefix="$(npm config get prefix 2>/dev/null || true)"
		say "exxperts installed, but the 'exxperts' command is not on your PATH yet."
		say "npm's global bin directory is: ${npm_prefix:+$npm_prefix/bin}"
		say "Add it to your PATH, e.g. append this line to your ~/.zshrc or ~/.bashrc:"
		say "  export PATH=\"$npm_prefix/bin:\$PATH\""
		say "then open a new terminal."
	fi

	local version
	version="$(cd "$dir" && node -p "require('./package.json').version" 2>/dev/null || true)"

	say ""
	say "all set. Start exxperts with:"
	say ""
	say "  exxperts web"
	say ""
	say "Installed version: ${version:-unknown} (check anytime with: exxperts --version)"
	say "To update later, just run this same install command again."
	say "Installed from: $dir"
}

main() {
	say "official exxperts installer"

	local method
	method="$(printf '%s' "${EXXPERTS_INSTALL_METHOD:-}" | tr '[:upper:]' '[:lower:]')"

	# EXXPERTS_DIR selects the source flow, EXXPERTS_INSTALL_METHOD=archive
	# rules it out: setting both is a contradiction, not a preference.
	if [ -n "${EXXPERTS_DIR:-}" ] && [ "$method" = "archive" ]; then
		fail "EXXPERTS_DIR and EXXPERTS_INSTALL_METHOD=archive contradict each other:
[exxperts] EXXPERTS_DIR means 'install from this checkout' (the source flow), while
[exxperts] EXXPERTS_INSTALL_METHOD=archive rules the source flow out.
[exxperts] Unset one of the two variables and re-run this command."
	fi

	# EXXPERTS_DIR set means "install from this checkout" (developers, CI):
	# the source flow runs exactly as before.
	if [ -z "${EXXPERTS_DIR:-}" ] && [ "$method" != "source" ]; then
		if try_archive_install; then
			return 0
		fi
		if [ "$method" = "archive" ]; then
			fail "archive install failed (${ARCHIVE_FAIL_REASON:-unknown reason}), and EXXPERTS_INSTALL_METHOD=archive rules out the source fallback."
		fi
		say "archive install unavailable (${ARCHIVE_FAIL_REASON:-unknown reason}); falling back to the source install."
	fi
	source_install
}

main "$@"
