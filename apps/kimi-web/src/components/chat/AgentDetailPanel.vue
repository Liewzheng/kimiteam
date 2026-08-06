<!-- apps/kimi-web/src/components/chat/AgentDetailPanel.vue -->
<!-- A subagent's full detail in the right-side panel (App's shared slot — opening
     this replaces a thinking/compaction/file view and vice versa). Mirrors the
     thinking panel: the content is reactive, so a still-running subagent keeps
     streaming its progress here, and the progress list follows the bottom as long
     as the user hasn't scrolled up. -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AgentMember, FilePreviewRequest } from '../../types';
import { formatUsage, hasUsage } from '../../lib/agentUsage';
import { shouldRenderMarkdown } from '../../lib/messageFormatting';
import AgentWorkflow from './AgentWorkflow.vue';
import Markdown from './Markdown.vue';
import Badge from '../ui/Badge.vue';
import PanelHeader from '../ui/PanelHeader.vue';

const props = defineProps<{ member: AgentMember }>();

const emit = defineEmits<{
  close: [];
  /** Open a workspace file linked from a rendered markdown field (task/output). */
  openFile: [target: FilePreviewRequest];
}>();

const { t } = useI18n();

// Token-usage strip: formatted input/output/total when the server supplied a
// usage aggregate with any real consumption, null otherwise (hidden entirely —
// a queued/not-yet-run subagent shows no "0 tokens" strip).
const usageText = computed(() =>
  props.member.usage && hasUsage(props.member.usage) ? formatUsage(props.member.usage) : null,
);

// Rendering policy for the panel's prose fields: the final summary is
// agent-facing prose and renders Markdown — bold / lists / tables / code. The
// task prompt, live output and tool-progress stream live in the shared
// AgentWorkflow block (same policy, decided in lib/messageFormatting).
const mdFields = {
  result: shouldRenderMarkdown('subagent-result'),
};

function phaseLabel(phase: AgentMember['phase']): string {
  switch (phase) {
    case 'queued': return 'Queued';
    case 'working': return 'Working';
    case 'suspended': return 'Suspended';
    case 'completed': return 'Completed';
    case 'failed': return 'Failed';
  }
}

const bodyEl = ref<HTMLElement | null>(null);
</script>

<template>
  <div class="ap">
    <PanelHeader
      :title="t('common.preview')"
      :subtitle="member.name"
      :close-label="t('thinking.close')"
      @close="emit('close')"
    >
      <Badge variant="neutral" size="sm" class="ap-phase">{{ phaseLabel(member.phase) }}</Badge>
    </PanelHeader>
    <div ref="bodyEl" class="ap-body">
      <div v-if="usageText" class="ap-usage">
        <span class="ap-usage-label">Tokens</span>
        <span class="ap-usage-item"><span class="ap-usage-k">input</span>{{ usageText.input }}</span>
        <span class="ap-usage-item"><span class="ap-usage-k">output</span>{{ usageText.output }}</span>
        <span class="ap-usage-item"><span class="ap-usage-k">total</span>{{ usageText.total }}</span>
      </div>
      <div v-if="member.subagentType" class="ap-type">{{ member.subagentType }}</div>
      <div v-if="member.suspendedReason" class="ap-reason">{{ member.suspendedReason }}</div>

      <!-- Task / live output / tool-progress stream — shared with the
           team-member detail (AgentWorkflow), so the streaming render + fold
           logic live in one tested place. -->
      <AgentWorkflow
        :member="member"
        :scroll-target="bodyEl"
        @open-file="(target) => emit('openFile', target)"
      />

      <div v-if="member.summary" class="ap-field">
        <span class="ap-field-label">Result</span>
        <div v-if="mdFields.result" class="ap-field-body ap-md">
          <Markdown :text="member.summary" :open-file="(target) => emit('openFile', target)" />
        </div>
        <div v-else class="ap-field-body">{{ member.summary }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ap {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--color-bg);
}
.ap-phase { flex: none; }

.ap-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 14px;
  font: var(--text-base)/var(--leading-normal) var(--font-ui);
  color: var(--color-text-muted);
}
.ap-type {
  font: var(--text-xs) var(--font-mono);
  color: var(--color-text-muted);
  margin-bottom: 8px;
}
.ap-reason {
  color: var(--color-warning);
  margin-bottom: 8px;
}
.ap-usage {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 14px;
  margin-bottom: 12px;
  padding: 8px 10px;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  font: var(--text-xs) var(--font-mono);
}
.ap-usage-label {
  flex: none;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-text-muted);
}
.ap-usage-item {
  flex: none;
  min-width: 0;
  color: var(--color-text);
  white-space: nowrap;
}
.ap-usage-k {
  color: var(--color-text-faint);
  margin-right: 4px;
}
.ap-field + .ap-field {
  margin-top: 12px;
}
/* Spacing between the shared workflow block (AgentWorkflow — task / live
   output / tool progress) and the trailing Result field. The workflow block
   handles its own internal field spacing. */
.aw + .ap-field {
  margin-top: 12px;
}
.ap-field-label {
  display: block;
  color: var(--color-text-muted);
  font: var(--text-xs) var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 4px;
}
.ap-field-body {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
/* Markdown-rendered prose field (final result). The inner Markdown.vue
   provides its own prose styles; this wrapper only keeps wide tables/code from
   pushing the panel's horizontal layout (they scroll inside their containers). */
.ap-md {
  min-width: 0;
}
</style>
