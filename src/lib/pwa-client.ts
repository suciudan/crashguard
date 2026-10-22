export type BeforeInstallPromptEvent = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

let installPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

export function getInstallPrompt() {
  return installPrompt;
}

export function captureInstallPrompt(event: BeforeInstallPromptEvent | null) {
  installPrompt = event;
  listeners.forEach((listener) => listener());
}

export function consumeInstallPrompt() {
  const event = installPrompt;
  captureInstallPrompt(null);
  return event;
}

export function observeInstallPrompt(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
