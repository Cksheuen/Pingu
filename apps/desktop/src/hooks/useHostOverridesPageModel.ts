import { useCallback, useEffect, useState } from "react";
import {
  createHostOverride,
  deleteHostOverride,
  listHostOverrides,
  resetHostOverrides,
  toggleHostOverride,
  updateHostOverride,
} from "../lib/host-overrides-api.js";
import type { HostOverride, HostOverrideDraft } from "../lib/types.js";

interface HostOverridesPageModel {
  overrides: HostOverride[];
  loading: boolean;
  saving: boolean;
  error: string;
  resetSupported: boolean;
  refresh: () => Promise<void>;
  createOverride: (draft: HostOverrideDraft) => Promise<void>;
  updateOverrideById: (id: string, draft: HostOverrideDraft) => Promise<void>;
  deleteOverrideById: (id: string) => Promise<void>;
  toggleOverrideEnabled: (id: string) => Promise<void>;
  resetOverrides: () => Promise<void>;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "Unknown error";
}

export function useHostOverridesPageModel(): HostOverridesPageModel {
  const [overrides, setOverrides] = useState<HostOverride[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [resetSupported, setResetSupported] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const nextOverrides = await listHostOverrides();
      setOverrides(nextOverrides);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runMutation = useCallback(
    async (mutation: () => Promise<void>) => {
      setSaving(true);
      setError("");

      try {
        await mutation();
      } catch (e) {
        setError(getErrorMessage(e));
        throw e;
      } finally {
        setSaving(false);
      }
    },
    []
  );

  const createOverride = useCallback(
    async (draft: HostOverrideDraft) => {
      await runMutation(async () => {
        const created = await createHostOverride(draft);
        setOverrides((prev) => [created, ...prev]);
      });
    },
    [runMutation]
  );

  const updateOverrideById = useCallback(
    async (id: string, draft: HostOverrideDraft) => {
      await runMutation(async () => {
        const updated = await updateHostOverride(id, draft);
        setOverrides((prev) =>
          prev.map((item) => (item.id === id ? updated : item))
        );
      });
    },
    [runMutation]
  );

  const deleteOverrideById = useCallback(
    async (id: string) => {
      await runMutation(async () => {
        await deleteHostOverride(id);
        setOverrides((prev) => prev.filter((item) => item.id !== id));
      });
    },
    [runMutation]
  );

  const toggleOverrideEnabled = useCallback(
    async (id: string) => {
      await runMutation(async () => {
        const updated = await toggleHostOverride(id);
        setOverrides((prev) =>
          prev.map((item) => (item.id === id ? updated : item))
        );
      });
    },
    [runMutation]
  );

  const resetOverrides = useCallback(async () => {
    await runMutation(async () => {
      try {
        await resetHostOverrides();
        await refresh();
      } catch (e) {
        const message = getErrorMessage(e);
        if (
          message.includes("reset_host_overrides") ||
          message.includes("unknown command")
        ) {
          setResetSupported(false);
        }
        throw e;
      }
    });
  }, [refresh, runMutation]);

  return {
    overrides,
    loading,
    saving,
    error,
    resetSupported,
    refresh,
    createOverride,
    updateOverrideById,
    deleteOverrideById,
    toggleOverrideEnabled,
    resetOverrides,
  };
}
