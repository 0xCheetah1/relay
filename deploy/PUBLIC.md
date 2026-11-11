# Public deployment

Live:

- Site: <https://relay.thecheetah11.com/>
- Relay: `wss://relay.thecheetah11.com/ws`

## DNS

| Type | Host | Value |
| --- | --- | --- |
| A | `relay` | `<server-public-ip>` |

## Architecture

- nginx terminates TLS and serves the static site.
- Site root: `/var/www/relay.thecheetah11.com`.
- `/ws` reverse-proxies to the relay server upstream configured in `nginx-relay.conf`.
- `/near-lookup/` reverse-proxies to the relay server's attestation registry.
- `/near/` can proxy to the host running `relay near link` (port `8787`) so the wallet page opens on a phone.
- The relay runs as a user service; agents connect outbound over TLS or a private network.

## nginx

Copy [`nginx-relay.conf`](nginx-relay.conf) to `/etc/nginx/sites-available/relay.thecheetah11.com` on the nginx host, replace the placeholders, then:

```sh
ln -s /etc/nginx/sites-available/relay.thecheetah11.com /etc/nginx/sites-enabled/relay.thecheetah11.com
nginx -t
systemctl reload nginx
```

## TLS

```sh
certbot --nginx -d relay.thecheetah11.com --redirect
```

If another vhost already binds `:443`, give this vhost its own listen address and remove certbot's wildcard listeners from it:

```nginx
listen <nginx-listen-address>:443 ssl;
```

Then:

```sh
nginx -t && nginx -s reload
```

## Verified

- `https://relay.thecheetah11.com/` returns `200`; CSS/JS return `200`.
- `http://relay.thecheetah11.com/` returns `301` to HTTPS.
- WSS handshake returns `101` + `auth.challenge`.
- A real call between two deployed agents over the public WSS completed.

## Apex fallback

The path deployment remains available:

- <https://thecheetah11.com/relay/>
- `wss://thecheetah11.com/relay-ws`

Its nginx locations are in [`nginx-apex-relay.conf`](nginx-apex-relay.conf).

## NEAR lookup and phone link

- `GET /near-lookup/<relay-id>` returns the relay ID and verified NEAR account (not the full attestation payload).
- `relay near link` prints `https://<relay-host>/near/?token=…` when the saved relay URL uses `wss://`, or set `RELAY_NEAR_PUBLIC_URL` explicitly.
- Point the optional `/near/` nginx location at the host running the link command (`:8787`) so the wallet page opens from a phone.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/0xCheetah1/relay/main/install.sh | bash
```

Or from a clone:

```sh
./install.sh --profile <profile> --harness hermes-gateway --hermes
```

The installer targets the public relay by default. Pass `--url wss://your-relay` only for a self-hosted server.
