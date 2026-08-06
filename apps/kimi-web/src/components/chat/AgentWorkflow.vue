<!-- apps/kimi-web/src/components/chat/AgentWorkflow.vue -->
<!-- Shared "what the agent is doing" block — the task prompt, the live output
     stream and the grouped tool-progress log of a subagent / team member.
     Used by both AgentDetailPanel (subagent detail, right-side slot) and
     TeamMemberDetailPanel (team-member detail, lower half), extracted so the
     streaming rendering + fold logic live in one tested place.

     The content is reactive: a still-running agent keeps streaming here. The
     embedding panel passes its scroll container via `scrollTarget` and this
     block follows the bottom while content grows, unless the user scrolled up
     (same behaviour the old AgentDetailPanel had on its own body). -->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AgentMember, FilePreviewRequest } from '../../types';
import { shouldRenderMarkdown } from '../../lib/messageFormatting';
import {
  groupProgress,
  progressFoldCount,
  PROGRESS_FOLD_THRESHOLD,
  PROGRESS_HEAD,
  PROGRESS_TAIL,
} from '../../lib/agentProgress';
import Markdown from './Markdown.vue';

const props = defineProps<{
  member: AgentMember;
  /** Optional scroll container to follow to the bottom while content streams
   *  (the embedding panel's body element). Omit to disable follow. */
  scrollTarget?: HTMLElement | null;
}>();

const emit = defineEmits<{ openFile: [target: FilePreviewRequest] }>();

const { t } = useI18n();

const progressLines = computed(() =>
  (props.member.outputLines ?? [])
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0),
);

/** The agent's concatenated live output (assistant deltas). Trimmed for
 *  display; grows in real time as deltas stream in. */
const liveText = computed(() => (props.member.text ?? '').trimEnd());

// The task prompt and live output are agent-facing prose (a TeamMessage the
// lead sent / the agent's formatted reply) and render Markdown; tool-progress
// lines stay a mono log. Decision lives in the tested lib/messageFormatting.
const mdFields = {
  task: shouldRenderMarkdown('subagent-task'),
  output: shouldRenderMarkdown('subagent-output'),
};

const progressGroups = computed(() => groupProgress(progressLines.value));

/** Group keys whose folded output is expanded. */
const expandedGroups = ref<Set<string>>(new Set());

function isExpanded(key: string): boolean {
  return expandedGroups.value.has(key);
}
function toggleGroup(key: string): void {
  const next = new Set(expandedGroups.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expandedGroups.value = next;
}

// Follow the bottom as the tool progress or the live text grows, as long as
// the user hasn't scrolled up (matches the old AgentDetailPanel behaviour).
watch(
  [() => progressLines.value.length + liveText.value.length, () => props.scrollTarget],
  () => {
    const el = props.scrollTarget;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (!atBottom) return;
    void nextTick(() => {
      if (props.scrollTarget) props.scrollTarget.scrollTop = props.scrollTarget.scrollHeight;
    });
  },
  { immediate: true },
);
</script>

<template>
  <div class="aw">
    <div v-if="member.prompt" class="aw-field">
      <span class="aw-field-label">{{ t('common.taskLabel') }}</span>
      <div v-if="mdFields.task" class="aw-field-body aw-md">
        <Markdown :text="member.prompt" :open-file="(target) => emit('openFile', target)" />
      </div>
      <div v-else class="aw-field-body">{{ member.prompt }}</div>
    </div>

    <div v-if="liveText" class="aw-field">
      <span class="aw-field-label">{{ t('common.outputLabel') }}</span>
      <div v-if="mdFields.output" class="aw-field-body aw-md">
        <Markdown :text="liveText" :open-file="(target) => emit('openFile', target)" />
      </div>
      <div v-else class="aw-field-body aw-live">{{ liveText }}</div>
    </div>

    <div v-if="progressGroups.length > 0" class="aw-field">
      <span class="aw-field-label">{{ t('common.progressLabel') }}</span>
      <div class="aw-field-body aw-progress">
        <div v-for="group in progressGroups" :key="group.key" class="aw-group">
          <div v-if="group.call" class="aw-call">
            <span class="aw-glyph" aria-hidden="true">▶</span>
            {{ group.call }}
          </div>
          <div v-if="group.output.length > 0" class="aw-output">
            <template v-if="group.output.length <= PROGRESS_FOLD_THRESHOLD || isExpanded(group.key)">
              <div v-for="(line, li) in group.output" :key="li" class="aw-out-line">{{ line }}</div>
            </template>
            <template v-else>
              <div v-for="(line, li) in group.output.slice(0, PROGRESS_HEAD)" :key="li" class="aw-out-line">{{ line }}</div>
              <button type="button" class="aw-fold" @click="toggleGroup(group.key)">
                … ({{ progressFoldCount(group) }} more)
              </button>
              <div v-for="(line, li) in group.output.slice(-PROGRESS_TAIL)" :key="'t' + li" class="aw-out-line">{{ line }}</div>
            </template>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.aw {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.aw-field {
  min-width: 0;
}
.aw-field-label {
  display: block;
  color: var(--color-text-muted);
  font: var(--text-xs) var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 4px;
}
.aw-field-body {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
/* Markdown-rendered prose field (task / live output). The inner Markdown.vue
   provides its own prose styles; this wrapper only keeps wide tables/code from
   pushing the panel's horizontal layout (they scroll inside their containers). */
.aw-md {
  min-width: 0;
}
.aw-live {
  font: var(--text-base)/var(--leading-relaxed) var(--font-mono);
  color: var(--color-text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.aw-progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font: var(--text-base)/var(--leading-relaxed) var(--font-mono);
  color: var(--color-text);
  min-width: 0;
}
.aw-group {
  min-width: 0;
}
.aw-call {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  font-weight: var(--weight-medium);
  color: var(--color-text);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.aw-glyph {
  flex: none;
  color: var(--color-accent);
  font-size: 0.85em;
}
.aw-output {
  margin: 2px 0 0 16px;
  padding-left: 8px;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  border-left: 2px solid var(--color-line);
  min-width: 0;
}
.aw-out-line {
  min-width: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.aw-fold {
  display: inline-block;
  margin: 2px 0;
  padding: 0;
  background: none;
  border: none;
  color: var(--color-accent);
  font: inherit;
  cursor: pointer;
}
.aw-fold:hover {
  text-decoration: underline;
}
.aw-fold:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}
</style>
