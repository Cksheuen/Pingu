import { useCallback, useEffect, useState } from "react";
import { getEgressIp } from "../lib/proxy-api";

export function useEgressStatus(connected: boolean) {
  const [ip, setIp] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    if (!connected) return;
    setChecking(true);
    try {
      setIp(await getEgressIp());
      setError(null);
    } catch (cause) {
      setError(typeof cause === "string" ? cause : "Unable to verify proxy egress");
    } finally {
      setChecking(false);
    }
  }, [connected]);

  useEffect(() => {
    if (!connected) {
      setIp(null);
      setError(null);
      return;
    }

    void check();
    const timer = setInterval(() => void check(), 30_000);
    return () => clearInterval(timer);
  }, [check, connected]);

  return { ip, checking, error, check };
}
