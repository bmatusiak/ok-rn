/**
 * WHEN THE APP CANNOT START, SAY WHY.
 *
 * Android's launch splash stays up until the app draws its first frame
 * (res/values/splash.xml). An error while App's modules load - a native module
 * the installed APK does not have, a broken import - means no frame ever comes,
 * and the phone sits on the logo with nothing to read. Seen on the Pixel
 * (2026-10-04): the JS asked for NativeEdgeAlert before the APK that has it was
 * installed; Brad: "in that state has an issue, need to display it".
 *
 * This screen is that first frame. It imports nothing of ours (no theme, no
 * components), so whatever broke App cannot break it too.
 */
import React from 'react';
import {ScrollView, Text, View} from 'react-native';

const hint = (msg: string) =>
  /TurboModuleRegistry|could not be found|native module/i.test(msg)
    ? 'A native part of the app is missing: this install is older than its JavaScript. Install the matching build.'
    : null;

export function StartupFailureScreen({error, where}: {error: unknown; where: string}) {
  const e = error instanceof Error ? error : new Error(String(error));
  const h = hint(e.message);
  return (
    <View style={{flex: 1, backgroundColor: '#1a1a1a', paddingTop: 64, paddingHorizontal: 20}}>
      <Text style={{color: '#ff6b6b', fontSize: 20, fontWeight: '700', marginBottom: 12}}>ok-rn could not start</Text>
      <Text style={{color: '#cccccc', marginBottom: 12}}>{`Failed while ${where}. Nothing on the key changed.`}</Text>
      {h ? <Text style={{color: '#f5c542', marginBottom: 12}}>{h}</Text> : null}
      <ScrollView style={{flex: 1}}>
        <Text selectable style={{color: '#ffffff', fontFamily: 'monospace', marginBottom: 12}}>{e.message}</Text>
        <Text selectable style={{color: '#888888', fontFamily: 'monospace', fontSize: 11}}>{(e.stack ?? '').split('\n').slice(0, 12).join('\n')}</Text>
      </ScrollView>
    </View>
  );
}

/** App failed to load: register this instead. */
export function startupFailure(error: unknown, where: string) {
  return function StartupFailure() {
    return <StartupFailureScreen error={error} where={where} />;
  };
}

/** App loaded but threw while drawing: the same screen, not a frozen splash. */
export class StartupBoundary extends React.Component<{children: React.ReactNode}, {error: unknown}> {
  state = {error: null as unknown};
  static getDerivedStateFromError(error: unknown) {
    return {error};
  }
  render() {
    return this.state.error ? <StartupFailureScreen error={this.state.error} where="drawing the app" /> : this.props.children;
  }
}
