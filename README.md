# 装机查价验证原型

项目包含装机配置与报价 HTTP API，以及输出 JSON 和 Markdown 的查价验证工具。使用 Node.js 22+，无第三方运行依赖。

在项目根目录运行 `npm start`，API 默认监听 `http://127.0.0.1:4310/api/v1`。前端可先调用演示配置和实查记录回放，无需密钥。查看 [前端对接文档](docs/api.md)。

## 本轮结果

2026-11-23 定向检查 7 个京东商品页面：2 个 CPU 链接、5 个 GPU 链接。人工网页观察中，一项 CPU 页面显示人民币 1729 元标价，同时要求登录查看到手价；其他页面涉及缺价、推荐区混入价格、浏览器提示或显存规格不明确。

- [原始观察摘录](data/observations.json)：保留链接、字段、采集时间和观察说明，标题有缩写。
- [观察回放报告](reports/validation.md)：7 条均为待核实，0 条可自动入槽。这是保守判定结果，不是准确率指标。
- [程序直接读取报告](reports/page-probe.md)：使用项目代码实际发起 7 次商品页读取，记录每次耗时和获取状态。

当前只对严格绑定 SKU 的 JSON-LD Product/Offer 报价做自动确认。尚未实现京东动态价格接口或登录态提取，因此零通过也反映了解析覆盖有限，不能推导为全平台无法查价。人工记录和程序读取报告分别保存，不混用证据或采集时间。

## 快速运行

在项目目录执行：

```powershell
npm test
npm run demo
npm run probe
```

`demo` 离线回放固定观察记录，输出 `reports/validation.md` 和 `.json`。回放用原始采集时间判定新鲜度，并保留原始时间，不能把回放当作重新查价。

`probe` 直接读取观察记录中的 7 个商品链接，输出 `reports/page-probe.md` 和 `.json`。每页最多等待 10 秒，不绕过验证码、登录或访问限制。

## 前端工作台（web/）

按 [design/workbench-v4-guided.png](design/workbench-v4-guided.png)（方向 C）实现的可交互前端，React + TypeScript + Vite，与查价 CLI 分开安装依赖。

```powershell
npm --prefix web install
npm start          # 终端 1：本地 API，http://127.0.0.1:4310
npm run web        # 终端 2：前端，http://localhost:5173（/api 代理到 4310，API_PORT 可改）
npm run web:test   # 前端测试，含与后端 calculateBuild 的一致性检查
```

连上 API 后：CPU / 显卡调用 `/quotes/search`（默认回放，配置密钥后可切实时），方案保存到 `.runtime/builds.json` 并带版本号。主板等其余配件暂为演示数据。API 未启动时整页退回演示模式，方案存在浏览器 localStorage。

## 国内型号补充（中关村在线，个人使用）

```powershell
npm run catalog:zol -- --category GPU --limit 600 --chips "RTX ?50\d0|RTX ?40\d0|RX ?9\d{3}|RX ?7\d{3}"
npm run catalog:zol -- --category CASE --limit 200
npm run catalog:zol -- --category COOLER --limit 200
```

从 ZOL 产品库抓取型号与参数，输出 `.runtime/zol-catalog.json`（多次运行按 id 累积），重启 API 后并入 `/catalog`：类目、品牌、料号与已有记录唯一匹配时只补缺失字段和中文别名，否则作为独立条目。已支持显卡（长度、建议电源、供电接口、显存）、机箱（板型、显卡限长、散热器限高）、CPU 风冷散热器（高度、插槽）。

只访问 robots.txt 允许的列表页和参数页，User-Agent 如实标明，请求间隔默认 2.5 秒，原始页面缓存在 `.runtime/zol-cache/`，遇到 403/429/验证页即停止。显卡默认排除服务器与专业卡。数据仅供个人非商业使用；参数为站点众包维护，可能有误；参考价不是实时报价，界面只显示、不计入合计。

前端连上 API 后，主板、内存、硬盘、电源、机箱、散热从型号目录选择（加入前手动填价）；CPU / 显卡可在「回放 / 实时 / 目录」间切换。兼容性检查包含显卡限长、散热器限高，以及按显卡建议电源判断电源功率。

## 估算价与定期更新

目录里的型号带估算价：有 ZOL 参考价就用参考价；显卡没有参考价时，用同芯片同显存至少 3 款的参考价中位数。网页上点“按估算价加入”，配置里显示“约 ¥x”，合计注明含几件估算；点价格可改成实付价，改过的价格不会再被刷新覆盖。

```powershell
npm run catalog:prices    # 重抓已抓过的 ZOL 列表页（约 50 次请求），更新参考价并追加 .runtime/zol-price-history.jsonl
```

刷新后重启 `npm start`，再在网页右侧点“刷新估算价”。建议每周一次；参考价不是实时报价，下单前以商城价格为准。

## 京东联盟京东价（个人使用）

在 `.env` 填写 `JD_UNION_APP_KEY` 与 `JD_UNION_APP_SECRET`，先验证一次：

```powershell
npm run jd:check -- https://item.jd.com/100012345678.html
```

成功后重启 `npm start`。网页填价对话框会出现“京东商品链接”输入框：粘贴链接取京东价并填入，配置备注记录查询时间与链接。京东价不含优惠券和补贴，有优惠可直接改为实付价。

## 接入实时搜索

目前实现 Brave Web Search 适配器。服务端通过官方固定端点检索，不会把密钥放进 URL、报告或缓存。先在本地复制 `.env.example` 为 `.env`，填入自己的密钥；无需在聊天中发送密钥。

```powershell
Copy-Item -LiteralPath .env.example -Destination .env
```

编辑 `.env` 后执行：

```powershell
npm run search -- --category CPU --query "9700X 盒装"
npm run search -- --category GPU --query "RTX 5060 Ti 16GB" --output reports/gpu-live
```

输出 `reports/live.md` / `.json`，或 `--output` 指定的文件前缀。最多处理 10 个搜索结果，重复的规范化链接只读取一次。搜索摘要只作为发现线索，不会给读取失败的商品页补价格。

本次环境没有搜索 API 密钥，所以尚未实测 Brave 的中文商品覆盖、端到端搜索延迟和账单。测试中的 API 响应是明确的合成控制样本，不能替代真实接入验证。工具本身不会自动创建账号或付费开通服务。

官方接口与鉴权文档：

- [Web Search API](https://api-dashboard.search.brave.com/api-reference/web/search/get)
- [API 鉴权](https://api-dashboard.search.brave.com/documentation/guides/authentication)

## 处理流程

1. 明确 CPU / GPU 型号、可选盒装要求、GPU 显存容量；保留 Ti / Super / XT 等后缀。
2. 查询服务端本地磁盘缓存，默认 TTL 为 60 分钟，可配置 30–120 分钟。
3. 缓存未命中时，先原子预留每日额度，再调用搜索 API；默认每天 20 次，按 Asia/Bangkok 日期分界。
4. 过滤不支持的商品链接、配件、二手、整机和板U套装。
5. 对候选商品页做只读检查，拒绝自动跟随重定向，限制请求时间和响应体大小。
6. 验证单一 Product、单一 Offer、相同 SKU、相同商品 URL、CNY、新品、库存、报价时间与型号规格。
7. 输出可自动入槽 / 待核实 / 已过滤，以及具体理由和原始证据。

只有单一、明确的 JSON-LD 商品报价才有机会通过；AggregateOffer、推荐区、用户评论、任意正文数字都不会自动归属到当前 SKU。券后、登录、补贴、定金等条件价格进入待核实。未知价格保留 `null`，金额使用整数分。

## 费用和限额

- `.runtime/usage.json` 保存每日请求尝试次数，失败请求也保守计数，不自动重试。
- 文件锁保护多个本地 CLI 实例的计数；相同实例的相同并发查询会合并。
- `.runtime/search-*.json` 保存搜索结果。缓存命中不发出搜索请求；商品页仍会重新读取。
- `SEARCH_COST_USD_PER_REQUEST` 留空时，金额费用显示未知。填写合同单价后，统计未扣抵扣额度的估算费用。
- 估算不等于实际账单，未推断免费额度、税费或搜索服务是否对失败请求收费。
- 如果进程被强制结束留下 `usage.lock`，确认没有任务运行后再人工处理锁文件；不会自动绕过限额。

HTTP API 仅绑定本机回环地址，配置存放在 `.runtime/builds.json`。当前按单进程本地服务设计。

## 模块

| 文件 | 用途 |
|---|---|
| `src/normalization.mjs` | 型号、规格、URL、金额规范化与报价判定 |
| `src/retailer.mjs` | 商品页只读请求、JSON-LD 报价验证 |
| `src/search.mjs` | Brave 检索、TTL 缓存、相同请求合并 |
| `src/store.mjs` | 本地文件存储、原子额度计数 |
| `src/cli.mjs` | 实时搜索命令 |
| `scripts/replay.mjs` | 固定观察记录回放 |
| `scripts/probe-pages.mjs` | 实际商品页读取实验 |
| `test/` | 型号混淆、价格陷阱、证据归属、缓存与额度测试 |

## 进入完整工作台前的条件

需要用用户自己的搜索账号实际运行 CPU / GPU 查询，记录可用候选、人工核实结果、延迟和单次成本；并评估能够提供明确 SKU、库存和报价时间的商品数据接口。再扩大样本验证误收、误过滤与无结果情况。

API 已提供槽位保存、锁定、手动价、预算汇总与基础兼容性检查。自动预算分配、性能评分和自然语言配单属于后续阶段。价格审核区间用于检查异常。

本原型未复制或导入前述四个第三方仓库的代码与数据。
