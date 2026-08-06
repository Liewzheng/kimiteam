<!-- apps/kimi-web/src/components/team/TeamStatusPanel.vue -->
<!-- /team right-side panel — READ-ONLY subagent roster for the CURRENT session.
     Same data source as the TeamPanel management dialog (GET /teams/{sid}/members,
     2.5s poll) and the same lib/teamRows derivations, but no management actions:
     this phase only ships the status view.
     The roster poll is LIFTED to App.vue (useTeamRoster) and shared with the
     chat dock's 「团队 (working/total)」 badge, so this panel receives the roster
     as props instead of polling on mount — one poll, no drift, no double-fetch
     while the panel and the dock badge are both live. -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppTeamMember, AppTeamMembers } from '../../api/types';
import {
  sortTeamMembers,
  summarizeTeam,
  toMemberCards,
  type TeamMemberCard,
} from '../../lib/teamRows';
import Badge from '../ui/Badge.vue';
import Card from '../ui/Card.vue';
import EmptyState from '../ui/EmptyState.vue';
import Icon from '../ui/Icon.vue';
import PanelHeader from '../ui/PanelHeader.vue';
import Spinner from '../ui/Spinner.vue';

const props = defineProps<{
  /** Latest roster for the active session (null until the first poll lands). */
  members: AppTeamMembers | null;
  /** True until the first roster fetch settles. */
  loading: boolean;
  /** Last fetch error message; surfaced only while nothing has loaded yet. */
  error: string | null;
}>();

const emit = defineEmits<{
  close: [];
  /** A member card was activated (click / Enter / Space) — open its detail.
   *  The detail panel wiring lands in a separate change; this only exposes the
   *  contract. */
  select: [member: AppTeamMember];
}>();

const { t } = useI18n();

// Dual-scope aggregation happens here, one section at a time (same as TeamPanel).
const globalRows = computed(() => sortTeamMembers(props.members?.global ?? []));
const projectRows = computed(() => sortTeamMembers(props.members?.project ?? []));
const summaryGlobal = computed(() => summarizeTeam(props.members?.global ?? []));
const summaryProject = computed(() => summarizeTeam(props.members?.project ?? []));
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
    cards: toMemberCards(globalRows.value),
    summary: summaryGlobal.value,
  },
  {
    key: 'project',
    titleKey: 'projectTeam',
    pathKey: 'projectScopePath',
    rows: projectRows.value,
    cards: toMemberCards(projectRows.value),
    summary: summaryProject.value,
  },
]);

function cardAria(card: TeamMemberCard): string {
  return t('team.memberCardAria', {
    name: card.name,
    status: t('team.status.' + card.statusKey),
  });
}

// Keep last-known roster on later poll failures; surface the error only while
// nothing has loaded yet.
const loadFailed = computed(() => props.error !== null && props.members === null);
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
            <!-- Member cards in a responsive grid: 4/row on a wide panel,
                 3/row at the default width, 2/row when the panel is narrowed.
                 `cards` is a 1:1 map of `rows` (same order), so `rows[i]` is the
                 member behind card `i` — used for the select payload + duty. -->
            <Card
              v-for="(card, i) in sec.cards"
              :key="`${sec.key}-${card.name}`"
              class="tsp-card"
              role="button"
              tabindex="0"
              :aria-label="cardAria(card)"
              @click="emit('select', sec.rows[i]!)"
              @keydown.enter.prevent="emit('select', sec.rows[i]!)"
              @keydown.space.prevent="emit('select', sec.rows[i]!)"
            >
              <div class="tsp-card-rows">
                <div class="tsp-card-name">
                  <span class="tsp-name" :title="card.name">{{ card.name }}</span>
                  <span class="tsp-status">({{ t('team.status.' + card.statusKey) }})</span>
                  <Badge v-if="sec.rows[i]!.duty" variant="warning" size="sm">{{ t('team.dutyBadge') }}</Badge>
                </div>
                <div class="tsp-card-row tsp-title" :title="card.title">{{ card.title }}</div>
                <div class="tsp-card-row tsp-model" :title="card.model">{{ card.model }}</div>
                <div class="tsp-card-row tsp-score">
                  <Icon name="star" size="sm" />
                  {{ card.scoreLabel ?? t('team.scoreNone') }}
                </div>
              </div>
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
  /* Container for the member-card grid: the panel's inner width is pinned to
     `--preview-w` (the aside content is a fixed-width column), so breakpoints
     key off the container, not the viewport. */
  container-type: inline-size;
  container-name: tsp;
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
  /* Member-card grid. Default (the panel's normal ~460px width): 3 columns.
     Wider panel → 4; a narrowed panel (<420px) falls back to 2 so cards never
     collapse to unusable slivers. `minmax(0, 1fr)` lets grid items shrink so
     the per-card ellipsis truncation actually kicks in. */
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-2);
  align-items: stretch;
}
/* 4 columns on a wide panel (user drags the resize handle past 640px). */
@container tsp (min-width: 640px) {
  .tsp-list { grid-template-columns: repeat(4, minmax(0, 1fr)); }
}
/* 2 columns on a heavily narrowed panel (down to PREVIEW_MIN 320px). */
@container tsp (max-width: 419px) {
  .tsp-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

/* Clickable member card — compact 4-row stack. */
.tsp-card {
  min-width: 0;
  cursor: pointer;
  transition: border-color var(--duration-fast) var(--ease-out);
}
.tsp-card:hover { border-color: var(--color-line-strong); }
.tsp-card:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.tsp-card :deep(.ui-card__body) { padding: var(--space-2) var(--space-3); }

.tsp-card-rows {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.tsp-card-name {
  display: flex;
  align-items: baseline;
  gap: 4px;
  min-width: 0;
}
.tsp-name {
  font-weight: var(--weight-semibold);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tsp-status {
  flex: none;
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  white-space: nowrap;
}
.tsp-card-row {
  font-size: var(--text-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.tsp-title { color: var(--color-text-muted); }
.tsp-model { color: var(--color-text-faint); font-family: var(--font-mono); }
.tsp-score {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--color-text);
  font-weight: var(--weight-medium);
}
.tsp-score :deep(svg) { flex: none; }
</style>
