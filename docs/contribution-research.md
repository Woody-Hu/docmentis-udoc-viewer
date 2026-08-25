# udoc-viewer 贡献方向调研与提案

> 说明：本文档用于内部讨论，并附带可直接提交到 GitHub 的 issue 草稿（英文）。
> 状态：调研完成，待你决定是否据此发起 issue / PR。

---

## 0. 一句话结论

这个项目的**渲染引擎（WASM）闭源**，开源贡献点全在 **JS/TS 层**。当前环境（Node 24 + vitest，可本地跑构建/单测）能实际落地、且对项目有价值的最优切入点是——**补齐被 CI 遗漏的测试能力并扩充核心纯函数单测**，其次是**精确修复 Headless 模式下注释编辑 API 的可用性（TODO#2）**。

---

## 1. 项目现状与更新方向（背景）

技术形态：

- **闭源 WASM 引擎**：`packages/udoc-viewer/src/wasm/` 为预编译二进制，来自私有库 `docmentis-udoc`，外部不可改。
- **开源 MIT 层**：全部 TS 源码、`ui/`、`worker/`、demo、examples、WordPress 插件、文档。

近期更新主线（来自 `CHANGELOG.md` 0.6.x 趋势）：

1. 格式覆盖扩张：PDF → DOCX → PPTX → XLSX → SVG → WMF/EMF → SmartArt/图表。
2. 渲染高保真（核心卖点）：图表、表格、3D 效果、PPTX 转场。
3. 注释/编辑系统（近期重点）：绘制、选择、undo/redo、打印叠加、存回 PDF。
4. 无障碍 + 国际化：ARIA、键盘导航、11 种语言。
5. UI/UX：视图模式、移动端工具栏、主题。
6. 商业化：遥测（PostHog）、license、品牌 attribution。

**对贡献者的含义**：渲染/布局 bug 几乎都在闭源引擎里，外部无法修；能有效贡献的是 JS 层功能、测试、a11y、i18n、类型、示例、文档。且 `CONTRIBUTING.md` 明确要求"零新增运行时依赖"。

---

## 2. 候选贡献点逐项调研

### A. 测试基建 + 纯函数单测扩充（推荐，优先级最高）

**现状（已核实）**：

- `package.json` 根有 `test: vitest run`；SDK 有 `test/` 目录，仅 3 个文件：`search.test.ts`、`spreadLayout.test.ts`、`tool-change.test.ts`。
- `.github/workflows/ci.yml` 的 `check` job 只跑 `typecheck` / `lint` / `format:check` / `build`，**没有 `npm test`**。即 CI 完全不会发现测试回归。
- 核心状态机 `packages/udoc-viewer/src/ui/viewer/reducer.ts#L6` 是**纯函数** `reducer(state, action): ViewerState`（`switch(action.type)` 派发，无副作用），是低成本、高价值的目标——但当前**没有任何 reducer 单测**。

**可验证性**：本环境已具备 Node 24 + vitest，可直接 `npm run build --workspace packages/udoc-viewer && vitest` 运行反馈，无需浏览器。

**落地步骤**：

1. 在 `ci.yml` 增加 `npm test`。
2. 为 reducer 的关键分支补单测：`SET_DOC`（同步 viewDefaults/工具降级）、`SET_PAGE`（clamp 边界）、`CLEAR_DOC`（状态复位完整性）、搜索状态机、工具切换、面板可见性。reducer 为纯函数，可直接 `import { reducer, initialState }` 断言。

**价值**：安全、低门槛、无商业边界争议，对长期回归防护价值高。

**可提交 issue（草稿，英文）**：

```markdown
### Test coverage gap

**Severity:** Low-Medium · **Type:** test/infra

The CI workflow (`.github/workflows/ci.yml`) runs `typecheck`, `lint`,
`format:check` and `build`, but does **not** run `npm test` (`vitest`).
As a result a regressing unit test (or a test that fails to compile) would
not be caught in CI.

In addition, the core state reducer `reducer(state, action)` in
`packages/udoc-viewer/src/ui/viewer/reducer.ts` is a pure function with no
side effects but currently has **zero** test coverage.

Proposal:

1. Add `npm test` to CI.
2. Add unit tests for the reducer's key branches: `SET_DOC` (view defaults,
   tool downgrade when annotations unsupported), `SET_PAGE` (clamp at
   bounds), `CLEAR_DOC` (full state reset), and the search + tool-switch
   state transitions.

Happy to open a PR if this is welcome.
```

---

### B. Headless 注释编辑可用性（TODO#2，精确修法已定位）

**现状（已核实）**：

- `UDocViewer` class 文档明确声明"Supports both UI mode (with container) and headless mode"——headless 模式是官方支持的能力。
- **读路径已 headless 兼容**：`getPageAnnotations()` 用 `this.uiShell?.store` 可选链，回退到 `workerClient`（`UDocViewer.ts#L794`）。
- **写路径未 headless 兼容**：`addPageAnnotation/updatePageAnnotation/removePageAnnotation` 均先 `ensureUiMode()`（无 container 直接抛错），再解引用 `this.uiShell!.store`（`UDocViewer.ts#L820-L868`）。注释编辑状态放在 UI shell store 里。
- JSDoc 已注明"暂只支持 UI 模式 + 仅 PDF"，即"只读 headless"已具备，缺的是把**编辑状态提升到 headless 可用的位置**。

**耦合点**：三类 editing 操作依赖 `uiShell.store`（store 是 UI shell 专属）。TODO.md 提议"把编辑状态上提，使其在无 container 时也可用，或显式文档化为只读"。

**落地方向（可二选一）**：

1. 若只想低成本收敛 → 明确在 API 文档/类型层面把注解编辑标注为"需 UI 模式"，避免使用者误解（当前仅 JSDoc 说明，缺少接口层提示）。
2. 若做功能级贡献 → 引入与 UI shell 解耦的轻量编辑 store（或复用 worker 层状态），让 `add/update/removePageAnnotation` 在 headless 下也能增删并最终 `toBytes()` 保存。需引擎侧 `pdf_save_annotations` 已支持（已存在，见 CHANGELOG 0.6.23）。

**价值**：这是 TODO.md 官方列出的两件 pending 中唯一在开源侧可解的一件（另一件 #1 在闭源 Rust 层）。

**可提交 issue（草稿，英文）**：

```markdown
### Headless annotation editing is unusable without a container (TODO#2)

**Type:** enhancement

`UDocViewer` supports headless mode (no `container`), and the **read** path
is already headless-safe: `getPageAnnotations()` falls back to the worker
via `this.uiShell?.store` (see `UDocViewer.ts#getPageAnnotations`).

However the **write** paths `addPageAnnotation` / `updatePageAnnotation` /
`removePageAnnotation` (`UDocViewer.ts#L820-L868`) all call `ensureUiMode()`
and dereference `this.uiShell!.store`, throwing when no container is present.
So an embedder using the viewer headlessly cannot create/edit/remove
annotations and save them, even though `getPageText`, rendering, and reads
work fine without a container.

Proposal: lift the annotation editing state out of the UI shell store so
these methods work headlessly (or, at minimum, surface the restriction at
the type/API level rather than a runtime throw). Noted in `TODO.md`.
```

---

### C. i18n 强化（预期已被修正）

**现状（已核实）**：`locales` 强类型为 `Record<string, TranslationKeys>`（`i18n/index.ts#L18`），`TranslationKeys` 是扁平的 string 接口。因此**缺 key 会在编译期报错**——"补齐缺失翻译"这类贡献价值很低。

**真正的可挖点**：

1. **占位符插值校验**：`t()` 用 `{param}` 正则替换，若某 locale 的模板占位符与调用处参数名不一致，会静默漏替换。可写单测：对每个 key、每个 locale，校验 `{xxx}` 占位符集合一致。
2. **回退解析覆盖**:`resolveLocale`（base-language fallback，如 `pt`→`pt-BR`、`zh-Hans`→`zh-CN`）目前无测试。

**价值**：中低；属于"锦上添花"，适合作为 A/B 之后的补充。

---

### D. TS 公共 API 类型/文档加固（备选）

- 项目强调 strong type + strict。可审计 `UDocClient`/`UDocViewer` 的 `ViewerOptions`/事件类型推导是否遗漏、`ViewerEventMap` 是否有未覆盖事件。
- 价值中等，产出偏"审阅性"，见效慢。

---

## 3. 优先级建议

| 优先级 | 方向                           | 环境可验证         |    商业边界风险    | 对项目价值        |
| :----: | ------------------------------ | ------------------ | :----------------: | ----------------- |
|   P0   | A. 测试基建 + reducer 单测     | ✅ 可直接跑        |         无         | 高                |
|   P1   | B. Headless 注释编辑（TODO#2） | ✅ 可跑 build+单测 | 低（需确认引擎侧） | 中高（官方 Todo） |
|   P2   | C. i18n 占位符/回退            | ✅                 |         无         | 中低              |
|   P3   | D. TS 类型加固                 | ✅                 |         无         | 中                |

---

## 4. 下一步

决定发起哪个方向后，我可以：

1. 直接用上面的 **issue 草稿**去 GitHub 发 issue 征询维护者意见（需先确认你有 GitHub 访问）；
2. 或直接动手实现（先跑通构建与单测验证）。
