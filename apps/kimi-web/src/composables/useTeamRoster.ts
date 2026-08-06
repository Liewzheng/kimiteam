// apps/kimi-web/src/composables/useTeamRoster.ts
// Lifted team-roster polling for the ACTIVE session. Owned once by App.vue and
// shared by both consumers so header/dock badge and the TeamStatusPanel always
// read the same snapshot — one poll, no drift:
//   - the chat dock's 「团队 (working/total)」 tab badge (summary counts);
//   - the /team right-side TeamStatusPanel (full roster).
// Previously TeamStatusPanel polled `GET /teams/{sid}/members` on its own while
// mounted; lifting the poll here keeps it alive for the badge even when the
// panel is closed, and removes the double-poll when it is open.
//
// Counting contract: `summary.working` = members whose status is `'working'`
// (the team lifecycle status, not subagent task state), `summary.total` = all
// roster members across global + project scopes — see lib/teamRows.summarizeTeam.

import { computed, onMounted, watch, type Ref } from 'vue';
import { getKimiWebApi } from '../api';
import type { AppTeamMembers } from '../api/types';
import { filterUserTeamMembers, summarizeTeam, type TeamRosterSummary } from '../lib/teamRows';
import { usePolling } from './usePolling';

/** Same cadence as the TeamPanel dialog / the old in-panel poll (2.5s). */
const POLL_MS = 2500;

const EMPTY_SUMMARY: TeamRosterSummary = { total: 0, working: 0, onDuty: 0, resting: 0, offDuty: 0 };

export function useTeamRoster(sessionId: Ref<string | null>) {
  const api = getKimiWebApi();

  // The fetch guards the session id: with no active session the poll ticks
  // resolve to null without hitting the network.
  const roster = usePolling<AppTeamMembers | null>(
    () => (sessionId.value ? api.getTeamMembers(sessionId.value) : Promise.resolve(null)),
    POLL_MS,
  );

  /** Roster with engine built-in default profiles (agent/coder/explore/plan)
   *  filtered out — panel + dock badge only count user-created members. Kept
   *  as a separate computed so the raw polled `data` stays the source of truth
   *  (edit-realtime patching / future consumers can still see it). */
  const members = computed<AppTeamMembers | null>(() => {
    const raw = roster.data.value;
    if (!raw) return null;
    return {
      ...raw,
      global: filterUserTeamMembers(raw.global),
      project: filterUserTeamMembers(raw.project),
    };
  });

  /** working / total for the badge, aggregated across global + project scopes. */
  const summary = computed<TeamRosterSummary>(() => {
    const m = members.value;
    if (!m) return EMPTY_SUMMARY;
    return summarizeTeam([...m.global, ...m.project]);
  });

  // Poll only while a session is active; on session switch drop the previous
  // roster and refetch immediately so the badge never shows a stale team.
  watch(
    sessionId,
    (id, oldId) => {
      if (!id) {
        roster.stop();
        return;
      }
      if (id !== oldId) {
        roster.data.value = null;
        roster.loading.value = true;
        roster.start();
        void roster.refresh();
      } else {
        roster.start();
      }
    },
    { immediate: true },
  );

  // usePolling starts on mount unconditionally; keep the timer stopped while no
  // session exists (the fetch guard alone would otherwise tick forever).
  onMounted(() => {
    if (!sessionId.value) roster.stop();
  });

  return { data: roster.data, members, loading: roster.loading, error: roster.error, summary };
}
