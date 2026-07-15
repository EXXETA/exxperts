#!/usr/bin/env bash
# Official exxperts one-line installer (macOS / Linux):
#
#   curl -fsSL https://raw.githubusercontent.com/EXXETA/exxperts/main/install.sh | bash
#
# What it does: checks prerequisites (git, Node.js), clones the repo into
# ~/exxperts (override with EXXPERTS_DIR), then runs `npm install` and
# `npm run install:global`. Re-running the same command updates an existing
# install. exxperts is source-distributed, so the install builds the app
# locally; give it a few minutes.
#
# Env overrides:
#   EXXPERTS_DIR   install directory (default: ~/exxperts)
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

main() {
	say "official exxperts installer"
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

main "$@"
