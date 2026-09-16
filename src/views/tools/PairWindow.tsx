import {
  Camera,
  Loader,
  type LucideIcon,
  MousePointerClick,
  ShieldCheck,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { resolveIcon } from "@/libs/icons";
import { resolveErrorMessage } from "@/libs/toastr";
import { extensionStore } from "@/stores/extensionStore";
import { stylesStore } from "@/stores/stylesStore";
import {
  closePairWindow,
  pairStore,
  requestPairPermission,
  restartPairSession,
} from "@/stores/tools/pairStore";
import type { ExtensionStylesWindowDims, ThemeColorSet } from "@/types";
import { resolvePopoverAnchor } from "@/utils/popover-anchor";
import { Window } from "@/views/Window";

const DEFAULT_CODE_ROTATION_SECONDS = 120;
const COUNTDOWN_TICK_MS = 1000;
const FALLBACK_DIMS: ExtensionStylesWindowDims = {
  minWidth: 300,
  minHeight: 320,
  initialWidth: 340,
};

interface PairWindowProps {
  colors: ThemeColorSet;
}

function codeDeadline(
  expiresAt: string | null,
  rotationSeconds: number,
): number {
  const rotation = Date.now() + rotationSeconds * 1000;
  const serverExpiry = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  if (Number.isNaN(serverExpiry)) return rotation;
  return Math.min(rotation, serverExpiry);
}

function stripProtocol(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

export default function PairWindow({ colors }: PairWindowProps) {
  const windowOpen = useStore(pairStore, (s) => s.windowOpen);
  const phase = useStore(pairStore, (s) => s.phase);
  const code = useStore(pairStore, (s) => s.code);
  const expiresAt = useStore(pairStore, (s) => s.expiresAt);
  const errorCode = useStore(pairStore, (s) => s.errorCode);
  const hasPermission = useStore(pairStore, (s) => s.hasHostPermission);
  const permissionStatus = useStore(pairStore, (s) => s.permissionStatus);
  const config = useStore(extensionStore, (s) => s.config);
  const styles = useStore(stylesStore, (s) => s.styles);

  const rotationSeconds =
    config?.behavior.pairCodeRotationSeconds ?? DEFAULT_CODE_ROTATION_SECONDS;
  const [secondsLeft, setSecondsLeft] = useState(rotationSeconds);
  const rotatedCode = useRef<string | null>(null);

  useEffect(() => {
    if (!windowOpen || phase !== "waitingCode" || !code) return;

    const deadline = codeDeadline(expiresAt, rotationSeconds);
    const remaining = () =>
      Math.max(0, Math.ceil((deadline - Date.now()) / 1000));

    setSecondsLeft(remaining());
    const timer = window.setInterval(() => {
      const left = remaining();
      setSecondsLeft(left);
      if (left > 0) return;
      window.clearInterval(timer);
      if (rotatedCode.current === code) return;
      rotatedCode.current = code;
      restartPairSession();
    }, COUNTDOWN_TICK_MS);
    return () => window.clearInterval(timer);
  }, [windowOpen, phase, code, expiresAt, rotationSeconds]);

  if (!windowOpen || !config || !styles) return null;

  const labels = config.pair;
  const tool = config.widget.tools.find(
    (item) => item.type === "toggle" && item.toggleTarget === "pair",
  );
  const Icon = resolveIcon(tool?.icon);
  const dims = styles.windows.pair ?? FALLBACK_DIMS;
  const anchor = resolvePopoverAnchor(config.widget, styles);
  const viewerUrl = stripProtocol(config.widget.pairViewerUrl);

  const errorMessage =
    phase === "error" || permissionStatus === "denied"
      ? resolveErrorMessage(
          errorCode ?? "PAIR_PERMISSION_DENIED",
          config.messages,
        )
      : null;
  const needsPermission =
    !hasPermission && (phase === "idle" || phase === "error");
  const awaitingCode =
    phase === "starting" || (phase === "idle" && hasPermission);
  const requesting = permissionStatus === "requesting";
  const scopeItems: { icon: LucideIcon; text: string }[] = [
    { icon: Camera, text: labels.permissionScopeCapture },
    { icon: MousePointerClick, text: labels.permissionScopeInput },
    { icon: ShieldCheck, text: labels.permissionScopeRevoke },
  ];

  return (
    <Window
      colors={colors}
      icon={<Icon size={14} className="shrink-0 text-white/60" />}
      title={tool?.label ?? ""}
      bottom={anchor.bottom}
      right={anchor.right}
      {...dims}
      onClose={closePairWindow}
      disclaimer={labels.disclaimer}
    >
      <div
        className="flex-1 min-h-0 overflow-y-auto px-4 py-4 flex flex-col items-center text-center gap-3"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {errorMessage && (
          <p className="w-full rounded-md bg-red-500/10 border border-red-400/20 px-3 py-2 text-sm text-red-200 leading-snug">
            {errorMessage}
          </p>
        )}

        {needsPermission && (
          <>
            <IconBadge icon={ShieldCheck} />
            <div className="flex flex-col gap-1.5">
              <p className="text-sm font-medium text-white">
                {labels.permissionTitle}
              </p>
              <p className="text-sm text-white/60 leading-relaxed">
                {labels.permissionDescription}
              </p>
            </div>
            <div className="w-full flex flex-col gap-2 rounded-md border border-white/10 bg-white/5 px-3.5 py-3 text-left">
              <p className="text-[11px] font-medium uppercase tracking-wide text-white/50">
                {labels.permissionScopeTitle}
              </p>
              {scopeItems.map((item) => (
                <div key={item.text} className="flex items-start gap-2">
                  <item.icon
                    size={14}
                    className="shrink-0 text-white/60 mt-0.5"
                  />
                  <span className="text-xs text-white/60 leading-relaxed">
                    {item.text}
                  </span>
                </div>
              ))}
            </div>
            {permissionStatus === "unavailable" && (
              <p className="text-xs text-white/50 leading-relaxed">
                {labels.permissionUnavailable}
              </p>
            )}
            <PrimaryButton onClick={requestPairPermission}>
              {requesting ? (
                <Loader size={14} className="animate-spin" />
              ) : (
                <ShieldCheck size={14} />
              )}
              {requesting
                ? labels.permissionRequesting
                : labels.permissionAction}
            </PrimaryButton>
          </>
        )}

        {!needsPermission && phase !== "error" && awaitingCode && (
          <div className="flex flex-col items-center gap-3 py-6 text-sm text-white/60">
            <Loader size={20} className="animate-spin" />
            {labels.generating}
          </div>
        )}

        {phase === "error" && hasPermission && (
          <PrimaryButton onClick={restartPairSession}>
            {labels.endedRestart}
          </PrimaryButton>
        )}

        {phase === "waitingCode" && (
          <>
            <IconBadge icon={Icon} />
            <div className="flex flex-col gap-1.5">
              <p className="text-sm font-medium text-white">
                {labels.codeTitle}
              </p>
              <p className="text-sm text-white/60 leading-relaxed">
                <TextWithUrl text={labels.codeInstruction} url={viewerUrl} />
              </p>
            </div>
            <div
              className="w-full rounded-md bg-white/5 border border-white/10 py-3 text-2xl font-semibold tracking-[0.3em] indent-[0.3em] text-white select-text cursor-text"
              style={{ userSelect: "text", WebkitUserSelect: "text" }}
            >
              {code ?? ""}
            </div>
            <p className="text-sm text-white/60 leading-relaxed">
              {labels.codeHint}
            </p>
            <p className="text-[11px] text-white/50 tabular-nums">
              {labels.codeRotation.replace("{{seconds}}", String(secondsLeft))}
            </p>
          </>
        )}

        {phase === "connecting" && (
          <div className="flex flex-col items-center gap-3 py-4">
            <Loader size={22} className="animate-spin text-white/60" />
            <div className="flex flex-col gap-1.5">
              <p className="text-sm font-medium text-white">
                {labels.connectingTitle}
              </p>
              <p className="text-sm text-white/60 leading-relaxed">
                {labels.connectingDescription}
              </p>
            </div>
          </div>
        )}
      </div>
    </Window>
  );
}

function IconBadge({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <div className="rounded-full bg-white/5 border border-white/10 p-3">
      <Icon size={22} className="text-white/80" />
    </div>
  );
}

function TextWithUrl({ text, url }: { text: string; url: string }) {
  const [before, after] = text.split("{url}");
  if (after === undefined) return <>{text}</>;
  return (
    <>
      {before}
      <span className="mx-0.5 inline-block rounded border border-white/10 bg-white/5 px-1.5 py-0.5 font-semibold text-white">
        {url}
      </span>
      {after}
    </>
  );
}

interface ActionButtonProps {
  onClick: () => void;
  children: ReactNode;
}

function stopMouseDown(e: React.MouseEvent): void {
  e.preventDefault();
  e.stopPropagation();
}

function PrimaryButton({ onClick, children }: ActionButtonProps) {
  return (
    <button
      type="button"
      className="vigogh-shine-btn flex items-center justify-center gap-1.5 py-2 px-3.5 text-white text-sm font-medium rounded-md w-full cursor-pointer border-none"
      onMouseDown={stopMouseDown}
      onClick={(e) => {
        stopMouseDown(e);
        onClick();
      }}
    >
      {children}
    </button>
  );
}
