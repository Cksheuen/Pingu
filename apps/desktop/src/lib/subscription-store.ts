import { create } from "zustand";
import { listSubscriptions, type SubscriptionSummary } from "./mihomo-api.js";
import { errorMessage } from "./network-view.js";

interface SubscriptionState {
  subscriptions: SubscriptionSummary[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

let pending: Promise<void> | null = null;
export const useSubscriptionStore = create<SubscriptionState>((set) => ({
  subscriptions: [], loading: false, loaded: false, error: null,
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
