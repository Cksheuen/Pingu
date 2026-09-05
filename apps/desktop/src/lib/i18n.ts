type Lang = "en" | "zh";

const translations: Record<string, Record<Lang, string>> = {
  // Sidebar
  "nav.home": { en: "Home", zh: "首页" },
  "nav.nodes": { en: "Nodes", zh: "节点" },
  "nav.rules": { en: "Rules", zh: "规则" },
  "nav.host_overrides": { en: "Overrides", zh: "覆盖项" },
  "nav.logs": { en: "Logs", zh: "日志" },

  // Home
  "home.connection": { en: "CONNECTION", zh: "连接状态" },
  "home.workspace_kicker": { en: "PRIVATE NETWORK / DESKTOP", zh: "私人网络 / 桌面端" },
  "home.workspace_title": { en: "Relay console", zh: "中继控制台" },
  "home.workspace_desc": {
    en: "Authorize this network, connect the relay, and watch the live path from one place.",
    zh: "在一个界面完成网络授权、连接中继并观察实时链路。",
  },
  "home.link_control": { en: "LINK CONTROL", zh: "链路控制" },
  "home.connect_action": { en: "Start relay", zh: "启动中继" },
  "home.disconnect_action": { en: "Stop relay", zh: "断开中继" },
  "home.connecting_status": { en: "CONNECTING", zh: "连接中" },
  "home.uptime": { en: "Session uptime", zh: "本次连接时长" },
  "home.network_access": { en: "NETWORK LEASE", zh: "网络租约" },
  "home.lease_active": { en: "Authorized", zh: "已授权" },
  "home.lease_missing": { en: "Not configured", zh: "尚未配置" },
  "home.lease_pending": { en: "Checking", zh: "检查中" },
  "home.lease_desc": {
    en: "Pingu renews the current public IP automatically before it reaches the VPS.",
    zh: "Pingu 会在连接 VPS 前自动续期当前公网 IP。",
  },
  "home.lease_until": { en: "Valid until", zh: "有效期至" },
  "home.lease_manage": { en: "Manage", zh: "管理" },
  "home.lease_renew": { en: "Renew", zh: "续期" },
  "home.lease_renewing": { en: "Renewing", zh: "续期中" },
  "home.connected": { en: "Connected", zh: "已连接" },
  "home.disconnected": { en: "Disconnected", zh: "未连接" },
  "home.connected_status": { en: "CONNECTED", zh: "已连接" },
  "home.disconnected_status": { en: "DISCONNECTED", zh: "未连接" },
  "home.current_node": { en: "RELAY NODE", zh: "中继节点" },
  "home.no_node": { en: "No node selected", zh: "未选择节点" },
  "home.current_rule_group": { en: "CURRENT RULE GROUP", zh: "当前规则组" },
  "home.no_rule_group": { en: "No rule group selected", zh: "未选择规则组" },
  "home.no_rule_group_disconnected": { en: "Connect to sync rule group", zh: "连接后同步规则组" },
  "home.traffic": { en: "TRAFFIC", zh: "流量" },
  "home.ai_preflight": { en: "AI SERVICE PREFLIGHT", zh: "AI 服务使用前验证" },
  "home.preflight_checking": { en: "Checking", zh: "检测中" },
  "home.preflight_recheck": { en: "Recheck", zh: "重新验证" },
  "home.preflight_connect": { en: "Connect to verify the egress and service routes.", zh: "连接后验证实际出口与服务路由。" },
  "home.preflight_ready": {
    en: "Observed through Pingu; the listed AI destinations are configured for proxy routing.",
    zh: "出口由 Pingu 实测，所列 AI 服务已配置为通过代理路由。",
  },
  "home.preflight_route_error": {
    en: "At least one listed AI destination is direct or blocked. Select a proxy rule group before use.",
    zh: "至少一个 AI 服务当前直连或被拦截；使用前请切换至代理规则组。",
  },
  "home.preflight_route_proxy": { en: "PROXY", zh: "代理" },
  "home.preflight_route_direct": { en: "DIRECT", zh: "直连" },
  "home.preflight_route_block": { en: "BLOCKED", zh: "拦截" },
  "home.preflight_check_egress_ip": { en: "IP response", zh: "IP 内容响应" },
  "home.preflight_check_cloudflare_trace": { en: "Cloudflare trace", zh: "Cloudflare 内容回显" },
  "home.preflight_check_google_content": { en: "Google HTTP content", zh: "Google HTTP 内容" },
  "home.preflight_check_passed": { en: "PASSED", zh: "通过" },
  "home.preflight_copy_claude": { en: "Copy Claude command", zh: "复制 Claude 命令" },
  "home.preflight_scope_note": {
    en: "These content checks verify routing and reachability, not IP reputation, Cloudflare challenge passage, or account eligibility.",
    zh: "这些内容校验只证明路由与可达性；不把它们当作 IP 信誉、Cloudflare 放行或账户资格的结论。",
  },
  "home.upload": { en: "Upload", zh: "上传" },
  "home.download": { en: "Download", zh: "下载" },
  "home.terminal_proxy": { en: "TERMINAL PROXY", zh: "终端代理" },
  "home.copy": { en: "Copy", zh: "复制" },
  "home.copied": { en: "Copied!", zh: "已复制!" },
  "home.copy_failed": { en: "Copy failed", zh: "复制失败" },
  "home.connect_for_commands": { en: "Connect to get proxy commands", zh: "连接后获取代理命令" },
  "home.port": { en: "PORT", zh: "端口" },

  // Nodes
  "nodes.kicker": { en: "SYSTEM / RELAYS", zh: "系统 / 中继节点" },
  "nodes.desc": {
    en: "Choose the encrypted route Pingu uses when the relay is active.",
    zh: "选择 Pingu 启动中继时使用的加密节点。",
  },
  "nodes.title": { en: "NODES", zh: "节点管理" },
  "nodes.import": { en: "Import Link", zh: "导入链接" },
  "nodes.import_title": { en: "Import Node", zh: "导入节点" },
  "nodes.import_placeholder": {
    en: "Paste a vless:// node link or an https:// subscription URL...",
    zh: "在此粘贴 vless:// 节点链接或 https:// 订阅链接...",
  },
  "nodes.cancel": { en: "Cancel", zh: "取消" },
  "nodes.import_btn": { en: "Import", zh: "导入" },
  "nodes.importing": { en: "Importing...", zh: "导入中..." },
  "nodes.empty": { en: "No nodes. Import a vless:// link to get started.", zh: "暂无节点。导入 vless:// 链接开始使用。" },
  "nodes.active": { en: "Active", zh: "活跃" },
  "nodes.switching": { en: "Switching…", zh: "切换中…" },
  "nodes.delete_confirm": {
    en: "Delete this node? Existing rules and overrides stay in place.",
    zh: "删除该节点？已有规则与覆盖项不受影响。",
  },
  "nodes.empty_cta": { en: "Import your first node", zh: "导入第一个节点" },
  "nodes.import_error": { en: "Failed to import node. Please check the link and try again.", zh: "导入节点失败。请检查链接后重试。" },

  // Rules
  "rules.kicker": { en: "TRAFFIC / ROUTING", zh: "流量 / 路由" },
  "rules.desc": {
    en: "Define which destinations use the relay, connect directly, or stay blocked.",
    zh: "定义哪些目标经过中继、直接连接或保持拦截。",
  },
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
  "rules.delete_confirm": { en: "Delete this rule?", zh: "删除这条规则？" },

  // Logs
  "logs.kicker": { en: "RUNTIME / DIAGNOSTICS", zh: "运行时 / 诊断" },
  "logs.desc": {
    en: "Inspect local runtime events without exposing connection credentials.",
    zh: "检查本机运行事件，连接凭证不会显示在日志中。",
  },
  "logs.title": { en: "LOGS", zh: "日志" },
  "logs.clear": { en: "Clear", zh: "清空" },
  "logs.empty": { en: "No logs yet", zh: "暂无日志" },
  "logs.log_path": { en: "Log file:", zh: "日志文件：" },
  "logs.filter_all": { en: "All", zh: "全部" },
  "logs.search_placeholder": { en: "Search logs…", zh: "搜索日志…" },

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

  // Host overrides
  "host_overrides.kicker": { en: "DNS / EXCEPTIONS", zh: "DNS / 例外规则" },
  "host_overrides.title": { en: "HOST OVERRIDES", zh: "主机覆盖项" },
  "host_overrides.subtitle": {
    en: "Manage host-level resolver and outbound overrides used by the runtime.",
    zh: "管理运行时使用的主机级解析与出站覆盖项。",
  },
  "host_overrides.list": { en: "OVERRIDE LIST", zh: "覆盖项列表" },
  "host_overrides.add": { en: "Add Override", zh: "新增覆盖项" },
  "host_overrides.add_title": { en: "Create Override", zh: "新建覆盖项" },
  "host_overrides.edit_title": { en: "Edit Override", zh: "编辑覆盖项" },
  "host_overrides.create": { en: "Create", zh: "创建" },
  "host_overrides.save": { en: "Save", zh: "保存" },
  "host_overrides.saving": { en: "Saving...", zh: "保存中..." },
  "host_overrides.cancel": { en: "Cancel", zh: "取消" },
  "host_overrides.refresh": { en: "Refresh", zh: "刷新" },
  "host_overrides.reset": { en: "Reset Overrides", zh: "重置覆盖项" },
  "host_overrides.loading": { en: "Loading...", zh: "加载中..." },
  "host_overrides.empty": {
    en: "No host overrides yet. Add one to pin resolver or outbound behavior for a specific host.",
    zh: "还没有主机覆盖项。新增一条后可为特定 host 固定解析器或出站策略。",
  },
  "host_overrides.host": { en: "Host", zh: "主机" },
  "host_overrides.host_placeholder": {
    en: "registry.internal.example.com",
    zh: "例如 registry.internal.example.com",
  },
  "host_overrides.resolver": { en: "Resolver", zh: "解析器" },
  "host_overrides.outbound": { en: "Outbound", zh: "出站" },
  "host_overrides.reason": { en: "Reason", zh: "原因" },
  "host_overrides.reason_placeholder": {
    en: "Why should this host bypass suffix rules or use another resolver?",
    zh: "说明为什么这个 host 需要压过后缀规则或改用其他解析器。",
  },
  "host_overrides.enabled": { en: "Enabled", zh: "启用" },
  "host_overrides.disabled": { en: "Disabled", zh: "停用" },
  "host_overrides.enable": { en: "Enable", zh: "启用" },
  "host_overrides.disable": { en: "Disable", zh: "停用" },
  "host_overrides.edit": { en: "Edit", zh: "编辑" },
  "host_overrides.delete": { en: "Delete", zh: "删除" },
  "host_overrides.delete_confirm": { en: "Delete this override?", zh: "删除这条覆盖项？" },
  "host_overrides.source.manual": { en: "Manual", zh: "手动" },
  "host_overrides.source.runtime_learned": { en: "Runtime Learned", zh: "运行时学习" },
  "host_overrides.source.runtime_fallback": { en: "Runtime Fallback", zh: "运行时回退" },
  "host_overrides.last_verified": { en: "Last Verified", zh: "最近验证" },
  "host_overrides.never_verified": { en: "Never", zh: "未验证" },
  "host_overrides.no_reason": { en: "No reason provided.", zh: "未填写原因。" },
  "host_overrides.resolver_value.inherit": { en: "Inherit", zh: "继承默认" },
  "host_overrides.resolver_value.system-dns": { en: "System DNS", zh: "系统 DNS" },
  "host_overrides.resolver_value.local-dns": { en: "Local DNS", zh: "本地 DNS" },
  "host_overrides.resolver_value.remote-dns": { en: "Remote DNS", zh: "远端 DNS" },
  "host_overrides.outbound_value.inherit": { en: "Inherit", zh: "继承默认" },
  "host_overrides.outbound_value.direct": { en: "Direct", zh: "直连" },
  "host_overrides.outbound_value.proxy": { en: "Proxy", zh: "代理" },
  "host_overrides.outbound_value.block": { en: "Block", zh: "拦截" },

  // Settings
  "nav.settings": { en: "Settings", zh: "设置" },
  "sidebar.relay_status": { en: "Relay status", zh: "中继状态" },
  "settings.title": { en: "SETTINGS", zh: "设置" },
  "settings.kicker": { en: "SYSTEM / PREFERENCES", zh: "系统 / 偏好设置" },
  "settings.workspace_title": { en: "Preferences", zh: "偏好设置" },
  "settings.workspace_desc": {
    en: "Control startup behavior, language, and the private network lease used by this device.",
    zh: "管理启动行为、显示语言，以及此设备使用的私人网络租约。",
  },
  "settings.general": { en: "GENERAL", zh: "常规" },
  "settings.access_setup": { en: "ACCESS SETUP", zh: "授权设置" },
  "settings.access_note": {
    en: "The link is stored locally. Its token is never shown again after saving.",
    zh: "访问链接仅保存在本机；保存后不会再次显示其中的令牌。",
  },
  "settings.autostart": { en: "Launch at Login", zh: "开机启动" },
  "settings.autostart_desc": { en: "Start Pingu automatically when you log in", zh: "登录系统时自动启动 Pingu" },
  "settings.language": { en: "Language", zh: "语言" },
  "settings.language_desc": { en: "Choose display language", zh: "选择显示语言" },
  "settings.gate": { en: "Automatic Network Access", zh: "自动网络授权" },
  "settings.gate_desc": {
    en: "Paste the access link once. Pingu authorizes the current network before connecting and renews it automatically.",
    zh: "只需粘贴一次访问链接，Pingu 会在连接前授权当前网络并自动续期。",
  },
  "settings.gate_toggle": { en: "Toggle automatic network access", zh: "切换自动网络授权" },
  "settings.gate_ready": { en: "Ready", zh: "已就绪" },
  "settings.gate_attention": { en: "Needs attention", zh: "需要处理" },
  "settings.gate_placeholder": { en: "Paste Gate access link", zh: "粘贴 Gate 访问链接" },
  "settings.gate_replace_placeholder": { en: "Paste a new link to replace the current one", zh: "粘贴新链接可替换当前配置" },
  "settings.gate_save": { en: "Save & Authorize", zh: "保存并授权" },
  "settings.gate_saving": { en: "Authorizing...", zh: "授权中..." },
  "settings.gate_current_ip": { en: "Current lease", zh: "当前租约" },
  "settings.gate_expires": { en: "Expires", zh: "到期时间" },
  "settings.gate_renew": { en: "Renew now", zh: "立即续期" },
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
