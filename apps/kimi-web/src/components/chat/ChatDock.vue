<!-- ChatDock.vue -->
<!-- Bottom dock that belongs to the chat tab: goal strip, running-task chips, -->
<!-- pending question/approval cards, and the composer. Only rendered inside a -->
<!-- chat-pane group so it never leaks into files/tasks/preview/btw panes. -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ActivationBadges, ApprovalBlock, ConversationStatus, PermissionMode, QueuedPromptView, TaskItem, TodoView, UIQuestion } from '../../types';
import type { AppGoal, AppModel, AppSkill, QuestionResponse, ThinkingLevel } from '../../api/types';
import type { FileItem } from './MentionMenu.vue';
import type { PromptAttachment } from '../../composables/useKimiWebClient';
import Composer from './Composer.vue';
import GoalStrip from './GoalStrip.vue';
import QuestionCard from './QuestionCard.vue';
import ApprovalCard from './ApprovalCard.vue';
import TasksPane from './TasksPane.vue';
import TodoCard from './TodoCard.vue';
import Icon from '../ui/Icon.vue';
import Pill from '../ui/Pill.vue';
import SegmentedControl from '../ui/SegmentedControl.vue';
import { teamTabState } from '../../lib/teamRows';

const props = defineProps<{
  sessionId?: string;
  running?: boolean;
  /** True while the empty-composer first prompt is being created + submitted.
   *  Covers the gap where draft-session creation already selected the new
   *  session (empty state → dock) before the first prompt is submitted. */
  starting?: boolean;
  queued?: QueuedPromptView[];
  searchFiles?: (q: string) => Promise<FileItem[]>;
  uploadImage?: (file: Blob, name?: string) => Promise<{ fileId: string; name: string; mediaType: string } | null>;
  status: ConversationStatus;
  thinking?: ThinkingLevel;
  planMode?: boolean;
  swarmMode?: boolean;
  goalMode?: boolean;
  activationBadges?: ActivationBadges;
  models?: AppModel[];
  starredIds?: string[];
  skills?: AppSkill[];
  goal?: AppGoal | null;
  goalExpandSignal?: number;
  dockPanel: 'bash' | 'todos' | null;
  bashTasks: TaskItem[];
  bashRunning: number;
  todoDoneCount: number;
  /** Team roster counts for the standing 「团队 (working/total)」 tab. */
  teamWorking: number;
  teamTotal: number;
  /** True while the right-side TeamStatusPanel is open for this session. */
  teamActive?: boolean;
  todos?: TodoView[];
  /** Completed-todo history of the session — rendered in the todos panel's
   *  history view (TUI `/todo` parity). */
  todoHistory?: TodoView[];
  /** Increment to switch the todos panel to the completed-history view (the
   *  `/todo` command entry). Same signal pattern as GoalStrip's expand signal. */
  todoHistorySignal?: number;
  pendingQuestion?: UIQuestion;
  /** Action kind in flight for the visible question (drives loading state). */
  questionBusyKind?: 'answer' | 'dismiss';
  pendingApproval?: { approvalId: string; block: ApprovalBlock; agentName?: string };
  /** True while the visible approval has a respond in flight. */
  approvalBusy?: boolean;
  mobile?: boolean;
}>();

const emit = defineEmits<{
  submit: [payload: { text: string; attachments: PromptAttachment[] }];
  steer: [payload: { text: string; attachments: PromptAttachment[] }];
  command: [cmd: string];
  interrupt: [];
  setPermission: [mode: PermissionMode];
  setThinking: [level: ThinkingLevel];
  togglePlan: [];
  toggleSwarm: [];
  toggleGoal: [];
  openBtw: [];
  createGoal: [objective: string];
  controlGoal: [action: 'pause' | 'resume' | 'cancel'];
  focusGoal: [];
  focusSwarm: [];
  compact: [];
  pickModel: [];
  selectModel: [modelId: string];
  answer: [questionId: string, response: QuestionResponse];
  dismiss: [questionId: string];
  approval: [approvalId: string, response: { decision: 'approved' | 'rejected' | 'cancelled'; scope?: 'session'; feedback?: string; selectedLabel?: string }];
  cancelTask: [taskId: string];
  'toggle-dock-panel': [panel: 'bash' | 'todos'];
  'close-dock-panel': [];
  /** The standing 「团队 (working/total)」 tab was clicked — open the
   *  right-side TeamStatusPanel for the active session. */
  openTeam: [];
}>();

const { t } = useI18n();

/** Derived highlight / disabled state for the team tab (pure, tested). */
const teamState = computed(() =>
  teamTabState({
    working: props.teamWorking,
    total: props.teamTotal,
    hasSession: !!props.sessionId,
  }),
);
/** Todos panel view: the live list (default) or the session's completed-work
 *  history. Reset to the live list whenever the panel closes, so reopening via
 *  the 待办 tab always lands on the current state. */
const todosView = ref<'active' | 'history'>('active');
const todoViewOptions = computed(() => [
  { value: 'active', label: t('tasks.todoActive') },
  { value: 'history', label: t('tasks.todoHistory') },
]);
/** Count badge for the todos tab / panel head: the live list's done/total when
 *  the list exists, otherwise the completed-history count (an all-done or
 *  cleared session can have history with an empty live list). */
const todoBadge = computed(() => {
  if ((props.todos?.length ?? 0) > 0) return `${props.todoDoneCount}/${props.todos!.length}`;
  if ((props.todoHistory?.length ?? 0) > 0) return String(props.todoHistory!.length);
  return '';
});
const composerRef = ref<{
  loadForEdit: (value: string) => boolean;
  loadAttachmentsForEdit: (atts: { fileId?: string; kind: 'image' | 'video' | 'file'; url: string; name?: string }[]) => void;
  focus: () => void;
} | null>(null);
const workPanelRef = ref<HTMLElement | null>(null);
const workbarRef = ref<HTMLElement | null>(null);
const dockRef = ref<HTMLElement | null>(null);

function loadForEdit(value: string): boolean {
  // The nested Composer is only rendered in ChatDock's v-else — when a pending
  // question or approval is shown it is unmounted, so report unavailability so
  // the caller doesn't dequeue a prompt it can't actually load.
  if (!composerRef.value) return false;
  composerRef.value.loadForEdit(value);
  return true;
}

function loadAttachmentsForEdit(atts: { fileId?: string; kind: 'image' | 'video' | 'file'; url: string; name?: string }[]): void {
  composerRef.value?.loadAttachmentsForEdit(atts);
}

function focus(): void {
  composerRef.value?.focus();
}

function onDocumentMouseDown(event: MouseEvent): void {
  if (!props.dockPanel) return;
  const target = event.target as Node | null;
  if (!target) return;
  if (workPanelRef.value?.contains(target)) return;
  if (workbarRef.value?.contains(target)) return;
  emit('close-dock-panel');
}

watch(
  () => props.dockPanel,
  (panel) => {
    if (typeof document === 'undefined') return;
    document.removeEventListener('mousedown', onDocumentMouseDown, true);
    if (panel) document.addEventListener('mousedown', onDocumentMouseDown, true);
    // Leaving the todos panel resets its view so the tab always reopens on the
    // live list (only `/todo` jumps straight to history).
    if (panel !== 'todos') todosView.value = 'active';
  },
  { immediate: true },
);

// `/todo` command entry: bump the signal to switch the open todos panel to the
// completed-history view (TUI parity). No-op while the panel is closed — the
// next open renders whatever view is current.
watch(
  () => props.todoHistorySignal,
  (n) => {
    if (n !== undefined && n > 0) todosView.value = 'history';
  },
);

let dockResizeObserver: ResizeObserver | null = null;

function publishDockHeight(): void {
  // Border-box height of the dock, exposed so fixed overlays (e.g. toasts) can
  // anchor just above the composer. offsetHeight includes the dock's own
  // safe-area padding, so consumers don't need to add safe-bottom again.
  const height = dockRef.value?.offsetHeight ?? 0;
  document.documentElement.style.setProperty('--dock-h', `${height}px`);
}

onMounted(() => {
  if (typeof ResizeObserver !== 'function' || !dockRef.value) return;
  dockResizeObserver = new ResizeObserver(publishDockHeight);
  dockResizeObserver.observe(dockRef.value);
  publishDockHeight();
});

onUnmounted(() => {
  if (typeof document !== 'undefined') {
    document.removeEventListener('mousedown', onDocumentMouseDown, true);
  }
  dockResizeObserver?.disconnect();
  dockResizeObserver = null;
});

defineExpose({ loadForEdit, loadAttachmentsForEdit, focus });
</script>

<template>
  <div ref="dockRef" class="chat-dock" :class="[mobile ? 'align-mobile' : 'align-center']" @click.stop>
    <Transition name="dock-panel">
      <div
        ref="workPanelRef"
        v-if="dockPanel"
        class="dock-work-panel"
        @click.stop
      >
        <div class="dock-work-head">
          <span
            v-if="dockPanel === 'bash'"
            class="dock-work-tab static"
          >
            {{ t('tasks.dockBash') }} · {{ bashRunning }} {{ t('tasks.running') }}
          </span>
          <template v-else-if="dockPanel === 'todos'">
            <SegmentedControl
              v-model="todosView"
              size="sm"
              class="dock-todo-views"
              :options="todoViewOptions"
              :aria-label="t('tasks.dockTodos')"
            />
            <span
              v-if="todoBadge"
              class="dock-work-tab static dock-todo-count"
            >
              {{ todoBadge }}
            </span>
          </template>
        </div>
        <div class="dock-work-body">
          <TasksPane
            v-if="dockPanel === 'bash'"
            :tasks="bashTasks"
            @cancel="emit('cancelTask', $event)"
          />
          <TodoCard
            v-else-if="dockPanel === 'todos'"
            :todos="todos ?? []"
            :history="todoHistory ?? []"
            :view="todosView"
          />
        </div>
      </div>
    </Transition>

    <GoalStrip
      v-if="goal"
      :goal="goal"
      :force-expanded="goalExpandSignal"
      @control-goal="emit('controlGoal', $event)"
    />
    <div ref="workbarRef" class="dock-workbar">
      <!-- Standing team entry — replaces the old conditional 子Agent tab.
           Clicking opens the right-side TeamStatusPanel (not a dock panel), so
           it is always visible: the dock tabs below stay conditional on work. -->
      <Pill
        class="dw-team"
        :hot="teamState.hot"
        :active="teamActive"
        :aria-pressed="teamActive"
        :disabled="teamState.disabled"
        @click="emit('openTeam')"
      >
        <Icon name="team" size="md" />
        <span>{{ t('tasks.teamTab') }}</span>
        <span class="dw-count">(<b>{{ teamWorking }}</b>/<b>{{ teamTotal }}</b>)</span>
      </Pill>
      <Pill
        v-if="bashTasks.length > 0"
        :active="dockPanel === 'bash'"
        :aria-pressed="dockPanel === 'bash'"
        @click="emit('toggle-dock-panel', 'bash')"
      >
        <Icon name="clock" size="md" />
        <span>{{ t('tasks.dockBash') }}</span>
        <span class="dw-count">(<b>{{ bashTasks.length }}</b>)</span>
      </Pill>
      <Pill
        v-if="(todos?.length ?? 0) > 0 || (todoHistory?.length ?? 0) > 0"
        :active="dockPanel === 'todos'"
        :aria-pressed="dockPanel === 'todos'"
        @click="emit('toggle-dock-panel', 'todos')"
      >
        <Icon name="check-list" size="md" />
        <span>{{ t('tasks.dockTodos') }}</span>
        <span v-if="todoBadge" class="dw-count">(<b>{{ todoBadge }}</b>)</span>
      </Pill>
    </div>

    <QuestionCard
      v-if="pendingQuestion"
      :key="pendingQuestion.questionId"
      :question="pendingQuestion"
      :busy-kind="questionBusyKind"
      @answer="(qid, resp) => emit('answer', qid, resp)"
      @dismiss="emit('dismiss', $event)"
    />
    <ApprovalCard
      v-else-if="pendingApproval"
      :key="pendingApproval.approvalId"
      class="dock-approval"
      :block="pendingApproval.block"
      :agent-name="pendingApproval.agentName"
      :busy="approvalBusy"
      @decide="emit('approval', pendingApproval!.approvalId, $event)"
    />
    <Composer
      v-else
      ref="composerRef"
      :session-id="sessionId"
      :running="running"
      :queued="queued"
      :search-files="searchFiles"
      :upload-image="uploadImage"
      :status="status"
      :thinking="thinking"
      :plan-mode="planMode"
      :swarm-mode="swarmMode"
      :goal-mode="goalMode"
      :goal="goal"
      :activation-badges="activationBadges"
      :models="models"
      :starred-ids="starredIds"
      :skills="skills"
      :starting="starting"
      @submit="emit('submit', $event)"
      @steer="emit('steer', $event)"
      @command="emit('command', $event)"
      @interrupt="emit('interrupt')"
      @set-permission="emit('setPermission', $event)"
      @set-thinking="emit('setThinking', $event)"
      @toggle-plan="emit('togglePlan')"
      @toggle-swarm="emit('toggleSwarm')"
      @toggle-goal="emit('toggleGoal')"
      @open-btw="emit('openBtw')"
      @create-goal="emit('createGoal', $event)"
      @control-goal="emit('controlGoal', $event)"
      @focus-goal="emit('focusGoal')"
      @focus-swarm="emit('focusSwarm')"
      @compact="emit('compact')"
      @pick-model="emit('pickModel')"
      @select-model="emit('selectModel', $event)"
    />
  </div>
</template>

<style scoped>
.chat-dock {
  --dock-inline-left: 16px;
  --dock-inline-right: 16px;
  box-sizing: border-box;
  width: 100%;
  max-width: calc(var(--read-max) + var(--panes-scrollbar-width, 0px));
  padding-right: var(--panes-scrollbar-width, 0px);
  flex: none;
  position: relative;
  background: var(--color-bg);
  z-index: var(--z-sticky);
}
.chat-dock.align-center { margin-left: auto; margin-right: auto; }
.chat-dock.align-left { margin-left: 0; margin-right: auto; }
.chat-dock.align-mobile { max-width: none; }

.dock-work-panel {
  position: absolute;
  left: 16px;
  right: calc(16px + var(--panes-scrollbar-width, 0px));
  bottom: 100%;
  background: var(--color-surface);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  margin-bottom: 7px;
  max-height: min(360px, 50vh);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.dock-work-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--color-line);
}
.dock-work-tab {
  font-size: var(--text-base);
  font-weight: 500;
  color: var(--color-text);
  padding: 3px 8px;
  border-radius: var(--radius-sm);
  background: var(--color-surface-sunken);
  border: 1px solid var(--color-line);
}
.dock-work-tab.static {
  background: transparent;
  border-color: transparent;
  padding-left: 2px;
}
.dock-todo-views { margin-left: auto; }
.dock-todo-count { margin-left: 6px; font-variant-numeric: tabular-nums; }
.dock-work-body {
  padding: 8px 10px;
  overflow-y: auto;
  min-height: 0;
}
.dock-work-body :deep(.taskspane) {
  border: none;
  background: transparent;
  padding: 0;
}
.dock-work-body :deep(.taskspane .tp-head) {
  display: none;
}

.dock-workbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px var(--dock-inline-right) 2px var(--dock-inline-left);
}
.dock-workbar .dw-count { margin-left: 1px; }
.dock-workbar .dw-count b { font-weight: 500; }

.dock-approval {
  margin-top: 8px;
}

@media (max-width: 640px) {
  .chat-dock {
    /* Inline (landscape) safe-area lives here only; the inner composer /
       workbar read --dock-inline-* so the inset is applied exactly once. */
    --dock-inline-left: max(12px, var(--safe-left));
    --dock-inline-right: max(12px, var(--safe-right));
  }
  .dock-work-panel {
    left: 10px;
    right: calc(10px + var(--panes-scrollbar-width, 0px));
  }
}

.chat-dock:not(.align-mobile) :deep(.composer) {
  padding-bottom: 14px;
}

.dock-panel-enter-active,
.dock-panel-leave-active {
  transition: opacity 0.16s ease, transform 0.16s ease;
}
.dock-panel-enter-from,
.dock-panel-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
