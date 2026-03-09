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

// ---- key computation ----

/**
 * Compute the entity key from its fields and the page's tags.
 * Rules:
 *   - country-key tag:    "name CC" (unless name contains a comma)
 *   - reference-key tag:  "name reference" or "reference name" (if reference-first)
 *   - default:            simplify(name)
 */
export function computeKey({ name, reference, country }, pageTags = []) {
  const referenceKey   = pageTags.includes("reference-key");
  const referenceFirst = pageTags.includes("reference-first");
  const countryKey     = pageTags.includes("country-key");
  const cc = country ? String(country).toUpperCase() : null;
  if (countryKey && cc && !String(name).includes(",")) return simplify(`${name} ${cc}`);
  if (referenceKey && reference) return simplify(referenceFirst ? `${reference} ${name}` : `${name} ${reference}`);
  return simplify(name);
}

// ---- flag / country helpers ----

// Map of ISO 3166-1 alpha-2 country codes to flag emoji.
// The flag emoji for country code XX is the regional indicator
// symbols for X and X: 0x1F1E6 + (charCode - 65).
export function countryCodeToFlagEmoji(code) {
  const upper = code.toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) return null;
  return [...upper]
    .map(c => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65))
    .join("");
}

/**
 * Given a flag emoji (two regional indicator symbols), return the
 * ISO 3166-1 alpha-2 country code, or null if it's not a flag emoji.
 */
export function flagEmojiToCountryCode(emoji) {
  if (!emoji) return null;
  const codePoints = [...emoji].map(c => c.codePointAt(0));
  if (codePoints.length !== 2) return null;
  if (!codePoints.every(cp => cp >= 0x1F1E6 && cp <= 0x1F1FF)) return null;
  return codePoints.map(cp => String.fromCharCode(cp - 0x1F1E6 + 65)).join("");
}

/**
 * Extract all country codes from an icons array.
 * Returns an array of uppercase ISO alpha-2 codes.
 */
export function countryCodesFromIcons(icons = []) {
  return icons.map(flagEmojiToCountryCode).filter(Boolean);
}

// ---- geo / city lookup ----

/**
 * Find the nearest city within radiusKm kilometres of the given location.
 * Requires a MongoDB collection handle for the entities collection.
 * Returns the city name string, or null if none found within the radius.
 *
 * @param {{ lat: number, lon: number } | { type: string, coordinates: number[] }} location
 * @param {Collection} entitiesCollection  — MongoDB collection handle
 * @param {number} radiusKm               — search radius in kilometres (default 20)
 */
export async function findNearestCity(location, entitiesCollection, radiusKm = 20) {
  // Accept either { lat, lon } or GeoJSON Point
  let geoPoint;
  if (location.type === "Point") {
    geoPoint = location;
  } else {
    geoPoint = { type: "Point", coordinates: [location.lon, location.lat] };
  }

  const results = await entitiesCollection
    .find(
      {
        list: "cities",
        location: {
          $nearSphere: {
            $geometry: geoPoint,
            $maxDistance: radiusKm * 1000, // metres
          },
        },
      },
      { projection: { name: 1, _id: 0 } }
    )
    .limit(1)
    .toArray();

  return results[0]?.name ?? null;
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
