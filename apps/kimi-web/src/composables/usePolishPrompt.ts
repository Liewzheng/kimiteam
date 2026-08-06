// apps/kimi-web/src/composables/usePolishPrompt.ts
// Polish-modal state machine for the member-detail edit form. Pure refs + an
// injected api, so it is unit-testable without a DOM:
//   startPolish(source) — opens the dialog and calls the server polish
//     endpoint with a loading state (POST /teams/{sid}/members/{name}:polish).
//   confirm()           — resets state and returns the polished text so the
//     caller backfills the prompt field (NO auto-save — the user still hits
//     Save, which runs the normal PUT /teams/{sid}/members/{name}).
//   cancel() / reset()  — discard the polish.
// The dialog stays open across the whole request so the UI can show the
// loading state, then 原文 + 润色结果 side by side.

import { ref, type Ref } from 'vue';

/** The single method the composable needs from the api — structurally satisfied
 *  by KimiWebApi, injectable so tests can pass a mock. */
export interface PolishTeamMemberPromptApi {
  polishTeamMemberPrompt(
    sessionId: string,
    name: string,
    prompt: string,
  ): Promise<{ ok: boolean; polished: string }>;
}

export interface UsePolishPrompt {
  /** Whether the polish dialog is open. */
  open: Ref<boolean>;
  /** True while the server is generating the polish. */
  loading: Ref<boolean>;
  /** Last failure message, null while idle / successful. */
  error: Ref<string | null>;
  /** The prompt sent to the server (rendered as 原文 in the dialog). */
  original: Ref<string | null>;
  /** The server-returned polish (rendered as 润色结果). Null while loading /
   *  on error — the confirm button stays disabled until it lands. */
  polished: Ref<string | null>;
  /** Open the dialog and request a polish. No-op on an empty prompt. */
  startPolish: (source: string) => Promise<void>;
  /** Confirm → reset state and return the polished text (null when none, e.g.
   *  after a failure). The caller backfills the prompt field with the result. */
  confirm: () => string | null;
  /** Cancel / close → reset state, discarding the polish. */
  cancel: () => void;
  /** Reset all state (no return value) — wired to the Dialog's close event so
   *  overlay/Esc/X closes behave exactly like cancel. */
  reset: () => void;
}

export function usePolishPrompt(
  api: PolishTeamMemberPromptApi,
  sessionId: string,
  name: string,
): UsePolishPrompt {
  const open = ref(false);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const original = ref<string | null>(null);
  const polished = ref<string | null>(null);

  function reset(): void {
    open.value = false;
    loading.value = false;
    error.value = null;
    original.value = null;
    polished.value = null;
  }

  async function startPolish(source: string): Promise<void> {
    if (source.trim().length === 0) return;
    original.value = source;
    open.value = true;
    loading.value = true;
    error.value = null;
    polished.value = null;
    try {
      const result = await api.polishTeamMemberPrompt(sessionId, name, source);
      polished.value = result.polished;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      loading.value = false;
    }
  }

  function confirm(): string | null {
    const text = polished.value;
    reset();
    return text;
  }

  function cancel(): void {
    reset();
  }

  return { open, loading, error, original, polished, startPolish, confirm, cancel, reset };
}
