/**
 * `skillCatalog` domain (L3) — builtin `team-onboarding` skill definition.
 */

import type { SkillDefinition } from '#/app/skillCatalog/types';
import { parseSkillText } from '#/app/skillCatalog/parser';
import TEAM_ONBOARDING_BODY from './team-onboarding.md?raw';

const PSEUDO_PATH = 'builtin://team-onboarding';

const parsed = parseSkillText({
  skillMdPath: '/builtin/skills/team-onboarding.md',
  skillDirName: 'team-onboarding',
  source: 'builtin',
  text: TEAM_ONBOARDING_BODY,
});

export const TEAM_ONBOARDING_SKILL: SkillDefinition = {
  ...parsed,
  path: PSEUDO_PATH,
  dir: PSEUDO_PATH,
  metadata: {
    ...parsed.metadata,
    type: parsed.metadata.type ?? 'inline',
  },
};
