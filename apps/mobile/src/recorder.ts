/**
 * Live run recorder.
 * v1 (this APK): foreground GPS watch + keep-awake — screen stays on during a run,
 * points buffer in memory and flush to the server every ~20s or 100 points; unsent
 * chunks retry on finish. Full background foreground-service tracking + SQLite
 * crash-recovery land in the hardening pass (see README roadmap).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import * as Location from 'expo-location';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { api } from './api';

export interface Point {
  t: number;
  lat: number;
  lng: number;
  alt?: number;
  acc?: number;
}

export interface RunState {
  status: 'idle' | 'requesting' | 'recording' | 'uploading' | 'done' | 'error';
  distanceM: number;
  elapsedS: number;
  paceSPerKm: number | null;
  points: number;
  error?: string;
  result?: { hexes_claimed: number; hexes_stolen: number; hexes_refreshed: number; status: string; flags?: unknown };
}

const R = 6371008.8;
function hav(a: Point, b: Point) {
  const d = Math.PI / 180;
  const s =
    Math.sin(((b.lat - a.lat) * d) / 2) ** 2 +
    Math.cos(a.lat * d) * Math.cos(b.lat * d) * Math.sin(((b.lng - a.lng) * d) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function useRunRecorder(onLivePoint?: (p: Point) => void) {
  const [state, setState] = useState<RunState>({ status: 'idle', distanceM: 0, elapsedS: 0, paceSPerKm: null, points: 0 });
  const sub = useRef<Location.LocationSubscription | null>(null);
  const buf = useRef<Point[]>([]);          // points not yet sent
  const all = useRef<Point[]>([]);          // everything (for stats)
  const seq = useRef(0);
  const activityId = useRef<string | null>(null);
  const startedAt = useRef(0);
  const flushTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const distance = useRef(0);

  const flush = useCallback(async () => {
    if (!activityId.current || buf.current.length === 0) return;
    const points = buf.current.splice(0, 200);
    const mySeq = seq.current++;
    try {
      await api(`/activities/live/${activityId.current}/chunks`, {
        method: 'POST',
        body: JSON.stringify({ seq: mySeq, points }),
      });
    } catch {
      // requeue at front; chunk seq is idempotent server-side
      buf.current.unshift(...points);
      seq.current = mySeq;
    }
  }, []);

  const start = useCallback(async () => {
    setState((s) => ({ ...s, status: 'requesting', error: undefined, result: undefined }));
    const perm = await Location.requestForegroundPermissionsAsync();
    if (perm.status !== 'granted') {
      setState((s) => ({ ...s, status: 'error', error: 'Location permission denied' }));
      return;
    }
    try {
      const started = new Date().toISOString();
      const res = await api('/activities/live/start', {
        method: 'POST',
        body: JSON.stringify({ type: 'run', started_at: started }),
      });
      activityId.current = res.activity_id;
      startedAt.current = Date.now();
      buf.current = [];
      all.current = [];
      seq.current = 0;
      distance.current = 0;
      await activateKeepAwakeAsync('run');
      sub.current = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 2 },
        (loc) => {
          const p: Point = {
            t: loc.timestamp,
            lat: loc.coords.latitude,
            lng: loc.coords.longitude,
            alt: loc.coords.altitude ?? undefined,
            acc: loc.coords.accuracy ?? undefined,
          };
          const prev = all.current[all.current.length - 1];
          if (prev) distance.current += hav(prev, p);
          all.current.push(p);
          buf.current.push(p);
          onLivePoint?.(p);
          const elapsedS = Math.round((Date.now() - startedAt.current) / 1000);
          setState({
            status: 'recording',
            distanceM: Math.round(distance.current),
            elapsedS,
            paceSPerKm: distance.current > 50 ? Math.round(elapsedS / (distance.current / 1000)) : null,
            points: all.current.length,
          });
          if (buf.current.length >= 100) void flush();
        },
      );
      flushTimer.current = setInterval(() => void flush(), 20_000);
      setState((s) => ({ ...s, status: 'recording' }));
    } catch (e: any) {
      setState((s) => ({ ...s, status: 'error', error: e.message }));
    }
  }, [flush, onLivePoint]);

  const stop = useCallback(async () => {
    sub.current?.remove();
    sub.current = null;
    if (flushTimer.current) clearInterval(flushTimer.current);
    deactivateKeepAwake('run');
    if (!activityId.current) return;
    setState((s) => ({ ...s, status: 'uploading' }));
    try {
      while (buf.current.length) await flush();
      await api(`/activities/live/${activityId.current}/finish`, {
        method: 'POST',
        body: JSON.stringify({ ended_at: new Date().toISOString() }),
      });
      // poll for pipeline verdict (WS also delivers it; poll is the fallback)
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const res = await api(`/activities/${activityId.current}/result`);
        if (res.pipeline_stage === 'fanned_out' || ['rejected', 'flagged'].includes(res.status)) {
          setState((s) => ({
            ...s,
            status: 'done',
            result: {
              hexes_claimed: res.hexes_claimed,
              hexes_stolen: res.hexes_stolen,
              hexes_refreshed: res.hexes_refreshed,
              status: res.status,
              flags: res.validation_flags,
            },
          }));
          activityId.current = null;
          return;
        }
      }
      setState((s) => ({ ...s, status: 'error', error: 'Pipeline timeout — check again in the feed' }));
    } catch (e: any) {
      setState((s) => ({ ...s, status: 'error', error: e.message }));
    }
  }, [flush]);

  const abandon = useCallback(async () => {
    sub.current?.remove();
    if (flushTimer.current) clearInterval(flushTimer.current);
    deactivateKeepAwake('run');
    if (activityId.current) {
      await api(`/activities/live/${activityId.current}/abandon`, { method: 'POST' }).catch(() => {});
      activityId.current = null;
    }
    setState({ status: 'idle', distanceM: 0, elapsedS: 0, paceSPerKm: null, points: 0 });
  }, []);

  useEffect(() => () => { sub.current?.remove(); if (flushTimer.current) clearInterval(flushTimer.current); }, []);

  return { state, start, stop, abandon };
}
