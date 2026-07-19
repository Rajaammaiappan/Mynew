import { useCallback, useEffect, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { api } from '../api';
import { T } from '../theme';

interface FeedItem {
  id: string; type: string; started_at: string; distance_m: number; moving_time_s: number;
  hexes_claimed: number; hexes_stolen: number; handle: string; display_name: string;
  color: string; kudos_count: number; comment_count: number;
}

export function FeedScreen() {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = await api('/feed');
      setItems(r.items);
    } finally { setRefreshing(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const kudos = async (id: string) => {
    await api(`/activities/${id}/kudos`, { method: 'POST' });
    void load();
  };

  const pace = (i: FeedItem) => {
    if (!i.distance_m) return '—';
    const s = Math.round(i.moving_time_s / (i.distance_m / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}/km`;
  };

  return (
    <FlatList
      style={{ flex: 1, backgroundColor: T.bg }}
      contentContainerStyle={{ padding: 14 }}
      data={items}
      keyExtractor={(i) => i.id}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} tintColor={T.acc} />}
      ListEmptyComponent={<Text style={{ color: T.mut, textAlign: 'center', marginTop: 40 }}>No activity yet — go claim some streets.</Text>}
      renderItem={({ item }) => (
        <View style={st.card}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <View style={[st.dot, { backgroundColor: item.color }]} />
            <Text style={st.handle}>@{item.handle}</Text>
            <Text style={st.when}>{new Date(item.started_at).toLocaleDateString()}</Text>
          </View>
          <Text style={st.line}>
            {(item.distance_m / 1000).toFixed(2)} km · {pace(item)} · 🏰 +{item.hexes_claimed}
            {item.hexes_stolen ? ` · ⚔️ ${item.hexes_stolen} stolen` : ''}
          </Text>
          <TouchableOpacity onPress={() => kudos(item.id)}>
            <Text style={st.kudos}>👏 {item.kudos_count}   💬 {item.comment_count}</Text>
          </TouchableOpacity>
        </View>
      )}
    />
  );
}

const st = StyleSheet.create({
  card: { backgroundColor: T.panel, borderColor: T.line, borderWidth: 1, borderRadius: 12, padding: 12, marginBottom: 10 },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: 8 },
  handle: { color: T.txt, fontWeight: '700', flex: 1 },
  when: { color: T.mut, fontSize: 11 },
  line: { color: T.txt, marginTop: 8 },
  kudos: { color: T.mut, marginTop: 8 },
});
