export const PAIR_CONTROL_CHANNEL = "control";
export const PAIR_FRAMES_CHANNEL = "frames";

export const PAIR_FRAME_CHUNK_BYTES = 16 * 1024;
export const PAIR_FRAME_HEADER_BYTES = 8;
export const PAIR_FRAME_BUFFER_LIMIT_BYTES = 512 * 1024;

export const PAIR_DEFAULT_INTERVAL_MS = 2000;
export const PAIR_MIN_INTERVAL_MS = 1000;
export const PAIR_MAX_INTERVAL_MS = 5000;
export const PAIR_AFTER_INPUT_DELAY_MS = 300;
export const PAIR_DEFAULT_QUALITY = 55;
export const PAIR_MAX_FRAME_WIDTH = 1024;

export const PAIR_ICE_GATHERING_TIMEOUT_MS = 1500;
export const PAIR_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
export const PAIR_MAX_DURATION_MS = 30 * 60 * 1000;

export const PAIR_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
];

export type PairNavAction = "back" | "forward" | "reload";

export type PairInput =
  | {
      kind: "tap";
      x: number;
      y: number;
      button?: "left" | "right";
      clickCount?: number;
    }
  | {
      kind: "scroll";
      x: number;
      y: number;
      deltaX: number;
      deltaY: number;
    }
  | {
      kind: "drag";
      from: { x: number; y: number };
      to: { x: number; y: number };
    }
  | { kind: "text"; text: string }
  | { kind: "key"; key: string }
  | { kind: "nav"; action: PairNavAction };

export type PairViewerMessage =
  | { t: "input"; input: PairInput }
  | { t: "config"; intervalMs?: number; quality?: number }
  | { t: "refresh" }
  | { t: "bye" };

export type PairHostMessage =
  | {
      t: "ready";
      viewport: { width: number; height: number };
      tabTitle: string;
      tabUrl: string;
      intervalMs: number;
    }
  | {
      t: "frame";
      frameId: number;
      width: number;
      height: number;
      tabTitle: string;
      tabUrl: string;
    }
  | { t: "ended"; reason: string }
  | { t: "error"; code: string };

export function encodeFrameChunks(
  frameId: number,
  bytes: Uint8Array,
): ArrayBuffer[] {
  const payloadSize = PAIR_FRAME_CHUNK_BYTES - PAIR_FRAME_HEADER_BYTES;
  const chunkCount = Math.max(1, Math.ceil(bytes.length / payloadSize));
  const chunks: ArrayBuffer[] = [];

  for (let index = 0; index < chunkCount; index++) {
    const start = index * payloadSize;
    const slice = bytes.subarray(start, start + payloadSize);
    const buffer = new ArrayBuffer(PAIR_FRAME_HEADER_BYTES + slice.length);
    const view = new DataView(buffer);
    view.setUint32(0, frameId);
    view.setUint16(4, index);
    view.setUint16(6, chunkCount);
    new Uint8Array(buffer, PAIR_FRAME_HEADER_BYTES).set(slice);
    chunks.push(buffer);
  }

  return chunks;
}

export interface PairFrameAssembler {
  push(buffer: ArrayBuffer): { frameId: number; bytes: Uint8Array } | null;
  reset(): void;
}

export function createFrameAssembler(): PairFrameAssembler {
  let currentFrameId = -1;
  let received = 0;
  let expected = 0;
  let parts: (Uint8Array | undefined)[] = [];

  function reset(): void {
    currentFrameId = -1;
    received = 0;
    expected = 0;
    parts = [];
  }

  return {
    reset,
    push(buffer) {
      if (buffer.byteLength < PAIR_FRAME_HEADER_BYTES) return null;
      const view = new DataView(buffer);
      const frameId = view.getUint32(0);
      const chunkIndex = view.getUint16(4);
      const chunkCount = view.getUint16(6);

      if (frameId !== currentFrameId) {
        currentFrameId = frameId;
        expected = chunkCount;
        received = 0;
        parts = new Array(chunkCount);
      }

      if (chunkIndex >= expected || parts[chunkIndex]) return null;

      parts[chunkIndex] = new Uint8Array(buffer.slice(PAIR_FRAME_HEADER_BYTES));
      received++;

      if (received !== expected) return null;

      let total = 0;
      for (const part of parts) total += part ? part.length : 0;

      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const part of parts) {
        if (!part) continue;
        bytes.set(part, offset);
        offset += part.length;
      }

      reset();
      return { frameId, bytes };
    },
  };
}

export function clampInterval(intervalMs: number): number {
  if (!Number.isFinite(intervalMs)) return PAIR_DEFAULT_INTERVAL_MS;
  return Math.min(
    PAIR_MAX_INTERVAL_MS,
    Math.max(PAIR_MIN_INTERVAL_MS, Math.round(intervalMs)),
  );
}

export function clampQuality(quality: number): number {
  if (!Number.isFinite(quality)) return PAIR_DEFAULT_QUALITY;
  return Math.min(90, Math.max(20, Math.round(quality)));
}
