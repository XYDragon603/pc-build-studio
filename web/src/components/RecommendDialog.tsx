import { Loader2, Lock, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, ApiError, type RecommendResult } from '../api/client';
import { API_TO_SLOT } from '../api/mapping';
import { formatYuan } from '../domain/money';
import { SLOTS } from '../domain/slots';
import type { Build, SlotId } from '../domain/types';
import { Dialog } from './Dialog';

interface Props {
  open: boolean;
  build: Build;
  onClose: () => void;
  onApply: (result: RecommendResult) => void;
}

export function RecommendDialog({ open, build, onClose, onApply }: Props) {
  return (
    <Dialog open={open} title="按预算自动配" onClose={onClose} width={760}>
      {open && <Body build={build} onClose={onClose} onApply={onApply} />}
    </Dialog>
  );
}

function Body({ build, onClose, onApply }: Omit<Props, 'open'>) {
  const [result, setResult] = useState<RecommendResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // 锁定的配件原样保留，把它们的价格与规格交给服务端参与计算
    const locked = Object.fromEntries(SLOTS.filter(s => build.slots[s.id].locked && build.slots[s.id].part).map(s => {
      const part = build.slots[s.id].part!;
      const apiSlot = Object.entries(API_TO_SLOT).find(([, id]) => id === s.id)![0];
      return [apiSlot, { priceCents: part.priceCents ?? 0, specs: part.specs }];
    }));
    api.recommend({ budgetCents: build.budgetCents, scenarios: build.scenarios, locked })
      .then(setResult)
      .catch(e => setError(e instanceof ApiError ? e.message : '生成失败'));
  }, [build]);

  if (error) return <div className="dialog-body"><p className="field-error" role="alert">{error}</p></div>;
  if (!result) return <div className="dialog-body"><p className="empty-note"><Loader2 size={16} className="spin" /> 正在按预算挑选…</p></div>;

  const bySlot = new Map(result.picks.map(p => [API_TO_SLOT[p.slot], p]));
  const over = result.totalCents > result.budgetCents;
  return (
    <div className="dialog-body">
      <p className="muted small">
        预算 {formatYuan(result.budgetCents)}，用途：{build.scenarios.length ? build.scenarios.join('、') : '未设置'}。锁定的配件保留不动，其余按估算价挑选，应用后都可以再改。
      </p>
      <table className="rec-table">
        <tbody>
          {SLOTS.map(({ id, label }) => {
            const s = build.slots[id];
            const pick = bySlot.get(id as SlotId);
            return (
              <tr key={id}>
                <th>{label}</th>
                {s.locked && s.part ? (
                  <td colSpan={2}><span className="muted"><Lock size={13} /> 已锁定：{s.part.name}</span></td>
                ) : pick ? (
                  <>
                    <td>
                      <div className="rec-name">{pick.item.name}</div>
                      <div className="muted small">{pick.item.summary}</div>
                      <div className="rec-reason">{pick.reason}</div>
                    </td>
                    <td className="rec-price">约 {formatYuan(pick.item.estimatedPriceCents!)}</td>
                  </>
                ) : (
                  <td colSpan={2} className="muted">没有找到合适的型号，请手动选择</td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className={`rec-total${over ? ' over' : ''}`}>
        估算总价 <strong>{formatYuan(result.totalCents)}</strong>
        <span>{over ? `超出预算 ${formatYuan(result.totalCents - result.budgetCents)}` : `剩余 ${formatYuan(result.budgetCents - result.totalCents)}`}</span>
      </div>
      <ul className="rec-notes">{result.notes.map(n => <li key={n}>{n}</li>)}</ul>
      <footer className="dialog-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>取消</button>
        <button type="button" className="btn btn-primary" disabled={!result.picks.length} onClick={() => { onApply(result); onClose(); }}>
          <Sparkles size={16} /> 应用到方案（{result.picks.length} 件）
        </button>
      </footer>
    </div>
  );
}
