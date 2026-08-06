<!-- apps/kimi-web/src/components/chat/tool-calls/TeamMessageTool.vue -->
<!-- The `TeamMessage` supervision tool (lead → member), rendered as a tool card
     instead of dumping the raw `{"agent_id","message"}` JSON: the collapsed
     header names the target (`→ agent-70`) and the expanded body shows the
     message as Markdown (it is agent-facing prose, same routing as the subagent
     task/output fields). If the arg is not the expected envelope, fall back to
     the raw text so malformed data is never lost and never crashes. -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ToolCall } from '../../../types';
import { toolGlyph, toolLabel } from '../../../lib/toolMeta';
import {
  isTeamMessageEnvelope,
  parseTeamMessageInput,
  teamMessageSummary,
} from '../../../lib/teamMessage';
import ToolRow from '../ToolRow.vue';
import Markdown from '../Markdown.vue';

const props = withDefaults(
  defineProps<{
    tool: ToolCall;
    mobile?: boolean;
    stackPosition?: 'single' | 'first' | 'middle' | 'last';
    toolDiffPanel?: boolean;
  }>(),
  { mobile: false, stackPosition: 'single', toolDiffPanel: false },
);

const input = computed(() => parseTeamMessageInput(props.tool.arg));
const hasOutput = computed(() => !!props.tool.output && props.tool.output.length > 0);
const canExpand = computed(() => Boolean(input.value.message) || hasOutput.value);
const open = ref(props.tool.defaultExpanded === true && canExpand.value);

const status = computed<'running' | 'ok' | 'error'>(() => props.tool.status as 'running' | 'ok' | 'error');
const label = computed(() => toolLabel(props.tool.name));
const glyph = computed(() => toolGlyph(props.tool.name));
const summary = computed(() => teamMessageSummary(input.value));

function toggle(): void {
  if (canExpand.value) open.value = !open.value;
}

watch(
  () => [props.tool.defaultExpanded, props.tool.output?.length, props.tool.status] as const,
  () => {
    if (props.tool.defaultExpanded === true && canExpand.value) open.value = true;
  },
);
</script>

<template>
  <ToolRow
    :status="status"
    :icon="glyph"
    :name="label"
    :arg="!open ? summary : ''"
    :time="tool.timing"
    :open="open"
    :expandable="canExpand"
    :stacked="stackPosition !== 'single'"
    :stack-position="stackPosition"
    @toggle="toggle"
  >
    <div v-if="input.message" class="tm-msg">
      <Markdown :text="input.message" />
    </div>
    <div v-else-if="!isTeamMessageEnvelope(input) && tool.arg" class="tm-raw">{{ tool.arg }}</div>
    <div v-if="hasOutput" class="tm-out">
      <div v-for="(line, i) in tool.output ?? []" :key="i">{{ line }}</div>
    </div>
  </ToolRow>
</template>

<style scoped>
.tm-msg {
  color: var(--color-text);
  word-break: break-word;
}
.tm-raw {
  color: var(--color-text);
  white-space: pre-wrap;
  word-break: break-word;
}
.tm-out {
  margin-top: 8px;
  padding: 8px 12px;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
