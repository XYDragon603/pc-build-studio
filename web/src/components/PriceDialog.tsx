import { ExternalLink, Loader2, ShoppingCart } from 'lucide-react';
import { useState } from 'react';
import { api, ApiError, type JdLookup } from '../api/client';
import { formatYuan, parseYuan } from '../domain/money';
import { Dialog } from './Dialog';

/** 价格的出处：用户手填，或从京东联盟取到的京东价 */
export interface PriceOrigin {
  kind: 'manual' | 'jd';
  jdUrl?: string;
  observedAt?: string;
}

export interface PriceRequest {
  title: string;
  subject: string;
  hint: string;
  initialCents: number | null;
  sourceUrl?: string;
  /** 京东商品链接预填（来自查价结果） */
  jdLink?: string;
  /** 是否允许清空为“价格未知” */
  allowUnknown?: boolean;
  onConfirm: (cents: number | null, origin: PriceOrigin) => void;
}

export function PriceDialog({ request, jdEnabled, onClose }: { request: PriceRequest | null; jdEnabled: boolean; onClose: () => void }) {
  return (
    <Dialog open={!!request} title={request?.title ?? ''} onClose={onClose} width={480}>
      {request && <PriceForm key={request.subject} request={request} jdEnabled={jdEnabled} onClose={onClose} />}
    </Dialog>
  );
}

function PriceForm({ request, jdEnabled, onClose }: { request: PriceRequest; jdEnabled: boolean; onClose: () => void }) {
  const [text, setText] = useState(request.initialCents == null ? '' : String(request.initialCents / 100));
  const [touched, setTouched] = useState(false);
  const [origin, setOrigin] = useState<PriceOrigin>({ kind: 'manual' });
  const cents = parseYuan(text);
  const empty = text.trim() === '';
  const error = empty ? (request.allowUnknown ? null : '请输入价格') : cents == null ? '请输入有效金额，最多两位小数' : null;

  return (
    <form
      className="dialog-body"
      onSubmit={e => {
        e.preventDefault();
        setTouched(true);
        if (error) return;
        request.onConfirm(empty ? null : cents, origin);
        onClose();
      }}
    >
      <p className="dialog-subject">{request.subject}</p>
      <p className="muted small">{request.hint}</p>
      {request.sourceUrl && (
        <a className="link" href={request.sourceUrl} target="_blank" rel="noreferrer noopener">
          打开来源页核对 <ExternalLink size={14} />
        </a>
      )}
      {jdEnabled && (
        <JdPriceLookup
          initialLink={request.jdLink ?? ''}
          onUse={(c, o) => { setText(String(c / 100)); setOrigin(o); setTouched(true); }}
        />
      )}
      <label className="field">
        <span>到手价（元）</span>
        <div className="money-input">
          <span>¥</span>
          <input
            autoFocus={!jdEnabled}
            inputMode="decimal"
            value={text}
            onChange={e => { setText(e.target.value); setOrigin({ kind: 'manual' }); }}
            onBlur={() => setTouched(true)}
            placeholder={request.allowUnknown ? '留空表示价格未知' : '例如 3999'}
            aria-invalid={touched && !!error}
          />
        </div>
        {touched && error && <span className="field-error">{error}</span>}
        {origin.kind === 'jd' && <span className="muted small">已填入京东联盟查到的京东价，未含优惠券、补贴；有优惠可以直接改成实付价。</span>}
        {cents === 0 && <span className="muted small">¥0 表示已有配件，与“价格未知”分开记录。</span>}
      </label>
      <footer className="dialog-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>取消</button>
        <button type="submit" className="btn btn-primary">确认价格</button>
      </footer>
    </form>
  );
}

function JdPriceLookup({ initialLink, onUse }: { initialLink: string; onUse: (cents: number, origin: PriceOrigin) => void }) {
  const [link, setLink] = useState(initialLink);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<JdLookup | null>(null);
  const [error, setError] = useState<string | null>(null);

  const lookup = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.jdPrices([link.trim()]));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '查询失败');
    } finally {
      setLoading(false);
    }
  };

  const item = result?.items[0];
  return (
    <div className="jd-lookup">
      <label className="field">
        <span>京东商品链接或编号</span>
        <div className="jd-row">
          <input
            autoFocus
            value={link}
            onChange={e => setLink(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (link.trim()) lookup(); } }}
            placeholder="https://item.jd.com/100012345678.html"
          />
          <button type="button" className="btn btn-outline" disabled={!link.trim() || loading} onClick={lookup}>
            {loading ? <Loader2 size={16} className="spin" /> : <ShoppingCart size={16} />} 取京东价
          </button>
        </div>
      </label>
      {error && <p className="field-error" role="alert">{error}</p>}
      {result && !item && <p className="muted small">联盟没有返回这件商品，可能不在推广中（不代表没有价格），请手动填写。</p>}
      {item && (
        <div className="jd-result">
          <div>
            <strong>{item.unitPriceCents != null ? formatYuan(item.unitPriceCents) : '京东价未知'}</strong>
            <span className="muted small"> 京东价{item.isJdSale ? ' · 自营' : ''} · 未含优惠{result.cached ? ' · 30 分钟内缓存' : ''}</span>
            <p className="muted small jd-name" title={item.name}>{item.name}</p>
          </div>
          {item.unitPriceCents != null && (
            <button type="button" className="btn btn-soft" onClick={() => onUse(item.unitPriceCents!, { kind: 'jd', jdUrl: item.url, observedAt: item.observedAt })}>
              填入
            </button>
          )}
        </div>
      )}
    </div>
  );
}
