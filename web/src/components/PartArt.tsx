import { useState } from 'react';
import type { Candidate } from '../domain/types';
import { SLOT_ICONS } from './icons';

/** 显卡示意图：不使用任何品牌图形，只按风扇数与配色区分。 */
function GpuArt({ fans, accent, body }: { fans: 2 | 3; accent: string; body: string }) {
  const w = 300;
  const fanR = fans === 3 ? 40 : 48;
  const gap = w / fans;
  return (
    <svg viewBox="0 0 320 150" className="gpu-art" aria-hidden="true">
      <defs>
        <linearGradient id={`shroud-${body}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={body} stopOpacity="0.92" />
          <stop offset="1" stopColor={body} />
        </linearGradient>
      </defs>
      {/* 挡板与金手指 */}
      <rect x="4" y="18" width="10" height="112" rx="2" fill="#9aa0a6" />
      <rect x="70" y="128" width="150" height="10" rx="1" fill="#c9a94b" />
      {/* 外壳 */}
      <rect x="12" y="14" width="300" height="116" rx="12" fill={`url(#shroud-${body})`} />
      <rect x="12" y="14" width="300" height="116" rx="12" fill="none" stroke="#000" strokeOpacity="0.25" />
      <path d={`M24 26 H300`} stroke={accent} strokeWidth="3" strokeLinecap="round" opacity="0.9" />
      <path d={`M24 118 H300`} stroke={accent} strokeWidth="2" strokeLinecap="round" opacity="0.5" />
      {Array.from({ length: fans }, (_, i) => {
        const cx = 12 + gap * i + gap / 2;
        const cy = 72;
        return (
          <g key={i}>
            <circle cx={cx} cy={cy} r={fanR + 4} fill="#1d2023" />
            <circle cx={cx} cy={cy} r={fanR} fill="#26292c" />
            {Array.from({ length: 9 }, (_, k) => (
              <path
                key={k}
                d={`M${cx} ${cy} q ${fanR * 0.55} ${-fanR * 0.25} ${fanR * 0.92} ${fanR * 0.12}`}
                stroke="#4b5056"
                strokeWidth="7"
                strokeLinecap="round"
                fill="none"
                transform={`rotate(${k * 40} ${cx} ${cy})`}
              />
            ))}
            <circle cx={cx} cy={cy} r={fanR * 0.28} fill="#1b1d1f" stroke={accent} strokeOpacity="0.6" />
          </g>
        );
      })}
    </svg>
  );
}

export function PartArt({ candidate }: { candidate: Candidate }) {
  const [imageFailed, setImageFailed] = useState(false);
  // 目录商品图来自外部站点：不发送来源页信息，加载失败时退回示意图
  if (candidate.imageUrl && !imageFailed) {
    return <img className="part-photo" src={candidate.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setImageFailed(true)} />;
  }
  if (candidate.art) return <GpuArt {...candidate.art} />;
  // 真实报价没有商品图，显卡统一用中性示意图
  if (candidate.slot === 'gpu') return <GpuArt fans={2} accent="#8a9199" body="#3a3f45" />;
  const Icon = SLOT_ICONS[candidate.slot];
  return <Icon className="part-art-icon" strokeWidth={1.1} aria-hidden="true" />;
}
