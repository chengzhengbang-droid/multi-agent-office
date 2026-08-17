import type { AppUpdateState } from "./app-updater.js";

export const DESKTOP_UPDATE_GET_STATE = "desktop-update:get-state";
export const DESKTOP_UPDATE_PERFORM_ACTION = "desktop-update:perform-action";
export const DESKTOP_UPDATE_STATE_CHANGED = "desktop-update:state-changed";

export interface DesktopUpdateSnapshot {
  mode: "desktop";
  platform: string;
  packaged: boolean;
  supported: boolean;
  state: AppUpdateState;
}

export interface DesktopBridge {
  getUpdateState(): Promise<DesktopUpdateSnapshot>;
  performUpdateAction(): Promise<DesktopUpdateSnapshot>;
  onUpdateState(
    listener: (snapshot: DesktopUpdateSnapshot) => void,
  ): () => void;
}
