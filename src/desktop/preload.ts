import { contextBridge, ipcRenderer } from "electron";
import {
  DESKTOP_UPDATE_GET_STATE,
  DESKTOP_UPDATE_PERFORM_ACTION,
  DESKTOP_UPDATE_STATE_CHANGED,
  type DesktopBridge,
  type DesktopUpdateSnapshot,
} from "./update-contract.js";

const bridge: DesktopBridge = {
  getUpdateState: () => ipcRenderer.invoke(DESKTOP_UPDATE_GET_STATE),
  performUpdateAction: () => ipcRenderer.invoke(DESKTOP_UPDATE_PERFORM_ACTION),
  onUpdateState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: unknown) => {
      listener(snapshot as DesktopUpdateSnapshot);
    };
    ipcRenderer.on(DESKTOP_UPDATE_STATE_CHANGED, handler);
    return () => ipcRenderer.removeListener(DESKTOP_UPDATE_STATE_CHANGED, handler);
  },
};

contextBridge.exposeInMainWorld("maoDesktop", bridge);
