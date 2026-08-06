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

/** The agent's concatenated chain-of-thought (thinking deltas). Trimmed for
 *  display; grows in real time as deltas stream in. */
const thinkingText = computed(() => (props.member.thinking ?? '').trimEnd());

/** True while the agent is still producing output — drives the thinking
 *  section's live window (open + follow-bottom) vs its settled collapsed state. */
const isRunning = computed(() => props.member.status === 'running');

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

/** The thinking section is a disclosure: it opens while the agent runs so the
 *  user sees the reasoning stream live, then folds once the agent settles so
 *  the real output owns the reading surface. The user can reopen it anytime;
 *  a settled member starts collapsed. */
const thinkOpen = ref(isRunning.value);
const thinkEl = ref<HTMLElement | null>(null);

function toggleThink(): void {
  thinkOpen.value = !thinkOpen.value;
}

watch(isRunning, (running) => {
  if (!running) thinkOpen.value = false;
});

// A fresh member gets a fresh disclosure state: open while it runs, closed once
// settled. Only fires on member switch (id change), so the user's open/collapse
// choice for a given member is never overridden mid-stream.
watch(
  () => props.member.id,
  () => {
    thinkOpen.value = isRunning.value;
  },
);

// While the thinking window is open and the agent is still streaming, follow
// the bottom of the thinking region so the newest reasoning stays visible
// (mirrors ThinkingBlock.vue's live-window scroll).
watch(
  () => thinkingText.value.length,
  () => {
    const el = thinkEl.value;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (!atBottom) return;
    void nextTick(() => {
      if (thinkEl.value) thinkEl.value.scrollTop = thinkEl.value.scrollHeight;
    });
  },
  { immediate: true },
);

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

    <div v-if="thinkingText" class="aw-field">
      <button
        type="button"
        class="aw-think-toggle"
        :aria-expanded="thinkOpen"
        @click="toggleThink"
      >
        <span class="aw-think-glyph" aria-hidden="true">{{ thinkOpen ? '▾' : '▸' }}</span>
        {{ t('common.thinkingLabel') }}
        <span v-if="isRunning" class="aw-think-live" aria-hidden="true" />
      </button>
      <div v-if="thinkOpen" ref="thinkEl" class="aw-field-body aw-thinking">{{ thinkingText }}</div>
    </div>

    <div v-if="liveText" class="aw-field">
      <span class="aw-field-label">{{ t('common.outputLabel') }}</span>
      <div v-if="mdFields.output" class="aw-field-body aw-md aw-box">
        <Markdown :text="liveText" :open-file="(target) => emit('openFile', target)" />
      </div>
      <div v-else class="aw-field-body aw-live aw-box">{{ liveText }}</div>
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
  font: var(--text-sm) var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-weight: var(--weight-semibold);
  margin-bottom: 4px;
}
.aw-field-body {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
/* Markdown-rendered prose field (task / live output). The inner Markdown.vue
   provides its own prose styles; this wrapper only keeps wide tables/code from
   pushing the panel's horizontal layout (they scroll inside their containers).

   Streamed subagent output is prose whose lines are separated by single `\n`
   (rarely a blank line between paragraphs), and Markdown collapses a single
   newline into a space — without pre-wrap the live output would render as one
   unbroken paragraph. Pin pre-wrap on the renderer root (and its text boxes) so
   the markdown structure (bold / code / lists) still applies while the original
   line breaks are preserved. Code blocks are unaffected — `pre` keeps its own
   white-space, and these selectors never target it. */
.aw-md {
  min-width: 0;
  /* The task + live-output fields render through Markdown here (mdFields.*
     are always true for this component), so this wrapper — not .aw-live — is
     the real output surface. The output is the PRIMARY reading area of the
     workflow, so it gets real room: 50% of the viewport height (scales down
     on small windows, up to 460px), far above the old ~11-line 240px cap.
     Overflow scrolls inside the region (thin app scrollbar skin). */
  max-height: min(50vh, 460px);
  overflow-y: auto;
}
/* Streamed subagent output is prose whose lines are separated by single `\n`
   (rarely a blank line between paragraphs), and Markdown collapses a single
   newline into a space — without pre-wrap the live output would render as one
   unbroken paragraph. markstream renders plain paragraphs as
   `div.markdown-renderer > div.node-slot > p > span.text-node` (streaming text
   splits into `.text-node-stream-delta` spans inside the same `.text-node`),
   and its own stylesheet already pins pre-wrap on `.text-node`. To make the
   guarantee structural rather than selector-specific, the ROOT rule makes
   pre-wrap inherit to every descendant, and the `:not(pre)` catch-all forces
   it on any element that declares its own white-space (markstream sets
   inline-code and table cells to `normal`), so a `\n` can never collapse to a
   space regardless of the DOM shape. Code blocks are excluded — `pre` keeps
   its own white-space so long lines scroll instead of wrapping. */
.aw-md :deep(.markdown-renderer) {
  white-space: pre-wrap;
}
.aw-md :deep(.markdown-renderer :not(pre):not(pre *)) {
  white-space: pre-wrap;
}
.aw-live {
  font: var(--text-base)/var(--leading-relaxed) var(--font-mono);
  color: var(--color-text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  /* Bounded live-output region (the plain-text twin of .aw-md, kept in step
     so a non-Markdown surface gets the same reading room): a long-running
     agent must not stretch the panel; overflow scrolls inside the region
     using the app's thin scrollbar skin. */
  max-height: min(50vh, 460px);
  overflow-y: auto;
}
.aw-progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font: var(--text-base)/var(--leading-relaxed) var(--font-mono);
  color: var(--color-text);
  min-width: 0;
  /* Bounded tool-progress region — reduced to ≈ 5 tool-call lines (~110px:
     mono 14px/1.7 call rows and 13px/1.5 output rows land at ~20–24px per
     line) so progress stays a glanceable status strip instead of competing
     with the enlarged output area. Overflow scrolls inside. */
  max-height: 110px;
  overflow-y: auto;
}
/* Tool-call-style render box for the output + progress regions — same
   surface / line border / radius as the chat's tool-call area
   (ToolGroup.vue .tool-group: background: var(--color-surface), border:
   1px solid var(--color-line), radius-md; inner padding matches
   ToolOutputBlock's --space-3 body padding). The task prompt and thinking
   disclosure stay unboxed — only the agent's rendered output and the tool
   progress log get the "tool call" surface. */
.aw-box,
.aw-progress {
  background: var(--color-surface);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  padding: var(--space-3);
}
/* Thinking disclosure — header styled like the other field labels (mono,
   uppercase) but interactive; the body is the muted/italic chain-of-thought,
   mirroring the TUI's dim+italic thinking text. */
.aw-think-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
  padding: 0;
  background: none;
  border: none;
  color: var(--color-text-muted);
  font: var(--text-sm) var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-weight: var(--weight-semibold);
  cursor: pointer;
}
.aw-think-toggle:hover {
  color: var(--color-text);
}
.aw-think-toggle:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}
.aw-think-glyph {
  color: var(--color-text-faint);
  font-size: 0.8em;
}
.aw-think-live {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-accent);
}
.aw-thinking {
  font: var(--text-base)/var(--leading-relaxed) var(--font-ui);
  color: var(--color-text-muted);
  font-style: italic;
  /* Reasoning is secondary to the output: cap it below the output region so
     a long chain-of-thought cannot dominate the workflow card. */
  max-height: 160px;
  overflow-y: auto;
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
