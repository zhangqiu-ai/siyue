import { createBoard, parseBoard, serializeBoard, type BoardDocument } from './model.ts';

// A device-local trial namespace; never read or write formal family/goal records.
export const WHITEBOARD_KEY = 'siyue.whiteboard.trial.v1';
export interface BoardStorage {
  getItemSync(key: string): string | null;
  setItemSync(key: string, value: string): void;
}
export function loadBoard(storage: BoardStorage): BoardDocument {
  const raw = storage.getItemSync(WHITEBOARD_KEY);
  return raw === null ? createBoard() : parseBoard(raw);
}
export function saveBoard(storage: BoardStorage, document: BoardDocument): void {
  // Do not replace an unreadable or newer original, including after a failed load.
  const existing = storage.getItemSync(WHITEBOARD_KEY);
  if (existing !== null) parseBoard(existing);
  storage.setItemSync(WHITEBOARD_KEY, serializeBoard(document));
}
