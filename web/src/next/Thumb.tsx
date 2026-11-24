import { useState } from 'react';
import { SLOT_ICONS } from '../components/icons';
import type { SlotId } from '../domain/types';

/** 商品图；没有图或加载失败时显示配件类别图标 */
export function Thumb({ src, slot, size = 'md' }: { src?: string | null; slot: SlotId; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const Icon = SLOT_ICONS[slot];
  const loaded = Boolean(src && src === loadedSrc);
  return (
    <span className={`nx-thumb nx-thumb-${size}${loaded ? ' has-image' : ' nx-thumb-icon'}`} aria-hidden>
      {!loaded && <Icon strokeWidth={1.3} />}
      {src && src !== failedSrc && <img key={src} src={src} alt="" loading={size === 'xl' || size === 'md' ? 'eager' : 'lazy'}
        referrerPolicy="no-referrer" onLoad={() => setLoadedSrc(src)} onError={() => setFailedSrc(src)} />}
    </span>
  );
}
