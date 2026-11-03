const buffer = new ArrayBuffer(8);
const floating = new Float64Array(buffer);
const bits = new BigUint64Array(buffer);

/** Adjacent IEEE754 values, used only to enclose arithmetic, not emulate game RNG. */
export function nextUp(value: number): number {
  if (Number.isNaN(value) || value === Infinity) return value;
  if (value === 0) return Number.MIN_VALUE;
  floating[0] = value;
  bits[0] += value > 0 ? 1n : -1n;
  return floating[0];
}

export function nextDown(value: number): number {
  return -nextUp(-value);
}

/** Outward-rounded enclosure under the declared binary64 parameter model. */
export class Interval {
  constructor(readonly lower: number, readonly upper = lower) {
    if (Number.isNaN(lower) || Number.isNaN(upper) || lower > upper) throw new Error('无效数值区间');
  }
  get midpoint(): number { return (this.lower + this.upper) / 2; }
  get width(): number { return this.upper - this.lower; }
  add(other: Interval): Interval {
    if (other.lower === 0 && other.upper === 0) return this;
    if (this.lower === 0 && this.upper === 0) return other;
    return new Interval(nextDown(this.lower + other.lower), nextUp(this.upper + other.upper));
  }
  sub(other: Interval): Interval {
    return this.add(new Interval(-other.upper, -other.lower));
  }
  mul(other: Interval): Interval {
    if ((this.lower === 0 && this.upper === 0) || (other.lower === 0 && other.upper === 0)) return ZERO;
    if (this.lower === 1 && this.upper === 1) return other;
    if (other.lower === 1 && other.upper === 1) return this;
    const products = [this.lower * other.lower, this.lower * other.upper, this.upper * other.lower, this.upper * other.upper];
    return new Interval(nextDown(Math.min(...products)), nextUp(Math.max(...products)));
  }
  div(other: Interval): Interval {
    if (other.lower <= 0 && other.upper >= 0) throw new Error('区间除数包含零');
    if (this.lower === 0 && this.upper === 0) return ZERO;
    const quotients = [this.lower / other.lower, this.lower / other.upper, this.upper / other.lower, this.upper / other.upper];
    return new Interval(nextDown(Math.min(...quotients)), nextUp(Math.max(...quotients)));
  }
  complement(): Interval {
    if (this.lower === 1 && this.upper === 1) return ZERO;
    if (this.lower === 0 && this.upper === 0) return ONE;
    return new Interval(nextDown(1 - this.upper), nextUp(1 - this.lower));
  }
  clamp(lower: number, upper: number): Interval {
    return new Interval(Math.max(lower, this.lower), Math.min(upper, this.upper));
  }
  report(): { lower: number; upper: number } { return { lower: this.lower, upper: this.upper }; }
}

export const ZERO = new Interval(0);
export const ONE = new Interval(1);
export const exact = (value: number): Interval => new Interval(value);
export const ratio = (numerator: number, denominator: number): Interval => {
  if (denominator === 0) throw new Error('除数为零');
  if (numerator === 0) return ZERO;
  if (numerator === denominator) return ONE;
  return exact(numerator).div(exact(denominator));
};
