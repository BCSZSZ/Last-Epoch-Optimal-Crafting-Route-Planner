import { expect, it } from 'vitest';
import { Catalog } from '../core/catalog';
import { affixName, affixSearchText } from './labels';

it('uses the matching Chinese affix IDs for the screenshot entries', () => {
  const catalog = new Catalog();
  expect(affixName(catalog, 391)).toBe('点燃几率于火焰技能击中时');
  expect(affixName(catalog, 392)).toBe('闪电技能击中时施加感电几率');
  expect(affixName(catalog, 393)).toBe('暴击时施放火焰光环几率（每秒至多3次）');
});

it('searches Chinese, original English and numeric IDs using the same mapping', () => {
  const catalog = new Catalog(), text = affixSearchText(catalog, 393);
  expect(text).toContain('火焰光环');
  expect(text).toContain('fire aura');
  expect(text).toContain('393');
  expect(affixSearchText(catalog, 393)).toBe(text);
});

it('covers all audited IDs and keeps input aliases and unknown-ID handling', () => {
  const catalog = new Catalog();
  for (const row of catalog.model.affixes) expect(affixName(catalog, row.id)).toMatch(/\p{Script=Han}/u);
  expect(affixName(catalog, 391, {391: '待补目标前缀1'})).toBe('待补目标前缀1');
  expect(affixName(catalog, 999999)).toBe('未知ID 999999');
});
