import type { ExtensionStyles, ResolvedWidgetConfig } from "@/types";

export interface PopoverAnchor {
  bottom: number;
  right: number;
}

export function resolveMenuPillWidth(styles: ExtensionStyles): number {
  const circleSize = styles.widget.baseCircleSize;
  const effectiveMenuWidth = Math.max(
    styles.widget.menuWidthMin,
    Math.round(
      circleSize * (styles.widget.menuWidth / styles.widget.circleSize),
    ),
  );
  return effectiveMenuWidth + styles.widget.pillPadding * 2;
}

export function resolvePopoverAnchor(
  widget: ResolvedWidgetConfig,
  styles: ExtensionStyles,
  menuPosition?: PopoverAnchor | null,
): PopoverAnchor {
  const bottom = menuPosition?.bottom ?? parseFloat(widget.bottom);
  const right = menuPosition?.right ?? parseFloat(widget.right);
  return {
    bottom,
    right: right + resolveMenuPillWidth(styles) + styles.widget.popoverGap,
  };
}
