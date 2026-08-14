import { useCallback, useEffect, useState } from "react";
import {
  configureGate,
  getGateSettings,
  renewGateLease,
  setGateEnabled,
} from "../lib/settings-api";
import type { GateSettings } from "../lib/types";

function errorMessage(cause: unknown): string {
  return typeof cause === "string" ? cause : "Gate operation failed";
}

export function useGateSettings() {
  const [settings, setSettings] = useState<GateSettings | null>(null);
  const [accessLink, setAccessLink] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const next = await getGateSettings();
    setSettings(next);
    return next;
  }, []);

  useEffect(() => {
    refresh()
      .catch((cause) => setError(errorMessage(cause)))
      .finally(() => setLoading(false));
  }, [refresh]);

  const saveAndAuthorize = async () => {
    if (!accessLink.trim()) {
      setError("Paste a Gate access link first");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const next = await configureGate(accessLink.trim());
      setSettings(next);
      setAccessLink("");
    } catch (cause) {
      setError(errorMessage(cause));
      await refresh().catch(() => undefined);
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async () => {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      setSettings(await setGateEnabled(!settings.enabled));
    } catch (cause) {
      setError(errorMessage(cause));
      await refresh().catch(() => undefined);
    } finally {
      setSaving(false);
    }
  };

  const renewNow = async () => {
    setSaving(true);
    setError(null);
    try {
      await renewGateLease();
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
      await refresh().catch(() => undefined);
    } finally {
      setSaving(false);
    }
  };

  return {
    settings,
    accessLink,
    loading,
    saving,
    error,
    setAccessLink,
    saveAndAuthorize,
    toggleEnabled,
    renewNow,
  };
}
