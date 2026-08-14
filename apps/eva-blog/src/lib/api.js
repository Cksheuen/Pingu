export async function requestJson(path) {
  const response = await fetch(path, { credentials: "include" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Public API returned ${response.status}.`);
  return payload;
}
