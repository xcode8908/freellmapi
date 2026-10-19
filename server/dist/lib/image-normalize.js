import { readFileSync } from 'node:fs';
// Inbound image normalization. Vision payloads ride inline as base64 data
// URLs, and agents replay their ENTIRE history every turn — one real Codex
// session accumulated 11.85MB of duplicated screenshots. Every upstream
// resizes internally anyway (OpenAI scales the long edge to 2048, Anthropic
// to 1568), so pixels beyond that cap are pure transport waste that still
// counts against payload limits (Gemini ~20MB/request, Anthropic 5MB/image)
// and our own buffering.
//
// Runs after body parsing on every chat-shaped surface (proxy, responses,
// anthropic, and the inbound-chat funnel behind Ollama/Gemini wire): data-URL
// images over the size threshold are decoded, downscaled to fit
// IMAGE_NORMALIZE_MAX_DIMENSION, and re-encoded — JPEG q<quality>, or PNG
// only when the alpha channel ACTUALLY carries transparency. Screenshots are
// the gotcha: macOS ships them as RGBA PNGs that are fully opaque, and
// honoring the bare hasAlpha flag kept them on PNG, "compressing" 2.0MB →
// 1.9MB. http(s) URLs are left alone — providers that need the bytes fetch
// them themselves (see google.ts). Failures anywhere in the pipeline keep the
// original image: a vision request must never be lost to a transcoding
// hiccup.
//
// Knobs (env):
//   IMAGE_NORMALIZE                 off/false/0 disables entirely (default on)
//   IMAGE_NORMALIZE_MAX_DIMENSION   long-edge cap in px (default 2048)
//   IMAGE_NORMALIZE_THRESHOLD_KB    raw-bytes floor before touching an image
//                                   (default 1024 — small images decode-free)
//   IMAGE_NORMALIZE_QUALITY         JPEG quality, 1-100 (default 90)
//
// Input formats: anything libvips decodes — jpeg, png, webp, gif (first
// frame only — animation is dropped), tiff (first page), bmp, svg (rasterized
// at native size), avif. Formats it can't decode (notably HEIC on standard
// builds) and any corrupt payload fall through untouched: the provider sees
// the original and decides.
const DEFAULT_MAX_DIMENSION = 2048;
const DEFAULT_THRESHOLD_KB = 1024;
const DEFAULT_QUALITY = 90;
let sharpModule; // undefined = not yet attempted
/**
 * False when this machine is known to be unable to run sharp's prebuilt
 * libvips: linux-x64 whose /proc/cpuinfo flags lack sse4_2. Anything we cannot
 * read or recognise counts as capable, which keeps today's behaviour.
 */
export function cpuCanRunSharp(platform = process.platform, arch = process.arch, readCpuinfo = () => readFileSync('/proc/cpuinfo', 'utf8')) {
    if (platform !== 'linux' || arch !== 'x64')
        return true;
    let cpuinfo;
    try {
        cpuinfo = readCpuinfo();
    }
    catch {
        return true;
    }
    const flags = cpuinfo.split('\n').find(line => /^flags\s*:/.test(line));
    if (!flags)
        return true;
    return /\bsse4_2\b/.test(flags);
}
async function loadSharp() {
    if (sharpModule !== undefined)
        return sharpModule;
    if (!cpuCanRunSharp()) {
        sharpModule = null;
        console.warn('[ImageNormalize] this CPU lacks SSE4.2, which the bundled image library (sharp) needs; ' +
            'inbound images will not be resized (set IMAGE_NORMALIZE=off to silence this)');
        return sharpModule;
    }
    try {
        sharpModule = (await import('sharp')).default;
    }
    catch (err) {
        sharpModule = null;
        console.warn('[ImageNormalize] sharp is unavailable, inbound images will not be resized ' +
            `(set IMAGE_NORMALIZE=off to silence this): ${err?.message ?? err}`);
    }
    return sharpModule;
}
function envFlagOff(raw) {
    if (!raw)
        return false;
    const lower = raw.trim().toLowerCase();
    return lower === 'off' || lower === 'false' || lower === '0' || lower === 'no';
}
function envNumber(raw, fallback, min) {
    if (raw === undefined || raw.trim() === '')
        return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min)
        return fallback;
    return Math.floor(n);
}
// Read lazily (not at import) so tests can steer the knobs via process.env
// without module-reload gymnastics.
function resolveOptions(overrides) {
    return {
        enabled: overrides?.enabled ?? !envFlagOff(process.env.IMAGE_NORMALIZE),
        maxDimension: overrides?.maxDimension
            ?? envNumber(process.env.IMAGE_NORMALIZE_MAX_DIMENSION, DEFAULT_MAX_DIMENSION, 16),
        thresholdBytes: overrides?.thresholdBytes
            ?? envNumber(process.env.IMAGE_NORMALIZE_THRESHOLD_KB, DEFAULT_THRESHOLD_KB, 0) * 1024,
        quality: Math.min(100, overrides?.quality
            ?? envNumber(process.env.IMAGE_NORMALIZE_QUALITY, DEFAULT_QUALITY, 1)),
    };
}
const DATA_URL_RE = /^data:([^;,]+)?(;base64)?,(.*)$/s;
// Collect the mutable image slots of one message: OpenAI-style `image_url`
// blocks in both the shorthand (string) and object ({ url }) forms.
function imageSlots(message) {
    if (!Array.isArray(message.content))
        return [];
    const slots = [];
    for (const block of message.content) {
        if (!block || typeof block !== 'object')
            continue;
        const b = block;
        if (b.type !== 'image_url' && b.type !== 'image')
            continue;
        if (typeof b.image_url === 'string') {
            slots.push({ url: b.image_url, set: (url) => { block.image_url = url; } });
        }
        else if (b.image_url && typeof b.image_url.url === 'string') {
            const obj = b.image_url;
            slots.push({ url: obj.url, set: (url) => { obj.url = url; } });
        }
    }
    return slots;
}
// The sharp-free half of the decision: is this data URL an image worth
// decoding at all? Kept apart so a request with nothing to transcode never
// loads sharp (#1469).
function candidateOf(url, opts) {
    const match = DATA_URL_RE.exec(url);
    if (!match)
        return null;
    const mime = (match[1] ?? '').toLowerCase();
    const isBase64 = Boolean(match[2]);
    const payload = match[3] ?? '';
    if (!isBase64 || !mime.startsWith('image/') || payload.length === 0)
        return null;
    const rawBytes = Math.floor(payload.length * 3 / 4);
    const alreadyCompact = mime === 'image/jpeg' || mime === 'image/webp';
    // Cheap pre-filter: under the threshold AND already a lossy format means
    // there is nothing to win — skip the decode entirely. Oversized-dimension
    // images under the threshold are rare enough (pixels ≈ bytes) that this
    // trade stays worth it.
    if (rawBytes < opts.thresholdBytes && alreadyCompact)
        return null;
    return { mime, payload, rawBytes, alreadyCompact };
}
// Transcode one candidate; returns null when the image should ride along
// unchanged (already compact or any failure).
async function normalizeDataUrl(sharp, candidate, opts) {
    const { payload, rawBytes, alreadyCompact } = candidate;
    let buffer;
    try {
        buffer = Buffer.from(payload, 'base64');
    }
    catch {
        return null;
    }
    try {
        const image = sharp(buffer);
        const meta = await image.metadata();
        const width = meta.width ?? 0;
        const height = meta.height ?? 0;
        const needsResize = width > opts.maxDimension || height > opts.maxDimension;
        // Small, right-sized, already-compact: nothing to win — skip the decode.
        if (!needsResize && alreadyCompact && rawBytes < opts.thresholdBytes)
            return null;
        // An over-threshold JPEG/WebP at the right size still gets re-encoded at
        // the target quality below (the never-grow guard keeps the original when
        // that can't win), so there is no early return for it.
        let pipeline = image;
        if (needsResize) {
            pipeline = pipeline.resize({
                width: opts.maxDimension,
                height: opts.maxDimension,
                fit: 'inside',
                withoutEnlargement: true,
            });
        }
        // Alpha is only worth keeping when it actually carries transparency.
        // Screenshots (the dominant vision payload here) are RGBA-but-fully-
        // opaque; honoring the bare hasAlpha flag kept them on PNG and squeezed
        // 2.0MB → 1.9MB instead of → ~300KB. stats() decodes, but we were about
        // to re-encode anyway.
        let keepAlpha = false;
        if (meta.hasAlpha) {
            try {
                keepAlpha = (await sharp(buffer).stats()).isOpaque === false;
            }
            catch {
                keepAlpha = true; // unknown opacity: stay lossless
            }
        }
        const out = keepAlpha
            ? { buffer: await pipeline.png().toBuffer(), mime: 'image/png' }
            : {
                buffer: await pipeline
                    .flatten({ background: { r: 255, g: 255, b: 255 } })
                    .jpeg({ quality: opts.quality })
                    .toBuffer(),
                mime: 'image/jpeg',
            };
        // Never make it bigger (tiny paletted PNGs can lose to JPEG overhead).
        if (out.buffer.length >= buffer.length)
            return null;
        return {
            url: `data:${out.mime};base64,${out.buffer.toString('base64')}`,
            before: buffer.length,
            after: out.buffer.length,
        };
    }
    catch {
        // Corrupt/unsupported image: the provider gets the original and decides.
        return null;
    }
}
/**
 * Downscale + re-encode over-threshold inline images across a chat-message
 * list. Pure with respect to everything but the image blocks themselves
 * (text, tool calls, detail hints, block order all untouched). Never throws.
 */
export async function normalizeMessageImages(messages, overrides) {
    const opts = resolveOptions(overrides);
    const summary = { messages, normalized: 0, bytesBefore: 0, bytesAfter: 0 };
    if (!opts.enabled)
        return summary;
    const work = [];
    for (const message of messages) {
        for (const slot of imageSlots(message)) {
            if (!slot.url.startsWith('data:'))
                continue;
            const candidate = candidateOf(slot.url, opts);
            if (candidate)
                work.push({ slot, candidate });
        }
    }
    // Text-only and small-image requests never load the native module (#1469).
    if (work.length === 0)
        return summary;
    // No sharp (missing prebuild, unsupported platform or CPU): pass everything
    // through untouched rather than failing the request.
    const sharp = await loadSharp();
    if (!sharp)
        return summary;
    for (const { slot, candidate } of work) {
        const result = await normalizeDataUrl(sharp, candidate, opts);
        if (!result)
            continue;
        slot.set(result.url);
        summary.normalized += 1;
        summary.bytesBefore += result.before;
        summary.bytesAfter += result.after;
    }
    if (summary.normalized > 0) {
        const mb = (n) => (n / (1024 * 1024)).toFixed(1);
        console.log(`[ImageNormalize] re-encoded ${summary.normalized} image(s): ${mb(summary.bytesBefore)}MB → ${mb(summary.bytesAfter)}MB`);
    }
    return summary;
}
//# sourceMappingURL=image-normalize.js.map