<!-- apps/kimi-web/src/components/team/TeamPanel.vue -->
<!-- /team overlay — subagent team management for the CURRENT session. Renders
     the read-only roster (name/role/status/model/avg score) and the management
     actions (hire, fire confirm, change model, score, message, concurrency,
     team mode). Polls GET /teams/{session_id}/members every 2.5s like the TUI.
     Built on the design-system Dialog / Card / Badge / Button primitives.
     The sub-forms (hire/score/model/message) are single-view states INSIDE the
     one Dialog — never nested <Dialog>s — so Esc / overlay-click can't close
     two modals at once. -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { getKimiWebApi } from '../../api';
import type { AppTeamMember } from '../../api/types';
import {
  averageScoreLabel,
  sortTeamMembers,
  summarizeTeam,
  teamStatusMeta,
} from '../../lib/teamRows';
import Dialog from '../ui/Dialog.vue';
import Button from '../ui/Button.vue';
import IconButton from '../ui/IconButton.vue';
import Icon from '../ui/Icon.vue';
import Badge from '../ui/Badge.vue';
import Card from '../ui/Card.vue';
import Field from '../ui/Field.vue';
import Input from '../ui/Input.vue';
import Textarea from '../ui/Textarea.vue';
import Switch from '../ui/Switch.vue';
import Select from '../ui/Select.vue';
import EmptyState from '../ui/EmptyState.vue';
import Spinner from '../ui/Spinner.vue';

const { t } = useI18n();

const props = defineProps<{
  /** The session whose team this panel manages (the active session). */
  sessionId: string;
}>();

const emit = defineEmits<{ close: [] }>();

const api = getKimiWebApi();

// The parent controls visibility with `v-if`, so the dialog is open whenever
// this component is mounted. Dialog emits `close` on Esc / overlay / close
// button, which we forward to the parent.
const open = ref(true);

// ---------------------------------------------------------------------------
// Roster state + polling
// ---------------------------------------------------------------------------
const globalMembers = ref<AppTeamMember[]>([]);
const projectMembers = ref<AppTeamMember[]>([]);
const teamMode = ref(false);
const loading = ref(true);
/** Persistent first-load failure (e.g. the backend route isn't shipped yet).
 *  Kept only while the roster is empty; later successes clear it. */
const loadError = ref<string | null>(null);
/** Failure from the most recent mutation, shown inline above the content. */
const actionError = ref<string | null>(null);
/** Score-inflation warning returned by the last score submission. */
const notice = ref<string | null>(null);
/** True while any mutation is in flight — disables the action affordances. */
const busy = ref(false);

const POLL_MS = 2500;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollInFlight = false;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function refresh(): Promise<void> {
  if (pollInFlight) return; // a poll is already round-tripping — skip this tick
  pollInFlight = true;
  try {
    const data = await api.getTeamMembers(props.sessionId);
    globalMembers.value = data.global;
    projectMembers.value = data.project;
    teamMode.value = data.teamMode;
    loadError.value = null;
  } catch (err) {
    // Keep the last-known roster; surface the error only when nothing is shown.
    if (globalMembers.value.length === 0 && projectMembers.value.length === 0) {
      loadError.value = errorMessage(err);
    }
  } finally {
    pollInFlight = false;
    loading.value = false;
  }
}

onMounted(() => {
  void refresh();
  pollTimer = setInterval(() => void refresh(), POLL_MS);
});

onUnmounted(() => {
  if (pollTimer !== null) clearInterval(pollTimer);
});

// ---------------------------------------------------------------------------
// Roster derivations (pure helpers from lib/teamRows)
// ---------------------------------------------------------------------------
// Dual-scope aggregation happens HERE (component side), one section at a time;
// the pure helpers in lib/teamRows keep their single-array semantics so the
// unit tests stay meaningful. The overall summary is the sum of the two.
const globalRows = computed(() => sortTeamMembers(globalMembers.value));
const projectRows = computed(() => sortTeamMembers(projectMembers.value));
const summaryGlobal = computed(() => summarizeTeam(globalMembers.value));
const summaryProject = computed(() => summarizeTeam(projectMembers.value));
const summary = computed(() => ({
  total: summaryGlobal.value.total + summaryProject.value.total,
  working: summaryGlobal.value.working + summaryProject.value.working,
  onDuty: summaryGlobal.value.onDuty + summaryProject.value.onDuty,
  resting: summaryGlobal.value.resting + summaryProject.value.resting,
  offDuty: summaryGlobal.value.offDuty + summaryProject.value.offDuty,
}));

/** The two roster sections rendered by the panel — title/path resolved via
 *  i18n keys in the template (keeps `t()` reactive and this computed pure). */
const sections = computed(() => [
  {
    key: 'global',
    titleKey: 'globalTeam',
    pathKey: 'globalScopePath',
    rows: globalRows.value,
    summary: summaryGlobal.value,
  },
  {
    key: 'project',
    titleKey: 'projectTeam',
    pathKey: 'projectScopePath',
    rows: projectRows.value,
    summary: summaryProject.value,
  },
]);

function scoreLabel(member: AppTeamMember): string | null {
  return averageScoreLabel(member.score);
}

function currentScoreLabel(member: AppTeamMember): string {
  return scoreLabel(member) ?? t('team.scoreNone');
}

// ---------------------------------------------------------------------------
// View state — one Dialog, one active view. Sub-views are NOT nested dialogs,
// so Esc/overlay-click always closes exactly one layer.
// ---------------------------------------------------------------------------
type PanelView =
  | { kind: 'roster' }
  | { kind: 'hire' }
  | { kind: 'score'; member: AppTeamMember }
  | { kind: 'model'; member: AppTeamMember }
  | { kind: 'message'; member: AppTeamMember };

const view = ref<PanelView>({ kind: 'roster' });

const dialogTitle = computed(() => {
  switch (view.value.kind) {
    case 'roster':
      return t('team.panelTitle');
    case 'hire':
      return t('team.hireTitle');
    case 'score':
      return t('team.scoreTitle', { name: view.value.member.name });
    case 'model':
      return t('team.modelTitle', { name: view.value.member.name });
    case 'message':
      return t('team.messageTitle', { name: view.value.member.name });
  }
});

function goRoster(): void {
  view.value = { kind: 'roster' };
}

// ---------------------------------------------------------------------------
// teamMode + concurrency (session-level, live on the roster view)
// ---------------------------------------------------------------------------
async function toggleTeamMode(next: boolean): Promise<void> {
  const previous = teamMode.value;
  teamMode.value = next; // optimistic — the 2.5s poll self-corrects on failure
  busy.value = true;
  actionError.value = null;
  try {
    await api.setTeamMode(next);
  } catch (err) {
    teamMode.value = previous;
    actionError.value = errorMessage(err);
  } finally {
    busy.value = false;
  }
}

const concurrencyOpen = ref(false);
const concurrencyLimit = ref('');

async function applyConcurrency(): Promise<void> {
  const raw = concurrencyLimit.value.trim();
  if (raw !== '') {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      actionError.value = t('team.concurrencyRange');
      return;
    }
  }
  busy.value = true;
  actionError.value = null;
  try {
    await api.setTeamConcurrency(props.sessionId, raw === '' ? undefined : Number(raw));
    concurrencyOpen.value = false;
    concurrencyLimit.value = '';
  } catch (err) {
    actionError.value = errorMessage(err);
  } finally {
    busy.value = false;
  }
}

async function resetConcurrency(): Promise<void> {
  busy.value = true;
  actionError.value = null;
  try {
    await api.setTeamConcurrency(props.sessionId);
    concurrencyOpen.value = false;
    concurrencyLimit.value = '';
  } catch (err) {
    actionError.value = errorMessage(err);
  } finally {
    busy.value = false;
  }
}

// ---------------------------------------------------------------------------
// Fire (two-step inline confirm on the row)
// ---------------------------------------------------------------------------
const confirmingFire = ref<string | null>(null);

async function doFire(name: string): Promise<void> {
  busy.value = true;
  actionError.value = null;
  try {
    const result = await api.fireTeamMember(props.sessionId, name);
    if (!result.ok) {
      actionError.value = t('team.fireFailed');
    } else {
      confirmingFire.value = null;
      await refresh();
    }
  } catch (err) {
    actionError.value = errorMessage(err);
  } finally {
    busy.value = false;
  }
}

// ---------------------------------------------------------------------------
// Hire form
// ---------------------------------------------------------------------------
const hireForm = ref({
  name: '',
  role: '',
  description: '',
  whenToUse: '',
  model: '',
  tools: '',
  skills: '',
  duty: false,
  prompt: '',
  scope: 'user' as 'user' | 'project',
});

function openHire(): void {
  hireForm.value = {
    name: '',
    role: '',
    description: '',
    whenToUse: '',
    model: '',
    tools: '',
    skills: '',
    duty: false,
    prompt: '',
    scope: 'user',
  };
  actionError.value = null;
  notice.value = null;
  view.value = { kind: 'hire' };
}

function splitList(raw: string): string[] {
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

async function submitHire(): Promise<void> {
  const f = hireForm.value;
  if (!f.name.trim() || !f.role.trim() || !f.description.trim() || !f.whenToUse.trim() || !f.prompt.trim()) {
    actionError.value = t('team.hireRequired');
    return;
  }
  busy.value = true;
  actionError.value = null;
  try {
    const tools = splitList(f.tools);
    const skills = splitList(f.skills);
    await api.hireTeamMember(props.sessionId, {
      name: f.name.trim(),
      role: f.role.trim(),
      description: f.description.trim(),
      whenToUse: f.whenToUse.trim(),
      model: f.model.trim() || undefined,
      tools: tools.length > 0 ? tools : undefined,
      skills: skills.length > 0 ? skills : undefined,
      duty: f.duty,
      prompt: f.prompt,
      scope: f.scope,
    });
    view.value = { kind: 'roster' };
    await refresh();
  } catch (err) {
    actionError.value = errorMessage(err);
  } finally {
    busy.value = false;
  }
}

// ---------------------------------------------------------------------------
// Score
// ---------------------------------------------------------------------------
const scoreForm = ref({ score: '100', note: '', model: '' });

function openScore(member: AppTeamMember): void {
  scoreForm.value = { score: '100', note: '', model: member.model };
  actionError.value = null;
  view.value = { kind: 'score', member };
}

async function submitScore(): Promise<void> {
  if (view.value.kind !== 'score') return;
  const member = view.value.member;
  const value = Number(scoreForm.value.score);
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    actionError.value = t('team.scoreRange');
    return;
  }
  busy.value = true;
  actionError.value = null;
  try {
    const result = await api.scoreTeamMember(props.sessionId, member.name, {
      score: value,
      note: scoreForm.value.note,
      model: scoreForm.value.model.trim() || undefined,
    });
    notice.value = result.warning ?? null;
    view.value = { kind: 'roster' };
    await refresh();
  } catch (err) {
    actionError.value = errorMessage(err);
  } finally {
    busy.value = false;
  }
}

// ---------------------------------------------------------------------------
// Change model
// ---------------------------------------------------------------------------
const modelForm = ref('');

function openModel(member: AppTeamMember): void {
  modelForm.value = member.model;
  actionError.value = null;
  view.value = { kind: 'model', member };
}

async function submitModel(): Promise<void> {
  if (view.value.kind !== 'model') return;
  const member = view.value.member;
  busy.value = true;
  actionError.value = null;
  try {
    await api.updateTeamMember(props.sessionId, member.name, {
      model: modelForm.value.trim() || undefined,
    });
    view.value = { kind: 'roster' };
    await refresh();
  } catch (err) {
    actionError.value = errorMessage(err);
  } finally {
    busy.value = false;
  }
}

// ---------------------------------------------------------------------------
// Message (递话)
// ---------------------------------------------------------------------------
const messageForm = ref({ text: '', interrupt: false });

function openMessage(member: AppTeamMember): void {
  messageForm.value = { text: '', interrupt: false };
  actionError.value = null;
  view.value = { kind: 'message', member };
}

async function submitMessage(): Promise<void> {
  if (view.value.kind !== 'message') return;
  const member = view.value.member;
  if (!messageForm.value.text.trim()) {
    actionError.value = t('team.messageRequired');
    return;
  }
  busy.value = true;
  actionError.value = null;
  try {
    // agent_id is the member's name — the wire roster carries no separate id.
    await api.messageTeamAgent(props.sessionId, member.name, {
      message: messageForm.value.text,
      interrupt: messageForm.value.interrupt || undefined,
    });
    view.value = { kind: 'roster' };
  } catch (err) {
    actionError.value = errorMessage(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Dialog v-model:open="open" size="lg" height="fixed" @close="emit('close')">
    <!-- Custom head: back button (sub-views) + title + description (roster). -->
    <template #head>
      <div class="tp-head">
        <IconButton
          v-if="view.kind !== 'roster'"
          size="sm"
          :label="t('team.back')"
          @click="goRoster"
        >
          <Icon name="undo" size="md" />
        </IconButton>
        <div class="tp-titles">
          <div class="tp-title">{{ dialogTitle }}</div>
          <div v-if="view.kind === 'roster'" class="tp-desc">{{ t('team.description') }}</div>
        </div>
      </div>
    </template>

    <div class="tp">
      <!-- ============================ Roster ============================ -->
      <template v-if="view.kind === 'roster'">
        <div class="tp-controls">
          <div class="tp-mode">
            <span class="tp-label">{{ t('team.teamMode') }}</span>
            <Switch
              :model-value="teamMode"
              :label="t('team.teamMode')"
              :disabled="busy"
              @update:model-value="toggleTeamMode"
            />
          </div>

          <div class="tp-conc">
            <Button
              v-if="!concurrencyOpen"
              size="sm"
              variant="secondary"
              @click="concurrencyOpen = true"
            >
              <Icon name="sliders" size="sm" />
              {{ t('team.concurrency') }}
            </Button>
            <div v-else class="tp-conc-form">
              <Input
                v-model="concurrencyLimit"
                size="sm"
                type="number"
                min="1"
                :placeholder="t('team.concurrencyPlaceholder')"
              />
              <Button size="sm" variant="primary" :disabled="busy" @click="applyConcurrency">
                {{ t('team.concurrencySet') }}
              </Button>
              <Button size="sm" variant="ghost" :disabled="busy" @click="resetConcurrency">
                {{ t('team.concurrencyReset') }}
              </Button>
            </div>
          </div>

          <span class="tp-spacer" />

          <Button size="sm" variant="primary" :disabled="busy" @click="openHire">
            <Icon name="plus" size="sm" />
            {{ t('team.hire') }}
          </Button>
        </div>

        <div class="tp-summary">
          <span class="tp-count">{{ t('team.membersCount', { count: summary.total }) }}</span>
          <Badge v-if="summary.working > 0" variant="info" size="sm">
            {{ t('team.working', { count: summary.working }) }}
          </Badge>
          <Badge v-if="summary.onDuty > 0" variant="success" size="sm">
            {{ t('team.onDuty', { count: summary.onDuty }) }}
          </Badge>
          <Badge v-if="summary.resting > 0" variant="warning" size="sm">
            {{ t('team.resting', { count: summary.resting }) }}
          </Badge>
          <Badge v-if="summary.offDuty > 0" variant="neutral" size="sm">
            {{ t('team.offDuty', { count: summary.offDuty }) }}
          </Badge>
        </div>

        <div v-if="notice" class="tp-notice" role="status">
          <Icon name="alert-triangle" size="sm" />
          {{ t('team.scoreWarning', { warning: notice }) }}
        </div>
        <div v-if="actionError" class="tp-error" role="alert">{{ actionError }}</div>

        <div v-if="loading" class="tp-loading">
          <Spinner size="sm" />
          {{ t('team.loading') }}
        </div>

        <div v-else-if="loadError" class="tp-empty">
          <EmptyState :title="t('team.loadFailed', { error: loadError })" />
        </div>

        <div v-else-if="summary.total === 0" class="tp-empty">
          <EmptyState :title="t('team.empty')" :hint="t('team.emptyHint')" />
        </div>

        <div v-else class="tp-roster">
          <section
            v-for="sec in sections"
            :key="sec.key"
            class="tp-scope"
            :data-scope="sec.key"
          >
            <header class="tp-scope-head">
              <span class="tp-scope-title">{{ t('team.' + sec.titleKey) }}</span>
              <span class="tp-scope-count">{{ t('team.membersCount', { count: sec.summary.total }) }}</span>
              <span class="tp-spacer" />
              <span class="tp-scope-path">{{ t('team.' + sec.pathKey) }}</span>
            </header>
            <div v-if="sec.rows.length === 0" class="tp-scope-empty">
              {{ t('team.noMembers') }}
            </div>
            <div v-else class="tp-list">
              <Card
                v-for="member in sec.rows"
                :key="`${sec.key}-${member.name}`"
                class="tp-card"
              >
                <template #head>
                  <div class="tp-card-head">
                    <span class="tp-name" :title="member.name">{{ member.name }}</span>
                    <Badge
                      :variant="teamStatusMeta(member.status).variant"
                      size="sm"
                      dot
                    >{{ t('team.status.' + member.status) }}</Badge>
                    <Badge v-if="member.duty" variant="warning" size="sm">{{ t('team.dutyBadge') }}</Badge>
                    <span class="tp-spacer" />
                    <IconButton
                      size="sm"
                      :label="t('team.message')"
                      :disabled="busy"
                      @click="openMessage(member)"
                    >
                      <Icon name="message" size="md" />
                    </IconButton>
                    <IconButton
                      size="sm"
                      :label="t('team.model')"
                      :disabled="busy"
                      @click="openModel(member)"
                    >
                      <Icon name="pencil" size="md" />
                    </IconButton>
                    <IconButton
                      size="sm"
                      :label="t('team.score')"
                      :disabled="busy"
                      @click="openScore(member)"
                    >
                      <Icon name="star" size="md" />
                    </IconButton>
                  </div>
                </template>

                <div class="tp-card-body">
                  <div class="tp-meta">
                    <span class="tp-role">{{ member.role }}</span>
                    <span class="tp-model">{{ member.model }}</span>
                    <Badge v-if="scoreLabel(member)" size="sm" variant="neutral" class="tp-score">
                      <Icon name="star" size="sm" />
                      {{ scoreLabel(member) }}
                    </Badge>
                    <span v-else class="tp-score-none">{{ t('team.scoreNone') }}</span>
                  </div>
                  <div v-if="member.whenToUse" class="tp-line">
                    <span class="tp-k">{{ t('team.whenToUse') }}</span>
                    <span class="tp-v">{{ member.whenToUse }}</span>
                  </div>
                  <div v-if="member.description" class="tp-line">
                    <span class="tp-k">{{ t('team.descriptionLabel') }}</span>
                    <span class="tp-v">{{ member.description }}</span>
                  </div>
                  <div v-if="member.tools.length > 0" class="tp-line">
                    <span class="tp-k">{{ t('team.tools') }}</span>
                    <span class="tp-v tp-tools">{{ member.tools.join(', ') }}</span>
                  </div>

                  <div class="tp-fire">
                    <template v-if="confirmingFire === member.name">
                      <span class="tp-fire-text">
                        {{ t('team.fireConfirm', { name: member.name }) }}
                      </span>
                      <Button size="sm" variant="danger" :disabled="busy" @click="doFire(member.name)">
                        {{ t('team.fire') }}
                      </Button>
                      <Button size="sm" variant="ghost" :disabled="busy" @click="confirmingFire = null">
                        {{ t('team.cancel') }}
                      </Button>
                    </template>
                    <Button
                      v-else
                      size="sm"
                      variant="danger-soft"
                      :disabled="busy"
                      @click="confirmingFire = member.name"
                    >
                      {{ t('team.fire') }}
                    </Button>
                  </div>
                </div>
              </Card>
            </div>
          </section>
        </div>
      </template>

      <!-- ============================ Hire ============================ -->
      <template v-else-if="view.kind === 'hire'">
        <div v-if="actionError" class="tp-error" role="alert">{{ actionError }}</div>
        <div class="tp-form">
          <Field :label="t('team.hireName')">
            <Input v-model="hireForm.name" :placeholder="t('team.hireName')" />
          </Field>
          <Field :label="t('team.hireRole')">
            <Input v-model="hireForm.role" :placeholder="t('team.hireRole')" />
          </Field>
          <Field :label="t('team.hireDescription')">
            <Textarea v-model="hireForm.description" :rows="2" />
          </Field>
          <Field :label="t('team.hireWhenToUse')">
            <Textarea v-model="hireForm.whenToUse" :rows="2" />
          </Field>
          <Field :label="t('team.scopeLabel')" :hint="t('team.scopeHint')">
            <Select v-model="hireForm.scope">
              <option value="user">{{ t('team.scopeGlobal') }}</option>
              <option value="project">{{ t('team.scopeProject') }}</option>
            </Select>
          </Field>
          <Field :label="t('team.hireModel')" :hint="t('team.optional')">
            <Input v-model="hireForm.model" />
          </Field>
          <Field :label="t('team.hireTools')" :hint="t('team.commaList')">
            <Input v-model="hireForm.tools" />
          </Field>
          <Field :label="t('team.hireSkills')" :hint="t('team.commaList')">
            <Input v-model="hireForm.skills" />
          </Field>
          <div class="tp-inline">
            <Switch v-model="hireForm.duty" :label="t('team.hireDuty')" />
            <span class="tp-inline-label">{{ t('team.hireDuty') }}</span>
          </div>
          <Field :label="t('team.hirePrompt')">
            <Textarea v-model="hireForm.prompt" :rows="4" />
          </Field>
        </div>
        <div class="tp-foot">
          <Button variant="secondary" :disabled="busy" @click="goRoster">
            {{ t('team.cancel') }}
          </Button>
          <Button variant="primary" :loading="busy" @click="submitHire">
            {{ t('team.hireSubmit') }}
          </Button>
        </div>
      </template>

      <!-- ============================ Score ============================ -->
      <template v-else-if="view.kind === 'score'">
        <div v-if="actionError" class="tp-error" role="alert">{{ actionError }}</div>
        <div class="tp-form">
          <div class="tp-current">
            {{ t('team.scoreCurrent', { label: currentScoreLabel(view.member) }) }}
          </div>
          <Field :label="t('team.scoreValue')" :hint="t('team.scoreRangeHint')">
            <Input
              v-model="scoreForm.score"
              type="number"
              min="0"
              max="100"
              step="1"
              :placeholder="t('team.scorePlaceholder')"
            />
          </Field>
          <Field :label="t('team.scoreNote')">
            <Textarea v-model="scoreForm.note" :rows="3" />
          </Field>
          <Field :label="t('team.hireModel')" :hint="t('team.optional')">
            <Input v-model="scoreForm.model" />
          </Field>
        </div>
        <div class="tp-foot">
          <Button variant="secondary" :disabled="busy" @click="goRoster">
            {{ t('team.cancel') }}
          </Button>
          <Button variant="primary" :loading="busy" @click="submitScore">
            {{ t('team.scoreSubmit') }}
          </Button>
        </div>
      </template>

      <!-- ============================ Model ============================ -->
      <template v-else-if="view.kind === 'model'">
        <div v-if="actionError" class="tp-error" role="alert">{{ actionError }}</div>
        <div class="tp-form">
          <Field :label="t('team.hireModel')">
            <Input v-model="modelForm" :placeholder="view.member.model" />
          </Field>
        </div>
        <div class="tp-foot">
          <Button variant="secondary" :disabled="busy" @click="goRoster">
            {{ t('team.cancel') }}
          </Button>
          <Button variant="primary" :loading="busy" @click="submitModel">
            {{ t('team.save') }}
          </Button>
        </div>
      </template>

      <!-- ============================ Message ============================ -->
      <template v-else>
        <div v-if="actionError" class="tp-error" role="alert">{{ actionError }}</div>
        <div class="tp-form">
          <Field :label="t('team.messageText')">
            <Textarea v-model="messageForm.text" :rows="4" />
          </Field>
          <div class="tp-inline">
            <Switch v-model="messageForm.interrupt" :label="t('team.messageInterrupt')" />
            <span class="tp-inline-label">{{ t('team.messageInterrupt') }}</span>
          </div>
        </div>
        <div class="tp-foot">
          <Button variant="secondary" :disabled="busy" @click="goRoster">
            {{ t('team.cancel') }}
          </Button>
          <Button variant="primary" :loading="busy" @click="submitMessage">
            {{ t('team.messageSubmit') }}
          </Button>
        </div>
      </template>
    </div>
  </Dialog>
</template>

<style scoped>
/* Custom head (the Dialog head slot replaces the default titles block but keeps
   the close button). */
.tp-head {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  min-width: 0;
}
.tp-titles { flex: 1; min-width: 0; }
.tp-title {
  font-size: var(--text-lg);
  font-weight: var(--weight-medium);
  color: var(--color-text);
  line-height: var(--leading-tight);
}
.tp-desc { margin-top: 4px; font-size: var(--text-base); color: var(--color-text-muted); }

/* Roster header: teamMode + concurrency + hire. */
.tp-controls {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--color-line);
}
.tp-mode {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.tp-label {
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--color-text-muted);
}
.tp-conc { display: flex; align-items: center; }
.tp-conc-form {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.tp-conc-form .ui-input { width: 88px; }
.tp-spacer { flex: 1; }

.tp-summary {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) 0 var(--space-2);
}
.tp-count { font-size: var(--text-sm); color: var(--color-text-muted); }

.tp-notice {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  margin-bottom: var(--space-2);
  border-radius: var(--radius-md);
  background: var(--color-warning-soft);
  color: var(--color-warning);
  font-size: var(--text-sm);
}
.tp-error {
  padding: var(--space-2) var(--space-3);
  margin-bottom: var(--space-2);
  border-radius: var(--radius-md);
  background: var(--color-danger-soft);
  color: var(--color-danger);
  font-size: var(--text-sm);
  overflow-wrap: anywhere;
}

.tp-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-8) var(--space-4);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}
.tp-empty { padding: var(--space-2) 0; }

.tp-roster {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-1) 0 var(--space-2);
}
.tp-scope {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}
.tp-scope-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  padding-bottom: var(--space-1);
  border-bottom: 1px solid var(--color-line);
}
.tp-scope-title {
  flex: none;
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  color: var(--color-text);
}
.tp-scope-count {
  flex: none;
  font-size: var(--text-xs);
  color: var(--color-text-faint);
}
.tp-scope-path {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tp-scope-empty {
  padding: var(--space-3);
  border: 1px dashed var(--color-line-strong);
  border-radius: var(--radius-md);
  color: var(--color-text-faint);
  font-size: var(--text-sm);
  text-align: center;
}

.tp-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.tp-card { flex: none; }
.tp-card-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
.tp-name {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tp-card-body { display: flex; flex-direction: column; gap: var(--space-2); }
.tp-meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  min-width: 0;
}
.tp-role {
  font-size: var(--text-sm);
  color: var(--color-text);
  font-weight: var(--weight-medium);
}
.tp-model {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tp-score { flex: none; }
.tp-score :deep(svg) { flex: none; }
.tp-score-none { font-size: var(--text-xs); color: var(--color-text-faint); }

.tp-line {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
  font-size: var(--text-sm);
}
.tp-k {
  flex: none;
  color: var(--color-text-faint);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: var(--text-xs);
}
.tp-v {
  min-width: 0;
  color: var(--color-text-muted);
  overflow-wrap: anywhere;
}
.tp-tools { color: var(--color-text); }

.tp-fire {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  padding-top: var(--space-1);
  border-top: 1px solid var(--color-line);
}
.tp-fire-text {
  flex: 1;
  min-width: 0;
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  overflow-wrap: anywhere;
}

/* Sub-views: form + footer. */
.tp-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-2) 0 var(--space-1);
}
.tp-inline {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.tp-inline-label { font-size: var(--text-sm); color: var(--color-text-muted); }
.tp-current { font-size: var(--text-sm); color: var(--color-text-muted); }
.tp-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  padding-top: var(--space-3);
  border-top: 1px solid var(--color-line);
}
</style>
