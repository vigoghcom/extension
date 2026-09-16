import type { BackgroundMessageResult } from "@/background/handlers/types";
import api, { extractApiErrorCode } from "@/libs/api-dispatch";
import { getEndpoint } from "@/libs/endpoints";
import { logger } from "@/libs/logger";
import {
  closeOffscreenDocument,
  ensureOffscreenDocument,
} from "@/libs/offscreen";
import {
  PAIR_DEFAULT_INTERVAL_MS,
  PAIR_DEFAULT_QUALITY,
  PAIR_MAX_FRAME_WIDTH,
  type PairInput,
} from "@/libs/pair-protocol";
import type { ExtensionMessage, PairHostPhase, PairHostState } from "@/types";

const STORAGE_KEY = "vigogh-pair-session";
const CAPTURE_TIMEOUT_MS = 5000;
const HOST_PERMISSION = { origins: ["<all_urls>"] };
const SESSION_GONE_REASONS: Record<string, string> = {
  PAIR_SESSION_ENDED: "replaced",
  PAIR_SESSION_EXPIRED: "expired",
  PAIR_SESSION_NOT_FOUND: "replaced",
};

let lifecycleQueue: Promise<unknown> = Promise.resolve();

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = lifecycleQueue.then(task, task);
  lifecycleQueue = run.catch(() => {});
  return run;
}

interface StoredPairSession {
  sessionId: string;
  hostToken: string;
  tabId: number;
  phase: PairHostPhase;
  code: string | null;
  expiresAt: string | null;
  tabTitle: string | null;
  errorCode: string | null;
  endedReason: string | null;
  attached: boolean;
  answerApplied: boolean;
}

const IDLE_STATE: PairHostState = {
  phase: "idle",
  code: null,
  expiresAt: null,
  tabTitle: null,
  errorCode: null,
  endedReason: null,
  hasHostPermission: false,
};

async function readSession(): Promise<StoredPairSession | null> {
  const stored = await chrome.storage.local.get<{
    [STORAGE_KEY]?: StoredPairSession;
  }>(STORAGE_KEY);
  return stored[STORAGE_KEY] ?? null;
}

async function writeSession(session: StoredPairSession): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: session });
}

async function clearSession(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}

async function hasHostPermission(): Promise<boolean> {
  try {
    return await chrome.permissions.contains(HOST_PERMISSION);
  } catch {
    return false;
  }
}

async function toState(
  session: StoredPairSession | null,
): Promise<PairHostState> {
  const granted = await hasHostPermission();
  if (!session) return { ...IDLE_STATE, hasHostPermission: granted };
  return {
    phase: session.phase,
    code: session.code,
    expiresAt: session.expiresAt,
    tabTitle: session.tabTitle,
    errorCode: session.errorCode,
    endedReason: session.endedReason,
    hasHostPermission: granted,
  };
}

async function emitState(state: PairHostState, tabId?: number): Promise<void> {
  let targetTabId = tabId;
  if (targetTabId === undefined) {
    const [tab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    targetTabId = tab?.id;
  }
  if (targetTabId === undefined) return;

  chrome.tabs
    .sendMessage(targetTabId, { action: "pair_state", state })
    .catch(() => {});
}

async function broadcastState(
  session: StoredPairSession | null,
): Promise<void> {
  const state = await toState(session);
  await emitState(state, session?.tabId);
}

async function patchSession(
  patch: Partial<StoredPairSession>,
): Promise<StoredPairSession | null> {
  const current = await readSession();
  if (!current) return null;
  const next = { ...current, ...patch };
  await writeSession(next);
  await broadcastState(next);
  return next;
}

interface PairViewport {
  width: number;
  height: number;
}

async function ensureContentScript(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["contentScript.js"],
    });
  } catch (error) {
    logger.debug("pair:content-script-inject-skipped", { error });
  }
}

async function readViewport(tabId: number): Promise<PairViewport | null> {
  try {
    const response = (await chrome.tabs.sendMessage(tabId, {
      action: "pair_viewport",
    })) as { ok: boolean; viewport: PairViewport } | undefined;
    return response?.viewport ?? null;
  } catch (error) {
    logger.warn("pair:viewport-failed", { error });
    return null;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("PAIR_CAPTURE_TIMEOUT")),
      ms,
    );
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

async function endPairSession(
  reason: string,
  options: { notifyApi?: boolean; errorCode?: string; silent?: boolean } = {},
): Promise<void> {
  const session = await readSession();

  chrome.runtime
    .sendMessage({ action: "offscreen_pair_teardown" })
    .catch(() => {});
  await closeOffscreenDocument();

  if (session && options.notifyApi !== false) {
    try {
      await api.post(
        getEndpoint("pairSessionEnd", { sessionId: session.sessionId }),
        { reason },
        { headers: { "X-Pair-Host-Token": session.hostToken } },
      );
    } catch (error) {
      logger.warn("pair:end-request-failed", { error });
    }
  }

  await clearSession();

  if (!options.silent) {
    const state: PairHostState = {
      ...IDLE_STATE,
      phase: options.errorCode ? "error" : "ended",
      errorCode: options.errorCode ?? null,
      endedReason: reason,
      hasHostPermission: await hasHostPermission(),
    };
    await emitState(state, session?.tabId);
  }

  logger.info("pair:session-ended", { reason, errorCode: options.errorCode });
}

async function resolveTargetTab(
  tabId?: number,
): Promise<chrome.tabs.Tab | undefined> {
  if (tabId !== undefined) {
    try {
      return await chrome.tabs.get(tabId);
    } catch {
      return undefined;
    }
  }
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  return tab;
}

function isShareableTab(
  tab: chrome.tabs.Tab | undefined,
): tab is chrome.tabs.Tab & { id: number; url: string } {
  if (!tab?.id || !tab.url) return false;
  if (tab.url.startsWith("chrome://")) return false;
  if (tab.url.startsWith(chrome.runtime.getURL(""))) return false;
  return true;
}

async function runStartPairSession(tabId?: number): Promise<void> {
  const existing = await readSession();
  if (existing) {
    const expiresAt = existing.expiresAt
      ? Date.parse(existing.expiresAt)
      : Number.NaN;
    const stale = Number.isNaN(expiresAt) || expiresAt <= Date.now();
    const sameTab = tabId === undefined || existing.tabId === tabId;

    if (!stale && sameTab) {
      await broadcastState(existing);
      logger.info("pair:start-ignored-existing", {
        sessionId: existing.sessionId,
        phase: existing.phase,
      });
      return;
    }

    await endPairSession(stale ? "expired" : "replaced", { silent: stale });
  }

  if (!(await hasHostPermission())) {
    await emitState(
      {
        ...IDLE_STATE,
        phase: "error",
        errorCode: "PAIR_PERMISSION_REQUIRED",
        hasHostPermission: false,
      },
      tabId,
    );
    return;
  }

  const tab = await resolveTargetTab(tabId);

  if (!isShareableTab(tab)) {
    const state: PairHostState = {
      ...IDLE_STATE,
      phase: "error",
      errorCode: "PAIR_TAB_NOT_SUPPORTED",
      hasHostPermission: true,
    };
    await emitState(state, tabId);
    return;
  }

  try {
    const response = await api.post<{
      data: {
        sessionId: string;
        code: string;
        hostToken: string;
        expiresAt: string;
      };
    }>(getEndpoint("pairSessions"));

    const created = response.data.data;
    const session: StoredPairSession = {
      sessionId: created.sessionId,
      hostToken: created.hostToken,
      tabId: tab.id,
      phase: "starting",
      code: created.code,
      expiresAt: created.expiresAt,
      tabTitle: tab.title ?? "",
      errorCode: null,
      endedReason: null,
      attached: false,
      answerApplied: false,
    };

    await writeSession(session);
    await broadcastState(session);

    await ensureOffscreenDocument({
      reasons: [chrome.offscreen.Reason.WEB_RTC],
      justification:
        "Hold the peer connection that streams this tab to the paired phone.",
    });
    chrome.runtime
      .sendMessage({ action: "offscreen_pair_prepare" })
      .catch(() => {});

    logger.info("pair:session-started", { sessionId: created.sessionId });
  } catch (error) {
    logger.error("pair:start-failed", { error });
    await endPairSession("hostEnded", {
      notifyApi: false,
      errorCode: extractApiErrorCode(error) ?? "PAIR_START_FAILED",
    });
  }
}

async function runRestartPairSession(tabId?: number): Promise<void> {
  const existing = await readSession();

  if (existing) {
    const sameTab = tabId === undefined || existing.tabId === tabId;
    await endPairSession("replaced", { silent: sameTab });
    logger.info("pair:session-replaced", { sessionId: existing.sessionId });
  }

  await runStartPairSession(tabId);
}

function startPairSession(tabId?: number): Promise<void> {
  return serialize(() => runStartPairSession(tabId));
}

function restartPairSession(tabId?: number): Promise<void> {
  return serialize(() => runRestartPairSession(tabId));
}

function stopPairSession(reason: string): Promise<void> {
  return serialize(() => endPairSession(reason));
}

async function runPublishOffer(sdp: string): Promise<void> {
  const session = await readSession();
  if (!session) return;

  try {
    await api.put(
      getEndpoint("pairSessionOffer", { sessionId: session.sessionId }),
      { offerSdp: sdp },
      { headers: { "X-Pair-Host-Token": session.hostToken } },
    );
    await patchSession({ phase: "waitingCode" });
    logger.info("pair:offer-published", { sessionId: session.sessionId });
  } catch (error) {
    const code = extractApiErrorCode(error);
    const goneReason = code ? SESSION_GONE_REASONS[code] : undefined;

    if (goneReason) {
      logger.warn("pair:offer-session-gone", { code, goneReason });
      await endPairSession(goneReason, { notifyApi: false });
      return;
    }

    logger.error("pair:offer-publish-failed", { error });
    await endPairSession("hostEnded", {
      errorCode: code ?? "PAIR_START_FAILED",
    });
  }
}

function publishOffer(sdp: string): Promise<void> {
  return serialize(() => runPublishOffer(sdp));
}

async function runPollPairSession(): Promise<void> {
  const session = await readSession();
  if (!session) return;

  try {
    const response = await api.get<{
      data: {
        status: string;
        answerSdp: string | null;
        endedReason: string | null;
      };
    }>(getEndpoint("pairSessionStatus", { sessionId: session.sessionId }), {
      headers: { "X-Pair-Host-Token": session.hostToken },
    });

    const pair = response.data.data;

    if (pair.status === "ended") {
      await endPairSession(pair.endedReason ?? "connectionLost", {
        notifyApi: false,
      });
      return;
    }

    if (pair.answerSdp && !session.answerApplied) {
      await patchSession({ phase: "connecting", answerApplied: true });
      chrome.runtime
        .sendMessage({
          action: "offscreen_pair_answer",
          sdp: pair.answerSdp,
        })
        .catch(() => {});
      logger.info("pair:answer-forwarded", { sessionId: session.sessionId });
    }
  } catch (error) {
    logger.warn("pair:poll-failed", { error });
  }
}

function pollPairSession(): Promise<void> {
  return serialize(runPollPairSession);
}

async function onPeerConnected(): Promise<void> {
  const session = await readSession();
  if (!session) return;

  try {
    await ensureContentScript(session.tabId);
    const viewport = await readViewport(session.tabId);
    if (!viewport) throw new Error("PAIR_VIEWPORT_UNAVAILABLE");

    const tab = await chrome.tabs.get(session.tabId);

    await patchSession({
      phase: "connected",
      attached: true,
      tabTitle: tab.title ?? "",
    });

    chrome.runtime
      .sendMessage({
        action: "offscreen_pair_start_frames",
        intervalMs: PAIR_DEFAULT_INTERVAL_MS,
        viewport,
        tabTitle: tab.title ?? "",
        tabUrl: tab.url ?? "",
      })
      .catch(() => {});

    logger.info("pair:peer-connected", { sessionId: session.sessionId });
  } catch (error) {
    logger.error("pair:content-script-failed", { error });
    await endPairSession("hostEnded", {
      errorCode: "PAIR_ATTACH_FAILED",
    });
  }
}

async function captureFrame(quality: number): Promise<{
  ok: boolean;
  code?: string;
  data?: string;
  width?: number;
  height?: number;
  tabTitle?: string;
  tabUrl?: string;
}> {
  const session = await readSession();
  if (!session?.attached) return { ok: false, code: "PAIR_NOT_CONNECTED" };

  try {
    const tab = await chrome.tabs.get(session.tabId);
    if (!tab.active) return { ok: false, code: "PAIR_TAB_NOT_VISIBLE" };

    const dataUrl = await withTimeout(
      chrome.tabs.captureVisibleTab(tab.windowId, {
        format: "jpeg",
        quality,
      }),
      CAPTURE_TIMEOUT_MS,
    );

    if (!dataUrl) return { ok: false, code: "PAIR_CAPTURE_FAILED" };

    const frame = await downscaleFrame(dataUrl, quality);

    return {
      ok: true,
      data: frame.base64,
      width: frame.width,
      height: frame.height,
      tabTitle: tab.title ?? "",
      tabUrl: tab.url ?? "",
    };
  } catch (error) {
    logger.warn("pair:capture-failed", { error });
    const code =
      (error as Error)?.message === "PAIR_CAPTURE_TIMEOUT"
        ? "PAIR_TAB_NOT_VISIBLE"
        : "PAIR_CAPTURE_FAILED";
    return { ok: false, code };
  }
}

async function dispatchInput(input: PairInput): Promise<void> {
  const session = await readSession();
  if (!session?.attached) return;

  try {
    await chrome.tabs.sendMessage(session.tabId, {
      action: "pair_input_dispatch",
      input,
    });
  } catch (error) {
    logger.warn("pair:input-failed", { kind: input.kind, error });
  }
}

const FRAME_BASE64_CHUNK = 0x8000;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += FRAME_BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + FRAME_BASE64_CHUNK));
  }
  return btoa(binary);
}

async function downscaleFrame(
  dataUrl: string,
  quality: number,
): Promise<{ base64: string; width: number; height: number }> {
  const sourceBlob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(sourceBlob);
  const scale = Math.min(1, PAIR_MAX_FRAME_WIDTH / Math.max(1, bitmap.width));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  context?.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await canvas.convertToBlob({
    type: "image/jpeg",
    quality: quality / 100,
  });
  const bytes = new Uint8Array(await blob.arrayBuffer());

  return { base64: bytesToBase64(bytes), width, height };
}

async function handlePermissionResult(
  granted: boolean,
  hostTabId: number | undefined,
): Promise<void> {
  if (!granted) {
    const permitted = await hasHostPermission();
    await emitState(
      {
        ...IDLE_STATE,
        phase: "error",
        errorCode: "PAIR_PERMISSION_DENIED",
        hasHostPermission: permitted,
      },
      hostTabId,
    );
    return;
  }

  await startPairSession(hostTabId);
}

function requestHostPermission(
  hostTabId: number | undefined,
  sendResponse: (response: unknown) => void,
): void {
  try {
    chrome.permissions.request(HOST_PERMISSION, (granted?: boolean) => {
      if (chrome.runtime.lastError) {
        logger.warn("pair:permission-request-failed", {
          error: new Error(chrome.runtime.lastError.message),
        });
        sendResponse({ ok: true, unavailable: true });
        return;
      }
      logger.info("pair:permission-result", { granted: !!granted });
      sendResponse({ ok: true, granted: !!granted });
      handlePermissionResult(!!granted, hostTabId).catch((error) => {
        logger.error("pair:permission-result-failed", { error });
      });
    });
  } catch (error) {
    logger.warn("pair:permission-request-threw", { error });
    sendResponse({ ok: true, unavailable: true });
  }
}

chrome.permissions.onRemoved.addListener(() => {
  readSession()
    .then((session) => {
      if (!session) return;
      return stopPairSession("permissionRevoked");
    })
    .catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  readSession()
    .then((session) => {
      if (!session || session.tabId !== tabId) return;
      return stopPairSession("tabClosed");
    })
    .catch(() => {});
});

export function handleMessages(
  message: ExtensionMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
): BackgroundMessageResult {
  if (message.action === "pair_start") {
    startPairSession(sender.tab?.id)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.action === "pair_restart") {
    restartPairSession(sender.tab?.id)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.action === "pair_stop") {
    stopPairSession(message.reason ?? "hostEnded")
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.action === "pair_get_state") {
    const senderTabId = sender.tab?.id;
    readSession()
      .then(async (session) => {
        const state = await toState(session);
        const isSessionTab =
          senderTabId !== undefined && session?.tabId === senderTabId;
        sendResponse({ ok: true, state, isSessionTab });
      })
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.action === "pair_request_permission") {
    requestHostPermission(sender.tab?.id, sendResponse);
    return true;
  }

  if (message.action === "pair_offer_ready") {
    publishOffer(message.sdp).catch(() => {});
    return false;
  }

  if (message.action === "pair_poll") {
    pollPairSession().catch(() => {});
    return false;
  }

  if (message.action === "pair_connected") {
    onPeerConnected().catch(() => {});
    return false;
  }

  if (message.action === "pair_disconnected") {
    const errorCode =
      message.reason === "connectionFailed"
        ? "PAIR_CONNECTION_FAILED"
        : undefined;
    serialize(() => endPairSession(message.reason, { errorCode })).catch(
      () => {},
    );
    return false;
  }

  if (message.action === "pair_capture") {
    const quality =
      (message as { quality?: number }).quality ?? PAIR_DEFAULT_QUALITY;
    captureFrame(quality)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, code: "PAIR_CAPTURE_FAILED" }));
    return true;
  }

  if (message.action === "pair_input") {
    dispatchInput(message.input as PairInput).catch(() => {});
    return false;
  }

  return null;
}
