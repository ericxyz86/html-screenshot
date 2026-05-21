import express from 'express';
import archiver from 'archiver';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { mkdir, rm, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { captureSections } from './lib/capture.mjs';
import { composeOutput } from './lib/compose.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5174);
const BIND = process.env.BIND_ADDRESS || '127.0.0.1';
const OUTPUT_ROOT = path.join(__dirname, 'output');
const TRUST_PROXY = Number(process.env.TRUST_PROXY || 0);
const JOB_TTL_MS = Number(process.env.JOB_TTL_MS || 60 * 60 * 1000); // 1h
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // 15m
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 1);

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

await mkdir(OUTPUT_ROOT, { recursive: true });

const app = express();
app.disable('x-powered-by');
if (TRUST_PROXY > 0) app.set('trust proxy', TRUST_PROXY);

// Security headers + tight CSP. Inline script not needed; everything from same origin.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginEmbedderPolicy: false, // we serve PNGs that may be embedded by browser tools
  }),
);

// Mounted before rate-limiting so container healthchecks stay reliable.
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Per-IP rate limit. Capture is expensive — be stingy.
const captureLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many capture requests. Try again later.' },
});

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});
app.use(generalLimiter);

app.use(express.json({ limit: '8kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// Custom static handler — serves only files under `output/<jobId>/final/`,
// never the `raw/` directory or anything else under output root.
app.get('/output/:jobId/final/:filename', async (req, res) => {
  const { jobId, filename } = req.params;
  if (!isSafeJobId(jobId)) return res.status(400).send('Invalid jobId');
  if (!isSafeFilename(filename)) return res.status(400).send('Invalid filename');
  const filePath = path.join(OUTPUT_ROOT, jobId, 'final', filename);
  try {
    await stat(filePath);
  } catch {
    return res.status(404).send('Not found');
  }
  res.type('png');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.sendFile(filePath);
});

// Lightweight Origin check for state-changing endpoints to deflect cross-site POSTs.
function checkOrigin(req, res, next) {
  const origin = req.get('Origin');
  const referer = req.get('Referer');
  const host = req.get('Host');
  const allow = [`http://${host}`, `https://${host}`, ...ALLOWED_ORIGINS];
  const source = origin || (referer ? new URL(referer).origin : null);
  if (!source) return res.status(400).json({ error: 'Missing Origin/Referer' });
  if (!allow.includes(source)) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  next();
}

// Single in-process concurrency gate so we don't OOM by launching many Chromiums.
let activeJobs = 0;
const waitQueue = [];
async function acquireSlot() {
  if (activeJobs < MAX_CONCURRENT) {
    activeJobs++;
    return;
  }
  await new Promise((resolve) => waitQueue.push(resolve));
  activeJobs++;
}
function releaseSlot() {
  activeJobs = Math.max(0, activeJobs - 1);
  const next = waitQueue.shift();
  if (next) next();
}

app.post('/api/capture', captureLimiter, checkOrigin, async (req, res) => {
  const { url, mode } = req.body || {};

  if (typeof url !== 'string' || url.length > 2048) {
    return res.status(400).json({ error: 'Provide a valid url string' });
  }
  if (mode !== 'full' && mode !== 'slides') {
    return res.status(400).json({ error: 'mode must be "full" or "slides"' });
  }

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');

  const jobId = `${Date.now()}-${crypto.randomBytes(16).toString('hex')}`;
  const jobDir = path.join(OUTPUT_ROOT, jobId);
  const rawDir = path.join(jobDir, 'raw');
  const finalDir = path.join(jobDir, 'final');

  const send = (obj) => {
    try { res.write(JSON.stringify(obj) + '\n'); } catch {}
  };

  const abortController = new AbortController();
  let clientGone = false;
  req.on('close', () => {
    clientGone = true;
    abortController.abort();
  });

  send({ event: 'start', jobId, mode });

  await acquireSlot();
  try {
    send({ event: 'progress', phase: 'queue', message: 'Slot acquired, starting' });
    const { sections } = await captureSections({
      url,
      outDir: rawDir,
      signal: abortController.signal,
      onProgress: (p) => send({ event: 'progress', ...p }),
    });
    if (clientGone) return;

    send({ event: 'compose', message: `Composing ${mode} output` });
    const finalFiles = await composeOutput({
      mode,
      captured: sections,
      outDir: finalDir,
      onProgress: (p) => send({ event: 'progress', ...p }),
    });

    const publicFiles = finalFiles.map((f) => ({
      ...f,
      file: `${jobId}/final/${path.basename(f.file)}`,
    }));

    send({
      event: 'done',
      jobId,
      mode,
      count: publicFiles.length,
      files: publicFiles,
      zipUrl: `/api/jobs/${jobId}/zip`,
    });
  } catch (err) {
    console.error(`[job ${jobId}]`, err);
    send({ event: 'error', message: sanitizeError(err) });
  } finally {
    releaseSlot();
    try { res.end(); } catch {}
  }
});

app.get('/api/jobs/:jobId/zip', async (req, res) => {
  const { jobId } = req.params;
  if (!isSafeJobId(jobId)) return res.status(400).send('Invalid jobId');
  const finalDir = path.join(OUTPUT_ROOT, jobId, 'final');

  try {
    await stat(finalDir);
  } catch {
    return res.status(404).send('Not found');
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="screenshots-${jobId}.zip"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    console.error(`[zip ${jobId}]`, err);
    res.destroy(err);
  });
  archive.pipe(res);
  // Only zip plain files we own; don't follow symlinks.
  const files = (await readdir(finalDir, { withFileTypes: true })).filter((d) => d.isFile());
  for (const f of files) {
    archive.file(path.join(finalDir, f.name), { name: f.name });
  }
  archive.finalize();
});

app.delete('/api/jobs/:jobId', checkOrigin, async (req, res) => {
  const { jobId } = req.params;
  if (!isSafeJobId(jobId)) return res.status(400).json({ error: 'Invalid jobId' });
  const jobDir = path.join(OUTPUT_ROOT, jobId);
  try {
    await rm(jobDir, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (err) {
    console.error('[delete]', err);
    res.status(500).json({ error: 'Failed to delete' });
  }
});

// Helpers --------------------------------------------------------------------

function isSafeJobId(s) {
  return typeof s === 'string' && /^\d{10,16}-[a-f0-9]{32}$/.test(s);
}

function isSafeFilename(s) {
  return typeof s === 'string' && /^[a-z0-9_-]{1,80}\.png$/i.test(s);
}

function sanitizeError(err) {
  const msg = err?.message || String(err);
  // Strip absolute paths that might leak the deploy layout.
  return msg
    .replace(/\/[A-Za-z0-9_./-]+/g, '<path>')
    .replace(/at [A-Za-z0-9_.]+:\d+:\d+/g, '')
    .slice(0, 300);
}

async function cleanupOldJobs() {
  let removed = 0;
  try {
    const entries = await readdir(OUTPUT_ROOT, { withFileTypes: true });
    const cutoff = Date.now() - JOB_TTL_MS;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const m = e.name.match(/^(\d+)-/);
      if (!m) continue;
      if (Number(m[1]) < cutoff) {
        await rm(path.join(OUTPUT_ROOT, e.name), { recursive: true, force: true });
        removed++;
      }
    }
    if (removed > 0) console.log(`Cleanup: removed ${removed} expired job(s)`);
  } catch (err) {
    console.error('Cleanup error:', err);
  }
}

// Periodic + at-boot cleanup.
cleanupOldJobs();
setInterval(cleanupOldJobs, CLEANUP_INTERVAL_MS).unref();

const server = app.listen(PORT, BIND, () => {
  console.log(`html-screenshots running at http://${BIND}:${PORT}`);
});

// Long captures: give each request 5 minutes before the server timeout cancels it.
server.requestTimeout = 5 * 60 * 1000;
server.headersTimeout = 60 * 1000;
