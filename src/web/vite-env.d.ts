/// <reference types="vite/client" />

import type { DesktopBridge } from "../desktop/update-contract";

declare global {
  interface Window {
    maoDesktop?: DesktopBridge;
  }
}
