// 用本地 .env 里的京东联盟密钥实际查询一次，确认签名与权限是否正常。只打印商品与价格，不打印密钥。
//   npm run jd:check -- https://item.jd.com/100012345678.html
import { JdUnion } from '../src/jdunion.mjs';
import { formatCents } from './format.mjs';

const inputs = process.argv.slice(2);
if (!inputs.length) {
  console.error('用法：npm run jd:check -- <京东商品链接或 SKU> [更多…]');
  process.exit(1);
}
const jd = new JdUnion({ directory: '.runtime' });
if (!jd.configured) {
  console.error('未读取到 JD_UNION_APP_KEY / JD_UNION_APP_SECRET：请确认项目根目录的 .env 已填写。');
  process.exit(1);
}
try {
  const { items, missing, cached } = await jd.lookup(inputs);
  for (const i of items) {
    console.log(`${i.skuId}  京东价 ${formatCents(i.unitPriceCents)}  手机价 ${formatCents(i.mobilePriceCents)}  ${i.isJdSale ? '自营' : '非自营'}  ${i.name}`);
  }
  if (missing.length) console.log(`未返回：${missing.join(', ')}（多半不在联盟推广中，不代表没有价格）`);
  console.log(cached ? '（30 分钟内的缓存结果）' : '（实时查询成功）');
} catch (error) {
  console.error(`查询失败 [${error.code ?? error.name}]：${error.message}`);
  process.exitCode = 1;
}
