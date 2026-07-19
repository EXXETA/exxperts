# Security

This document states what exxperts is designed to protect against, which deployments are supported, and how to report a vulnerability. It is deployment guidance for users and reviewers, not a hardening checklist for hostile environments.

## Threat model

exxperts is a **single-user, local application**. The design assumption is one person, on their own machine, talking to a server that only that machine can reach.

What that means concretely:

- The web server binds to `127.0.0.1` only. It is never reachable from another machine in a supported setup.
- Every request is additionally checked by a request guard: the connection must come from a loopback address, and the `Host` and `Origin` headers must be loopback values. This stops a malicious website in your browser from driving the local API via DNS rebinding.
- Requests that carry reverse-proxy headers (`Forwarded`, `X-Forwarded-*`, `X-Real-IP`, `Via`) are refused with an explicit error. A proxy in front of the server would make all traffic appear local, so proxied requests are rejected rather than trusted.
- API and WebSocket requests require a **client auth token**: a random 256-bit secret the server mints on first run and stores at `~/.exxperts/app/auth-token` (file mode 0600 on POSIX). `exxperts web` opens the browser through a one-time link that exchanges the token for a long-lived HttpOnly cookie; programmatic callers send the token in the `X-Exxperts-Auth` header. Only the readiness probe (`/healthz`) and the exchange route itself are open, and a tokenless browser navigation gets a plain page explaining how to open the app. To rotate the token, delete the file and restart. Because browsers treat every localhost port as the same site, cookie-backed WebSocket connections are additionally pinned to the app's own page origin, so a page served by some other local program cannot ride the session. Note the limits: the token protects the HTTP surface, not the machine; anyone who can read your home directory or your processes already has your permissions.

## Supported deployments

Supported: installing and running exxperts on your own machine, via any of the three install types (prebuilt archive one-liner, npm global install, repo clone). The app, its memory, artifacts, and credentials all stay on your disk.

Not supported, and actively refused where detectable:

- Putting a **reverse proxy** (nginx, Caddy, Traefik, an ingress controller) in front of exxperts.
- Running exxperts in **Docker or any container** with the port published beyond the container.
- **Port-forwarding, tunneling, or otherwise exposing** the server to other machines or users.
- Hosting exxperts as a **shared or multi-user service**.

These are not supported configurations that happen to work; they are unsafe, because they move the server outside the trust boundary it is designed for, and the client auth token is the only thing left protecting it there. The server refuses proxied requests so that a standard proxy setup fails loudly during configuration instead of silently exposing your machine. This detection is best-effort: a proxy configured to send no identifying headers cannot be recognized this way, which is why the loopback bind and the client auth token, not the header check, are the protections to rely on. Do not treat a proxy that happens to get through as a supported deployment.

A hosted or multi-user exxperts would need client authentication, TLS, a real multi-user permission model, isolation for tool execution, and a story for provider credentials. That is a separate product decision, not a configuration away.

## Client auth token

The client auth token described in the threat model shipped with the guard hardening: the server refuses unauthenticated API and WebSocket requests, so the loopback bind and header guard are defense in depth rather than the only line. This does not make the unsupported deployments above supported; a hosted exxperts would still need TLS, a multi-user model, and tool isolation.

## Release integrity

Prebuilt release archives are built by GitHub Actions from the release tag; the workflow definition is in this repository (`.github/workflows/release.yml`). Each release ships a `SHA256SUMS.txt` file, and the installers verify the archive checksum before unpacking.

The archives bundle a Node.js runtime. Its version and per-platform checksums are pinned in `scripts/release-node-version.json` and verified at build time against that pin; the pinned checksums are taken from the official SHASUMS256.txt published at nodejs.org. A scheduled CI check turns red when the pinned Node falls behind a security release in its line, and we update the pin and cut a release when that happens.

If you prefer not to run prebuilt archives, the source install path (documented in the README) builds everything from the repository on your machine.

## Reporting a vulnerability

Please report suspected vulnerabilities privately to the maintainers rather than in a public issue: **borja.odriozola.schick@exxeta.ch** and **fernando.pastor@exxeta.ch**. Include what you observed and how to reproduce it. We will acknowledge, assess, and credit you in the fix unless you prefer otherwise.

Findings about the boundaries described above are still welcome, especially where the app fails to refuse an unsupported deployment loudly enough.
