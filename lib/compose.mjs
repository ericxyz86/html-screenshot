import sharp from 'sharp';
import { mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';

// 16:9 slide canvas
const CANVAS_W = 1920;
const CANVAS_H = 1080;
const BG = { r: 13, g: 17, b: 32, alpha: 1 };
const WELL_W = 1760;
const WELL_H = 920;
const LEFT = (CANVAS_W - WELL_W) / 2;
const TOP = (CANVAS_H - WELL_H) / 2;
const MIN_SHRINK_SCALE = 0.70;
const MAX_INPUT_PIXELS = 60_000_000; // ~60 megapixels — guards against giant captures

// Cap libvips' pixel budget so a malformed/oversize input can't blow up RAM.
sharp.cache(false);

export async function composeOutput({ mode, captured, outDir, onProgress = () => {} }) {
  await mkdir(outDir, { recursive: true });

  if (mode === 'full') {
    const out = [];
    for (let i = 0; i < captured.length; i++) {
      const s = captured[i];
      const base = path.basename(s.file);
      const dest = path.join(outDir, base);
      await copyFile(s.file, dest);
      onProgress({ phase: 'compose', index: i + 1, total: captured.length, message: `Copied ${base}` });
      out.push({ ...s, file: dest });
    }
    return out;
  }

  if (mode === 'slides') {
    const out = [];
    for (let i = 0; i < captured.length; i++) {
      const s = captured[i];
      onProgress({ phase: 'compose', index: i + 1, total: captured.length, message: `Framing ${s.id}` });
      const slides = await toSlides(s, outDir);
      out.push(...slides);
    }
    return out;
  }

  throw new Error(`Unknown mode: ${mode}`);
}

async function toSlides(section, outDir) {
  const meta = await sharp(section.file, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  const heightAtFullWidth = Math.round(meta.height * (WELL_W / meta.width));
  const shrinkThreshold = Math.round(WELL_H / MIN_SHRINK_SCALE);
  const n = String(section.index).padStart(2, '0');
  const base = `${n}-${section.id}`;

  if (heightAtFullWidth <= WELL_H) {
    const scaledBuf = await sharp(section.file, { limitInputPixels: MAX_INPUT_PIXELS })
      .resize(WELL_W, heightAtFullWidth, { fit: 'fill' })
      .png()
      .toBuffer();
    const topMargin = Math.round((CANVAS_H - heightAtFullWidth) / 2);
    const outFile = path.join(outDir, `${base}.png`);
    await composeOnCanvas(scaledBuf, LEFT, topMargin, outFile);
    return [{ ...section, file: outFile, strategy: 'fits' }];
  }

  if (heightAtFullWidth <= shrinkThreshold) {
    const scale = Math.min(WELL_W / meta.width, WELL_H / meta.height);
    const w = Math.round(meta.width * scale);
    const h = Math.round(meta.height * scale);
    const scaledBuf = await sharp(section.file, { limitInputPixels: MAX_INPUT_PIXELS })
      .resize(w, h, { fit: 'fill' })
      .png()
      .toBuffer();
    const leftMargin = Math.round((CANVAS_W - w) / 2);
    const topMargin = Math.round((CANVAS_H - h) / 2);
    const outFile = path.join(outDir, `${base}.png`);
    await composeOnCanvas(scaledBuf, leftMargin, topMargin, outFile);
    const widthRatio = w / WELL_W;
    return [{ ...section, file: outFile, strategy: 'shrunk', scale: Number(widthRatio.toFixed(2)) }];
  }

  const scaledW = WELL_W;
  const scaledH = heightAtFullWidth;
  const nSlides = Math.ceil(scaledH / WELL_H);
  const stride = Math.floor((scaledH - WELL_H) / (nSlides - 1));
  const scaledBuf = await sharp(section.file, { limitInputPixels: MAX_INPUT_PIXELS })
    .resize(scaledW, scaledH, { fit: 'fill' })
    .png()
    .toBuffer();

  const out = [];
  for (let i = 0; i < nSlides; i++) {
    const yStart = i * stride;
    const sliceH = Math.min(WELL_H, scaledH - yStart);
    const slice = await sharp(scaledBuf, { limitInputPixels: MAX_INPUT_PIXELS })
      .extract({ left: 0, top: yStart, width: scaledW, height: sliceH })
      .png()
      .toBuffer();
    const outFile = path.join(outDir, `${base}-${i + 1}of${nSlides}.png`);
    await composeOnCanvas(slice, LEFT, TOP, outFile);
    out.push({ ...section, file: outFile, strategy: 'split', slide: i + 1, of: nSlides });
  }
  return out;
}

async function composeOnCanvas(buf, left, top, outFile) {
  await sharp({
    create: { width: CANVAS_W, height: CANVAS_H, channels: 4, background: BG },
  })
    .composite([{ input: buf, left, top }])
    .png()
    .toFile(outFile);
}
