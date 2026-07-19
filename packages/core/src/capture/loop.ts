import {
  LatLng, haversineM, pathLengthM, toLocalXY, segmentIntersection,
} from '../geo/geometry.js';

export interface Ring {
  /** closed polygon (first point ≠ last; closure implied) */
  points: LatLng[];
  perimeterM: number;
  kind: 'endpoint_closure' | 'self_intersection';
}

export interface LoopOptions {
  /** start/end within this distance ⇒ the whole path is a ring */
  endpointToleranceM: number;   // default 60
  /** rings smaller than this are noise (GPS jitter circles) */
  minPerimeterM: number;        // default 400
  /** cap rings per activity (abuse guard: figure-eight spam) */
  maxRings: number;             // default 5
}

export const DEFAULT_LOOP_OPTS: LoopOptions = {
  endpointToleranceM: 60,
  minPerimeterM: 400,
  maxRings: 5,
};

/**
 * Detect closed rings in a *simplified* path.
 *
 * Two mechanisms, mirroring how real runs close loops:
 *  1. Endpoint closure — you finished (nearly) where you started.
 *  2. Self-intersection — the path crossed itself mid-run (e.g. a lasso
 *     shape: run out, loop a park, run back). Each crossing yields a ring.
 *
 * Rings shorter than minPerimeterM are discarded: GPS jitter at a stoplight
 * must never mint a polygon.
 */
export function detectRings(path: LatLng[], opts: LoopOptions = DEFAULT_LOOP_OPTS): Ring[] {
  if (path.length < 4) return [];
  const rings: Ring[] = [];

  // 1. Endpoint closure
  if (haversineM(path[0], path[path.length - 1]) <= opts.endpointToleranceM) {
    const perimeter = pathLengthM(path) + haversineM(path[path.length - 1], path[0]);
    if (perimeter >= opts.minPerimeterM) {
      rings.push({ points: [...path], perimeterM: perimeter, kind: 'endpoint_closure' });
    }
  }

  // 2. Self-intersections (planar scan on the simplified path — O(n²) is fine
  //    post-simplification; a marathon simplifies to a few hundred vertices)
  const origin = path[0];
  const xy = path.map((p) => toLocalXY(origin, p));
  const claimed = new Uint8Array(path.length); // avoid nested duplicate rings

  outer:
  for (let i = 0; i < path.length - 3 && rings.length < opts.maxRings; i++) {
    if (claimed[i]) continue;
    for (let j = i + 2; j < path.length - 1; j++) {
      // skip adjacent segments and the trivial start/end adjacency
      if (i === 0 && j === path.length - 2) continue;
      const hit = segmentIntersection(xy[i], xy[i + 1], xy[j], xy[j + 1]);
      if (!hit) continue;

      const ringPts = path.slice(i + 1, j + 1);
      if (ringPts.length < 3) continue;
      const perimeter = pathLengthM(ringPts) + haversineM(ringPts[ringPts.length - 1], ringPts[0]);
      if (perimeter < opts.minPerimeterM) continue;

      rings.push({ points: ringPts, perimeterM: perimeter, kind: 'self_intersection' });
      for (let k = i; k <= j; k++) claimed[k] = 1;
      continue outer;
    }
  }

  return rings;
}
