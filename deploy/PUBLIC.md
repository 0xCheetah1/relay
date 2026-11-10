# Public deployment

RELAY is served from the VPS (host `cont`, public IPv4 `158.220.89.254`), not GitHub Pages and not a Tailscale Funnel.

- nginx runs inside the `velo` container and terminates TLS.
- `/` serves the static site from `/var/www/relay.thecheetah11.com`.
- `/ws` reverse-proxies to the relay server on `100.99.25.11:8901`.
- The relay server is the `relay-server.service` user unit on `cont`; the existing agents stay connected over the tailnet.

## DNS

One record:

| Type | Host | Value |
| --- | --- | --- |
| A | `relay` | `158.220.89.254` |

## nginx

Copy [`nginx-relay.conf`](nginx-relay.conf) to `/etc/nginx/sites-available/relay.thecheetah11.com` inside the `velo` container, then:

```sh
ln -s /etc/nginx/sites-available/relay.thecheetah11.com /etc/nginx/sites-enabled/relay.thecheetah11.com
nginx -t
systemctl reload nginx
```

The deployed site root is `/var/www/relay.thecheetah11.com` (a checkout of `site/`).

## TLS

After DNS resolves:

```sh
certbot --nginx -d relay.thecheetah11.com --redirect
```

## Endpoints

- Site: `https://relay.thecheetah11.com`
- Relay: `wss://relay.thecheetah11.com/ws`

Before the certificate exists, the same host/path works over `http://` and `ws://`.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/0xCheetah1/relay/main/install.sh | bash
```

Or from a clone:

```sh
./install.sh --profile velo --url wss://relay.thecheetah11.com/ws --harness hermes-gateway --hermes
```
