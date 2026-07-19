# RUNVERSE — Phase 1 Test Plan

Legend: ✅ automated & passing in this deliverable · 🔜 lands with Part 2 (mobile) · 🧪 manual/staged

## 1. Capture engine (packages/core) — ✅ all automated

| Case | Expectation | Status |
|---|---|---|
| Straight 5 km run | Corridor-only, no loops, ~19 cells, ≤ budget | ✅ |
| Sparse vs dense GPS sampling of same line | Identical cell sets (densification) | ✅ |
| Closed loop (endpoints ≤ 60 m) | Loop detected, interior polyfilled | ✅ |
| Open horseshoe (endpoints 300 m) | No loop | ✅ |
| Oversized enclosure (18.8 km ring, 283 cells) | Capped at budget (187); corridor fully awarded before interior | ✅ |
| Import multiplier | Budget halved (ADR-007) | ✅ |
| Figure-8 self-intersection | Rings found without endpoint closure; interiors captured | ✅ |
| Determinism | Identical inputs → identical outputs (client preview ≡ server) | ✅ |
| GPS jitter micro-rings (< 400 m) | Filtered | ✅ |

## 2. Validator & trust (packages/core + pipeline) — ✅ all automated

| Case | Expectation | Status |
|---|---|---|
| Normal 5 km @ 5:12/km with healthy cadence | `validated`, no flags | ✅ |
| Teleport (2 km instant jump) | `teleport_jump` → flagged | ✅ |
| 54 km/h sustained "run", 40 steps total | overspeed + vehicle/no-step flags → flagged | ✅ |
| Same speed as `cycle` | validated (per-type envelopes) | ✅ |
| Non-monotonic timestamps / < 300 m | hard reject | ✅ |
| Dead pedometer on multi-km "run" | `no_step_signal` → flagged | ✅ |
| Decay math | 100 → 60 after 5 days; clamps at 0 and vs clock skew | ✅ |
| Ownership resolution | claim / refresh / steal / defended truth table | ✅ |

## 3. API E2E (apps/api, against live PG+Redis) — ✅ all automated

| Flow | Expectation | Status |
|---|---|---|
| OTP request/verify, rate limit 3/hr | tokens issued; user auto-created | ✅ (limit itself 🧪) |
| Refresh rotation + reuse detection | reuse kills device session | 🧪 scripted in staging |
| Live session: start → 4×200-pt chunks → finish | idempotent chunk acks; pipeline enqueued | ✅ |
| Pipeline settle < 10 s | status `validated`, stage `fanned_out` | ✅ (typ. ~1.5 s) |
| 2.2 km loop → captures | 7 hexes (corridor + interior), recap endpoint matches | ✅ |
| Viewport | Owned hexes visible with strength 100; ETag → 304 on repeat | ✅ |
| Hex drill-down | owner + last-10 event history | ✅ |
| Fresh-territory defense | rival steal attempt → 0 stolen | ✅ |
| Decayed-territory conquest | 8-day-old hexes stolen (eff 36 < power 50) | ✅ |
| Feed + kudos | followee runs appear; kudos_count increments | ✅ |
| Cheat path | flagged run: 0 territory, fraud_reviews row, trust 100→95 | ✅ |
| WS live map | subscribe → `territory.delta` + `activity.result` frames arrive | ✅ |
| WS subscribe-at-open race | early frames buffered, not lost | ✅ (regression for fixed bug) |
| Decay sweep cron | dead hexes neutralized + `decay_loss` events | 🧪 run `DecaySweep.sweep()` manually in staging |
| Shadow-ban | activities validate but write no world state | 🧪 staging script |

## 4. Pending with Part 2 (mobile) — 🔜

Battery ≤ 10%/hr across 3 device tiers · offline recording with airplane-mode mid-run · kill-and-resume recovery from SQLite · optimistic preview reconciliation vs server result · privacy-zone clipping on shared views · Mapbox 60 fps with 2k hexes in viewport · onboarding to first-capture funnel.

## 5. Load & chaos (pre-launch gate, Phase 7 hardening)

k6 profile: 70k activities/hr sustained, p95 pipeline < 8 s · Redis failover during a capture burst (expected loss ≤ 1 war-score snapshot, zero territory loss) · worker kill mid-transaction → resume without double-award (idempotency keyed on capture_events dedup — unit-verifiable today) · viewport read storm with cold ETags.
