# Provider setup and AI profiles

Audience: users who need to connect a provider/profile before using persistent-agent rooms and product LLM workflows.

## Current setup model

There are two setup paths, depending on how the provider authenticates:

- **Subscription (OAuth) providers — Claude, ChatGPT Plus/Pro:** sign in directly from the web app's **AI setup** page. Each profile that is not connected yet shows a **Sign in →** button; it opens the provider's login in a new browser tab, and the page updates when the sign-in completes. The CLI `/login` flow remains available as an alternative — both paths write to the same local credential store.
- **API-key providers, including the OpenAI-compatible gateway:** set up in the web app: open **AI setup**, then **Add another provider**, then **Set up gateway**; enter the base URL and the model ids your gateway routes, pick the Learn/Review Memory model, then paste your token on the gateway's profile row. The terminal wizard (`exxperts setup openai-compatible`, with the API key entered through the CLI `/login` prompt) remains available as an alternative.

In both cases:

- Credentials stay on your machine in the local runtime auth store (`~/.exxperts/agent/auth.json`), shared between the web app and the CLI.
- The web app's **AI setup** page shows readiness, status, active profile selection, and model options for every profile.
- Persistent-agent room state references provider/model identity only; provider credentials and transport details stay outside room memory/state.
- The `./scripts/exxperts-cli` repo wrapper used throughout this page is a bash script (macOS/Linux/Git Bash); on Windows PowerShell/cmd, run `node bin\exxperts-cli.cjs` with the same arguments instead.

## Current first-class AI profiles

These are the current product-approved profiles for persistent-room/product workflows:

| Product profile | User-facing label | Runtime provider | Setup path |
| --- | --- | --- | --- |
| `chatgpt-codex` | ChatGPT Plus/Pro | `openai-codex` | In-app sign-in (or CLI `/login`). Requires an eligible ChatGPT Plus/Pro Codex subscription. |
| `anthropic` | Claude | `anthropic` | In-app sign-in (or CLI `/login`). Requires a Claude Pro/Max subscription. |
| `openai-compatible` | OpenAI-compatible gateway | `openai-compatible` | Terminal setup + CLI `/login` API-key entry; bring-your-own gateway for advanced users/orgs. |

Any other provider the runtime knows (Google Gemini, Groq, Mistral, DeepSeek, OpenRouter, xAI, and about 25 more) can be added from the web app: open **AI setup** and use **Add another provider**, then sign in with a subscription where the provider offers one, or paste an API key. After signing in, approve the models that provider may use in rooms plus the one that runs Learn and Review Memory. Approval creates the provider's AI profile; without it, the provider is signed in but not usable in rooms.

## ChatGPT Plus/Pro / Codex setup

Use this path for the current `chatgpt-codex` product profile.

Current identities:

| Concept | Value |
| --- | --- |
| Product profile id | `chatgpt-codex` |
| Web profile label | ChatGPT Plus/Pro |
| Runtime provider id | `openai-codex` |
| CLI/TUI OAuth option | ChatGPT Plus/Pro (Codex Subscription) |
| Primary approved persistent-room model | `openai-codex/gpt-5.5` |

Requirements:

- An installed Exxperts package, or a repo clone.
- A real ChatGPT Plus/Pro account with Codex/subscription entitlement.

### 1. Sign in from the web app (primary path)

Open the web app's **AI setup** page. On the **ChatGPT Plus/Pro** profile card, click **Sign in →**. The provider's login opens in a new browser tab; complete it there. Back in Exxperts, the page updates automatically once the sign-in finishes (use **Cancel** on the card to abort a stuck attempt, then retry).

One sign-in can run at a time. If your browser blocks the login tab, allow pop-ups for the Exxperts page and retry.

Alternative — CLI `/login`: start the CLI/TUI (`exxperts cli`, `exxperts-cli`, or the repo wrapper `./scripts/exxperts-cli`), run `/login`, select `Use a subscription`, then `ChatGPT Plus/Pro (Codex Subscription)`, and complete the browser OAuth flow. If the CLI/TUI asks you to paste a redirect URL or code, paste it only into the CLI/TUI prompt. Both paths store credentials in the same local auth store.

Do not paste redirect URLs, auth codes, tokens, screenshots, or raw auth files into docs, issues, or chat. Provider OAuth labels and browser screens can change outside this repository.

### 2. Select the profile

On **AI setup**, when ChatGPT Plus/Pro shows as connected, select **ChatGPT Plus/Pro** in the AI profile controls. The active product profile becomes `chatgpt-codex`.

Profile switching is readiness-gated. If the profile is not ready, the web app keeps it unselectable and shows setup/status guidance. To disconnect later, open **Connection details** at the bottom of the page and use **Sign out**.

### 3. Start or resume a compatible room

The active profile governs current persistent-room/product LLM workflows. Switching the active profile does not rewrite old threads or model locks.

Message-bearing room threads are model-locked and resume with their locked model. To change models cleanly, create a checkpoint or Memento boundary. If you leave before sending a new turn after the boundary, Exxperts retires the empty prepared runtime and returns the room to a fresh-entry state where the model picker applies to the next runtime.

## Claude / Anthropic setup

Use this path for the current `anthropic` product profile.

Current identities:

| Concept | Value |
| --- | --- |
| Product profile id | `anthropic` |
| Web profile label | Claude |
| Runtime provider id | `anthropic` |
| CLI/TUI OAuth option | Anthropic (Claude Pro/Max) |
| Recommended approved persistent-room model | `anthropic/claude-opus-4-8` |

Requirements:

- An installed Exxperts package, or a repo clone.
- A real Claude Pro/Max account with Anthropic subscription/OAuth access.

### 1. Sign in from the web app (primary path)

Open the web app's **AI setup** page. On the **Claude** profile card, click **Sign in →**. The provider's login opens in a new browser tab; complete it there. Back in Exxperts, the page updates automatically once the sign-in finishes (use **Cancel** on the card to abort a stuck attempt, then retry).

The sign-in flow uses a local callback on port `53692`; one sign-in can run at a time. If your browser blocks the login tab, allow pop-ups for the Exxperts page and retry.

Alternative — CLI `/login`: start the CLI/TUI (`exxperts cli`, `exxperts-cli`, or the repo wrapper `./scripts/exxperts-cli`), run `/login`, select `Use a subscription`, then `Anthropic (Claude Pro/Max)`, and complete the browser OAuth flow. If the CLI/TUI asks you to paste a redirect URL or code, paste it only into the CLI/TUI prompt. Both paths store credentials in the same local auth store.

Do not paste redirect URLs, auth codes, tokens, screenshots, or raw auth files into docs, issues, or chat. Anthropic/Claude OAuth labels, browser screens, and account entitlement behavior can change outside this repository.

> Note: Anthropic API-key setup exists in the embedded runtime, but this product profile is documented as a subscription/OAuth profile. API-key product setup is deferred.

### 2. Select the profile

On **AI setup**, when Claude shows as connected, select **Claude** in the AI profile controls. The active product profile becomes `anthropic`.

Profile switching is readiness-gated. If the profile is not ready, the web app keeps it unselectable and shows setup/status guidance. To disconnect later, open **Connection details** at the bottom of the page and use **Sign out**.

### 3. Start or resume a compatible room

The active profile governs current persistent-room/product LLM workflows. Switching the active profile does not rewrite old threads or model locks.

Message-bearing room threads are model-locked and resume with their locked model. To change models cleanly, create a checkpoint or Memento boundary. If you leave before sending a new turn after the boundary, Exxperts retires the empty prepared runtime and returns the room to a fresh-entry state where the model picker applies to the next runtime.

## OpenAI-compatible gateway setup

Use this path for the `openai-compatible` product profile when you or your organization operate an OpenAI Chat Completions-compatible gateway, for example a LiteLLM deployment or another gateway that exposes a compatible `/v1/chat/completions` surface.

Current identities:

| Concept | Value |
| --- | --- |
| Product profile id | `openai-compatible` |
| Web profile label | OpenAI-compatible gateway |
| Runtime provider id | `openai-compatible` |
| Setup command | `exxperts setup openai-compatible` |
| CLI/TUI API-key option | OpenAI-compatible gateway |
| Transport/API mode | `openai-completions` |

Requirements:

- Terminal access.
- A gateway base URL, for example `https://gateway.example.com/v1`.
- A real API key for that gateway.
- The exact gateway model ids or aliases you want Exxperts to use, as exposed by your gateway.
- Non-confidential test prompts for validation.

### 1. Configure non-secret gateway and model policy

Run the setup command in Terminal:

```bash
exxperts setup openai-compatible
```

For repo/branch validation, prefer:

```bash
./scripts/exxperts-cli setup openai-compatible
```

The setup command prompts only for non-secret values:

- gateway display name, default `OpenAI-compatible gateway`;
- gateway base URL;
- primary persistent-room model id or gateway alias;
- optional additional persistent-room model ids or gateway aliases;
- optional maintenance model id or gateway alias, defaulting to the primary model.

Model ids are exact strings supplied by your gateway. They are often case-sensitive, and Exxperts does not discover or validate them during setup. If you are unsure whether the id is `gpt-5.5`, `GPT-5.5`, `gpt5.5`, or another alias, ask the gateway owner/admin or check the gateway's API/model documentation before approving it for Exxperts.

It writes non-secret runtime transport/model config to:

```text
~/.exxperts/agent/models.json
```

It also writes the product-approved local process/model policy to:

```text
~/.exxperts/app/openai-compatible-ai-profile.json
```

It does **not** ask for, store, or print the API key.

### 2. Add the API key through `/login`

Start the CLI/TUI:

```bash
exxperts cli
```

For repo/branch validation:

```bash
./scripts/exxperts-cli
```

Inside the CLI/TUI, run:

```text
/login
```

Then select:

```text
Use an API key
```

Then select:

```text
OpenAI-compatible gateway
```

Paste the API key only into the CLI/TUI prompt. The key is stored in runtime auth state under `~/.exxperts/agent/auth.json`; do not paste it into docs, issues, merge requests, chat, screenshots, or `models.json`.

### 3. Refresh web readiness and select the profile

Return to the web app and open **AI setup**. Refresh provider/auth status.

The `OpenAI-compatible gateway` profile is readiness-gated. It becomes selectable only when all of these are true:

1. `~/.exxperts/app/openai-compatible-ai-profile.json` exists and validates.
2. `~/.exxperts/agent/models.json` contains provider `openai-compatible` and the mapped model ids.
3. Credentials are configured for provider `openai-compatible` through `/login` or another runtime-supported auth source.

When ready, select **OpenAI-compatible gateway**. Persistent-room model options should show only the room model ids explicitly entered during setup.

### 4. Understand the local policy

The local app policy approves only the model ids entered during setup:

| Process | Mapping |
| --- | --- |
| Persistent-room conversation | Explicit `roomModels` from `openai-compatible-ai-profile.json` |
| Checkpoint compression | Inherits the selected persistent-room model |
| Learn (absorb recent context) | `maintenanceModel` |
| Structural review | `maintenanceModel` |

A maintenance-only model is included in runtime `models.json` so maintenance processes can use it, but it is not automatically selectable for persistent-room conversation unless you also list it as a room model.

### 5. Gateway limitations and responsibilities

OpenAI-compatible gateway support means Exxperts can call a configured Chat Completions-compatible endpoint with model ids you approve locally. It does not mean Exxperts can guarantee every upstream model behavior.

You or your organization remain responsible for:

- upstream provider configuration, entitlements, billing, quotas, and rate limits;
- gateway logging, data retention, security posture, and access control;
- model aliases, availability, routing, failover, and context-window claims;
- tool/function-calling behavior, image support, streaming behavior, and system/developer role compatibility;
- prompt caching, TTL, reasoning/thinking controls, and related billing semantics;
- capability validation with non-confidential prompts before relying on a gateway for real work.

The setup command does not fetch `/models`, list available model ids, validate reachability, validate the API key, or automatically approve every model exposed by the gateway. If a disposable validation room later fails with a non-secret error such as "model not found" or "unknown model", rerun setup with the exact model id or alias expected by the gateway.

## Current ChatGPT/Codex process-model policy

The provider catalog may contain more `openai-codex` models than the product approves. Persistent-room workflows use the architect-approved process/model policy in `apps/web-server/src/persistent-agent-ai-profiles.ts`.

Current `chatgpt-codex` mapping:

| Process | Approved provider/model |
| --- | --- |
| Persistent-room conversation | `openai-codex/gpt-5.5` |
| Checkpoint compression | Inherits the selected persistent-room model |
| Learn (absorb recent context) | `openai-codex/gpt-5.5` |
| Structural review | `openai-codex/gpt-5.5` |

Model-policy editing is not a user/admin feature today. Any editable policy needs a separate product design for storage, schema, validation, merge behavior, thread-lock safety, and rollback.

## Current Claude/Anthropic process-model policy

The provider catalog may contain more `anthropic` models than the product approves. Persistent-room workflows use the architect-approved process/model policy in `apps/web-server/src/persistent-agent-ai-profiles.ts`.

Current `anthropic` mapping:

| Process | Approved provider/model |
| --- | --- |
| Persistent-room conversation | `anthropic/claude-opus-4-8`, `anthropic/claude-sonnet-5`, `anthropic/claude-fable-5`, `anthropic/claude-opus-4-6`, `anthropic/claude-opus-4-7`, `anthropic/claude-sonnet-4-6` |
| Checkpoint compression | Inherits the selected persistent-room model |
| Learn (absorb recent context) | `anthropic/claude-opus-4-8` |
| Structural review | `anthropic/claude-opus-4-8` |

`claude-opus-4-8` is the default/recommended model. `claude-sonnet-5` and `claude-fable-5` are approved as additional persistent-room conversation choices.

Model-policy editing is not a user/admin feature today. Any editable policy needs a separate product design for storage, schema, validation, merge behavior, thread-lock safety, and rollback.

### Maintainer checklist for newly released provider models

Provider catalogs may contain models that Exxperts has not approved. Product AI profiles may list only models that the runtime registry can resolve. Updating npm packages is not necessarily what updates the registry; in this repo, the model generator fetches upstream model catalogs and writes `runtime/packages/ai/src/models.generated.ts`.

When adding a newly released provider model to an approved AI profile:

1. Run:

   ```bash
   npm run generate-models --workspace @exxeta/exxperts-ai
   ```

2. Inspect `runtime/packages/ai/src/models.generated.ts` and confirm the exact `provider/model` IDs generated for the target provider.
3. Only after the runtime registry contains the model, add it to the approved product AI profile policy in `apps/web-server/src/persistent-agent-ai-profiles.ts`, limited to the process or processes explicitly approved.
4. Update display labels / curated model labels in `apps/web-server/src/index.ts` if the model should appear in UI.
5. Update docs/current mapping tables.
6. Run model-policy/status smokes.
7. Manually validate with an eligible account before claiming real-provider validation.

Do not add hand-written fallback entries unless upstream catalogs do not contain the model and the fallback metadata is explicitly approved.

## Privacy and no-secret rules

Do not paste or commit:

- API keys;
- OAuth access tokens or refresh tokens;
- redirect URLs or auth codes;
- browser cookies;
- raw `auth.json` contents;
- screenshots that include credentials or account-identifying details;
- unreviewed raw status endpoint output.

Current storage boundaries:

| Path | Purpose |
| --- | --- |
| `~/.exxperts/app/` | Product/app state, active AI profile, selected persistent-room model, local `openai-compatible` policy, persistent rooms. |
| `~/.exxperts/agent/` | Embedded runtime provider/auth/model/settings/session state, including gateway `models.json` and runtime `auth.json`. |

Status endpoints and UI should be used for readiness checks, not for copying or sharing credential files.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| **Sign in →** does nothing or the login tab never opens | Allow pop-ups for the Exxperts page and retry. Only one sign-in can run at a time — use **Cancel** on the profile card to clear a stuck attempt first. |
| In-app sign-in reports "Sign-in timed out" | The flow expires after 5 minutes. Retry from **AI setup**; if it keeps failing, try the CLI `/login` path and report a non-secret description. |
| ChatGPT Plus/Pro or Anthropic option is not visible in `/login` | Confirm you chose `Use a subscription`; provider labels may have changed; escalate with a non-secret description. |
| OpenAI-compatible gateway is not visible under `/login` → `Use an API key` | Run `exxperts setup openai-compatible` first so runtime `models.json` defines provider `openai-compatible`; restart the CLI/TUI if needed. |
| OpenAI-compatible gateway validation fails with `model not found`, `unknown model`, or similar | Confirm the exact model id/alias with the gateway owner/admin. Model ids can be case-sensitive. Rerun `exxperts setup openai-compatible` with the corrected id; do not paste raw gateway logs or keys. |
| Sign-in succeeds but the web still shows not connected | Use **Refresh** on the AI setup page; restart the web app if needed; do not inspect or share raw credential files. |
| Profile cannot be selected | The readiness gate likely still sees missing auth, missing runtime model config, or missing/invalid local app policy. Refresh status and check the profile diagnostics. |
| Room cannot resume after switching profile | Message-bearing saved threads are model-locked. Select the compatible profile to resume that thread. To change models cleanly, resume under a compatible profile, create a checkpoint/Memento boundary, then leave before the next turn to return the room to fresh-entry state where the picker applies. |
| Status output appears to contain secrets | Stop and escalate before sharing screenshots/output. |

## Related docs

- [How Exxperts works](how-exxperts-works.md) — where AI profiles and per-process model locks fit in the architecture.
