# 发布依赖工作台 · Release Dependency Studio

在固定 revision 的依赖图上选择一组包变更，按依赖范围（runtime / optional / peer）沿图传播
major·minor·patch 的**最小影响**，算出哪些下游包需要同步发版，并生成候选版本计划与每个升级的原因链。
前端可调整任意候选版本并**增量重算**受影响子图。

**纯本地模拟**：不连接包仓库、不执行任何发布动作。

## 运行

```bash
npm install
npm run dev      # API  http://127.0.0.1:4174 ；前端 http://127.0.0.1:4173
npm test         # vitest：semver / planner 算法 / HTTP API，共 53 例
npm run build    # tsc --noEmit + vite build
```

## 传播语义（核心规则）

对每条依赖边 `owner --(kind, range)--> dep`，当 dep 产生候选版本 `depV`：

1. `range` 已满足 `depV`（caret/union/预发布按 npm 规则）→ owner **不发版**，记入“已满足/未触发边”。
2. `range` 不满足：
   - **runtime**：owner 必须发版，影响级别 = dep 的变更级别（major/minor/patch）。
   - **optional**：owner 以 **patch** 兜底（不放大上游 major）；边 `missing`（未安装）时完全不构成约束。
   - **peer**：owner 以 **minor** 发版并放宽 peer 范围；范围改写采用“旧范围 ∪ 新兼容范围”的并集，保留对旧消费者的支持。
3. 一个包同时被多条路径强迫时，取**最大级别**；范围改写必须同时满足全部路径。
4. 算法为带指纹的**不动点**迭代，天然处理依赖环（单调升级、收敛即停、超限报错）。
5. **预发布**：
   - 范围满足按 npm 规则（预发布版本仅在范围显式引用同一 `M.m.p` 元组时命中）；
   - 预发布包 minor/major 视为“毕业”到对应稳定元组；patch 在预发布序列内推进（`beta.2 → beta.3`）；
   - 对预发布版本的最小新范围采用精确钉版（`1.0.0-beta.3`），稳定版采用 caret（`^1.0.0`）。
6. **私有包**照常产出候选版本并向下游传播，但标记 `publishable=false`（仅内部）。
7. **外部冻结包**的声明范围不可改写：runtime/optional 失配 → `frozen-range` 冲突；
   peer 失配或多条 peer 范围**交集为空（互斥）**→ `peer-mutex` 冲突。
8. 无法满足时返回 **422 + 最小冲突子图**：直接矛盾的边标 `contradicting`，
   宿主/原因路径以 `context` 节点与上下文边附上，并带从原始变更到冲突点的原因链。

## 增量重算

调整某个候选版本后，只从该候选沿**反向依赖边**求可达集（缺失的 optional 边不传播）：

- 子图内的包重新参与不动点求解，候选标 `recomputed=true`；
- 子图外的上一轮候选原样沿用（`recomputed=false`），作为固定点继续约束子图；
- 本轮被消解的候选进入 `removedIds`；
- 调整后若撞冲突，同样返回最小冲突子图。

## 并发修改图

- 图带单调 `revision`；`POST /api/graph/mutate` 走**串行写队列** + 乐观锁，
  过期 revision 返回 **409** 与当前图，旧调整不会覆盖新图；计划计算同样校验 revision。
- 前端用**单调请求序号**丢弃乱序返回：旧计算结果永远不能覆盖新调整。

## API

| 方法/路径 | 说明 |
| --- | --- |
| `GET /api/graph` | 当前固定 revision 依赖图（节点 + 边） |
| `POST /api/graph/mutate` | `{revision, mutation}`：set-version / set-node / add-edge / remove-edge |
| `POST /api/plan/compute` | `{revision, changes:[{id,to|level}], overrides?}` → 200 计划 / 422 冲突 / 409 过期 |
| `POST /api/plan/recompute` | `{revision, changes, overrides, adjustedId, previous}` 增量重算 |
| `POST /api/graph/reset` | 测试辅助：回到初始 revision 1 |

类型见 `src/shared/model.ts`；semver 内核见 `src/server/semver.ts`；传播算法见 `src/server/planner.ts`。

## 前端

- 左栏：图浏览器（从任意包查看出/入边，外部/私有/缺失标记）+ 并发修改演示；
- 中栏：勾选变更（patch/minor/major/指定版本）→ 计算计划；候选版本就地可编辑 → “增量重算”；
- 冲突面板展示最小冲突子图，节点与原因边可互相跳转定位；
- 原因链逐跳展示边类型、声明范围、新范围、贡献的最小级别与文字解释。
