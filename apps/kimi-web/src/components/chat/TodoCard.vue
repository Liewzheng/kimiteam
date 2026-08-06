<!-- apps/kimi-web/src/components/chat/TodoCard.vue -->
<!-- Read-only todo list driven by the model's TodoList tool. Two views, switched
     by the dock panel head:
       - 'active'  (default): the live list — latest full-list write wins.
       - 'history': the session's completed-work history (TUI /todo parity) —
         each row is `todo num / who / what done`, aggregated across every
         TodoList write by composables/latestTodos.todoHistory.
     Rows share StatusGlyph with the background bash/subagent task list so the
     two stay visually identical. -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { TodoView } from '../../types';
import StatusGlyph, { type StatusGlyphStatus } from './StatusGlyph.vue';

const props = defineProps<{
  todos: TodoView[];
  /** Completed-work history (done items across every TodoList write). */
  history?: TodoView[];
  /** Which view to render — 'active' (live list) or 'history' (completed). */
  view?: 'active' | 'history';
}>();

const { t } = useI18n();

function glyphStatus(status: TodoView['status']): StatusGlyphStatus {
  return status === 'in_progress' ? 'run' : status;
}

/** Empty state is per-view: the live list or the completed history. */
const isEmpty = computed(() =>
  props.view === 'history' ? (props.history?.length ?? 0) === 0 : props.todos.length === 0,
);
const emptyText = computed(() =>
  props.view === 'history' ? t('tasks.emptyTodoHistory') : t('tasks.emptyTodo'),
);

/** Stable key: the todo id when present, else the row position (history items
 *  without an id are legacy pre-extension entries — position is stable enough
 *  since the list is deduped and sorted by the composable). */
function historyKey(td: TodoView, index: number): string {
  return td.id !== undefined && td.id.length > 0 ? td.id : `h${index}`;
}
</script>

<template>
  <div class="todo-card">
    <!-- Single empty state, shared by both views (text varies). -->
    <div v-if="isEmpty" class="tc-empty">
      <svg class="tc-empty-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M9 11l2 2 4-4" />
        <rect x="4" y="4" width="16" height="16" rx="3" />
      </svg>
      <span>{{ emptyText }}</span>
    </div>

    <!-- Completed-work history: todo num / who / what done (TUI /todo parity). -->
    <template v-else-if="props.view === 'history'">
      <div
        v-for="(td, i) in props.history ?? []"
        :key="historyKey(td, i)"
        class="tc-row tc-history"
      >
        <StatusGlyph status="done" />
        <span class="tc-num">{{ td.id ?? i + 1 }}</span>
        <span class="tc-who">{{ td.assignee || '—' }}</span>
        <span class="tc-what">{{ td.whatDone || td.title || '—' }}</span>
      </div>
    </template>

    <!-- Live list (default). -->
    <template v-else>
      <div v-for="(td, i) in props.todos" :key="i" class="tc-row" :class="`s-${td.status}`">
        <StatusGlyph :status="glyphStatus(td.status)" />
        <span class="tc-name">{{ td.title }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.todo-card {
  display: flex;
  flex-direction: column;
  gap: 1px;
  font-size: var(--text-base);
}

.tc-row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 0;
  color: var(--color-text);
}
.tc-name { flex: 1; min-width: 0; overflow-wrap: anywhere; line-height: 1.4; }
.tc-row.s-in_progress .tc-name { font-weight: var(--weight-medium); }
.tc-row.s-done .tc-name {
  color: var(--color-text-faint);
  text-decoration: line-through;
}

/* Completed-history rows: `num / who / what done` — aligned like the TUI /todo
   list. `num` is the stable id (or position); `who` the assignee (accent, may
   ellipsize); `what` wraps. */
.tc-history { align-items: baseline; }
.tc-num {
  flex: none;
  min-width: 26px;
  font-weight: var(--weight-medium);
  font-variant-numeric: tabular-nums;
}
.tc-who {
  flex: none;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-accent);
  font-weight: var(--weight-medium);
}
.tc-what {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
  line-height: 1.4;
}

.tc-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-6) var(--space-4);
  color: var(--color-text-faint);
  font-size: var(--text-sm);
}
.tc-empty-ico { width: 28px; height: 28px; color: var(--color-line-strong); }

/* Mobile (~/todo tab): match the chat font bump; row spacing opens up. */
@media (max-width: 640px) {
  .todo-card { font-size: var(--text-lg); }
  .tc-row { padding: var(--space-2) var(--space-3); }
}
</style>
