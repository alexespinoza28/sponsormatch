export function score(n: number | undefined, digits = 2): string {
  return n === undefined ? "n/a" : n.toFixed(digits);
}

export function signed(n: number, digits = 2): string {
  return `${n > 0 ? "+" : ""}${n.toFixed(digits)}`;
}

export function pct(before: number, after: number): string {
  if (before === 0) return "n/a";
  const p = Math.round(((after - before) / Math.abs(before)) * 100);
  return `${p > 0 ? "+" : ""}${p}%`;
}

export function usd(n: number): string {
  return `$${n.toLocaleString("en-US")}`;
}
