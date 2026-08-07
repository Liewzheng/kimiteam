/**
 * `workspaceAgentProfileLoader` domain — agent-file parsing primitives.
 *
 * Parses a single agent Markdown file (frontmatter + body) into an
 * `AgentFileDefinition`. Pure functions with no IO: callers read bytes however
 * they like and pass the decoded text in. Unknown frontmatter fields are
 * ignored so later format extensions stay forward-compatible. Compatibility conventions match other agent CLIs: a
 * missing `name` falls back to the file name (OpenCode), a lone `*` in
 * `tools` / `subagents` means unrestricted like an omitted field, and list
 * fields accept either a bare comma-separated string or the YAML list form
 * (Claude Code).
 */

import { CoreErrors } from '#/_base/errors/codes';
import { Error2 } from '#/_base/errors/errors';
import { FrontmatterError, parseFrontmatter } from '#/_base/text/frontmatter';

import type { AgentFileDefinition, AgentFileSource } from './types';

export class AgentFileParseError extends Error2 {
  readonly reason?: unknown;

  constructor(message: string, cause?: unknown) {
    super(CoreErrors.codes.VALIDATION_FAILED, message, {
      cause,
      name: 'AgentFileParseError',
    });
    if (cause !== undefined) this.reason = cause;
  }
}

export interface ParseAgentFileOptions {
  readonly path: string;
  readonly source: AgentFileSource;
  readonly text: string;
  /**
   * Optional reporter for non-fatal diagnostics (currently: unknown frontmatter
   * fields that are silently ignored). Kept optional so pure-parse callers
   * (e.g. CLI name probing) stay warn-free.
   */
  readonly warn?: (message: string) => void;
}

const AGENT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Frontmatter keys this format understands; anything else is ignored. */
const KNOWN_FRONTMATTER_FIELDS: ReadonlySet<string> = new Set([
  'name',
  'description',
  'whenToUse',
  'override',
  'tools',
  'disallowedTools',
  'subagents',
  'skills',
  'model_preference',
  'role',
  'duty',
  'display_name',
  'think_mode',
  'temperature',
]);

/** Common misspellings → the canonical key, so the warn can point at the fix. */
const FRONTMATTER_FIELD_HINTS: Readonly<Record<string, string>> = {
  when_to_use: 'whenToUse',
  'when-to-use': 'whenToUse',
  disallowed_tools: 'disallowedTools',
};

export function parseAgentFileText(options: ParseAgentFileOptions): AgentFileDefinition {
  let parsed;
  try {
    parsed = parseFrontmatter(options.text);
  } catch (error) {
    if (error instanceof FrontmatterError) {
      throw new AgentFileParseError(
        `Invalid frontmatter in ${options.path}: ${error.message}`,
        error,
      );
    }
    throw error;
  }

  const frontmatter = parsed.data;
  if (frontmatter === null) {
    throw new AgentFileParseError(`Missing frontmatter in ${options.path}`);
  }
  if (!isRecord(frontmatter)) {
    throw new AgentFileParseError(
      `Frontmatter in ${options.path} must be a mapping at the top level`,
    );
  }

  const nameField = frontmatter['name'];
  if (nameField !== undefined && nameField !== null && typeof nameField !== 'string') {
    throw new AgentFileParseError(
      `Frontmatter field "name" in ${options.path} must be a non-empty string`,
    );
  }
  const name = nonEmptyString(nameField) ?? deriveNameFromPath(options.path);
  if (name === undefined) {
    throw new AgentFileParseError(`Missing required frontmatter field "name" in ${options.path}`);
  }
  if (!AGENT_NAME_PATTERN.test(name)) {
    throw new AgentFileParseError(
      `Invalid agent name "${name}" in ${options.path}: expected kebab-case (e.g. "code-reviewer")`,
    );
  }

  const description = requiredNonEmptyString(
    frontmatter['description'],
    'description',
    options.path,
  );

  const override = parseBoolean(frontmatter['override'], 'override', options.path);
  const rawTools = parseStringList(frontmatter['tools'], 'tools', options.path);
  const tools = rawTools?.length === 1 && rawTools[0] === '*' ? undefined : rawTools;
  const disallowedTools = parseStringList(
    frontmatter['disallowedTools'],
    'disallowedTools',
    options.path,
  );
  const rawSubagents = parseStringList(frontmatter['subagents'], 'subagents', options.path);
  const subagents =
    rawSubagents?.length === 1 && rawSubagents[0] === '*' ? undefined : rawSubagents;
  const rawSkills = parseStringList(frontmatter['skills'], 'skills', options.path);
  const skills =
    rawSkills?.length === 1 && rawSkills[0] === '*' ? undefined : rawSkills;
  const modelPreference = parseModelPreference(frontmatter['model_preference'], options.path);
  const role = nonEmptyString(frontmatter['role']);
  const duty = parseBoolean(frontmatter['duty'], 'duty', options.path);
  const displayName = nonEmptyString(frontmatter['display_name']);
  const thinkMode = nonEmptyString(frontmatter['think_mode']);
  const temperature = parseNumber(frontmatter['temperature'], 'temperature', options.path);

  const prompt = parsed.body.trim();
  if (prompt.length === 0) {
    throw new AgentFileParseError(`Missing prompt body in ${options.path}`);
  }

  // Surface unknown frontmatter fields: the file still parses (fields are
  // ignored), but a misspelled canonical key silently no-ops today. One warn
  // per file listing every unknown key, with rename hints for the frequent
  // `when_to_use` / `when-to-use` / `disallowed_tools` mistakes.
  const unknownKeys = Object.keys(frontmatter).filter(
    (key) => !KNOWN_FRONTMATTER_FIELDS.has(key),
  );
  if (unknownKeys.length > 0) {
    const hints = unknownKeys
      .filter((key) => FRONTMATTER_FIELD_HINTS[key] !== undefined)
      .map((key) => `"${key}" → use "${FRONTMATTER_FIELD_HINTS[key]}"`);
    const hintText = hints.length > 0 ? ` (${hints.join('; ')})` : '';
    options.warn?.(
      `${options.path}: ignoring unknown frontmatter field(s): ${unknownKeys.join(', ')}${hintText}`,
    );
  }

  return {
    name,
    description,
    whenToUse: nonEmptyString(frontmatter['whenToUse']),
    override,
    tools,
    disallowedTools,
    subagents,
    skills,
    modelPreference,
    role,
    duty,
    displayName,
    thinkMode,
    temperature,
    prompt,
    path: options.path,
    source: options.source,
  };
}

function parseNumber(
  value: unknown,
  field: string,
  filePath: string,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new AgentFileParseError(
    `Frontmatter field "${field}" in ${filePath} must be a finite number`,
  );
}

function parseModelPreference(
  value: unknown,
  filePath: string,
): AgentFileDefinition['modelPreference'] {
  if (value === undefined || value === null) return undefined;
  // Accepts the symbolic "primary"/"secondary" shortcuts or any explicit
  // `[models.<id>]` id; the id's validity is checked against the model
  // catalog when a subagent is spawned, not at parse time.
  if (typeof value === 'string' && value.trim().length > 0) return value;
  throw new AgentFileParseError(
    `Frontmatter field "model_preference" in ${filePath} must be "primary", "secondary", or a [models] id from config.toml`,
  );
}

function parseBoolean(value: unknown, field: string, filePath: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  throw new AgentFileParseError(
    `Frontmatter field "${field}" in ${filePath} must be a boolean`,
  );
}

function parseStringList(
  value: unknown,
  field: string,
  filePath: string,
): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '');
  }
  if (!Array.isArray(value)) {
    throw new AgentFileParseError(
      `Frontmatter field "${field}" in ${filePath} must be a comma-separated string or a list of strings`,
    );
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new AgentFileParseError(
        `Frontmatter field "${field}" in ${filePath} must be a list of non-empty strings`,
      );
    }
    out.push(item.trim());
  }
  return out;
}

function requiredNonEmptyString(value: unknown, field: string, filePath: string): string {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new AgentFileParseError(
      `Frontmatter field "${field}" in ${filePath} must be a non-empty string`,
    );
  }
  const parsed = nonEmptyString(value);
  if (parsed === undefined) {
    throw new AgentFileParseError(`Missing required frontmatter field "${field}" in ${filePath}`);
  }
  return parsed;
}

function deriveNameFromPath(filePath: string): string | undefined {
  const base = filePath.split(/[\\/]/).pop() ?? '';
  const name = base.replace(/\.[^.]*$/, '');
  return name !== '' ? name : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
