import { describe, expect, it } from 'vitest';
import { scenariosOf } from '../next/Home';
import { PURPOSES, purposeOfScenarios, vramHint } from './purposes';

// 后端 src/recommend.mjs 的用途档案；两边的 scenario 名必须一致
const backendPath = '../../../src/recommend.mjs';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const backend: any = await import(/* @vite-ignore */ backendPath);

describe('使用场景', () => {
  it('每个下拉选项都对应后端的一个用途档案', () => {
    for (const p of PURPOSES) expect(backend.profileOf([p.scenario]).key).toBe(p.scenario);
  });

  it('选项转成发给后端的 scenarios；安静优先附加在后面', () => {
    expect(scenariosOf('ai', false)).toEqual(['ai']);
    expect(scenariosOf('game', true)).toEqual(['2k', 'quiet']);
    expect(purposeOfScenarios(['creator', 'quiet'])?.label).toBe('视频剪辑 / 设计');
    expect(purposeOfScenarios(['quiet'])).toBeNull();
  });

  it('AI 方案按显存给模型大小的粗略参考', () => {
    expect(vramHint(8)).toMatch(/7B 左右/);
    expect(vramHint(16)).toMatch(/14B–20B/);
    expect(vramHint(24)).toMatch(/30B/);
    expect(vramHint(undefined)).toBeNull();
  });
});

describe('方案默认名', () => {
  it('档位 · 用途 · 日期，不含价格', async () => {
    const { planName } = await import('./plan');
    expect(planName('推荐版', ['ai', 'quiet'], new Date(2026, 10, 25))).toBe('推荐版 · AI / 机器学习 · 11/25');
    expect(planName('省钱版', ['quiet'], new Date(2026, 0, 3))).toBe('省钱版 · 1/3');
    expect(planName('进阶版', ['2k'])).not.toMatch(/¥/);
  });
});
