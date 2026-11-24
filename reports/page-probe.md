# CPU / GPU 查价验证结果

生成时间：2026-11-23 21:19:38（Asia/Bangkok）。这是对已知商品链接的直接读取，没有进行搜索。

共 7 条；可自动入槽 0 条；待核实 7 条；已过滤 0 条。

报价仅表示证据中的观测值；待核实项不会进入配置总价。金额未知用空值，不能用零代替。

| 目标 | 商品标题 | 参考价 | 状态 | 原因 |
|---|---|---:|---|---|
| 9700X 盒装 | AMD 锐龙 7 9700X 盒装CPU | 未知 | 待核实 | 没有可归属到当前商品的价格；未确认人民币价格；页面缺少可验证的单商品结构化报价；尚未将价格绑定到明确SKU；库存状态未确认；商品是否为新品未确认 |
| 9700X 盒装 | AMD 锐龙 7 9700X 盒装CPU | 未知 | 待核实 | 没有可归属到当前商品的价格；未确认人民币价格；页面缺少可验证的单商品结构化报价；尚未将价格绑定到明确SKU；库存状态未确认；商品是否为新品未确认 |
| RTX 5060 Ti 16GB | 影驰 RTX 5060 Ti 金属大师 MAX 白 OC 16G | 未知 | 待核实 | 没有可归属到当前商品的价格；未确认人民币价格；页面缺少可验证的单商品结构化报价；尚未将价格绑定到明确SKU；库存状态未确认；商品是否为新品未确认 |
| RTX 5060 Ti 16GB | 影驰 RTX 5060 Ti 星曜 LUNA MAX OC 16G | 未知 | 待核实 | 没有可归属到当前商品的价格；未确认人民币价格；页面缺少可验证的单商品结构化报价；尚未将价格绑定到明确SKU；库存状态未确认；商品是否为新品未确认 |
| RTX 5060 Ti 16GB | 技嘉 RTX 5060 Ti 16GB（仅检索线索） | 未知 | 待核实 | 没有可归属到当前商品的价格；未确认人民币价格；页面缺少可验证的单商品结构化报价；尚未将价格绑定到明确SKU；库存状态未确认；商品是否为新品未确认 |
| RTX 5060 Ti 16GB | 七彩虹 RTX 5060 Ti 16GB（仅检索线索） | 未知 | 待核实 | 没有可归属到当前商品的价格；未确认人民币价格；页面缺少可验证的单商品结构化报价；尚未将价格绑定到明确SKU；库存状态未确认；商品是否为新品未确认 |
| RTX 5060 Ti 16GB | 华硕 RTX5060Ti O8G/O16G 显卡 大师PRIME O8G | 未知 | 待核实 | 显存容量缺失或包含多个选项；没有可归属到当前商品的价格；未确认人民币价格；页面缺少可验证的单商品结构化报价；尚未将价格绑定到明确SKU；库存状态未确认；商品是否为新品未确认 |

## 来源与证据

1. AMD 锐龙 7 9700X 盒装CPU：<https://item.jd.com/product/P1v1mUNZZMMi7YHNd38fgQ.html>；采集时间 2026-11-23T14:19:35.565Z；方法 page-unverified；请求耗时 580ms。
2. AMD 锐龙 7 9700X 盒装CPU：<https://ic-item.jd.com/100371461200.html>；采集时间 2026-11-23T14:19:36.145Z；方法 page-unverified；请求耗时 939ms。
3. 影驰 RTX 5060 Ti 金属大师 MAX 白 OC 16G：<https://item.jd.com/product/Bt661uYAHVd-inmnSOmaYA.html>；采集时间 2026-11-23T14:19:37.084Z；方法 page-unverified；请求耗时 407ms。
4. 影驰 RTX 5060 Ti 星曜 LUNA MAX OC 16G：<https://item.jd.com/product/k0VRwpTHmkN1oXd4wozvaA.html>；采集时间 2026-11-23T14:19:37.491Z；方法 page-unverified；请求耗时 403ms。
5. 技嘉 RTX 5060 Ti 16GB（仅检索线索）：<https://item.jd.com/100253509694.html>；采集时间 2026-11-23T14:19:37.893Z；方法 page-unverified；请求耗时 187ms。
6. 七彩虹 RTX 5060 Ti 16GB（仅检索线索）：<https://item.jd.com/100245473299.html>；采集时间 2026-11-23T14:19:38.081Z；方法 page-unverified；请求耗时 248ms。
7. 华硕 RTX5060Ti O8G/O16G 显卡 大师PRIME O8G：<https://item.jd.com/product/Ci-A5lreSlyqLlTL8aEVgQ.html>；采集时间 2026-11-23T14:19:38.328Z；方法 page-unverified；请求耗时 400ms。

## 调用与成本

项目搜索API尝试次数：0；商品页请求次数：7；缓存命中：0。
本轮搜索估算费用（USD，未扣抵扣额度）：0.000000。
外部搜索服务的实际账单以提供商为准。失败尝试保守计入每日上限，不代表提供商一定收费。

- 此次仅直接读取预先发现的7个商品页，没有调用搜索API。
- 当前解析器仅覆盖单一JSON-LD Product/Offer报价，要求SKU和URL明确绑定；没有通过不代表网页不存在其他可提取报价。
- 未实现京东动态价格接口或登录态价格提取，不能将此轮结果视为全平台可用率。
- 读取失败可能来自网络、页面策略或内容格式；不能据此断定商品已下架。

## 判定规则

- `unsupported_source`：来源不是已支持的京东商品详情链接
- `accessory`：标题指向配件、包装、维修服务或不含本体
- `used`：标题包含二手、拆机、矿卡或翻新信息
- `bundle`：标题包含板U套装、整机或组合商品
- `model_mismatch`：标题型号与检索目标不一致
- `model_ambiguous`：标题含多个型号或型号不明确
- `memory_mismatch`：显存容量与目标不一致
- `memory_ambiguous`：显存容量缺失或包含多个选项
- `target_memory_missing`：检索目标未指定显存容量
- `packaging_mismatch`：盒装或散片与检索要求不一致或尚未确认
- `conditional_price`：价格依赖登录、优惠券、会员、补贴、定金或其他条件
- `price_missing`：没有可归属到当前商品的价格
- `price_ambiguous`：有多个价格，无法确定当前SKU的实际价格
- `price_sanity`：价格超出宽泛的人工审核范围，需要核实
- `currency_unknown`：未确认人民币价格
- `sku_unverified`：尚未将价格绑定到明确SKU
- `stock_unknown`：库存状态未确认
- `condition_unknown`：商品是否为新品未确认
- `stale`：证据已过期、时间无效或采集时间在未来
- `snippet_only`：只有搜索摘要，未验证商品页
- `page_blocked`：商品页返回访问限制或浏览器验证提示
- `page_fetch_failed`：页面请求失败，需区分网络环境与商家页面限制
- `unstructured_page`：页面缺少可验证的单商品结构化报价
- `recommendation_prices`：只能看到推荐商品价格，不能作为当前商品报价
- `manual_observation`：人工浏览记录，只供验证回放
