// General-purpose utility functions shared across scripts.

/**
 * Convert a name to a URL-safe key.
 * Lowercases, strips punctuation, replaces spaces and separators with hyphens,
 * removes diacritics, and strips a leading "the-".
 */
export function simplify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/ /g, "-")
    .replace(/['']/g, "")
    .replace(/\./g, "")
    .replace(/,/g, "")
    .replace(/[*"<>()/&–—]/g, "-")
    .replace(/---/g, "-")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^the-/, "");
}

/**
 * Parse a coords string into { lat, lon } decimal degrees.
 * Accepts:
 *   - Decimal:  "51.5074, -0.1278"
 *   - DMS:      "51°30'26.64\"N, 0°7'39.96\"W"
 *   - Mixed:    "51.5074N, 0.1278W"
 * Returns null if the string cannot be parsed or is out of range.
 */
export function parseCoords(s) {
  if (!s) return null;

  const parts = String(s).split(",");
  if (parts.length < 2) return null;

  const lat = parseOneCoord(parts[0].trim(), "lat");
  const lon = parseOneCoord(parts.slice(1).join(",").trim(), "lon");
  if (lat == null || lon == null) return null;

  return { lat, lon };
}

/**
 * Return true if a coords string contains a degree symbol (DMS format).
 */
export function isDmsCoords(s) {
  return s != null && String(s).includes("°");
}

/**
 * Format a { lat, lon } object as a canonical decimal string: "12.3456, -9.8765"
 */
export function formatCoords({ lat, lon }) {
  return `${lat}, ${lon}`;
}

// ---- internal ----

const isCleanDecimal = (s) => /^-?\d+(?:\.\d+)?$/.test(s);

function parseOneCoord(raw, kind) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;

  s = s.replace(/\u2032/g, "'").replace(/\u2033/g, '"');

  const hemiMatch = s.match(/[NSEW]/i);
  const hemi = hemiMatch ? hemiMatch[0].toUpperCase() : null;

  s = s.replace(/[NSEW]/gi, "").replace(/\s+/g, "");

  if (s.includes("°")) {
    const m = s.match(/^(-?\d+(?:\.\d+)?)°(?:(\d+(?:\.\d+)?)')?(?:(\d+(?:\.\d+)?)")?$/);
    if (!m) return null;

    const deg = Number(m[1]);
    const min = m[2] != null ? Number(m[2]) : 0;
    const sec = m[3] != null ? Number(m[3]) : 0;
    if (!Number.isFinite(deg) || !Number.isFinite(min) || !Number.isFinite(sec)) return null;
    if (min < 0 || min >= 60 || sec < 0 || sec >= 60) return null;

    let val = Math.abs(deg) + min / 60 + sec / 3600;
    let sign = deg < 0 ? -1 : 1;
    if (hemi === "S" || hemi === "W") sign = -1;
    if (hemi === "N" || hemi === "E") sign = 1;
    val *= sign;

    const max = kind === "lat" ? 90 : 180;
    if (Math.abs(val) > max) return null;
    return val;
  }

  s = s.replace(/°/g, "");
  if (!isCleanDecimal(s)) return null;

  let val = Number(s);
  if (!Number.isFinite(val)) return null;

  if (hemi) {
    const abs = Math.abs(val);
    val = (hemi === "S" || hemi === "W") ? -abs : abs;
  }

  const max = kind === "lat" ? 90 : 180;
  if (Math.abs(val) > max) return null;
  return val;
}
