// VENDORED from the test-moniker package - see ./README.md.
// Kept in upstream's formatting so this stays diffable against where it
// came from; every edit of ours is marked VENDORED.
import React, { useEffect, useState, useRef } from 'react';
import { View, Text, Button, ScrollView, StyleSheet, ActivityIndicator, Pressable, DevSettings } from 'react-native';

const harness = require('./harness');

let configLoaded = true;
const monikerConfig = (() => {
    try {
        return require('../moniker.config');// if we are in ./test-moniker in root project
    } catch (e) {
        try {
            return require('../../moniker.config');//if we are in node_modules/test-moniker
        } catch (e) {
            configLoaded = false;
            return {};
        }
    }
})();

function MonikerView(props = { tests: [] }) {
    const [running, setRunning] = useState(false);
    const [results, setResults] = useState(null);
    // Prepopulate test list from harness so UI can display tests before running
    const makeInitial = () => {
        try {
            const reg = harness.getRegisteredSuites && harness.getRegisteredSuites();
            if (reg) {
                return reg.map(s => ({ name: s.name, tests: s.tests.map(t => ({ name: t.name, status: 'pending', ok: null, error: null })) }));
            }
        } catch (_e) { }
        return [];
    };
    const [testList, setTestList] = useState([]);

    const log = (...args) => console.log('[Moniker]', ...args);
    const timersRef = useRef({});
    const [suiteDurations, setSuiteDurations] = useState({});
    const [totalDurationMs, setTotalDurationMs] = useState(null);

    const [renderComponentView, setRenderComponent] = useState(null);
    const renderComponent = (component) => {
        setRenderComponent(component);
    };

    const formatDuration = (ms) => {
        if (ms == null) return '';
        if (ms < 1000) return `${ms}ms`;
        return `${(ms / 1000).toFixed(2)}s`;
    };

    const runAll = async () => {
        if (running || globalThis._testRan) {

            return;
        }
        globalThis._testRan = true;
        setRunning(true);
        setResults(null);
        try { log('TESTS STARTING'); } catch (_) { }
        // reset testList to pending
        setTestList(prev => prev.map(s => ({ ...s, tests: s.tests.map(t => ({ ...t, status: 'pending', ok: null, error: null })) })));
        const onTestUpdate = ({ suiteName, testName, status, error }) => {
            setTestList(prev => prev.map(s => {
                if (s.name !== suiteName) return s;
                return {
                    ...s,
                    tests: s.tests.map(t => {
                        if (t.name !== testName) return t;
                        const updated = { ...t };
                        updated.status = status || updated.status;
                        if (status === 'passed') { updated.ok = true; updated.error = null; }
                        if (status === 'failed') { updated.ok = false; updated.error = error || null; }
                        // VENDORED: a skip is its own state - not a pass, not a failure.
                        if (status === 'skipped') { updated.ok = true; updated.skipped = true; updated.error = error || null; }
                        return updated;
                    })
                };
            }));
        };

        const allStart = Date.now();
        timersRef.current = {};
        setSuiteDurations({});
        setTotalDurationMs(null);

        const onTestStartTiming = ({ suiteName }) => {
            if (!timersRef.current[suiteName]) {
                const total = (testList.find(s => s.name === suiteName) || {}).tests?.length || 0;
                timersRef.current[suiteName] = { startedAt: Date.now(), finished: 0, total };
            }
        };

        const onTestEndTiming = ({ suiteName }) => {
            const entry = timersRef.current[suiteName];
            if (!entry) return;
            entry.finished = (entry.finished || 0) + 1;
            if (entry.finished >= entry.total) {
                const duration = Date.now() - entry.startedAt;
                setSuiteDurations(prev => ({ ...prev, [suiteName]: duration }));
            }
        };

        try {
            const res = await harness.run({ render: renderComponent, log, onTestUpdate, onTestStart: onTestStartTiming, onTestEnd: onTestEndTiming, config: monikerConfig });
            setResults(res);
            const stopTime = Date.now();
            const totalDurationMs = stopTime - allStart;
            setTotalDurationMs(totalDurationMs);
            try { log('TEST ENDED: 5 Second delay to flush logs'); } catch (_) { }
            setTimeout(() => {
                //short delay to allow log flush before indicating completion
                // VENDORED: Skipped is in the verdict line, which tools/e2e.js
                // parses. It is only printed when there ARE skips, so an
                // ordinary run reads exactly as it always did.
                try { log('TEST COMPLETE |', `Passed: ${res.passed} Failed: ${res.failed}${res.skipped ? ` Skipped: ${res.skipped}` : ''} ${totalDurationMs ? `(${formatDuration(totalDurationMs)})` : ''}`); } catch (_) { }
            }, 5000);
        } catch (e) {
            log('harness.run threw', e);
        } finally {
            setRunning(false);
        }
    };

    const runSuite = async (targetSuite) => {
        if (running) return;
        globalThis._testRan = true;
        setRunning(true);
        setResults(null);

        // reset only the target suite to pending
        setTestList(prev => prev.map(s => {
            if (s.name !== targetSuite) return s;
            return { ...s, tests: s.tests.map(t => ({ ...t, status: 'pending', ok: null, error: null })) };
        }));

        const onTestUpdate = ({ suiteName, testName, status, error }) => {
            setTestList(prev => prev.map(s => {
                if (s.name !== suiteName) return s;
                return {
                    ...s,
                    tests: s.tests.map(t => {
                        if (t.name !== testName) return t;
                        const updated = { ...t };
                        updated.status = status || updated.status;
                        if (status === 'passed') { updated.ok = true; updated.error = null; }
                        if (status === 'failed') { updated.ok = false; updated.error = error || null; }
                        // VENDORED: a skip is its own state - not a pass, not a failure.
                        if (status === 'skipped') { updated.ok = true; updated.skipped = true; updated.error = error || null; }
                        return updated;
                    })
                };
            }));
        };

        const suiteStart = Date.now();
        try {
            const res = await harness.run({ render: renderComponent, log, onTestUpdate, testFilter: (testName, suiteName) => suiteName === targetSuite, config: monikerConfig });
            setResults(res);
            const dur = Date.now() - suiteStart;
            setSuiteDurations(prev => ({ ...prev, [targetSuite]: dur }));
            setTotalDurationMs(dur);
        } catch (e) {
            log('harness.run threw', e);
        } finally {
            setRunning(false);
        }
    };

    useEffect(() => {
        (async () => {

            if (running || globalThis._testRan) {
                if (__DEV__) {
                    log('Tests already running — reloading');
                    DevSettings.reload();
                }
                return;
            }
            console.log('[Moniker] Test Harness Loaded');

            // load tests: built-in MonikerTest, any tests passed via props, and any tests attached to the component
            // TIP: to include tests from the repository __e2e_tests__ folder, require them in your app (e.g. index.js)
            // and add them to MonikerView.tests or pass them via props.tests:
            //   MonikerView.tests = (MonikerView.tests || []).concat([ require('../__e2e_tests__/myTest') ]);
            //   OR <MonikerView tests={[ require('../__e2e_tests__/myTest') ]} />
            const moduleList = [require('./MonikerTest')].concat(props.tests || [], MonikerView.tests || []);

            const testsByName = {};
            moduleList.forEach((mod) => {
                if (typeof mod === 'function' && mod.name) {
                    mod = { name: mod.name, test: mod };
                }
                if (!mod || !mod.name || typeof mod.test !== 'function') {
                    console.warn('[Moniker] invalid test module', mod && (mod.name || mod));
                    return;
                }
                testsByName[mod.name] = mod;
                // Register the suite with the harness
                try { mod.test(harness); } catch (e) { console.warn('[Moniker] failed to register', mod.name, e && e.message); }
            });

            setTestList(makeInitial());
        })();
    }, []);

    useEffect(() => {
        // auto-run shortly after mount to allow native init
        const t = setTimeout(runAll, 500);
        return () => clearTimeout(t);
    }, [testList.length]);

    return (
        <>

            <View style={styles.container}>
                <View
                // style={styles.hide}
                >
                    {renderComponentView}
                </View>
                <Text style={styles.title}>{monikerConfig.title || 'Test Moniker'}</Text>
                <Text style={styles.title}>Config Loaded: {configLoaded ? 'Yes' : 'No'}</Text>
                <Button title={running ? 'Running…' : 'Run Tests'} onPress={() => {
                    if (__DEV__) {
                        DevSettings.reload();
                    } else {
                        globalThis._testRan = false;
                        runAll();
                    }
                }} disabled={running} />

                {running ? (
                    <View style={styles.runningRow}>
                        <ActivityIndicator style={styles.runningSpinner} size="small" />
                        <Text style={styles.runningText}>Running tests…</Text>
                    </View>
                ) : null}

                <View style={styles.summary}>
                    <Text style={styles.summaryText}>
                        {/* VENDORED: skips shown on screen too, for the same reason. */}
                        {results ? `Passed: ${results.passed}  Failed: ${results.failed}${results.skipped ? `  Skipped: ${results.skipped}` : ''} ${totalDurationMs ? `(${formatDuration(totalDurationMs)})` : ''}` : 'No results yet'}
                    </Text>
                </View>

                <ScrollView style={styles.scroll} contentContainerStyle={{ flexGrow: 1 }}>
                    {testList.map((suite, si) => (
                        <Pressable key={si} onPress={() => runSuite(suite.name)} style={({ pressed }) => [styles.suite, pressed && styles.suitePressed]}>
                            <Text style={styles.suiteTitle}>{suite.name}{suiteDurations[suite.name] ? ` — ${formatDuration(suiteDurations[suite.name])}` : ''}</Text>
                            {suite.tests.map((t, ti) => (
                                <View key={ti} style={styles.testRow}>
                                    <View style={styles.testRowInner}>
                                        {t.status === 'running' ? (
                                            <ActivityIndicator size="small" style={styles.testSpinner} />
                                        ) : t.status === 'pending' ? (
                                            <Text style={[styles.testName, styles.pending]}>○</Text>
                                        ) : t.status === 'passed' ? (
                                            <Text style={[styles.testName, styles.pass]}>✓</Text>
                                        ) : t.status === 'skipped' ? (
                                            <Text style={[styles.testName, styles.pending]}>○</Text>
                                        ) : (
                                            <Text style={[styles.testName, styles.fail]}>✗</Text>
                                        )}
                                        <Text style={[styles.testName, t.status === 'skipped' ? styles.pending : t.ok ? styles.pass : (t.status === 'pending' ? styles.pending : styles.fail)]}>
                                            {` ${t.name}`}
                                        </Text>
                                    </View>
                                    {t.error ? (
                                        <Text style={t.status === 'skipped' ? styles.pending : styles.error}>{t.error}</Text>
                                    ) : null}
                                </View>
                            ))}
                        </Pressable>
                    ))}
                </ScrollView>
            </View>
        </>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, padding: 12, paddingTop: 25, backgroundColor: '#fff', width: '100%' },
    title: { fontSize: 20, fontWeight: '700', marginBottom: 8 },
    summary: { marginVertical: 8 },
    summaryText: { fontSize: 14 },
    scroll: { flex: 1 },
    suite: { paddingVertical: 8, borderBottomWidth: 1 },
    suitePressed: { backgroundColor: '#f6f6f6' },
    suiteTitle: { fontWeight: '700', fontSize: 16, marginBottom: 6 },
    testRow: { marginLeft: 8, marginBottom: 6 },
    testName: { fontSize: 14 },
    pass: { color: '#0a0' },
    fail: { color: '#a00' },
    pending: { color: '#666' },
    testRowInner: { flexDirection: 'row', alignItems: 'center' },
    testSpinner: { width: 20, marginRight: 6 },
    error: { color: '#a00', fontSize: 12, marginTop: 2 },
    runningSpinner: { marginRight: 6 },
    runningRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 8 },
    runningText: { fontSize: 14 },
    hide: {
        position: 'absolute',
        width: 0,
        height: 0,
        flexGrow: 0,
        flexShrink: 1
    },
});

export default MonikerView;
