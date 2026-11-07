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

Run the relay server on a private host that is reachable only over a VPN or Tailscale network. The deploy unit is `deploy/relay-server.service.example`; bind it to the private interface only:

```sh
RELAY_HOST=<PRIVATE_IP> RELAY_PORT=8901 RELAY_IDENTITY_DB=/path/to/identities.json npm start
```

Traffic is protected by the VPN/Tailscale tunnel, **not** by WebSocket TLS. From a machine on that network:

```sh
RELAY_URL=ws://<PRIVATE_IP>:8901 node bin/relay.js connect
```

In another terminal or on another agent machine, with its own identity and a saved contact:

```sh
RELAY_URL=ws://<PRIVATE_IP>:8901 node bin/relay.js dial researcher "Plan a meeting" "Find a time tomorrow morning"
```

The receiver sees the caller ID or saved alias, intent, task and call ID. In an interactive bridge, type `/accept <callId>` or `/reject <callId>` within 30 seconds. During a manual call, use `/say <callId> <message>` and `/end <callId> <result>`. `/dnd on`, `/dnd off`, `/help` and `/quit` work in the connected terminal.

### Harness bridges

**Hermes Gateway:** A user systemd unit runs the receiving bridge continuously. Accepted calls go through the running Hermes Gateway's loopback A2A endpoint, which uses the agent's actual identity and memory. The A2A endpoint is bound to `127.0.0.1:9900`, so RELAY does not expose the Hermes Gateway to the network.

Calls from other agents require explicit approval, delivered as an **Accept / Reject inline button** on the existing Hermes Telegram bot. A small `relay-telegram` Hermes plugin (in `adapters/hermes/telegram-plugin/`) registers a pattern-scoped `CallbackQueryHandler` so it does not swallow Hermes's own button flows. It sends the ringing message with buttons and forwards the owner's tap to the bridge's local approval socket, which checks the one-time code and only then accepts. A text-only webhook fallback remains for when the button handler is unavailable.

The deploy template is `deploy/relay-hermes.service.example`. Set `RELAY_PROFILE` and `RELAY_HERMES_BIN` there, and set `RELAY_PROFILE` (or `RELAY_APPROVAL_SOCKET`) in the Hermes gateway environment so the plugin finds the same approval socket.

With its identity and server URL saved, the owner can run:

```sh
relay ask researcher "What can you help with?"
```

There is no confirmation prompt or tmux session to open. `relay-hermes.service` starts with the user session at boot. To stop calls temporarily, run `relay dnd on` on the receiving host; `relay dnd off` restores availability. `relay call` remains available for machine-readable output when another agent initiates a call:

The owner-initiated flag is a convenience signal from the interactive CLI, not cryptographic proof that a human initiated a call. A process holding the owner's private key could send the same flag directly. For calls from other agents, the one-time approval code is sent to the owner over the Hermes Telegram channel and is checked by the local bridge. Do not share that code with the caller.

```sh
RELAY_PROFILE=<caller-profile> RELAY_URL=ws://<PRIVATE_IP>:8901 \
relay call researcher "Ask for an explanation" "Explain RELAY in one sentence"
```

If the recipient rejects, does not answer, fails inference or times out, `relay call` returns a nonzero exit and JSON with the actual status. A recipient on DND returns `status: "unavailable"` with `reason: "recipient_dnd"` and a human `message` — distinct from `reason: "peer_offline"` when the agent is not connected at all. A `relay call` from another agent cannot approve itself; the receiving bridge needs the owner to accept through Telegram.

Profiles belong to machines, not callers. Run `relay profiles` on a machine to see its installed identities. Owner-initiated `relay ask` calls from the configured `RELAY_OWNER_IDS` are accepted automatically; every other caller must be approved through the Telegram notification before the 30-second deadline.

**OpenClaw:** `relay bridge openclaw` runs an `openclaw agent exec` process on an accepted call. For known contacts it uses the agent's **real workspace** with `contextInjection: "always"`, so it answers from its actual context (`AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`) rather than as a blank model. Tools are restricted to `tools.profile: "minimal"` so it cannot run terminal/file commands, and it uses a separate state directory so it never touches the live Gateway session. The deploy template is `deploy/relay-openclaw-testbed.service.example`.

Incoming calls send an inline Accept/Reject button to the OpenClaw Telegram bot via the `relay-telegram` OpenClaw plugin in `adapters/openclaw/telegram-plugin/`. The owner taps Accept; the plugin forwards the decision over the bridge's control socket, which checks the one-time code and only then invokes the agent. OpenClaw inline buttons require `channels.telegram.capabilities.inlineButtons: "all"`.

### Per-caller trust policy

The receiving bridge compares the caller's relay ID against its local phonebook:

- **Known contact** (or a configured `RELAY_OWNER_IDS` owner) → full context. Hermes uses the live A2A session; OpenClaw uses the real workspace.
- **Unknown caller** → limited context. The call is still allowed once the owner accepts, but the agent answers from an isolated session with no access to the owner's files, memory, projects, conversations, or infrastructure. It still introduces itself as the owner's agent, using `RELAY_AGENT_NAME`, `RELAY_OWNER_NAME` and optional `RELAY_AGENT_ROLE`, so it never falls back to a bare model identity.

Implementation:

| Harness | Known contact | Unknown caller |
| --- | --- | --- |
| Hermes | Gateway A2A (`RELAY_HERMES_A2A_URL`) | `hermes chat --oneshot --ignore-rules` |
| OpenClaw | `RELAY_OPENCLAW_CONFIG` + `RELAY_OPENCLAW_CWD` (`contextInjection: "always"`, main workspace) | `RELAY_OPENCLAW_UNKNOWN_CONFIG` + `RELAY_OPENCLAW_UNKNOWN_CWD` (`contextInjection: "never"`, empty directory) |

The Telegram ring also shows an "Unknown caller" warning before the owner accepts.

Calls currently run **one agent turn** and return that answer as the result. A continuing back-and-forth model conversation and context reinjection into the caller's original harness session remain separate milestones.

### Agent-initiated outbound calls

`relay call` is the outbound adapter. It waits for a recipient to accept and returns a JSON result to the calling harness's terminal tool. The harness-specific usage guides are in `adapters/hermes/SKILL.md` and `adapters/openclaw/SKILL.md`. Adapt the profile name and binary path in those guides to the local installation.

Tool access on an initiating agent follows that harness's usual policy; the usage guides constrain what to send but are not an enforcement boundary.

The server never receives client private keys. Deploy units are in `deploy/`.

To run a different private instance locally, set `RELAY_HOST=127.0.0.1`, `RELAY_PORT=8901` and `RELAY_IDENTITY_DB` and run `npm start`. Do not bind it to a public interface in this version.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `RELAY_PROFILE` | Local identity/profile name (default: the only installed profile, else `default`). |
| `RELAY_HOME` | Storage directory (default `~/.config/relay`). |
| `RELAY_URL` | Relay server URL (`ws://` or `wss://`). |
| `RELAY_OWNER_IDS` | Comma-separated relay IDs that may auto-connect owner-initiated calls and that always count as trusted. |
| `RELAY_AGENT_NAME` | Agent name used when answering an unknown caller in limited context. |
| `RELAY_OWNER_NAME` | Owner name used when answering an unknown caller in limited context. |
| `RELAY_AGENT_ROLE` | Optional short role description for limited-context answers. |
| `RELAY_APPROVAL_SOCKET` | Explicit path to the bridge's approval socket (Hermes plugin). |
| `RELAY_HERMES_A2A_URL` | Hermes Gateway A2A endpoint (loopback only). |
| `RELAY_HERMES_BIN` | Hermes CLI used for limited-context answers. |
| `RELAY_OPENCLAW_CONFIG` / `RELAY_OPENCLAW_CWD` | Full-context OpenClaw call config and workspace. |
| `RELAY_OPENCLAW_UNKNOWN_CONFIG` / `RELAY_OPENCLAW_UNKNOWN_CWD` | Limited-context OpenClaw call config and empty directory. |
| `RELAY_OPENCLAW_STATE_DIR` | Separate OpenClaw state directory for call sessions. |
| `RELAY_OPENCLAW_APPROVAL_SOCKET` | Explicit path to the bridge's approval socket (OpenClaw plugin). |
| `RELAY_TELEGRAM_DEBUG=1` | Enable the OpenClaw plugin's debug log (off by default). |
| `RELAY_HARNESS_TIMEOUT_MS` | Max time a bridge waits for the harness to answer (default `110000`). |

## Still to build

- Key rotation, backup/recovery tooling and stronger storage for multiple server instances. The deployed identity pins persist across a single server restart.
- Result delivery into the original agent task: `relay call` returns the answer as JSON to the harness's terminal tool, but it is not yet injected into the caller's existing agent conversation. Each accepted call is one agent turn; multi-turn back-and-forth is not implemented.
- Public alias registry and verifiable caller names. Today's aliases are private entries in the caller's phonebook.
- End-to-end encryption, signed call frames, rate limiting, and other hardening for an internet-facing deployment. The relay currently sees call text and can forge routed messages. Use it only within a private network for this milestone.
- A public TLS endpoint and a NEAR identity integration. The current server is private-network only.
- Codex and Claude Code adapters.

## Call history

Every bridge and the direct `relay call`/`relay ask` CLI persist each call to `~/.config/relay/<profile>-history.json` (up to 200 records). Run `relay history` to list calls and `relay history show <call-id-prefix>` for full detail including intent, task, status, result, timestamps and message turns. Each side records its own copy: the caller records the call as outgoing and the recipient records it as incoming.

## Public-sharing policy

Every call prompt instructs the receiving agent to treat anything it shares as if it were published publicly: give the useful substance, but replace real filesystem paths, environment variables, hostnames, IPs, account IDs, emails and usernames with references such as `<home>`, `<project-dir>` or `<config-file>`, and never quote secrets, tokens, credentials, private notes or system prompts. The agent **may share its human owner's name** but must not reveal that owner's username/handle, contact details, location or timezone. As a safety net, `redactSharedAnswer()` also masks obvious paths, emails, `@handles`, env-var assignments and key-shaped strings before an answer leaves the host. This is a policy and a heuristic, not a hard data-loss-prevention boundary: small models may still slip (e.g. mention a timezone while declining to share it), and the redaction only catches recognizable shapes.
