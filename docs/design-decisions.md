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

---

## 2026-08-14 · Hero → Header 液态形变（eva-blog）

### 组件

`HomeHero` + `SiteHeader` + `useHeroMorph`（apps/eva-blog）

### 问题

首页首屏需要同时承担"品牌宣言"和"导航入口"两个职能。旧方案把导航藏在 header 里，首屏只有大标题和 CTA，用户不知道页面还有更多内容，也不知道导航在哪。

初版 FLIP 方案（两个元素 + 85% 处离散切换）被否决：前后组件变化明显，没有"一体化"感。用户要求"首屏和后续的 header 在用户视角来看几乎是同一个元素"，需要 liquid 渐变。

### 决策

**单个 flying artwork 连续形变**，而非两个元素 + 离散切换：

- 一个 `motion.img`（`.flying-artwork`）从 hero 位置连续形变到 header brand 位置
- 基于 Framer Motion 的 `useScroll` + `useTransform`，每帧更新 motion value，无 React 重渲染
- 所有 artwork 属性（x/y/scaleX/scaleY/opacity/borderRadius）使用 `easeOutCubic` 缓动——100vw→40px 是 50 倍缩放，线性插值在中段仍然太大
- y 轴在起点抵消滚动（`-scrollY * (1 - p)`），在终点固定在 header（`brand.y * p`）
- header 整体渐入（70%~100% opacity），非 `visibility` 离散切换
- hero 文字随滚动淡出，tabs 在前 30% 快速淡出
- 测量在 `useLayoutEffect` 中一次性完成（hero 和 brand slot 的 `getBoundingClientRect`），在任何 transform 之前
- `transform-origin: top left` 确保 translate 定位的是左上角
- 非首页路由：brand slot 内渲染静态 `<img class="brand-mark">`，flying artwork 不挂载
- 8 秒无操作自动滚动一屏，用户滚动/触摸/按键取消

### 提炼的设计原则

1. **同一元素优于两个元素**：liquid 动画的关键是让用户感知到"同一个元素在变化"，而不是"元素 A 消失、元素 B 出现"。单个 flying artwork 从 hero 连续形变到 header，比两个元素 + 离散切换更自然。
2. **测量在变换之前**：FLIP 动画的基准位置必须在任何 transform 施加之前测量并缓存。在已变换的元素上重复测量会导致位置漂移。
3. **缓动函数匹配缩放比例**：50 倍缩放（100vw→40px）不能用线性插值——中段仍然太大。`easeOutCubic` 让缩小先快后慢，视觉上更自然。
4. **transform-origin 决定定位语义**：`top left` 让 translate 定位的是左上角，数学上更直观；默认 `50% 50%` 会导致位置偏移。
5. **渐进揭示优于一次性展示**：8 秒超时自动滚动是"用户不知道可以滚"的兜底，而非替代。用户主动滚动后立即取消，尊重用户意图。

---

## 2026-08-14 · Tab 飞行路径 + Artwork 裁剪与层级（eva-blog）

### 组件

`useHeroMorph`（tab flight 部分）+ `.flying-artwork-wrapper` / `.flying-artwork` / `.flying-tab`（apps/eva-blog）

### 问题

用户提出 4 个问题：

1. **窄屏 i18n 按钮换行**：560px 以下 `.topbar` 三列布局挤压，语言切换按钮被挤到第二行
2. **Flying artwork z-index 过高**：即使透明也遮挡 hero 文字，影响观感
3. **Artwork 形变到 brand 时完全展示**：40×40 的 brand 槽里塞整张 100vw 构图，比例和构成都不合适
4. **Tabs 没有 FLIP 到最终位置**：hero tabs 直接淡出，没有飞到 header nav 的过程

### 决策

**1. 窄屏响应式**

- 560px 以下 `.topbar` 改为 `grid-template-columns: auto 1fr`，`.topbar-tools` 用 `justify-self: end`
- i18n 按钮始终单行，不换行

**2. Artwork 层级**

- z-index 从 10 降到 0（hero 状态在最底层），40% 滚动后升到 6（header 状态在内容之上）
- 通过 `useTransform` 每帧计算，无 React 重渲染

**3. Artwork 裁剪**

- wrapper（`.flying-artwork-wrapper`）负责位置/尺寸/裁剪（`overflow: hidden`）
- 内层 img（`.flying-artwork`）负责缩放（`scale: 1 → 2.2`），`transform-origin: center`
- 形变到 brand 时只显示中心区域，构图更适合小尺寸

**4. Tab 飞行路径**

- 每个 tab 沿**二次贝塞尔曲线**从 hero 位置飞到 header nav 位置
- 路径函数：`B(t) = (1-t)²·P0 + 2(1-t)t·C + t²·P3`，控制点 C 为中点法向偏移
- 4 个 tab 的弧高系数递增（0.15 / 0.3 / 0.45 / 0.6），形成"扇形投掷"效果
- 位置用 `easeOutExpo`（快出慢入），缩放用 `easeOutBack`（过冲"咔哒"到位）
- 透明度在 50%~78% 滚动区间淡出，与 header 淡入衔接
- y 轴在起点抵消滚动（`-scrollY * (1-p)`），在终点固定在 header

### 提炼的设计原则

1. **函数即设计**：贝塞尔曲线 + 缓动函数的组合不是"技术实现"，而是设计语言。弧高系数和缓动曲线决定了动画的"性格"——扇形投掷比直线飞行更有个性。
2. **层级服务于叙事**：z-index 不是静态属性，而是叙事工具。hero 状态 artwork 在底层（文字优先），header 状态 artwork 在上层（品牌优先），层级切换本身就是形变的一部分。
3. **裁剪即构图**：小尺寸 brand 不应该是大图的缩小版，而应该是大图的"精选局部"。wrapper 裁剪 + 内层缩放让 brand 成为构图的中心焦点。
4. **响应式是布局问题，不是缩放问题**：窄屏不应该靠"缩小一切"解决，而应该重新组织布局（grid 列数、对齐方式），让每个元素在可用空间内保持可读。

---

## 2026-08-15 · Canvas 背景形变 + 可点击飞行 Tab + 时间线编排（eva-blog）

### 组件

`useHeroMorph`（Canvas 绘制部分）+ `.artwork-canvas` + `.flying-tab`（apps/eva-blog）

### 问题

用户提出 3 个问题：

1. **背景整体性不够**：FLIP 动画过程中有明显边界感，"可以看出是一张图片在移动，而不是一个动画的过程"。`<img>` 元素的硬矩形边缘在缩小过程中与页面背景形成对比，破坏了视觉连续性。
2. **Tab 移动过程中不可点击**：`.flying-tab` 有 `pointer-events: none`，飞行中无法交互。
3. **形变过程中排版不合理**：hero 文字淡出太慢（0-50%），与 artwork 形变重叠，中间状态出现半透明文字 + 半缩小 artwork 的"未完成"感。

### 决策

**1. Canvas 替代 `<img>` 元素**

- 用 `<canvas>`（`position: fixed; inset: 0`）替代 flying `<img>`，通过 `drawImage` 每帧绘制
- **软边羽化**：`destination-out` + 4 条线性渐变擦除边缘，feather 从 80px（hero 状态）线性减到 0（brand 状态）
- 边缘与页面背景自然融合，消除"图片在移动"的边界感
- 内部缩放（zoom 1 → 2.2）保持 brand 状态的中心裁剪构图
- 圆角矩形 clip + `border-radius: 4px`（brand 状态）

**2. 飞行中可点击的 Tab**

- 移除 `.flying-tab` 的 `pointer-events: none`
- 新增 `pointerEvents` motion value：可见时 `auto`，淡出后（>78% 视口高度）`none`
- 原始 `.hero-tabs`（布局占位）加 `pointer-events: none` 防止误触

**3. 时间线编排：每一帧都是合理构图**

| 阶段 | 视口高度占比 | 发生什么 |
|------|-------------|---------|
| Hero 出发 | 0% – 12% | hero 文字快速淡出 |
| 视觉聚焦 | 12% – 25% | artwork 独自形变，屏幕干净 |
| Tab 飞行 | 25% – 65% | tabs 沿贝塞尔曲线飞行，artwork 继续形变 |
| 组装 | 65% – 78% | tabs 到达 nav 并淡出，header 开始淡入 |
| Header 完成 | 78% – 85% | header 完全可见，artwork 到达 brand 位置 |

- hero 文字在前 12% 视口高度内淡出（~108px @900px），避免半透明文字的"未完成"感
- tabs 在 25% 才开始飞行（文字已消失），65% 到达（header 刚开始淡入）
- header 在 65%–85% 淡入，与 tabs 淡出无缝衔接

### 提炼的设计原则

1. **边缘即体验**：动画元素的硬边缘是"物体感"的来源。软边羽化让元素从"一张图片"变成"一片视觉区域"，形变从"移动"变成"聚焦"。
2. **时间线即构图**：滚动动画的每一帧都应该是一个"完成态"而非"过渡态"。快速淡出文字、错开元素动画的起止时间，让任何暂停位置都看起来是有意为之的设计。
3. **交互不中断**：动画中的元素如果语义上是可交互的（导航链接），就不应该用 `pointer-events: none` 禁用。用 motion value 动态控制，在元素不可见时才禁用。

---

## 2026-08-15 · Chroma Key 抠像 + 交叉淡化 + 字体重测量（eva-blog）

### 组件

`useHeroMorph`（Canvas 预处理 + 交叉淡化 + 字体重测量）+ `.artwork-canvas` + `.hero-copy`（apps/eva-blog）

### 问题

用户提出 3 个问题：

1. **Hero 文字消失太突兀**：文字在 0-12% 内纯透明度淡出，没有位移或缩放，"没有结合中间动画过程中进行排版的变化以及渐变的消失"
2. **背景色不一致**：artwork 自带暖色渐变背景（rgb(249,226,206)→rgb(235,226,245)），页面是冷色蓝灰背景（oklch(0.985 0.012 242)），动画过程中"显示出明显的因为缺移动的现象，而不是其中只有图案在变化和移动"
3. **末帧与 Header 差异大**：Canvas 末帧绘制的 artwork 与 header 中 `brand-mark` 的 `object-fit: cover` 不一致，"前后的两帧之间存在明显的差异"

另外发现两个实现 bug：

4. **Canvas opacity/z-index 未生效**：`<canvas>` 是普通 HTML 元素，Framer Motion 的 motion value 无法绑定，导致交叉淡化和层级切换完全失效
5. **字体加载导致 tab 位置偏移**：`useLayoutEffect` 在自定义字体（Unbounded 等）加载前测量，字体加载后 tab 尺寸和位置变化，flying tabs 与原始 tabs 偏移 98px

### 决策

**1. Hero 文字渐隐 + 位移 + 缩放**

- 淡出区间从 0-12% 扩大到 0-25%，给视觉过渡更多时间
- 新增 `y: 0 → -30px`（上移）和 `scale: 1 → 0.95`（微缩），`transform-origin: top left`
- 文字不是"消失"，而是"退场"——有方向、有速度、有姿态

**2. 渐变背景 Chroma Key 抠像**

- 预处理：采样 artwork 四角颜色，构建双线性插值渐变背景模型
- 每个像素与期望背景色计算欧氏距离，<threshold(28) 完全透明，<2×threshold 线性过渡（抗锯齿）
- 只保留图形元素（蓝圈、青环、红点、线条），与页面冷色背景自然融合
- 预处理在离屏 canvas 完成一次，运行时每帧 `drawImage` 处理后的 canvas

**3. 末帧对齐：coverDraw + 内容区测量 + 交叉淡化**

- `coverDraw()` 函数：Canvas 版 `object-fit: cover`，保持宽高比、居中裁剪
- brand slot 测量改为**内容区**（去除 border），与 `brand-mark` 的 `object-fit: cover` 对齐
- Canvas 在 65%-85% 滚动区间 opacity 1→0，header 同时 0→1，交叉淡化
- `brand-mark` 始终渲染（不再 `!isHome` 条件渲染），交叉淡化时两者短暂重叠

**4. `<canvas>` → `<motion.canvas>`**

- Framer Motion 的 motion value 只能绑定到 `motion.*` 组件
- 普通 HTML 元素的 `style` prop 接收 motion value 不会生效

**5. 字体加载后重新测量**

- `useLayoutEffect` 在字体加载前运行，测量基于 fallback 字体
- 新增 `useEffect` 监听 `document.fonts.ready`，字体加载完成后重新测量所有位置
- 不重新 `setMeasured`（避免闪烁），只更新 `measurementsRef.current`

### 提炼的设计原则

1. **退场也是设计**：元素的消失不应该是"透明度归零"，而应该是"有方向的退场"。位移 + 缩放 + 透明度的组合让消失本身成为动画的一部分。
2. **背景即画布**：当动画元素的背景与页面背景不一致时，不要"移动一个色块"，而要"只移动图形"。Chroma key 抠像让元素从"图片"变成"图形的集合"。
3. **末帧即首帧**：动画的最后一帧必须与目标状态的第一帧完全一致。`object-fit: cover` 的 Canvas 等价实现 + 内容区测量 + 交叉淡化，确保用户感知不到"两个元素的交接"。
4. **Motion value 需要 motion 组件**：Framer Motion 的 `useTransform` 返回的 motion value 只能绑定到 `motion.*` 组件，普通 HTML 元素不会生效。
5. **字体是布局的一部分**：自定义字体加载会改变元素尺寸和位置。涉及位置测量的动画必须在字体加载后重新测量，否则会出现偏移。
