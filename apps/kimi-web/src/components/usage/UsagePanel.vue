<!-- apps/kimi-web/src/components/usage/UsagePanel.vue -->
<!-- /usage right-side panel — subagent token usage for the CURRENT session.
     Reads GET /teams/{sid}/usage (2.5s poll, same cadence as the team roster)
     and renders two sections: by model and by member, each row showing
     input / output / total tokens. The `__secondary__` derived-model alias is
     resolved to the real model id by lib/usageRows before rendering. -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { getKimiWebApi } from '../../api';
import { usePolling } from '../../composables/usePolling';
import { formatTokens } from '../../lib/formatTokens';
import {
  memberUsageRows,
  modelUsageRows,
  normalizeTeamUsage,
  tokenTotal,
  type UsageAmountRow,
} from '../../lib/usageRows';
import EmptyState from '../ui/EmptyState.vue';
import PanelHeader from '../ui/PanelHeader.vue';
import Spinner from '../ui/Spinner.vue';

const props = defineProps<{
  /** The session whose usage this panel shows (the active session). */
  sessionId: string;
}>();

const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();

const api = getKimiWebApi();

// ---------------------------------------------------------------------------
// Usage state + polling (2.5s, same cadence as the team roster)
// ---------------------------------------------------------------------------
const POLL_MS = 2500;

const { data, loading, error } = usePolling(() => api.getTeamUsage(props.sessionId), POLL_MS);

const usage = computed(() => (data.value ? normalizeTeamUsage(data.value) : null));
const modelRows = computed<UsageAmountRow[]>(() => (usage.value ? modelUsageRows(usage.value) : []));
const memberRows = computed<UsageAmountRow[]>(() => (usage.value ? memberUsageRows(usage.value) : []));

const totalTokens = computed(() => {
  const u = usage.value;
  if (!u) return 0;
  let total = 0;
  for (const row of Object.values(u.byModel)) total += tokenTotal(row);
  return total;
});

const isEmpty = computed(() => {
  if (usage.value === null) return false;
  return modelRows.value.length === 0 && memberRows.value.length === 0;
});

// Keep last-known usage on later poll failures; surface the error only while
// nothing has loaded yet.
const loadFailed = computed(() => error.value !== null && data.value === null);
</script>

<template>
  <div class="up">
    <PanelHeader
      :title="t('usage.panelTitle')"
      :subtitle="t('usage.description')"
      :close-label="t('thinking.close')"
      @close="emit('close')"
    >
      <span class="up-runs">{{ t('usage.runs', { count: usage?.runs ?? 0 }) }}</span>
    </PanelHeader>

    <div class="up-body">
      <div v-if="loading" class="up-loading">
        <Spinner size="sm" />
        {{ t('usage.loading') }}
      </div>

      <div v-else-if="loadFailed" class="up-empty">
        <EmptyState :title="t('usage.loadFailed', { error })" />
      </div>

      <div v-else-if="isEmpty" class="up-empty">
        <EmptyState :title="t('usage.empty')" :hint="t('usage.emptyHint')" />
      </div>

      <div v-else class="up-content">
        <section class="up-section">
          <header class="up-section-head">
            <span class="up-section-title">{{ t('usage.byModel') }}</span>
            <span class="up-spacer" />
            <span class="up-total-tokens">{{ t('usage.totalTokens', { tokens: formatTokens(totalTokens) }) }}</span>
          </header>
          <div v-if="modelRows.length === 0" class="up-section-empty">
            {{ t('usage.noRows') }}
          </div>
          <div v-else class="up-rows">
            <div v-for="row in modelRows" :key="`m-${row.label}`" class="up-row">
              <span class="up-label" :title="row.label">{{ row.label }}</span>
              <span class="up-cells">
                <span class="up-cell-label">In</span>
                <span class="up-cell-value">{{ formatTokens(row.input) }}</span>
                <span class="up-cell-label">Out</span>
                <span class="up-cell-value">{{ formatTokens(row.output) }}</span>
                <span class="up-cell-label">Σ</span>
                <span class="up-cell-value up-cell-total">{{ formatTokens(row.input + row.output) }}</span>
              </span>
            </div>
          </div>
        </section>

        <section class="up-section">
          <header class="up-section-head">
            <span class="up-section-title">{{ t('usage.byMember') }}</span>
          </header>
          <div v-if="memberRows.length === 0" class="up-section-empty">
            {{ t('usage.noRows') }}
          </div>
          <div v-else class="up-rows">
            <div v-for="row in memberRows" :key="`p-${row.label}`" class="up-row">
              <span class="up-label" :title="row.label">{{ row.label }}</span>
              <span class="up-cells">
                <span class="up-cell-label">In</span>
                <span class="up-cell-value">{{ formatTokens(row.input) }}</span>
                <span class="up-cell-label">Out</span>
                <span class="up-cell-value">{{ formatTokens(row.output) }}</span>
                <span class="up-cell-label">Σ</span>
                <span class="up-cell-value up-cell-total">{{ formatTokens(row.input + row.output) }}</span>
              </span>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.up {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--color-bg);
}
.up-runs {
  flex: none;
  font-size: var(--text-xs);
  color: var(--color-text-faint);
}

.up-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 14px;
}
.up-loading {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}
.up-empty { height: 100%; }

.up-content {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.up-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}
.up-section-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  padding-bottom: var(--space-1);
  border-bottom: 1px solid var(--color-line);
}
.up-section-title {
  flex: none;
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  color: var(--color-text);
}
.up-spacer { flex: 1; }
.up-total-tokens {
  flex: none;
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
.up-section-empty {
  padding: var(--space-3);
  border: 1px dashed var(--color-line-strong);
  border-radius: var(--radius-md);
  color: var(--color-text-faint);
  font-size: var(--text-sm);
  text-align: center;
}

.up-rows {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.up-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  padding: 7px 10px;
  background: var(--color-surface);
}
.up-row + .up-row {
  border-top: 1px solid var(--color-line);
}
.up-label {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.up-cells {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
.up-cell-label { color: var(--color-text-faint); }
.up-cell-value {
  min-width: 40px;
  text-align: right;
  color: var(--color-text-muted);
}
.up-cell-total {
  min-width: 46px;
  font-weight: var(--weight-medium);
  color: var(--color-text);
}
</style>
