import { Check, ChevronRight, Lock } from 'lucide-react';
import { Fragment } from 'react';
import { SLOTS } from '../domain/slots';
import type { Build, SlotId } from '../domain/types';
import { SLOT_ICONS } from './icons';

export function StepNav({ build, active, onSelect }: { build: Build; active: SlotId; onSelect: (id: SlotId) => void }) {
  return (
    <nav className="steps" aria-label="配件步骤">
      {SLOTS.map((s, i) => {
        const state = build.slots[s.id];
        const Icon = SLOT_ICONS[s.id];
        const isActive = s.id === active;
        const status = state.locked ? '已锁定' : state.part ? '已选择' : '未选择';
        return (
          <Fragment key={s.id}>
            {i > 0 && <ChevronRight className="step-sep" size={16} aria-hidden="true" />}
            <button
              type="button"
              className={`step${isActive ? ' is-active' : ''}${state.part ? ' is-done' : ''}`}
              aria-current={isActive ? 'step' : undefined}
              aria-label={`${i + 1} ${s.label}，${status}`}
              onClick={() => onSelect(s.id)}
            >
              <Icon size={20} strokeWidth={1.6} />
              <span className="step-num">{i + 1}</span>
              <span className="step-label">{s.label}</span>
              {state.locked ? <Lock size={15} className="step-mark" /> : state.part ? <Check size={16} className="step-mark ok" /> : null}
            </button>
          </Fragment>
        );
      })}
    </nav>
  );
}
