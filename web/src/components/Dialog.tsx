import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';

interface Props {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}

/** 基于原生 <dialog>：自带焦点限制、Esc 关闭与背景遮罩。 */
export function Dialog({ open, title, onClose, children, width = 440 }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="dialog"
      style={{ width }}
      onClose={onClose}
      onClick={e => { if (e.target === ref.current) onClose(); }}
      aria-label={title}
    >
      {open && (
        <div className="dialog-inner">
          <header className="dialog-head">
            <h2>{title}</h2>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭"><X size={18} /></button>
          </header>
          {children}
        </div>
      )}
    </dialog>
  );
}
