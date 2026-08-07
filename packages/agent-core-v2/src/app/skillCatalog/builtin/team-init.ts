/**
 * `skillCatalog` domain (L3) — builtin `team-init` skill definition.
 *
 * The team building / adjustment onboarding flow, reached via `/team init` on
 * both the TUI and web — the single entry point. The skill was folded into this
 * name so no legacy bare skill item surfaces in the web command menu.
 */

import type { SkillDefinition } from '#/app/skillCatalog/types';
import { parseSkillText } from '#/app/skillCatalog/parser';
import TEAM_INIT_BODY from './team-init.md?raw';

const PSEUDO_PATH = 'builtin://team-init';

const parsed = parseSkillText({
  skillMdPath: '/builtin/skills/team-init.md',
  skillDirName: 'team-init',
  source: 'builtin',
  text: TEAM_INIT_BODY,
});

export const TEAM_INIT_SKILL: SkillDefinition = {
  ...parsed,
  path: PSEUDO_PATH,
  dir: PSEUDO_PATH,
  metadata: {
    ...parsed.metadata,
    type: parsed.metadata.type ?? 'inline',
  },
};
