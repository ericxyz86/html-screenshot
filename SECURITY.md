# Security

This app accepts an arbitrary URL from any client and renders it in headless Chromium. The threat model is **unauthenticated internet** — when deployed publicly, every defense has to assume the input is hostile.

## Threats and mitigations

### SSRF — Server-Side Request Forgery

**Threat.** Attacker submits `http://169.254.169.254/latest/meta-data/iam/security-credentials/` (AWS metadata), `http://internal-service:8080/`, or a domain whose DNS resolves to a private IP. Headless Chromium fetches it and renders a screenshot the attacker can download.

**Defenses, layered:**

1. **Hostname allowlist + IP-range blocklist.** Every URL is resolved with `dns.resolve4` and `dns.resolve6`. Any address inside RFC1918, loopback, link-local, CGNAT, multicast, reserved, IPv4-mapped IPv6, or the cloud-metadata ranges (169.254.0.0/16, etc.) → reject. Hostnames `localhost`, `metadata.google.internal`, and friends are also blocklisted directly.
2. **DNS pinning at the Chromium level.** Chromium launches with `--host-resolver-rules=MAP <host> <ip>` for each validated IP, plus a wildcard `--host-rules=MAP * ~NOTFOUND` that excludes only the target hostname. Result: even if DNS rebinds between validation and navigation, Chromium never asks the OS resolver — it uses the pinned mapping.
3. **Route interception.** Every navigation and subresource passes through `page.route()`. We re-check the protocol (must be `http(s)`) and the hostname. Direct IP literals get re-validated; `localhost`/`0.0.0.0` are aborted. This catches redirects to `chrome://`/`file://` and CNAME-chain bypasses.

### Container escape via Chromium

**Threat.** A malicious page triggers a renderer-process vulnerability. If Chromium runs without its sandbox (which happens automatically when run as root), the renderer process gets full container access.

**Defenses:**

- The container runs as non-root `pwuser` (uid 1000), shipped by the Playwright base image with the userns/seccomp configuration the sandbox needs.
- `chromium.launch({ chromiumSandbox: true })` is set explicitly — if the sandbox can't initialize, the launch fails instead of silently disabling it.
- The base image (`mcr.microsoft.com/playwright:v1.60.0-noble`) pins both Chromium and its supporting libraries.

### Denial of service

**Threats:** unbounded captures from a single IP; multiple Chromium launches consuming all RAM; attacker-served pages with `body { height: 1000000px }`; sharp processing 100MP inputs.

**Defenses:**

- `express-rate-limit`: 20 captures per IP per 10 minutes, 120 general requests per minute. `trust proxy` must be configured (Coolify reverse-proxies, so `TRUST_PROXY=1`).
- In-process semaphore (`MAX_CONCURRENT`, default 1) serializes Chromium launches.
- Page height capped at 30 000 px, individual section at 8 000 px.
- sharp `limitInputPixels: 60_000_000` so a malformed PNG can't blow up libvips.
- Request body capped at 8 KB. URL length capped at 2 048 chars.
- HTTP request timeout 5 minutes, headers timeout 60 s.
- Client-disconnect propagates an `AbortSignal` that closes Chromium and stops the job.

### Information disclosure

**Threats:** raw error messages leaking file paths or stack frames; `/output` exposing `raw/` captures or other jobs.

**Defenses:**

- All errors sent to the client run through `sanitizeError()`: paths are replaced with `<path>`, stack frames stripped, capped at 300 chars. Full errors are logged server-side.
- The static handler for `/output` only serves `/<jobId>/final/<filename>` — `raw/` is never served. `jobId` and filename are regex-validated; no path traversal possible.
- Job IDs are `Date.now() + crypto.randomBytes(16).toString('hex')` (128 bits of randomness, unguessable). Even an attacker who knows you exist can't enumerate other users' jobs.

### Cross-site abuse

**Threats:** a victim's browser, logged into the deployed app via cached Basic Auth, makes a hostile `POST /api/capture` from another origin. Without checks, the screenshot generates and silently fills the victim's account quota.

**Defenses:**

- POST and DELETE endpoints reject any request whose `Origin`/`Referer` isn't the host itself or an entry in `ALLOWED_ORIGINS`.
- Helmet sets `frame-ancestors 'none'` and `Content-Security-Policy default-src 'self'`. The app cannot be iframed; injected `<img>` cross-origin requests can't trigger captures (capture is POST, not GET).

### Archive abuse

**Threat.** ZIP-slip or symlink-follow during ZIP generation lets an attacker exfiltrate files outside `final/`.

**Defenses:** ZIP only includes regular files from `readdir(finalDir, { withFileTypes: true })` — no symlinks, no directory recursion, no glob.

## Configuration knobs

| Env var | Default | Why |
|---|---|---|
| `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` | unset | Gate every route with HTTP Basic Auth. Required for any internet-exposed deploy. |
| `ALLOWED_ORIGINS` | empty | Comma-separated origins permitted to call `POST /api/capture` (host itself is always allowed). |
| `TRUST_PROXY` | `0` | Set to `1` when behind a single reverse proxy (Coolify). Without this, `express-rate-limit` rate-limits the proxy, not the real client. |
| `MAX_CONCURRENT` | `1` | Parallel Chromium launches. Bump only if you've sized the host for it. |
| `JOB_TTL_MS` | `3600000` | How long captured jobs survive before automatic cleanup. |
| `BIND_ADDRESS` | `127.0.0.1` (local) / `0.0.0.0` (Docker) | Bind interface. |
| `PORT` | `5174` | Listening port. |

## Reporting

Found something? Open a GitHub issue. For sensitive disclosures, contact the repo owner directly.
