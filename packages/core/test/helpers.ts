import { LatLng, TrackPoint } from '../src/geo';

export const ORIGIN: LatLng = { lat: 13.05, lng: 80.25 }; // Chennai-ish
const M_PER_DEG_LAT = 111320;
const mPerDegLng = (lat: number) => 111320 * Math.cos((lat * Math.PI) / 180);

export function offsetM(o: LatLng, eastM: number, northM: number): LatLng {
  return { lat: o.lat + northM / M_PER_DEG_LAT, lng: o.lng + eastM / mPerDegLng(o.lat) };
}

export interface GenOpts { speedMs?: number; hz?: number; startT?: number; jitterM?: number }

/** Attach timestamps/accuracy to a geometric path at constant speed. */
export function toTrack(path: LatLng[], opts: GenOpts = {}): TrackPoint[] {
  const { speedMs = 3, startT = 1_750_000_000_000, jitterM = 0 } = opts;
  let t = startT, d = 0;
  const out: TrackPoint[] = [];
  for (let i = 0; i < path.length; i++) {
    if (i > 0) {
      const dx = Math.hypot(
        (path[i].lat - path[i - 1].lat) * M_PER_DEG_LAT,
        (path[i].lng - path[i - 1].lng) * mPerDegLng(path[i].lat),
      );
      d = dx; t += (dx / speedMs) * 1000;
    }
    const j = jitterM ? (Math.sin(i * 12.9898) * jitterM) : 0; // deterministic jitter
    out.push({ ...offsetM(path[i], j, -j), t: Math.round(t), acc: 8 });
  }
  void d;
  return out;
}

export function straightPath(km: number, stepM = 20, o = ORIGIN): LatLng[] {
  const n = Math.round((km * 1000) / stepM);
  return Array.from({ length: n + 1 }, (_, i) => offsetM(o, 0, i * stepM));
}

/** Circle of radius r; closeGapM > 0 leaves the ring open by that many meters. */
export function circlePath(radiusM: number, closeGapM = 0, o = ORIGIN): LatLng[] {
  const c = 2 * Math.PI * radiusM;
  const n = Math.max(24, Math.round(c / 20));
  const endA = 2 * Math.PI * (1 - closeGapM / c);
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = (i / n) * endA;
    return offsetM(o, radiusM * Math.cos(a), radiusM * Math.sin(a));
  });
}

/** Two overlapping circles traversed in sequence — guarantees genuine path self-crossings. */
export function figureEight(radiusM: number, o = ORIGIN): LatLng[] {
  const a = circlePath(radiusM, 0, o);
  const b = circlePath(radiusM, 0, offsetM(o, 0, 1.4 * radiusM));
  return [...a, ...b];
}

export function withTeleport(track: TrackPoint[], atIndex: number, jumpM = 2000): TrackPoint[] {
  return track.map((p, i) => (i >= atIndex ? { ...p, ...offsetM(p, jumpM, 0) } : p));
}

export function assertLog(name: string, extra = '') {
  console.log(`✓ ${name}${extra ? ' — ' + extra : ''}`);
}
