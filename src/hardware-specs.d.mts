export const BOARD_FORMATS: string[];
export const HARDWARE_DETAIL_FIELDS: string[];
export function boardFormat(value: unknown): string | null;
export function boardFormats(value: unknown): string[];
export function supportedBoardFormats(specs: Record<string, unknown>): string[];
export function boardCaseStatus(board: Record<string, unknown>, pc: Record<string, unknown>): 'PASS' | 'FAIL' | 'UNKNOWN';
export function hardwareDetails(input: Record<string, unknown>): Record<string, unknown>;
