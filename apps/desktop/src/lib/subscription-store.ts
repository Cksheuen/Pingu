import { create } from "zustand";
import { listSubscriptions, updateSubscription, type SubscriptionSummary } from "./mihomo-api.js";
import { errorMessage } from "./network-view.js";

import { runOptimistic } from "./optimistic.js";

interface SubscriptionState {
  subscriptions: SubscriptionSummary[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  refresh: () => Promise<void>;
}

let pending: Promise<void> | null = null;
export const useSubscriptionStore = create<SubscriptionState>((set, get) => ({
  subscriptions: [], loading: false, loaded: false, error: null,
  setEnabled: async (id, enabled) => {
    if (pending) await pending;
    const previous = get().subscriptions.find(source => source.id === id);
    if (!previous) return;
    const patch = (value: boolean) => set(state => ({
      subscriptions: state.subscriptions.map(source => source.id === id ? { ...source, enabled: value } : source),
    }));
    await runOptimistic({
      apply: () => patch(enabled),
      commit: () => updateSubscription(id, { enabled }),
      rollback: () => patch(previous.enabled),
    });
  },
  refresh: () => {
    if (pending) return pending;
    set({ loading: true, error: null });
    pending = listSubscriptions().then((subscriptions) => {
      set({ subscriptions, loaded: true, error: null });
    }).catch((cause: unknown) => {
      set({ error: errorMessage(cause) });
      throw cause;
    }).finally(() => {
      pending = null;
      set({ loading: false });
    });
    return pending;
  },
}));
