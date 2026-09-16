import { useStore } from "zustand";
import { resolveInfoMessage } from "@/libs/toastr";
import { extensionStore } from "@/stores/extensionStore";
import { stylesStore } from "@/stores/stylesStore";
import { pairStore } from "@/stores/tools/pairStore";
import type { ThemeColorSet } from "@/types";

const FALLBACK_Z_INDEX = 2147483644;

interface PairIndicatorProps {
  colors: ThemeColorSet;
}

export default function PairIndicator({ colors }: PairIndicatorProps) {
  const phase = useStore(pairStore, (s) => s.phase);
  const config = useStore(extensionStore, (s) => s.config);
  const styles = useStore(stylesStore, (s) => s.styles);

  if (phase !== "connected") return null;

  const zIndex = styles?.indicators.zIndex ?? FALLBACK_Z_INDEX;
  const color1 = config?.indicators.color1 ?? colors.buttonColor1;
  const color2 = config?.indicators.color2 ?? colors.buttonColor2;
  const height = config?.indicators.topBorder.height ?? "3px";
  const label = resolveInfoMessage("PAIR_INDICATOR", config?.messages);

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex,
        pointerEvents: "none",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
      }}
    >
      <div
        style={{
          width: "100%",
          height,
          background: `linear-gradient(90deg, ${color1}, ${color2}, ${color1})`,
        }}
      />
      {label && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            marginTop: "6px",
            padding: "4px 10px",
            borderRadius: "9999px",
            background: colors.menuBackground,
            border: `1px solid ${colors.menuBorderColor}`,
            boxShadow: colors.containerShadow,
            color: colors.textColor,
            fontSize: "12px",
            lineHeight: "1.2",
            whiteSpace: "nowrap",
            maxWidth: "90vw",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          <span
            style={{
              width: "6px",
              height: "6px",
              borderRadius: "9999px",
              background: color2,
              flexShrink: 0,
            }}
          />
          {label}
        </div>
      )}
    </div>
  );
}
