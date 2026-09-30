import { useCallback, useEffect, useRef, useState } from "react";
import { getAiServicePreflight } from "../lib/proxy-api";
import type { AiServicePreflight } from "../lib/types";

export interface AiServicePreflightModel {
  report: AiServicePreflight | null;
  checking: boolean;
  error: string | null;
  check: () => Promise<void>;
}

export function useAiServicePreflight(
  connected: boolean,
  activeGroupId: string | null,
  routeKey = "",
): AiServicePreflightModel {
  const [report, setReport] = useState<AiServicePreflight | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generation = useRef(0);
  const check = useCallback(async () => {
    if (!connected) return;
    const request = ++generation.current;
    setChecking(true);
    setReport(null);
    try {
      const next = await getAiServicePreflight();
      if (request !== generation.current) return;
      setReport(next);
      setError(null);
    } catch (cause) {
      if (request !== generation.current) return;
      setError(typeof cause === "string" ? cause : "Unable to verify AI service readiness");
    } finally {
      if (request === generation.current) setChecking(false);
    }
  }, [connected]);

  useEffect(() => {
    if (!connected) {
      generation.current++;
      setChecking(false);
      setReport(null);
      setError(null);
      return;
    }

    // A preflight is intentionally event-driven: connect, route or rule-group change
    // triggers it once, and the user can recheck before starting a CLI session.
    // Continuous egress polling would add avoidable traffic and UI work.
    void check();
    return () => { generation.current++; };
  }, [activeGroupId, routeKey, check, connected]);

  return { report, checking, error, check };
}
