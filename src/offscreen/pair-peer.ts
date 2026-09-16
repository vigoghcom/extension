import { logger } from "@/libs/logger";
import {
  clampInterval,
  clampQuality,
  encodeFrameChunks,
  PAIR_AFTER_INPUT_DELAY_MS,
  PAIR_CONTROL_CHANNEL,
  PAIR_DEFAULT_INTERVAL_MS,
  PAIR_DEFAULT_QUALITY,
  PAIR_FRAME_BUFFER_LIMIT_BYTES,
  PAIR_FRAMES_CHANNEL,
  PAIR_ICE_GATHERING_TIMEOUT_MS,
  PAIR_ICE_SERVERS,
  PAIR_IDLE_TIMEOUT_MS,
  PAIR_MAX_DURATION_MS,
  type PairHostMessage,
  type PairViewerMessage,
} from "@/libs/pair-protocol";
import type {
  OffscreenModule,
  OffscreenModuleContext,
} from "@/offscreen/types";
import type { ExtensionMessage } from "@/types";

const ACTIONS = [
  "offscreen_pair_prepare",
  "offscreen_pair_answer",
  "offscreen_pair_start_frames",
  "offscreen_pair_teardown",
] as const;

const POLL_INTERVAL_MS = 2000;
const WATCHDOG_INTERVAL_MS = 10000;

interface CaptureResponse {
  ok: boolean;
  code?: string;
  data?: string;
  width?: number;
  height?: number;
  tabTitle?: string;
  tabUrl?: string;
}

interface PeerSession {
  pc: RTCPeerConnection;
  control: RTCDataChannel;
  frames: RTCDataChannel;
  pollTimer: ReturnType<typeof setInterval> | null;
  frameTimer: ReturnType<typeof setInterval> | null;
  watchdogTimer: ReturnType<typeof setInterval> | null;
  afterInputTimer: ReturnType<typeof setTimeout> | null;
  intervalMs: number;
  quality: number;
  frameId: number;
  lastFrameData: string | null;
  capturing: boolean;
  startedAt: number;
  lastInputAt: number;
}

function notifyBackground(payload: Record<string, unknown>): void {
  chrome.runtime.sendMessage(payload).catch(() => {});
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function createPairPeerModule(
  context: OffscreenModuleContext,
): OffscreenModule {
  let session: PeerSession | null = null;

  function clearTimers(active: PeerSession): void {
    if (active.pollTimer) clearInterval(active.pollTimer);
    if (active.frameTimer) clearInterval(active.frameTimer);
    if (active.watchdogTimer) clearInterval(active.watchdogTimer);
    if (active.afterInputTimer) clearTimeout(active.afterInputTimer);
    active.pollTimer = null;
    active.frameTimer = null;
    active.watchdogTimer = null;
    active.afterInputTimer = null;
  }

  function teardown(): void {
    if (!session) return;
    const active = session;
    session = null;
    clearTimers(active);
    try {
      active.control.close();
      active.frames.close();
      active.pc.close();
    } catch (error) {
      logger.warn("offscreen:pair-close-failed", { error });
    }
    logger.info("offscreen:pair-teardown", {});
    context.notifyIdle();
  }

  function sendToViewer(message: PairHostMessage): void {
    if (session?.control.readyState !== "open") return;
    try {
      session.control.send(JSON.stringify(message));
    } catch (error) {
      logger.warn("offscreen:pair-control-send-failed", { error });
    }
  }

  function disconnect(reason: string): void {
    sendToViewer({ t: "ended", reason });
    notifyBackground({ action: "pair_disconnected", reason });
    teardown();
  }

  async function captureAndSend(): Promise<void> {
    if (!session || session.capturing) return;
    if (session.frames.readyState !== "open") return;
    if (session.frames.bufferedAmount > PAIR_FRAME_BUFFER_LIMIT_BYTES) {
      logger.debug("offscreen:pair-frame-skipped", {
        reason: "backpressure",
        bufferedAmount: session.frames.bufferedAmount,
      });
      return;
    }

    session.capturing = true;
    try {
      const response = (await chrome.runtime.sendMessage({
        action: "pair_capture",
        quality: session.quality,
      })) as CaptureResponse | undefined;

      if (!session) return;

      if (!response?.ok || !response.data) {
        if (response?.code) sendToViewer({ t: "error", code: response.code });
        return;
      }

      if (response.data === session.lastFrameData) return;
      session.lastFrameData = response.data;
      session.frameId = (session.frameId + 1) % 0xffffffff;

      sendToViewer({
        t: "frame",
        frameId: session.frameId,
        width: response.width ?? 0,
        height: response.height ?? 0,
        tabTitle: response.tabTitle ?? "",
        tabUrl: response.tabUrl ?? "",
      });

      const chunks = encodeFrameChunks(
        session.frameId,
        base64ToBytes(response.data),
      );
      for (const chunk of chunks) session.frames.send(chunk);
    } catch (error) {
      logger.warn("offscreen:pair-capture-failed", { error });
    } finally {
      if (session) session.capturing = false;
    }
  }

  function scheduleAfterInputCapture(): void {
    if (!session) return;
    if (session.afterInputTimer) clearTimeout(session.afterInputTimer);
    session.afterInputTimer = setTimeout(() => {
      if (session) session.afterInputTimer = null;
      void captureAndSend();
    }, PAIR_AFTER_INPUT_DELAY_MS);
  }

  function handleViewerMessage(raw: string): void {
    if (!session) return;
    let message: PairViewerMessage;
    try {
      message = JSON.parse(raw) as PairViewerMessage;
    } catch {
      return;
    }

    if (message.t === "bye") {
      disconnect("viewerEnded");
      return;
    }

    if (message.t === "refresh") {
      session.lastFrameData = null;
      void captureAndSend();
      return;
    }

    if (message.t === "config") {
      if (typeof message.intervalMs === "number") {
        session.intervalMs = clampInterval(message.intervalMs);
        if (session.frameTimer) clearInterval(session.frameTimer);
        session.frameTimer = setInterval(() => {
          void captureAndSend();
        }, session.intervalMs);
      }
      if (typeof message.quality === "number") {
        session.quality = clampQuality(message.quality);
        session.lastFrameData = null;
      }
      return;
    }

    if (message.t === "input") {
      session.lastInputAt = Date.now();
      notifyBackground({ action: "pair_input", input: message.input });
      scheduleAfterInputCapture();
    }
  }

  function startWatchdog(): void {
    if (!session) return;
    session.watchdogTimer = setInterval(() => {
      if (!session) return;
      const now = Date.now();
      if (now - session.startedAt > PAIR_MAX_DURATION_MS) {
        disconnect("maxDuration");
        return;
      }
      if (now - session.lastInputAt > PAIR_IDLE_TIMEOUT_MS) {
        disconnect("idleTimeout");
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  async function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === "complete") return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, PAIR_ICE_GATHERING_TIMEOUT_MS);
      pc.addEventListener("icegatheringstatechange", () => {
        if (pc.iceGatheringState !== "complete") return;
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async function prepare(): Promise<void> {
    teardown();

    const pc = new RTCPeerConnection({ iceServers: PAIR_ICE_SERVERS });
    const control = pc.createDataChannel(PAIR_CONTROL_CHANNEL, {
      ordered: true,
    });
    const frames = pc.createDataChannel(PAIR_FRAMES_CHANNEL, {
      ordered: true,
    });

    const now = Date.now();
    session = {
      pc,
      control,
      frames,
      pollTimer: null,
      frameTimer: null,
      watchdogTimer: null,
      afterInputTimer: null,
      intervalMs: PAIR_DEFAULT_INTERVAL_MS,
      quality: PAIR_DEFAULT_QUALITY,
      frameId: 0,
      lastFrameData: null,
      capturing: false,
      startedAt: now,
      lastInputAt: now,
    };

    control.onmessage = (event) => {
      if (typeof event.data === "string") handleViewerMessage(event.data);
    };
    control.onopen = () => {
      logger.info("offscreen:pair-control-open", {});
      notifyBackground({ action: "pair_connected" });
    };

    pc.onconnectionstatechange = () => {
      if (!session) return;
      if (
        pc.connectionState === "failed" ||
        pc.connectionState === "disconnected" ||
        pc.connectionState === "closed"
      ) {
        logger.warn("offscreen:pair-connection-lost", {
          connectionState: pc.connectionState,
        });
        notifyBackground({
          action: "pair_disconnected",
          reason: "connectionLost",
        });
        teardown();
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);

    const sdp = pc.localDescription?.sdp;
    if (!sdp) {
      notifyBackground({
        action: "pair_disconnected",
        reason: "connectionLost",
      });
      teardown();
      return;
    }

    logger.info("offscreen:pair-offer-ready", { sdpLength: sdp.length });
    notifyBackground({ action: "pair_offer_ready", sdp });

    session.pollTimer = setInterval(() => {
      notifyBackground({ action: "pair_poll" });
    }, POLL_INTERVAL_MS);
  }

  async function applyAnswer(sdp: string): Promise<void> {
    if (!session) return;
    if (session.pollTimer) {
      clearInterval(session.pollTimer);
      session.pollTimer = null;
    }
    await session.pc.setRemoteDescription({ type: "answer", sdp });
    logger.info("offscreen:pair-answer-applied", {});
  }

  function startFrames(params: {
    intervalMs: number;
    viewport: { width: number; height: number };
    tabTitle: string;
    tabUrl: string;
  }): void {
    if (!session) return;
    session.intervalMs = clampInterval(params.intervalMs);
    session.lastInputAt = Date.now();

    sendToViewer({
      t: "ready",
      viewport: params.viewport,
      tabTitle: params.tabTitle,
      tabUrl: params.tabUrl,
      intervalMs: session.intervalMs,
    });

    void captureAndSend();
    session.frameTimer = setInterval(() => {
      void captureAndSend();
    }, session.intervalMs);
    startWatchdog();

    logger.info("offscreen:pair-frames-started", {
      intervalMs: session.intervalMs,
    });
  }

  return {
    id: "pair-peer",
    actions: ACTIONS,
    isActive: () => session !== null,
    teardown,
    handle(message: ExtensionMessage) {
      if (message.action === "offscreen_pair_prepare") {
        prepare().catch((error) => {
          logger.error("offscreen:pair-prepare-failed", { error });
          notifyBackground({
            action: "pair_disconnected",
            reason: "connectionLost",
          });
          teardown();
        });
        return;
      }

      if (message.action === "offscreen_pair_answer") {
        applyAnswer(message.sdp).catch((error) => {
          logger.error("offscreen:pair-answer-failed", { error });
          notifyBackground({
            action: "pair_disconnected",
            reason: "connectionLost",
          });
          teardown();
        });
        return;
      }

      if (message.action === "offscreen_pair_start_frames") {
        startFrames({
          intervalMs: message.intervalMs,
          viewport: message.viewport,
          tabTitle: message.tabTitle,
          tabUrl: message.tabUrl,
        });
        return;
      }

      if (message.action === "offscreen_pair_teardown") teardown();
    },
  };
}
