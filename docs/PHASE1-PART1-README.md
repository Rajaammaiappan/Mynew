# RUNVERSE — Phase 1, Part 1: Backend Core

**Status:** ✅ Built and verified end-to-end in a live environment (PostgreSQL 16 + PostGIS + Redis).
**Scope of this part:** monorepo scaffold, shared capture engine, migrations, and the API vertical slice — auth → live GPS recording → validation → hex capture → live map deltas → feed. **Part 2 delivers the React Native client.**

---

## What is verified working (not just written)

The repo ships two executable proof suites that were run against real infrastructure:

**Unit — capture engine & validator** (`packages/core/test/`, 16 assertions)
Corridor capture on straight runs; densification invariance (sparse GPS sampling captures identical cells to dense); endpoint loop-closure with interior polyfill; open horseshoes correctly *not* closing; budget capping on oversized enclosures with corridor-before-interior ordering; the 0.5× import multiplier; figure-8 self-intersection rings; determinism (client preview ≡ server result); sub-400 m jitter-ring rejection; physics validation (teleport, sustained overspeed, dead-pedometer, non-monotonic time, minimum duration); decay math and claim/refresh/steal/defended resolution.

**E2E — full vertical slice** (`apps/api/test/e2e.smoke.ts`, `ws.smoke.ts`)
OTP auth with rotating refresh tokens → live session → chunked point upload → finish → async pipeline → **7 hexes claimed from a 2.2 km closed loop** → capture recap → viewport query with working ETag/304 → hex drill-down with event history → *fresh hexes successfully defend against a rival* → *8-day-decayed hexes successfully stolen* → feed shows followee runs with kudos counts → **a 60 km/h "run" with a dead pedometer is flagged, awards zero territory, enters the fraud review queue, and drops the cheater's trust score**. The WS smoke proves a subscribed viewport receives `territory.delta` frames in real time as the pipeline lands captures.

## Bugs found & fixed by testing (why we test)

1. **Capture budget was tuned uselessly.** The isoperimetric inequality means a path of length L km can enclose at most ~0.76·L² res-9 hexes, so the planned 25/km budget never bound below 33 km activities. Retuned to **10 hexes/km** (binds from ~13 km loops; meaningfully caps cycling/ultra enclosures). ADR-005 constant updated.
2. **WS subscribe race.** Clients that subscribe immediately on socket-open lost the frame while the gateway awaited JWT verification. Fixed with a synchronous early-message buffer replayed post-auth.
3. **PG parameter type deduction** failure on reused params in the pipeline's summary UPDATE (explicit `::int` casts).
4. **Nest + tsx incompatibility**: esbuild doesn't emit decorator metadata, silently breaking DI. Dev flow runs compiled `dist` (same as prod).

## Repo layout

```
runverse/
├── packages/core/            # shared domain logic (TESTED) — runs on server AND client
│   ├── src/geo.ts            #   haversine, Douglas-Peucker, resampling, segment intersection
│   ├── src/capture.ts        #   corridor + loop closure + polyfill + budget (the game's heart)
│   ├── src/physics.ts        #   stage-1 validation: kinematics + sensor cross-checks
│   ├── src/decay.ts          #   effectiveStrength, claim/refresh/steal/defended resolution
│   ├── src/constants.ts      #   canonical tuning table (single source, client & server)
│   └── test/                 #   capture.test.ts, physics.test.ts (run: npm test)
├── apps/api/                 # NestJS modular monolith (TYPECHECKED + E2E TESTED)
│   ├── src/auth/             #   OTP (dev provider) + JWT + device-bound rotating refresh
│   ├── src/users/            #   me, profiles, privacy zones (PostGIS circles)
│   ├── src/activities/       #   live sessions, Redis chunk buffer, finish→enqueue, feed
│   ├── src/pipeline/         #   BullMQ ingest worker (validate→capture→fanout), decay cron
│   ├── src/territory/        #   viewport (ETag), summary+rank title, hex drill-down
│   ├── src/realtime/         #   res-5-sharded WS gateway + Redis pub/sub broadcaster
│   ├── src/social/           #   follows, kudos, comments
│   ├── src/db/               #   pg pool, tx helper, migration runner
│   └── test/                 #   e2e.smoke.ts, ws.smoke.ts
├── migrations/0001_init.sql  # Phase-1 schema (identity, activities, territory, social, anti-cheat)
└── docs/                     # Phase 0 document set
```

## Running locally

```bash
# prerequisites: Node 22, PostgreSQL 16 + postgis, Redis
createuser runverse -s && createdb runverse -O runverse   # or match DATABASE_URL
npm install
npm run build -w @runverse/core
npm run migrate -w @runverse/api
npm run dev -w @runverse/api          # builds & starts on :3000; dev OTP codes print to stdout

# proof suites
npm test -w @runverse/core            # capture engine + physics units
npx tsx apps/api/test/e2e.smoke.ts    # full vertical slice (server must be running)
npx tsx apps/api/test/ws.smoke.ts     # live map deltas
```

Env vars: `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET` (required in prod), `STREAM_DIR`/`STREAM_BUCKET`, `PORT`.

## Deliberate Phase-1 simplifications (tracked, not forgotten)

- **Attacker power is flat 50** — building perks & streak bonuses modify it in Phase 2.
- **Stage 3 (resources)** is a pipeline no-op hook until Phase 2's economy tables land.
- **h3-pg optional in dev**: Phase 1 computes H3 in the worker; in-database H3 starts with Phase-2 rollups. `activities/captures` has a `to_hex` fallback.
- **Rank titles** stop at Area Captain — Governor+ need res-7 plurality rollups (Phase 2).
- **Privacy-zone clipping** is schema-ready but enforcement lands with the mobile client (Part 2), where zone UX lives; flag `privacy_clipped` is already on activities.
- **`packages/contracts`** (zod→OpenAPI) extracts from controllers when the mobile client needs shared types in Part 2.
- **Dev OTP provider** logs codes; SMS gateway is an interface swap.
- **S3 stream store** is a local-FS adapter behind the prod interface.

## Store-policy flags touched this part

Background location isn't in scope yet (server-side only), but the API contract already enforces the pattern App Review expects: recording sessions are explicit start/finish, nothing tracks outside them.


---

## Phase 1, Part 2 — Mobile app (apps/mobile)

Expo (SDK 53) + MapLibre GL (token-free dark map) + expo-location. **Typechecked and Metro-bundled to Hermes bytecode (2.31 MB) with zero errors** — the exact JS compilation an APK build performs. Screens: Login (server URL + phone, dev-OTP autofill) · World (live hex map over WebSocket, run HUD with distance/time/pace, Start→Finish & Capture) · Feed (kudos) · Empire (hex count, decay-at-risk, rank title, logout).

### Building the Android APK (≈15 min, free)

APK compilation needs Android build infrastructure; Expo's EAS cloud does it from your machine:

```bash
cd apps/mobile
npm install
npm install -g eas-cli
eas login                      # free account at expo.dev
eas build --platform android --profile preview
```

EAS prints a URL; when the build finishes (~10–15 min) it gives a QR code / download link for the **.apk** — install it directly on any Android phone (allow "install from unknown sources"). iOS needs an Apple Developer account ($99/yr) — use `--platform ios --profile preview` for a simulator build or TestFlight.

First launch: enter your API server URL (your Render URL or `http://<laptop-LAN-IP>:3000` while on the same Wi-Fi), phone number → the dev OTP autofills → Start Run.

### v1 tracking model (deliberate)

The APK records via foreground GPS watch with keep-awake — screen stays on during a run (like early Strava). This sidesteps Android's background-location review for a test build. The production tracking core (foreground service notification, background survival, SQLite crash recovery, adaptive battery sampling) is the next hardening pass and the app.json permissions are already declared for it.

### Zero-build phone testing

A deployed API now serves the visual tester at **`https://your-api/client`** — open it on your phone's browser, log in, and the **"📍 Record real run"** button records your actual GPS (same-origin HTTPS, so geolocation just works). Simulated-run buttons work from any desktop browser too.
