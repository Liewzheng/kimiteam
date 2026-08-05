/**
 * `contextMemory` vacuous-content predicate — shared test for content parts
 * that carry nothing the provider wire can represent. Vacuous means an empty
 * or whitespace-only text block, or a bare (unsigned) thinking block: bare
 * `think` is internal reasoning — never representable on the provider wire on
 * its own — so it is vacuous whether or not it is empty. A signed thinking
 * block (`encrypted`) is never vacuous — reasoning providers require it back
 * verbatim — and media parts always carry content.
 */

import type { ContentPart } from '#/kosong/contract/message';

export function isVacuousContentPart(part: ContentPart): boolean {
  if (part.type === 'text') return part.text.trim().length === 0;
  if (part.type === 'think') return part.encrypted === undefined;
  return false;
}

/**
 * Narrower predicate for streamed-part preservation (e.g. interrupted-turn
 * content drain): only parts that carry literally nothing — empty text, or an
 * empty bare think — are dropped. A non-empty bare think is still kept here so
 * an interrupted turn preserves what it had streamed; whether a settled frame
 * made of bare think alone is SENDABLE is `isVacuousContentPart`'s call.
 */
export function isEmptyContentPart(part: ContentPart): boolean {
  if (part.type === 'text') return part.text.trim().length === 0;
  if (part.type === 'think') return part.encrypted === undefined && part.think.trim().length === 0;
  return false;
}
