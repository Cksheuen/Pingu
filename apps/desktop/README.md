# Pingu Desktop

Pingu validates the saved route before enabling the macOS system proxy. Rule and node changes keep the public proxy listener on `127.0.0.1:2080`.

For an unattended launch, quit any existing Pingu instance, then run:

```sh
/Applications/Pingu.app/Contents/MacOS/pingu --connect
```

The flag uses the same connection, content-verification, rollback and shutdown lifecycle as the Connect button. A failed startup does not publish a connected state or take over the system proxy. Launching without the flag keeps the normal manual-connect behavior.

Run `pnpm test --plan` before verification. See [AGENTS.md](AGENTS.md) for the scoped test workflow.

## Shared VPS WARP exits and Magpie

The connection page manages a shared pool on the VPS: create, rename, inspect
and delete independent WARP registrations, select an exit for this Pingu device,
and bind each Magpie model subscription account or API key independently. Each
consumer can explicitly choose VPS direct; creating an exit does not select it.
The number of running exits is limited by VPS resources, not by a one-exit UI.

Configure an existing SSH host alias (or `root@host`), an optional absolute SSH
configuration path, and the exact server hostname of the selected VLESS node.
SSH requires key authentication and a previously trusted host key. No password,
private key, VLESS credential or Magpie web key is sent to the webview.

The server setup is documented in
[`ops/vps/README.md`](../../ops/vps/README.md#desktop-managed-cloudflare-exit).
Opening this page does not install software or register a Cloudflare device.
The server helper must support protocol version 2; an old helper is rejected.
Existing single-exit saved selections migrate to the `legacy` exit without
changing their VLESS credentials.

Selection changes only this client's VLESS identity. Device paths, TLS settings,
local rules and `127.0.0.1:2080` are preserved. Use one explicitly selected VLESS
node with chains disabled. Switch to direct before selecting another server.
A live switch is committed only after connectivity and a TLS `warp=on` trace
through the local proxy succeed. A local direct rule for `www.cloudflare.com`
prevents that verification. Changes apply to new connections; existing streams
keep their route until they close. Deletion interrupts streams using that exit.
Cloudflare IPs are shared: separate registrations can have the same IP and
recreation does not guarantee a new IP. WARP identities support TCP only; UDP
is explicitly rejected.

Magpie rows contain account names and masked key labels, never full API keys.
WARP off explicitly writes `direct`; following the provider is a separate
option. Other manually configured proxies are shown without their credentials.
Provider revisions prevent saving a stale edit; settings are backed up on the
VPS before native Magpie saves and read back afterward. Add/remove model
subscriptions, sign in and edit unrelated settings using the displayed Magpie
administration address. The Pingu panel manages their exit bindings.

Deletion is refused while any Magpie provider/account/key still references an
exit, including hidden saved overrides. Magpie must be reachable to confirm
that check. Other Pingu devices using a deleted exit must choose another exit
or direct. There is no automatic WARP-to-direct fallback for the same identity
or key; Magpie's existing account failover can choose another account, which
then follows its own proxy setting. Magpie bypasses proxies for localhost
upstreams, so those providers cannot receive a WARP binding here.


## macOS TUN

首页「网络模式」可选择系统代理或 TUN。断开时保存选择，之后每次连接（包括 `--connect` 启动）自动使用该模式。

TUN 沿用已有节点和分流规则，通过虚拟网卡接管 IPv4、IPv6 客户端流量及 DNS。A/AAAA 使用对应的 fake-IP 地址池，内核恢复域名后再匹配规则；IPv6 回环、链路本地及 ULA 地址保持直连。域名请求可经 IPv6 进入 TUN，再由出口选择可用的 IPv4/IPv6；原生 IPv6 目标能否访问仍取决于直连网络或所选代理节点的 IPv6 能力。它不设置 macOS 系统代理，也不向终端注入代理环境变量；用户已经设置的环境变量不受影响。

首次连接 TUN 时，macOS 请求一次管理员授权，安装 root 所有的 `com.pingu.network` launchd 网络助手。后续启动、连接和断开复用助手，不重复授权；界面更新和签名变化不会触发重新安装。界面通过 root 所有且不可由普通用户修改的客户端桥接程序调用助手，桥接程序以普通用户运行，仅提供 ping/start；助手校验桥接程序签名与安装用户。只有未安装或旧版迁移时进入安装授权，已安装组件暂时不可用时返回错误，不把故障转为重复授权。界面始终以普通用户运行，不保存密码，不修改 sudoers，也不使用 setuid。助手仅接受安装用户和已授权桥接程序签名的请求，不接受自定义可执行文件或 shell 命令。

每个连接独立启动核心，控制 socket 关闭、app 退出或助手停止时终止该核心并清理路由。TUN 使用本机 `127.0.0.1:16553` DNS 和 fake-IP，让未设置代理环境变量的域名请求进入规则栈；外网代理目标通过代理出口的 DoH 解析，避免把其他内网代理的临时 IP 发给出口；DIRECT 和代理节点初始化仍使用原本的本地解析。内网 fake-IP 例外、现有内网 DNS 和其他 VPN 路由保留。DNS 通过 configd 的会话键发布，断开或助手崩溃自动移除自己的条目，不改写其他 VPN 或网络服务的持久 DNS。核心配置和缓存位于 root 私有临时目录，连接结束后删除。

组件路径：`/Library/PrivilegedHelperTools/com.pingu.network/`，启动项：`/Library/LaunchDaemons/com.pingu.network.plist`。卸载时先断开 Pingu，再由管理员 `launchctl bootout system/com.pingu.network`，删除上述两个专属路径和 `/private/var/run/pingu-network/`。

首次本机授权与真实路由验收需要在安装后的 macOS 应用中完成；普通单元测试不代表已获得该授权。切换模式须先断开，避免两种模式同时接管网络。
