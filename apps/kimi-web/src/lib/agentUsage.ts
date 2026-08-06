// apps/kimi-web/src/lib/agentUsage.ts
// Pure helpers for the subagent token-usage strip in AgentDetailPanel — no Vue,
// no i18n (the `input`/`output`/`total` labels are literal technical tokens,
// matching the TUI usage panel; the component's other section labels are also
// hardcoded). Kept pure so the gate + formatting are unit-testable.

import type { AgentUsage } from '../types';
import { formatTokens } from './formatTokens';

/** A positive finite token count, or 0. Guards against a server that ships
 *  undefined / NaN / negative values in the usage aggregate. */
function positiveNumber(n: number): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Whether a usage summary is worth showing. Mirrors the TUI usage panel, which
 * skips a subagent row whose input+output total is 0 — a queued / not-yet-run
 * subagent must not advertise a "0 tokens" strip.
 */
export function hasUsage(usage: AgentUsage | undefined): boolean {
  if (!usage) return false;
  return (
    positiveNumber(usage.input) > 0 ||
    positiveNumber(usage.output) > 0 ||
    positiveNumber(usage.total) > 0
  );
}

/**
 * Format a usage summary for the compact strip (`input 49.4k  output 1.2k
 *  total 50.6k`), 1024-based like every token readout in the app. When the
 * server's `total` is absent or still 0 mid-stream, fall back to input+output
 * so the strip never shows a stale "total 0" next to real input/output.
 */
export function formatUsage(usage: AgentUsage): {
  input: string;
  output: string;
  total: string;
} {
  const input = positiveNumber(usage.input);
  const output = positiveNumber(usage.output);
  const total = positiveNumber(usage.total) || input + output;
  return {
    input: formatTokens(input),
    output: formatTokens(output),
    total: formatTokens(total),
  };
}
