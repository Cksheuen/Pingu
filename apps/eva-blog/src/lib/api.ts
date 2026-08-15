// 公开 API 读取：统一 credentials 与错误形状。
export async function requestJson<T = unknown>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "include" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((payload as { error?: string }).error || `Public API returned ${response.status}.`);
  return payload as T;
}
