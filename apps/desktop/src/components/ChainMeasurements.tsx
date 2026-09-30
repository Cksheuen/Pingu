import { t } from "../lib/i18n";
import { comparisonGain, median, nodeKey, type ChainComparison, type ChainSelection, type TargetMeasurement } from "../lib/chain-api";
const latency = (value: TargetMeasurement | undefined) => {
  const ms = value && !value.error ? median(value.response_ms) : null;
  return ms === null || ms === undefined ? "—" : `${Math.round(ms)} ms`;
};
function Comparison({ result }: { result: ChainComparison }) {
  const direct = result.routes.find(r => r.route === "direct_exit");
  const chain = result.routes.find(r => r.route === "chain");
  const gain = comparisonGain(result);
  return <><div className="chain-table-wrap"><table className="chain-table"><thead><tr><th>{t("chain.site")}</th><th>{t("chain.single_exit")}</th><th>{t("nav.chain")}</th><th>{t("chain.samples")}</th></tr></thead><tbody>{direct?.targets.map((target, i) => <tr key={target.url}><th scope="row"><a href={target.url} target="_blank" rel="noreferrer">{target.name}</a></th><td>{latency(target)}</td><td>{latency(chain?.targets[i])}</td><td>{target.response_ms.length}/3 · {chain?.targets[i]?.response_ms.length ?? 0}/3</td></tr>)}</tbody></table></div>
    <p className="chain-conclusion" role="status">{gain === null ? t(result.cancelled ? "chain.cancelled" : !result.same_exit ? "chain.exit_unverified" : "chain.incomplete") : `${t(gain >= 0 ? "chain.faster" : "chain.slower")} ${Math.abs(gain).toFixed(1)}%`}</p></>;
}
export default function ChainMeasurements({ comparison, selection }: { comparison: ChainComparison | null; selection: ChainSelection | null }) {
  const chosen = selection?.candidates.find(c => nodeKey(c.reference) === nodeKey(selection.selected));
  const displayed = comparison ?? chosen?.comparison ?? null;
  if (!displayed && !selection) return null;
  return <div className="chain-measurements">
    {displayed && <Comparison result={displayed} />}
    {selection && <><p className="chain-auto-summary" role="status">{t(`chain.selection_${selection.outcome}`)} · {selection.candidates.length} {t("chain.candidates")}</p>
      <details className="chain-candidate-results"><summary>{t("chain.candidate_results")}</summary><div className="chain-table-wrap"><table className="chain-table"><thead><tr><th>{t("chain.entry")}</th><th>YouTube</th><th>GitHub</th><th>{t("chain.vs_single")}</th></tr></thead><tbody>
        <tr><th>{t("chain.single_exit")}</th>{selection.baseline.targets.map(target => <td key={target.url}>{latency(target)}</td>)}<td>—</td></tr>
        {selection.candidates.map(c => { const route = c.comparison?.routes.find(r => r.route === "chain"); const gain = c.comparison && comparisonGain(c.comparison); return <tr key={nodeKey(c.reference)} data-selected={!!selection.selected && nodeKey(c.reference) === nodeKey(selection.selected)}><th scope="row" title={c.source}>{nodeKey(c.reference) === nodeKey(selection.selected) ? "✓ " : ""}{c.name}</th><td>{latency(route?.targets[0])}</td><td>{latency(route?.targets[1])}</td><td>{gain === null || gain === undefined ? t("chain.incomplete_short") : `${gain > 0 ? "−" : "+"}${Math.abs(gain).toFixed(1)}%`}</td></tr>; })}
      </tbody></table></div></details></>}
    <div className="chain-measure-foot"><time>{new Date((selection ?? displayed)!.measured_at).toLocaleString()}</time><details><summary>{t("workspace.measure_method")}</summary><p className="network-hint">{t("chain.measure_note")}</p></details></div>
  </div>;
}
