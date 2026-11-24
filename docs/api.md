# 装机工作台 API v1

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

## 商品目录

`GET /catalog?category=GPU&q=RTX%205060%20Ti%2016GB` 返回 `{ items, total, limit, offset }`。筛选参数可省略。默认每页 24 项，最多 100 项。商品图片直接使用 `imageUrl`，点详情用 `sourceUrl`。图片加载失败时显示占位图。

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

目录条目可带 `estimatedPriceCents`、`estimateBasis` 与 `estimateSamples`：有 ZOL 参考价时 `estimateBasis` 为 `reference`；显卡缺参考价时，用同芯片、同显存条目参考价的中位数，至少 3 个样本，`estimateBasis` 为 `chip-median`。`priceObservedAt` 为参考价的观察时间。估算价不是报价。`npm run catalog:prices` 重抓已抓过的 ZOL 列表页刷新参考价，并追加 `.runtime/zol-price-history.jsonl`，重启 API 后生效。

## 按预算自动配

`POST /recommend` 请求体 `{ "budgetCents": 800000, "scenarios": ["2k", "quiet"], "locked": { "CPU": { "priceCents": 145000, "specs": { "socket": "AM5" } } } }`。`locked` 的键为标准槽位 ID，`specs` 使用与配件相同的兼容性字段。返回 `{ budgetCents, totalCents, lockedCents, picks: [{ slot, reason, item }], notes }`，`item` 为目录条目（含 `estimatedPriceCents`）。只使用有估算价、且兼容性所需规格齐全的条目；结果为估算，不是报价。

目录条目在有价格历史时带 `priceTrend: { previousCents, changedAt, lowestCents, since, points }`。
