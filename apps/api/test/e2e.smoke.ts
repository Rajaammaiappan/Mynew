/**
 * E2E smoke: exercises the full Phase-1 vertical slice against the running API.
 *   auth (OTP) → live session → chunked upload of a closed 2km loop →
 *   finish → ingest pipeline → result → viewport → hex detail → feed → kudos.
 * Also proves the cheat path: a 60 km/h "run" must land in the fraud queue, not on the map.
 */
import assert from 'node:assert';
import { cellToParent, latLngToCell } from 'h3-js';

const API = (process.env.API_URL ?? 'http://localhost:3000') + '/v1';
let otpFromLog = '';
process.on('message', () => {});

async function api(path: string, opts: RequestInit = {}, token?: string) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
  const body = res.status === 204 || res.status === 304 ? null : await res.json().catch(() => null);
  return { status: res.status, body, headers: res.headers };
}

// synthetic closed loop, r=350m near Chennai, 1Hz at 3 m/s (≈12min run compressed)
function loopTrack(lat0 = 13.06, lng0 = 80.27, radiusM = 350) {
  const pts: Array<{ t: number; lat: number; lng: number; acc: number }> = [];
  const mLat = 111320, mLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const circ = 2 * Math.PI * radiusM;
  const n = Math.round(circ / 3); // 3m per second per point
  const t0 = Date.now() - n * 1000;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * 2 * Math.PI * (1 - 20 / circ); // close within 20m
    pts.push({
      t: t0 + i * 1000,
      lat: lat0 + (radiusM * Math.sin(a)) / mLat,
      lng: lng0 + (radiusM * Math.cos(a)) / mLng,
      acc: 8,
    });
  }
  return pts;
}

async function authAs(phone: string) {
  const r1 = await api('/auth/otp/request', { method: 'POST', body: JSON.stringify({ phone_e164: phone }) });
  assert.strictEqual(r1.status, 200, JSON.stringify(r1.body));
  if ((r1.body as any)?.dev_code) {
    otpFromLog = (r1.body as any).dev_code;           // remote-friendly: DEV_OTP_ECHO=true
  } else {                                            // local fallback: read the server log
    const { readFileSync } = await import('node:fs');
    await new Promise((r) => setTimeout(r, 300));
    const log = readFileSync(process.env.API_LOG ?? '/tmp/api.log', 'utf8');
    const m = [...log.matchAll(new RegExp(`\\[dev-otp\\] \\${phone} → (\\d{6})`, 'g'))].pop();
    assert.ok(m, 'OTP not found — set DEV_OTP_ECHO=true on the server or API_LOG locally');
    otpFromLog = m![1];
  }
  const r2 = await api('/auth/otp/verify', {
    method: 'POST',
    body: JSON.stringify({ phone_e164: phone, code: otpFromLog, device: { platform: 'dev' } }),
  });
  assert.strictEqual(r2.status, 200, JSON.stringify(r2.body));
  return r2.body as { access: string; refresh: string; user: { id: string; handle: string } };
}

async function runActivity(token: string, points: ReturnType<typeof loopTrack>, sensors: object) {
  const start = await api('/activities/live/start', {
    method: 'POST',
    body: JSON.stringify({ type: 'run', started_at: new Date(points[0].t).toISOString() }),
  }, token);
  assert.strictEqual(start.status, 201, JSON.stringify(start.body));
  const id = (start.body as any).activity_id as string;

  const CHUNK = 200;
  for (let seq = 0; seq * CHUNK < points.length; seq++) {
    const r = await api(`/activities/live/${id}/chunks`, {
      method: 'POST',
      body: JSON.stringify({ seq, points: points.slice(seq * CHUNK, (seq + 1) * CHUNK), sensors }),
    }, token);
    assert.strictEqual(r.status, 202, JSON.stringify(r.body));
  }
  const fin = await api(`/activities/live/${id}/finish`, {
    method: 'POST',
    body: JSON.stringify({ ended_at: new Date(points[points.length - 1].t).toISOString() }),
  }, token);
  assert.strictEqual(fin.status, 200, JSON.stringify(fin.body));

  // poll pipeline result
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const res = await api(`/activities/${id}/result`, {}, token);
    if ((res.body as any)?.pipeline_stage === 'fanned_out' ||
        ['rejected', 'flagged'].includes((res.body as any)?.status)) {
      return { id, result: res.body as any };
    }
  }
  throw new Error('pipeline did not settle in 10s');
}

(async () => {
  // ── legit runner captures a loop ──────────────────────────────────────────
  const alice = await authAs('+919000000001');
  const track = loopTrack();
  const { id, result } = await runActivity(alice.access, track, { steps: 1200, accelVar: 1.1 });
  assert.strictEqual(result.status, 'validated', JSON.stringify(result));
  assert.ok(result.hexes_claimed >= 5, `expected corridor+interior claims, got ${result.hexes_claimed}`);
  console.log(`✓ legit 2.2km loop validated: ${result.hexes_claimed} hexes claimed`);

  // captures endpoint
  const caps = await api(`/activities/${id}/captures`, {}, alice.access);
  assert.strictEqual(caps.status, 200);
  assert.strictEqual((caps.body as any[]).length, result.hexes_claimed);
  console.log(`✓ capture recap lists ${(caps.body as any[]).length} hexes`);

  // viewport shows ownership, ETag caches
  const r5 = cellToParent(latLngToCell(13.06, 80.27, 9), 5);
  const v1 = await api(`/territory/viewport?cells=${r5}`, {}, alice.access);
  assert.strictEqual(v1.status, 200);
  const mine = (v1.body as any).hexes.filter((h: any) => h.owner.id === alice.user.id);
  assert.strictEqual(mine.length, result.hexes_claimed, 'viewport must show all captured hexes');
  assert.ok(mine.every((h: any) => h.strength_eff === 100));
  const etag = v1.headers.get('etag')!;
  const v2 = await api(`/territory/viewport?cells=${r5}`, { headers: { 'if-none-match': etag } }, alice.access);
  assert.strictEqual(v2.status, 304, 'unchanged viewport must 304');
  console.log(`✓ viewport: ${mine.length} owned hexes visible, ETag 304 works`);

  // hex detail with history
  const hd = await api(`/territory/hex/${mine[0].h3}`, {}, alice.access);
  assert.strictEqual((hd.body as any).state.handle, alice.user.handle);
  assert.strictEqual((hd.body as any).history[0].kind, 'claim');
  console.log('✓ hex drill-down shows owner + claim history');

  // summary + rank title
  const sum = await api('/territory/me/summary', {}, alice.access);
  assert.strictEqual((sum.body as any).hex_count, result.hexes_claimed);
  assert.strictEqual((sum.body as any).rank_title, result.hexes_claimed >= 10 ? 'street_owner' : null);
  console.log(`✓ summary: ${(sum.body as any).hex_count} hexes, title=${(sum.body as any).rank_title}`);

  // ── rival steals: fresh hexes defend, so run bob AFTER simulating decay ──
  const bob = await authAs('+919000000002');
  const fresh = await runActivity(bob.access, loopTrack(13.06, 80.27, 200), { steps: 700, accelVar: 1.0 });
  assert.strictEqual(fresh.result?.status ?? fresh.result.status, 'validated');
  assert.strictEqual(fresh.result.hexes_stolen, 0, 'fresh strength-100 hexes must defend');
  console.log(`✓ defense: bob stole 0 fresh hexes (claimed ${fresh.result.hexes_claimed} neutrals)`);

  // age alice's hexes 8 days → eff 36 < attacker power 50 → stealable
  const { Client } = await import('pg');
  const pg = new Client({ connectionString: 'postgres://runverse:runverse@localhost:5432/runverse' });
  await pg.connect();
  await pg.query(`UPDATE hex_states SET last_refreshed_at = now() - interval '8 days' WHERE owner_user_id=$1`, [alice.user.id]);
  const steal = await runActivity(bob.access, loopTrack(), { steps: 1200, accelVar: 1.1 });
  assert.ok(steal.result.hexes_stolen > 0, `decayed hexes must be stealable, got ${JSON.stringify(steal.result)}`);
  console.log(`✓ conquest: bob stole ${steal.result.hexes_stolen} decayed hexes from alice`);

  // feed + kudos
  await api(`/users/${bob.user.id}/follow`, { method: 'POST' }, alice.access);
  const feed = await api('/feed', {}, alice.access);
  const items = (feed.body as any).items;
  assert.ok(items.some((i: any) => i.handle === bob.user.handle), 'followee activity must appear in feed');
  await api(`/activities/${items[0].id}/kudos`, { method: 'POST' }, alice.access);
  const feed2 = await api('/feed', {}, alice.access);
  assert.strictEqual((feed2.body as any).items[0].kudos_count, 1);
  console.log('✓ feed shows followee runs; kudos counted');

  // ── cheater: 60 km/h "run", dead pedometer → flagged, zero territory ─────
  const mallory = await authAs('+919000000003');
  const fast = loopTrack(13.2, 80.1, 800).map((p, i) => ({ ...p, t: Date.now() - (1000 - i) * 180 })); // ~17 m/s
  const cheat = await runActivity(mallory.access, fast, { steps: 20, accelVar: 0.01 });
  assert.strictEqual(cheat.result.status, 'flagged', JSON.stringify(cheat.result));
  assert.strictEqual(cheat.result.hexes_claimed, 0, 'flagged activity must award nothing');
  const q = await pg.query(`SELECT count(*)::int n FROM fraud_reviews WHERE status='open'`);
  assert.ok(q.rows[0].n >= 1, 'cheat must enter the review queue');
  const t = await pg.query(`SELECT trust_score FROM users WHERE id=$1`, [(mallory.user as any).id]);
  assert.ok(t.rows[0].trust_score < 100, 'trust score must drop');
  console.log(`✓ anti-cheat: vehicle-speed run flagged, 0 hexes, review queued, trust=${t.rows[0].trust_score}`);

  await pg.end();
  console.log('\nE2E smoke: ALL PASSED');
  process.exit(0);
})().catch((e) => { console.error('E2E FAILED:', e); process.exit(1); });
