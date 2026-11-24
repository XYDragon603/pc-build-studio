import { useState } from 'react';
import { parseYuan } from '../domain/money';
import type { CustomPart } from '../domain/types';
import { Dialog } from './Dialog';

export function CustomPartDialog({ open, onClose, onAdd }: { open: boolean; onClose: () => void; onAdd: (p: CustomPart) => void }) {
  return (
    <Dialog open={open} title="添加自定义配件" onClose={onClose}>
      {open && <Form onClose={onClose} onAdd={onAdd} />}
    </Dialog>
  );
}

function Form({ onClose, onAdd }: { onClose: () => void; onAdd: (p: CustomPart) => void }) {
  const [name, setName] = useState('');
  const [spec, setSpec] = useState('');
  const [price, setPrice] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const cents = price.trim() === '' ? null : parseYuan(price);
  const nameErr = !name.trim() ? '请填写配件名称' : null;
  const priceErr = price.trim() !== '' && cents == null ? '请输入有效金额' : null;

  return (
    <form
      className="dialog-body"
      onSubmit={e => {
        e.preventDefault();
        setSubmitted(true);
        if (nameErr || priceErr) return;
        onAdd({ id: `custom-${Date.now().toString(36)}`, name: name.trim(), spec: spec.trim(), priceCents: cents });
        onClose();
      }}
    >
      <p className="muted small">例如机箱风扇、无线网卡、延长线。自定义配件计入合计，但不参与兼容性检查。</p>
      <label className="field">
        <span>名称</span>
        <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="ARGB 机箱风扇" aria-invalid={submitted && !!nameErr} />
        {submitted && nameErr && <span className="field-error">{nameErr}</span>}
      </label>
      <label className="field">
        <span>规格（可选）</span>
        <input value={spec} onChange={e => setSpec(e.target.value)} placeholder="120mm × 3" />
      </label>
      <label className="field">
        <span>价格（可选）</span>
        <div className="money-input">
          <span>¥</span>
          <input inputMode="decimal" value={price} onChange={e => setPrice(e.target.value)} placeholder="留空表示价格未知" aria-invalid={submitted && !!priceErr} />
        </div>
        {submitted && priceErr && <span className="field-error">{priceErr}</span>}
      </label>
      <footer className="dialog-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>取消</button>
        <button type="submit" className="btn btn-primary">添加</button>
      </footer>
    </form>
  );
}
