# 设计决策记录

> 活文档：每完成一个组件的讨论，追加一条记录。格式 = 组件 / 问题 / 决策 / 提炼的设计原则。
> 跨 app 稳定的原则再提炼到 `docs/design-principles.md`（暂不建）。

---

## 2026-08-14 · Header（eva-blog）

### 组件

`SiteHeader`（apps/eva-blog，原 `.topbar` + `.home-intro-dock`）

### 问题

首页存在两个 bar：

1. `.topbar`——sticky 常驻的真 header（brand、导航、read-only 信号、语言切换）
2. `.home-intro-dock`——fixed 定位，滚动 >150px 后从顶部滑入，显示文章标题 + "EXPAND INTRO ↑"

二者职能重复（都是"当前在哪、怎么回去"的入口），且 dock 没有按最初设想与 topbar 的隐藏联动——topbar 始终可见，dock 只是叠在上面。

### 决策

**一个 header 组件，两态**，而非两个元素：

- `expanded`：完整 topbar（现状）
- `condensed`：同一 `.topbar` 加 `is-condensed` class（紧凑 padding、隐藏 tagline、brand mark 缩小）
- 首页滚动 >150px 切 condensed（迟滞 42px，防止边界抖动）；回顶或点 brand 恢复 expanded
- 非首页路由：始终 expanded（问题 #1 只在首页，其余页面行为不动）
- 删除 `.home-intro-dock` 元素、JS 逻辑、CSS 规则
- brand 点击（`href="#/"`）+ 平滑回顶，承接旧 dock 的"回到介绍"职能

### 提炼的设计原则

1. **职能不重复**：同一职能（导航/定位/回退）在同一视口内只应有一个承载元素。两个元素做同一件事，用户要学两遍，维护者要改两处。
2. **状态优于元素**：同一组件的不同视觉状态（expanded/condensed）用 class 切换，比"隐藏 A、显示 B"的双元素方案更可维护——DOM 结构不变，只有样式变化。
3. **行为变更最小化**：只修有问题的场景（首页），不顺手改其他页面的行为。非首页的 topbar 保持 expanded，留待后续讨论。
