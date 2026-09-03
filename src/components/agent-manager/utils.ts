export function pickRandomSpritePair(pool: number[]): [number, number] {
  if (pool.length === 0) return [1, 2];
  const first = pool[Math.floor(Math.random() * pool.length)] ?? 1;
  if (pool.length === 1) return [first, first];
  let second = first;
  while (second === first) {
    second = pool[Math.floor(Math.random() * pool.length)] ?? first;
  }
  return [first, second];
}
