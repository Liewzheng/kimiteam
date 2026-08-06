// apps/kimi-web/src/composables/useComposerDraft.ts
import { nextTick, ref, watch } from 'vue';
import { draftStorageKey, safeGetString, safeRemove, safeSetString } from '../lib/storage';

export interface ComposerDraftDeps {
  /** Active session id — scopes the persisted draft (getter for reactivity). */
  sessionId: () => string | undefined;
}

/** Debounce window for persisting the live draft — keystrokes write to
 *  localStorage at most once per window instead of synchronously every key
 *  (the old path forced a storage write on each input). Blur / submit / session
 *  switch flush immediately via flushDraft, so a draft is never lost. */
export const DRAFT_SAVE_DELAY_MS = 400;

/**
 * The composer's text state plus its per-session unsent-draft persistence.
 *
 * The draft is kept in localStorage keyed by session, so switching away and back
 * (or a page refresh) restores whatever the user was typing for that session; it
 * is cleared when the draft is sent/steered. This composable owns the `text`
 * and `textarea` refs, the `autosize` helper, the debounced draft save watcher,
 * and the imperative `loadForEdit` handle exposed to the parent.
 */
export function useComposerDraft(deps: ComposerDraftDeps) {
  const { sessionId } = deps;

  function loadDraft(sid: string | undefined): string {
    return safeGetString(draftStorageKey(sid)) ?? '';
  }
  function saveDraft(sid: string | undefined, value: string): void {
    const key = draftStorageKey(sid);
    if (value) safeSetString(key, value);
    else safeRemove(key);
  }

  const text = ref(loadDraft(sessionId()));
  const textareaRef = ref<HTMLTextAreaElement | null>(null);

  /** Pending debounced write (null when idle). */
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleDraftSave(): void {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveDraft(sessionId(), text.value);
    }, DRAFT_SAVE_DELAY_MS);
  }

  /** Persist the pending draft immediately and cancel any debounced write.
   *  Bound to the textarea's blur (and called before session switches), so a
   *  draft typed right before leaving the box is never lost to the debounce. */
  function flushDraft(): void {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    saveDraft(sessionId(), text.value);
  }

  function autosize(): void {
    const el = textareaRef.value;
    if (!el) return;
    // Reset to measure the natural content height, then fit the box to it.
    // The resting height and the upper cap live in CSS (`min-height` /
    // `max-height`); once the content outgrows the cap, `overflow-y: auto`
    // scrolls internally. This keeps a single source of truth for the bounds.
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }

  watch(text, () => {
    void nextTick(autosize);
    // Persist the live draft debounced (empty clears the entry on write).
    scheduleDraftSave();
  });

  // Switching sessions: flush the OLD session's draft synchronously (the
  // debounce must not swallow it), then load the new session's draft into the
  // box.
  watch(sessionId, (newSid, oldSid) => {
    if (newSid === oldSid) return;
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    saveDraft(oldSid, text.value);
    text.value = loadDraft(newSid);
    void nextTick(autosize);
  });

  /** Imperatively load text into the box for editing (used by "edit & resend the
      last message" after an undo, or by the dock queue panel when the user edits
      a queued prompt). Focuses with the caret at the end. */
  function loadForEdit(value: string): void {
    text.value = value;
    void nextTick(() => {
      const el = textareaRef.value;
      if (!el) return;
      el.focus();
      const pos = value.length;
      el.setSelectionRange(pos, pos);
      autosize();
    });
  }

  /**
   * Synchronously clear the persisted draft for the current session (and cancel
   * any pending debounced write so a stale timer can't resurrect it).
   * Call this right after clearing `text.value` on send/steer; relying on the
   * text watcher is unsafe because the Composer may unmount before the watcher
   * flushes (e.g. when the optimistic user message replaces the empty-session
   * composer), causing the next mount to reload the stale draft.
   */
  function clearDraft(): void {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    saveDraft(sessionId(), '');
  }

  return { text, textareaRef, autosize, flushDraft, loadForEdit, clearDraft };
}
