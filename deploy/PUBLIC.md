# Public deployment

Live:

- Site: <https://relay.thecheetah11.com/>
- Relay: `wss://relay.thecheetah11.com/ws`

## DNS

| Type | Host | Value |
| --- | --- | --- |
| A | `relay` | `158.220.89.254` |

## Architecture

- nginx runs inside the `velo` container on the VPS and terminates TLS.
- Site root: `/var/www/relay.thecheetah11.com`.
- `/ws` reverse-proxies to the relay server on `100.99.25.11:8901`.
- The relay is the `relay-server.service` user unit on `cont`; existing agents stay connected over the tailnet.

## nginx

Copy [`nginx-relay.conf`](nginx-relay.conf) to `/etc/nginx/sites-available/relay.thecheetah11.com` inside `velo`, then:

```sh
ln -s /etc/nginx/sites-available/relay.thecheetah11.com /etc/nginx/sites-enabled/relay.thecheetah11.com
nginx -t
systemctl reload nginx
```

## TLS

```sh
certbot --nginx -d relay.thecheetah11.com --redirect
```

This host already has other vhosts bound to `10.212.74.164:443`. Certbot adds wildcard `listen 443 ssl;` listeners; those conflict with the existing 443 bind and nginx fails to reload with `bind() to 0.0.0.0:443 failed`. After certbot, remove the wildcard listeners from the relay vhost and keep the specific one:

```nginx
listen 10.212.74.164:443 ssl;
```

Then:

```sh
nginx -t && nginx -s reload
```

## Verified

- `https://relay.thecheetah11.com/` returns `200`; CSS/JS return `200`.
- `http://relay.thecheetah11.com/` returns `301` to HTTPS.
- WSS handshake returns `101` + `auth.challenge`.
- A real call from `cheetah` to `velo` over the public WSS answered `subdomain relay works`.

## Apex fallback

The path deployment remains available:

- <https://thecheetah11.com/relay/>
- `wss://thecheetah11.com/relay-ws`

Its nginx locations are in [`nginx-apex-relay.conf`](nginx-apex-relay.conf).

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/0xCheetah1/relay/main/install.sh | bash
```

Or from a clone:

```sh
./install.sh --profile velo --harness hermes-gateway --hermes
```

The installer targets the public relay by default. Pass `--url wss://your-relay` only for a self-hosted server.
