import { create } from "zustand";
import { getVpsEgress, type EgressState } from "./egress-api.js";
import { errorMessage } from "./network-view.js";

interface Store {
  data: EgressState | null; error: string | null; loading: boolean; busy: boolean;
  refresh: (remote?: boolean) => Promise<void>;
  execute: (action: () => Promise<EgressState>) => Promise<boolean>;
}
let revision = 0;
export const useEgressStore = create<Store>((set, get) => ({
  data: null, error: null, loading: false, busy: false,
  refresh: async (remote = true) => {
    if (get().busy) return;
    const epoch = ++revision;
    set({ loading: true });
    try {
      const data = await getVpsEgress(remote);
      if (epoch !== revision) return;
      const previous = get().data;
      if (!remote && previous && JSON.stringify(previous.management) === JSON.stringify(data.management)) {
        data.exits = previous.exits; data.magpie = previous.magpie;
        data.installed = previous.installed; data.error = previous.error;
      }
      set({ data, error: data.error });
    } catch (cause) {
      if (epoch === revision) set({ error: errorMessage(cause) });
    } finally { if (epoch === revision) set({ loading: false }); }
  },
  execute: async (action) => {
    if (get().busy) return false;
    ++revision; set({ busy: true, loading: false, error: null });
    try {
      const data = await action();
      set({ data, error: data.error });
      return true;
    } catch (cause) {
      const error = errorMessage(cause);
      // Deletion may have switched this client to direct before a remote
      // cleanup failed. Always display canonical state, never the old choice.
      try { set({ data: await getVpsEgress(true) }); } catch { /* retain last snapshot */ }
      set({ error }); return false;
    } finally { set({ busy: false }); }
  },
}));
