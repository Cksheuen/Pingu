# Design Decisions

## Round 4: Hero Morph 深度重构（2026-08-15）

### 问题

1. **Tab 样式突变**：flying tabs 用 Unbounded 600 大字，header nav 用 Fragment Mono 小字——字体完全不同，交叉时样式跳变
2. **Title 缺少分层动画**：所有文字在一个容器里整体淡出，没有层次感
3. **背景像素降低**：SVG 被光栅化到 900×640 离屏 canvas 再 chroma key，损失矢量质量
4. **背景内容不实时**：artwork 是静态图片的位移/缩放，SVG 元素没有随滚动独立动画

### 决策

#### 1. Tab 样式统一为 Fragment Mono

**选择**：统一用一种字体，消除字体差异。

**理由**：
- 两种字体（Unbounded vs Fragment Mono）的字形宽度、x-height、字重完全不同，交叉淡化时视觉跳变明显
- Fragment Mono 是等宽字体，字符宽度固定，飞行过程中不会因字宽变化产生抖动
- 与 header nav 保持一致，终态无差异

**实现**：
- `.flying-tab` 和 `.hero-tabs` 改为 Fragment Mono
- 字号从 `clamp(1rem, 2vw, 1.4rem)` 动画到 `0.66rem`
- 字距从 `0` 动画到 `0.06em`
- 颜色从 `var(--ink)` 动画到 `var(--on-dark-soft)`（用 framer-motion 的 `mix()` 插值 oklch 颜色）

#### 2. 背景元素始终可见，仅位移动画

**选择**：元素始终可见，只做位移/缩放，不做渐进绘制。

**理由**：
- 渐进绘制（draw-in）会让背景在滚动初期"不完整"，与 hero 状态不一致
- 用户期望背景是"活的"——元素随滚动有生命感，但不是"正在画出来"
- 位移动画更符合 liquid morph 的语义：整个场景在流动，而不是在被绘制

**实现**：
- 每个元素有独立的 `elementState(spec, s)`，返回 `dx, dy, scale, march, travelT`
- 所有位移用 `sin(s·π)` 包络，s=0 和 s=1 时归零，保证终态与静态 brand-mark 一致
- 虚线曲线有 `march`（虚线行进），红色圆点沿轨道曲线滑行（`ridePosition`）

#### 3. Title 分层错峰淡出

**选择**：每个元素有独立的淡出时间窗口和位移量，形成级联。

**理由**：
- 整体淡出太"平"，没有层次感
- 错峰淡出让视线有引导：先看 eyebrow，再看 h1，最后看 actions
- 与背景的位移动画形成节奏对比

**实现**：
- 5 个元素：eyebrow → h1 第一行 → h1 em 第二行 → intro → actions
- 时间窗口：0%-12%, 5%-18%, 8%-22%, 12%-26%, 16%-30%（视口高度占比）
- 每个元素有独立的 y 位移和 scale 变化

#### 4. SVG 矢量渲染替代光栅化

**选择**：解析 SVG DOM，用 Canvas 2D API 直接绘制矢量元素。

**理由**：
- 光栅化到固定尺寸（900×640）再缩放会损失清晰度
- 矢量绘制在任意 DPR 下保持清晰
- 可以逐元素控制动画（位移、缩放、虚线行进）

**实现**：
- `parseSvg(svgText)` 用 DOMParser 解析，提取元素列表
- `prepareScene(scene)` 预计算路径长度、Path2D、滑行采样点
- `renderScene(ctx, scene, state, dest)` 用 Canvas 2D API 绘制
- `coverTransform()` 实现 object-fit: cover 的数学等价

### 验证

- 22 个单元测试通过（含 9 个 orbit-scene 测试）
- 构建成功
- 6 项 smoke 测试通过
- Playwright 截图验证 0%-100% 滚动过程

### 相关文件

- `src/lib/svgRenderer.js`：SVG 解析 + Canvas 2D 矢量渲染
- `src/hooks/useHeroMorph.js`：滚动驱动动画状态
- `src/components/HomeHero.jsx`：分层标题
- `src/App.jsx`：flying tabs 绑定
- `src/styles.css`：Fragment Mono 统一样式

## Round 5: Tab 样式以首屏为主 + 文字连续布局 + Canvas 数学曲线（2026-08-15）

### 问题

1. **Tab 样式以 header 为主（太小）**：tab 从首屏的 `clamp(0.85rem, 1.5vw, 1.05rem)` 缩小到 header nav 的 `0.66rem`，用户希望以首屏样式为主
2. **文字一下滑就消失**：文字在 0-25% vh 内就完全淡出，用户希望文字在整个下滑过程中不断变化布局和效果
3. **Canvas 动画元素太少**：只有 7 类简单动画，用户希望增加有趣的数学函数曲线，完全用 Canvas 实现

### 决策

#### 1. Tab 样式以首屏为主

**选择**：让 header nav 的字号与首屏 tab 一致，消除字号差异。

**理由**：
- 字号差异是 tab 飞行中最明显的视觉跳变
- 统一字号后，飞行中只有颜色变化（`--ink` → `--on-dark-soft`），过渡更自然
- 首屏大字号在 header 中仍然可读，且与首屏 tab 形成视觉延续

**实现**：
- `.public-nav` 的 `font-size` 从 `0.66rem` 改为 `clamp(0.85rem, 1.5vw, 1.05rem)`
- `.public-nav a` 的 `padding-block` 从 `8px` 改为 `4px 0`（与首屏 tab 的 `padding-bottom: 4px` 对齐）
- `useTabFlight` 中的字号插值变为 no-op（两端相同），tab 在飞行过程中保持首屏大字号

#### 2. 文字连续布局变化

**选择**：用连续函数替代离散淡出窗口，文字在整个下滑过程中不断变化布局。

**理由**：
- 离散淡出（0-25% vh 内消失）让文字"一下滑就没了"，缺乏过渡
- 连续布局变化让文字在整个下滑过程中都有视觉存在感，更符合 liquid morph 的语义
- 滚动对抗（scroll counteraction）让文字在初期钉在视口，逐渐释放，形成"液体"感

**实现**：
- 统一进度变量：`s = clamp01(scroll / (vh * 0.85))`，与 Canvas 进度一致
- 滚动对抗：`y = -scroll * hold(s) + drift(s)`，其中 `hold(s) = 1 - smoothstep(s, 0.25, 0.65)`
  - 前 25% 完全对抗滚动（文字钉在视口）
  - 25-65% 逐渐释放
  - 65%+ 完全释放（文字跟随滚动）
- 5 个元素各有 5-6 个连续属性，全部用 `smoothstep(s, a, b)` 控制：
  - eyebrow：字距从 0.09em 扩散到 0.31em，微旋 -1.5°，右移 20px
  - h1 第一行：字号微缩 5%，字距微扩
  - h1 第二行：右移 32px 产生错位排版，字号微缩 5%
  - intro：左移 16px，字距微扩
  - actions：右移 24px，微旋 -1.5°
- 所有元素的 opacity 在 s=0.3-0.6 之间连续淡出
- 文字可见时间从 0-7.5% vh 提升到 0-42% vh（完全可见）+ 42-82% vh（在 canvas 后方逐渐溶解）

#### 3. Canvas 数学曲线

**选择**：新增 4 种数学曲线，完全用 Canvas 2D 实现，与现有 SVG 场景共享 cover 变换和圆角裁剪。

**理由**：
- 现有 7 类动画元素（背景、虚线、实线、红点、青环、蓝点、文字）太少，缺乏视觉丰富度
- 数学曲线（Harmonograph、Lissajous、FlowField、Archimedean）有天然的美感和有机感
- 完全用 Canvas 实现避免 SVG 的性能开销，且与现有矢量渲染管线一致

**实现**：
- 新增 `src/lib/mathCurves.ts` 模块，4 种曲线：
  - **Harmonograph**：阻尼简谐运动合成，4 频率微失谐，500 点预计算，从尾部开始消失
  - **Lissajous**：3:4 频率比，相位随 s 漂移，300 点实时计算，虚线样式，t 范围逐渐缩小
  - **FlowField**：64 粒子沿 sin/cos 流场运动，64×120 步预计算，粒子数逐渐减少
  - **Archimedean 螺线**：r = a + b·θ，2 圈，200 点预计算，从尾部开始消失
- 统一包络：`env(s) = 1 - smoothstep(s, 0.7, 0.95)`
  - s=0 时全部可见，s=1 时全部消失
  - 各曲线有自己的消失时间窗口，形成"由多到少"的效果
  - 曲线在 `renderScene` 之后绘制，共享圆角裁剪和 cover 变换
- 性能：预计算 + 折线批量绘制 + 包络早退，每帧 <1ms
- Reduced motion 时 s=1，曲线完全隐藏

#### 4. Brand mark 简化

**选择**：终态只保留核心元素（青色环 + 蓝点 + 背景），其余元素在滚动过程中消失。

**理由**：
- 40×40 的 brand mark 不适合展示复杂内容
- 虚线、红点、文字在小尺寸下不可读
- 简化后的 brand mark 更清晰、更有辨识度

**实现**：
- 虚线曲线：s=0.1 到 s=0.5 逐渐消失
- 实线轨道：s=0.2 到 s=0.6 逐渐消失
- 红色标记点：s=0.2 到 s=0.6 逐渐消失
- 文字标签：s=0.3 到 s=0.7 逐渐消失
- 终态只保留：背景、青色环、蓝色点

### 验证

- 32 个单元测试通过（含 8 个 mathCurves 测试）
- 构建成功
- 6 项 smoke 测试通过
- Playwright 截图验证 0%-85% 滚动过程
- Reduced motion 截图验证

### 相关文件

- `src/lib/mathCurves.ts`：数学曲线模块
- `src/lib/svgRenderer.ts`：SVG 解析 + Canvas 2D 矢量渲染
- `src/hooks/useHeroMorph.ts`：滚动驱动动画状态 + 连续文字动画
- `src/components/HomeHero.tsx`：绑定新属性（x, letterSpacing, rotate）
- `src/styles.css`：nav 字号与首屏 tab 一致
