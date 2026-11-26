# 装机工作台 API v1

## V2.1 行为更新

`POST /plans` 与 `POST /recommend` 使用同一组合优化和最终兼容性规则。`/plans` 可附 `workload: { task, game?, targetFps?, quality?, material?, ambientC?, cpuPowerLimitWatts?, maxNoiseDbA? }`。一级用途与细分任务必须匹配；没有对应场景实测时返回明确标记的代理及低可信度，不能据此确认目标 FPS。

方案带 `recommendationStatus`：`feasible`（已确认可行）、`conditional`、`verification_required`、`degraded`、`over_budget_alternative` 或 `infeasible`。`formalRecommendation` 只在已确认可行时为 true。整机 `compatibility.overall` 保留 PASS / CONDITIONAL / UNKNOWN / FAIL；任何 UNKNOWN 不简化成通过。严格预算 `maxOverPercent: 0` 下无解时 `picks: []`，超预算配置仅在独立的 `alternative` 中展示，`partialPicks` 只是未配齐的候选线索。

**外设费用现计入总预算**。请求 `peripherals` 时各档同时比较主机与外设合计；方案 `totalCents` 是主机、额外采购与外设总价，`hostTotalCents` 单列主机。保存配置的 `totals.totalCents` 仍是主机小计，`grandTotalCents` 是总价，`remainingCents = budgetCents - grandTotalCents`。机箱已知额外风扇费用通过方案 `additionalCosts` 单列，并保存为自定义槽位；未知费用保留待核实说明。

`GET /catalog/quality-report` 导出含时间、价格来源、SKU 规格冲突、倒挂、库存未知和散热数据缺失的数据质量报告。`PUT /catalog/:id/specs` 接收 `{ specs, sourceUrl, note? }`；HTTPS 来源必填，字段有类型与范围校验，持久化在 `spec-overrides.json`，立即用于下一次搜索。官方核实修正保存在 `data/hardware-corrections.json`，原始目录与价格不被无来源覆盖。

保存配件的 `priceSource` 增加 `verified` 与 `historical`，分别表示已核实市场报价与历史报价。未来观察时间被拒绝。响应 `meta` 提供目录过滤、候选数量、预算剪枝、规格 / 品质淘汰、Top-K、价格记录及关键 GPU 替代方案；搜索有界，不证明全局最优。

在项目根目录运行 `npm start`。地址默认为 `http://127.0.0.1:4310/api/v1`。在 `.env` 中设置 `PORT` 可换端口。配置保存到 `.runtime/builds.json`，由一个本地 API 进程写入。

本地前端可以从 `http://localhost:5173` 或其他 HTTP(S) 回环地址直连接口。若 UI 跑在云端预览环境，需要在本机启动前端或配置合适的开发代理。所有带请求体的接口使用 `Content-Type: application/json`。

| 方法 | 路径（相对于 `/api/v1`） | 行为 |
|---|---|---|
| GET | `/health` | 服务状态、查价模式、支持类目、实时密钥配置状态 |
| GET | `/slot-types` | 八个标准槽位的 ID 与名称 |
| GET | `/catalog` | 商品目录，可按类目、名称、别名或料号检索 |
| GET | `/catalog/:id` | 单个具体硬件型号的规格和官网图片链接 |
| GET | `/templates/demo` | 读取 C 版演示配置，适合初始化 UI |
| GET | `/builds` | 已保存方案列表，返回 `{ items }` |
| POST | `/builds` | 创建方案，返回 201 和完整配置 |
| GET | `/builds/:id` | 读取完整配置 |
| PUT | `/builds/:id` | 保存完整配置，提交当前 `version` |
| DELETE | `/builds/:id` | 请求体为 `{ "version": 2 }`，成功返回 204 |
| POST | `/quotes/search` | CPU、GPU 报价回放或实时检索 |
| POST | `/quotes/jd` | 京东联盟按 SKU 查京东价，请求体 `{ "skuIds": ["商品链接或编号"] }` |
| POST | `/recommend` | 按预算自动配，请求体 `{ budgetCents, scenarios, locked }` |

## 前端初始化

```js
const api = 'http://127.0.0.1:4310/api/v1';
const template = await fetch(api + '/templates/demo').then(response => response.json());

// 用户首次点击「保存方案」时创建持久记录，以后用 PUT 更新。
const response = await fetch(api + '/builds', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: template.name,
    budgetCents: template.budgetCents,
    slots: template.slots,
  }),
});
const saved = await response.json();
```

也可以通过 `POST /builds` 发送 `{ "preset": "demo" }` 创建样例，或发送 `{}` 创建八个空槽位。演示模板预算 ¥8,000，已选 7 件共 ¥3,944，剩余 ¥4,056，GPU 空置、CPU 锁定。

`POST`、`GET /builds/:id` 和 `PUT` 返回的配置包括 `id`、`version`、`name`、`budgetCents`、`slots`、`totals`、`compatibility`、`createdAt` 和 `updatedAt`。模板没有持久化 ID 或版本。

## 草稿与方案备份

- `GET /api/v1/draft` 返回 `{ draft: null }` 或 `{ draft: { build, serverId?, version? } }`。桌面和网页使用同一数据目录时共享最近编辑的草稿。
- `PUT /api/v1/draft` 接收 `{ build, serverId?, version? }` 并返回 204。草稿写入 `draft.json`，与正式保存的方案独立。若附带已保存方案的 ID，需要同时提供该版本号。
- `GET /api/v1/builds/backup` 导出 `{ format: 1, builds: [...] }`。向同一路径 `POST` 文件内容可恢复方案，返回 `{ restored, skipped }`。已有 ID 会跳过。

## 商品目录

`GET /catalog?category=GPU&q=RTX%205060%20Ti%2016GB` 返回 `{ items, total, limit, offset }`。筛选参数可省略。默认每页 24 项，最多 100 项。商品图片直接使用 `imageUrl`，点详情用 `sourceUrl`。图片加载失败时显示占位图。

`market=cn|global|all` 按来源筛选，默认为 `all`。条目的 `market` 为 `cn`（ZOL 条目、合并了 ZOL 数据的条目或内置官网样本）或 `global`（仅有 BuildCores 数据）。传入其他值返回 400。分组依据数据来源，库存仍需另外核实。

每条记录包含稳定的 `id`、`category`、`name`、`manufacturer`、厂商料号或型号 `mpn`、一行 `summary`、`aliases` 和 `specs`。没有料号或核实图片时，`mpn` 或 `imageUrl` 为 `null`。图片和规格来自不同厂商页面时，`imageSourceUrl` 单独记录图片出处。8GB 和 16GB 这样的变体使用不同料号与记录。其中部分料号对应海外版本，目录不代表当地库存。

目录记录不含报价。用户选定商品时，可以把 `name` 填入 `part.model`，把可用的兼容性字段填入 `part.specs`，未填价格用 `null`。用报价接口查出的 GPU 候选，可能与目录商品只有芯片和显存容量相同。将其绑定到具体目录商品前，还需核对品牌和厂商料号。

本地非商业目录由 [9 条官网样本](../data/catalog.json) 和 BuildCores OpenDB 导入快照组成。接口只在类目、品牌与厂商料号唯一匹配时合并两条记录，并保留官网图。BuildCores 记录用 `datasetUrl` 指向具体版本的上游文件，`sourceUrl` 优先返回厂商页面。列表响应和含 BuildCores 数据的详情响应提供 `attribution`，可用于显示来源、修订号、修改说明和许可证。数据采用 CC BY-NC-SA 4.0，图片链接单独保留其厂商出处。参考 [BuildCores 授权声明](https://github.com/buildcores/buildcores-open-db/blob/main/NOTICE.md)。

另可选导入中关村在线快照 `.runtime/zol-catalog.json`（`npm run catalog:zol`，个人非商业使用）。ZOL 记录 `id` 以 `zol-` 开头、`dataSource` 为 `zol`，可带非实时的 `referencePriceCents`（只作参考，不是报价）。与已有记录在类目、品牌、料号唯一匹配时并入该记录：已有字段优先，只补缺失规格、中文别名和图片，并加上 `zolId`、`zolUrl`。列表响应不含原始参数表，详情响应提供 `rawParams` 和 `zolAttribution`；列表响应的 `attributions` 列出全部数据来源。

更新本地数据时，在项目根目录运行以下命令。首次导入用 `git clone`，后续仅在已经克隆的目录内快进更新，再导入。重启 API 后读取新快照。项目会在快照缺失时回退到 9 条官网样本。

```powershell
git clone --depth 1 --single-branch --branch main https://github.com/buildcores/buildcores-open-db.git .runtime/buildcores-open-db
npm run catalog:import
```

更新已有检出时使用 `git -C .runtime/buildcores-open-db pull --ff-only` 后重新导入。导入只取八类硬件的字段，并在存储类过滤非 SSD 记录。原仓库和快照都在 Git 忽略的 `.runtime` 目录。

目录支持在分页前按当前配置筛选。传入类目及 JSON 格式的 `fit` 参数，例如 `category=MOTHERBOARD&fit={"socket":"AM5","memoryType":"DDR5"}`。规格匹配返回 `compatibility: "pass"`，任一已知条件冲突时默认隐藏，传 `showConflicts=1` 可显示为 `"conflict"`。缺少用于判断的规格返回 `"unknown"`。按返回的 `total` 和 `offset` 翻页。

## 槽位与预算

标准 ID 为 `CPU`、`GPU`、`MOTHERBOARD`、`RAM`、`SSD`、`PSU`、`CASE`、`COOLER`。保存时每个标准槽位必须恰好出现一次。自定义槽位 ID 以 `custom-` 开头，例如 `custom-case-fans`。槽位共有 `id`、`label`、`locked`、`part`，空槽位的 `part` 为 `null`。

```json
{
  "id": "GPU",
  "label": "显卡",
  "locked": false,
  "part": {
    "model": "RTX 5060 Ti 16GB",
    "priceCents": 399900,
    "quantity": 1,
    "priceSource": "manual",
    "note": "已手动核对",
    "url": null,
    "specs": {}
  }
}
```

- 金额使用人民币整数分。`priceCents: null` 表示未填价格。`priceCents: 0` 表示已知零价。合计按数量乘单价，只累加已知价格，并在 `totals.unknownPriceCount` 标出未知项。剩余预算为负数时显示超预算。
- `part.spec` 为可选的展示用简短规格（最长 120 字符，例如 `AM5 · 盒装`），不参与兼容性计算。配置可带可选的 `scenarios`（最多 8 个不重复的小写标识，例如 `["2k", "quiet"]`），省略时为空数组。
- `priceSource` 支持 `manual`、`demo` 和 `estimate`（按目录参考价估算），默认 `manual`。`part.catalogId` 可记录配件对应的目录 ID，用于之后刷新估算价。手动录入待核实报价时，用户确认后再填写价格。
- `PUT` 提交完整的 `name`、`budgetCents`、`slots` 和 `version`。成功后用响应的新版本覆盖本地副本。若返回 `VERSION_CONFLICT`，先重新读取方案再处理改动。
- 已锁定槽位先单独解锁，再编辑、换件或移除。解锁请求只改变该槽位的 `locked`，保留配件字段。
- `compatibility.cpuSocket` 和 `memoryType` 返回 `pass`、`conflict` 或 `unknown`。接口和内存代际取自配件 `specs.socket`、`specs.memoryType`。BIOS 仍为 `unknown`。
- `compatibility.radiatorClearance` 比较水冷 `specs.radiatorSizeMm` 与机箱 `specs.maxRadiatorMm`；`boardFit` 比较主板 `specs.formFactor` 与机箱 `specs.maxBoardFormFactor`（`MINI-ITX` < `MICRO ATX` < `ATX` < `EATX`）；`gpuPowerConnector` 在显卡 `specs.gpuPowerConnector` 为 16pin 时检查电源 `specs.native16Pin`（布尔），没有原生 16pin 返回 `warning`。
- `compatibility.gpuClearance` 比较显卡 `specs.lengthMm` 与机箱 `specs.maxGpuLengthMm`，`coolerClearance` 比较散热器 `specs.heightMm` 与机箱 `specs.maxCoolerHeightMm`，均为整数毫米，返回 `{ status, sizeMm, limitMm }`，`status` 为 `pass`、`conflict` 或 `unknown`。
- 功耗估算需要 CPU 和 GPU 的 `specs.maxPowerWatts`。估算负载为两类配件峰值合计加 75 W，建议电源额定功率按 25% 余量计算。存在 `specs.ratedWatts` 时返回 `pass` 或 `warning`，缺数据返回 `unknown`。 显卡可带厂商建议电源 `specs.recommendedPsuWatts`：与估算值都有时 `recommendedWatts` 取较大者，只有建议值时直接使用；`power.gpuRecommendedWatts` 返回该建议值。

## 报价查询

```json
{
  "category": "GPU",
  "query": "RTX 5060 Ti 16GB",
  "mode": "replay"
}
```

- `replay` 是默认模式，目前收录 `CPU / 9700X 盒装` 和 `GPU / RTX 5060 Ti 16GB`。结果保留原始观察时间并始终需要人工核实。其他合法型号可返回空列表，适合联调空状态。
- `live` 通过服务端 Brave Search 进行实时检索，需要在 `.env` 设置 `BRAVE_SEARCH_API_KEY`。没有可用密钥且缓存未命中时返回 503，前端可按需显式切回回放模式。
- 响应包含 `target`、`mode`、`summary`、`results` 和 `cost`。回放还会提供 `evidenceAsOf`。候选包含 `title`、`model`、`capacityGB`、`priceCents`、`url`、`observedAt`、`status`、`autoEligible`、`reasonCodes` 与 `reasons`。
- `accepted` 为已通过报价校验，`review` 为待核实，`rejected` 为已过滤。查价只返回候选。保存或修改方案需独立调用配置接口。

错误使用统一格式 `{ "error": { "code": "SLOT_LOCKED", "message": "…" } }`。常用状态码为 400 输入错误、404 未找到、409 配置冲突、429 搜索限额或繁忙、502 上游失败、503 实时搜索未配置。

## 京东联盟京东价

在 `.env` 配置 `JD_UNION_APP_KEY`、`JD_UNION_APP_SECRET` 后，`/health` 的 `quotes.jdUnionConfigured` 为 `true`。`POST /quotes/jd` 接受 1–100 个京东商品链接或 SKU，调用 `jd.union.open.goods.promotiongoodsinfo.query`，返回 `{ items, missing, observedAt, cached }`。`items[].unitPriceCents` 为京东价（整数分，不含优惠券、补贴），`mobilePriceCents` 为无线京东价，未查到为 `null`。`missing` 列出联盟没有返回的 SKU：多半不在推广中，不代表没有价格。同一组 SKU 30 分钟内返回缓存，两次实际调用至少间隔 1 秒。未配置返回 503 `JD_UNION_NOT_CONFIGURED`，无权限返回 403 `JD_UNION_FORBIDDEN`。

网关 `https://api.jd.com/routerjson` 已确认可达；签名与业务参数名 `360buy_param_json` 按京东开放平台通用规则实现，用 `npm run jd:check -- <商品链接>` 做首次真实验证。

## 估算价

目录条目可带 `estimatedPriceCents`、`estimateBasis` 与 `estimateSamples`。

| `estimateBasis` | 依据 |
|---|---|
| `reference` | 条目自身的 ZOL 参考价 |
| `chip-median` | 同芯片、同显存的显卡参考价中位数 |
| `model` | CPU 型号键完全相同。一个样本直接沿用，至少三个有效样本时用中位价 |
| `spec-median` | 内存、电源或 SSD 的同规格中位价 |

补价只使用已有价格作为样本。内存比较代际、容量与条数，电源比较取整到 50 W 的额定功率与能效档，SSD 比较标称容量与 PCIe 代数或 SATA。未知接口和未知能效各自分组。新增中位价剔除低于原组中位数 60% 的样本，保留至少三个样本，再把结果四舍五入到 10 元。

`priceObservedAt` 为参考价的观察时间。估算价用于参考。`npm run catalog:prices` 重抓已抓过的 ZOL 列表页刷新参考价，并追加 `.runtime/zol-price-history.jsonl`，重启 API 后生效。

## 按预算自动配

`POST /recommend` 请求体 `{ "budgetCents": 800000, "scenarios": ["2k", "quiet"], "locked": { "CPU": { "priceCents": 145000, "specs": { "socket": "AM5" } } } }`。`locked` 的键为标准槽位 ID，`specs` 使用与配件相同的兼容性字段。返回 `{ budgetCents, totalCents, lockedCents, picks: [{ slot, reason, item }], notes }`，`item` 为目录条目（含 `estimatedPriceCents`）。只使用有估算价、且兼容性所需规格齐全的条目；结果为估算，不是报价。

`/recommend` 和 `/plans` 的自动选件都只使用 `market: "cn"` 的条目。

目录条目在有价格历史时带 `priceTrend: { previousCents, changedAt, lowestCents, since, points }`。

## 整机方案（V2）

`POST /plans` 请求体：

```json
{ "budgetCents": 800000, "scenarios": ["2k"], "peripherals": [], "maxOverPercent": null,
  "priceMode": "estimate", "allowUsed": false,
  "locked": { "CPU": { "priceCents": 145000, "specs": { "socket": "AM5" }, "name": "…" }, "GPU": { "igpu": true } } }
```

- `maxOverPercent`：`null` 不限；`0` 严格预算（每档不超过本档目标）；`1`–`50` 允许超出的百分比。
- `priceMode`：`estimate` 参考估算（默认）；`manual` 优先我的价格（见下文价格记录）。`allowUsed` 只在 `manual` 下生效。
- `strategy`：`value` 性价比优先 / `balanced` 均衡推荐（默认）/ `performance` 预算内性能优先（2.2.1：前两者以场景综合评分减成本为目标，后者先最大化工作负载核心性能）。
- `workload.minVramGB`、`workload.minSsdGB`（2.2.1）：显存 / 硬盘最低容量，软约束，达不到时方案的 `unmetRequirements` 标明。
- `allowModified`（2.2.1，默认 `false`）：允许非原厂改装 / 工程样品参与推荐。目录条目带 `productStatus`（`new` / `used` / `refurbished` / `modified` / `engineering_sample` / `unknown`）与 `productStatusReason`；默认只用 `new`，被排除的 CPU / 显卡列在 `meta.productStatusFilter.excluded`。
- 方案的 `tradeoffs`（2.2.1）：与上一档相比上升 / 下降的显存、显卡指标、CPU 指标、内存与硬盘容量。
- `locked`：硬约束，键为标准槽位；`GPU: { igpu: true }` 表示锁定使用核显。

返回 `{ plans, priceMeta }`，`plans` 固定三档（`save` / `balanced` / `plus`，目标为预算的 80% / 100% / 120%）。每档含 `picks`、`totalCents`、`budget`（输入、目标、上限与差额）、`compatibility`（`overall` 与 `checks[]`，状态为 `PASS` / `FAIL` / `CONDITIONAL` / `UNKNOWN` / `NOT_APPLICABLE`）、`score`（`total` 0–100、`parts` 分项 0–100、`bottleneck`、`version`）、`sameAs`（与哪一档相同）和 `notes`。找不到可行组合时 `infeasible: true`，附 `reasons`、`minFeasibleCents`、`suggestions`，不会悄悄少一档。

## 价格记录（V2）

用户价格与配件规格分开存放在 `<数据目录>/prices.json`。不抓取电商实时价。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/prices?componentId=` | 列出记录 |
| POST | `/prices` | 新增一条：`{ componentId, priceCents, shippingCents?, sourceName?, sourceUrl?, observedAt?, condition?, stockStatus?, priceType?, confidence?, sku?, note? }` |
| DELETE | `/prices/{id}` | 删除 |
| GET | `/prices/export?format=csv` | 导出 CSV（UTF-8 BOM，防公式注入）；不带 `format` 时导出 JSON `{ version, exportedAt, records }` |
| POST | `/prices/import` | `{ format: "csv" \| "json", content }`，逐行校验，返回 `{ imported, errors: [{ row, message }] }`；错误行不写入 |

字段取值：`condition` 为 `new` / `used` / `refurbished` / `old-stock` / `oem`；`stockStatus` 为 `in_stock` / `out_of_stock` / `unknown`；`priceType` 为 `manual` / `verified` / `reference` / `estimate`（`verified` 必须带 HTTPS `sourceUrl`）；货币只支持 `CNY`。

`priceMode: "manual"` 时，每个配件取最新一条有效记录（价格 + 运费）；默认忽略二手、翻新、拆机和明确无货的记录。目录参考价超过 14 天、用户记录超过 30 天标记 `priceStale: true`。`GET /catalog?priceMode=manual&allowUsed=true` 按同样规则显示价格，条目带 `priceSource: "catalog" | "user"`。
