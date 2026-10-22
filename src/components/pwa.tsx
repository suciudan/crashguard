"use client";

import { useEffect } from "react";
import {
  captureInstallPrompt,
  type BeforeInstallPromptEvent,
} from "@/lib/pwa-client";

export function PwaRegistration() {
  useEffect(() => {
    const onInstallPrompt = (event: Event) => {
      event.preventDefault();
      captureInstallPrompt(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => captureInstallPrompt(null);
    window.addEventListener("beforeinstallprompt", onInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);
    if (window.isSecureContext && "serviceWorker" in navigator) {
      // Registration never asks for notification permission. Settings reports
      // registration failures when the user chooses to enable notifications.
      void navigator.serviceWorker
        .register("/sw.js", { scope: "/", updateViaCache: "none" })
        .catch(() => {});
    }
    return () => {
      window.removeEventListener("beforeinstallprompt", onInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);
  return null;
}
