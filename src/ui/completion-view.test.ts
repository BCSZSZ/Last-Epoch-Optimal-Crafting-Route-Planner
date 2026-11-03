import { expect, it } from 'vitest';
import { completionPercent } from './completion-view';

it('keeps strict recommendation thresholds clear when two-decimal rounding would conceal the difference', () => {
  expect(completionPercent({lower:.65004034,upper:.65004035})).toBe('>65%');
  expect(completionPercent({lower:.24999,upper:.249991})).toBe('<25%');
  expect(completionPercent({lower:.65,upper:.65})).toBe('65.00%');
  expect(completionPercent({lower:.25,upper:.25})).toBe('25.00%');
  expect(completionPercent({lower:.68343477,upper:.68343479})).toBe('68.34%');
});
