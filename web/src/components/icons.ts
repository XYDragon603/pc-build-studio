import { CircuitBoard, Cpu, Fan, HardDrive, MemoryStick, Monitor, PcCase, Zap } from 'lucide-react';
import type { SlotId } from '../domain/types';

export const SLOT_ICONS: Record<SlotId, typeof Cpu> = {
  cpu: Cpu,
  gpu: Monitor,
  board: CircuitBoard,
  ram: MemoryStick,
  ssd: HardDrive,
  psu: Zap,
  case: PcCase,
  cooler: Fan,
};
