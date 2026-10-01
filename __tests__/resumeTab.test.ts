import AsyncStorage from '@react-native-async-storage/async-storage';
import {RESUME_WINDOW_MS, pickResumeTab, rememberTab, takeResumeTab} from '../src/resumeTab';

const TABS = ['This Key', 'PIN Setup', 'Key Chain', 'Keys'];

describe('back to the last tab after a deliberate restart', () => {
  it('returns the remembered tab within five minutes, and nothing after', () => {
    const raw = JSON.stringify({tab: 'PIN Setup', at: 1000});
    expect(pickResumeTab(raw, TABS, 1000 + RESUME_WINDOW_MS)).toBe('PIN Setup');
    expect(pickResumeTab(raw, TABS, 1000 + RESUME_WINDOW_MS + 1)).toBeNull();
    expect(RESUME_WINDOW_MS).toBe(5 * 60 * 1000);
  });

  it('ignores a tab that is not shown now, a clock that went backwards, and junk', () => {
    expect(pickResumeTab(JSON.stringify({tab: 'Testing', at: 1000}), TABS, 2000)).toBeNull();
    expect(pickResumeTab(JSON.stringify({tab: 'Keys', at: 5000}), TABS, 1000)).toBeNull();
    expect(pickResumeTab('not json', TABS, 1000)).toBeNull();
    expect(pickResumeTab(null, TABS, 1000)).toBeNull();
  });

  it('is used once: taking it forgets it', async () => {
    await rememberTab('Key Chain', 1000);
    expect(await takeResumeTab(TABS, 2000)).toBe('Key Chain');
    expect(await takeResumeTab(TABS, 2000)).toBeNull();
    expect(await AsyncStorage.getItem('okrn.resumeTab')).toBeNull();
  });
});
