# Security

This document states what exxperts is designed to protect against, which deployments are supported, and how to report a vulnerability. It is deployment guidance for users and reviewers, not a hardening checklist for hostile environments.

## Threat model

exxperts is a **single-user, local application**. The design assumption is one person, on their own machine, talking to a server that only that machine can reach.

What that means concretely:

- The web server binds to `127.0.0.1` only. It is never reachable from another machine in a supported setup, with one explicit, off-by-default exception: remote mode, described in its own section below, which additionally serves the user's own enrolled devices over their private tunnel. With remote mode off (the default, forever), the server's behavior is byte-identical to a build without the feature, and automated tests pin that.
- Every request is additionally checked by a request guard: the connection must come from a loopback address, and the `Host` and `Origin` headers must be loopback values. This stops a malicious website in your browser from driving the local API via DNS rebinding.
- Requests that carry reverse-proxy headers (`Forwarded`, `X-Forwarded-*`, `X-Real-IP`, `Via`) are refused with an explicit error. A proxy in front of the server would make all traffic appear local, so proxied requests are rejected rather than trusted.
- API and WebSocket requests require a **client auth token**: a random 256-bit secret the server mints on first run and stores at `~/.exxperts/app/auth-token` (file mode 0600 on POSIX). `exxperts web` opens the browser through a one-time link that exchanges the token for a long-lived HttpOnly cookie; programmatic callers send the token in the `X-Exxperts-Auth` header. Only the readiness probe (`/healthz`) and the exchange route itself are open, and a tokenless browser navigation gets a plain page explaining how to open the app. To rotate the token, delete the file and restart. Because browsers treat every localhost port as the same site, cookie-backed WebSocket connections are additionally pinned to the app's own page origin, so a page served by some other local program cannot ride the session. Note the limits: the token protects the HTTP surface, not the machine; anyone who can read your home directory or your processes already has your permissions.

## A room's commands

A room's model can be steered by what it reads, such as a web page, a file or a connector's answer. So on a Mac, and on Windows 11 on an x64 PC where Windows makes its sandbox available (build 26100 or later; on build 26200, 26200.9278 or later), a room's commands run inside the operating system's sandbox, which the app calls the room's protection:

- A command changes files only in the room's folder and the folders the person allowed it to change, and can't read the person's other files, their keys or the app's data.
- It reaches a website only after the person's yes, or when the site is on the room's list, or, in a room the person put on Auto at the computer, any public website without asking. This computer's own addresses (such as localhost), link-local addresses and raw IP addresses are never reached. A name on the local network needs the person's yes like any other site, and in a room on Auto it is never reached: the address is checked where the connection is made.
- It starts with a short, fixed set of environment variables, without the app's sign-in token. When the room finishes answering, whatever a command left running is stopped and its network closes.
- If the protection doesn't start or doesn't hold, the command doesn't run. It never falls back to running unprotected.

Only the person can turn protection off for a room: at the computer, with the room's Protection switch, after a confirm. The app reads that choice when it starts and from then on takes it only from that switch, so a change to that choice made in its settings files behind its back counts only from its next start. Other settings changed that way, such as whether a room's commands ask first, can count at once. A room whose protection the person turned off has commands that can do anything the person can, including changing the app's settings for other rooms.

A command the person approves to run outside the protection (**Run once**) and the connectors the person installed run with the person's rights. The limits that remain, such as the secrets a command can read inside the room's own folder and the differences on Windows, are listed in [Folders, commands and protection](docs/workspace-and-bash.md#what-protection-doesnt-cover).

## Supported deployments

Supported: installing and running exxperts on your own machine, via any of the three install types (prebuilt archive one-liner, global install from source via npm, repo clone). exxperts is not published to the npm registry; the npm path installs a package built from this repository. The app, its memory, artifacts, and credentials all stay on your disk.

Officially not supported:

- Putting a **reverse proxy** (nginx, Caddy, Traefik, an ingress controller) in front of exxperts.
- Running exxperts in **Docker or any container** with the port published beyond the container.
- **Port-forwarding, reverse tunnels, or otherwise exposing** the server to other machines or users. The one supported way to reach the app from another device is the built-in remote mode below; anything else, including public tunnel products, remains unsupported and is refused where detectable.
- Hosting exxperts as a **shared or multi-user service**.

The deployments listed above are not merely unsupported configurations that happen to work; they are unsafe, because they move the server outside the trust boundary it is designed for, and the client auth token is the only thing left protecting it there. The server refuses proxied requests so that a standard proxy setup fails loudly during configuration instead of silently exposing your machine. This detection is best-effort: a proxy configured to send no identifying headers cannot be recognized this way, which is why the loopback bind and the client auth token, not the header check, are the protections to rely on. Do not treat a proxy that happens to get through as a supported deployment.

Containerizing exxperts to sandbox it on your own machine is a different case, and a legitimate one: as long as nothing is published beyond the container, the trust boundary holds. On Linux, running the container with `--network=host` keeps everything loopback from the app's point of view, so it works without changes. The server still binds `127.0.0.1` inside the container, so bridge networking with a published port currently fails; an explicit opt-in for such setups may come later.

A hosted or multi-user exxperts would need client authentication, TLS, a real multi-user permission model, isolation for tool execution, and a story for provider credentials. That is a separate product decision, not a configuration away.

## Remote mode

Remote mode is the explicit opt-in for reaching your own exxperts from your own phone or laptop. It is off by default and stays off until you turn it on in the app on the computer (Settings, Remote access); turning it off there instantly restores the loopback-only behavior above, and with it off the server behaves byte-identically to a build without the feature.

What it is: the server additionally listens on the machine's own private-tunnel address (Tailscale or a compatible mesh; you install and sign in to the tunnel yourself, on both devices). It never binds a LAN or public interface, never uses a relay URL, and never puts a proxy in front of the app: the request guard above runs unchanged on the tunnel listener, including the refusal of proxied requests, so tunnel products that rewrite traffic are refused rather than trusted.

Two independent factors gate every remote request:

- **Device enrollment in the tunnel.** A device that is not on your tailnet cannot reach the port at all. The tunnel's traffic is end-to-end encrypted (WireGuard) on every path, including through the vendor's relays, which only carry already-encrypted packets.
- **A per-device key minted by pairing.** The pairing QR carries a single-use code that expires after ten minutes; redeeming it requires an explicit approval on the computer, naming the device. The master client auth token is not a credential on the tunnel listener and never travels to a phone in any form. Each device's key is stored hashed, expires server-side after 30 days, and is individually revocable: revoking a device closes its live connections immediately, and turning remote access off signs out everything at once.

What a remote device can do: by default, the full app, including rooms that run commands; this is your own machine and remote mode exists to give you full power over it. A remote device sees and answers a room's question to run a command, and a question about a website, whose yes lasts for the current answer only. The questions for a folder, for turning a room's commands on and for running a command outside the room's protection (**Run once**) are answered only at the computer; a remote device shows them as waiting there. Choosing a room's command mode (Ask, Semi or Auto), and turning a room's protection off, are only possible at the computer itself, never from a remote device. Two narrowing controls exist, both changeable only on the computer itself, never from a phone: a per-device viewing-only setting, and per-room hiding. **Hiding a room from remote is a convenience, not a security control**: it tidies what your own paired devices see, and it fails toward the default (all rooms reachable) if its settings file is ever unreadable. The controls to rely on for a device that must not reach something are revoking that device or not pairing it. Actions that touch the computer itself (provider credentials and sign-ins, connector administration, installing skills, native file dialogs, workspace folder access, and every remote-mode setting) are refused for all remote devices regardless of capability.

Operational notes, stated plainly:

- The tunnel vendor's control plane sees device names, keys' public halves, and connection metadata, never your traffic or its contents. A self-hosted control plane (Headscale) removes that if you prefer.
- The default tailnet access policy allows every device on your tailnet to reach every other; the app's per-device keys are what keep a merely-enrolled device from being a paired one. Narrowing the tailnet policy to your own devices is recommended defense in depth.
- Security-relevant remote events (pairing attempts, failed device authentication, revocations) are appended to a redacted audit log at `~/.exxperts/app/remote-auth-audit.jsonl`; it never contains key material, pairing codes, or typed device names.
- In this release the tunnel listener serves plain http; the bytes are protected by the tunnel's encryption, not by TLS. A TLS stage using tunnel-issued certificates is planned.
- Remote mode is meant for a personal computer. On a company-managed computer, leave it off unless your IT team allows it; the Remote access page tells you to check your company's policy before you turn it on.

Findings about remote mode's boundaries are welcome under the reporting process below, especially anywhere the OFF state is observably different from a build without the feature, anywhere the master token can be induced to appear on the tunnel listener, or anywhere a remote device can widen its own access.

## Client auth token

The client auth token described in the threat model shipped with the guard hardening: the server refuses unauthenticated API and WebSocket requests, so the loopback bind and header guard are defense in depth rather than the only line. This does not make the unsupported deployments above supported; a hosted exxperts would still need TLS, a multi-user model, and tool isolation.

## Release integrity

Prebuilt release archives are built by GitHub Actions from the release tag; the workflow definition is in this repository (`.github/workflows/release.yml`). Each release ships a `SHA256SUMS.txt` file, and the installers verify the archive checksum before unpacking. Each release also carries four CycloneDX SBOMs generated from the lockfiles in that same workflow, `sbom-app.cdx.json`, `sbom-runtime.cdx.json`, `sbom-desktop.cdx.json` and `sbom-document-tools.cdx.json` (the desktop one keeps Electron in, a dev dependency by npm convention that ships in every installer), so a scanner can read the full dependency inventory without cloning the repository. A weekly OSV scan over the same lockfiles runs in `.github/workflows/sbom.yml`.

The archives bundle a Node.js runtime. Its version and per-platform checksums are pinned in `scripts/release-node-version.json` and verified at build time against that pin; the pinned checksums are taken from the official SHASUMS256.txt published at nodejs.org. A scheduled CI check turns red when the pinned Node falls behind a security release in its line, and we update the pin and cut a release when that happens.

If you prefer not to run prebuilt archives, the source install path (documented in the README) builds everything from the repository on your machine.

## Reporting a vulnerability

Please report suspected vulnerabilities privately to the maintainers rather than in a public issue: **borja.odriozola.schick@exxeta.ch** and **fernando.pastor@exxeta.ch**. Include what you observed and how to reproduce it. We will acknowledge, assess, and credit you in the fix unless you prefer otherwise.

Findings about the boundaries described above are still welcome, especially where the app fails to refuse an unsupported deployment loudly enough. Findings are especially welcome where a room's command reaches a file or a site it wasn't allowed, or where a room can turn its own protection off.
