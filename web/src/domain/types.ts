export type CoreSlotId = 'cpu' | 'gpu' | 'board' | 'ram' | 'ssd' | 'psu' | 'case' | 'cooler';
/** 外设：可选，单独计价，不参与兼容性与“还差几件” */
export type PeripheralId = 'monitor' | 'keyboard' | 'mouse';
export type SlotId = CoreSlotId | PeripheralId;

/**
 * 候选的报价状态（界面用）：
 * confirmed = 可直接加入（演示确认 / 后端校验通过 / 用户手动核实）
 * review    = 有页面标价但附带条件或未校验，需要核实
 * missing   = 没有可归属的价格，需要手动填价
 * 后端 rejected 的结果不做成卡片，只进“已过滤”折叠区。
 */
export type PriceState = 'confirmed' | 'review' | 'missing';

/** 与后端 part.specs 字段一致，用于兼容性计算 */
export interface PartSpecs {
  socket?: string;
  memoryType?: string;
  /** CPU / 显卡峰值功耗，W */
  maxPowerWatts?: number;
  /** 电源额定功率，W */
  ratedWatts?: number;
  /** 显卡厂商建议电源功率，W */
  recommendedPsuWatts?: number;
  /** 显卡长度，mm */
  lengthMm?: number;
  /** 风冷散热器高度，mm */
  heightMm?: number;
  /** 机箱显卡限长，mm */
  maxGpuLengthMm?: number;
  /** 机箱散热器限高，mm */
  maxCoolerHeightMm?: number;
  /** 水冷冷排尺寸，mm（如 240、360） */
  radiatorSizeMm?: number;
  /** 机箱支持的最大冷排，mm */
  maxRadiatorMm?: number;
  /** 主板板型（大写：MINI-ITX / MICRO ATX / ATX / EATX） */
  formFactor?: string;
  /** 机箱支持的最大主板板型（大写） */
  maxBoardFormFactor?: string;
  /** 显卡供电接口（大写，如 8PIN、16PIN） */
  gpuPowerConnector?: string;
  /** 电源带原生 16pin 显卡供电线 */
  native16Pin?: boolean;
  // —— 以下字段与目录（catalog specs）同名，供 src/compat-rules.mjs 直接判断 ——
  /** 主板芯片组（如 B650）、显卡芯片（如 GEFORCE RTX 5070） */
  chipset?: string;
  /** CPU 核显说明（ZOL 对 F 系列写“不支持”） */
  integratedGraphics?: string;
  /** 显卡需要的供电接口数量 */
  powerPins?: { pin6?: number; pin8?: number; pin16?: number; none?: boolean };
  /** 显卡整卡功耗（厂商标注），W */
  boardPowerWatts?: number;
  /** Intel Arc：需要开启 Resizable BAR */
  needsResizableBar?: boolean;
  /** 电源显卡供电接口数量 */
  pcie8Count?: number;
  pcie6Count?: number;
  pin16Count?: number;
  /** 电源 12V 输出电流（单路），A；多路时为各路电流 */
  rail12vAmps?: number;
  rail12vSplitAmps?: number[];
  atxVersion?: string;
  /** 主板 */
  memorySlots?: number;
  maxMemoryGB?: number;
  videoOutputs?: boolean;
  pcieGen?: number;
  m2Slots?: number;
  vrmPhases?: number;
  /** 内存 */
  capacityGB?: number;
  modules?: number;
  speedMTs?: number;
  /** 散热器支持的插槽 */
  sockets?: string[];
  /** 固态接口（如 M.2 PCIe 4.0） */
  interface?: string;
}

export type CandidateSource = 'demo' | 'replay' | 'live' | 'catalog';

export interface Candidate {
  id: string;
  slot: SlotId;
  source: CandidateSource;
  name: string;
  spec: string;
  /** 配置摘要里展示的精简规格，缺省取 spec 前两段 */
  summarySpec?: string;
  store: 'jd' | 'other';
  storeLabel: string;
  condition: 'new' | 'used';
  capacityGB?: number;
  /** 可计入配置的价格（整数分）；未知为 null，绝不用 0 补位 */
  priceCents: number | null;
  /** 页面上看到但未确认的价格，只作参考，不计入合计 */
  referenceCents?: number | null;
  state: PriceState;
  /** 后端校验通过（accepted） */
  verified?: boolean;
  /** 简短状态，例如“需登录确认” */
  reviewNote?: string;
  /** 后端给出的完整原因 */
  reasons?: string[];
  observedAt?: string | null;
  url: string | null;
  /** 型号目录 ID */
  catalogId?: string;
  /** 目录估算价：ZOL 参考价，或同芯片同显存中位价 */
  estimate?: { cents: number; basis: import('../api/client').EstimateBasis; samples: number; observedAt: string | null };
  /** 性能参考（CPU / 显卡） */
  performance?: { key: string; blender: { score: number; runs: number; api: string } | null; gaming: { index: number; label: string | null } | null };
  /** 参考价走势（有价格历史时） */
  priceTrend?: { previousCents: number | null; changedAt: string | null; lowestCents: number; since: string; points: number };
  /** 商品图（目录数据），加载失败时退回示意图 */
  imageUrl?: string | null;
  specs?: PartSpecs;
  art?: { fans: 2 | 3; accent: string; body: string };
}

export interface Part {
  name: string;
  spec: string;
  /** 整数分；0 表示已知零价（已有配件），null 表示价格未知 */
  priceCents: number | null;
  quantity: number;
  /** estimate：按目录参考价估算，计入合计但单独标注 */
  priceSource: 'manual' | 'demo' | 'estimate';
  /** 对应的型号目录 ID，用于刷新估算价 */
  catalogId?: string | null;
  note: string;
  url: string | null;
  specs: PartSpecs;
}

export interface SlotState {
  part: Part | null;
  locked: boolean;
}

export interface CustomPart {
  id: string;
  name: string;
  spec: string;
  priceCents: number | null;
}

export interface Build {
  /** 本地标识；已保存到服务端时与 serverId 相同 */
  id: string;
  serverId?: string;
  /** 服务端版本号，用于乐观并发控制 */
  version?: number;
  name: string;
  budgetCents: number;
  scenarios: string[];
  slots: Record<SlotId, SlotState>;
  custom: CustomPart[];
  updatedAt: string;
}
