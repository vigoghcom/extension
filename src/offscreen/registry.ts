import { createAudioCaptureModule } from "@/offscreen/audio-capture";
import { createPairPeerModule } from "@/offscreen/pair-peer";
import type { OffscreenModuleFactory } from "@/offscreen/types";

export const offscreenModules: OffscreenModuleFactory[] = [
  createAudioCaptureModule,
  createPairPeerModule,
];
