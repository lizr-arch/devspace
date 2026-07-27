export function attachRegisteredToolName(
  toolName: string,
  result: unknown,
): unknown {
  if (!result || typeof result !== "object") return result;

  const record = result as Record<string, unknown>;
  const existingMeta =
    record._meta && typeof record._meta === "object"
      ? (record._meta as Record<string, unknown>)
      : {};

  return {
    ...record,
    _meta: {
      ...existingMeta,
      tool: toolName,
    },
  };
}
