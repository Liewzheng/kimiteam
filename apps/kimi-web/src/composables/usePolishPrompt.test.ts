// apps/kimi-web/src/composables/usePolishPrompt.test.ts
import { describe, expect, it, vi } from 'vitest';
import { usePolishPrompt, type PolishTeamMemberPromptApi } from './usePolishPrompt';

function mockApi(overrides: Partial<PolishTeamMemberPromptApi> = {}): PolishTeamMemberPromptApi {
  return {
    polishTeamMemberPrompt: vi.fn().mockResolvedValue({ ok: true, polished: 'polished text' }),
    ...overrides,
  };
}

describe('usePolishPrompt — polish-modal state machine', () => {
  it('starts idle (dialog closed, nothing to show)', () => {
    const p = usePolishPrompt(mockApi(), 's1', 'm1');
    expect(p.open.value).toBe(false);
    expect(p.loading.value).toBe(false);
    expect(p.error.value).toBeNull();
    expect(p.original.value).toBeNull();
    expect(p.polished.value).toBeNull();
  });

  it('does not call the api for an empty prompt', async () => {
    const client = mockApi();
    const p = usePolishPrompt(client, 's1', 'm1');
    await p.startPolish('   ');
    expect(client.polishTeamMemberPrompt).not.toHaveBeenCalled();
    expect(p.open.value).toBe(false);
    expect(p.loading.value).toBe(false);
  });

  it('opens the dialog with a loading state, then lands the polished text', async () => {
    const p = usePolishPrompt(mockApi(), 's1', 'm1');
    const done = p.startPolish('my prompt');
    expect(p.open.value).toBe(true);
    expect(p.loading.value).toBe(true);
    expect(p.original.value).toBe('my prompt');
    await done;
    expect(p.loading.value).toBe(false);
    expect(p.polished.value).toBe('polished text');
    expect(p.error.value).toBeNull();
  });

  it('surfaces an error and keeps the dialog open (retry or cancel)', async () => {
    const client = mockApi({
      polishTeamMemberPrompt: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const p = usePolishPrompt(client, 's1', 'm1');
    await p.startPolish('prompt');
    expect(p.loading.value).toBe(false);
    expect(p.error.value).toBe('boom');
    expect(p.polished.value).toBeNull();
    expect(p.open.value).toBe(true);
  });

  it('confirm() returns the polished text and resets state (caller backfills)', async () => {
    const p = usePolishPrompt(mockApi(), 's1', 'm1');
    await p.startPolish('prompt');
    const text = p.confirm();
    expect(text).toBe('polished text');
    expect(p.open.value).toBe(false);
    expect(p.polished.value).toBeNull();
    expect(p.original.value).toBeNull();
    expect(p.loading.value).toBe(false);
  });

  it('confirm() returns null after a failure (nothing to backfill)', async () => {
    const client = mockApi({
      polishTeamMemberPrompt: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const p = usePolishPrompt(client, 's1', 'm1');
    await p.startPolish('prompt');
    expect(p.confirm()).toBeNull();
  });

  it('cancel() discards the polish', async () => {
    const p = usePolishPrompt(mockApi(), 's1', 'm1');
    await p.startPolish('prompt');
    p.cancel();
    expect(p.open.value).toBe(false);
    expect(p.polished.value).toBeNull();
    expect(p.original.value).toBeNull();
    expect(p.loading.value).toBe(false);
    expect(p.error.value).toBeNull();
  });
});
