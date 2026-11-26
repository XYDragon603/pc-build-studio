import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createCatalog } from '../src/catalog.mjs';
import { boardCaseStatus } from '../src/hardware-specs.mjs';

const root = 'reports/v2.1';
await mkdir(root, { recursive: true });
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const before = await read(`${root}/baseline-v2/测试结果.json`);
const after = await read('配置/测试结果.json');
const corrections = await read('data/hardware-corrections.json');
const all = after.cases.flatMap(c => c.variants);
const previous = before.cases.flatMap(c => c.variants);
const historicalCopies = (await readdir(`${root}/baseline-v2`)).filter(f => f.includes('副本'));
const money = v => `¥${(v / 100).toLocaleString('zh-CN')}`;
const slot = (v, id) => v.build.slots.find(s => s.id === id)?.part;
const byCase = v => v.map(p => money(p.build.totals.totalCents)).join(' / ');
const freq = values => [...new Set(values)].map(v => `${v} ${values.filter(x => x === v).length} 套`).join('；');
const catalog = createCatalog().all();
const ids = new Map(catalog.map(i => [i.id, i]));
const oldPhysicalConflicts = previous.filter(v => boardCaseStatus(slot(v, 'MOTHERBOARD')?.specs, ids.get(slot(v, 'CASE')?.catalogId)?.specs) === 'FAIL');
const compare = { baselineTime: before.testedAt, testedAt: after.testedAt, before: { count: previous.length, overBudget: previous.filter(v => !v.checks.withinTarget).length, officiallyCorrectedCaseConflicts: oldPhysicalConflicts.length }, after: { count: all.length, overBudget: all.filter(v => !v.checks.withinTarget).length, confirmedConflicts: all.filter(v => v.checks.conflicts.length).length, unknown: after.unknownCount, conditional: after.conditionalCount, strictBudgetPassed: after.strictBudgetPassed }, cases: after.cases.map(c => ({ index: c.index, label: c.label, budgetCents: c.request.budgetCents, before: before.cases.find(b => b.index === c.index)?.variants.map(v => ({ id: v.id, priceCents: v.build.totals.totalCents, overall: v.checks.overall })), after: c.variants.map(v => ({ id: v.id, priceCents: v.build.totals.totalCents, overall: v.checks.overall, recommendationStatus: v.recommendationStatus })), strict: c.strictPlans })) };
await writeFile(`${root}/12组前后对比.json`, JSON.stringify(compare, null, 2));
const diff = execFileSync('git', ['diff', '--no-ext-diff'], { encoding: 'utf8', maxBuffer: 10 * 1024 ** 2 });
await writeFile(`${root}/代码差异.patch`, diff);
const changed = execFileSync('git', ['diff', '--name-only'], { encoding: 'utf8' }).trim().split('\n');
const additions = ['data/hardware-corrections.json', 'src/hardware-specs.mjs', 'src/hardware-specs.d.mts', 'src/catalog-corrections.mjs', 'src/data-quality.mjs', 'src/workloads.mjs', 'test/v21.test.mjs', 'web/src/next/SpecCorrection.tsx', 'web/src/domain/v21.test.ts', 'scripts/report-v21.mjs'];
const backend = await readFile(`${root}/后端完整测试.txt`, 'utf8');
const frontend = await readFile(`${root}/前端完整测试.txt`, 'utf8');
const build = await readFile(`${root}/前端构建.txt`, 'utf8');
const testCounts = { backend: Number(backend.match(/tests (\d+)/)?.[1]), frontend: Number(frontend.match(/Tests\s+(\d+) passed/)?.[1]), backendFailures: Number(backend.match(/fail (\d+)/)?.[1]), buildPassed: /built in/.test(build) && !/error TS/.test(build) };
const lines = [
  '# PC Build Studio V2.1 第二轮缺陷修复报告', '',
  `本轮保留 V2 的组合优化、三档方案、价格管理、锁定配件和蓝白色界面。修正了机箱主板支持数据、A520 PCIe 上限、散热能力判断和缺失数据评分。12 组输入重新导出 36 套；已知物理和供电冲突 ${compare.after.confirmedConflicts} 套，严格预算模式全部满足“预算内或独立显示无解”。`, '',
  `这 36 套中 ${after.unknownCount} 套属于 UNKNOWN，不能作为已经确认可装配的正式推荐。主要缺口是对应负载的持续温度与噪音实测、显卡高度厚度和供电线空间、实际 PCIe 控制器链路。普通模式的超预算配置保留为替代方案。`, '',
  `基线时间：${before.testedAt}；本轮导出时间：${after.testedAt}（ISO UTC；本地时区 Asia/Bangkok）。价格观察时间留在配件记录中；性能快照时间和评分版本分别保存。评分版本是 2.1.0，不是采集日期，未再把 2026-11-27 写成已完成更新时间。`, '',
  '## 基线与复现', '',
  '开发前 Git 状态已检查，原始状态记录在 baseline-v2/git-status.txt；没有 reset、回退或提交。开发前配置复制到 baseline-v2，保留 12 份 Markdown、对应 JSON、总备份和测试摘要。工作台原有 .runtime/builds.json 与草稿未被测试写入；恢复验证使用独立 .test-store。', '',
  `原目录另有 ${historicalCopies.length} 份历史副本（${historicalCopies.join('、') || '无'}），保留原件但不计入 12 组回归，也不作为本轮新导出。`, '',
  `用官方修正后的机箱支持集合重新核对旧方案，发现 ${oldPhysicalConflicts.length} 套主板与机箱板型冲突；旧软件自己的检查未发现这些冲突。回归不以“旧检查返回 PASS”作为硬件事实。`, '',
  '## 已确认的根因与修复逻辑', '',
  '| 问题 | V2 根因 | V2.1 行为 |', '|---|---|---|',
  '| ATX 主板进入 M-ATX 机箱 | import-zol.caseSpecs 用机箱结构字段推最大主板板型，忽略适用主板；M8 因此被记成 ATX | 适用主板解析为明确集合，机箱类型不再充当支持证据；自动搜索要求板型 PASS，最终重新运行整机规则 |',
  '| 散热器能力误判 | optimizer.cooler 用高度 155mm 等阈值代表 250W 散热能力；quality 默认散热分 0.9 | 高度只判断安装。散热判据读取持续功耗、明确功耗限制、同插槽与机箱风道下的持续温度测试；只有厂商标称或缺实测时保留 UNKNOWN / CONDITIONAL |',
  '| 高功耗机箱总选最低价 | pcCase 只比较显卡限长、板型与散热器高度，没有负载和风道证据 | 按当前 CPU/GPU 负载下的实测证据、空间数据完整度、实际价格排序；同时检查显卡高度厚度、扩展槽、电源、供电线、冷排位置和空间共享；缺失值不是 PASS |',
  '| A520 错记 PCIe 4.0 | 第三方原始参数就是 4.0，enrichSpecs 直接采用；单个 pcieGen 又被当作所有插槽的代数 | 保留原始快照并在有来源的修正层限制 A520 为 3.0；显卡物理接口、电气通道、CPU 控制器、每个 M.2、设备端点和共享限制分别保存 |',
  '| RX 6500 XT 被当作 x8 | 根据芯片名的宽泛正则将多种低端卡都视作 x8，甚至排除了部分 Ti | 6500 XT 的官方芯片接口资料记录为 x4；规则按实际端点、CPU 和主板链路取交集，不能补出缺失的通道数据；带宽限制与无法安装区分 |',
  '| 缺证据仍高分 | 散热固定高分；尺寸推断噪音；未知价格默认较可信；AI 75% 显存占比掩盖算力 | 缺少持续散热证据不给高可靠性分，噪音只用整机负载实测；AI 容量与算力分开，缺项不补高默认分；高端性能曲线保留差异 |',
  '| 升级固定 2 分阈值 | 分差不足 2 即忽略，可能换掉核心显卡 / 内存 | 删除固定阈值；输出绝对与相对代理分变化、额外成本；各档优先满足最低需求，再在核心指标不倒退的候选中比较目标值；Blender 特殊取舍单独说明 |',
  '| 条件或未知简化成通过 | 原导出 passed 只看是否无 FAIL 和未超预算 | “已确认通过”必须总体 PASS；UNKNOWN、CONDITIONAL、降级、超预算替代、无解分别保留在 UI 和导出；只有已确认可行方案 formalRecommendation 为 true |',
  '| 外设预算遗漏 | 原接口主机选完后附加外设，不检查合计预算 | 各档在主机与外设总价上搜索；保存和编辑页用合计计算预算余额，外设仍独立列价 |',
  '| 历史价与已核实报价丢失 | 应用推荐时一律变成 estimate | 前端保存 manual / verified / historical / estimate，保留观察时间、来源、库存和商品状态；手动价格变化后重新生成读取最新记录 |', '',
  '关键逻辑摘录（省略了字段校验）：', '',
  '```js',
  '// 原逻辑：maxBoardFormFactor = boardFormFactor(raw["机箱结构"]);',
  '// 现逻辑：supportedBoardFormats = boardFormats(raw["适用主板"]);',
  'if (boardCaseStatus(board.specs, pc.specs) !== "PASS") excludeFromAutomaticCaseSelection();',
  'const checks = evaluateBuild(allSelectedParts, { workload });',
  'if (checks.some(c => c.status === "FAIL")) rejectCombination();',
  '// 无温度测试或空间数据时保留 UNKNOWN；不是降几分后变成 PASS。',
  '```', '',
  '## 官方数据来源与修正记录', '',
  '修正层不改商品价格，不覆盖原始抓取文件；每项保存来源、核实日期与理由。泛化的板型和 A520 平台上限规则适用于其他型号，型号记录仅用于修正已经核实的数据库事实。', '',
  ...corrections.records.map(r => `- ${ids.get(r.id)?.name ?? catalog.find(i => i.zolId === r.id)?.name ?? r.id}：[官方资料](${r.sourceUrl})。${r.reason}`),
  '- RX 6500 XT：[ASRock 官方接口规格](https://www.asrock.com/Graphics-Card/AMD/Radeon%20RX%206500%20XT%20Phantom%20Gaming%20D%204GB%20OC/index.asp)支持 PCIe 4.0 x4 的链路事实，不用于假定所有品牌尺寸、供电或显存变体完全相同。', '',
  '## 搜索与关键替代方案', '',
  '保留 V2 有界组合枚举。CPU 按平台保留候选，避免一个平台的裸 CPU 跑分淘汰另一平台所有组合。AI 显卡按价格、显存和渲染算力的多维 Pareto 保留候选。组合阶段记录预算剪枝、规格 FAIL、品质下限、Top-K、各候选使用的真实目录价格与价格来源。日志位于 配置/候选日志，原始响应也保存在每组 JSON。', '',
  '日志中的 GPU 替代项包含最低完整成本、各档预算内组合数、最好分项评分、原始分数减成本目标值、最终目标值及排除原因。相同芯片显存仍选代表卡，CPU 每平台保留有限候选，电源、散热和机箱按证据补齐；不是全量笛卡尔积，不声明全局最优。最低完整成本是本次有界搜索所找到的最低值。', '',
];
for (const [prefix, title, pattern] of [['11_', '20000 元 AI 的 RTX 3090 与 RTX 4090', /3090|4090/], ['07_', '15000 元 4K 的 RTX 5070 Ti 与 4080 SUPER 及 5080', /5070 Ti|4080 SUPER|5080/]]) {
  const file = (await readdir('配置/候选日志')).find(f => f.startsWith(prefix));
  const meta = await read(`配置/候选日志/${file}`);
  lines.push(`### ${title}`, '', '| 候选 | 部件目录价 | 最低完整成本 | 推荐档预算内组合数 | 取舍 |', '|---|---:|---:|---:|---|');
  const alternatives = meta.gpuAlternatives.filter(a => pattern.test(a.name));
  for (const a of alternatives) { const tier = a.tierDecisions.find(t => t.tier === 'balanced'); lines.push(`| ${a.name} | ${money(a.gpuPriceCents)} | ${money(a.minimumBuildCents)} | ${tier?.withinBudget ?? 0} | ${tier?.reason ?? a.reason} |`); }
  const excluded = [...meta.candidateLog, ...(meta.catalogFilter?.excluded ?? [])].filter(i => pattern.test(i.name) && !i.retained);
  lines.push('', `该组另有 ${excluded.length} 条相关卡的变体因同芯片代表、价格 / 多维支配、搜索宽度或目录质量门槛排除；逐条原因见日志，不把未进入组合枚举的条目称为已经穷尽验证。`, '');
}
lines.push('## 12 组修改前后对比', '', '价格顺序均为省钱版 / 推荐版 / 进阶版。普通模式保留独立的超预算替代；同一组另执行严格预算模式。评分版本已经变化，不能把 V2 与 V2.1 的分数变化解读为硬件性能变化。', '', '| 组 | 输入 / 用途 | V2 合计 | V2.1 合计 | 本轮结论 |', '|---|---|---|---|---|');
for (const c of after.cases) {
  const old = before.cases.find(b => b.index === c.index);
  lines.push(`| ${c.index} | ${money(c.request.budgetCents)} ${c.label} | ${byCase(old.variants)} | ${byCase(c.variants)} | ${c.variants.map(v => `${v.id}: ${v.recommendationStatus}`).join('；')} |`);
}
lines.push('', `机箱分布：V2 为 ${freq(previous.map(v => slot(v, 'CASE')?.model))}；V2.1 为 ${freq(all.map(v => slot(v, 'CASE')?.model))}。变化来自支持集合与负载证据筛选，没有随机更换、固定价格比例或按预算强制买贵机箱。`, '', `散热分布：V2.1 为 ${freq(all.map(v => slot(v, 'COOLER')?.model))}。原装散热同样带条件说明，不声称覆盖持续满载；高功耗散热仍需温度实测。`, '', '## 场景与价格管理', '',
  '保留六个一级用途，新增具体游戏、画质、目标 FPS；4K 光栅、光追、原生、超分和帧生成；PR、达芬奇、剪映、Blender 和素材分辨率；LLM、ComfyUI、AI 视频、训练、微调。细分权重和建议容量是明确的启发式偏好，对应场景实测缺失时显示代理与低可信度，不把 2K 光栅、Blender 或显存推导成真实场景 FPS / 吞吐。', '',
  '数据质量报告检查估算时间、老型号库存、内存容量价格倒挂、相同厂商料号关联不同规格、缺少持续散热证据及官方修正。价格管理继续支持手动与已核实记录；新增规格修正表单及 PUT /api/v1/catalog/:id/specs，必须有 HTTPS 资料来源，写入 spec-overrides.json 后即时参与下一次搜索。既有已保存方案保留当时规格快照。', '',
  '3300X、RTX 3090 的 11999 元、RX 6500 XT 8GB 的 699 元及 32GB/64GB 倒挂都保留来源与库存未知状态，未凭经验改价。RTX 4090、5080 是否进入候选取决于本次目录的来源市场、估算质量及对应组合成本；不把有目录价等同于仍有全新现货。完整数据见 配置/数据质量报告.json。', '',
  '## 自动化验证', '',
  `- npm test：${testCounts.backend} 项通过，${testCounts.backendFailures} 项失败，日志 后端完整测试.txt。`,
  `- npm run web:test：${testCounts.frontend} 项通过，日志 前端完整测试.txt。`,
  `- npm --prefix web run build：${testCounts.buildPassed ? 'TypeScript 与生产构建通过' : '构建未通过'}，日志 前端构建.txt。`,
  '- node scripts/test-configurations.mjs：12 组 × 普通/严格预算模式，36 套普通模式导出；全部方案备份导入与重读一致。每组 JSON 带 strictResponse，严格模式预算不足时不输出正式超支推荐。',
  '- test/v21.test.mjs 的编号 01–16 对应本轮要求的 16 类通用回归，使用隔离的合成硬件、价格和温度记录；另有规格修正 API 与数据质量测试。合成测量没有写入真实目录。', '',
  '## 尚未满足的数据验收', '',
  '1. 高功耗配置尚不能证明持续散热合格。已补充功耗、风道布局、空间和温度证据字段与判据，但本机目录没有覆盖这些实际 CPU/GPU/机箱组合的持续温度与噪音实测。对应方案为 UNKNOWN、非正式已确认推荐；需要按实际安装布局取得测试记录后才能 PASS。',
  '2. 多数 PCIe 链路仍缺 CPU 的显卡 / 存储控制器通道数据或逐个 M.2 共享说明，不能报告精确实际带宽。A520 上限及已知 x4 限制已修正；其他未核实字段继续 UNKNOWN。七彩虹给定产品页本次返回 502，不能声称已读到该页手册。',
  '3. 没有新增授权的实时电商接口。导出仍主要是本地估算，库存和商品状态未知；价格倒挂已列入报告而未擅改。',
  '4. 对应游戏 FPS、4K 光追、超分、帧生成、剪辑编码、LLM 和训练的真实基准尚未收集。已增加入口、偏好和独立指标承载，但目前使用明确标记的代理；细分软件不等于已实测。',
  '5. 搜索受候选宽度与代表卡限制，未证明全局最优；部分替代只在现有目录与搜索范围内比较。', '',
  '## 修改文件与交付路径', '',
  ...[...new Set([...changed, ...additions])].filter(Boolean).map(f => `- ${f}`), '',
  '完整跟踪文件差异：代码差异.patch；新增模块保存在项目源码中。12 份新 Markdown 与对应 JSON：项目根目录“配置”；可恢复总备份：配置/全部方案_可导入备份.json；逐组比较：12组前后对比.json；冻结的 V2 结果：baseline-v2。', '',
  '复现：先 npm test、npm run web:test、npm --prefix web run build，再 node scripts/test-configurations.mjs，最后 node scripts/report-v21.mjs。测试脚本不修改用户已保存方案；需开放本机回环连接。', '',
);
await writeFile(`${root}/V2.1开发报告.md`, lines.join('\n'));
await writeFile(`${root}/验收摘要.json`, JSON.stringify({ ...testCounts, ...compare.after, caseCount: after.caseCount, importedReadback: after.restoreReadbackPassed }, null, 2));
console.log(JSON.stringify({ report: `${root}/V2.1开发报告.md`, testCounts, ...compare.after }));
