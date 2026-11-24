import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApiError } from './api-error.mjs';

export class LocalStore {
  constructor(directory = '.runtime') { this.directory = path.resolve(directory); }

  async read(name, fallback) {
    try { return JSON.parse(await readFile(path.join(this.directory, name), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  }

  async write(name, value) {
    await mkdir(this.directory, { recursive: true });
    const temp = path.join(this.directory, `${name}.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
      await rename(temp, path.join(this.directory, name));
    } finally { await unlink(temp).catch(() => {}); }
  }

  async withLock(name, action) {
    await mkdir(this.directory, { recursive: true });
    const lockPath = path.join(this.directory, name);
    let lock;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { lock = await open(lockPath, 'wx'); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    if (!lock) throw new ApiError(503, 'STORE_BUSY', `本地数据正在保存，请稍后重试。若持续失败，请确认没有运行中的任务后检查 ${name}。`);
    try {
      return await action();
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  }

  // Across CLI processes, reserve a request before sending it. Never silently reset a corrupt ledger.
  async reserveRequest({ limit, unitCost, now = Date.now() }) {
    return this.withLock('usage.lock', async () => {
      const days = await this.read('usage.json', {});
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
      const usage = days[day] ?? { attemptedRequests: 0, estimatedGrossUsd: 0, unpricedRequests: 0 };
      if (!Number.isSafeInteger(usage.attemptedRequests) || usage.attemptedRequests < 0) throw new Error('调用记录无效，已停止请求');
      if (usage.attemptedRequests >= limit) throw new ApiError(429, 'DAILY_SEARCH_LIMIT', `今日搜索上限 ${limit} 次已用完`);
      usage.attemptedRequests++;
      if (unitCost === null) usage.unpricedRequests++;
      else usage.estimatedGrossUsd = Math.round((usage.estimatedGrossUsd + unitCost) * 1e8) / 1e8;
      days[day] = usage;
      await this.write('usage.json', days);
      return { day, ...usage };
    });
  }
}
