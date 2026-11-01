import { BASE_URL, SIDEPANEL_URL } from "@/libs/constants";
import { initLogger, logger } from "@/libs/logger";
import { setupIframeBridge } from "./bridge";

const PENDING_ROUTE_KEY = "vigogh-pending-route";

initLogger("sidepanel");
logger.info("sidepanel:opened", {});

function isSidepanelPath(path: unknown): path is string {
  return typeof path === "string" && path.startsWith("/sidepanel");
}

function buildRouteUrl(path: string, region: "us" | "br" | undefined): string {
  const prefix = region === "us" ? "/us" : "";
  return new URL(`${BASE_URL}${prefix}${path}`).toString();
}

async function resolveInitialUrl(): Promise<string> {
  try {
    const stored = await chrome.storage.local.get<{
      [PENDING_ROUTE_KEY]?: string;
      "vigogh-region"?: "us" | "br";
    }>([PENDING_ROUTE_KEY, "vigogh-region"]);
    const region = stored["vigogh-region"];

    const path = stored[PENDING_ROUTE_KEY];
    if (!isSidepanelPath(path)) return SIDEPANEL_URL;

    await chrome.storage.local.remove(PENDING_ROUTE_KEY).catch(() => {});
    logger.info("sidepanel:initial-route", { path, region });
    return buildRouteUrl(path, region);
  } catch (error) {
    logger.warn("sidepanel:initial-route-failed", { error });
    return SIDEPANEL_URL;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const iframe = document.querySelector<HTMLIFrameElement>("iframe");

  if (!iframe) {
    logger.error("sidepanel:no-iframe", {
      error: new Error("Sidepanel iframe not found in document"),
    });
    return;
  }

  const targetOrigin = new URL(SIDEPANEL_URL).origin;

  resolveInitialUrl()
    .then((url) => setupIframeBridge(iframe, targetOrigin, url))
    .catch(() => setupIframeBridge(iframe, targetOrigin, SIDEPANEL_URL));
});
