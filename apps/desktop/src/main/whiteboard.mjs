import { dialog, nativeImage } from 'electron';
import { openBoardBackend, pickDesktopImage } from './whiteboard-store.mjs';

// Electron shell around the board backend: the only host-specific part is the photo picker.
export function openWhiteboard(file) {
  return openBoardBackend(file,win=>source=>pickDesktopImage(source,{dialog,nativeImage,win}));
}
