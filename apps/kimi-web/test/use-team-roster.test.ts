// apps/kimi-web/test/use-team-roster.test.ts
// Lifted team-roster polling (App.vue): drives the dock's 「团队 (working/total)」
// badge and the /team TeamStatusPanel from a single GET /teams/{sid}/members
// poll. Covers the session guard, the working/total summary derivation, and
// refetch-on-session-switch so the badge never shows a stale team.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { useTeamRoster } from '../src/composables/useTeamRoster';
import type { AppTeamMember, AppTeamMemberStatus, AppTeamMembers } from '../src/api/types';

const { getTeamMembers } = vi.hoisted(() => ({ getTeamMembers: vi.fn() }));
vi.mock('../src/api', () => ({
  getKimiWebApi: () => ({ getTeamMembers }),
}));

function member(status: AppTeamMemberStatus): AppTeamMember {
  return {
    name: `m-${status}`,
    role: '',
    description: '',
    whenToUse: '',
    model: '',
    tools: [],
    status,
    score: { average: null, count: 0 },
  };
}

function roster(global: AppTeamMemberStatus[], project: AppTeamMemberStatus[] = []): AppTeamMembers {
  return {
    teamMode: true,
    global: global.map(member),
    project: project.map(member),
  };
}

describe('useTeamRoster', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    getTeamMembers.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('polls members for the active session and derives working/total', async () => {
    getTeamMembers.mockResolvedValue(roster(['working', 'working', 'resting'], ['working', 'resting']));
    const sessionId = ref<string | null>('s1');
    const { summary } = useTeamRoster(sessionId);

    await vi.advanceTimersByTimeAsync(0);
    await nextTick();

    expect(getTeamMembers).toHaveBeenCalledWith('s1');
    expect(summary.value).toEqual({ total: 5, working: 3, resting: 2, offDuty: 0 });
  });

  it('does not fetch and stays at 0/0 without an active session', async () => {
    getTeamMembers.mockResolvedValue(roster(['working']));
    const sessionId = ref<string | null>(null);
    const { summary } = useTeamRoster(sessionId);

    await vi.advanceTimersByTimeAsync(2500 * 3);

    expect(getTeamMembers).not.toHaveBeenCalled();
    expect(summary.value).toEqual({ total: 0, working: 0, resting: 0, offDuty: 0 });
  });

  it('drops stale data and refetches when the session switches', async () => {
    getTeamMembers.mockResolvedValue(roster(['working']));
    const sessionId = ref<string | null>('s1');
    const { summary } = useTeamRoster(sessionId);

    await vi.advanceTimersByTimeAsync(0);
    await nextTick();
    expect(summary.value).toEqual({ total: 1, working: 1, resting: 0, offDuty: 0 });

    getTeamMembers.mockResolvedValue(roster(['working', 'working', 'off-duty']));
    sessionId.value = 's2';
    await vi.advanceTimersByTimeAsync(0);
    await nextTick();

    expect(getTeamMembers).toHaveBeenCalledWith('s2');
    expect(summary.value).toEqual({ total: 3, working: 2, resting: 0, offDuty: 1 });
  });

  it('keeps polling on the interval so the badge stays live', async () => {
    getTeamMembers.mockResolvedValue(roster(['working']));
    const sessionId = ref<string | null>('s1');
    useTeamRoster(sessionId);

    await vi.advanceTimersByTimeAsync(0);
    expect(getTeamMembers).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2500);
    expect(getTeamMembers).toHaveBeenCalledTimes(2);
  });
});
