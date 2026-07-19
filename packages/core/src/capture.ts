/**
 * RUNVERSE capture engine — converts a validated GPS track into an ordered,
 * budget-capped set of H3 res-9 cells.
 *
 * Identical code runs server-side (authoritative, in the ingest pipeline) and
 * client-side (optimistic preview during a run). Server results always win.
 *
 * Pipeline: simplify → corridor cells → loop detection → interior polyfill →
 * budget cap (corridor first, then interior nearest-to-path).
 */
import {
  latLngToCell,
  polygonToCells,
  cellToLatLng,
} from 'h3-js';
import {
  LatLng,
  haversineM,
  pathLengthM,
  resample,
  segIntersect,
  simplify,
} from './geo';
import { TUNING } from './constants';

export type CaptureKind = 'corridor' | 'interior';

export interface CaptureResult {
  /** Ordered cells (corridor in path order, then interior nearest-to-path), capped at budget. */
  cells: Array<{ h3: string; kind: CaptureKind }>;
  /** Budget = f(distance); what the cap was. */
  budget: number;
  /** Cells found before capping (for telemetry/tuning). */
  uncappedCount: number;
  /** Closed rings detected (each is a polygon of LatLng). */
  loops: LatLng[][];
  distanceM: number;
}

/** Capture budget: TUNING.CAPTURE_BUDGET_PER_KM cells per km, floor 1-cell minimum for any valid activity. */
export function captureBudget(distanceM: number, multiplier = 1): number {
  return Math.max(1, Math.floor((distanceM / 1000) * TUNING.CAPTURE_BUDGET_PER_KM * multiplier));
}

/**
 * Corridor cells: cells touched by the path, sampled densely enough that no
 * cell along the route is skipped (sample step << res-9 edge length ~174 m).
 * Ordered by first touch along the path; deduplicated.
 */
export function corridorCells(path: LatLng[], res = TUNING.H3_RES): string[] {
  const dense = resample(path, TUNING.CORRIDOR_SAMPLE_M);
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const p of dense) {
    const c = latLngToCell(p.lat, p.lng, res);
    if (!seen.has(c)) {
      seen.add(c);
      ordered.push(c);
    }
  }
  return ordered;
}

/**
 * Loop detection. Two mechanisms:
 *  1. Endpoint closure: start and end within LOOP_ENDPOINT_M → whole path is a ring.
 *  2. Self-intersection: any two non-adjacent segments intersect → the sub-path
 *     between them (closed at the intersection point) is a ring.
 * Rings below LOOP_MIN_PERIMETER_M are ignored (GPS jitter, tight turnarounds).
 */
export function detectLoops(path: LatLng[]): LatLng[][] {
  const loops: LatLng[][] = [];
  if (path.length < 4) return loops;

  // 1. Endpoint closure
  if (haversineM(path[0], path[path.length - 1]) <= TUNING.LOOP_ENDPOINT_M) {
    if (pathLengthM(path) >= TUNING.LOOP_MIN_PERIMETER_M) {
      loops.push([...path, path[0]]);
    }
  }

  // 2. Self-intersections (on the simplified path, so O(n^2) is cheap)
  for (let i = 0; i < path.length - 1; i++) {
    // start j at i+2: adjacent segments always share a point, not a crossing
    for (let j = i + 2; j < path.length - 1; j++) {
      const x = segIntersect(path[i], path[i + 1], path[j], path[j + 1]);
      if (!x) continue;
      const ring = [x, ...path.slice(i + 1, j + 1), x];
      if (pathLengthM(ring) >= TUNING.LOOP_MIN_PERIMETER_M) loops.push(ring);
    }
  }
  return loops;
}

/** Interior cells of a ring via H3 polyfill, excluding cells already in `exclude`. */
export function interiorCells(
  ring: LatLng[],
  exclude: Set<string>,
  res = TUNING.H3_RES,
): string[] {
  const poly = ring.map((p) => [p.lat, p.lng]);
  let cells: string[];
  try {
    cells = polygonToCells(poly, res);
  } catch {
    return []; // degenerate ring — corridor capture still applies
  }
  return cells.filter((c) => !exclude.has(c));
}

/**
 * Full capture computation.
 * @param rawPath cleaned GPS points (already accuracy-filtered by validation)
 * @param budgetMultiplier 1.0 live GPS, 0.5 imports (ADR-007)
 */
export function computeCapture(rawPath: LatLng[], budgetMultiplier = 1): CaptureResult {
  const distanceM = pathLengthM(rawPath);
  const budget = captureBudget(distanceM, budgetMultiplier);
  const path = simplify(rawPath, TUNING.SIMPLIFY_EPSILON_M);

  const corridor = corridorCells(path);
  const corridorSet = new Set(corridor);

  const loops = detectLoops(path);
  const interiorSet = new Set<string>();
  for (const ring of loops) {
    for (const c of interiorCells(ring, corridorSet)) interiorSet.add(c);
  }

  // Rank interior by proximity to the path: reward the runner nearest their route
  // first when the budget can't cover a huge enclosed area.
  const anchor = resample(path, 100);
  const interior = [...interiorSet]
    .map((h3) => {
      const [lat, lng] = cellToLatLng(h3);
      let best = Infinity;
      for (const a of anchor) {
        const d = haversineM({ lat, lng }, a);
        if (d < best) best = d;
      }
      return { h3, d: best };
    })
    .sort((a, b) => a.d - b.d)
    .map((x) => x.h3);

  const uncappedCount = corridor.length + interior.length;
  const cells: CaptureResult['cells'] = [];
  for (const h3 of corridor) {
    if (cells.length >= budget) break;
    cells.push({ h3, kind: 'corridor' });
  }
  for (const h3 of interior) {
    if (cells.length >= budget) break;
    cells.push({ h3, kind: 'interior' });
  }

  return { cells, budget, uncappedCount, loops, distanceM };
}
