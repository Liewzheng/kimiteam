/**
 * `team-score` domain — TeamScore acceptance-evidence contract.
 *
 * An Agent-scoped service (main agent only) that watches the tech-lead's tool
 * calls and classifies them as acceptance evidence, plus a per-member
 * delivery-completion window anchored on the subagent run-settle signal.
 * `TeamScoreTool.record` consults `evaluateRecordGate` before scoring; the
 * gate is shape detection only — it blocks "scored with no acceptance at
 * all", never "perfunctory acceptance". Bound at Agent scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

/**
 * Outcome of evaluating the acceptance gate for one profile. `ok: true` means
 * at least one detectable acceptance action covers the profile's latest
 * delivery; `ok: false` carries a human-readable, actionable explanation of
 * what evidence is missing and which tool actions would satisfy it.
 */
export type AcceptanceGateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export interface IAcceptanceEvidenceService {
  readonly _serviceBrand: undefined;

  /**
   * Evaluate the TeamScore `record` acceptance gate for `profileName`. Shape
   * detection: passes when the profile's delivery output was read, or when a
   * diff review / test rerun happened after the profile's latest delivery
   * completed.
   */
  evaluateRecordGate(profileName: string): AcceptanceGateResult;
}

export const IAcceptanceEvidenceService: ServiceIdentifier<IAcceptanceEvidenceService> =
  createDecorator<IAcceptanceEvidenceService>('acceptanceEvidence');
