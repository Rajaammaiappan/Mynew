import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { api, getSession, saveSession } from '../api';
import { T } from '../theme';

const TITLES: Record<string, string> = {
  street_owner: '🏠 Street Owner',
  area_captain: '🛡️ Area Captain',
  district_governor: '🏛️ District Governor',
  city_lord: '👑 City Lord',
  state_king: '👑 State King',
  national_emperor: '👑 National Emperor',
};

export function EmpireScreen({ onLogout }: { onLogout: () => void }) {
  const me = getSession()!.user;
  const [sum, setSum] = useState<{ hex_count: number; decay_at_risk: number; rank_title: string | null } | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try { setSum(await api('/territory/me/summary')); } finally { setRefreshing(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: T.bg }}
      contentContainerStyle={{ padding: 18 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} tintColor={T.acc} />}
    >
      <Text style={st.h}>@{me.handle}</Text>
      <Text style={st.title}>{sum?.rank_title ? TITLES[sum.rank_title] : '🌱 Unranked — capture 10 hexes'}</Text>
      <View style={st.row}>
        <View style={st.stat}><Text style={st.big}>{sum?.hex_count ?? '—'}</Text><Text style={st.mut}>HEXES HELD</Text></View>
        <View style={st.stat}><Text style={[st.big, { color: T.warn }]}>{sum?.decay_at_risk ?? '—'}</Text><Text style={st.mut}>DECAYING SOON</Text></View>
      </View>
      <Text style={st.note}>
        Territory decays 8 strength/day. Re-run your streets to refresh them; rivals can steal anything below their attack power.
      </Text>
      <TouchableOpacity style={st.logout} onPress={async () => { await saveSession(null); onLogout(); }}>
        <Text style={{ color: T.bad, fontWeight: '700' }}>Log out</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const st = StyleSheet.create({
  h: { color: T.txt, fontSize: 24, fontWeight: '800' },
  title: { color: T.acc, marginTop: 4, marginBottom: 18, fontSize: 16 },
  row: { flexDirection: 'row', gap: 12 },
  stat: { flex: 1, backgroundColor: T.panel, borderColor: T.line, borderWidth: 1, borderRadius: 12, padding: 16, alignItems: 'center' },
  big: { color: T.acc, fontSize: 28, fontWeight: '800' },
  mut: { color: T.mut, fontSize: 10, letterSpacing: 1, marginTop: 4 },
  note: { color: T.mut, marginTop: 18, lineHeight: 20 },
  logout: { marginTop: 30, alignItems: 'center', padding: 12 },
});
