# html-screenshots

Local-or-self-hosted web app that captures every section of a website as PNG. Two output modes:

- **Full sections** — one PNG per section at native height. Aspect ratios vary by section.
- **16:9 slides** — composes each section onto a 1920×1080 dark canvas. Short sections fit as-is; sections slightly taller than the slide shrink to fit (as long as scale stays ≥ 70%); sections much taller than that split into multiple overlapping slides with no content cropped.

## Run locally

```bash
npm install
npx playwright install chromium
npm start
```

Open <http://127.0.0.1:5174>.

## Run in Docker

```bash
docker build -t html-screenshots .
docker run --rm -p 5174:5174 \
  -e BASIC_AUTH_USER=admin \
  -e BASIC_AUTH_PASSWORD='change-me' \
  -e ALLOWED_ORIGINS='https://html-screenshot.aiailabs.net' \
  html-screenshots
```

## Deploy on Coolify

1. **New Resource → Application → Public Repository**, point at this repo.
2. **Build Pack: Dockerfile.**
3. **Domain**: `https://html-screenshot.aiailabs.net` (Coolify provisions the cert).
4. **Port**: `5174`.
5. **Environment variables**:
   - `BASIC_AUTH_USER` — pick a username
   - `BASIC_AUTH_PASSWORD` — long random string
   - `ALLOWED_ORIGINS` — `https://html-screenshot.aiailabs.net`
   - `TRUST_PROXY=1` (already set in the Dockerfile)
   - `BIND_ADDRESS=0.0.0.0` (already set)
   - `MAX_CONCURRENT=1` — bump if your host has the RAM
   - `JOB_TTL_MS=3600000` — 1h
6. **Health check**: `GET /healthz` (already wired).
7. **Persistent storage** *(optional)*: mount a volume on `/app/output` if you want jobs to survive container restarts. Otherwise the auto-cleanup handles disk.

## Security model

This server accepts an arbitrary URL from a user and renders it in headless Chromium. That's a powerful primitive and a juicy SSRF target — the defenses, in order:

- **URL → IP pinning**: every URL is resolved against A + AAAA records. If any address falls into a private, loopback, link-local, CGNAT, multicast, reserved, or cloud-metadata range (IPv4 + IPv6, including `::ffff:`-mapped v4), the request is rejected before the browser starts.
- **Chromium host-resolver-rules**: Chromium is started with `--host-resolver-rules` mapping the requested hostname to the pre-validated IPs. Any DNS lookup for a host outside that pin gets `NOTFOUND` from the network stack. This blocks DNS rebinding because Chromium never re-resolves.
- **Route interception**: every request the browser makes (navigations + subresources) passes through `page.route()`. Anything that's not `http(s)`, or that points to `localhost` / `0.0.0.0` / a private IP literal, is aborted. Defense-in-depth against redirects to `chrome://`, `file://`, or attacker-controlled CNAME chains.
- **Chromium sandbox** stays on (`chromiumSandbox: true`) and the container runs as the non-root `pwuser`. The Playwright base image ships with the kernel-userns setup the sandbox needs.
- **HTTP Basic Auth** at the edge if `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` are set (recommended for public deploys).
- **Origin/Referer check** on POST `/api/capture` and DELETE `/api/jobs/:id` rejects cross-site form submissions.
- **Per-IP rate limit** — 20 capture jobs per 10 minutes, 120 general requests per minute. Configure `TRUST_PROXY` correctly so this rate-limits clients not your reverse proxy.
- **In-process concurrency cap** (`MAX_CONCURRENT`, default 1) keeps multiple Chromium launches from OOMing the box.
- **Size caps**: pages taller than 30 000 px, sections taller than 8 000 px, and sharp inputs over 60 MP all get rejected.
- **Helmet + strict CSP**: `default-src 'self'`, `frame-ancestors 'none'`, no inline script.
- **Sanitized errors**: client only sees a redacted message; full stack traces are logged server-side.
- **Job IDs**: 16 bytes of random hex (128 bits) — unguessable. Only `final/` is served; raw captures are never exposed.
- **Job cleanup** runs at boot and every 15 minutes (default TTL 1 hour).

The audit and rationale are in [`SECURITY.md`](SECURITY.md).

## How it works

1. Playwright loads the URL at 1440×900 desktop viewport, 2× DPR.
2. Page is scrolled top-to-bottom once to trigger lazy-loaded content, then reset to the top.
3. Section detection (in order):
   - All `<section>` elements
   - `[data-section]` elements
   - Direct children of `<main>`
   - `[role="region"]`
   - Fallback: split the page into viewport-sized folds
4. Playwright takes a clipped screenshot of each section's full bounding box.
5. **Full sections** mode → PNGs returned as captured.
6. **16:9 slides** mode → each section runs through the shrink-or-split rule onto a 1920×1080 dark canvas.

## Output layout

```
output/<jobId>/
├── raw/    # internal — never served
└── final/  # served at /output/<jobId>/final/<filename>
```

The UI exposes individual files and a single ZIP per job.

## Stack

- Express + Helmet + express-rate-limit + express-basic-auth
- Playwright (Chromium with sandbox)
- sharp (libvips) for resize + composite
- archiver for ZIPs
- vanilla HTML/CSS/JS (no frontend framework)
