type Lang = "en" | "zh";

const translations: Record<string, Record<Lang, string>> = {
  // Sidebar
  "nav.home": { en: "Home", zh: "首页" },
  "nav.nodes": { en: "Nodes", zh: "节点" },
  "nav.rules": { en: "Rules", zh: "规则" },
  "nav.logs": { en: "Logs", zh: "日志" },

  // Home
  "home.connection": { en: "CONNECTION", zh: "连接状态" },
  "home.connected": { en: "Connected", zh: "已连接" },
  "home.disconnected": { en: "Disconnected", zh: "未连接" },
  "home.connected_status": { en: "CONNECTED", zh: "已连接" },
  "home.disconnected_status": { en: "DISCONNECTED", zh: "未连接" },
  "home.current_node": { en: "CURRENT NODE", zh: "当前节点" },
  "home.no_node": { en: "No node selected", zh: "未选择节点" },
  "home.traffic": { en: "TRAFFIC", zh: "流量" },
  "home.upload": { en: "Upload", zh: "上传" },
  "home.download": { en: "Download", zh: "下载" },
  "home.terminal_proxy": { en: "TERMINAL PROXY", zh: "终端代理" },
  "home.copy": { en: "Copy", zh: "复制" },
  "home.copied": { en: "Copied!", zh: "已复制!" },
  "home.connect_for_commands": { en: "Connect to get proxy commands", zh: "连接后获取代理命令" },
  "home.port": { en: "PORT", zh: "端口" },

  // Nodes
  "nodes.title": { en: "NODES", zh: "节点管理" },
  "nodes.import": { en: "Import Link", zh: "导入链接" },
  "nodes.import_title": { en: "Import Node", zh: "导入节点" },
  "nodes.import_placeholder": { en: "Paste vless:// link here...", zh: "在此粘贴 vless:// 链接..." },
  "nodes.cancel": { en: "Cancel", zh: "取消" },
  "nodes.import_btn": { en: "Import", zh: "导入" },
  "nodes.importing": { en: "Importing...", zh: "导入中..." },
  "nodes.empty": { en: "No nodes. Import a vless:// link to get started.", zh: "暂无节点。导入 vless:// 链接开始使用。" },
  "nodes.active": { en: "Active", zh: "活跃" },
  "nodes.import_error": { en: "Failed to import node. Please check the link and try again.", zh: "导入节点失败。请检查链接后重试。" },

  // Rules
  "rules.title": { en: "ROUTING RULES", zh: "路由规则" },
  "rules.add": { en: "Add Rule", zh: "添加规则" },
  "rules.default_strategy": { en: "DEFAULT STRATEGY", zh: "默认策略" },
  "rules.default_desc_proxy": { en: "Unmatched traffic goes through proxy", zh: "未匹配流量通过代理" },
  "rules.default_desc_direct": { en: "Unmatched traffic connects directly", zh: "未匹配流量直接连接" },
  "rules.direct": { en: "Direct", zh: "直连" },
  "rules.proxy": { en: "Proxy", zh: "代理" },
  "rules.block": { en: "Block", zh: "拦截" },
  "rules.type": { en: "TYPE", zh: "类型" },
  "rules.match": { en: "MATCH", zh: "匹配" },
  "rules.outbound": { en: "OUTBOUND", zh: "出站" },
  "rules.add_title": { en: "Add Rule", zh: "添加规则" },
  "rules.type_label": { en: "Type", zh: "规则类型" },
  "rules.match_label": { en: "Match Value", zh: "匹配值" },
  "rules.outbound_label": { en: "Outbound", zh: "出站方式" },
  "rules.adding": { en: "Adding...", zh: "添加中..." },
  "rules.empty": { en: "No rules. Add a rule to control routing.", zh: "暂无规则。添加规则来控制路由。" },
  "rules.add_error": { en: "Failed to add rule.", zh: "添加规则失败。" },

  // Logs
  "logs.title": { en: "LOGS", zh: "日志" },
  "logs.clear": { en: "Clear", zh: "清空" },
  "logs.empty": { en: "No logs yet", zh: "暂无日志" },
  "logs.log_path": { en: "Log file:", zh: "日志文件：" },

  // Tooltips
  "tooltip.geosite": {
    en: "GeoSite: Match by domain category from maintained lists. E.g. 'geolocation-cn' matches all known Chinese domains including Apple CN, Google CN services.",
    zh: "GeoSite：按维护列表中的域名分类匹配。如 'geolocation-cn' 匹配所有已知中国域名，包括 Apple CN、Google CN 等服务。",
  },
  "tooltip.geoip": {
    en: "GeoIP: Match by IP geolocation. E.g. 'cn' matches IP addresses located in China.",
    zh: "GeoIP：按 IP 地理位置匹配。如 'cn' 匹配位于中国的 IP 地址。",
  },
  "tooltip.domain_suffix": {
    en: "Domain Suffix: Match domains ending with this suffix. E.g. '.edu.cn' matches all Chinese education domains.",
    zh: "域名后缀：匹配以此后缀结尾的域名。如 '.edu.cn' 匹配所有中国教育域名。",
  },
  "tooltip.domain": {
    en: "Domain: Match exact domain name. E.g. 'google.com' only matches google.com itself.",
    zh: "域名：精确匹配域名。如 'google.com' 仅匹配 google.com 本身。",
  },
  "tooltip.ip_cidr": {
    en: "IP CIDR: Match IP address range in CIDR notation. E.g. '10.0.0.0/8' matches private network addresses.",
    zh: "IP CIDR：按 CIDR 表示法匹配 IP 地址范围。如 '10.0.0.0/8' 匹配内网地址。",
  },
  "tooltip.default_strategy": {
    en: "Determines how unmatched traffic is handled. 'Proxy' sends it through your VPS. 'Direct' connects without proxy.",
    zh: "决定未匹配流量的处理方式。'代理'通过 VPS 转发。'直连'不经过代理。",
  },
  "tooltip.outbound_direct": {
    en: "Direct: Connect without going through the proxy server.",
    zh: "直连：不经过代理服务器直接连接。",
  },
  "tooltip.outbound_proxy": {
    en: "Proxy: Route traffic through your VPS proxy server.",
    zh: "代理：通过 VPS 代理服务器转发流量。",
  },
  "tooltip.outbound_block": {
    en: "Block: Reject the connection entirely.",
    zh: "拦截：完全拒绝连接。",
  },
  "tooltip.reality": {
    en: "REALITY: A TLS camouflage protocol that makes proxy traffic look like normal HTTPS, resistant to deep packet inspection.",
    zh: "REALITY：一种 TLS 伪装协议，使代理流量看起来像正常 HTTPS，可抵抗深度包检测。",
  },
  "tooltip.terminal_proxy": {
    en: "Run these commands in your terminal to route CLI traffic (curl, git, npm, etc.) through the proxy.",
    zh: "在终端运行这些命令，使 CLI 流量（curl、git、npm 等）通过代理。",
  },
  "tooltip.ip_is_private": {
    en: "IP Private: Match private/reserved IP addresses (LAN, localhost, etc.). Typically set to Direct.",
    zh: "私有 IP：匹配私有/保留 IP 地址（局域网、本机等），通常设为直连。",
  },
  "tooltip.dns_split": {
    en: "DNS is automatically split: Chinese domains use AliDNS (223.5.5.5) directly, others use Google DNS (8.8.8.8) via proxy. This prevents DNS pollution.",
    zh: "DNS 已自动分流：中国域名使用阿里 DNS（223.5.5.5）直连解析，其余使用 Google DNS（8.8.8.8）通过代理解析，防止 DNS 污染。",
  },
  "rules.groups": { en: "RULE GROUPS", zh: "规则组" },
  "rules.new_group": { en: "New Group", zh: "新建组" },
  "rules.rename": { en: "Rename", zh: "重命名" },
  "rules.delete_group": { en: "Delete Group", zh: "删除组" },
  "rules.delete_group_confirm": { en: "Delete this rule group?", zh: "确认删除此规则组？" },
  "rules.group_name_placeholder": { en: "Group name...", zh: "组名称..." },
  "rules.create": { en: "Create", zh: "创建" },
  "tooltip.rule_groups": {
    en: "Rule Groups let you maintain different routing configs for different scenarios (e.g., daily use, university, full proxy).",
    zh: "规则组允许你为不同场景维护不同的路由配置（如日常使用、大学访问、全代理）。",
  },
  "rules.builtin_info": {
    en: "Built-in: DNS split, private IP direct, and rule-set caching are auto-configured.",
    zh: "内置：DNS 分流、私有 IP 直连、规则集缓存已自动配置。",
  },
};

let currentLang: Lang = (() => {
  try {
    return (localStorage.getItem("lang") as Lang) || "zh";
  } catch {
    return "zh" as Lang;
  }
})();

const listeners = new Set<() => void>();

export function t(key: string): string {
  return translations[key]?.[currentLang] ?? key;
}

export function getLang(): Lang {
  return currentLang;
}

export function setLang(lang: Lang) {
  currentLang = lang;
  try {
    localStorage.setItem("lang", lang);
  } catch {
    /* noop */
  }
  listeners.forEach((fn) => fn());
}

export function onLangChange(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
