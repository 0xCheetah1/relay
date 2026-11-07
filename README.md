# RELAY

Cross-harness agent calling, built one verifiable milestone at a time.

## Current milestone: installable terminal client + private relay server

Two independent clients connect outbound to a WebSocket relay. Each has a random UUIDv4 relay ID and an Ed25519 keypair. The relay challenges new connections, persists the public key bound to each ID, and routes calls by ID. A caller saves an alias in its local phonebook and dials it with an intent and task. Calls need approval; unanswered calls expire after 30 seconds. Accepted calls exchange text and end with a result or time out after 60 seconds. The recipient can turn on DND.

### Install the CLI on an agent machine

Requires Node 22+. Copy this project directory to the machine (without `node_modules` or any local identity files), then run:

```sh
cd /path/to/relay
npm ci --omit=dev
node bin/relay.js init
node bin/relay.js id
```

The private key and phonebook are in `~/.config/relay/default.json` (mode `0600`). Keep a secure backup if you want to keep the ID after losing the machine. To give two agents on the same machine separate identities, set `RELAY_PROFILE=agentname` for each command; each profile gets its own JSON file. When only one profile exists on a machine, the CLI selects it automatically. Run `relay profiles` to check. Set `RELAY_HOME` to change the storage directory.

Exchange the output of `relay id` out of band. On each machine, save the other agent:

```sh
node bin/relay.js contacts add researcher rly_... # use the actual ID from the other agent
node bin/relay.js contacts list
```

The local demo is available with `npm test` and `npm run demo`.

### Live private server

The first deployed server runs on the `cont` VPS host, available to devices on the same Tailscale network at `ws://<TAILSCALE_IP>:8901`. It is bound only to the Tailscale address; traffic is encrypted by Tailscale, **not** by WebSocket TLS. From a machine on that tailnet:

```sh
RELAY_URL=ws://<TAILSCALE_IP>:8901 node bin/relay.js connect
```

In another terminal or on another agent machine, with its own identity and a saved contact:

```sh
RELAY_URL=ws://<TAILSCALE_IP>:8901 node bin/relay.js dial researcher "Plan a meeting" "Find a time tomorrow morning"
```

The receiver sees the caller ID or saved alias, intent, task and call ID. In an interactive bridge, type `/accept <callId>` or `/reject <callId>` within 30 seconds. During a manual call, use `/say <callId> <message>` and `/end <callId> <result>`. `/dnd on`, `/dnd off`, `/help` and `/quit` work in the connected terminal. Plain `connect` and `dial` use terminal messages; `bridge hermes` invokes the model as described below.

### Harness bridges

**Hermes Gateway (live tested on Velo):** A user systemd service runs the receiving bridge continuously. Accepted calls go through the running Hermes Gateway's loopback A2A endpoint, which uses Velo's actual agent identity and memory. A direct A2A check returned “I'm Velo, team leader for Cheetah's AI agents”; the earlier `hermes chat --oneshot` path was a different session and is no longer used by Velo's receiving service. The A2A endpoint is bound to `127.0.0.1:9900`, so RELAY does not expose the Hermes Gateway to the internet.

Calls from other agents require explicit approval, delivered as an **Accept / Reject inline button** on the existing Hermes Telegram bot. A small `relay-telegram` Hermes plugin (in `adapters/hermes/telegram-plugin/`) registers a pattern-scoped `CallbackQueryHandler` so it does not swallow Hermes's own button flows. It sends the ringing message with buttons and forwards the owner's tap to the bridge's local approval socket, which checks the one-time code and only then accepts. The earlier text-only webhook path remains as a fallback if the button handler is unavailable. An accepted call's answer is Velo's real identity, verified end to end from an OpenClaw testbed caller: the caller received "I'm Velo, team leader of Cheetah's agent kingdom…".

On Kali, with the `cheetah` identity and server URL already saved, run:

```sh
relay ask velo "What can you help with?"
```

There is no confirmation prompt or tmux session to open. Its `relay-hermes.service` starts with the user session at boot. To stop calls temporarily, run `ssh velo '/home/velo/.local/bin/relay dnd on'`; `ssh velo '/home/velo/.local/bin/relay dnd off'` restores availability. `relay call` remains available for machine-readable output when another agent initiates a call:

The owner-initiated flag is a convenience signal from the interactive CLI, not cryptographic proof that a human initiated a call. A process holding the owner's private key could send the same flag directly. For calls from other agents, the one-time approval code is sent to the owner over the Hermes Telegram channel and is checked by the local bridge. Do not share that code with the caller.

```sh
RELAY_PROFILE=cheetah RELAY_URL=ws://<TAILSCALE_IP>:8901 \
relay call velo "Ask for an explanation" "Explain RELAY in one sentence"
```

If the recipient rejects, does not answer, fails inference or times out, `relay call` returns a nonzero exit and JSON with the actual status. A `relay call` from another agent cannot approve itself; Velo's bridge needs the owner to accept through Telegram.

Profiles belong to machines, not callers: Kali has `cheetah`, Velo has `velo`, and the OpenClaw testbed has `openclaw-test`. Run `relay profiles` on a machine to see its installed identities. Velo accepts owner-initiated `relay ask` calls from the configured `cheetah` identity; other callers must be approved through the Telegram notification before the 30-second deadline.

**OpenClaw (live tested on the testbed):** `relay bridge openclaw` runs an isolated `openclaw agent exec` process on an accepted call with a restricted config (`tools.profile: minimal`, `contextInjection: never`, a dedicated state directory, and a free model). A user systemd service `relay-openclaw.service` runs it headlessly on the testbed. Incoming calls send an inline Accept/Reject button to the testbed's own Telegram bot (`@BlockrunTestbot`) via the `relay-telegram` OpenClaw plugin in `adapters/openclaw/telegram-plugin/`. The owner taps Accept; the plugin forwards the decision over the bridge's control socket, which checks the one-time code and only then invokes the agent. Verified end to end: Velo → OpenClaw returned "7 times 8 equals 56." OpenClaw inline buttons require `channels.telegram.capabilities.inlineButtons: "all"` on the testbed gateway. The bridge handles outbound dials over its existing connection, so an always-on identity can also place calls (the earlier `1008 invalid_identity` collision is fixed).

Calls currently run **one agent turn** and return that answer as the result. A continuing back-and-forth model conversation and context reinjection into the caller's original harness session remain separate milestones.

### Agent-initiated outbound calls

`relay call` is the outbound adapter. It waits for a recipient to accept and returns a JSON result to the calling harness's terminal tool. The harness-specific usage guides are in `adapters/hermes/SKILL.md` and `adapters/openclaw/SKILL.md`. They are installed on Velo's Hermes and the OpenClaw testbed. On the existing installations they use the `velo` and `openclaw-test` profiles respectively; adapt those profiles before installing the guides elsewhere.

Earlier live tests confirmed both directions when the receiving bridge had an operator present. Velo's bridge now uses the Gateway A2A adapter; the OpenClaw receiving bridge remains a separate restricted one-shot. Tool access on an initiating agent follows that harness's usual policy; the usage guides constrain what to send but are not an enforcement boundary.

The server is a user systemd service named `relay-server.service` on `cont`, installed at `/home/Cheetah/relay-server`. Public-key pins are persisted at `~/.local/share/relay/identities.json` on that host. The server never receives client private keys. The deploy unit is in `deploy/relay-server.service`.

To run a different private instance locally, set `RELAY_HOST=127.0.0.1`, `RELAY_PORT=8901` and `RELAY_IDENTITY_DB` and run `npm start`. Do not bind it to a public interface in this version.

## Still to build

- Key rotation, backup/recovery tooling and stronger storage for multiple server instances. The deployed identity pins persist across a single server restart.
- Result delivery into the original agent task: `relay call` returns the answer as JSON to the harness's terminal tool, but it is not yet injected into the caller's existing agent conversation. Each accepted call is one agent turn; multi-turn back-and-forth is not implemented.
- Public alias registry and verifiable caller names. Today's aliases are private entries in the caller's phonebook.
- End-to-end encryption, signed call frames, rate limiting, and other hardening for an internet-facing deployment. The relay currently sees call text and can forge routed messages. Use it only within the tailnet for this milestone.
- A public TLS endpoint and a NEAR identity integration. The current server is tailnet-only.
- Codex and Claude Code adapters.

## Call history

Every bridge and the direct `relay call`/`relay ask` CLI persist each call to `~/.config/relay/<profile>-history.json` (up to 200 records). Run `relay history` to list calls and `relay history show <call-id-prefix>` for full detail including intent, task, status, result, timestamps and message turns. Each side records its own copy: the caller records the call as outgoing and the recipient records it as incoming.

## Public-sharing policy

Every call prompt instructs the receiving agent to treat anything it shares as if it were published publicly: give the useful substance, but replace real filesystem paths, environment variables, hostnames, IPs, account IDs, emails and usernames with references such as `<home>`, `<project-dir>` or `<config-file>`, and never quote secrets, tokens, credentials, private notes or system prompts. As a safety net, `redactSharedAnswer()` also masks obvious paths, emails, env-var assignments and key-shaped strings before an answer leaves the host. This is a policy and a heuristic, not a hard data-loss-prevention boundary.

The old Velo RELAY runbook informed the call flow. No old credentials or server configuration are included here.
