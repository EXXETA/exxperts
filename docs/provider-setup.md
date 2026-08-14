# Provider setup and AI profiles

Audience: users who need to connect a provider/profile before using persistent-agent rooms and product LLM workflows.

## Current setup model

There are two setup paths, depending on how the provider authenticates:

- **Subscription (OAuth) providers (Claude, ChatGPT Plus/Pro):** sign in directly from the web app's **AI setup** page. Each profile that is not connected yet shows a **Sign in →** button; it opens the provider's login in a new browser tab, and the page updates when the sign-in completes. The CLI `/login` flow remains available as an alternative; both paths write to the same local credential store.
- **API-key providers, including OpenAI-compatible gateways:** set up in the web app: open **AI setup**, then **Add another provider**, then **Add gateway**; give the gateway a name, enter its base URL and API key, load the models it routes, and approve the ones your rooms may use. You can save several gateways, for example a personal endpoint and a company one, and each appears as its own profile row you can switch to. The terminal wizard (`exxperts setup openai-compatible`, with the API key entered through the CLI `/login` prompt) remains available for the first gateway.

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
| `openai-compatible` | The name you gave your first gateway | `openai-compatible` | In-app **Add gateway**, or terminal setup + CLI `/login` API-key entry; bring-your-own gateway for advanced users/orgs. |
| `gateway-<name>` | The name you gave that gateway | `gateway-<name>` | In-app **Add gateway**. Every gateway after the first gets ids of its own so the first one's ids never move. |

Any other provider the runtime knows (Google Gemini, Groq, Mistral, DeepSeek, OpenRouter, xAI, and about 25 more) can be added from the web app: open **AI setup** and use **Add another provider**, then sign in with a subscription where the provider offers one, or paste an API key. After signing in, approve the models that provider may use in rooms plus the one that runs Memorize and Review. Approval creates the provider's AI profile; without it, the provider is signed in but not usable in rooms.

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

Alternative (CLI `/login`): start the CLI/TUI (`exxperts cli`, `exxperts-cli`, or the repo wrapper `./scripts/exxperts-cli`), run `/login`, select `Use a subscription`, then `ChatGPT Plus/Pro (Codex Subscription)`, and complete the browser OAuth flow. If the CLI/TUI asks you to paste a redirect URL or code, paste it only into the CLI/TUI prompt. Both paths store credentials in the same local auth store.

Do not paste redirect URLs, auth codes, tokens, screenshots, or raw auth files into docs, issues, or chat. Provider OAuth labels and browser screens can change outside this repository.

### 2. Select the profile

On **AI setup**, when ChatGPT Plus/Pro shows as connected, select **ChatGPT Plus/Pro** in the AI profile controls. The active product profile becomes `chatgpt-codex`.

Profile switching is readiness-gated. If the profile is not ready, the web app keeps it unselectable and shows setup/status guidance. To disconnect later, open **Connection details** at the bottom of the page and use **Sign out**.

### 3. Start or resume a compatible room

The active profile governs current persistent-room/product LLM workflows. Switching the active profile does not rewrite old threads or model locks.

Message-bearing room threads are model-locked and resume with their locked model. To change models cleanly, close the conversation with Remember or Forget. If you leave before sending a new turn after that boundary, Exxperts retires the empty prepared runtime and returns the room to a fresh-entry state where the model picker applies to the next runtime.

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

Alternative (CLI `/login`): start the CLI/TUI (`exxperts cli`, `exxperts-cli`, or the repo wrapper `./scripts/exxperts-cli`), run `/login`, select `Use a subscription`, then `Anthropic (Claude Pro/Max)`, and complete the browser OAuth flow. If the CLI/TUI asks you to paste a redirect URL or code, paste it only into the CLI/TUI prompt. Both paths store credentials in the same local auth store.

Do not paste redirect URLs, auth codes, tokens, screenshots, or raw auth files into docs, issues, or chat. Anthropic/Claude OAuth labels, browser screens, and account entitlement behavior can change outside this repository.

> Note: Anthropic API-key setup exists in the embedded runtime, but this product profile is documented as a subscription/OAuth profile. API-key product setup is deferred.

### 2. Select the profile

On **AI setup**, when Claude shows as connected, select **Claude** in the AI profile controls. The active product profile becomes `anthropic`.

Profile switching is readiness-gated. If the profile is not ready, the web app keeps it unselectable and shows setup/status guidance. To disconnect later, open **Connection details** at the bottom of the page and use **Sign out**.

### 3. Start or resume a compatible room

The active profile governs current persistent-room/product LLM workflows. Switching the active profile does not rewrite old threads or model locks.

Message-bearing room threads are model-locked and resume with their locked model. To change models cleanly, close the conversation with Remember or Forget. If you leave before sending a new turn after that boundary, Exxperts retires the empty prepared runtime and returns the room to a fresh-entry state where the model picker applies to the next runtime.

## OpenAI-compatible gateway setup

Use this path when you or your organization operate an OpenAI Chat Completions-compatible gateway, for example a LiteLLM deployment or another gateway that exposes a compatible `/v1/chat/completions` surface.

You can save as many gateways as you need. Each one has its own name, base URL, API key and approved models, and each appears as its own row in the AI profile list next to ChatGPT and Claude, so switching to a gateway works exactly like switching to any other profile. A personal endpoint and a company gateway can sit side by side without one overwriting the other.

Current identities:

| Concept | Value |
| --- | --- |
| Product profile id | `openai-compatible` for the first gateway, `gateway-<name>` for each one after it |
| Web profile label | The name you gave the gateway |
| Runtime provider id | Same as the product profile id |
| Setup command | `exxperts setup openai-compatible` (first gateway only) |
| CLI/TUI API-key option | OpenAI-compatible gateway (first gateway only) |
| Transport/API mode | `openai-completions` |

The first gateway keeps the ids it has always had. Every room thread stores the provider and model it is locked to, so those ids are load-bearing: an existing setup carries over untouched and nothing needs re-approving. Gateways added afterwards get ids derived from the name you give them.

Requirements:

- A gateway base URL, for example `https://gateway.example.com/v1`.
- A real API key for that gateway.
- Non-confidential test prompts for validation.
- Terminal access, if you use the terminal wizard rather than the app.

Rooms call tools on every turn, so a model has to support function calling to be usable in one. A model that does not is not a good candidate to approve as a room model, however well it writes.

### Add a gateway in the web app

Open **AI setup**, then **Add another provider**, then **Add gateway**. Give the gateway a name, enter its base URL and API key, and choose **Load models from gateway**. Exxperts calls the gateway's `/models` and shows what it routes, so you approve from a list instead of copying ids by hand. If your gateway does not publish a model list, **enter ids manually** takes exact ids instead.

Each model in the list carries four decisions:

- **Approve**: whether rooms may run on this model.
- **Supports images**: whether attached images are sent to the model. A model left unticked is registered as text-only, and an attached image is not sent to it. The room says so plainly rather than passing the image along silently.
- **Supports web search**: whether this model may search the web through the gateway's own search machinery. Ticking it makes Exxperts ask for provider-side search on every request to that model, so the model can look things up itself instead of only through the room's `web_search` tool. Leave it unticked unless the gateway really runs search for that model. A gateway that does not will do one of two things, and only one of them is loud: some reject that model's requests outright, others accept the request, ignore the field and answer without searching. Because the second failure is silent, confirm a newly ticked model with a question about something current before relying on it. The room's own `web_search` tool stays available either way, and the two coexist. Detection ticks this for you where a gateway declares it; otherwise it is yours to set. See [`web-search.md`](web-search.md) for the app's own search, which is a separate setting.
- **Context window**: the token budget Exxperts assumes for this model. It drives the room's context reading and decides when a conversation is compacted, so a wrong number here is felt as premature compaction or as a chip that never fills.

Below the list, pick the model that runs Memorize and Review. Save, and the gateway appears as a profile row.

Model ids are exact strings supplied by your gateway and are often case-sensitive. If you are unsure whether the id is `gpt-5.5`, `GPT-5.5`, `gpt5.5`, or another alias, ask the gateway owner/admin or check the gateway's API/model documentation before approving it.

### What auto-detection fills in, and when it cannot

After loading the model list, Exxperts asks the gateway what it is willing to say about its own models and pre-fills the fields above from the answer. Nothing announces this; the values are simply there, and every field stays editable. Whatever you save is what counts.

Three shapes are understood:

- **LiteLLM `/model/info`**: per-model image support, web-search support and token limits. The most complete answer, and the one that wins where sources disagree, because it describes the deployment rather than a catalogue entry.
- **LiteLLM `/models`**: a LiteLLM deployment also states `max_input_tokens` on its ordinary model rows, so context windows fill in from there even when the richer route is unavailable.
- **OpenRouter `/models`**: modality and `context_length` on the model rows, which fills in image support and the context window. Web search is only ever declared on LiteLLM's `/model/info`, so it stays yours to set here.

A gateway that publishes none of this is not a lesser gateway. The form opens on the defaults, a context window of 128000 shown rather than hidden, and you fill in what you know.

**Restricted virtual keys.** A LiteLLM virtual key is often scoped to the `llm_api_routes` group, which does not include the model info route. Such a key gets a `403` naming the allowed routes, and that is a correctly configured company gateway, not a broken one. Detection stays useful: context windows still fill in from `max_input_tokens` on the plain `/models` rows, and the images and web-search ticks are left to you, since no shape available to that key carries them. If you want full detection, the gateway administrator can allow the model info route on virtual keys.

### Edit, switch, and remove a gateway

Every gateway's row on the **AI setup** page carries its own menu:

- **Approve models** changes the model set and the two per-model fields. The address and key are untouched.
- **Edit gateway** owns the name, base URL and API key. Leaving the key field blank keeps the stored key.
- **Remove gateway** deletes that gateway's model catalog entry, its stored key, and its profile. Other gateways keep their models and stay signed in.

Removing a gateway is not reversible from inside the app, and it does not migrate rooms. Threads locked to one of its models stop resolving that model and cannot resume until you select a model they can use, so prefer editing a gateway over removing and re-adding one. A gateway added again later gets a new provider id even if you give it the same name, precisely so that rooms still pointing at the removed one do not silently re-attach to a different endpoint.

### Terminal setup for the first gateway

The terminal wizard remains available and manages the first gateway only. It and the app write the same files, so a gateway set up in the terminal is editable in the app and an edit made in the app is visible to the wizard. The wizard does not ask about image support, web search or context windows; it preserves whatever the app recorded rather than resetting it.

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

Paste the API key only into the CLI/TUI prompt. The key is stored in runtime auth state under `~/.exxperts/agent/auth.json`; do not paste it into docs, issues, pull requests, chat, screenshots, or `models.json`.

### 3. Refresh web readiness and select the profile

Return to the web app and open **AI setup**. Refresh provider/auth status.

A gateway profile is readiness-gated. It becomes selectable only when all of these are true:

1. The gateway is described either by `~/.exxperts/app/openai-compatible-gateways.json` or, for the first gateway, by `~/.exxperts/app/openai-compatible-ai-profile.json`.
2. `~/.exxperts/agent/models.json` contains the gateway's provider entry and the mapped model ids.
3. Credentials are configured for that gateway's provider id through `/login`, the app, or another runtime-supported auth source.

When ready, select the gateway by name. Persistent-room model options should show only the room models approved for it.

### 4. Understand the local policy

The local app policy approves only the model ids you approved:

| Process | Mapping |
| --- | --- |
| Persistent-room conversation | Explicit `roomModels` for that gateway |
| Remember (checkpoint compression) | Inherits the selected persistent-room model |
| Memorize (absorb recent context) | `maintenanceModel` |
| Review (structural review) | `maintenanceModel` |

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

The terminal setup command does not fetch `/models`, list available model ids, validate reachability, validate the API key, or automatically approve every model exposed by the gateway. The app's **Add gateway** and **Approve models** steps do fetch the model list and read whatever capabilities the gateway publishes, but neither approves anything on your behalf and neither validates that a model actually works. If a disposable validation room later fails with a non-secret error such as "model not found" or "unknown model", correct the model id in **Approve models**, or rerun the terminal setup with the exact id or alias expected by the gateway.

Capability values that were auto-detected are still the gateway's claims, not verified behavior. A model marked as supporting images may still refuse them upstream, and a declared context window may not match what the upstream provider enforces. Validate with non-confidential prompts before relying on either.

## Current ChatGPT/Codex process-model policy

The provider catalog may contain more `openai-codex` models than the product approves. Persistent-room workflows use the architect-approved process/model policy in `apps/web-server/src/persistent-agent-ai-profiles.ts`.

Current `chatgpt-codex` mapping:

| Process | Approved provider/model |
| --- | --- |
| Persistent-room conversation | `openai-codex/gpt-5.5` |
| Remember (checkpoint compression) | Inherits the selected persistent-room model |
| Memorize (absorb recent context) | `openai-codex/gpt-5.5` |
| Review (structural review) | `openai-codex/gpt-5.5` |

Model-policy editing is not a user/admin feature today. Any editable policy needs a separate product design for storage, schema, validation, merge behavior, thread-lock safety, and rollback.

## Current Claude/Anthropic process-model policy

The provider catalog may contain more `anthropic` models than the product approves. Persistent-room workflows use the architect-approved process/model policy in `apps/web-server/src/persistent-agent-ai-profiles.ts`.

Current `anthropic` mapping:

| Process | Approved provider/model |
| --- | --- |
| Persistent-room conversation | `anthropic/claude-opus-4-8`, `anthropic/claude-sonnet-5`, `anthropic/claude-fable-5`, `anthropic/claude-opus-4-6`, `anthropic/claude-opus-4-7`, `anthropic/claude-sonnet-4-6` |
| Remember (checkpoint compression) | Inherits the selected persistent-room model |
| Memorize (absorb recent context) | `anthropic/claude-opus-4-8` |
| Review (structural review) | `anthropic/claude-opus-4-8` |

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
| `~/.exxperts/app/` | Product/app state, active AI profile, selected persistent-room model, saved gateway policy, persistent rooms. |
| `~/.exxperts/agent/` | Embedded runtime provider/auth/model/settings/session state, including gateway `models.json` and runtime `auth.json`. |

Status endpoints and UI should be used for readiness checks, not for copying or sharing credential files.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| **Sign in →** does nothing or the login tab never opens | Allow pop-ups for the Exxperts page and retry. Only one sign-in can run at a time; use **Cancel** on the profile card to clear a stuck attempt first. |
| In-app sign-in reports "Sign-in timed out" | The flow expires after 5 minutes. Retry from **AI setup**; if it keeps failing, try the CLI `/login` path and report a non-secret description. |
| ChatGPT Plus/Pro or Anthropic option is not visible in `/login` | Confirm you chose `Use a subscription`; provider labels may have changed; escalate with a non-secret description. |
| OpenAI-compatible gateway is not visible under `/login` → `Use an API key` | Run `exxperts setup openai-compatible` first so runtime `models.json` defines provider `openai-compatible`; restart the CLI/TUI if needed. |
| Gateway validation fails with `model not found`, `unknown model`, or similar | Confirm the exact model id/alias with the gateway owner/admin. Model ids can be case-sensitive. Correct it in **Approve models**, or rerun `exxperts setup openai-compatible` with the corrected id; do not paste raw gateway logs or keys. |
| A gateway model ignores an attached image | The model is registered as text-only. Tick **supports images** for it in **Approve models**, and confirm with the gateway owner/admin that the model really accepts image input. |
| A room compacts far too early, or its context reading never moves | The model's context window is wrong. Correct it per model in **Approve models**; auto-detection fills it in only where the gateway declares it. |
| Sign-in succeeds but the web still shows not connected | Use **Refresh** on the AI setup page; restart the web app if needed; do not inspect or share raw credential files. |
| Profile cannot be selected | The readiness gate likely still sees missing auth, missing runtime model config, or missing/invalid local app policy. Refresh status and check the profile diagnostics. |
| Room cannot resume after switching profile | Message-bearing saved threads are model-locked. Select the compatible profile to resume that thread. To change models cleanly, resume under a compatible profile, close the conversation with Remember or Forget, then leave before the next turn to return the room to fresh-entry state where the picker applies. |
| Status output appears to contain secrets | Stop and escalate before sharing screenshots/output. |

## Related docs

- [How Exxperts works](how-exxperts-works.md): where AI profiles and per-process model locks fit in the architecture.
