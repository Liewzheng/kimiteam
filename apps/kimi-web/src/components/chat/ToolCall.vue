<!-- apps/kimi-web/src/components/chat/ToolCall.vue -->
<script setup lang="ts">
import { computed } from 'vue';
import type { FilePreviewRequest, ToolCall, ToolMedia } from '../../types';
import { resolveToolRenderer } from './tool-calls/toolRegistry';

const props = withDefaults(
  defineProps<{
    tool: ToolCall;
    mobile?: boolean;
    stackPosition?: 'single' | 'first' | 'middle' | 'last';
    toolDiffPanel?: boolean;
  }>(),
  { mobile: false, stackPosition: 'single', toolDiffPanel: false },
);

const emit = defineEmits<{
  openMedia: [media: ToolMedia];
  openFile: [target: FilePreviewRequest];
  openToolDiff: [id: string];
  openAgent: [toolCallId: string];
}>();

// Stable references — emit-call bindings would mint a new function per render
// and re-render the tool renderer on every streaming frame.
function onOpenMedia(media: ToolMedia): void {
  emit('openMedia', media);
}
function onOpenFile(target: FilePreviewRequest): void {
  emit('openFile', target);
}
function onOpenToolDiff(id: string): void {
  emit('openToolDiff', id);
}
function onOpenAgent(toolCallId: string): void {
  emit('openAgent', toolCallId);
}

const Renderer = computed(() => resolveToolRenderer(props.tool));
</script>

<template>
  <component
    :is="Renderer"
    :tool="tool"
    :mobile="mobile"
    :stack-position="stackPosition"
    :tool-diff-panel="toolDiffPanel"
    :data-scroll-anchor-id="tool.id"
    @open-media="onOpenMedia"
    @open-file="onOpenFile"
    @open-tool-diff="onOpenToolDiff"
    @open-agent="onOpenAgent"
  />
</template>
