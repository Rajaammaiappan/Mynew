/** WS smoke: subscribe to a res-5 cell, run an activity, expect territory.delta + activity.result. */
import assert from 'node:assert';
import { cellToParent, latLngToCell } from 'h3-js';

const API = (process.env.API_URL ?? 'http://localhost:3000') + '/v1';
const post = async (p: string, body: object, tok?: string) =>
  (await fetch(API + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: JSON.stringify(body) })).json();

(async () => {
  const req = await post('/auth/otp/request', { phone_e164: '+919000000009' });
  let code: string;
  if (req.dev_code) code = req.dev_code;
  else {
    await new Promise((r) => setTimeout(r, 300));
    const log = (await import('node:fs')).readFileSync(process.env.API_LOG ?? '/tmp/api.log', 'utf8');
    code = [...log.matchAll(/\[dev-otp\] \+919000000009 → (\d{6})/g)].pop()![1];
  }
  const auth = await post('/auth/otp/verify', { phone_e164: '+919000000009', code, device: { platform: 'dev' } });

  const lat = 13.2, lng = 80.35;
  const r5 = cellToParent(latLngToCell(lat, lng, 9), 5);
  const wsBase = (process.env.API_URL ?? 'http://localhost:3000').replace(/^http/, 'ws');
  const ws = new WebSocket(`${wsBase}/rt?token=${auth.access}`);
  const events: any[] = [];
  ws.onmessage = (m) => events.push(JSON.parse(String(m.data)));
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.send(JSON.stringify({ type: 'subscribe', cells_r5: [r5] }));
  await new Promise((r) => setTimeout(r, 200));

  // run a small loop inside that cell
  const pts: any[] = [];
  const mLat = 111320, mLng = 111320 * Math.cos((lat * Math.PI) / 180);
  const n = Math.round((2 * Math.PI * 300) / 3);
  const t0 = Date.now() - n * 1000;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * 2 * Math.PI * 0.99;
    pts.push({ t: t0 + i * 1000, lat: lat + (300 * Math.sin(a)) / mLat, lng: lng + (300 * Math.cos(a)) / mLng, acc: 8 });
  }
  const { activity_id } = await post('/activities/live/start', { type: 'run', started_at: new Date(t0).toISOString() }, auth.access);
  for (let s = 0; s * 200 < pts.length; s++) {
    await post(`/activities/live/${activity_id}/chunks`, { seq: s, points: pts.slice(s * 200, (s + 1) * 200), sensors: { steps: 900, accelVar: 1.1 } }, auth.access);
  }
  await post(`/activities/live/${activity_id}/finish`, { ended_at: new Date(pts[pts.length - 1].t).toISOString() }, auth.access);

  await new Promise((r) => setTimeout(r, 4000));
  const hello = events.find((e) => e.type === 'hello');
  const delta = events.find((e) => e.type === 'territory.delta' && e.cell_r5 === r5);
  const result = events.find((e) => e.type === 'activity.result' && e.activity_id === activity_id);
  assert.ok(hello, 'hello frame');
  assert.ok(delta, `territory.delta for ${r5}; got ${events.map((e) => e.type).join(',')}`);
  assert.ok(delta.changes.length > 0 && delta.changes[0].owner.color, 'delta carries owner render info');
  assert.ok(result && (result.hexes_claimed + (result.hexes_refreshed ?? 0)) > 0, 'personal activity.result frame');
  console.log(`✓ WS live map: hello + territory.delta (${delta.changes.length} hexes) + activity.result (${result.hexes_claimed} claimed)`);
  ws.close();
  process.exit(0);
})().catch((e) => { console.error('WS FAILED:', e.message); process.exit(1); });
