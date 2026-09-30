import assert from "node:assert/strict";
import test from "node:test";
import { comparisonGain, type ChainComparison } from "../src/lib/chain-api.js";
function fixture(): ChainComparison {
  return { settings: { enabled: false, entry: null, exit: null }, measured_at: "", cancelled: false, same_exit: true, gain_percent:25,eligible:true,
    routes: ["direct_exit", "chain"].map(route => ({ route: route as "direct_exit" | "chain", targets:["YouTube","GitHub"].map(name=>({name,url:name,response_ms:[100,110,105],error:null})), egress_ip:"192.0.2.1",error:null })) };
}
test("latency conclusion rejects incomplete, failed, cancelled, or mismatched-exit measurements", () => {
  assert.equal(comparisonGain(fixture()),25);
  const cancelled=fixture();cancelled.cancelled=true;assert.equal(comparisonGain(cancelled),null);
  const different=fixture();different.same_exit=false;assert.equal(comparisonGain(different),null);
  const partial=fixture();partial.routes[1].targets[0].response_ms.pop();assert.equal(comparisonGain(partial),null);
  const failed=fixture();failed.routes[1].targets[1].error="HTTP 403";assert.equal(comparisonGain(failed),null);
  const invalid=fixture();invalid.routes[1].targets[0].response_ms[0]=NaN;assert.equal(comparisonGain(invalid),null);
});
