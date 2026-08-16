import { useEffect, useState } from "react";
import { deleteNode, importNode, setActiveNode } from "../lib/nodes-api";
import { useConnectionStore } from "../lib/connection-store";

interface NodesPageModel {
  activeNodeId: string | null;
  nodes: ReturnType<typeof useConnectionStore.getState>["nodes"];
  showImport: boolean;
  switchingNodeId: string | null;
  switchError: string | null;
  openImportDialog: () => void;
  closeImportDialog: () => void;
  activateNode: (id: string) => Promise<void>;
  removeNode: (id: string) => Promise<void>;
  importNodeFromUri: (uri: string) => Promise<void>;
}

export function useNodesPageModel(): NodesPageModel {
  const activeNodeId = useConnectionStore((state) => state.status.active_node_id);
  const nodes = useConnectionStore((state) => state.nodes);
  const refreshStatus = useConnectionStore((state) => state.refreshStatus);
  const refreshNodes = useConnectionStore((state) => state.refreshNodes);
  const [showImport, setShowImport] = useState(false);
  const [switchingNodeId, setSwitchingNodeId] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);

  useEffect(() => {
    refreshNodes().catch(() => undefined);
  }, [refreshNodes]);

  const activateNode = async (id: string) => {
    if (id === activeNodeId || switchingNodeId) return;
    setSwitchingNodeId(id);
    setSwitchError(null);
    try {
      await setActiveNode(id);
      await refreshStatus();
    } catch (cause) {
      setSwitchError(typeof cause === "string" ? cause : "Unable to switch node");
    } finally {
      setSwitchingNodeId(null);
    }
  };

  const removeNode = async (id: string) => {
    try {
      await deleteNode(id);
      await refreshNodes();
      await refreshStatus();
    } catch {
      // ignore
    }
  };

  const importNodeFromUri = async (uri: string) => {
    await importNode(uri);
    await refreshNodes();
    await refreshStatus();
  };

  return {
    activeNodeId,
    nodes,
    showImport,
    switchingNodeId,
    switchError,
    openImportDialog: () => setShowImport(true),
    closeImportDialog: () => setShowImport(false),
    activateNode,
    removeNode,
    importNodeFromUri,
  };
}
