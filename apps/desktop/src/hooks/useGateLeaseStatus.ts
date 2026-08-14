import { useCallback, useEffect, useState } from "react";
import { getGateSettings, renewGateLease } from "../lib/settings-api";
import type { GateSettings } from "../lib/types";

function messageFrom(cause: unknown): string {
  return typeof cause === "string" ? cause : "Unable to refresh network lease";
}

export function useGateLeaseStatus(connectionMarker: boolean) {
  const [settings, setSettings] = useState<GateSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [renewing, setRenewing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSettings(await getGateSettings());
      setError(null);
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(interval);
  }, [connectionMarker, refresh]);

  const renew = async () => {
    setRenewing(true);
    setError(null);
    try {
      await renewGateLease();
      await refresh();
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setRenewing(false);
    }
  };

  return { settings, loading, renewing, error, renew };
}
