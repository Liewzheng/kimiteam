<!-- apps/kimi-web/src/components/team/TeamStatusPanel.vue -->
<!-- /team right-side panel — READ-ONLY subagent roster for the CURRENT session.
     Same data source as the TeamPanel management dialog (GET /teams/{sid}/members,
     2.5s poll), same lib/teamRows derivations, but no management actions: this
     phase only ships the status view. Mounted with v-if by App's shared right
     side slot, so the poll starts on mount and stops on close automatically. -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { getKimiWebApi } from '../../api';
import type { AppTeamMember } from '../../api/types';
import { usePolling } from '../../composables/usePolling';
import {
  averageScoreLabel,
  sortTeamMembers,
  summarizeTeam,
  teamStatusMeta,
} from '../../lib/teamRows';
import Badge from '../ui/Badge.vue';
import Card from '../ui/Card.vue';
import EmptyState from '../ui/EmptyState.vue';
import Icon from '../ui/Icon.vue';
import PanelHeader from '../ui/PanelHeader.vue';
import Spinner from '../ui/Spinner.vue';

const props = defineProps<{
  /** The session whose team this panel shows (the active session). */
  sessionId: string;
}>();

const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();

const api = getKimiWebApi();

// ---------------------------------------------------------------------------
// Roster state + polling (shared composable, 2.5s like the TeamPanel dialog)
// ---------------------------------------------------------------------------
const POLL_MS = 2500;

const { data, loading, error } = usePolling(() => api.getTeamMembers(props.sessionId), POLL_MS);

// Dual-scope aggregation happens here, one section at a time (same as TeamPanel).
const globalRows = computed(() => sortTeamMembers(data.value?.global ?? []));
const projectRows = computed(() => sortTeamMembers(data.value?.project ?? []));
const summaryGlobal = computed(() => summarizeTeam(data.value?.global ?? []));
const summaryProject = computed(() => summarizeTeam(data.value?.project ?? []));
const summary = computed(() => ({
  total: summaryGlobal.value.total + summaryProject.value.total,
  working: summaryGlobal.value.working + summaryProject.value.working,
  onDuty: summaryGlobal.value.onDuty + summaryProject.value.onDuty,
  resting: summaryGlobal.value.resting + summaryProject.value.resting,
  offDuty: summaryGlobal.value.offDuty + summaryProject.value.offDuty,
}));

const sections = computed(() => [
  {
    key: 'global',
    titleKey: 'globalTeam',
    pathKey: 'globalScopePath',
    rows: globalRows.value,
    summary: summaryGlobal.value,
  },
  {
    key: 'project',
    titleKey: 'projectTeam',
    pathKey: 'projectScopePath',
    rows: projectRows.value,
    summary: summaryProject.value,
  },
]);

function scoreLabel(member: AppTeamMember): string | null {
  return averageScoreLabel(member.score);
}

// Keep last-known roster on later poll failures; surface the error only while
// nothing has loaded yet.
const loadFailed = computed(() => error.value !== null && data.value === null);
</script>

<template>
  <div class="tsp">
    <PanelHeader
      :title="t('team.panelTitle')"
      :subtitle="t('team.description')"
      :close-label="t('thinking.close')"
      @close="emit('close')"
    >
      <span class="tsp-count">{{ t('team.membersCount', { count: summary.total }) }}</span>
    </PanelHeader>

    <div class="tsp-body">
      <div class="tsp-summary">
        <Badge v-if="summary.working > 0" variant="info" size="sm">
          {{ t('team.working', { count: summary.working }) }}
        </Badge>
        <Badge v-if="summary.onDuty > 0" variant="success" size="sm">
          {{ t('team.onDuty', { count: summary.onDuty }) }}
        </Badge>
        <Badge v-if="summary.resting > 0" variant="warning" size="sm">
          {{ t('team.resting', { count: summary.resting }) }}
        </Badge>
        <Badge v-if="summary.offDuty > 0" variant="neutral" size="sm">
          {{ t('team.offDuty', { count: summary.offDuty }) }}
        </Badge>
      </div>

      <div v-if="loading" class="tsp-loading">
        <Spinner size="sm" />
        {{ t('team.loading') }}
      </div>

      <div v-else-if="loadFailed" class="tsp-empty">
        <EmptyState :title="t('team.loadFailed', { error })" />
      </div>

      <div v-else-if="summary.total === 0" class="tsp-empty">
        <EmptyState :title="t('team.empty')" :hint="t('team.emptyHint')" />
      </div>

      <div v-else class="tsp-roster">
        <section
          v-for="sec in sections"
          :key="sec.key"
          class="tsp-scope"
          :data-scope="sec.key"
        >
          <header class="tsp-scope-head">
            <span class="tsp-scope-title">{{ t('team.' + sec.titleKey) }}</span>
            <span class="tsp-scope-count">{{ t('team.membersCount', { count: sec.summary.total }) }}</span>
            <span class="tsp-spacer" />
            <span class="tsp-scope-path">{{ t('team.' + sec.pathKey) }}</span>
          </header>
          <div v-if="sec.rows.length === 0" class="tsp-scope-empty">
            {{ t('team.noMembers') }}
          </div>
          <div v-else class="tsp-list">
            <Card
              v-for="member in sec.rows"
              :key="`${sec.key}-${member.name}`"
              class="tsp-card"
            >
              <template #head>
                <div class="tsp-card-head">
                  <span class="tsp-name" :title="member.name">{{ member.name }}</span>
                  <Badge
                    :variant="teamStatusMeta(member.status).variant"
                    size="sm"
                    dot
                  >{{ t('team.status.' + member.status) }}</Badge>
                  <Badge v-if="member.duty" variant="warning" size="sm">{{ t('team.dutyBadge') }}</Badge>
                  <span class="tsp-spacer" />
                  <span class="tsp-role">{{ member.role }}</span>
                  <span class="tsp-model">{{ member.model }}</span>
                  <Badge v-if="scoreLabel(member)" size="sm" variant="neutral" class="tsp-score">
                    <Icon name="star" size="sm" />
                    {{ scoreLabel(member) }}
                  </Badge>
                  <span v-else class="tsp-score-none">{{ t('team.scoreNone') }}</span>
                </div>
              </template>
            </Card>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tsp {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--color-bg);
}
.tsp-count {
  flex: none;
  font-size: var(--text-xs);
  color: var(--color-text-faint);
}

.tsp-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.tsp-summary {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.tsp-loading {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}
.tsp-empty { flex: 1; }

.tsp-roster {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.tsp-scope {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}
.tsp-scope-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  padding-bottom: var(--space-1);
  border-bottom: 1px solid var(--color-line);
}
.tsp-scope-title {
  flex: none;
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  color: var(--color-text);
}
.tsp-scope-count {
  flex: none;
  font-size: var(--text-xs);
  color: var(--color-text-faint);
}
.tsp-scope-path {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tsp-spacer { flex: 1; }
.tsp-scope-empty {
  padding: var(--space-3);
  border: 1px dashed var(--color-line-strong);
  border-radius: var(--radius-md);
  color: var(--color-text-faint);
  font-size: var(--text-sm);
  text-align: center;
}

.tsp-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.tsp-card { flex: none; }
.tsp-card-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
.tsp-name {
  flex: none;
  font-weight: var(--weight-semibold);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 40%;
}
.tsp-role {
  flex: none;
  font-size: var(--text-xs);
  font-family: var(--font-ui);
  font-weight: var(--weight-regular);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 20%;
}
.tsp-model {
  flex: 0 1 auto;
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tsp-score { flex: none; }
.tsp-score :deep(svg) { flex: none; }
.tsp-score-none {
  flex: none;
  font-size: var(--text-xs);
  color: var(--color-text-faint);
}
</style>
