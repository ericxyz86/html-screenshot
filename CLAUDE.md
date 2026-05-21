# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm start` — run the server (production-style, no watch)
- `npm run dev` — `node --watch server.mjs` for local iteration
- `npx playwright install chromium` — required once after `npm install`; the Playwright npm package does not ship the browser binary
- `docker build -t html-screenshots . && docker run --rm -p 5174:5174 html-screenshots` — full prod-equivalent local run (the `mcr.microsoft.com/playwright` base image already includes Chromium, so no extra install step inside Docker)

There is no test suite and no linter configured. Don't invent `npm test` / `npm run lint` — they don't exist.

## Architecture

The capture pipeline spans three files and won't make sense reading any one of them alone:

1. **`server.mjs`** — Express orchestrator. Validates input, mints a 16-byte hex jobId, runs the job in-process under a `MAX_CONCURRENT` semaphore, streams progress via Server-Sent Events on `GET /api/jobs/:id/events`, and serves results from `output/<jobId>/final/` only. Raw captures under `output/<jobId>/raw/` are never exposed.
2. **`lib/capture.mjs`** — Playwright/Chromium driver. Section detection has a fallback chain: `<section>` → `[data-section]` → `<main>` children → `[role="region"]` → viewport-sized folds. Captures clipped screenshots at 1440×900 viewport, 2× DPR.
3. **`lib/compose.mjs`** — Sharp post-processor. Mode `full` just copies. Mode `slides` runs a shrink-or-split rule onto a 1920×1080 dark canvas: short sections fit as-is, slightly-too-tall sections shrink while scale stays ≥ 0.70, anything taller splits into overlapping slides with no cropping.

A job's filesystem layout is `output/<jobId>/{raw,final}/`. Cleanup runs at boot and every 15 min, deleting jobs older than `JOB_TTL_MS` (default 1h). Only `final/` survives serving.

### SSRF defense — three layers, all required

This server takes an arbitrary URL from a user and renders it in headless Chromium. That's a juicy SSRF target, and the defense is **deliberately layered**. If you change one layer in isolation, you can reopen the hole:

1. **`lib/ssrf.mjs`** rejects any URL whose A/AAAA records resolve into private/loopback/link-local/CGNAT/multicast/reserved/cloud-metadata ranges (IPv4 + IPv6, including `::ffff:`-mapped v4). This happens before Chromium starts.
2. **`lib/capture.mjs` line ~31** launches Chromium with `--host-resolver-rules=MAP <hostname> <pinned-ips>`, so the browser's network stack can only reach IPs we pre-validated for the main hostname. This kills DNS rebinding because Chromium never re-resolves.
3. **`lib/capture.mjs` `page.route('**/*')` handler** re-validates every request (navigations + subresources): non-http(s) schemes, `localhost`, `0.0.0.0`, and private-IP literals get aborted. This defends against redirects to `chrome://` / `file://` and attacker-controlled CNAME chains in subresources.

When touching any of these, read `SECURITY.md` for the rationale and **keep all three**. Anything weaker has been considered and rejected.

### `/healthz` must be mounted before rate-limit middleware

The Dockerfile `HEALTHCHECK` runs `node -e "fetch('http://127.0.0.1:5174/healthz')..."` from inside the container with no credentials. Keep `/healthz` near the top of `server.mjs`, before request middleware that can throttle or reject it. The route is intentionally `app.get('/healthz', ...)` registered immediately after `helmet`.

`/healthz` is mounted before `generalLimiter`. Everything else — including the static frontend at `public/` — sits behind the rate limiter.

## Runtime configuration

Env vars are consumed at the top of `server.mjs`. The ones with non-obvious behavior:

- `ALLOWED_ORIGINS` (comma-separated) — checked against `Origin`/`Referer` on `POST /api/capture` and `DELETE /api/jobs/:id` to reject cross-site form submissions. Not a CORS header — purely defensive.
- `TRUST_PROXY` (integer count of trusted hops) — must match your real proxy chain or `express-rate-limit` will rate-limit the proxy IP instead of the client. Set to `1` in the Dockerfile; bump if running behind multiple proxies.
- `MAX_CONCURRENT` (default 1) — caps simultaneous Chromium launches. Each Playwright instance can use ~500MB+; raising this on a small VM will OOM.

The Dockerfile bakes `BIND_ADDRESS=0.0.0.0`, `PORT=5174`, `TRUST_PROXY=1`, `NODE_ENV=production` directly as `ENV` lines — they are **not** set in Coolify env vars and don't need to be. Setting them in Coolify is harmless but redundant.

## Deployment

Production is on Coolify at `https://html-screenshot.aiailabs.net`, behind Cloudflare Access (Zero Trust). External curl probes get a 302 redirect to the Access login; after browser IdP login, the app opens directly with no second Basic Auth prompt. Trust the Coolify dashboard's `running:healthy` status as the source of truth, not external HTTP probes. See **`NOX.md`** for the full deploy-state handoff — app UUIDs, manual deploy recipes, and the pending GitHub-App source switch.

## Multi-agent coordination

This repo is worked on by both Claude Code (MacBook Pro) and Nox (Mac Studio). The two agents can't message each other directly — `git pull` / `git push` and `NOX.md` are the coordination channels. When making deploy-state-relevant changes (env vars, Dockerfile, server.mjs port binding, middleware ordering), **update `NOX.md` in the same commit** so the other agent inherits accurate context on its next pull.
