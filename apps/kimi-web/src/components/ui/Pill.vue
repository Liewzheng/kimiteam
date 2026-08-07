<!-- apps/kimi-web/src/components/ui/Pill.vue -->
<!-- Design-system §03 Pill: composer toolbar pill. Renders as a button when
     clickable, otherwise as a static span. -->
<script setup lang="ts">
withDefaults(defineProps<{
  clickable?: boolean;
  active?: boolean;
  hot?: boolean;
  disabled?: boolean;
  ariaPressed?: boolean;
}>(), {
  clickable: true,
});

defineEmits<{ click: [event: MouseEvent] }>();
</script>

<template>
  <button
    v-if="clickable"
    class="ui-pill"
    :class="{ 'is-active': active, 'is-hot': hot }"
    type="button"
    :disabled="disabled"
    :aria-pressed="ariaPressed"
    @click="$emit('click', $event)"
  >
    <slot />
  </button>
  <span v-else class="ui-pill" :class="{ 'is-active': active, 'is-hot': hot }"><slot /></span>
</template>

<style scoped>
.ui-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  line-height: 1;
  white-space: nowrap;
  cursor: default;
  transition: background var(--duration-base) var(--ease-out),
    color var(--duration-base) var(--ease-out);
}
button.ui-pill { cursor: pointer; }
button.ui-pill:hover:not(:disabled) { background: var(--color-surface-sunken); color: var(--color-text); }
button.ui-pill:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
button.ui-pill:disabled { opacity: 0.5; cursor: not-allowed; }
.ui-pill.is-active { background: var(--color-accent-soft); color: var(--color-accent); }
/* `hot` — accent emphasis keyed off live work (e.g. the standing team entry
   while any member is working), visually the same family as `is-active` but a
   distinct state so a pill can be hot without being active. Shared here so the
   dock and the empty-state team entry don't each re-declare the accent. */
.ui-pill.is-hot { background: var(--color-accent-soft); color: var(--color-accent); }
.ui-pill.is-hot :deep(svg) { color: var(--color-accent); }
.ui-pill :deep(svg) { width: var(--p-ic-sm); height: var(--p-ic-sm); flex: none; color: var(--color-text-faint); }
</style>
