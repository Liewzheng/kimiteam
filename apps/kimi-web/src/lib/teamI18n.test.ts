// apps/kimi-web/src/lib/teamI18n.test.ts
// Guard for the team locale namespaces (member-detail labels + the polish /
// model-dropdown keys added for the detail-panel edit form). The two locales
// are kept in sync manually, so this asserts the specific keys we introduced
// exist in BOTH and that the 职位 rename landed.
import { describe, expect, it } from 'vitest';
import en from '../i18n/locales/en/team';
import zh from '../i18n/locales/zh/team';

describe('team i18n — member detail labels', () => {
  it('zh memberTitleLabel reads 职位 (Title maps to the role/职位 field)', () => {
    expect(zh.memberTitleLabel).toBe('职位');
    expect(en.memberTitleLabel).toBe('Title');
  });

  it('polish + model-dropdown keys exist in both locales (en/zh parity)', () => {
    const keys = [
      'memberRecentModels',
      'memberNoModels',
      'memberOtherModels',
      'polish',
      'polishTitle',
      'polishLoading',
      'polishOriginal',
      'polishPolished',
      'polishConfirm',
    ] as const;
    for (const key of keys) {
      expect(en[key], `en.${key}`).toBeTruthy();
      expect(zh[key], `zh.${key}`).toBeTruthy();
    }
  });
});
