"""Lifecycle tests for the connections page SCRIPT, run in a Node vm+DOM harness."""

import importlib.util
import json
import pathlib
import shutil
import subprocess
import tempfile
import unittest


MODULE_PATH = pathlib.Path(__file__).resolve().parent.parent / "sbin" / "pingu_connections.py"
SPEC = importlib.util.spec_from_file_location("pingu_connections", MODULE_PATH)
connections = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(connections)


HARNESS = r"""
const vm = require('vm');
const fs = require('fs');
const source = fs.readFileSync(process.argv[2], 'utf8');

const CONTROLS = ['connection-status', 'connection-rows', 'connection-search',
                  'connection-summary', 'connection-empty', 'connection-refresh',
                  'connection-close-all'];
function makeElement(tag) {
  return {
    tagName: tag, children: [], dataset: {}, hidden: false, disabled: false,
    textContent: '', type: '', value: '', listeners: {},
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
  };
}
const elements = { 'connections-app': makeElement('div') };
for (const id of CONTROLS) elements[id] = makeElement(id === 'connection-rows' ? 'tbody' : 'div');
elements['connections-app'].dataset.prefix = '/devices';
elements['connections-app'].dataset.csrf = 'csrf-token';

const documentListeners = {}, windowListeners = {};
const document = {
  hidden: false,
  getElementById: (id) => elements[id] || null,
  createElement: makeElement,
  addEventListener: (type, fn) => { (documentListeners[type] = documentListeners[type] || []).push(fn); },
};
const window = {
  addEventListener: (type, fn) => { (windowListeners[type] = windowListeners[type] || []).push(fn); },
};

let nextIntervalId = 0;
const intervals = new Map();
const setIntervalStub = (fn, ms) => { intervals.set(++nextIntervalId, { fn, ms }); return nextIntervalId; };
const clearIntervalStub = (id) => { intervals.delete(id); };

// Each read is an independent deferred so tests can settle them out of order.
const reads = [];
function fetchStub(url, options) {
  const read = { url, options };
  read.promise = new Promise((resolve) => {
    read.settle = (body, status) => {
      status = status === undefined ? 200 : status;
      resolve({ ok: status < 400, status, json: () => Promise.resolve(body || {}) });
    };
  });
  reads.push(read);
  return read.promise;
}
const settleWrite = (index, body, status) => reads[index].settle(body, status);

function fireTick() { for (const entry of Array.from(intervals.values())) entry.fn(); }
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
function fireEvent(map, type, event) { (map[type] || []).forEach((fn) => fn(Object.assign({ type }, event))); }
const data = (label, ids) => ({
  connections: (ids || []).map((id) => ({
    id, upload: 2048, download: 1024, start: '2026-09-24T00:00:00Z',
    metadata: { host: 'example.com', destinationPort: 443 }, chains: ['DIRECT'],
  })),
  uploadTotal: 4096, downloadTotal: 4096, label,
});
// Gate-attributed WS row: real client source plus a preserved backend endpoint.
const attributed = (label, metadata) => ({
  connections: [{ id: 'ws-1', upload: 1, download: 1, start: '2026-09-24T00:00:00Z', chains: ['DIRECT'], metadata }],
  uploadTotal: 2, downloadTotal: 2, label,
});
const rowCells = () => elements['connection-rows'].children.map(
  (row) => row.children.map((cell) => ({
    text: cell.textContent, small: cell.children.map((child) => child.textContent),
  })));
const state = () => ({
  reads: reads.length,
  dataReads: reads.filter((read) => read.url.endsWith('/connections/data')).length,
  intervals: intervals.size,
  summary: elements['connection-summary'].textContent,
  status: elements['connection-status'].textContent,
  statusError: elements['connection-status'].dataset.error,
  rowCount: elements['connection-rows'].children.length,
  emptyHidden: elements['connection-empty'].hidden,
});

const context = {
  document, window, fetch: fetchStub, setInterval: setIntervalStub, clearInterval: clearIntervalStub,
  console, Date, Number, Math, JSON, Promise, URLSearchParams, Error, setTimeout,
};
vm.createContext(context);
const load = () => vm.runInContext(source, context);
const emit = (obj) => process.stdout.write(JSON.stringify(obj));

const cases = {
  // Normal initial lifecycle: one immediate read, one 2s interval, rendered table.
  async initial() {
    load();
    const before = state();
    settleWrite(0, data('initial', ['c1', 'c2']));
    await flush();
    emit({
      readsAfterLoad: before.reads, intervalsAfterLoad: before.intervals,
      intervalMs: Array.from(intervals.values())[0].ms,
      after: state(), hasRefreshButton: elements['connection-refresh'].listeners.click.length === 1,
    });
  },

  // BFCache return: immediate refresh, exactly one interval, stale pre-hide read ignored (200).
  async resumed_after_stale_200() {
    load();
    settleWrite(0, data('initial', ['c1', 'c2']));
    await flush();
    fireTick();                      // read 1 issued before the page is hidden
    fireEvent(windowListeners, 'pagehide', { persisted: true });
    const afterHide = state();
    fireTick(); fireTick();          // cancelled interval must not poll while hidden
    const afterHiddenTicks = state();
    settleWrite(1, data('stale', ['stale-1', 'stale-2', 'stale-3']));
    await flush();
    const afterStale = state();
    fireEvent(windowListeners, 'pageshow', { persisted: true });
    const afterShow = state();
    settleWrite(2, data('refreshed', ['c1', 'c2', 'c3']));
    await flush();
    emit({ afterHide, afterHiddenTicks, afterStale, afterShow, afterFresh: state() });
  },

  // BFCache return where the stale pre-hide read resolves 403 after the fresh read.
  async resumed_after_stale_403() {
    load();
    settleWrite(0, data('initial', ['c1', 'c2']));
    await flush();
    fireTick();                      // read 1 issued before the page is hidden
    fireEvent(windowListeners, 'pagehide', { persisted: true });
    fireEvent(windowListeners, 'pageshow', { persisted: true });
    settleWrite(2, data('refreshed', ['c1', 'c2', 'c3']));   // fresh read wins first
    await flush();
    const afterFresh = state();
    settleWrite(1, {}, 403);         // late stale 403 must not poison the fresh page
    await flush();
    const afterStale = state();
    fireTick();                      // polling must still be alive
    const afterTick = state();
    settleWrite(3, data('still-live', ['c1']));
    await flush();
    emit({ afterFresh, afterStale, afterTick, afterLive: state() });
  },

  // A live 403 (no page transition) still marks the session expired.
  async live_403_expires() {
    load();
    settleWrite(0, data('initial', ['c1']));
    await flush();
    fireTick();
    settleWrite(1, {}, 403);
    await flush();
    const afterExpiry = state();
    const readsBeforeTick = state().reads;
    fireTick();
    emit({ afterExpiry, readsAfterTick: state().reads, readsBeforeTick });
  },

  // Duplicate pageshow must not stack intervals.
  async duplicate_pageshow() {
    load();
    settleWrite(0, data('initial', ['c1']));
    await flush();
    fireTick();
    fireEvent(windowListeners, 'pagehide', { persisted: true });
    fireEvent(windowListeners, 'pageshow', { persisted: true });
    const afterFirstShow = state();
    fireEvent(windowListeners, 'pageshow', { persisted: true });
    fireEvent(windowListeners, 'pageshow', { persisted: false });
    const afterDuplicates = state();
    settleWrite(1, data('first', ['c1']));
    await flush();
    const afterFirstSettle = state();
    settleWrite(2, data('duplicate', ['c1', 'c2', 'c3']));
    await flush();
    emit({ afterFirstShow, afterDuplicates, afterFirstSettle, afterSecondSettle: state() });
  },

  // pageshow while hidden must still be resumed by the next visible visibilitychange.
  async hidden_pageshow_then_visible() {
    load();
    settleWrite(0, data('initial', ['c1']));
    await flush();
    document.hidden = true;
    fireEvent(windowListeners, 'pagehide', { persisted: true });
    fireEvent(windowListeners, 'pageshow', { persisted: true });
    const whileHidden = state();
    const readsWhileHidden = state().reads;
    fireTick();
    const readsAfterHiddenTick = state().reads;
    document.hidden = false;
    fireEvent(documentListeners, 'visibilitychange', {});
    const afterVisible = state();
    settleWrite(1, data('resumed', ['c1', 'c2']));
    await flush();
    emit({ whileHidden, readsWhileHidden, readsAfterHiddenTick, afterVisible, afterResume: state() });
  },

  // Hidden document suppresses polling; becoming visible refreshes once.
  async hidden_suppresses_refresh() {
    load();
    settleWrite(0, data('initial', ['c1']));
    await flush();
    document.hidden = true;
    const before = state().reads;
    fireTick();
    const whileHidden = state().reads;
    document.hidden = false;
    fireEvent(documentListeners, 'visibilitychange', {});
    const afterVisible = state().reads;
    settleWrite(1, data('visible', ['c1']));
    await flush();
    emit({ readsBefore: before, readsWhileHidden: whileHidden, afterVisible, after: state() });
  },

  // A failed read shows the error, keeps the last data, and keeps polling.
  async failure_display() {
    load();
    settleWrite(0, data('initial', ['c1']));
    await flush();
    fireTick();
    settleWrite(1, undefined, 503);
    await flush();
    emit({ afterFailure: state() });
  },

  // Device-attributed WS row: source shows the real IP without a fabricated port,
  // the device label is searchable, and the Gate backend endpoint stays visible.
  async attributed_fields() {
    load();
    settleWrite(0, attributed('attributed', {
      host: 'example.com', destinationPort: 443, network: 'ws',
      inboundName: 'cf-ws-local', sourceIP: '198.51.100.27',
      pinguDeviceOwner: 'alice', pinguDeviceName: '<b>phone</b>',
      pinguBackendSourceIP: '127.0.0.1', pinguBackendSourcePort: '41001',
    }));
    await flush();
    const search = elements['connection-search'];
    const cells = rowCells();
    search.value = 'alice';
    search.listeners.input[0]();
    const deviceMatches = elements['connection-rows'].children.length;
    search.value = '<b>phone</b>';
    search.listeners.input[0]();
    const labelMatches = elements['connection-rows'].children.length;
    search.value = 'example.com';
    search.listeners.input[0]();
    emit({ cells, deviceMatches, labelMatches, hostMatches: elements['connection-rows'].children.length });
  },

  // An enriched row without a backend port must not render a trailing colon, and
  // an unknown client port must not be invented.
  async attributed_without_ports() {
    load();
    settleWrite(0, attributed('attributed', {
      host: 'example.com', network: 'ws', sourceIP: '198.51.100.27',
      pinguDeviceOwner: 'alice', pinguDeviceName: 'phone', pinguBackendSourceIP: '127.0.0.1',
    }));
    await flush();
    emit({ cells: rowCells() });
  },

  // Disconnect uses authenticated POST with CSRF and does not overlap refreshes.
  async close_button() {
    load();
    settleWrite(0, data('initial', ['c1']));
    await flush();
    const rowButton = elements['connection-rows'].children[0].children.slice(-1)[0].children[0];
    rowButton.listeners.click[0]();
    const writeIndex = reads.length - 1;
    const duringClose = state();
    settleWrite(writeIndex, {}, 200);        // the DELETE succeeds
    await flush();
    const refreshIndex = reads.length - 1;
    settleWrite(refreshIndex, data('post-close', ['c1']));
    await flush();
    emit({
      writeUrl: reads[writeIndex].url, writeMethod: reads[writeIndex].options.method,
      writeCredentials: reads[writeIndex].options.credentials, writeBody: String(reads[writeIndex].options.body),
      readCredentials: reads[0].options.credentials, readCache: reads[0].options.cache,
      duringClose, refreshUrl: reads[refreshIndex].url, afterClose: state(), buttonReenabled: !rowButton.disabled,
    });
  },
};

const name = process.argv[3];
if (!cases[name]) { process.stderr.write('unknown case: ' + name); process.exit(2); }
cases[name]().then(() => {}, (error) => { process.stderr.write(String(error && error.stack)); process.exit(1); });
"""


class _NodeHarness:
    """Runs one harness case per test, in an isolated temporary directory."""

    node = None

    @classmethod
    def setUpClass(cls):
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is required for the connections SCRIPT harness")
        cls._tmp = tempfile.TemporaryDirectory(prefix="pingu-connections-")
        directory = pathlib.Path(cls._tmp.name)
        cls.harness_path = directory / "harness.cjs"
        cls.script_path = directory / "connections-script.js"
        cls.harness_path.write_text(HARNESS, encoding="utf-8")
        cls.script_path.write_text(connections.SCRIPT, encoding="utf-8")
        cls.cases = {}

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    @classmethod
    def run_case(cls, name):
        if name not in cls.cases:
            completed = subprocess.run(
                [cls.node, str(cls.harness_path), str(cls.script_path), name],
                capture_output=True, text=True, timeout=60, check=False,
            )
            cls.cases[name] = (completed.returncode, completed.stdout, completed.stderr)
        return cls.cases[name]

    def case(self, name):
        code, stdout, stderr = self.run_case(name)
        self.assertEqual(code, 0, f"{name} exited {code}\nstdout: {stdout}\nstderr: {stderr}")
        return json.loads(stdout)


class ConnectionScriptLifecycleTests(_NodeHarness, unittest.TestCase):
    def test_initial_lifecycle_polls_once_with_one_2s_interval(self):
        result = self.case("initial")
        self.assertEqual(result["readsAfterLoad"], 1)
        self.assertEqual(result["intervalsAfterLoad"], 1)
        self.assertEqual(result["intervalMs"], 2000)
        self.assertTrue(result["hasRefreshButton"])
        after = result["after"]
        self.assertEqual(after["rowCount"], 2)
        self.assertIn("2 个活动连接", after["summary"])
        self.assertIn("每 2 秒更新", after["status"])
        self.assertEqual(after["statusError"], "false")
        self.assertTrue(after["emptyHidden"],
                        "empty placeholder stays hidden while rows are rendered")

    def test_pagehide_cancels_interval_and_stale_200_is_dropped_on_return(self):
        result = self.case("resumed_after_stale_200")
        self.assertEqual(result["afterHide"]["intervals"], 0)
        self.assertEqual(result["afterHiddenTicks"]["reads"], result["afterHide"]["reads"])
        stale = result["afterStale"]
        self.assertEqual(stale["rowCount"], 2, "pre-hide response must not overwrite state")
        self.assertIn("2 个活动连接", stale["summary"])
        self.assertEqual(result["afterShow"]["intervals"], 1)
        self.assertEqual(result["afterShow"]["reads"], result["afterStale"]["reads"] + 1)
        fresh = result["afterFresh"]
        self.assertEqual(fresh["rowCount"], 3)
        self.assertIn("3 个活动连接", fresh["summary"])
        self.assertIn("每 2 秒更新", fresh["status"])

    def test_stale_pre_hide_403_does_not_poison_fresh_page(self):
        result = self.case("resumed_after_stale_403")
        self.assertEqual(result["afterFresh"]["rowCount"], 3)
        self.assertEqual(result["afterFresh"]["statusError"], "false")
        stale = result["afterStale"]
        self.assertEqual(stale["statusError"], "false", "stale 403 must not set error state")
        self.assertNotIn("登录已过期", stale["status"])
        self.assertEqual(stale["rowCount"], 3, "stale 403 must not clobber fresh rows")
        self.assertEqual(result["afterTick"]["reads"], stale["reads"] + 1, "polling must stay alive")
        live = result["afterLive"]
        self.assertEqual(live["rowCount"], 1)
        self.assertIn("1 个活动连接", live["summary"])

    def test_live_403_marks_session_expired_and_stops_polling(self):
        result = self.case("live_403_expires")
        expired = result["afterExpiry"]
        self.assertEqual(expired["statusError"], "true")
        self.assertIn("登录已过期", expired["status"])
        self.assertEqual(result["readsAfterTick"], result["readsBeforeTick"])

    def test_duplicate_pageshow_does_not_multiply_timers(self):
        result = self.case("duplicate_pageshow")
        self.assertEqual(result["afterFirstShow"]["intervals"], 1)
        self.assertEqual(result["afterDuplicates"]["intervals"], 1, "duplicate pageshow must not stack timers")
        self.assertEqual(result["afterDuplicates"]["reads"], result["afterFirstShow"]["reads"])
        self.assertEqual(result["afterFirstSettle"]["rowCount"], 1)
        self.assertIn("1 个活动连接", result["afterFirstSettle"]["summary"])
        self.assertEqual(result["afterSecondSettle"]["reads"], result["afterFirstSettle"]["reads"])

    def test_hidden_pageshow_is_resumed_by_next_visibilitychange(self):
        result = self.case("hidden_pageshow_then_visible")
        self.assertEqual(result["readsWhileHidden"], result["readsAfterHiddenTick"])
        self.assertEqual(result["afterVisible"]["reads"], result["whileHidden"]["reads"] + 1)
        self.assertEqual(result["afterVisible"]["intervals"], 1)
        resumed = result["afterResume"]
        self.assertEqual(resumed["rowCount"], 2)
        self.assertIn("2 个活动连接", resumed["summary"])

    def test_hidden_document_suppresses_refresh(self):
        result = self.case("hidden_suppresses_refresh")
        self.assertEqual(result["readsWhileHidden"], result["readsBefore"])
        self.assertEqual(result["afterVisible"], result["readsBefore"] + 1)
        self.assertEqual(result["after"]["rowCount"], 1)

    def test_failed_read_shows_error_and_keeps_data_and_polling(self):
        failed = self.case("failure_display")["afterFailure"]
        self.assertEqual(failed["statusError"], "true")
        self.assertIn("暂时无法读取或操作 Mihomo 连接。", failed["status"])
        self.assertIn("当前显示上次成功的数据。", failed["status"])
        self.assertEqual(failed["rowCount"], 1)
        self.assertEqual(failed["intervals"], 1)

    def test_close_uses_csrf_post_and_does_not_overlap_refreshes(self):
        result = self.case("close_button")
        self.assertTrue(result["writeUrl"].endswith("/devices/connections/close"))
        self.assertEqual(result["writeMethod"], "POST")
        self.assertEqual(result["writeCredentials"], "same-origin")
        self.assertIn("csrf=csrf-token", result["writeBody"])
        self.assertIn("id=c1", result["writeBody"])
        self.assertEqual(result["readCredentials"], "same-origin")
        self.assertEqual(result["readCache"], "no-store")
        self.assertEqual(result["duringClose"]["dataReads"], 1,
                         "no refresh may overlap the close write (the only request is the POST)")
        self.assertEqual(result["duringClose"]["reads"], 2)
        self.assertTrue(result["refreshUrl"].endswith("/devices/connections/data"))
        self.assertEqual(result["afterClose"]["rowCount"], 1)
        self.assertTrue(result["buttonReenabled"])


class ConnectionAttributionDisplayTests(_NodeHarness, unittest.TestCase):
    def test_device_fields_render_searchably_through_text_content(self):
        result = self.case("attributed_fields")
        cells = result["cells"][0]     # one row; cells[0] target, cells[1] source, ...
        self.assertEqual(cells[1]["text"], "198.51.100.27",
                         "enriched source must not carry a fabricated client port")
        self.assertEqual(cells[1]["small"],
                         ["alice / <b>phone</b> · cf-ws-local · gate 127.0.0.1:41001"])
        self.assertEqual(result["deviceMatches"], 1, "device owner must be searchable")
        self.assertEqual(result["labelMatches"], 1, "device label must be searchable")
        self.assertEqual(result["hostMatches"], 1, "host search must keep working")

    def test_unknown_ports_do_not_render_trailing_colons(self):
        cells = self.case("attributed_without_ports")["cells"][0]
        self.assertEqual(cells[0]["text"], "example.com", "no trailing colon for an unknown port")
        self.assertEqual(cells[1]["text"], "198.51.100.27")
        self.assertEqual(cells[1]["small"], ["alice / phone · gate 127.0.0.1"])


if __name__ == "__main__":
    unittest.main()
