/** Geometric primitives shared by server (authoritative) and client (preview). Pure, deterministic. */

export interface LatLng {
  lat: number;
  lng: number;
}

export interface TrackPoint extends LatLng {
  /** epoch ms */
  t: number;
  /** altitude, m (optional) */
  alt?: number;
  /** reported horizontal accuracy, m */
  acc?: number;
  /** heart rate bpm */
  hr?: number;
  /** cadence, steps per minute */
  cad?: number;
}

const R_EARTH_M = 6371008.8;
const DEG = Math.PI / 180;

/** Great-circle distance in meters. */
export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLng = (b.lng - a.lng) * DEG;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.sqrt(s));
}

/** Total path length in meters. */
export function pathLengthM(points: LatLng[]): number {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += haversineM(points[i - 1], points[i]);
  return d;
}

/**
 * Perpendicular distance (meters) from point p to segment [a,b],
 * using a local equirectangular projection (fine at segment scale).
 */
function pointSegDistM(p: LatLng, a: LatLng, b: LatLng): number {
  const cosLat = Math.cos(((a.lat + b.lat) / 2) * DEG);
  const ax = a.lng * cosLat, ay = a.lat;
  const bx = b.lng * cosLat, by = b.lat;
  const px = p.lng * cosLat, py = p.lat;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let qx = ax, qy = ay;
  if (len2 > 0) {
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    qx = ax + t * dx;
    qy = ay + t * dy;
  }
  // degrees -> meters
  const ddx = (px - qx) * 111320;
  const ddy = (py - qy) * 111320;
  return Math.hypot(ddx, ddy);
}

/** Douglas–Peucker simplification with tolerance in meters. Preserves endpoints. */
export function simplify<T extends LatLng>(points: T[], epsilonM = 8): T[] {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    let maxD = 0, maxI = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = pointSegDistM(points[i], points[lo], points[hi]);
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > epsilonM && maxI > 0) {
      keep[maxI] = 1;
      stack.push([lo, maxI], [maxI, hi]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

/** Resample a path so consecutive points are at most stepM apart (linear interpolation). */
export function resample(points: LatLng[], stepM = 50): LatLng[] {
  if (points.length < 2) return points.slice();
  const out: LatLng[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const d = haversineM(a, b);
    const n = Math.floor(d / stepM);
    for (let k = 1; k <= n; k++) {
      const t = (k * stepM) / d;
      out.push({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });
    }
    out.push(b);
  }
  return out;
}

/** 2D segment intersection test in a local projection. Returns intersection point or null. */
export function segIntersect(a1: LatLng, a2: LatLng, b1: LatLng, b2: LatLng): LatLng | null {
  const cosLat = Math.cos(a1.lat * DEG);
  const x1 = a1.lng * cosLat, y1 = a1.lat;
  const x2 = a2.lng * cosLat, y2 = a2.lat;
  const x3 = b1.lng * cosLat, y3 = b1.lat;
  const x4 = b2.lng * cosLat, y4 = b2.lat;
  const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(den) < 1e-15) return null;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
  const u = ((x1 - x3) * (y1 - y2) - (y1 - y3) * (x1 - x2)) / den;
  if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return null;
  return { lat: y1 + t * (y2 - y1), lng: (x1 + t * (x2 - x1)) / cosLat };
}
