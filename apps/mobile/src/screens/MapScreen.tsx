import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import MapLibreGL from '@maplibre/maplibre-react-native';
import * as Location from 'expo-location';
import { api, getSession, wsUrl } from '../api';
import { hexFeatureCollection, OwnedHex, viewportCells } from '../hexgeo';
import { useRunRecorder } from '../recorder';
import { T } from '../theme';

MapLibreGL.setAccessToken(null); // raster tiles, no token

const STYLE = {
  version: 8,
  sources: {
    carto: {
      type: 'raster',
      tiles: ['https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap © CARTO',
    },
  },
  layers: [{ id: 'base', type: 'raster', source: 'carto' }],
} as const;

export function MapScreen() {
  const me = getSession()!.user;
  const [hexes, setHexes] = useState<Map<string, OwnedHex>>(new Map());
  const [center, setCenter] = useState<[number, number] | null>(null); // [lng, lat]
  const [banner, setBanner] = useState('');
  const ws = useRef<WebSocket | null>(null);
  const cells = useRef<string[]>([]);

  const refreshViewport = useCallback(async (lat: number, lng: number) => {
    cells.current = viewportCells(lat, lng);
    const data = await api(`/territory/viewport?cells=${cells.current.join(',')}`);
    setHexes((prev) => {
      const next = new Map(prev);
      for (const h of data.hexes) {
        next.set(h.h3, { h3: h.h3, color: h.owner.color, strength: h.strength_eff, mine: h.owner.id === me.id });
      }
      return next;
    });
  }, [me.id]);

  useEffect(() => {
    (async () => {
      const perm = await Location.requestForegroundPermissionsAsync();
      let lat = 12.9716, lng = 77.5946; // Bengaluru fallback
      if (perm.status === 'granted') {
        const loc = await Location.getCurrentPositionAsync({});
        lat = loc.coords.latitude; lng = loc.coords.longitude;
      }
      setCenter([lng, lat]);
      await refreshViewport(lat, lng);
      const url = wsUrl();
      if (!url) return;
      const sock = new WebSocket(url);
      ws.current = sock;
      sock.onopen = () => sock.send(JSON.stringify({ type: 'subscribe', cells_r5: cells.current }));
      sock.onmessage = (m) => {
        const e = JSON.parse(String(m.data));
        if (e.type === 'territory.delta') {
          setHexes((prev) => {
            const next = new Map(prev);
            for (const ch of e.changes) {
              next.set(ch.h3, { h3: ch.h3, color: ch.owner.color, strength: ch.strength, mine: ch.owner.id === me.id });
            }
            return next;
          });
        }
        if (e.type === 'activity.result') {
          setBanner(`⚔️ +${e.hexes_claimed} claimed · ${e.hexes_stolen} stolen · ${e.hexes_refreshed} defended`);
          setTimeout(() => setBanner(''), 6000);
        }
      };
    })();
    return () => ws.current?.close();
  }, [me.id, refreshViewport]);

  const { state, start, stop, abandon } = useRunRecorder();
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  return (
    <View style={{ flex: 1, backgroundColor: T.bg }}>
      {center && (
        <MapLibreGL.MapView style={{ flex: 1 }} mapStyle={JSON.stringify(STYLE)} logoEnabled={false} attributionEnabled>
          <MapLibreGL.Camera zoomLevel={14} centerCoordinate={center} />
          <MapLibreGL.UserLocation visible />
          <MapLibreGL.ShapeSource id="hexes" shape={hexFeatureCollection([...hexes.values()])}>
            <MapLibreGL.FillLayer id="hex-fill" style={{ fillColor: ['get', 'color'], fillOpacity: ['get', 'opacity'] }} />
            <MapLibreGL.LineLayer id="hex-line" style={{ lineColor: ['get', 'color'], lineWidth: 1.2 }} />
          </MapLibreGL.ShapeSource>
        </MapLibreGL.MapView>
      )}
      {!!banner && <View style={st.banner}><Text style={st.bannerTxt}>{banner}</Text></View>}

      <View style={st.hud}>
        {state.status === 'recording' || state.status === 'uploading' ? (
          <>
            <View style={st.stats}>
              <Stat label="DIST" value={`${(state.distanceM / 1000).toFixed(2)} km`} />
              <Stat label="TIME" value={fmt(state.elapsedS)} />
              <Stat label="PACE" value={state.paceSPerKm ? `${fmt(state.paceSPerKm)}/km` : '—'} />
            </View>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <TouchableOpacity style={[st.btn, { backgroundColor: T.bad, flex: 1 }]} onPress={abandon}>
                <Text style={st.btnTxt}>Discard</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[st.btn, { flex: 2 }]} onPress={stop} disabled={state.status === 'uploading'}>
                <Text style={st.btnTxt}>{state.status === 'uploading' ? 'Uploading…' : 'Finish & Capture'}</Text>
              </TouchableOpacity>
            </View>
          </>
        ) : (
          <TouchableOpacity style={st.btn} onPress={start} disabled={state.status === 'requesting'}>
            <Text style={st.btnTxt}>{state.status === 'requesting' ? 'Starting…' : '▶  START RUN'}</Text>
          </TouchableOpacity>
        )}
        {state.status === 'done' && state.result && (
          <Text style={st.result}>
            {state.result.status === 'flagged'
              ? '🚫 Flagged for review — no territory awarded'
              : `🏰 +${state.result.hexes_claimed} claimed, ${state.result.hexes_stolen} stolen`}
          </Text>
        )}
        {state.status === 'error' && <Text style={[st.result, { color: T.bad }]}>{state.error}</Text>}
      </View>
    </View>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ alignItems: 'center', flex: 1 }}>
      <Text style={{ color: T.acc, fontSize: 20, fontWeight: '800' }}>{value}</Text>
      <Text style={{ color: T.mut, fontSize: 10, letterSpacing: 1 }}>{label}</Text>
    </View>
  );
}

const st = StyleSheet.create({
  hud: { position: 'absolute', bottom: 24, left: 16, right: 16, backgroundColor: T.panel + 'F0', borderRadius: 16, borderColor: T.line, borderWidth: 1, padding: 14 },
  stats: { flexDirection: 'row', marginBottom: 12 },
  btn: { backgroundColor: T.acc, borderRadius: 10, padding: 14, alignItems: 'center' },
  btnTxt: { color: '#00222a', fontWeight: '800' },
  result: { color: T.ok, textAlign: 'center', marginTop: 10 },
  banner: { position: 'absolute', top: 54, alignSelf: 'center', backgroundColor: T.panel, borderColor: T.acc, borderWidth: 1, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 8 },
  bannerTxt: { color: T.txt, fontWeight: '700' },
});
