import { useEffect, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { loadSession, Session } from './src/api';
import { Login } from './src/screens/Login';
import { MapScreen } from './src/screens/MapScreen';
import { FeedScreen } from './src/screens/FeedScreen';
import { EmpireScreen } from './src/screens/EmpireScreen';
import { T } from './src/theme';

type Tab = 'map' | 'feed' | 'empire';

export default function App() {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [tab, setTab] = useState<Tab>('map');

  useEffect(() => { loadSession().then((s) => { setSession(s); setReady(true); }); }, []);
  if (!ready) return <View style={{ flex: 1, backgroundColor: T.bg }} />;
  if (!session) return <><StatusBar style="light" /><Login onDone={setSession} /></>;

  return (
    <View style={{ flex: 1, backgroundColor: T.bg }}>
      <StatusBar style="light" />
      <View style={{ flex: 1 }}>
        {tab === 'map' && <MapScreen />}
        {tab === 'feed' && <FeedScreen />}
        {tab === 'empire' && <EmpireScreen onLogout={() => setSession(null)} />}
      </View>
      <View style={st.tabs}>
        {(['map', 'feed', 'empire'] as Tab[]).map((t) => (
          <TouchableOpacity key={t} style={st.tab} onPress={() => setTab(t)}>
            <Text style={[st.tabTxt, tab === t && { color: T.acc }]}>
              {t === 'map' ? '🗺️ World' : t === 'feed' ? '⚡ Feed' : '🏰 Empire'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  tabs: { flexDirection: 'row', backgroundColor: T.panel, borderTopColor: T.line, borderTopWidth: 1, paddingBottom: 18, paddingTop: 8 },
  tab: { flex: 1, alignItems: 'center', padding: 8 },
  tabTxt: { color: T.mut, fontWeight: '700' },
});
