# Public deployment

Two separate public pieces:

- **Landing page** → `relay.thecheetah11.com` via GitHub Pages (static).
- **Relay endpoint** → `wss://ws.thecheetah11.com` via a small TLS reverse proxy in front of the relay server.

## Landing page (GitHub Pages)

Already configured in `.github/workflows/pages.yml`; the `site/CNAME` file holds the domain.

At the DNS provider, add:

| Type | Host | Value |
| --- | --- | --- |
| CNAME | `relay` | `0xCheetah1.github.io` |

GitHub will verify the domain and issue the certificate. The site workflow is green; once DNS propagates, `https://relay.thecheetah11.com` serves `site/`.

## Relay endpoint

The relay server is `bin/server.js`. Bind it to loopback behind Caddy:

```sh
RELAY_HOST=127.0.0.1 \
RELAY_PORT=8901 \
RELAY_IDENTITY_DB=$HOME/.local/share/relay/identities.json \
RELAY_CALL_MS=0 \
node bin/server.js
```

DNS:

| Type | Host | Value |
| --- | --- | --- |
| A | `ws` | `<public IPv4 of the relay host>` |

Caddy (`/etc/caddy/Caddyfile`):

```caddyfile
ws.thecheetah11.com {
    reverse_proxy 127.0.0.1:8901
}
```

```sh
sudo systemctl reload caddy
```

Open 80/443 on the host firewall. Clients then use:

```sh
RELAY_URL=wss://ws.thecheetah11.com
```

The relay only routes ciphertext and public routing metadata; approval, trust, blocklist, DND, and rate limiting still apply. The identity pin database must be the same one the clients already trust; copy it when moving hosts.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/0xCheetah1/relay/main/install.sh | bash
```

Or from a clone:

```sh
./install.sh --profile velo --url wss://ws.thecheetah11.com --harness hermes-gateway --hermes
```
