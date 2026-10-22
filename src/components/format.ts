export const AGE_LABELS: Record<string, string> = {
  "24_and_younger": "24 and under",
  "25_to_29": "25-29",
  "30_to_34": "30-34",
  "35_to_44": "35-44",
  "45_to_54": "45-54",
  "55_and_older": "55+",
};

export function score(n: number | undefined, digits = 2): string {
  return n === undefined ? "n/a" : n.toFixed(digits);
}

export function signed(n: number): string {
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}`;
}

export function formatDate(date?: string): string | undefined {
  if (!date) return undefined;
  const d = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(d.getTime())
    ? undefined
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
