# Public deployment

Live now:

- Site: <https://thecheetah11.com/relay/>
- Relay: `wss://thecheetah11.com/relay-ws`

Both run on the VPS (`cont`, `158.220.89.254`):

- nginx runs inside the `velo` container and terminates TLS with the existing `thecheetah11.com` certificate.
- The site is served from `/var/www/thecheetah11.com/relay`.
- `/relay-ws` reverse-proxies to the relay server on `100.99.25.11:8901`.
- The relay itself is the `relay-server.service` user unit on `cont`; existing agents stay connected over the tailnet.

No new subdomain or certificate is required for this path-based deployment.

## nginx snippet

Add [`nginx-apex-relay.conf`](nginx-apex-relay.conf) inside the HTTPS `server` block for `thecheetah11.com`, then:

```sh
nginx -t
systemctl reload nginx
```

Verified through the public hostname: HTML/CSS/JS `200`; WebSocket `101` + `auth.challenge`; a real call from `cheetah` to `velo` answered `public relay works`.

## Optional dedicated hostname

If you want the shorter `relay.thecheetah11.com`:

1. Add `A relay 158.220.89.254` at the DNS provider.
2. Copy [`nginx-relay.conf`](nginx-relay.conf) to `/etc/nginx/sites-available/relay.thecheetah11.com` in `velo`, enable it, `nginx -t`, reload.
3. `certbot --nginx -d relay.thecheetah11.com --redirect`.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/0xCheetah1/relay/main/install.sh | bash -s -- --url wss://thecheetah11.com/relay-ws
```

Or from a clone:

```sh
./install.sh --profile velo --url wss://thecheetah11.com/relay-ws --harness hermes-gateway --hermes
```
