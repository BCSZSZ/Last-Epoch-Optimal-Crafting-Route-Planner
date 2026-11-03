/** xoshiro128** 1.1: https://prng.di.unimi.it/xoshiro128starstar.c (public domain).
 * Deterministic research sampling, not the game's RNG and not cryptographic.
 */
export type Draw = () => number;

const rotate = (value: number, shift: number) => (value << shift) | (value >>> (32 - shift));

export function seededRandom(seed: string): Draw {
  const hashes = new Uint32Array([0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35]);
  const multipliers = [0x01000193, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2d];
  for (let i = 0; i < seed.length; i++) for (let lane = 0; lane < 4; lane++) {
    hashes[lane] = Math.imul(hashes[lane] ^ seed.charCodeAt(i), multipliers[lane]);
  }
  const state = new Uint32Array(4);
  for (let i = 0; i < 4; i++) {
    let mixed = (hashes[i] + 0x9e3779b9 * (i + 1)) | 0;
    mixed = Math.imul(mixed ^ (mixed >>> 16), 0x21f0aaad);
    mixed = Math.imul(mixed ^ (mixed >>> 15), 0x735a2d97);
    state[i] = (mixed ^ (mixed >>> 15)) >>> 0;
  }
  if (state.every((word) => word === 0)) state[0] = 1;
  return () => {
    const result = Math.imul(rotate(Math.imul(state[1], 5), 7), 9) >>> 0;
    const temporary = state[1] << 9;
    state[2] ^= state[0]; state[3] ^= state[1]; state[1] ^= state[2]; state[0] ^= state[3];
    state[2] ^= temporary;
    state[3] = rotate(state[3], 11);
    return result / 0x100000000;
  };
}

export function pickWeighted<T>(values: readonly T[], weight: (value: T) => number, draw: Draw): T {
  let total = 0;
  for (const value of values) {
    const probability = weight(value);
    if (!Number.isFinite(probability) || probability < 0) throw new Error('抽样权重无效');
    total += probability;
  }
  if (!(total > 0)) throw new Error('抽样候选池为空');
  const random = draw();
  if (!(random >= 0 && random < 1)) throw new Error('随机源必须返回[0,1)');
  let threshold = random * total;
  let last = values[0];
  for (const value of values) {
    const probability = weight(value);
    if (probability <= 0) continue;
    last = value;
    threshold -= probability;
    if (threshold < 0) return value;
  }
  return last;
}
