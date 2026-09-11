# Reverse Proxy Targets

Forward 80/443 traffic for a domain to a host:port Beachhead does **not**
run — most commonly a NAS or other device on the same LAN.

## Why this exists

Beachhead's proxy stack (nginx-proxy + acme-companion) only routes to Docker
containers on `beachhead-net`, discovered automatically via `VIRTUAL_HOST` /
`VIRTUAL_PORT` / `LETSENCRYPT_HOST` env vars. There's no mechanism to route
straight to an arbitrary LAN `host:port` that isn't one of Beachhead's own
containers.

Reverse Proxy Targets close that gap by running a tiny `nginx:alpine`
sidecar container carrying those same env vars — nginx-proxy and
acme-companion pick it up exactly like any app or static site (no manual
signalling, no override files). The sidecar's own nginx config then does the
actual `proxy_pass` to your target. TLS terminates at Beachhead; the hop from
the sidecar to your target uses whatever scheme you configure (plain HTTP is
typical for a LAN device).

## How it routes

This is domain-based (SNI/Host header) reverse proxying, not raw port
forwarding — the same model every other Beachhead app or static site uses to
share 80/443 on one public IP. Point a subdomain's DNS at your Beachhead
host's public IP (same as any other app), and traffic for that domain gets
proxied onward to your target. Your router only needs to forward 80/443 to
the Beachhead host, same as it already does for everything else Beachhead
hosts — nothing extra to forward to the target device itself.

## Fields

| Field | Meaning |
|---|---|
| `domains` | One or more hostnames routed to this target (comma/space separated in the dashboard) |
| `target_scheme` | `http` or `https` — protocol Beachhead uses to reach the target |
| `target_host` | LAN IP or hostname of the target (e.g. `192.168.1.50`) |
| `target_port` | Port the target listens on |
| `websocket` | Adds `Upgrade`/`Connection` headers for WebSocket passthrough (file-manager UIs, media servers, etc.) |
| `verify_tls` | When `target_scheme=https`, whether to verify the target's certificate — turn off for a device with a self-signed admin-UI cert (e.g. Synology DSM) |
| `enabled` | Stops the sidecar without deleting the definition |

## Dashboard

**Reverse Proxy** in the nav. Add a target, and Beachhead starts the sidecar
immediately — the domain's cert is issued the same way any new app's cert is
(usually under a minute, as long as DNS already points here). Restart
re-runs the sidecar without changing config (useful after the target device
comes back from a reboot); Disable stops it without losing the definition.

## API

All routes require an authenticated super-admin session.

- `GET /api/reverse-proxy-targets` — list
- `POST /api/reverse-proxy-targets` — create `{ name?, domains, target_scheme?, target_host, target_port, websocket?, verify_tls? }`
- `PUT /api/reverse-proxy-targets/:id` — update any of the above; restarts the sidecar
- `POST /api/reverse-proxy-targets/:id/enable` — `{ enabled }`
- `POST /api/reverse-proxy-targets/:id/restart` — re-run the sidecar unchanged
- `DELETE /api/reverse-proxy-targets/:id` — stop the sidecar and remove the definition

Domains are checked for collisions against apps, app endpoints, static
sites, and other reverse proxy targets — one hostname can only be claimed by
one of them at a time.

## Notes

- `target_host` is written directly into the sidecar's nginx config, so it's
  restricted to a safe hostname/IP charset — no room for injecting nginx
  directives.
- The sidecar resolves the target at request time (`resolver 127.0.0.11`),
  not at container start, so a LAN hostname that's briefly unreachable when
  the sidecar starts won't wedge it — same rule Beachhead apps follow for
  cross-service calls.
- Large transfers (e.g. browsing a NAS file share through this) aren't
  capped — `client_max_body_size 0` and 1-hour proxy timeouts are set on
  every target.
