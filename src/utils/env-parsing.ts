export function parseStrictPositiveInteger(
  value: string | undefined,
  maxValue = Number.MAX_SAFE_INTEGER
): number | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maxValue) return undefined;
  return parsed;
}

export function parsePositiveInteger(
  value: string | undefined,
  defaultValue: number,
  maxValue = Number.MAX_SAFE_INTEGER
): number {
  return parseStrictPositiveInteger(value, maxValue) ?? defaultValue;
}
