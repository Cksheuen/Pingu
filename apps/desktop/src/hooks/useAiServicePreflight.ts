import { useCallback, useEffect, useState } from "react";
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
): AiServicePreflightModel {
  const [report, setReport] = useState<AiServicePreflight | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    if (!connected) return;
    setChecking(true);
    try {
      setReport(await getAiServicePreflight());
      setError(null);
    } catch (cause) {
      setError(typeof cause === "string" ? cause : "Unable to verify AI service readiness");
    } finally {
      setChecking(false);
    }
  }, [connected]);

  useEffect(() => {
    if (!connected) {
      setReport(null);
      setError(null);
      return;
    }

    // A preflight is intentionally event-driven: connect or rule-group change
    // triggers it once, and the user can recheck before starting a CLI session.
    // Continuous egress polling would add avoidable traffic and UI work.
    void check();
  }, [activeGroupId, check, connected]);

  return { report, checking, error, check };
}
