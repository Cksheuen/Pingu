import type { HostOverride, HostOverrideDraft } from "./types.js";
import { tauriInvoke } from "./tauri-invoke.js";

interface HostOverrideRecord {
  id: string;
  host: string;
  resolver_mode: HostOverride["resolver"];
  outbound_mode: HostOverride["outbound"];
  enabled: boolean;
  source: HostOverride["source"];
  reason: string;
  updated_at: string;
}

function mapHostOverride(record: HostOverrideRecord): HostOverride {
  return {
    id: record.id,
    host: record.host,
    resolver: record.resolver_mode,
    outbound: record.outbound_mode,
    enabled: record.enabled,
    source: record.source,
    reason: record.reason,
    last_verified_at: record.updated_at,
    last_verified_result: null,
  };
}

export async function listHostOverrides(): Promise<HostOverride[]> {
  try {
    const records = await tauriInvoke<HostOverrideRecord[]>("list_host_overrides");
    return records.map(mapHostOverride);
  } catch (e) {
    console.warn("listHostOverrides failed:", e);
    return [];
  }
}

export async function createHostOverride(
  override: HostOverrideDraft
): Promise<HostOverride> {
  const record = await tauriInvoke<HostOverrideRecord>("create_host_override", {
    input: {
      host: override.host,
      resolver_mode: override.resolver,
      outbound_mode: override.outbound,
      enabled: override.enabled,
      reason: override.reason,
    },
  });
  return mapHostOverride(record);
}

export async function updateHostOverride(
  id: string,
  patch: HostOverrideDraft
): Promise<HostOverride> {
  const record = await tauriInvoke<HostOverrideRecord>("update_host_override", {
    input: {
      id,
      host: patch.host,
      resolver_mode: patch.resolver,
      outbound_mode: patch.outbound,
      enabled: patch.enabled,
      reason: patch.reason,
    },
  });
  return mapHostOverride(record);
}

export async function deleteHostOverride(id: string): Promise<void> {
  return await tauriInvoke("delete_host_override", { id });
}

export async function toggleHostOverride(id: string): Promise<HostOverride> {
  const record = await tauriInvoke<HostOverrideRecord>("toggle_host_override", {
    id,
  });
  return mapHostOverride(record);
}

export async function resetHostOverrides(): Promise<void> {
  return await tauriInvoke("reset_host_overrides");
}
