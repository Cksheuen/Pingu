import { Menu } from "../components/Menu";
import { NetworkLoading } from "../components/network/NetworkState";
import { confirmAction } from "../lib/confirm-action";
import { SectionHeader } from "../components/SectionHeader";
import { t } from "../lib/i18n";
import Tooltip from "../components/Tooltip";
import { ImportDialog } from "../components/nodes/ImportDialog";
import { useI18nRerender } from "../hooks/useI18nRerender";
import { useNodesPageModel } from "../hooks/useNodesPageModel";

function PlusIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export default function Nodes() {
  const {
    activeNodeId,
    nodes,
    loading,
    showImport,
    switchingNodeId,
    switchError,
    openImportDialog,
    closeImportDialog,
    activateNode,
    removeNode,
    importNodeFromUri,
  } = useNodesPageModel();
  useI18nRerender();

  return (
    <div className="workspace-section">
      <SectionHeader title={t("workspace.manual_nodes")}>
        <button
          onClick={openImportDialog}
          className="btn btn-primary"
        >
          <PlusIcon />
          {t("nodes.import")}
        </button>
      </SectionHeader>
      {switchError && <p className="node-switch-error" role="alert">{switchError}</p>}
      {/* Node list */}
      <div className="node-list flex flex-col gap-2">
        {loading && <NetworkLoading />}
        {!loading && nodes.length === 0
          && (
            <div className="empty-state">
              <p>{t("nodes.empty")}</p>
              <button className="btn" onClick={openImportDialog}>
                {t("nodes.empty_cta")}
              </button>
            </div>
          )}
        {nodes.map(
          (node) => {
            const isActive = node.id === activeNodeId;
            const isSwitching = node.id === switchingNodeId;
            const switching = switchingNodeId !== null;
            return (
              <div
                key={node.id}
                aria-busy={isSwitching}
                data-switching={isSwitching}
                className="row node-row"
                style={{
                  borderColor: isActive ? "var(--color-accent)" : "var(--line)",
                }}
              >
                {/* Status dot */}
                <span
                  className="status-dot shrink-0"
                  style={{
                    width: "10px",
                    height: "10px",
                    backgroundColor: isActive ? "var(--color-accent)" : "var(--color-text-muted)",
                  }}
                />
                {/* Info */}
                <div className="flex-1 min-w-0">
                  <p className="font-sans font-semibold text-text-primary truncate" style={{ fontSize: "15px" }}>
                    {node.name}
                  </p>
                  <span className="flex items-center gap-1" style={{ marginTop: "2px" }}>
                    <span className="font-mono text-text-secondary truncate" style={{ fontSize: "var(--text-xs)" }}>
                      {node.address}
                      {":"}
                      {node.port}
                    </span>
                    <span className="text-text-secondary" style={{ fontSize: "var(--text-xs)" }}> · </span>
                    <span className="text-text-secondary" style={{ fontSize: "var(--text-xs)" }}>
                      {"VLESS"}
                      {node.security ? ` + ${node.security.toUpperCase()}` : ""}
                    </span>
                    {node.security === "reality" && <Tooltip text={t("tooltip.reality")} />}
                  </span>
                </div>
                {/* Status / actions */}
                <div className="node-row-actions">
                  {(isActive || isSwitching) && <span className="pill pill-accent">
                    {isSwitching ? t("nodes.switching") : t("nodes.active")}
                  </span>}
                  <div className="row-actions">
                    <Menu label={`${t("lists.actions")} ${node.name}`} items={[
                      ...(!isActive ? [{ label: t("nodes.set_active"), disabled: switching,
                        onSelect: () => { void activateNode(node.id); } }] : []),
                      { label: t("network.delete"), tone: "danger", disabled: switching,
                        onSelect: () => {
                          void (async () => {
                            if (await confirmAction(t("nodes.delete_confirm"))) await removeNode(node.id);
                          })();
                        } },
                    ]} />
                  </div>
                </div>
              </div>
            );
          }
        )}
      </div>
      {showImport
        && (
          <ImportDialog onClose={closeImportDialog} onImport={importNodeFromUri} />
        )}
    </div>
  );
}
