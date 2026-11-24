import { CircleAlert, CircleCheck, CircleX, Info, Puzzle } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Check } from '../domain/compat';

const ICON = { ok: CircleCheck, warn: CircleAlert, error: CircleX } as const;

export function CompatStrip({ checks, action }: { checks: Check[]; action: ReactNode }) {
  return (
    <div className="compat">
      <div className="compat-card">
        <span className="compat-title"><Puzzle size={22} strokeWidth={1.6} /> 兼容性提示</span>
        <ul>
          {checks.map(c => {
            const Icon = ICON[c.level];
            return (
              <li key={c.id} className={`compat-item ${c.level}`}>
                <Icon size={18} aria-hidden="true" />
                <span>{c.label}</span>
                <span className="tip" tabIndex={0} aria-label={c.detail}>
                  <Info size={15} aria-hidden="true" />
                  <span role="tooltip">{c.detail}</span>
                </span>
              </li>
            );
          })}
        </ul>
      </div>
      {action}
    </div>
  );
}
