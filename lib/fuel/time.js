// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Time-zone math for challenges. Every challenge day is a calendar date in
// the challenge's own timezone (fuel_challenges.timezone), so "Nov 6" means
// the same thing to the page, the API and the cron no matter where Vercel
// runs. Plain Intl — no tz library.

// 'YYYY-MM-DD' for an instant, in tz.
function localDate(instant, tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(instant);
}

// Minutes tz is ahead of UTC at an instant (CT in November → -360).
function offsetMinutes(instant, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - instant.getTime()) / 60000);
}

// The instant a wall-clock time happens in tz. 'YYYY-MM-DD', 'HH:MM:SS'.
function zonedToUtc(date, time, tz) {
  const [y, mo, d] = date.split('-').map(Number);
  const [h = 0, mi = 0, s = 0] = String(time || '00:00:00').split(':').map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  // Two passes settle the offset across a DST change.
  let guess = wall - offsetMinutes(new Date(wall), tz) * 60000;
  guess = wall - offsetMinutes(new Date(guess), tz) * 60000;
  return new Date(guess);
}

const startOfDay = (date, tz) => zonedToUtc(date, '00:00:00', tz);
const endOfDay = (date, tz) => zonedToUtc(addDays(date, 1), '00:00:00', tz);

function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function isIsoDate(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'));
}

// 'Nov 6'
function shortDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

module.exports = { localDate, offsetMinutes, zonedToUtc, startOfDay, endOfDay, addDays, isIsoDate, shortDate };
