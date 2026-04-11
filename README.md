# Pingu

## 调试与验证命令

新增了一组面向后端代理调试的命令，建议在项目根目录执行。

### 1. 查看当前后端状态

```bash
pnpm run debug:proxy:status
```

用于检查：

- 当前是否有可用节点
- 当前 active node / active rule group
- 当前默认分流策略是否正确

### 2. 生成并检查 sing-box 配置

```bash
pnpm run check:config
```

这个命令会：

- 读取当前本机保存的节点与规则配置
- 生成 `sing-box-config.json`
- 调用 `sing-box check` 校验配置是否合法

### 3. 直接启动后端代理调试进程

```bash
pnpm run debug:proxy:start
```

启动后会直接在终端输出 sing-box 运行日志，监听：

- `http://127.0.0.1:2080`

适合用来排查：

- 节点是否真的连上
- 国内请求是否走 `direct`
- 国外请求是否走 `vless[proxy]`

### 4. 连通性与分流脚本

```bash
pnpm run test:routing
```

这个脚本会检查：

- 本地代理端口是否监听
- 国内站点是否可达
- 国外站点是否可达
- 当前生成配置的 `route.final`

说明：

- 这个脚本会给出 PASS / FAIL / WARN
- IP 探针结果只作为辅助判断
- 最终应结合 sing-box 运行日志确认真实出站

### 5. 一键端到端验证

```bash
pnpm run verify:routing
```

这个脚本会自动：

- 启动 debug-proxy
- 发起国内/国外请求
- 按日志验证国内是否走 `direct`
- 按日志验证国外是否走 `vless[proxy]`

## 当前推荐验证流程

每次改后端代理逻辑后，建议按下面顺序执行：

```bash
pnpm run debug:proxy:status
pnpm run check:config
pnpm run debug:proxy:start
```

另开一个终端执行：

```bash
pnpm run test:routing
```

如果要做端到端闭环验证：

```bash
pnpm run verify:routing
```
