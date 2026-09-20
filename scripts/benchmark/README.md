# 地形瓦片渲染量化基准测试

把「糊斑 / 不刷新 / 空洞 / 卡顿」这类**主观观感**翻译成图层内部可计算的**硬指标**，按固定场景跑一遍，
自动输出「实测 vs 期望 vs 基线」差异表。目的是：问题可复现、可量化、可回归、可快速定位。

## 快速开始

```bash
npm run dev                 # 先起 dev server（默认 12345）
npm run benchmark           # 跑全部场景（约 6 分钟）
npm run benchmark:baseline  # 把当前结果写成新基线
```

常用参数：

```bash
node scripts/benchmark/run.cjs --scenarios=pan-near,rotate   # 只跑部分场景
node scripts/benchmark/run.cjs --url=http://localhost:12345/examples/cesium-terrain/other/
node scripts/benchmark/run.cjs --spec=path/to/other-spec.json
```

退出码：`0` = 全部期望通过；`1` = 有指标越界（可直接用于 CI / 提交前自检）。

## 产物

- `artifacts/benchmark/<时间戳>/report.md`　报告（表格 + 期望比对 + 失败项）
- `artifacts/benchmark/<时间戳>/report.json`　机器可读的完整数据（含每个采样点的明细）
- `artifacts/benchmark/<时间戳>/*.png`　每个操作步骤后的截图
- `artifacts/benchmark/latest.md`　最近一次报告副本
- `scripts/benchmark/baseline.json`　基线（用于「变化」列）

## 指标（都取自图层内部状态，不依赖肉眼）

| 指标 | 含义 | 方向 |
|---|---|---|
| `blurRatioPeak` | 屏幕网格中由「影像分辨率不足/无覆盖」瓦片顶着的点占比**峰值**。交互刚结束的瞬时糊斑是「先粗后细」策略的正常代价，**只观测不设阈值** | 越低越好 |
| `blurRatioFinal` | 收敛后的糊斑占比 —— **真正的验收标准** | 越低越好 |
| `uncoveredRatioFinal` | 收敛后完全没有已就绪瓦片覆盖的屏幕点占比（永久空洞） | 越低越好 |
| `dangerCoarse` | 可见、写深度、且比该视野最细就绪瓦片更粗的瓦片数（会从上方糊住清晰地形的「架空弦」） | 越低越好 |
| `settleSeconds` | 最后一次操作后，队列 / 在途请求 / 候场全部排空且糊斑清零所需时间 | 越低越好 |
| `dupTileRatio` | 同一瓦片 URL 重复请求占比（0 = 无浪费） | 越低越好 |
| `fpsMin` | 记录到的最低帧率（headless 软件渲染下偏低，仅观测） | 越高越好 |
| `interactingStuck` | `cameraInteracting` 为真但相机静止的采样次数（手势标志卡死检测） | 恒为 0 |

### 「糊斑占比」怎么算的

对屏幕做 32×20 网格采样，每个网格点找出**覆盖它且最细**的可见瓦片（等价于「精细瓦片后绘制、粗瓦片不写深度」的观感），
再比较该瓦片的**屏幕投影像素尺寸**与它的**影像纹理边长**：

```
像素/纹素比 = 投影像素数 ÷ 纹理边长
```

- `<= sharpPixelRatio`（默认 1.5） → 该点判为「清晰」
- `> 1.5` → 判为「糊」（纹理被放大，屏幕上就是模糊的）
- 无任何瓦片覆盖 → 计入「空洞」

即：**糊斑占比 = 屏幕上多少比例的面积，其影像分辨率已经撑不住当前屏幕尺寸。**

## 指标签名 → 病因速查

出现问题时，先看报告里哪个指标越界，再看该场景的采样明细（`report.json` 的 `checkpoints`，含 `visZoom`、`blurSamples`）：

| 签名 | 指向的机制 | 常见修复方向 |
|---|---|---|
| `blurRatioFinal` 高 + `uncoveredRatioFinal` 高 | 遍历/可见集缺瓦片：某区域根本没被选中 | 检查视野剪枝（AABB 预剪枝余量）、遍历优先级（best-first）、`maxTilesPerView` 预算 |
| `blurRatioFinal` 高 + `uncoveredRatioFinal` 低 | 瓦片被选中且已就绪，但**被更粗的瓦片盖住** | 检查 `coveredAncestors` / `depthWrite` 遮挡剔除链 |
| `dangerCoarse` > 0 | 粗瓦片「架空弦」赢了深度测试 | 祖先标记是否漏了视野外子树；`hideCoveredAncestors` 的判定 |
| 糊斑长时间不消 + 网络无在途请求 | 管线「自洽地」无事可做：目标层级被压死（如 `cameraInteracting` 卡死）或请求挂起 | 手势标志看门狗；请求超时兜底 |
| `settleSeconds` 触顶 + `stitchPending` 长期不清零 | 拼接队列积压（画布过大 / 子请求过多） | 手势期压低画布与目标层级；`maxRequestsPerFrame` |
| `dupTileRatio` 高 | 同一瓦片被反复请求（换代抖动 / 缓存未命中） | `imgCache` / `tileCache` 容量与换代滞回 |
| `interactingStuck` > 0 | 手势标志卡死 | 看门狗（相机静止超时自动解除） |
| 上屏瓦片远小于 256×256（见 `diag-tiny-tiles.cjs`，看「细长条」行：等效边长 = sqrt(可见面积)，只看最长边会把 1066x41 这类压扁条漏掉） | 细分判据 `pixelSize` 是**未裁剪**投影：瓦片大部分在画面外、只有一条缝入画时仍会被细分到底；叠加 `estimateTileSurfaceHeight` 把后代高程也算进来，形成「加载越多→高度越高→px 越大→越细分」正反馈，同一瓦片同一相机的 px 可差 6 倍 → 判据抖动 | 已修：①高度估计只认自身/最近已加载祖先（顺带 O(N)→O(层级)）；②细分前加「可见尺寸护栏」：裁剪到视口后的**短边** ≤ `terrainTilePixelSize` 就不再细分 |
| 整屏退化成 minZoom 马赛克（正选集只剩一两块巨瓦） | 可见尺寸护栏**误用了长边**做条件：远景下整屏被一块比屏幕大得多的瓦片盖住，可见长边被视口饱和截断（永远 < 2×目标值），长边条件恒不满足 → 从 minZoom 起就不再细分 | 长边不可用作条件；只用**短边**（"这条瓦片在屏幕上有多厚"，不受饱和影响）。另可用 `traversalDebug.guardBlocked/guardBlockSamples` 直接看护栏拦了谁 |
| rotate 糊斑 0→34%（护栏上线后） | 护栏拦掉的叶子会走 `resolveAvailableAncestor` 解析成粗祖先，与旁边细瓦片形成 LOD 拼花——但根因是当时高度估计还在抖（px 同相机差 6 倍），护栏的拦截对象随机化 | 先修高度估计（消除抖动），护栏才可控；每次动细分判据必须跑全量基准 + `diag-tiny-tiles.cjs` 双验证 |

## 场景与阈值

场景定义在 `spec.json`。每个场景 = 一串操作 + 一组期望：

```jsonc
{
  "id": "pan-near",
  "title": "朝相机近端平移 3 轮",
  "steps": [
    { "op": "zoomIn", "steps": 13, "intervalMs": 250 },
    { "op": "tilt", "steps": 6, "dy": -50 },
    { "op": "pan", "dir": "near", "rounds": 3, "dy": 120 },   // 每轮之间会自动采样
    { "op": "settle" }                                        // 等收敛并记录 settleSeconds
  ],
  "expect": {
    "blurRatioFinal": { "max": 0.03 },   // max = 不得超过；min = 不得低于
    "dangerCoarse": { "max": 0 },
    "settleSeconds": { "max": 45 }
  }
}
```

支持的操作原语：

| op | 参数 | 说明 |
|---|---|---|
| `zoomIn` / `zoomOut` | `steps`, `intervalMs` | 滚轮缩放 |
| `tilt` | `steps`, `dy` | 左键拖拽压低/抬起视角（`dy` 负值 = 压低） |
| `rotate` | `rounds`, `dx` | 水平转动，左右交替（每轮之间采样） |
| `pan` | `dir: "near"\|"far"`, `rounds`, `dy` | 右键拖拽平移（`near` = 朝相机近端，每轮之间采样） |
| `settle` | — | 等队列/请求/候场排空且糊斑清零，记录耗时 |

## 层级着色验证模式（debugColors）

把影像**整体关掉**，瓦片按层级着纯色：**色相 = 层级，明度 = 瓦片个体**。
这是「糊斑占比」指标的肉眼看图版——截图里同色 = 同层级，出现粗层级色块即说明该区域的精细瓦片没被选中或没上屏。

```bash
# 打开即用（叠加 ?wireframe=1 可同时看三角网）
http://localhost:12345/examples/cesium-terrain/fullscreen/?debugColors=1
node scripts/diag-debug-colors.cjs        # 自动化断言 + 分阶段截图
```

- 因为**不请求、不拼接任何影像**，地形网格一就绪即上屏，验证「瓦片选择对不对」的速度远快于看真实影像；
- 页面左下角有实时图例，三个数字刻意分开，避免误读：
  - **正选** = 本帧 LOD 集里的瓦片（含仍在加载的）；
  - **兜底** = 已加载且可见、但**不在** LOD 集的瓦片：底图毯与粗祖先。它们刻意常驻（请求不取消、不 fade-out）且 `depthWrite=false`，**只在精细瓦片覆盖不到的像素显色**——所以「兜底」数大 ≠ 画面糊，「上屏 > 正选」也不是漏瓦片；
  - **上屏** = 实际提交绘制的瓦片数。
- 同层级相邻瓦片有轻微明度抖动（±4%），能数出「这一层铺了几块瓦片」；
- 运行时也可用控制台切换：`__terrainDebug.setDebugColorMode(true/false)`、`__terrainDebug.getZoomColorLegend()`；
- 退出该模式后自动按当前目标层级补拉影像（1~2 秒内恢复）。

### 层级配色规则（改色值必须遵守）

1. **任意两级颜色距离 ≥ 60**（RGB 欧氏）。当前表最小间距 **69.9**（z11 vs z13，两个招牌色，保留），仅此一对低于 70。
   历史教训：旧表里 **z6 与 z16 是同一个色值**（距离 0），另有 27 对距离 <90 —— 截图里的碎色块因此无法反查层级，判定只能靠猜。
2. **避开背景色 `0x1a1a1a` 与无影像兜底色 `0x6f786f`**（否则背景/兜底像素会被误判成某层级）。
3. 明度抖动固定 **-4% / 0 / +4%** 三档：抖动造成的 RGB 位移（≤18）必须远小于色表最小间距，否则反查会串级。
4. 非生产环境启动时会自检并 `console.warn` 过近的色对；`diag-debug-colors.cjs` 里的断言会校验最小间距 ≥60。

层级配色速记（z9~z15、z18 为招牌色，其余由约束搜索分配；完整表见 `CesiumTerrainLayer.DEBUG_ZOOM_COLORS` 与页面图例）：

| 层级 | 颜色 | 层级 | 颜色 | 层级 | 颜色 |
|---|---|---|---|---|---|
| z9 | 蓝 | z12 | 红 | z15 | 青 |
| z10 | 绿 | z13 | 橙 | z18 | 黄绿 |
| z11 | 黄 | z14 | 粉 | 其余 | 见页面图例 |

典型读图：拉近后应看到颜色**由粗变细**（蓝→黄→红→橙→粉→青…）；若某区域停留在粗层级颜色不动，
对照上面「指标签名 → 病因速查」表排查。

### 两把「判定」用的工具

```bash
# 1) 像素归属归因（需 ?debugColors=1）：对屏幕网格采样，用瓦片真实网格顶点的屏幕凸包
#    判断每点的实际绘制者，并与该点最细的"正选"瓦片对比，输出六类归因：
#    normal / geom(精细就绪却被压住) / loading(精细在路上) / unselected(无正选覆盖,兜底显色) / hole / finer
node scripts/diag-crest-slivers.cjs

# 2) 截图反查层级：直接解码 PNG，把每个像素颜色映射回层级，输出占比、位置分布、
#    ASCII 层级图、以及"与周边中位层级差≥2级"的碎块簇（比周边更粗=糊/越界候选）
node scripts/analyze-shot-colors.cjs <截图.png> [--palette=old]   # 旧色表截图加 --palette=old

# 3) 小瓦片测量：统计每个上屏瓦片的屏幕可见足迹，输出 <160px 小瓦片的数量/占比/层级分布
#    （复现"拖动过程中有些瓦块比 256*256 小了很多"）
node scripts/diag-tiny-tiles.cjs        # TINY_PX=180 可改阈值；中途/静置各测一轮

# 4) 细分判据归因：复现 rotate 流程后，逐个列出可见瓦片的
#    px/vis/sse/containsCamera/可用性/guard 判定 + 右下象限绘制者统计。
#    把 visibleGuard 临时置 true/false 各跑一次即可做 A/B 对比（输出存 artifacts/guard-*.txt）
node scripts/diag-rotate-guard.cjs
```

判读要点：

- 碎块**集中在屏幕最上缘**（远景地平线带）→ 远处本来就该粗，正常；
- 碎块比周边**更细**（精细瓦片的小岛）→ LOD 过渡的碎块化，通常不是缺陷；
- 碎块比周边**更粗且位于画面内部** → 粗瓦片越界/糊，需按「指标签名」表排查（多数是底图毯/粗祖先兜底在精细瓦片缺位处显色）。

## 已知局限

- **起点固定**：所有场景都从示例页默认视角出发。用户手动导航到的特定地形（如某座山）目前无法直接复现——需要时给示例页加中心/高度 URL 参数，或在 `spec.json` 里扩展 `zoomIn`/`tilt` 步数组合逼近。
- **模糊判定用几何近似**：屏幕覆盖率由瓦片包围盒投影的屏幕矩形近似（真实瓦片在透视下是四边形），因此边界点存在少量误差；由于所有运行用同一套近似，**回归比对仍然可靠**。
- **FPS 仅供参考**：headless SwiftShader 下的帧率远低于真实 GPU，不作为验收项。

## 维护约定

1. **改引擎后跑一次**：`npm run benchmark`，全 PASS 再提交；若某项确实变差，先判断是「行为变了」还是「回归了」。
2. **阈值只收紧不放宽**：确有意外的更优结果时，用 `npm run benchmark:baseline` 更新基线（报告里的「变化」列会立刻反映差异）。
3. **加新场景**：优先覆盖**曾经出过问题的操作路径**（出过的 bug 就是最好的测试用例）。新增场景后先用 `--update-baseline` 建立基线。
4. **headless 环境说明**：本测试跑在 SwiftShader 软件渲染下，FPS 数值偏低是正常的，所以 `fpsMin` 只观测、不设阈值；时间类指标（`settleSeconds`）在真实 GPU 上会更快，阈值留了充足余量。
