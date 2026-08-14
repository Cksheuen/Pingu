import { useEffect, useState } from "react";
import { deleteNode, importNode, setActiveNode } from "../lib/nodes-api";
import { useConnectionStore } from "../lib/connection-store";

interface NodesPageModel {
  status: ReturnType<typeof useConnectionStore.getState>["status"];
  nodes: ReturnType<typeof useConnectionStore.getState>["nodes"];
  showImport: boolean;
  openImportDialog: () => void;
  closeImportDialog: () => void;
  activateNode: (id: string) => Promise<void>;
  removeNode: (id: string) => Promise<void>;
  importNodeFromUri: (uri: string) => Promise<void>;
}

export function useNodesPageModel(): NodesPageModel {
  const { status, nodes, refreshStatus, refreshNodes, updateStatus } = useConnectionStore();
  const [showImport, setShowImport] = useState(false);

  useEffect(() => {
    refreshNodes().catch(() => undefined);
  }, [refreshNodes]);

  const activateNode = async (id: string) => {
    try {
      await setActiveNode(id);
      updateStatus((current) => ({ ...current, active_node_id: id }));
    } catch {
      // ignore
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
    status,
    nodes,
    showImport,
    openImportDialog: () => setShowImport(true),
    closeImportDialog: () => setShowImport(false),
    activateNode,
    removeNode,
    importNodeFromUri,
  };
}
