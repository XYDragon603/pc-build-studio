import test from 'node:test';
import assert from 'node:assert/strict';
import { boardFormFactor, countOf, listPage, maxRadiator, parseList, parseParams, parseRamCapacity, parseSockets } from '../scripts/import-zol.mjs';

// 按 ZOL 页面结构写的最小合成片段，不含站点原文
const list = `
<li class="nth-child-3n" data-follow-id="p2130983" >
  <a href="/vga/index2130983.shtml" class="pic"><img width="220" .src="https://2d.zol-img.com.cn/product/x.png" alt="示例"></a>
  <h3><a href="/vga/index2130983.shtml" title="t">示例品牌GeForce RTX 5060 Ti 测试版 16G <span>卖点副标题</span></a></h3>
  <div class="price-row"><span class="price-tip">参考价：</span><span class="price"><b class="price-sign">￥</b><b class="price-type">4099</b></span></div>
</li>
<li data-follow-id="p1"><h3><a href="#">无价格商品</a></h3><b class="price-type">概念产品</b></li>`;

const param = `<title>【示例参数】EXAMPLE GeForce RTX 5060 Ti TEST 16G显卡参数_规格</title>
<div class="breadcrumb"><a>ZOL报价首页</a> &gt; <a>显卡</a> &gt; <a>技嘉显卡</a> &gt; 示例 &gt; 参数</div>
<tr><th><span id="newPmName_0">产品型号</span></th><td><span id="newPmVal_0">GV-TEST-16GD</span><em>纠错</em></td></tr>
<tr><th><span id="newPmName_1">产品尺寸</span></th><td><span id="newPmVal_1">281×119×40mm</span></td></tr>
<tr><th><span id="newPmName_2">建议电源</span></th><td><span id="newPmVal_2">650W</span></td></tr>`;

test('ZOL 列表页：去掉卖点副标题，未知价格保留 null', () => {
  const items = parseList(list);
  assert.deepEqual(items[0], { zolId: '2130983', name: '示例品牌GeForce RTX 5060 Ti 测试版 16G',
    referencePriceCents: 409900, imageUrl: 'https://2d.zol-img.com.cn/product/x.png' });
  assert.equal(items[1].referencePriceCents, null);
});

test('ZOL 列表页地址：默认与热门排序分页、缓存名互不冲突', () => {
  assert.deepEqual(listPage('solid_state_drive', 1), { url: 'https://detail.zol.com.cn/solid_state_drive/', cacheName: 'list-solid_state_drive-1.html' });
  assert.deepEqual(listPage('solid_state_drive', 2, 'hot'), { url: 'https://detail.zol.com.cn/solid_state_drive/hot_2.html', cacheName: 'list-solid_state_drive-hot-2.html' });
  assert.equal(listPage('vga', 1, 'hot').url, 'https://detail.zol.com.cn/vga/hot.html');
});

test('ZOL 列表页：系列产品的价格区间单独记录，不当成参考价', () => {
  const [item] = parseList('<li data-follow-id="p9"><h3><a href="#">示例固态硬盘系列</a></h3><b class="price-type">359-1799</b></li>');
  assert.equal(item.referencePriceCents, null);
  assert.deepEqual(item.priceRangeCents, [35900, 179900]);
});

test('ZOL 参数页：读取参数表、英文名与中文品牌，不把“纠错”带进值', () => {
  const r = parseParams(param, '显卡');
  assert.equal(r.params['产品型号'], 'GV-TEST-16GD');
  assert.equal(r.params['产品尺寸'], '281×119×40mm');
  assert.equal(r.englishName, 'EXAMPLE GeForce RTX 5060 Ti TEST 16G');
  assert.equal(r.brand, '技嘉');
});

test('散热器适用范围解析为插槽列表', () => {
  assert.deepEqual(parseSockets('Intel：LGA 115X/1200/1700 AMD：AM4/AM5'), ['LGA115X', 'LGA1200', 'LGA1700', 'AM4', 'AM5']);
  assert.equal(parseSockets('通用'), undefined);
});

test('内存容量与板型解析', () => {
  assert.deepEqual(parseRamCapacity('套装（2×16GB）'), { modules: 2, capacityGB: 32 });
  assert.deepEqual(parseRamCapacity('16GB'), { modules: 1, capacityGB: 16 });
  assert.equal(boardFormFactor('Micro ATX板型'), 'Micro ATX');
  assert.equal(boardFormFactor('MATX'), 'Micro ATX');
  assert.equal(boardFormFactor('Mini-ITX板型'), 'Mini-ITX');
  assert.equal(boardFormFactor('E-ATX板型'), 'EATX');
  assert.equal(boardFormFactor('ATX板型'), 'ATX');
});

test('机箱冷排支持只认标准尺寸', () => {
  assert.equal(maxRadiator('顶置：360冷排（长度在395mm以内） 主板前侧置：360冷排'), 360);
  assert.equal(maxRadiator('顶置：支持140水冷 后置：支持120水冷'), 140);
  assert.equal(maxRadiator('支持120mm，240mm，280mm，360mm水冷'), 360);
  assert.equal(maxRadiator(undefined), undefined);
});

test('核心 / 线程数支持中文数字', () => {
  assert.equal(countOf('四核心'), 4);
  assert.equal(countOf('十二核心'), 12);
  assert.equal(countOf('二十四核心(8P+16E)'), 24);
  assert.equal(countOf('十六线程'), 16);
  assert.equal(countOf('8核心'), 8);
  assert.equal(countOf('十核心'), 10);
  assert.equal(countOf(undefined), undefined);
});
