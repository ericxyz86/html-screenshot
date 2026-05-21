# NOX.md — handoff from Claude Code (MacBook Pro)

This file is read by Nox on Mac Studio after `git pull`. It exists because we
can't message each other directly. Last updated **2026-05-21 by Claude Code**.

If you (Nox) make changes that update this state, **edit this file in the same
commit** so the next agent inherits accurate context.

## Project in one line

`html-screenshots` — Node/Express app that takes a URL, renders it with
headless Chromium, returns per-section PNGs. Deployed to Hetzner via Coolify.

## Live deployment

| Field | Value |
|---|---|
| Public URL | https://html-screenshot.aiailabs.net |
| Coolify app UUID | `zk0w40s0gcwws88cskc48cs0` |
| Coolify project | "Render Migration" (UUID `ckckg4088ko0w48k8gk8kckw`) |
| Coolify environment | `production` (UUID `acos4ss88s00wsk04kc84sss`) |
| Server | `localhost` (Coolify host) |
| Dashboard | https://coolify.aiailabs.net/project/ckckg4088ko0w48k8gk8kckw/environment/acos4ss88s00wsk04kc84sss/application/zk0w40s0gcwws88cskc48cs0 |
| Image | Dockerfile build pack, base `mcr.microsoft.com/playwright:v1.60.0-noble` |
| Port | 5174 (set by Dockerfile, exposed via Coolify) |
| Healthcheck | `GET /healthz` — **must remain unauthenticated** (see Gotchas) |

Auth layers, outside → in:

1. **Cloudflare Access** (Zero Trust) gates the hostname. External requests get
   302-redirected to `agileintelligence.cloudflareaccess.com/cdn-cgi/access/login`.
   curl/CI cannot reach the origin without a CF Access service token. Browser
   login via the team's IdP is the normal path.
2. **HTTP Basic Auth** at the origin — user `admin`, password generated and
   stored in Coolify env vars. Applies to every route except `/healthz`.
3. **SSRF defenses** inside the app (DNS pinning + Chromium host-resolver-rules
   + route interception). See `SECURITY.md`.

## Credentials Nox needs

Both files are gitignored — they exist on MacBook Pro only. To work on the
deploy from Mac Studio, retrieve from Eric's `~/secrets/` or 1Password:

- `.env` — `COOLIFY_URL` + `COOLIFY_API_TOKEN`. Used for any scripted Coolify
  ops. Token created at `<COOLIFY_URL>/security/api-tokens`. Sanctum format
  (`<id>|<random>`) — **must be quoted** in shell or read with `awk` to avoid
  the `|` being interpreted as a pipe.
- `.env.deploy.local` — the live `BASIC_AUTH_USER` and `BASIC_AUTH_PASSWORD`
  that the deployed instance is using. Needed if you want to test the live URL
  past the Cloudflare Access prompt.

If neither file is in `~/secrets/`, ask Eric on Telegram. Don't regenerate the
Basic Auth password without coordinating — the live Coolify env vars hold
the canonical value.

## Coolify source — pending switch

Currently the app is sourced via "Public Repository" (Coolify pulls anonymously
from GitHub on each manual deploy trigger). **Auto-deploy on push is not yet
wired**, because:

- `source_type = App\Models\GithubApp` but `source_id = 0` (no real binding).
- Coolify's API does not allow flipping `source_id` via PATCH on an existing
  app (returns 422 "This field is not allowed").
- The fix is a one-click UI flip Eric was about to do at handoff time:
  Configuration → Source → change to GitHub App #1 (the same one used by
  `crawl-a-i`, `chewy-byd`, `llm-council`, etc., all visible in the dashboard).

**Check if this has happened yet** before assuming push-to-deploy works:

```sh
URL=$(awk -F= '/^COOLIFY_URL=/{sub(/^COOLIFY_URL=/,""); print; exit}' .env)
TOK=$(awk -F= '/^COOLIFY_API_TOKEN=/{sub(/^COOLIFY_API_TOKEN=/,""); print; exit}' .env)
curl -sS -H "Authorization: Bearer $TOK" "$URL/api/v1/applications/zk0w40s0gcwws88cskc48cs0" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('source_id =', d['source_id'])"
```

- `source_id = 0` → still on public-repo path, auto-deploy NOT live.
- `source_id = 1` → GitHub App wired, auto-deploy IS live. Push to `main`
  should trigger a deploy within ~30s.

If still on `0` and Eric has not done the UI flip, prompt him via Telegram —
don't try to recreate the app from API to force it. Recreating involves
deleting the running container and risks a downtime window on a domain that's
actively serving.

## Triggering a deploy manually (any time)

```sh
URL=$(awk -F= '/^COOLIFY_URL=/{sub(/^COOLIFY_URL=/,""); print; exit}' .env)
TOK=$(awk -F= '/^COOLIFY_API_TOKEN=/{sub(/^COOLIFY_API_TOKEN=/,""); print; exit}' .env)
curl -sS -H "Authorization: Bearer $TOK" "$URL/api/v1/deploy?uuid=zk0w40s0gcwws88cskc48cs0"
```

Returns a `deployment_uuid`. Poll with
`GET /api/v1/deployments/{deployment_uuid}` — `status` cycles through
`queued` → `in_progress` → `finished | failed`. Build logs are **only**
visible in the Coolify UI in this version (4.0.0-beta.462); the API exposes
runtime container logs but only while the app is `running:healthy`.

## Editing env vars

Single-var endpoint, minimal body shape (other fields like `is_build_time` are
rejected as `"not allowed"`):

```sh
curl -sS -X POST -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"key":"FOO","value":"bar"}' \
  "$URL/api/v1/applications/zk0w40s0gcwws88cskc48cs0/envs"
```

Coolify auto-creates a `is_preview=True` mirror of every env var. That's
intentional, leave it alone.

## Gotchas — read before changing code

1. **`/healthz` must stay above auth.** It's mounted at line ~53 of
   `server.mjs`, *before* both `basicAuth` and the rate limiter. The Dockerfile
   HEALTHCHECK fetches `http://127.0.0.1:5174/healthz` without creds — if you
   move `/healthz` below auth, every deploy will fail with `exited:unhealthy`
   after ~3 minutes of build time. This was the cause of the first failed
   deploy (commit `b41c6c6`); fix is commit `adddc36`.

2. **The Cloudflare Access redirect makes external curl probes look broken
   even when the app is healthy.** Use the Coolify dashboard's "Status" field
   or `GET /api/v1/applications/{uuid}` `status` field — `running:healthy`
   is the truth. Don't chase a 302 from the public URL.

3. **`TRUST_PROXY=1` is set in the Dockerfile**, not in Coolify env vars. The
   README documents it as if it were settable in Coolify, but it's baked in.
   If you ever run this behind a multi-hop proxy chain, bump it in the
   Dockerfile, not Coolify.

4. **Origin/Referer check on POST `/api/capture`** rejects cross-site form
   submissions. If you build an external client that hits the API, set the
   `Origin` header to `https://html-screenshot.aiailabs.net`.

5. **Per-IP rate limit** is 20 captures per 10 min, 120 requests per minute.
   With Cloudflare in front, `TRUST_PROXY=1` is required for these to limit
   the real client, not the proxy. Already set.

## Workflow rules between us

- Pull before starting: `git pull origin main`
- Push when stopping. Don't leave uncommitted work on either machine.
- All work happens in `~/Developer/html-screenshots/` — never edit on the
  Hetzner server, never edit on `~/Desktop/`.
- If you change deploy-relevant config (env vars, Dockerfile, server.mjs port
  binding, domain), **update this file in the same commit**.
- If you generate any new secret (rotated password, new token), write it to
  `.env.deploy.local`, never commit, and Telegram Eric so he can sync it to
  Mac Studio's `~/secrets/`.
