<!-- apps/kimi-web/src/components/settings/ProviderManager.vue -->
<!-- Provider settings page (modal): list, add, edit, refresh, delete.
     Add + edit persist to config.toml through the server's provider CRUD
     (POST /providers, PUT /providers/{id}) — the UI replaces hand-editing
     ~/.kimi-code/config.toml, including for non-kimi users configuring a
     third-party provider (apiKey + baseUrl + models). -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { getKimiWebApi } from '../../api';
import type {
  AppModel,
  AppProvider,
  AppProviderModelInput,
  AppProviderUpdate,
} from '../../api/types';
import { useDialogFocus } from '../../composables/useDialogFocus';
import {
  DEFAULT_MAX_CONTEXT_SIZE,
  emptyProviderForm,
  PROVIDER_TYPE_LABEL_KEYS,
  PROVIDER_WIRE_TYPES,
  providerModelsFromCatalog,
  validateProviderForm,
  type ProviderFormState,
  type ProviderWireType,
} from '../../lib/providerForm';
import Dialog from '../ui/Dialog.vue';
import Button from '../ui/Button.vue';
import Badge from '../ui/Badge.vue';
import Spinner from '../ui/Spinner.vue';
import Field from '../ui/Field.vue';
import Input from '../ui/Input.vue';
import Select from '../ui/Select.vue';
import Icon from '../ui/Icon.vue';
import IconButton from '../ui/IconButton.vue';
import Tooltip from '../ui/Tooltip.vue';

const { t } = useI18n();

const dialogRef = ref<HTMLElement | null>(null);
// Move focus into the dialog on open; restore it to the opener on close.
useDialogFocus(dialogRef);

const props = defineProps<{
  providers: AppProvider[];
  /** Model catalog — rebuilds edit-form model rows with real context sizes and
   *  resolves the default-model alias to its raw name. */
  models: AppModel[];
  loading?: boolean;
  /** If true, providers could not be fetched (daemon 404 / unsupported) */
  unavailable?: boolean;
}>();

const emit = defineEmits<{
  add: [input: {
    id: string;
    type: string;
    apiKey?: string;
    baseUrl?: string;
    defaultModel?: string;
    models: AppProviderModelInput[];
  }];
  update: [id: string, input: AppProviderUpdate];
  refresh: [id: string];
  delete: [id: string];
  /** Open the login dialog for the given platform (OAuth flow) */
  openLogin: [platform: string];
  close: [];
}>();

// -------------------------------------------------------------------------
// Delete confirmation — the modal confirm and the async delete live in App.vue
// (confirmDeleteProvider); the manager only emits the intent.
// -------------------------------------------------------------------------
function onDeleteProvider(id: string): void {
  emit('delete', id);
}

// -------------------------------------------------------------------------
// Add / edit provider form — shared shape (id read-only in edit mode).
// Add requires an api key; edit may leave it blank to keep the stored key
// (the server's tri-state api_key: omitted keeps, "" clears, value replaces).
// `models` is required (min 1) on both — it is what registers the model
// aliases that make the provider immediately usable.
// -------------------------------------------------------------------------
const showAddForm = ref(false);
const showEditForm = ref(false);
const editingId = ref('');
const editLoading = ref(false);
const form = reactive<ProviderFormState>(emptyProviderForm());
const formError = ref('');

const nonEmptyModelRows = computed(() => form.models.filter((row) => row.model.trim().length > 0));

function openAdd(): void {
  showEditForm.value = false;
  editingId.value = '';
  Object.assign(form, emptyProviderForm());
  formError.value = '';
  showAddForm.value = true;
}

/** Open the edit form for a provider. The list row carries baseUrl/defaultModel/
 *  models; the stored api_key is revealed via GET /providers/{id} for prefill
 *  (non-fatal: on failure the field stays blank = "keep stored key" on save). */
async function openEdit(p: AppProvider): Promise<void> {
  showAddForm.value = false;
  showEditForm.value = true;
  editingId.value = p.id;
  formError.value = '';
  form.id = p.id;
  form.type = isWireType(p.type) ? p.type : 'openai';
  form.baseUrl = p.baseUrl ?? '';
  form.models = providerModelsFromCatalog(p.models, p.id, props.models);
  form.defaultModel = '';
  if (p.defaultModel) {
    form.defaultModel = props.models.find((m) => m.id === p.defaultModel)?.model ?? '';
  }
  form.apiKey = '';
  editLoading.value = true;
  try {
    const detail = await getKimiWebApi().getProvider(p.id);
    form.apiKey = detail.apiKey ?? '';
  } catch {
    // Keep blank → the PUT omits api_key → the stored key is kept.
  } finally {
    editLoading.value = false;
  }
}

function cancelForm(): void {
  showAddForm.value = false;
  showEditForm.value = false;
  editingId.value = '';
  editLoading.value = false;
  formError.value = '';
}

function submitForm(): void {
  const error = validateProviderForm(form, showAddForm.value);
  if (error !== null) {
    formError.value = error;
    return;
  }
  formError.value = '';
  const base: AppProviderUpdate = {
    type: form.type,
    apiKey: form.apiKey.trim() || undefined,
    baseUrl: form.baseUrl.trim() || undefined,
    defaultModel: form.defaultModel.trim() || undefined,
    models: form.models
      .map((row) => ({ model: row.model.trim(), maxContextSize: row.maxContextSize }))
      .filter((row) => row.model.length > 0),
  };
  if (showEditForm.value) {
    emit('update', editingId.value, base);
  } else {
    emit('add', { id: form.id.trim(), ...base });
  }
  cancelForm();
}

function addModelRow(): void {
  form.models.push({ model: '', maxContextSize: DEFAULT_MAX_CONTEXT_SIZE });
}
function removeModelRow(idx: number): void {
  if (form.models.length <= 1) return;
  form.models.splice(idx, 1);
}

function isWireType(value: string): value is ProviderWireType {
  return (PROVIDER_WIRE_TYPES as readonly string[]).includes(value);
}
function onTypeChange(value: string): void {
  form.type = isWireType(value) ? value : 'openai';
}

// -------------------------------------------------------------------------
// Keyboard — Esc closes the open form first, then the dialog
// -------------------------------------------------------------------------
function handleKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    if (showAddForm.value || showEditForm.value) {
      cancelForm();
      return;
    }
    emit('close');
  }
}

onMounted(() => document.addEventListener('keydown', handleKeydown));
onUnmounted(() => document.removeEventListener('keydown', handleKeydown));

// -------------------------------------------------------------------------
// Status helpers
// -------------------------------------------------------------------------
function statusColor(status: AppProvider['status']): string {
  if (status === 'connected') return 'var(--color-success)';
  if (status === 'error') return 'var(--color-danger)';
  return 'var(--color-text-faint)';
}
function statusLabel(status: AppProvider['status']): string {
  if (status === 'connected') return t('providers.status.connected');
  if (status === 'error') return t('providers.status.error');
  return t('providers.status.unconfigured');
}
</script>

<template>
  <Dialog :open="true" :close-on-esc="false" :title="t('providers.title')" size="xl" height="fixed" @close="emit('close')">
    <div ref="dialogRef" class="pm">
      <!-- Provider list -->
      <div class="prov-list">
        <!-- Loading state -->
        <div v-if="loading" class="state-row">
          <Spinner size="sm" />
          <span>{{ t('providers.loading') }}</span>
        </div>
        <!-- Unavailable (daemon 404) -->
        <div v-else-if="unavailable" class="state-row unavail">
          <Icon name="alert-triangle" size="md" />
          <span>{{ t('providers.unavailable') }}</span>
        </div>
        <!-- Empty + beginner guidance -->
        <div v-else-if="providers.length === 0" class="empty-guide">
          <div class="empty-title">{{ t('providers.emptyTitle') }}</div>
          <p class="empty-text">{{ t('providers.emptyHint') }}</p>
          <p class="empty-text">{{ t('providers.emptyHintCompat') }}</p>
        </div>
        <!-- Provider rows -->
        <template v-else>
          <div v-for="p in providers" :key="p.id" class="prov-row">
            <!-- Status dot -->
            <Tooltip :text="statusLabel(p.status)">
              <span
                class="status-dot"
                :class="{ 'status-dot--empty': p.status !== 'connected' && p.status !== 'error' }"
                :style="p.status === 'connected' || p.status === 'error' ? { background: statusColor(p.status) } : undefined"
              />
            </Tooltip>
            <div class="prov-info">
              <span class="prov-type">{{ p.type }}</span>
              <span v-if="p.baseUrl" class="prov-url">{{ p.baseUrl }}</span>
              <span class="prov-meta">
                <Badge :variant="p.hasApiKey ? 'success' : 'neutral'" size="sm">
                  {{ p.hasApiKey ? t('providers.keySet') : t('providers.keyNotSet') }}
                </Badge>
                <span v-if="p.models && p.models.length > 0"> · {{ t('providers.modelCount', { count: p.models.length }) }}</span>
              </span>
            </div>
            <!-- Actions -->
            <div class="prov-actions">
              <Button variant="secondary" size="sm" @click="openEdit(p)">{{ t('providers.edit') }}</Button>
              <Tooltip :text="t('providers.refreshTitle', { type: p.type })">
                <Button variant="secondary" size="sm" @click="emit('refresh', p.id)">{{ t('providers.refresh') }}</Button>
              </Tooltip>
              <Tooltip :text="t('providers.deleteTitle', { type: p.type })">
                <Button variant="danger-soft" size="sm" @click="onDeleteProvider(p.id)">{{ t('providers.delete') }}</Button>
              </Tooltip>
            </div>
          </div>
        </template>
      </div>

      <!-- Add / Edit provider form -->
      <div v-if="!unavailable" class="add-section">
        <template v-if="!showAddForm && !showEditForm">
          <div class="add-btns">
            <!-- OAuth login shortcuts for common platforms -->
            <Button variant="secondary" size="sm" @click="emit('openLogin', 'moonshot')">
              <Icon name="user" size="sm" />
              {{ t('providers.loginKimi') }}
            </Button>
            <Button variant="secondary" size="sm" @click="emit('openLogin', 'anthropic')">
              <Icon name="user" size="sm" />
              {{ t('providers.loginAnthropic') }}
            </Button>
            <Button variant="primary" size="sm" @click="openAdd">
              <Icon name="plus" size="sm" />
              {{ t('providers.enterApiKey') }}
            </Button>
          </div>
        </template>
        <template v-else>
          <div class="add-form">
            <Field :label="t('providers.fieldId')">
              <Input
                v-if="showAddForm"
                v-model="form.id"
                :placeholder="t('providers.idPlaceholder')"
                autocomplete="off"
                spellcheck="false"
              />
              <span v-else class="edit-id">{{ form.id }}</span>
            </Field>
            <Field :label="t('providers.fieldType')">
              <Select :model-value="form.type" @update:model-value="onTypeChange">
                <option v-for="pt in PROVIDER_WIRE_TYPES" :key="pt" :value="pt">
                  {{ t(PROVIDER_TYPE_LABEL_KEYS[pt]) }}
                </option>
              </Select>
            </Field>
            <Field :label="t('providers.fieldApiKey')" :hint="showEditForm ? t('providers.keyKeepHint') : undefined">
              <Input
                v-model="form.apiKey"
                type="password"
                :placeholder="showEditForm ? t('providers.keyKeepPlaceholder') : 'sk-…'"
                autocomplete="off"
                spellcheck="false"
              />
            </Field>
            <Field :label="t('providers.fieldBaseUrl')">
              <Input
                v-model="form.baseUrl"
                :placeholder="t('providers.baseUrlPlaceholder')"
                autocomplete="off"
                spellcheck="false"
              />
            </Field>

            <!-- Model rows — the server requires >= 1 model on create and on replace. -->
            <div class="models-section">
              <span class="models-label">{{ t('providers.fieldModels') }}</span>
              <div v-for="(row, idx) in form.models" :key="idx" class="model-row">
                <Input
                  v-model="row.model"
                  :placeholder="t('providers.modelPlaceholder')"
                  autocomplete="off"
                  spellcheck="false"
                />
                <Input
                  :model-value="row.maxContextSize"
                  type="number"
                  min="1"
                  class="model-ctx"
                  :aria-label="t('providers.contextLabel')"
                  @update:model-value="row.maxContextSize = Number($event)"
                />
                <IconButton
                  size="sm"
                  :label="t('providers.removeModel')"
                  :disabled="form.models.length <= 1"
                  @click="removeModelRow(idx)"
                >
                  <Icon name="close" size="sm" />
                </IconButton>
              </div>
              <Button variant="ghost" size="sm" class="add-model-btn" @click="addModelRow">
                <Icon name="plus" size="sm" />
                {{ t('providers.addModel') }}
              </Button>
            </div>

            <Field :label="t('providers.fieldDefaultModel')">
              <Select v-model="form.defaultModel">
                <option value="">{{ t('providers.defaultModelNone') }}</option>
                <option v-for="row in nonEmptyModelRows" :key="row.model" :value="row.model">
                  {{ row.model }}
                </option>
              </Select>
            </Field>

            <div v-if="formError" class="add-error" role="alert">{{ t(formError) }}</div>
            <div v-if="editLoading" class="state-row">
              <Spinner size="sm" />
              <span>{{ t('providers.loading') }}</span>
            </div>
            <div class="form-btns">
              <Button variant="primary" size="sm" :disabled="editLoading" @click="submitForm">
                {{ showEditForm ? t('providers.save') : t('providers.add') }}
              </Button>
              <Button variant="secondary" size="sm" @click="cancelForm">{{ t('common.cancel') }}</Button>
            </div>
          </div>
        </template>
      </div>

      <!-- Footer -->
      <div class="footer-hint">{{ t('providers.escClose') }}</div>
    </div>
  </Dialog>
</template>

<style scoped>
.pm { display: flex; flex-direction: column; gap: var(--space-4); }

/* Provider list */
.prov-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.state-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-4) 0;
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-base);
}
.state-row.unavail { color: var(--color-warning); }

/* Empty state + beginner guidance */
.empty-guide {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-4) var(--space-3);
  border: 1px dashed var(--color-line-strong);
  border-radius: var(--radius-lg);
}
.empty-title {
  font-family: var(--font-ui);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  color: var(--color-text);
}
.empty-text {
  margin: 0;
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--color-text-muted);
}

.prov-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--color-line);
  transition: background var(--duration-fast) var(--ease-out);
}
.prov-row:last-child { border-bottom: none; }

.status-dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
  box-sizing: border-box;
}
.status-dot--empty {
  background: transparent;
  border: 1.5px solid var(--color-text-faint);
}
.prov-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.prov-type {
  font-family: var(--font-ui);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  color: var(--color-text);
}
.prov-url {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.prov-meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}

.prov-actions {
  display: flex;
  gap: var(--space-2);
  flex: none;
  align-items: center;
  flex-wrap: wrap;
}
/* Add section */
.add-section {
  border-top: 1px solid var(--color-line);
  padding-top: var(--space-4);
}
.add-btns {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

/* Form */
.add-form { display: flex; flex-direction: column; gap: var(--space-3); }
.edit-id {
  font-family: var(--font-mono);
  font-size: var(--text-base);
  color: var(--color-text);
  padding: 0 var(--space-3);
  height: 38px;
  display: flex;
  align-items: center;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
}
.models-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.models-label {
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--color-text-muted);
}
.model-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.model-row .ui-input { flex: 1; min-width: 0; }
.model-ctx { flex: none; width: 150px; }
.add-model-btn { align-self: flex-start; }
.add-error {
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  color: var(--color-danger);
}
.form-btns {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

/* Footer */
.footer-hint {
  padding-top: var(--space-2);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  border-top: 1px solid var(--color-line);
}

@media (max-width: 640px) {
  .prov-row {
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .prov-actions {
    flex: 1 1 100%;
    justify-content: flex-end;
  }
  .model-row { flex-wrap: wrap; }
  .model-row .ui-input { flex: 1 1 100%; }
}
</style>
