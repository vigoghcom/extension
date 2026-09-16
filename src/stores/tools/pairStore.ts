import { createStore } from "zustand/vanilla";
import { logger } from "@/libs/logger";
import { openPlansScreen, requireSession } from "@/libs/sidepanel";
import { toastr } from "@/libs/toastr";
import { touchToolActivity } from "@/libs/tool-inactivity-timer";
import type { PairHostPhase, PairHostState } from "@/types";
import { isExtensionContextValid } from "@/utils/extension-context";
import { sendBackgroundRequest } from "@/utils/runtime-request";

export const PAIR_TOOL_ID = "pair";

const ACTIVE_PHASES: PairHostPhase[] = [
  "starting",
  "waitingCode",
  "connecting",
  "connected",
];

const PENDING_PHASES: PairHostPhase[] = [
  "starting",
  "waitingCode",
  "connecting",
];

export type PairPermissionStatus =
  | "idle"
  | "requesting"
  | "granted"
  | "denied"
  | "unavailable";

interface PairState {
  phase: PairHostPhase;
  code: string | null;
  expiresAt: string | null;
  tabTitle: string | null;
  errorCode: string | null;
  hasHostPermission: boolean;
  permissionStatus: PairPermissionStatus;
  windowOpen: boolean;
}

export const pairStore = createStore<PairState>()(() => ({
  phase: "idle",
  code: null,
  expiresAt: null,
  tabTitle: null,
  errorCode: null,
  hasHostPermission: false,
  permissionStatus: "idle",
  windowOpen: false,
}));

function applyHostState(state: PairHostState): void {
  const { permissionStatus, errorCode } = pairStore.getState();
  let nextPermissionStatus = permissionStatus;
  if (state.hasHostPermission) nextPermissionStatus = "granted";
  else if (state.errorCode === "PAIR_PERMISSION_DENIED")
    nextPermissionStatus = "denied";
  else if (permissionStatus === "granted") nextPermissionStatus = "idle";

  const ended = state.phase === "ended";
  pairStore.setState({
    phase: ended ? "idle" : state.phase,
    code: ended ? null : state.code,
    expiresAt: ended ? null : state.expiresAt,
    tabTitle: ended ? null : state.tabTitle,
    errorCode: state.errorCode ?? (state.phase === "error" ? errorCode : null),
    hasHostPermission: state.hasHostPermission,
    permissionStatus: nextPermissionStatus,
  });
}

export function initPairTool(): void {
  if (!isExtensionContextValid()) return;
  sendBackgroundRequest<{
    noToken?: boolean;
    state?: PairHostState;
    isSessionTab?: boolean;
  }>({ action: "pair_get_state" }, (response) => {
    if (chrome.runtime.lastError || !response?.state) return;

    if (!response.isSessionTab) {
      pairStore.setState({
        hasHostPermission: response.state.hasHostPermission,
      });
      return;
    }

    applyHostState(response.state);
    if (PENDING_PHASES.includes(response.state.phase)) {
      pairStore.setState({ windowOpen: true });
    }
  });
}

export function isPairSessionActive(phase: PairHostPhase): boolean {
  return ACTIVE_PHASES.includes(phase);
}

export function isPairSessionPending(phase: PairHostPhase): boolean {
  return PENDING_PHASES.includes(phase);
}

export function receivePairState(state: PairHostState): void {
  const previous = pairStore.getState();
  applyHostState(state);

  if (state.phase === previous.phase) return;

  logger.info("pair:phase", { from: previous.phase, to: state.phase });

  if (state.phase === "connected") {
    toastr.success("PAIR_CONNECTED");
    touchToolActivity();
    pairStore.setState({ windowOpen: false });
    return;
  }

  if (isPairSessionActive(state.phase)) {
    pairStore.setState({ windowOpen: true });
    touchToolActivity();
    return;
  }

  if (state.phase === "error") {
    if (state.errorCode === "SUBSCRIPTION_REQUIRED") void openPlansScreen();
    if (previous.windowOpen) return;
    if (state.errorCode === "PAIR_PERMISSION_DENIED") {
      pairStore.setState({ windowOpen: true });
      return;
    }
    if (state.errorCode) toastr.error(state.errorCode);
    return;
  }

  if (state.phase === "ended") {
    pairStore.setState({ windowOpen: false, permissionStatus: "idle" });
    if (previous.phase === "idle") return;
    toastr.info("PAIR_ENDED");
  }
}

export function openPairWindow(): void {
  pairStore.setState({ windowOpen: true });
}

export function closePairWindow(): void {
  const { phase } = pairStore.getState();
  pairStore.setState({ windowOpen: false, permissionStatus: "idle" });

  if (isPairSessionPending(phase)) {
    stopPairSession();
    return;
  }

  if (phase === "error") {
    pairStore.setState({
      phase: "idle",
      code: null,
      expiresAt: null,
      tabTitle: null,
      errorCode: null,
    });
  }
}

function beginSession(action: "pair_start" | "pair_restart"): void {
  pairStore.setState({
    windowOpen: true,
    phase: "starting",
    code: null,
    expiresAt: null,
    errorCode: null,
  });
  touchToolActivity();
  sendBackgroundRequest({ action });
}

export function startPairSession(): void {
  if (!isExtensionContextValid()) return;

  const { hasHostPermission } = pairStore.getState();
  if (!hasHostPermission) {
    openPairWindow();
    return;
  }

  toastr.info("PAIR_WAITING");
  beginSession("pair_start");
}

export function restartPairSession(): void {
  if (!isExtensionContextValid()) return;
  beginSession("pair_restart");
}

export function stopPairSession(): void {
  if (!isExtensionContextValid()) return;

  const { phase } = pairStore.getState();
  if (isPairSessionActive(phase)) toastr.info("PAIR_ENDED");
  pairStore.setState({
    phase: "idle",
    code: null,
    expiresAt: null,
    tabTitle: null,
    errorCode: null,
  });
  sendBackgroundRequest({ action: "pair_stop" });
}

export function requestPairPermission(): void {
  if (!isExtensionContextValid()) return;

  pairStore.setState({ permissionStatus: "requesting", errorCode: null });
  sendBackgroundRequest<{
    noToken?: boolean;
    granted?: boolean;
    unavailable?: boolean;
  }>({ action: "pair_request_permission" }, (response) => {
    if (chrome.runtime.lastError || !response || response.unavailable) {
      pairStore.setState({ permissionStatus: "unavailable" });
      return;
    }
    pairStore.setState({
      permissionStatus: response.granted ? "granted" : "denied",
    });
  });
}

export function togglePairSession(): void {
  if (!isExtensionContextValid()) return;

  const { phase } = pairStore.getState();
  logger.info("pair:toggled", { phase });

  if (isPairSessionActive(phase)) {
    stopPairSession();
    return;
  }

  requireSession(() => startPairSession());
}
