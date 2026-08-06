<!-- apps/kimi-web/src/components/team/TeamMemberDetailPanel.vue -->
<!-- Team-member detail — drill-in from a TeamStatusPanel card, replacing the
     roster in the shared right-side slot (close returns to the roster).
     Three parts:
       - Top: the member's prompt + info (Title / Model / when-to-use /
         description / tools / score) with an Edit mode for Prompt + Title +
         Model, saved through PUT /teams/{sid}/members/{name}
         (api.updateTeamMember). The roster is patched in place via
         `memberUpdated` so the change is live immediately.
       - Token usage: the member's current-session spend (GET /teams/{sid}/usage
         → byMember[name]). Historical / all-time spend has no server source
         yet — the section is structured so an all-time row can slot in.
       - Bottom: the member's live workflow — task prompt, streaming output and
         grouped tool-progress — rendered by the shared AgentWorkflow, matched
         to the member's running subagent task by profile name
         (lib/teamRows.findMemberTask). Idle members show an empty state.
     Note: Title maps to the `role` profile field. -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { getKimiWebApi } from '../../api';
import type { AppModel, AppTeamMember, AppTeamMembers, AppTask } from '../../api/types';
import type { AgentMember, FilePreviewRequest } from '../../types';
import { usePolling } from '../../composables/usePolling';
import { usePolishPrompt } from '../../composables/usePolishPrompt';
import { formatTokens } from '../../lib/formatTokens';
import {
  averageScoreLabel,
  findMemberTask,
  findTeamMember,
  memberModelOptions,
  teamStatusMeta,
  type MemberModelOption,
} from '../../lib/teamRows';
import { memberSessionUsage, tokenTotal } from '../../lib/usageRows';
import { toAgentMember } from '../../composables/messagesToTurns';
import AgentWorkflow from '../chat/AgentWorkflow.vue';
import Badge from '../ui/Badge.vue';
import Button from '../ui/Button.vue';
import Dialog from '../ui/Dialog.vue';
import EmptyState from '../ui/EmptyState.vue';
import Field from '../ui/Field.vue';
import Icon from '../ui/Icon.vue';
import Input from '../ui/Input.vue';
import PanelHeader from '../ui/PanelHeader.vue';
import Select from '../ui/Select.vue';
import Spinner from '../ui/Spinner.vue';
import Textarea from '../ui/Textarea.vue';

const props = defineProps<{
  sessionId: string;
  /** The roster member being inspected (keyed by profile name). */
  name: string;
  /** Live roster (useTeamRoster.data) — the source of truth the edit patches. */
  members: AppTeamMembers | null;
  /** Live subagent tasks (client.activeAppTasks) — workflow matching input. */
  tasks: AppTask[];
  /** Full model catalog (client.models.value) — drives the Model dropdown. */
  models: AppModel[];
}>();

const emit = defineEmits<{
  close: [];
  /** A save succeeded — the parent patches the roster so it updates live. */
  memberUpdated: [member: AppTeamMember];
  openFile: [target: FilePreviewRequest];
}>();

const { t } = useI18n();
const api = getKimiWebApi();

const member = computed(() => findTeamMember(props.members, props.name));

/** The member's live subagent task → AgentMember for the workflow half. The
 *  join key is the profile name (`subagentType === member.name`); null when the
 *  member has no running instance (idle / resting / on-duty). */
const liveMember = computed<AgentMember | null>(() => {
  const task = findMemberTask(props.tasks, props.name);
  return task ? toAgentMember(task) : null;
});

const scoreLabel = computed(() => {
  const m = member.value;
  return m ? (averageScoreLabel(m.score) ?? t('team.scoreNone')) : '';
});

/** Scroll container for the workflow half — AgentWorkflow follows the bottom. */
const bodyEl = ref<HTMLElement | null>(null);

// ---------------------------------------------------------------------------
// Token usage — current session only (GET /teams/{sid}/usage → byMember[name]).
// Historical / all-time spend has no server source this phase (the /usage
// route aggregates the live session lifecycle only); the section is structured
// so an all-time row can slot in beside this one once a server aggregate lands.
// ---------------------------------------------------------------------------
const POLL_MS = 2500;
const { data: usageData } = usePolling(() => api.getTeamUsage(props.sessionId), POLL_MS);

/** The member's current-session input/output tokens, or null (none yet). */
const sessionUsage = computed(() =>
  usageData.value ? memberSessionUsage(usageData.value, props.name) : null,
);
const hasSessionUsage = computed(
  () => sessionUsage.value !== null && sessionUsage.value.input + sessionUsage.value.output > 0,
);

// ---------------------------------------------------------------------------
// Model dropdown — model catalog (client.models.value) + the models this
// member actually called this session (最近调用, pinned on top). The server
// already resolves the engine's `__secondary__` alias, so the usage keys are
// real model ids usable verbatim as <option> values.
// ---------------------------------------------------------------------------

/** Model ids with recorded spend for THIS member this session, in usage-key
 *  order (recently-used pin). */
const recentModelIds = computed<readonly string[]>(() => {
  const bucket = usageData.value?.byMember[props.name];
  if (!bucket) return [];
  return Object.keys(bucket).filter((id) => {
    const row = bucket[id];
    return row !== undefined && tokenTotal(row) > 0;
  });
});

const modelOptions = computed(() =>
  memberModelOptions({
    models: props.models,
    recentModelIds: recentModelIds.value,
    currentId: model.value,
  }),
);

/** Catalog section grouped by provider (insertion order) for <optgroup>s. */
const catalogGroups = computed<{ provider: string; options: MemberModelOption[] }[]>(() => {
  const byProvider = new Map<string, MemberModelOption[]>();
  for (const opt of modelOptions.value.catalog) {
    const list = byProvider.get(opt.provider);
    if (list) list.push(opt);
    else byProvider.set(opt.provider, [opt]);
  }
  return [...byProvider.entries()].map(([provider, options]) => ({ provider, options }));
});

const hasModelOptions = computed(
  () => modelOptions.value.recent.length > 0 || catalogGroups.value.length > 0,
);

// ---------------------------------------------------------------------------
// Edit mode — prompt + Title (role) + Model. All three are patchable by the
// server's PUT update schema (prompt replaces the profile body; Title maps to
// the `role` frontmatter field).
// ---------------------------------------------------------------------------
const editing = ref(false);
const saving = ref(false);
const saveError = ref<string | null>(null);
const title = ref('');
const model = ref('');
const prompt = ref('');

// Polish-modal state machine — bound to the api + panel identity so tests can
// drive it with a mock api. confirm() returns the polished text; the caller
// backfills `prompt` (no auto-save).
const {
  open: polishOpen,
  loading: polishLoading,
  error: polishError,
  original: polishOriginal,
  polished: polishPolished,
  startPolish,
  confirm: confirmPolish,
  cancel: cancelPolish,
} = usePolishPrompt(api, props.sessionId, props.name);

/** Confirm in the polish dialog → write the polished text back into the prompt
 *  field (the user then saves through the normal Save button / PUT). */
function applyPolish(): void {
  const text = confirmPolish();
  if (text !== null) prompt.value = text;
}

function startEdit(): void {
  const m = member.value;
  if (!m) return;
  title.value = m.role;
  model.value = m.model;
  prompt.value = m.prompt ?? '';
  saveError.value = null;
  editing.value = true;
}

function cancelEdit(): void {
  editing.value = false;
  saveError.value = null;
}

async function save(): Promise<void> {
  const m = member.value;
  if (!m) return;
  saving.value = true;
  saveError.value = null;
  try {
    const updated = await api.updateTeamMember(props.sessionId, m.name, {
      model: model.value.trim() || undefined,
      role: title.value.trim() || undefined,
      // Empty prompt is rejected by the server (min 1) — leave it untouched.
      prompt: prompt.value.trim() || undefined,
    });
    emit('memberUpdated', updated);
    title.value = updated.role;
    model.value = updated.model;
    prompt.value = updated.prompt ?? '';
    editing.value = false;
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : String(err);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="tmd">
    <PanelHeader
      :title="member?.name ?? name"
      :subtitle="member?.role"
      :close-label="t('thinking.close')"
      @close="emit('close')"
    >
      <Badge
        v-if="member"
        :variant="teamStatusMeta(member.status).variant"
        size="sm"
        dot
      >{{ t('team.status.' + member.status) }}</Badge>
    </PanelHeader>

    <div ref="bodyEl" class="tmd-body">
      <template v-if="member">
        <!-- ============================ Top: details + edit ================= -->
        <section class="tmd-top">
        <div class="tmd-head">
          <span class="tmd-k">{{ t('team.memberDetailsLabel') }}</span>
          <span class="tmd-spacer" />
          <Button v-if="!editing" size="sm" variant="secondary" @click="startEdit">
            <Icon name="pencil" size="sm" />
            {{ t('team.memberEdit') }}
          </Button>
        </div>

        <div v-if="editing" class="tmd-form">
          <Field :label="t('team.hirePrompt')" :hint="t('team.memberPromptHint')">
            <div class="tmd-prompt-edit">
              <Textarea v-model="prompt" :rows="5" />
              <Button
                size="sm"
                variant="secondary"
                :disabled="!prompt.trim() || polishLoading"
                @click="startPolish(prompt)"
              >
                <Icon name="sparkles" size="sm" />
                {{ t('team.polish') }}
              </Button>
            </div>
          </Field>
          <Field :label="t('team.memberTitleLabel')">
            <Input v-model="title" :placeholder="member.role" />
          </Field>
          <Field :label="t('team.hireModel')" :hint="t('team.optional')">
            <Select v-model="model">
              <option v-if="!hasModelOptions" value="" disabled>{{ t('team.memberNoModels') }}</option>
              <optgroup v-if="modelOptions.recent.length > 0" :label="t('team.memberRecentModels')">
                <option v-for="opt in modelOptions.recent" :key="opt.id" :value="opt.id">{{ opt.label }}</option>
              </optgroup>
              <optgroup
                v-for="group in catalogGroups"
                :key="group.provider"
                :label="group.provider || t('team.memberOtherModels')"
              >
                <option v-for="opt in group.options" :key="opt.id" :value="opt.id">{{ opt.label }}</option>
              </optgroup>
            </Select>
          </Field>
          <div v-if="saveError" class="tmd-error" role="alert">{{ saveError }}</div>
          <div class="tmd-form-actions">
            <Button size="sm" variant="secondary" :disabled="saving" @click="cancelEdit">
              {{ t('team.cancel') }}
            </Button>
            <Button size="sm" variant="primary" :loading="saving" @click="save">
              {{ t('team.save') }}
            </Button>
          </div>
        </div>

        <div v-else class="tmd-details">
          <div v-if="member.prompt" class="tmd-prompt">
            <span class="tmd-k">{{ t('team.hirePrompt') }}</span>
            <div class="tmd-prompt-body">{{ member.prompt }}</div>
          </div>
          <div class="tmd-line">
            <span class="tmd-k">{{ t('team.memberTitleLabel') }}</span>
            <span class="tmd-v">{{ member.role }}</span>
          </div>
          <div class="tmd-line">
            <span class="tmd-k">{{ t('team.hireModel') }}</span>
            <span class="tmd-v">{{ member.model }}</span>
          </div>
          <div v-if="member.whenToUse" class="tmd-line">
            <span class="tmd-k">{{ t('team.whenToUse') }}</span>
            <span class="tmd-v">{{ member.whenToUse }}</span>
          </div>
          <div v-if="member.description" class="tmd-line">
            <span class="tmd-k">{{ t('team.descriptionLabel') }}</span>
            <span class="tmd-v">{{ member.description }}</span>
          </div>
          <div v-if="member.tools.length > 0" class="tmd-line">
            <span class="tmd-k">{{ t('team.tools') }}</span>
            <span class="tmd-v tmd-tools">{{ member.tools.join(', ') }}</span>
          </div>
          <div class="tmd-line">
            <span class="tmd-k">{{ t('team.score') }}</span>
            <span class="tmd-v">{{ scoreLabel }}</span>
          </div>
        </div>
      </section>

      <!-- ====================== Token usage (this session) ================= -->
      <section class="tmd-usage">
        <div class="tmd-head">
          <span class="tmd-k">{{ t('team.memberUsageLabel') }}</span>
        </div>
        <div v-if="hasSessionUsage && sessionUsage" class="tmd-usage-row">
          <span class="tmd-usage-k">{{ t('team.memberUsageSession') }}</span>
          <span class="tmd-usage-cells">
            <span class="tmd-usage-cell-label">In</span>
            <span class="tmd-usage-cell-value">{{ formatTokens(sessionUsage.input) }}</span>
            <span class="tmd-usage-cell-label">Out</span>
            <span class="tmd-usage-cell-value">{{ formatTokens(sessionUsage.output) }}</span>
            <span class="tmd-usage-cell-label">Σ</span>
            <span class="tmd-usage-cell-value tmd-usage-cell-total">{{ formatTokens(sessionUsage.input + sessionUsage.output) }}</span>
          </span>
        </div>
        <div v-else-if="usageData" class="tmd-usage-none">
          {{ t('team.memberUsageNone') }}
        </div>
      </section>

      <!-- ==================== Bottom: live workflow / idle ================ -->
        <section class="tmd-bottom">
          <div class="tmd-head">
            <span class="tmd-k">{{ t('team.memberWorkflowLabel') }}</span>
          </div>
          <AgentWorkflow
            v-if="liveMember"
            :member="liveMember"
            :scroll-target="bodyEl"
            @open-file="(target) => emit('openFile', target)"
          />
          <EmptyState v-else :title="t('team.memberIdle', { name: member.name })" />
        </section>
      </template>
      <EmptyState v-else :title="t('team.memberNotFound')" />
    </div>

    <!-- Polish-prompt dialog: 原文 + 润色文 side by side; confirm backfills the
         prompt field (the user still saves via the normal Save button). -->
    <Dialog
      :open="polishOpen"
      :title="t('team.polishTitle')"
      size="lg"
      @close="cancelPolish"
    >
      <div v-if="polishLoading" class="tmd-polish-state">
        <Spinner size="sm" />
        <span>{{ t('team.polishLoading') }}</span>
      </div>
      <div v-else-if="polishError" class="tmd-polish-state tmd-polish-error" role="alert">
        <Icon name="alert-triangle" size="lg" />
        <span>{{ polishError }}</span>
      </div>
      <template v-else-if="polishPolished">
        <div class="tmd-polish-col">
          <span class="tmd-k">{{ t('team.polishOriginal') }}</span>
          <div class="tmd-polish-body">{{ polishOriginal }}</div>
        </div>
        <div class="tmd-polish-col">
          <span class="tmd-k">{{ t('team.polishPolished') }}</span>
          <div class="tmd-polish-body tmd-polish-body--new">{{ polishPolished }}</div>
        </div>
      </template>
      <template #foot>
        <Button size="sm" variant="secondary" :disabled="polishLoading" @click="cancelPolish">
          {{ t('team.cancel') }}
        </Button>
        <Button size="sm" variant="primary" :disabled="!polishPolished" @click="applyPolish">
          {{ t('team.polishConfirm') }}
        </Button>
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.tmd {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--color-bg);
}

.tmd-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.tmd-top,
.tmd-usage,
.tmd-bottom {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}
.tmd-usage,
.tmd-bottom {
  padding-top: var(--space-3);
  border-top: 1px solid var(--color-line);
}

.tmd-usage-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
.tmd-usage-k {
  flex: none;
  color: var(--color-text-muted);
}
.tmd-usage-cells {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
}
.tmd-usage-cell-label { color: var(--color-text-faint); }
.tmd-usage-cell-value {
  min-width: 40px;
  text-align: right;
  color: var(--color-text-muted);
}
.tmd-usage-cell-total {
  min-width: 46px;
  font-weight: var(--weight-medium);
  color: var(--color-text);
}
.tmd-usage-none {
  font-size: var(--text-xs);
  color: var(--color-text-faint);
}

.tmd-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
.tmd-spacer { flex: 1; }
.tmd-k {
  flex: none;
  font: var(--text-xs) var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-text-muted);
}

.tmd-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.tmd-error {
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--color-danger-soft);
  color: var(--color-danger);
  font-size: var(--text-sm);
  overflow-wrap: anywhere;
}
.tmd-form-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}

.tmd-details {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}
.tmd-prompt {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface);
}
.tmd-prompt-body {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 160px;
  overflow-y: auto;
}
.tmd-line {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
  font-size: var(--text-sm);
}
.tmd-v {
  min-width: 0;
  color: var(--color-text-muted);
  overflow-wrap: anywhere;
}
.tmd-tools { color: var(--color-text); }

/* Prompt field + polish button */
.tmd-prompt-edit {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.tmd-prompt-edit .ui-button {
  align-self: flex-end;
}

/* Polish-prompt dialog body */
.tmd-polish-state {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-4) 0;
  color: var(--color-text-muted);
  font-size: var(--text-base);
}
.tmd-polish-state.tmd-polish-error { color: var(--color-danger); }

.tmd-polish-col {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.tmd-polish-body {
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 200px;
  overflow-y: auto;
}
.tmd-polish-body--new { color: var(--color-text); }
</style>
