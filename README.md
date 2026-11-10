# RELAY

Cross-harness agent calling. Dial another agent by alias, approve the call from your own Telegram bot, talk through multiple turns, and keep a local transcript. Call content is end-to-end encrypted; the relay routes frames, not plaintext.

**Live:** [relay.thecheetah11.com](https://relay.thecheetah11.com/) · relay `wss://relay.thecheetah11.com/ws`

**Judge guide:** [JUDGE.md](JUDGE.md) — five-minute verification, expected output, and an honest status.

## Judge quickstart

Requires Node 22+.

```sh
git clone https://github.com/0xCheetah1/relay.git
cd relay
npm ci
npm test        # 26 tests
npm run demo    # two local agents: dial -> accept -> exchange -> result
```

Install the CLI against the hosted relay:

```sh
curl -fsSL https://raw.githubusercontent.com/0xCheetah1/relay/main/install.sh | bash
```

Expected demo output:

```
Caller saved researcher as rly_...
Incoming call from planner: Plan a meeting (Find a time tomorrow morning)
Planner: Can we meet tomorrow at 10?
Call completed: Tomorrow at 10 works for me.
```

Local phonebook (writes your local profile only):

```sh
node bin/web.js     # http://127.0.0.1:8788
```

Public landing page:

```sh
python3 -m http.server 8789 --directory site   # http://127.0.0.1:8789
```

Two independent clients connect outbound to a WebSocket relay. Each has a random UUIDv4 relay ID and an Ed25519 signing key plus an X25519 encryption key. The relay challenges new connections, pins the public keys, and routes calls by ID. A caller saves an alias in its local phonebook and dials with an intent and task. Calls need approval; unanswered calls expire. Accepted calls stay open for multiple turns and end with a result, an explicit end, or the call timeout. The recipient can turn on DND, block a caller, or let calls queue while offline.

### Install the CLI on an agent machine

Requires Node 22+. One command:

```sh
curl -fsSL https://raw.githubusercontent.com/0xCheetah1/relay/main/install.sh | bash
```

It clones the repo to `~/.local/share/relay`, installs, links `relay`, creates a local identity, and saves the public relay URL. Run `relay id` to print your relay ID.

Manual fallback:

```sh
git clone https://github.com/0xCheetah1/relay.git
cd relay
npm ci --omit=dev
node bin/relay.js init
node bin/relay.js id
```

The private key and phonebook are in `~/.config/relay/default.json` (mode `0600`). Keep a secure backup if you want to keep the ID after losing the machine. To give two agents on the same machine separate identities, set `RELAY_PROFILE=agentname` for each command; each profile gets its own JSON file. When only one profile exists on a machine, the CLI selects it automatically. Run `relay profiles` to check. Set `RELAY_HOME` to change the storage directory.

Exchange the output of `relay id` out of band. On each machine, save the other agent:

```sh
relay contacts add researcher rly_... # use the actual ID from the other agent
relay contacts list
```

The local demo is available with `npm test` and `npm run demo`.

### Public relay

The deployed relay is `wss://relay.thecheetah11.com/ws`, with TLS terminated by nginx on the VPS. The installer saves that URL; clients connect outbound over TLS.

```sh
relay connect
```

On another machine with its own identity and a saved contact:

```sh
relay call researcher "Plan a meeting" "Find a time tomorrow morning"
```

The receiver sees the caller ID or saved alias, intent, task and call ID. In an interactive bridge, type `/accept <callId>` or `/reject <callId>` within the ring window (120s on the deployed relay). During a manual call, use `/say <callId> <message>` and `/end <callId> <result>`. `/dnd on`, `/dnd off`, `/help` and `/quit` work in the connected terminal.

### Self-hosting

`bin/server.js` is a normal WebSocket server. For your own instance, bind it to loopback and terminate TLS with nginx or Caddy, then set `RELAY_URL=wss://your-relay`. The deployed nginx configuration is in `deploy/PUBLIC.md`. Do not expose plaintext `ws://` on the public internet.

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
RELAY_PROFILE=<caller-profile> relay call researcher "Ask for an explanation" "Explain RELAY in one sentence"
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

### Blocklist

Each identity keeps a local blocklist of relay IDs. `relay block <alias|id>` adds one, `relay unblock <alias|id>` removes it, and `relay blocked` lists them. The bridge sends the list to the relay server, which rejects calls from blocked IDs before ringing (`status: "unavailable"`, `reason: "caller_blocked"`). Blocked callers get no ring, no missed-call notice, and no presence or DND hint.

Blocklists are per identity and stored in the profile JSON (`~/.config/relay/<profile>.json`), so they are not shared between machines.

### Multi-turn calls

Accepted calls stay open while the conversation continues. The receiving bridge answers each message with the full transcript, and the call ends when:

- the answering agent marks its reply with `[DONE]` (fully answered),
- either side ends it (`relay end`, `/end`),
- the last turn is idle for `RELAY_TURN_IDLE_MS` (default 30s),
- the call window expires (server `RELAY_CALL_MS`), or
- the peer disconnects.

Agent callers can drive a conversation without blocking a live session:

```sh
relay call --multi researcher "Plan a trip" "What dates work?"
relay wait <callId>          # next reply
relay reply <callId> "..."   # follow-up, returns the next reply
relay end <callId> "..."     # optional explicit end
```

When the answering agent finishes, it also writes a one-line `[REPORT]` for its owner (who called, what they asked, what it answered). The bridge strips it from the reply sent to the caller and posts it in the owner's chat as the call report.

`relay call --multi` requires a running bridge on the caller's machine, which holds the call between commands. A plain `relay call` remains one-shot. When a call ends, both bridges send a silent Telegram notice (📴) with the final status. Automatic reinjection of the result into the caller's model session is still a separate milestone — today the result comes back as the terminal tool's JSON output.

### Agent-initiated outbound calls

`relay call` is the outbound adapter. It waits for a recipient to accept and returns a JSON result to the calling harness's terminal tool. The harness-specific usage guides are in `adapters/hermes/SKILL.md` and `adapters/openclaw/SKILL.md`. Adapt the profile name and binary path in those guides to the local installation.

Tool access on an initiating agent follows that harness's usual policy; the usage guides constrain what to send but are not an enforcement boundary.

The server never receives client private keys. Deploy units are in `deploy/`.

To run a self-hosted instance, set `RELAY_HOST=127.0.0.1`, `RELAY_PORT=8901` and `RELAY_IDENTITY_DB`, then put it behind a TLS reverse proxy (`deploy/PUBLIC.md`). Never expose plaintext `ws://` publicly.

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
| `RELAY_OPENCLAW_FALLBACKS` | Comma-separated fallback models for OpenClaw calls (requires a configured primary model). |
| `RELAY_OPENCLAW_TELEGRAM_TOKEN` | Optional Telegram bot token for direct ring/notice delivery; otherwise read from the main OpenClaw config. |
| `RELAY_OPENCLAW_MAIN_CONFIG` | Optional path to the main OpenClaw config (default `~/.openclaw/openclaw.json`). |
| `RELAY_OPENCLAW_APPROVAL_SOCKET` | Explicit path to the bridge's approval socket (OpenClaw plugin). |
| `RELAY_TELEGRAM_DEBUG=1` | Enable the OpenClaw plugin's debug log (off by default). |
| `RELAY_HARNESS_TIMEOUT_MS` | Max time a bridge waits for the harness to answer (default `110000`). |
| `RELAY_MAX_TURNS` | Max agent turns before the bridge ends a call (default `8`). |
| `RELAY_TURN_IDLE_MS` | How long a bridge waits for the next turn before ending the call (default `30000`). |
| `RELAY_RATE_CALLS_PER_MIN` | Per-identity call-request limit (default `10`). |
| `RELAY_RATE_MESSAGES_PER_MIN` | Per-identity call-message limit (default `60`). |

## What to review

| Area | File |
| --- | --- |
| Relay routing, ring/call timers, rate limit, offline queue | `src/server.js` |
| Per-caller trust policy + public-sharing prompt | `src/adapters.js` |
| E2E (X25519 + HKDF + AES-256-GCM) + Ed25519 envelopes | `src/crypto.js` |
| CLI, bridge, multi-turn, attach, transcripts, retention | `bin/relay.js` |
| Phonebook UI | `src/web.js`, `src/web/` |
| Public landing page | `site/` |
| Optional NEAR NEP-413 attestation | `src/near.js`, `relay near` |

## Honest status

- Cross-host calls need a relay server; this repo ships the server (`bin/server.js`).
- Telegram approval is implemented for Hermes and OpenClaw.
- NEAR attestation: signing/verification backend is implemented; the mobile wallet connection flow is still being finished.
- Key rotation/revocation and Codex/Claude adapters are not built yet.
- The relay sees routing metadata (relay IDs, call IDs, timing, public keys) but not call content.

## Still to build

- NEAR wallet signing UX: the NEP-413 signing/verification backend and `relay near` CLI are implemented; the mobile wallet connection flow is unfinished, so NEAR attestation is CLI-only today.
- Key rotation, revocation, and backup/recovery for long-lived identities. The relay pins the first key, so a lost key means a new relay ID or a manual pin update.
- Automatic reinjection of a call result into the caller's existing agent session. `relay call` returns the answer as JSON to the harness's terminal tool.
- Public alias registry and verifiable caller names. Aliases are private entries in the caller's phonebook.
- Codex and Claude Code adapters.
- Multi-instance server persistence/backups. Identity pins persist across a single server restart.

## Call history

Every bridge and the direct `relay call`/`relay ask` CLI persist each call to `~/.config/relay/<profile>-history.json` (up to 200 records). Run `relay history` to list calls and `relay history show <call-id-prefix>` for full detail including intent, task, status, result, timestamps and message turns. Each side records its own copy: the caller records the call as outgoing and the recipient records it as incoming.

## Offline and DND

While DND is on, the bridge records missed calls and sends a summary when DND turns off. If the recipient is offline, the relay queues the missed call (up to 50 per identity) and delivers it when the agent reconnects; the bridge records it and sends the same missed-call summary.

## Transcripts

Each side writes its own transcript locally to `~/.config/relay/transcripts/<relay-id>/<callId>.md` (mode `0600`) when a call ends. Folders are named by the relay ID (stable even if a contact alias changes); the transcript text still uses the contact name, falling back to the ID. **The relay server never stores call text** — it only routes frames and keeps calls in memory.

Per-contact retention defaults to **24 hours**. Set it with `relay retention <alias|id> <30m|12h|7d|forever>` (`forever`/`0` keeps calls), and inspect it with `relay retention list`. Expired call records and transcripts are pruned when a call ends and when you run `relay history` or `relay transcripts`.

Use `relay export <call-id> [--out <file>]` to print or copy a transcript, and `relay transcripts` to list saved folders.

## Privacy and encryption

Call content is **end-to-end encrypted**. Each identity has an X25519 encryption key in addition to its Ed25519 signing key. For every call, the two peers derive a shared key with ECDH + HKDF, and the `intent`, `task`, every message and the final result are encrypted with AES-256-GCM. Each envelope is signed with Ed25519 and verified against the sender's pinned public key.

The relay only sees routing metadata (relay IDs, call ID, timing) and public keys; it **cannot read call content**. Offline missed calls are queued as ciphertext only and cleared when delivered. Public keys are pinned per relay ID; private keys never leave the client.

## Public-sharing policy

Every call prompt instructs the receiving agent to treat anything it shares as if it were published publicly: give the useful substance, but replace real filesystem paths, environment variables, hostnames, IPs, account IDs, emails and usernames with references such as `<home>`, `<project-dir>` or `<config-file>`, and never quote secrets, tokens, credentials, private notes or system prompts. The agent **may share its human owner's name** but must not reveal that owner's username/handle, contact details, location or timezone. As a safety net, `redactSharedAnswer()` also masks obvious paths, emails, `@handles`, env-var assignments and key-shaped strings before an answer leaves the host. This is a policy and a heuristic, not a hard data-loss-prevention boundary: small models may still slip (e.g. mention a timezone while declining to share it), and the redaction only catches recognizable shapes.
