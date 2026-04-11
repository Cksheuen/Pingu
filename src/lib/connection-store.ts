import { create } from "zustand";
import { getStatus, listNodes, getProxyInfo } from "./api";
import type { ProxyStatus, Node, ProxyInfo } from "./types";

interface ConnectionState {
  status: ProxyStatus;
  nodes: Node[];
  proxyInfo: ProxyInfo | null;
  loaded: boolean;
  loading: boolean;

  refreshStatus: () => Promise<ProxyStatus>;
  refreshNodes: () => Promise<Node[]>;
  refreshProxyInfo: () => Promise<ProxyInfo>;
  refreshAll: () => Promise<void>;
  updateStatus: (updater: (s: ProxyStatus) => ProxyStatus) => void;
  setNodes: (nodes: Node[]) => void;
}

const defaultStatus: ProxyStatus = {
  connected: false,
  active_node_id: null,
  uptime_seconds: 0,
};

let inflightRefresh: Promise<ProxyStatus> | null = null;

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  status: defaultStatus,
  nodes: [],
  proxyInfo: null,
  loaded: false,
  loading: false,

  refreshStatus: async () => {
    if (inflightRefresh) return inflightRefresh;

    set({ loading: true });

    inflightRefresh = getStatus()
      .then((status) => {
        set({ status, loaded: true, loading: false });
        return status;
      })
      .catch((error) => {
        set({ loaded: true, loading: false });
        throw error;
      })
      .finally(() => {
        inflightRefresh = null;
      });

    return inflightRefresh;
  },

  refreshNodes: async () => {
    const nodes = await listNodes();
    set({ nodes });
    return nodes;
  },

  refreshProxyInfo: async () => {
    const proxyInfo = await getProxyInfo();
    set({ proxyInfo });
    return proxyInfo;
  },

  refreshAll: async () => {
    const [status, nodes, proxyInfo] = await Promise.all([
      getStatus(),
      listNodes(),
      getProxyInfo(),
    ]);
    set({ status, nodes, proxyInfo, loaded: true, loading: false });
  },

  updateStatus: (updater) => {
    set({ status: updater(get().status) });
  },

  setNodes: (nodes) => set({ nodes }),
}));
