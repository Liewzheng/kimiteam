// apps/kimi-web/test/use-detail-panel.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import type { DetailTarget } from '../src/composables/useFilePreview';
import { useDetailPanel } from '../src/composables/useDetailPanel';

// useViewportWidth registers window listeners via lifecycle hooks that are no-ops
// outside a component; mock it so useDetailPanel is pure to drive in tests.
vi.mock('../src/composables/useViewportWidth', () => ({
  clampPanelWidth: (width: number, min: number, max: number) =>
    Math.min(max, Math.max(min, width)),
  panelMaxWidth: (available: number, min: number, reserve: number) =>
    Math.max(min, available - reserve),
  useViewportWidth: () => ({ viewportWidth: ref(1200) }),
}));

function makeClient() {
  return {
    turns: ref([]),
    activeAppTasks: ref([]),
    sideChatVisible: ref(false),
    activeSessionId: ref<string | null>('s1'),
    closeSideChat: vi.fn(),
    openSideChat: vi.fn(),
    startSessionAndOpenSideChat: vi.fn(),
    loadGitStatus: vi.fn(),
    clearFileDiff: vi.fn(),
    loadFileDiff: vi.fn(),
  };
}

function makePanel() {
  const client = makeClient();
  const detailTarget = ref<DetailTarget | null>(null);
  const closeFilePreview = vi.fn();
  const panel = useDetailPanel({
    client: client as never,
    sideWidth: ref(0),
    detailTarget,
    closeFilePreview,
  });
  return { client, detailTarget, closeFilePreview, panel };
}

describe('useDetailPanel — team/usage branches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('openTeamPanel claims the shared slot and closeTeamPanel releases it', () => {
    const { detailTarget, panel } = makePanel();

    expect(panel.teamVisible.value).toBe(false);
    panel.openTeamPanel('s1');
    expect(detailTarget.value).toBe('team');
    expect(panel.teamVisible.value).toBe(true);
    expect(panel.sidePanelVisible.value).toBe(true);

    panel.closeTeamPanel();
    expect(detailTarget.value).toBeNull();
    expect(panel.teamVisible.value).toBe(false);
  });

  it('openTeamPanel on the already-open session toggles the panel closed', () => {
    const { detailTarget, panel } = makePanel();

    panel.openTeamPanel('s1');
    expect(detailTarget.value).toBe('team');
    panel.openTeamPanel('s1');
    expect(detailTarget.value).toBeNull();
  });

  it('openUsagePanel / closeUsagePanel mirror the team behavior', () => {
    const { detailTarget, panel } = makePanel();

    panel.openUsagePanel('s1');
    expect(detailTarget.value).toBe('usage');
    expect(panel.usageVisible.value).toBe(true);
    expect(panel.sidePanelVisible.value).toBe(true);

    panel.openUsagePanel('s1');
    expect(detailTarget.value).toBeNull();

    panel.openUsagePanel('s2');
    expect(detailTarget.value).toBe('usage');
    panel.closeUsagePanel();
    expect(detailTarget.value).toBeNull();
  });

  it('opening team replaces whatever occupied the shared slot', () => {
    const { detailTarget, panel } = makePanel();

    detailTarget.value = 'file';
    panel.openTeamPanel('s1');
    expect(detailTarget.value).toBe('team');

    panel.openUsagePanel('s1');
    expect(detailTarget.value).toBe('usage');
  });

  it('closeOpenSidePanel closes team and usage (and returns false when idle)', () => {
    const { detailTarget, panel } = makePanel();

    panel.openTeamPanel('s1');
    expect(panel.closeOpenSidePanel()).toBe(true);
    expect(detailTarget.value).toBeNull();

    panel.openUsagePanel('s1');
    expect(panel.closeOpenSidePanel()).toBe(true);
    expect(detailTarget.value).toBeNull();

    expect(panel.closeOpenSidePanel()).toBe(false);
  });

  it('remembers an open team panel per session and restores it on switch-back', async () => {
    const { client, detailTarget, panel } = makePanel();

    panel.openTeamPanel('s1');
    expect(detailTarget.value).toBe('team');

    client.activeSessionId.value = 's2';
    await nextTick();
    // Team is session-scoped — switching away closes the panel.
    expect(detailTarget.value).toBeNull();

    client.activeSessionId.value = 's1';
    await nextTick();
    // The snapshot restores the team panel for the returning session.
    expect(detailTarget.value).toBe('team');
    expect(panel.teamVisible.value).toBe(true);
  });

  it('remembers an open usage panel per session and restores it on switch-back', async () => {
    const { client, detailTarget, panel } = makePanel();

    panel.openUsagePanel('s1');
    client.activeSessionId.value = 's2';
    await nextTick();
    expect(detailTarget.value).toBeNull();

    client.activeSessionId.value = 's1';
    await nextTick();
    expect(detailTarget.value).toBe('usage');
  });
});
