import { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { anon, saveSession, Session } from '../api';
import { T } from '../theme';

export function Login({ onDone }: { onDone: (s: Session) => void }) {
  const [apiUrl, setApiUrl] = useState('http://192.168.1.10:3000');
  const [phone, setPhone] = useState('+919000000100');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'idle' | 'sending' | 'code' | 'verifying'>('idle');
  const [err, setErr] = useState('');

  const requestOtp = async () => {
    setErr(''); setStage('sending');
    try {
      const r = await anon(apiUrl, '/auth/otp/request', { method: 'POST', body: JSON.stringify({ phone_e164: phone }) });
      if (r.dev_code) {
        setCode(r.dev_code); // dev servers echo the code — autofill
      }
      setStage('code');
    } catch (e: any) { setErr(e.message); setStage('idle'); }
  };

  const verify = async () => {
    setErr(''); setStage('verifying');
    try {
      const v = await anon(apiUrl, '/auth/otp/verify', {
        method: 'POST',
        body: JSON.stringify({ phone_e164: phone, code, device: { platform: 'android' } }),
      });
      const s: Session = { apiUrl, access: v.access, refresh: v.refresh, user: v.user };
      await saveSession(s);
      onDone(s);
    } catch (e: any) { setErr(e.message); setStage('code'); }
  };

  return (
    <View style={st.wrap}>
      <Text style={st.logo}>RUN<Text style={{ color: T.acc }}>VERSE</Text></Text>
      <Text style={st.sub}>every kilometer has consequence</Text>
      <Text style={st.label}>API SERVER</Text>
      <TextInput style={st.input} value={apiUrl} onChangeText={setApiUrl} autoCapitalize="none" placeholder="https://your-api.onrender.com" placeholderTextColor={T.mut} />
      <Text style={st.label}>PHONE</Text>
      <TextInput style={st.input} value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
      {stage === 'code' || stage === 'verifying' ? (
        <>
          <Text style={st.label}>OTP CODE</Text>
          <TextInput style={st.input} value={code} onChangeText={setCode} keyboardType="number-pad" />
          <TouchableOpacity style={st.btn} onPress={verify} disabled={stage === 'verifying'}>
            {stage === 'verifying' ? <ActivityIndicator color="#00222a" /> : <Text style={st.btnTxt}>Enter the world</Text>}
          </TouchableOpacity>
        </>
      ) : (
        <TouchableOpacity style={st.btn} onPress={requestOtp} disabled={stage === 'sending'}>
          {stage === 'sending' ? <ActivityIndicator color="#00222a" /> : <Text style={st.btnTxt}>Send code</Text>}
        </TouchableOpacity>
      )}
      {!!err && <Text style={st.err}>{err}</Text>}
    </View>
  );
}

const st = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: T.bg, justifyContent: 'center', padding: 24 },
  logo: { color: T.txt, fontSize: 34, fontWeight: '800', letterSpacing: 2, textAlign: 'center' },
  sub: { color: T.mut, textAlign: 'center', marginBottom: 32 },
  label: { color: T.mut, fontSize: 11, letterSpacing: 1.2, marginTop: 14, marginBottom: 4 },
  input: { backgroundColor: T.panel, borderColor: T.line, borderWidth: 1, borderRadius: 10, color: T.txt, padding: 12 },
  btn: { backgroundColor: T.acc, borderRadius: 10, padding: 14, alignItems: 'center', marginTop: 20 },
  btnTxt: { color: '#00222a', fontWeight: '800' },
  err: { color: T.bad, marginTop: 12, textAlign: 'center' },
});
