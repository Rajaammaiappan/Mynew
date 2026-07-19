import { latLngToCell, polygonToCells, cellToLatLng } from 'h3-js';
import {
  LatLng, TrackPoint, densify, simplify, pathLengthM, haversineM,
} from '../geo/geometry.js';
import { detectRings, DEFAULT_LOOP_OPTS, LoopOptions, Ring } from './loop.js';

export const H3_RES = 9;

export interface CaptureOptions {
  h3Res: number;
  /** simplification epsilon, meters */
  simplifyEpsM: number;         // 8
  /** densification step — must be < res-9 edge (~174m) to never skip a cell */
  densifyStepM: number;         // 50
  /** capture budget per km */
  budgetPerKm: number;          // 25
  /** multiplier for non-live sources (imports/syncs) — ADR-007 */
  sourceRateMultiplier: number; // 1.0 live, 0.5 import
  loop: LoopOptions;
}

export const DEFAULT_CAPTURE_OPTS: CaptureOptions = {
  h3Res: H3_RES,
  simplifyEpsM: 8,
  densifyStepM: 50,
  budgetPerKm: 25,
  sourceRateMultiplier: 1.0,
  loop: DEFAULT_LOOP_OPTS,
};

export interface CaptureResult {
  /** cells physically traversed, in path order (dedup, first-visit order) */
  corridor: string[];
  /** cells enclosed by rings, not traversed */
  interior: string[];
  /** final awarded set after budget: corridor first, then interior by proximity */
  awarded: string[];
  budget: number;
  truncated: boolean;
  distanceM: number;
  rings: Ring[];
}

/**
 * Authoritative capture computation. Pure function of the track — the client
 * runs the identical code for optimistic preview; only server results count.
 *
 * Guarantees:
 *  - Deterministic: same track ⇒ same awarded set, same order.
 *  - Budget-bounded: |awarded| ≤ budgetPerKm × km × sourceRate (ADR-005).
 *  - Corridor-first: enclosed "free" hexes never displace hexes you actually ran.
 */
export function computeCapture(
  points: Pick<TrackPoint, 'lat' | 'lng'>[],
  opts: CaptureOptions = DEFAULT_CAPTURE_OPTS,
): CaptureResult {
  const raw: LatLng[] = points.map((p) => ({ lat: p.lat, lng: p.lng }));
  const distanceM = pathLengthM(raw);

  const simplified = simplify(raw, opts.simplifyEpsM);
  const dense = densify(simplified, opts.densifyStepM);

  // --- corridor: every cell the path touches, first-visit order ---
  const corridorSet = new Set<string>();
  const corridor: string[] = [];
  for (const p of dense) {
    const cell = latLngToCell(p.lat, p.lng, opts.h3Res);
    if (!corridorSet.has(cell)) {
      corridorSet.add(cell);
      corridor.push(cell);
    }
  }

  // --- rings → interior polyfill ---
  const rings = detectRings(simplified, opts.loop);
  const interiorSet = new Set<string>();
  for (const ring of rings) {
    const poly = ring.points.map((p) => [p.lat, p.lng]);
    for (const cell of polygonToCells(poly, opts.h3Res)) {
      if (!corridorSet.has(cell)) interiorSet.add(cell);
    }
  }

  // --- interior ordering: nearest-to-corridor first (fair truncation) ---
  const corridorCenters = corridor.map((c) => {
    const [lat, lng] = cellToLatLng(c);
    return { lat, lng };
  });
  const interior = [...interiorSet];
  if (interior.length > 0 && corridorCenters.length > 0) {
    // Sample corridor centers if huge to keep this O(n·m) bounded
    const sample = corridorCenters.length > 200
      ? corridorCenters.filter((_, i) => i % Math.ceil(corridorCenters.length / 200) === 0)
      : corridorCenters;
    const dist = new Map<string, number>();
    for (const cell of interior) {
      const [lat, lng] = cellToLatLng(cell);
      let best = Infinity;
      for (const cc of sample) {
        const d = haversineM({ lat, lng }, cc);
        if (d < best) best = d;
      }
      dist.set(cell, best);
    }
    interior.sort((a, b) => dist.get(a)! - dist.get(b)! || (a < b ? -1 : 1));
  }

  // --- budget ---
  const budget = Math.max(
    0,
    Math.floor((distanceM / 1000) * opts.budgetPerKm * opts.sourceRateMultiplier),
  );
  const awarded = [...corridor, ...interior].slice(0, budget);

  return {
    corridor,
    interior,
    awarded,
    budget,
    truncated: corridor.length + interior.length > budget,
    distanceM,
    rings,
  };
}
