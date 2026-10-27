// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Verification pipeline for one step-challenge upload.
//
// No detector is perfect, so this never rejects anything. It runs every
// check, starts the entry at 100, subtracts per flag, and decides one of:
//   auto_approved   — score >= 80, no hard flag, count readable and within
//                     2% of the claim, date inside the window
//   pending_review  — everything else; the coach decides in the portal
//
// Checks: date window · exact duplicate (SHA-256) · near duplicate (64-bit
// dHash, Hamming <= 6) · EXIF/XMP (capture date, editor or generator
// software, IPTC digital source type) · C2PA Content Credentials · Claude
// vision read + skepticism · claimed vs read count · daily cap and spike.
//
// Plain module (not an api/ file) so it adds no serverless function.
// Returns everything the caller needs to write the entry row and the audit
// event; it does not write to the database itself.

const crypto = require('crypto');
const sharp = require('sharp');
const exifr = require('exifr');
const { askJson, ClaudeError } = require('./claude');
const { zonedToUtc, endOfDay, localDate, addDays } = require('./time');

const AUTO_APPROVE_SCORE = 80;
const NEAR_DUP_DISTANCE = 6;
const COUNT_TOLERANCE = 0.02;
const PHOTO_DATE_TOLERANCE_H = 36;
const SPIKE_MULTIPLIER = 3;
const SPIKE_MIN_ENTRIES = 3;
const VISION_LONG_EDGE = 1568;

// flag → points off. HARD flags also block auto-approval outright.
const PENALTY = {
  reused_photo: 60,
  ai_generated_content_credentials: 70,
  ai_generated_metadata: 70,
  edited_or_generated_software: 40,
  over_daily_cap: 30,
  outside_window: 50,
  unreadable_count: 30,
  vision_unavailable: 30,
  ai_likelihood_high: 50,
  ai_likelihood_medium: 25,
  near_duplicate_photo: 30,
  photo_date_mismatch: 25,
  sudden_spike: 25,
  count_mismatch: 20,
  display_date_mismatch: 20,
  source_mismatch: 15,
  edited_content_credentials: 15,
  exif_missing: 5,
};
const HARD_FLAGS = new Set([
  'reused_photo', 'ai_generated_content_credentials', 'ai_generated_metadata',
  'edited_or_generated_software', 'over_daily_cap', 'outside_window',
]);

// Editors, filters and generators that should never touch a step photo.
const EDITOR_RE = /photoshop|lightroom|snapseed|picsart|facetune|canva|midjourney|dall[\s·.\-]?e|firefly|stable[\s\-]?diffusion|comfyui|automatic1111|gimp|pixelmator|affinity|meitu|airbrush|lensa|remini|faceapp|photoroom|pixlr|fotor|polarr|befunky|chatgpt|openai|gemini|imagen|ideogram|leonardo|flux|krita|paint\.net|grok|sora/i;
const AI_SOURCE_RE = /compositeWithTrainedAlgorithmicMedia|trainedAlgorithmicMedia|algorithmicMedia/;

const SOURCE_TO_DISPLAY = {
  stair_machine_photo: 'stair_machine',
  watch_screenshot: 'watch',
  phone_app_screenshot: 'phone_health_app',
};
const isScreenshotSource = (s) => s === 'watch_screenshot' || s === 'phone_app_screenshot';

// ─── Window ──────────────────────────────────────────────────────────

// Is entryDate loggable right now? → { ok, reason }
function checkWindow(challenge, entryDate, now = new Date()) {
  const tz = challenge.timezone;
  if (new Date(challenge.final_upload_deadline) <= now) return { ok: false, reason: 'deadline_passed' };
  if (entryDate < challenge.start_date || entryDate > challenge.end_date) return { ok: false, reason: 'outside_challenge' };
  if (entryDate > localDate(now, tz)) return { ok: false, reason: 'future_date' };
  const closes = new Date(endOfDay(entryDate, tz).getTime() + challenge.log_grace_hours * 3600_000);
  if (now > closes) return { ok: false, reason: 'grace_expired' };
  return { ok: true };
}

// ─── Image helpers ───────────────────────────────────────────────────

function sniffMime(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12);
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return 'image/heic';
    if (brand === 'avif') return 'image/avif';
  }
  return null;
}

// sharp's prebuilt libvips has no HEVC decoder, so iPhone HEIC goes
// through heic-convert (WASM libheif) first.
async function toDecodable(buf, mime) {
  if (mime !== 'image/heic') return buf;
  const convert = require('heic-convert');
  return Buffer.from(await convert({ buffer: buf, format: 'JPEG', quality: 0.92 }));
}

async function visionJpeg(decodable) {
  return sharp(decodable).rotate()
    .resize({ width: VISION_LONG_EDGE, height: VISION_LONG_EDGE, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 85 })
    .toBuffer();
}

// 64-bit difference hash: 9x8 grayscale, one bit per left/right pair.
async function dHash(decodable) {
  const px = await sharp(decodable).rotate().grayscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits = (bits << 1n) | (px[y * 9 + x] > px[y * 9 + x + 1] ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, '0');
}

function hamming(a, b) {
  let v = BigInt('0x' + a) ^ BigInt('0x' + b);
  let n = 0;
  while (v) { n += Number(v & 1n); v >>= 1n; }
  return n;
}

// ─── EXIF / XMP ──────────────────────────────────────────────────────

async function readMetadata(buf) {
  let raw = null;
  try {
    raw = await exifr.parse(buf, {
      tiff: true, exif: true, xmp: true, iptc: true,
      gps: false, icc: false, interop: false, reviveValues: false, mergeOutput: true,
    });
  } catch { raw = null; }
  if (!raw || !Object.keys(raw).length) return null;
  const pick = (...keys) => keys.map((k) => raw[k]).find((v) => v != null && v !== '');
  const str = (v) => (v == null ? null : String(Array.isArray(v) ? v.join(' ') : typeof v === 'object' ? JSON.stringify(v) : v).slice(0, 300));
  // Never store GPS: many participants are minors.
  return {
    DateTimeOriginal: str(pick('DateTimeOriginal', 'CreateDate', 'DateCreated')),
    OffsetTimeOriginal: str(pick('OffsetTimeOriginal', 'OffsetTime')),
    Make: str(pick('Make')),
    Model: str(pick('Model')),
    Software: str(pick('Software', 'CreatorTool')),
    History: str(pick('HistorySoftwareAgent', 'History')),
    UserComment: str(pick('UserComment')),
    DigitalSourceType: str(pick('DigitalSourceType')),
  };
}

// EXIF 'YYYY:MM:DD HH:MM:SS' (+ optional offset) → Date, read in tz when
// the camera didn't record an offset.
function exifInstant(meta, tz) {
  const m = String(meta?.DateTimeOriginal || '').match(/^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const off = String(meta.OffsetTimeOriginal || '').match(/^([+-]\d{2}):?(\d{2})$/);
  if (off) return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${off[1]}:${off[2]}`);
  return zonedToUtc(`${m[1]}-${m[2]}-${m[3]}`, `${m[4]}:${m[5]}:${m[6]}`, tz);
}

// ─── C2PA ────────────────────────────────────────────────────────────

// The c2pa-node native binary ships for linux-x64 (Vercel). Anywhere it
// won't load, the check reports unavailable and the pipeline carries on.
let c2paModule;
async function loadC2pa() {
  if (c2paModule !== undefined) return c2paModule;
  try {
    const mod = await import('@contentauth/c2pa-node');
    c2paModule = mod.Reader ? mod : null;
  } catch (e) {
    console.warn('[fuel-verify] c2pa unavailable:', e?.message);
    c2paModule = null;
  }
  return c2paModule;
}

async function readC2pa(buf, mime) {
  const mod = await loadC2pa();
  if (!mod) return { available: false };
  let reader;
  try {
    reader = await mod.Reader.fromAsset({ buffer: buf, mimeType: mime });
  } catch (e) {
    // A native-binary load failure surfaces on first use, not on import.
    if (/index\.node|Win32|ELF|dlopen|cannot open shared object/i.test(e?.message || '')) {
      c2paModule = null;
      return { available: false };
    }
    return { available: true, present: false, error: String(e?.message || e).slice(0, 200) };
  }
  if (!reader) return { available: true, present: false };
  const store = reader.json();
  const active = store.manifests?.[store.active_manifest] || {};
  const generators = [
    active.claim_generator,
    ...(active.claim_generator_info || []).map((g) => [g.name, g.version].filter(Boolean).join(' ')),
  ].filter(Boolean);
  const actions = [];
  for (const a of active.assertions || []) {
    if (!/^c2pa\.actions/.test(a.label || '')) continue;
    for (const act of a.data?.actions || []) {
      actions.push({
        action: act.action,
        digitalSourceType: act.digitalSourceType || null,
        softwareAgent: typeof act.softwareAgent === 'object' ? act.softwareAgent?.name : act.softwareAgent || null,
      });
    }
  }
  const blob = JSON.stringify(store);
  return {
    available: true,
    present: true,
    generators,
    title: active.title || null,
    issuer: active.signature_info?.issuer || null,
    signed_at: active.signature_info?.time || null,
    actions: actions.slice(0, 20),
    ai_source: AI_SOURCE_RE.test(blob),
    ai_generator: generators.some((g) => EDITOR_RE.test(g)),
    edited: actions.some((a) => /c2pa\.(edited|filtered|color_adjustments|drawing|composited)/.test(a.action || '')),
    camera_capture: /digitalCapture/.test(blob),
    validation_state: store.validation_state || null,
  };
}

// ─── Claude vision ───────────────────────────────────────────────────

const VISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['readable_step_count', 'display_type', 'matches_declared_source', 'date_visible',
    'real_photo_signals', 'manipulation_signals', 'ai_or_edited_likelihood', 'notes'],
  properties: {
    readable_step_count: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    display_type: { type: 'string', enum: ['stair_machine', 'watch', 'phone_health_app', 'other', 'unreadable'] },
    matches_declared_source: { type: 'boolean' },
    date_visible: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    real_photo_signals: { type: 'array', items: { type: 'string' } },
    manipulation_signals: { type: 'array', items: { type: 'string' } },
    ai_or_edited_likelihood: { type: 'string', enum: ['low', 'medium', 'high'] },
    notes: { type: 'string' },
  },
};

const VISION_SYSTEM = `You verify proof images for a fitness step challenge. Participants upload either a photo of a stair-climber machine's console after a workout, or a screenshot of a watch or phone health app (Apple Fitness/Health, Garmin, Fitbit, Samsung Health, Google Fit and similar). Prizes are at stake, so be skeptical: your job is to read the step count and to notice anything that suggests the image is edited, reused, staged or AI-generated.

Reading the count:
- readable_step_count is the STEPS figure for the day or workout shown. Never report floors, calories, minutes, distance or heart rate as steps. Ignore thousands separators. If no step figure is clearly legible, return null.
- date_visible is the date the image itself shows, as YYYY-MM-DD, only when an actual date is legible. Labels like "Today" are not a date: return null.

What genuine images look like:
- Stair machine photos show a physical console in real-world lighting: screen glare, reflections, moiré from photographing an LCD, slight angle and perspective, natural blur or noise, scuffs, the machine's frame or the gym around it.
- Health app screenshots show the app's native UI exactly: the correct system fonts, consistent digit rendering, a status bar, aligned cards and charts whose bars agree with the totals.

Manipulation signals to look for: digits in a different font, weight, size or baseline from their neighbours; numbers that look pasted on; smudged or warped UI; text that is almost-but-not-quite real words; impossible layouts or totals that disagree with the chart; perfectly flat, noise-free "photos" of screens; AI artifacts such as melted edges, garbled small text or inconsistent shadows.

ai_or_edited_likelihood: "low" when the image looks genuine, "medium" when something is off but could be innocent, "high" when you see clear manipulation or generation artifacts. Base it only on the image. notes is one plain sentence.`;

async function runVision(jpeg, { source, entryDate }) {
  const declared = {
    stair_machine_photo: 'a photo of a stair machine console',
    watch_screenshot: 'a screenshot from a smartwatch app',
    phone_app_screenshot: 'a screenshot from a phone health or fitness app',
  }[source];
  const { data, model } = await askJson({
    system: VISION_SYSTEM,
    schema: VISION_SCHEMA,
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
      { type: 'text', text: `The participant says this is ${declared}, for their steps on ${entryDate}. Analyze the image.` },
    ],
  });
  return { ...data, model };
}

// ─── Pipeline ────────────────────────────────────────────────────────

// Every entry in the challenge, paged past PostgREST's 1000-row cap so
// duplicate checks see the whole month.
async function priorEntries(supabase, challenge) {
  const PAGE = 1000;
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('fuel_step_entries')
      .select('id, participant_id, entry_date, image_sha256, image_phash, claimed_steps, extracted_steps, counted_steps, verification_status')
      .eq('client_id', challenge.client_id)
      .eq('challenge_id', challenge.id)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error('prior entries lookup failed: ' + error.message);
    rows.push(...data);
    if (data.length < PAGE) return rows;
  }
}

// args: { supabase, challenge, participant, entry: { entry_date, source,
//         claimed_steps, image_path }, image: Buffer, now }
// → { status, score, flags, hard_flags, counted_steps, extracted_steps,
//     image_sha256, image_phash, exif, c2pa, ai_analysis, reasoning }
async function verifyStepImage({ supabase, challenge, participant, entry, image, now = new Date() }) {
  const tz = challenge.timezone;
  const flags = new Set();
  const reasoning = [];
  const note = (check, result, detail) => reasoning.push(detail === undefined ? { check, result } : { check, result, detail });
  const screenshot = isScreenshotSource(entry.source);

  // 1. Window (the API refuses out-of-window dates before upload; this is
  //    the record, and the backstop).
  const win = checkWindow(challenge, entry.entry_date, now);
  if (!win.ok) flags.add('outside_window');
  note('window', win.ok ? 'ok' : win.reason);

  // 2. Exact duplicate.
  const sha = crypto.createHash('sha256').update(image).digest('hex');
  const mime = sniffMime(image);
  let decodable = null;
  let phash = null;
  try {
    decodable = await toDecodable(image, mime);
    phash = await dHash(decodable);
  } catch (e) {
    note('decode', 'failed', String(e?.message || e).slice(0, 200));
  }

  const prior = await priorEntries(supabase, challenge);

  const exact = prior.filter((p) => p.image_sha256 === sha);
  if (exact.length) flags.add('reused_photo');
  note('exact_duplicate', exact.length ? 'match' : 'none',
    exact.length ? { entries: exact.map((p) => p.id), same_participant: exact.every((p) => p.participant_id === participant.id) } : undefined);

  // 3. Near duplicate: the same photo cropped or re-saved. A 64-bit dHash
  //    can't tell two photos of the same gym machine apart (same console,
  //    same angle, different digits hash 2-3 bits apart), and app
  //    screenshots share a layout. A re-used photo also shows the SAME
  //    number, so it takes a close hash AND a matching count to flag.
  let nearest = null;
  let nearDup = null;
  if (phash) {
    for (const p of prior) {
      if (!p.image_phash || p.image_sha256 === sha) continue;
      const d = hamming(phash, p.image_phash);
      if (!nearest || d < nearest.distance) nearest = { id: p.id, participant_id: p.participant_id, distance: d };
      const priorCount = p.extracted_steps ?? p.claimed_steps;
      const sameCount = priorCount != null && Math.abs(priorCount - entry.claimed_steps) <= Math.max(entry.claimed_steps, 1) * COUNT_TOLERANCE;
      if (d <= NEAR_DUP_DISTANCE && sameCount && (!nearDup || d < nearDup.distance)) {
        nearDup = { id: p.id, participant_id: p.participant_id, distance: d };
      }
    }
  }
  const near = !!nearDup;
  if (near) nearest = nearDup;
  if (near) flags.add('near_duplicate_photo');
  note('near_duplicate', near ? 'match' : 'none', nearest || undefined);

  // 4. EXIF / XMP.
  const meta = await readMetadata(image);
  if (!meta || (!meta.DateTimeOriginal && !meta.Make && !meta.Software)) {
    flags.add('exif_missing');
    note('exif', 'missing');
  } else {
    const shot = exifInstant(meta, tz);
    if (shot) {
      const entryNoon = zonedToUtc(entry.entry_date, '12:00:00', tz);
      const hoursOff = Math.abs(shot - entryNoon) / 3600_000;
      if (hoursOff > PHOTO_DATE_TOLERANCE_H) flags.add('photo_date_mismatch');
      note('exif_date', hoursOff > PHOTO_DATE_TOLERANCE_H ? 'mismatch' : 'ok', { taken_local: localDate(shot, tz), hours_from_entry_noon: Math.round(hoursOff) });
    } else {
      note('exif_date', 'absent');
    }
    const software = [meta.Software, meta.History].filter(Boolean).join(' | ');
    if (software && EDITOR_RE.test(software)) {
      flags.add('edited_or_generated_software');
      note('exif_software', 'editor_or_generator', software);
    } else {
      note('exif_software', software ? 'ok' : 'absent', software || undefined);
    }
    if (meta.DigitalSourceType && AI_SOURCE_RE.test(meta.DigitalSourceType)) {
      flags.add('ai_generated_metadata');
      note('iptc_source_type', 'ai', meta.DigitalSourceType);
    }
  }

  // 5. C2PA Content Credentials.
  const c2pa = mime ? await readC2pa(image, mime) : { available: true, present: false };
  if (c2pa.present) {
    if (c2pa.ai_source || c2pa.ai_generator) flags.add('ai_generated_content_credentials');
    else if (c2pa.edited) flags.add('edited_content_credentials');
  }
  note('c2pa', !c2pa.available ? 'unavailable' : !c2pa.present ? 'none'
    : c2pa.ai_source || c2pa.ai_generator ? 'ai_generated' : c2pa.edited ? 'edited' : c2pa.camera_capture ? 'camera_capture' : 'present');

  // 6. Claude vision.
  let vision = null;
  if (decodable) {
    try {
      vision = await runVision(await visionJpeg(decodable), entry);
    } catch (e) {
      const code = e instanceof ClaudeError ? e.code : 'error';
      console.error('[fuel-verify] vision failed:', code, e?.message);
      note('vision', 'failed', code);
    }
  }
  if (!vision) {
    flags.add('vision_unavailable');
  } else {
    if (vision.ai_or_edited_likelihood === 'high') flags.add('ai_likelihood_high');
    if (vision.ai_or_edited_likelihood === 'medium') flags.add('ai_likelihood_medium');
    const expected = SOURCE_TO_DISPLAY[entry.source];
    if (!vision.matches_declared_source || (expected && vision.display_type !== expected)) flags.add('source_mismatch');
    if (vision.date_visible && /^\d{4}-\d{2}-\d{2}$/.test(vision.date_visible) && vision.date_visible !== entry.entry_date) {
      flags.add('display_date_mismatch');
    }
    note('vision', vision.ai_or_edited_likelihood, { display_type: vision.display_type, read: vision.readable_step_count });
  }

  // 7. Number check.
  const claimed = entry.claimed_steps;
  const extracted = Number.isInteger(vision?.readable_step_count) ? vision.readable_step_count : null;
  let countMatches = false;
  if (extracted == null) {
    flags.add('unreadable_count');
    note('count', 'unreadable');
  } else {
    const diff = Math.abs(extracted - claimed) / Math.max(claimed, 1);
    countMatches = diff <= COUNT_TOLERANCE;
    if (!countMatches) flags.add('count_mismatch');
    note('count', countMatches ? 'match' : 'mismatch', { claimed, extracted, diff_pct: Math.round(diff * 1000) / 10 });
  }

  // 8. Plausibility.
  if (claimed > challenge.daily_step_cap) flags.add('over_daily_cap');
  const weekAgo = addDays(entry.entry_date, -7);
  const byDay = new Map();
  for (const p of prior) {
    if (p.participant_id !== participant.id || p.counted_steps == null) continue;
    if (!['auto_approved', 'approved'].includes(p.verification_status)) continue;
    if (p.entry_date < weekAgo || p.entry_date >= entry.entry_date) continue;
    byDay.set(p.entry_date, Math.max(byDay.get(p.entry_date) || 0, p.counted_steps));
  }
  const recent = [...byDay.values()];
  const avg = recent.length >= SPIKE_MIN_ENTRIES ? recent.reduce((a, b) => a + b, 0) / recent.length : null;
  if (avg && claimed > SPIKE_MULTIPLIER * avg) flags.add('sudden_spike');
  note('plausibility', {
    over_cap: claimed > challenge.daily_step_cap,
    seven_day_avg: avg && Math.round(avg),
    spike: !!(avg && claimed > SPIKE_MULTIPLIER * avg),
  });

  // 9. Score + decision.
  let score = 100;
  for (const f of flags) {
    let p = PENALTY[f] || 0;
    if (f === 'near_duplicate_photo' && screenshot) p = 15;
    if (f === 'exif_missing' && screenshot) p = 0;
    score -= p;
  }
  score = Math.max(0, Math.min(100, score));
  const hard = [...flags].filter((f) => HARD_FLAGS.has(f));
  const autoApprove = score >= AUTO_APPROVE_SCORE && !hard.length && extracted != null && countMatches && win.ok;
  const status = autoApprove ? 'auto_approved' : 'pending_review';
  note('decision', status, { score, hard_flags: hard });

  return {
    status,
    score,
    flags: [...flags],
    hard_flags: hard,
    counted_steps: autoApprove ? claimed : null,
    // When the read disagrees with the claim, the read is the suggestion
    // the coach sees in review.
    extracted_steps: extracted,
    suggested_steps: extracted ?? null,
    image_sha256: sha,
    image_phash: phash,
    exif: meta,
    c2pa,
    ai_analysis: vision,
    reasoning,
  };
}

module.exports = { verifyStepImage, checkWindow, sniffMime, dHash, hamming, PENALTY, HARD_FLAGS };
