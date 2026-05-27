import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { isPrivateIp, validateUrlForSsrf } from './ssrf.mjs';

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
const DEVICE_SCALE_FACTOR = 2;
const NAV_TIMEOUT_MS = 30000;
const MAX_PAGE_HEIGHT = 30000;        // px — refuse to capture monstrous pages
const MAX_SECTION_HEIGHT = 8000;      // px — cap individual section heights
const MAX_SECTIONS = 40;              // refuse pages with absurd section counts

export async function captureSections({ url, outDir, onProgress = () => {}, signal }) {
  await mkdir(outDir, { recursive: true });

  // Validate URL + resolve to IPs we can pin.
  const { url: cleanUrl, pinnedIps } = await validateUrlForSsrf(url);

  // Build host-resolver-rules so Chromium can only talk to the IPs we pre-validated.
  // Format: "MAP <hostname> <ip>" — applied only when the page navigates to that host.
  const isFileUrl = new URL(cleanUrl).protocol === 'file:';
  const hostname = new URL(cleanUrl).hostname.toLowerCase();
  const resolverRules = pinnedIps.map((ip) => `MAP ${hostname} ${ip}`).join(', ');

  onProgress({ phase: 'launch', message: 'Launching browser' });
  // Pin the main hostname so DNS rebinding can't swap in a private IP between
  // validation and navigation. Subresources are allowed to resolve normally
  // (CDNs, fonts) — page.route() below re-validates each request's hostname
  // and aborts anything pointing at a private IP.
  const browser = await chromium.launch({
    chromiumSandbox: true,
    args: isFileUrl ? [] : [`--host-resolver-rules=${resolverRules}`],
  });

  let aborted = false;
  const onAbort = () => {
    aborted = true;
    browser.close().catch(() => {});
  };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  try {
    const ctx = await browser.newContext({
      viewport: DESKTOP_VIEWPORT,
      deviceScaleFactor: DEVICE_SCALE_FACTOR,
      ignoreHTTPSErrors: false,
    });
    const page = await ctx.newPage();

    // Belt-and-suspenders: reject any request that points to a private IP
    // literal, `localhost`, or a non-http(s) scheme. CDN/font subresources
    // are allowed through.
    await page.route('**/*', async (route) => {
      if (aborted) return route.abort();
      const request = route.request();
      try {
        const target = new URL(request.url());
        if (target.protocol === 'file:' && process.env.ALLOW_FILE_URLS === '1') {
          return route.continue();
        }
        if (target.protocol !== 'http:' && target.protocol !== 'https:') {
          return route.abort();
        }
        const subHost = target.hostname.toLowerCase().replace(/^\[|\]$/g, '');
        if (subHost === 'localhost' || subHost === '0.0.0.0') return route.abort();
        if (/^\d+\.\d+\.\d+\.\d+$/.test(subHost) && isPrivateIp(subHost)) {
          return route.abort();
        }
        return route.continue();
      } catch {
        return route.abort();
      }
    });

    onProgress({ phase: 'load', message: `Loading ${cleanUrl}` });
    await page.goto(cleanUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    try {
      await page.waitForLoadState('networkidle', { timeout: 5000 });
    } catch {
      onProgress({ phase: 'load', message: 'Network still busy after 5s, continuing anyway' });
    }
    await page.waitForTimeout(1500);
    if (aborted) throw new Error('Aborted');

    // Refuse pages that try to be enormous (DoS on screenshot/sharp).
    const pageHeight = await page.evaluate(() => document.body.scrollHeight);
    if (pageHeight > MAX_PAGE_HEIGHT) {
      throw new Error(`Page is too tall (${pageHeight}px, limit ${MAX_PAGE_HEIGHT}px)`);
    }

    onProgress({ phase: 'warmup', message: 'Triggering lazy-loaded content' });
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let y = 0;
        const step = () => {
          window.scrollTo(0, y);
          y += 400;
          if (y < document.body.scrollHeight) setTimeout(step, 50);
          else resolve();
        };
        step();
      });
    });
    await page.waitForTimeout(800);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(400);
    if (aborted) throw new Error('Aborted');

    onProgress({ phase: 'detect', message: 'Detecting sections' });
    let sections = await detectSections(page);

    if (sections.length === 0) {
      throw new Error('No sections detected on the page');
    }
    if (sections.length > MAX_SECTIONS) {
      throw new Error(`Too many sections (${sections.length}, limit ${MAX_SECTIONS})`);
    }

    sections = sections.map((s) => ({
      ...s,
      // Strip anything weird from attacker-controlled IDs before reporting.
      id: sanitizeId(s.id),
      // Clamp section heights so we never ask Chromium to clip a 1M-pixel image.
      height: Math.min(s.height, MAX_SECTION_HEIGHT),
    }));

    onProgress({ phase: 'detect', message: `Found ${sections.length} sections`, sections });

    const captured = [];
    for (let i = 0; i < sections.length; i++) {
      if (aborted) throw new Error('Aborted');
      const s = sections[i];
      const n = String(i + 1).padStart(2, '0');
      const safeName = (s.id || `section-${i + 1}`).replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 40) || `section-${i + 1}`;
      const outFile = path.join(outDir, `${n}-${safeName}.png`);

      onProgress({
        phase: 'capture',
        index: i + 1,
        total: sections.length,
        message: `Capturing ${i + 1}/${sections.length}: ${s.id || `section-${i + 1}`}`,
      });

      // fullPage:true is required for clip y-coords below the viewport — without
      // it Playwright limits the screenshot to the viewport rectangle. clip is
      // applied to the full-page raster, so this captures any section.
      await page.screenshot({
        path: outFile,
        clip: { x: Math.round(s.x), y: Math.round(s.y), width: Math.round(s.width), height: Math.round(s.height) },
        fullPage: true,
      });

      captured.push({
        index: i + 1,
        id: s.id || `section-${i + 1}`,
        file: outFile,
        width: Math.round(s.width),
        height: Math.round(s.height),
      });
    }

    return { sections: captured };
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    await browser.close().catch(() => {});
  }
}

function sanitizeId(id) {
  if (typeof id !== 'string') return null;
  const cleaned = id.replace(/[^a-z0-9_-]/gi, '').slice(0, 40);
  return cleaned || null;
}

async function detectSections(page) {
  return page.evaluate(() => {
    const seen = new Set();
    const results = [];
    const pushIfBig = (el) => {
      if (!el || seen.has(el)) return;
      const r = el.getBoundingClientRect();
      if (r.height < 200) return;
      seen.add(el);
      results.push({
        x: 0,
        y: r.top + window.scrollY,
        width: document.documentElement.clientWidth,
        height: r.height,
        id: el.id || null,
        tag: el.tagName.toLowerCase(),
      });
    };

    document.querySelectorAll('section').forEach(pushIfBig);
    if (results.length === 0) document.querySelectorAll('[data-section]').forEach(pushIfBig);
    if (results.length === 0) {
      const main = document.querySelector('main');
      if (main) Array.from(main.children).forEach(pushIfBig);
    }
    if (results.length === 0) document.querySelectorAll('[role="region"]').forEach(pushIfBig);

    if (results.length === 0) {
      const vh = window.innerHeight;
      const total = document.body.scrollHeight;
      let y = 0;
      let i = 0;
      while (y < total) {
        results.push({
          x: 0,
          y,
          width: document.documentElement.clientWidth,
          height: Math.min(vh, total - y),
          id: `fold-${++i}`,
          tag: 'fold',
        });
        y += vh;
      }
    }

    return results.sort((a, b) => a.y - b.y);
  });
}
