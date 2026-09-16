import { logger } from "@/libs/logger";
import type { PairInput, PairNavAction } from "@/libs/pair-protocol";
import {
  insertTextIntoContentEditable,
  insertTextIntoTextarea,
} from "@/libs/text-insertion";

const KEY_CODES: Record<string, number> = {
  Enter: 13,
  Backspace: 8,
  Tab: 9,
  Escape: 27,
  Delete: 46,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
};

export interface PairViewport {
  width: number;
  height: number;
}

export function readPairViewport(): PairViewport {
  return {
    width: Math.round(document.documentElement.clientWidth),
    height: Math.round(document.documentElement.clientHeight),
  };
}

function toPoint(x: number, y: number): { clientX: number; clientY: number } {
  const viewport = readPairViewport();
  return {
    clientX: Math.round(viewport.width * x),
    clientY: Math.round(viewport.height * y),
  };
}

function elementAt(clientX: number, clientY: number): Element | null {
  const found = document.elementFromPoint(clientX, clientY);
  if (!found) return null;
  if (found.shadowRoot) {
    const inner = found.shadowRoot.elementFromPoint(clientX, clientY);
    if (inner) return inner;
  }
  return found;
}

function mouseInit(
  clientX: number,
  clientY: number,
  button: number,
  extra: MouseEventInit = {},
): MouseEventInit {
  return {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX,
    clientY,
    screenX: clientX,
    screenY: clientY,
    button,
    buttons: button === 2 ? 2 : 1,
    ...extra,
  };
}

function dispatchPointerAndMouse(
  target: Element,
  type: string,
  init: MouseEventInit,
): void {
  const pointerType = `pointer${type.replace("mouse", "")}`;
  if (typeof PointerEvent === "function") {
    target.dispatchEvent(
      new PointerEvent(pointerType, {
        ...init,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
      }),
    );
  }
  target.dispatchEvent(new MouseEvent(type, init));
}

function focusIfPossible(target: Element): void {
  const focusable = target as HTMLElement;
  if (typeof focusable.focus !== "function") return;
  try {
    focusable.focus({ preventScroll: true });
  } catch {}
}

function performTap(input: Extract<PairInput, { kind: "tap" }>): void {
  const { clientX, clientY } = toPoint(input.x, input.y);
  const target = elementAt(clientX, clientY);
  if (!target) return;

  const button = input.button === "right" ? 2 : 0;
  const clickCount = input.clickCount ?? 1;

  target.dispatchEvent(
    new MouseEvent("mousemove", mouseInit(clientX, clientY, button)),
  );
  dispatchPointerAndMouse(
    target,
    "mousedown",
    mouseInit(clientX, clientY, button, { detail: clickCount }),
  );
  focusIfPossible(target);
  dispatchPointerAndMouse(
    target,
    "mouseup",
    mouseInit(clientX, clientY, button, { detail: clickCount, buttons: 0 }),
  );

  if (button === 2) {
    target.dispatchEvent(
      new MouseEvent("contextmenu", mouseInit(clientX, clientY, 2)),
    );
    return;
  }

  target.dispatchEvent(
    new MouseEvent(
      "click",
      mouseInit(clientX, clientY, 0, { detail: clickCount, buttons: 0 }),
    ),
  );

  if (clickCount >= 2) {
    target.dispatchEvent(
      new MouseEvent(
        "dblclick",
        mouseInit(clientX, clientY, 0, { detail: 2, buttons: 0 }),
      ),
    );
  }
}

function scrollableAncestor(start: Element | null): Element | Window {
  let node: Element | null = start;
  while (node && node !== document.body && node !== document.documentElement) {
    const style = window.getComputedStyle(node);
    const scrollable = /(auto|scroll|overlay)/.test(
      style.overflowY + style.overflowX,
    );
    if (scrollable && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return window;
}

function performScroll(input: Extract<PairInput, { kind: "scroll" }>): void {
  const { clientX, clientY } = toPoint(input.x, input.y);
  const viewport = readPairViewport();
  const deltaX = input.deltaX * viewport.width;
  const deltaY = input.deltaY * viewport.height;

  const target = elementAt(clientX, clientY);
  if (target) {
    target.dispatchEvent(
      new WheelEvent("wheel", {
        ...mouseInit(clientX, clientY, 0, { buttons: 0 }),
        deltaX,
        deltaY,
        deltaMode: 0,
      }),
    );
  }

  const scroller = scrollableAncestor(target);
  if (scroller === window) {
    window.scrollBy({ left: deltaX, top: deltaY, behavior: "auto" });
    return;
  }
  (scroller as Element).scrollBy({
    left: deltaX,
    top: deltaY,
    behavior: "auto",
  });
}

function performDrag(input: Extract<PairInput, { kind: "drag" }>): void {
  const from = toPoint(input.from.x, input.from.y);
  const to = toPoint(input.to.x, input.to.y);
  const target = elementAt(from.clientX, from.clientY);
  if (!target) return;

  dispatchPointerAndMouse(
    target,
    "mousedown",
    mouseInit(from.clientX, from.clientY, 0),
  );

  const steps = 4;
  for (let step = 1; step <= steps; step++) {
    const clientX = from.clientX + ((to.clientX - from.clientX) * step) / steps;
    const clientY = from.clientY + ((to.clientY - from.clientY) * step) / steps;
    dispatchPointerAndMouse(
      target,
      "mousemove",
      mouseInit(Math.round(clientX), Math.round(clientY), 0),
    );
  }

  const releaseTarget = elementAt(to.clientX, to.clientY) ?? target;
  dispatchPointerAndMouse(
    releaseTarget,
    "mouseup",
    mouseInit(to.clientX, to.clientY, 0, { buttons: 0 }),
  );
}

function performKey(key: string): void {
  const target = (document.activeElement ?? document.body) as HTMLElement;
  const keyCode = KEY_CODES[key];
  if (keyCode === undefined) return;

  const init: KeyboardEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    key,
    code: key,
    keyCode,
    which: keyCode,
  } as KeyboardEventInit;

  target.dispatchEvent(new KeyboardEvent("keydown", init));

  if (key === "Backspace" || key === "Delete") {
    document.execCommand("delete");
  }

  target.dispatchEvent(new KeyboardEvent("keyup", init));
}

function insertTextIntoInput(input: HTMLInputElement, text: string): void {
  input.focus();

  const start = input.selectionStart ?? input.value.length;
  const nextValue =
    input.value.slice(0, start) + text + input.value.slice(start);

  const nativeSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;

  if (nativeSetter) {
    nativeSetter.call(input, nextValue);
  } else {
    input.value = nextValue;
  }

  try {
    input.selectionStart = start + text.length;
    input.selectionEnd = start + text.length;
  } catch {}

  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function performText(text: string): void {
  const target = document.activeElement as HTMLElement | null;
  if (!target) return;

  if (target instanceof HTMLTextAreaElement) {
    insertTextIntoTextarea(target, text);
    return;
  }

  if (target instanceof HTMLInputElement) {
    insertTextIntoInput(target, text);
    return;
  }

  if (target.isContentEditable) {
    insertTextIntoContentEditable(target, text);
  }
}

function performNav(action: PairNavAction): void {
  if (action === "back") {
    window.history.back();
    return;
  }
  if (action === "forward") {
    window.history.forward();
    return;
  }
  window.location.reload();
}

export function applyPairInput(input: PairInput): void {
  try {
    if (input.kind === "tap") {
      performTap(input);
      return;
    }
    if (input.kind === "scroll") {
      performScroll(input);
      return;
    }
    if (input.kind === "drag") {
      performDrag(input);
      return;
    }
    if (input.kind === "nav") {
      performNav(input.action);
      return;
    }
    if (input.kind === "key") {
      performKey(input.key);
      return;
    }
    if (input.kind === "text") performText(input.text);
  } catch (error) {
    logger.warn("pair:input-failed", { kind: input.kind, error });
  }
}
