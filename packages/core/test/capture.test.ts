import assert from 'node:assert';
import { computeCapture, captureBudget } from '../src/capture';
import { pathLengthM } from '../src/geo';
import { straightPath, circlePath, figureEight, assertLog } from './helpers';

// 1. Straight 5k: corridor only, no loops, within budget
{
  const r = computeCapture(straightPath(5));
  assert.strictEqual(r.loops.length, 0);
  assert.ok(r.cells.every((c) => c.kind === 'corridor'));
  assert.strictEqual(r.budget, captureBudget(r.distanceM));
  assert.ok(r.cells.length >= 15 && r.cells.length <= 45, `got ${r.cells.length}`);
  assert.ok(r.cells.length <= r.budget);
  assertLog('straight 5k', `${r.cells.length} corridor cells, budget ${r.budget}`);
}

// 2. Densification: sparse sampling must not skip cells
{
  const dense = computeCapture(straightPath(2, 20));
  const sparse = computeCapture(straightPath(2, 180)); // one point per hex-ish
  assert.deepStrictEqual(
    new Set(sparse.cells.map((c) => c.h3)),
    new Set(dense.cells.map((c) => c.h3)),
    'sparse and dense sampling of same line must capture same cells',
  );
  assertLog('densification', `${sparse.cells.length} cells match at 20m and 180m sampling`);
}

// 3. Endpoint-closed loop: interior polyfill fires
{
  const r = computeCapture(circlePath(400, 40)); // 40m gap < 60m threshold
  assert.ok(r.loops.length >= 1, 'loop must close');
  const interior = r.cells.filter((c) => c.kind === 'interior').length;
  assert.ok(interior > 0, `expected interior cells, got ${interior}`);
  assert.ok(r.cells.length <= r.budget);
  assertLog('closed loop r=400m', `${r.cells.length} cells (${interior} interior), budget ${r.budget}`);
}

// 4. Open horseshoe (300m gap): not a loop
{
  const r = computeCapture(circlePath(400, 300));
  assert.strictEqual(r.loops.length, 0);
  assert.ok(r.cells.every((c) => c.kind === 'corridor'));
  assertLog('open horseshoe', 'no loop detected');
}

// 5. Budget abuse: big enclosure capped; corridor awarded before interior
{
  const r = computeCapture(circlePath(3000, 30)); // ~18.8km enclosing ~28 km² — beyond the bind point
  assert.ok(r.uncappedCount > r.budget, `${r.uncappedCount} !> ${r.budget}`);
  assert.strictEqual(r.cells.length, r.budget);
  const lastCorr = r.cells.map((c) => c.kind).lastIndexOf('corridor');
  const firstInt = r.cells.findIndex((c) => c.kind === 'interior');
  assert.ok(firstInt === -1 || firstInt > lastCorr, 'corridor before interior');
  assertLog('budget cap', `enclosure ${r.uncappedCount} → awarded ${r.budget}`);
}

// 6. Import multiplier (ADR-007)
{
  const t = circlePath(3000, 30);
  const live = computeCapture(t, 1), imp = computeCapture(t, 0.5);
  assert.ok(Math.abs(imp.budget - Math.floor(live.budget / 2)) <= 1);
  assertLog('import multiplier', `live ${live.budget} → import ${imp.budget}`);
}

// 7. Figure-8: self-intersection loops without endpoint closure
{
  const r = computeCapture(figureEight(700));
  assert.ok(r.loops.length >= 1, `figure-8 loops: ${r.loops.length}`);
  assert.ok(r.cells.some((c) => c.kind === 'interior'));
  assertLog('figure-8', `${r.loops.length} loop(s) via self-intersection`);
}

// 8. Determinism (client preview must equal server result)
{
  const t = circlePath(500, 20);
  assert.deepStrictEqual(computeCapture(t).cells, computeCapture(t).cells);
  assertLog('determinism');
}

// 9. Jitter ring < 400m perimeter ignored
{
  const t = [...straightPath(1), ...circlePath(30, 5, { lat: 13.059, lng: 80.25 })];
  const r = computeCapture(t);
  for (const l of r.loops) assert.ok(pathLengthM(l) >= 400);
  assertLog('jitter ring filtered', `${r.loops.length} loops kept`);
}

console.log('\ncapture: all tests passed');
