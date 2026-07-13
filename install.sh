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

	if is_exxperts_clone "$dir"; then
		update_clone "$dir"
	elif [ -e "$dir" ]; then
		fail "$dir already exists but is not an exxperts clone. Move it out of the way,
[exxperts] or pick another directory: EXXPERTS_DIR=/some/other/dir and re-run this command."
	else
		say "cloning $REPO_URL into $dir ..."
		git clone "$REPO_URL" "$dir"
	fi

	say "installing dependencies (npm install) ..."
	if ! (cd "$dir" && npm install); then
		fail "npm install failed. From $dir, run 'npm run doctor'; it checks every layer and prints the fix."
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

	say ""
	say "all set. Start exxperts with:"
	say ""
	say "  exxperts web"
	say ""
	say "To update later, just run this same install command again."
	say "Installed from: $dir"
}

main "$@"
