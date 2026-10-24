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
  routeKey: string | null,
): AiServicePreflightModel {
  const [report, setReport] = useState<AiServicePreflight | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generation = useRef(0);
  const check = useCallback(async () => {
    if (!connected) return;
    const request = ++generation.current;
    setChecking(true);
    setError(null);
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

  const checkedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!connected) {
      checkedKey.current = null;
      generation.current++;
      setChecking(false);
      setReport(null);
      setError(null);
      return;
    }
    // A preflight is intentionally event-driven: each settled route or rule
    // group is checked once (every check repeats three probes through the
    // proxy), and the user can recheck before starting a CLI session.
    if (routeKey === null) return;
    const key = JSON.stringify([activeGroupId, routeKey]);
    if (checkedKey.current === key) return;
    checkedKey.current = key;
    void check();
  }, [activeGroupId, routeKey, check, connected]);
  useEffect(() => () => {
    generation.current++;
    checkedKey.current = null;
  }, []);

  return { report, checking, error, check };
}
