/**
 * Geo primitives shared by client (optimistic preview) and server (authoritative).
 * All distances in meters, speeds in m/s, timestamps in epoch ms.
 */

export interface TrackPoint {
  /** epoch ms */
  t: number;
  lat: number;
  lng: number;
  /** altitude, meters (optional) */
  alt?: number;
  /** GPS horizontal accuracy, meters */
  acc?: number;
  /** heart rate bpm */
  hr?: number;
  /** cadence, steps per minute */
  cad?: number;
}

export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_R = 6371008.8; // mean earth radius, meters
const DEG = Math.PI / 180;

/** Great-circle distance in meters. */
export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLng = (b.lng - a.lng) * DEG;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Total path length in meters. */
export function pathLengthM(pts: LatLng[]): number {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += haversineM(pts[i - 1], pts[i]);
  return d;
}

/**
 * Project to a local equirectangular plane (meters) around an origin.
 * Valid for activity-scale extents (< ~50 km); used for simplification
 * and segment-intersection math where planar geometry is fine.
 */
export function toLocalXY(origin: LatLng, p: LatLng): { x: number; y: number } {
  const x = (p.lng - origin.lng) * DEG * EARTH_R * Math.cos(origin.lat * DEG);
  const y = (p.lat - origin.lat) * DEG * EARTH_R;
  return { x, y };
}

/** Linear interpolation between two coordinates (fine at activity scale). */
export function lerp(a: LatLng, b: LatLng, f: number): LatLng {
  return { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f };
}

/**
 * Insert intermediate points so consecutive points are at most `stepM` apart.
 * Guarantees the corridor capture cannot "skip" an H3 cell on long segments.
 */
export function densify(pts: LatLng[], stepM: number): LatLng[] {
  if (pts.length < 2) return [...pts];
  const out: LatLng[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const d = haversineM(pts[i - 1], pts[i]);
    const n = Math.floor(d / stepM);
    for (let k = 1; k <= n; k++) out.push(lerp(pts[i - 1], pts[i], k / (n + 1)));
    out.push(pts[i]);
  }
  return out;
}

/**
 * Douglas–Peucker simplification with a metric epsilon.
 * Works in the local plane; epsilon ≈ 8 m removes GPS jitter while
 * preserving loop topology.
 */
export function simplify(pts: LatLng[], epsilonM: number): LatLng[] {
  if (pts.length <= 2) return [...pts];
  const origin = pts[0];
  const xy = pts.map((p) => toLocalXY(origin, p));

  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;

  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const ax = xy[s], bx = xy[e];
    const dx = bx.x - ax.x, dy = bx.y - ax.y;
    const len2 = dx * dx + dy * dy;
    let maxD = -1, maxI = -1;
    for (let i = s + 1; i < e; i++) {
      let d: number;
      if (len2 === 0) {
        d = Math.hypot(xy[i].x - ax.x, xy[i].y - ax.y);
      } else {
        const t = Math.max(0, Math.min(1, ((xy[i].x - ax.x) * dx + (xy[i].y - ax.y) * dy) / len2));
        d = Math.hypot(xy[i].x - (ax.x + t * dx), xy[i].y - (ax.y + t * dy));
      }
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > epsilonM) {
      keep[maxI] = 1;
      stack.push([s, maxI], [maxI, e]);
    }
  }
  return pts.filter((_, i) => keep[i] === 1);
}

/**
 * 2D segment intersection in the local plane.
 * Returns intersection point as a fraction along segment 1, or null.
 */
export function segmentIntersection(
  p1: { x: number; y: number }, p2: { x: number; y: number },
  p3: { x: number; y: number }, p4: { x: number; y: number },
): { x: number; y: number } | null {
  const d1x = p2.x - p1.x, d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x, d2y = p4.y - p3.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-12) return null; // parallel
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
  const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denom;
  if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return null;
  return { x: p1.x + t * d1x, y: p1.y + t * d1y };
}
