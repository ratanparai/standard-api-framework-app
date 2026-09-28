export type GenericPayloadSyncResult = { text: string; isObject: boolean };

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function synchronizeGenericProcessIdentificationNo(text: string, processId: string): GenericPayloadSyncResult {
  const payload = parseObject(text.replace(/^\uFEFF/, ""));
  if (!payload) return { text, isObject: false };
  return {
    text: JSON.stringify({ ...payload, processIdentificationNo: processId }, null, 2),
    isObject: true,
  };
}

export function isGenericPayloadObject(text: string): boolean {
  return parseObject(text.replace(/^\uFEFF/, "")) !== null;
}
