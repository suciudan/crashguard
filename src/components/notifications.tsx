"use client";

import { useEffect, useState } from "react";
import {
  Bell,
  BellOff,
  Check,
  Download,
  RefreshCw,
  Send,
  Smartphone,
  Trash2,
} from "lucide-react";
import {
  getNotificationSettings,
  subscribeNotifications,
  unsubscribeNotifications,
  removeNotificationDevice,
  sendTestNotification,
} from "@/app/actions/notifications";
import {
  consumeInstallPrompt,
  getInstallPrompt,
  observeInstallPrompt,
} from "@/lib/pwa-client";
import { action } from "./shared";
import styles from "./notifications.module.css";

type Settings = NonNullable<
  Awaited<ReturnType<typeof getNotificationSettings>>["data"]
>;

function browserSupport() {
  if (!window.isSecureContext)
    return "Open CrashGuard over HTTPS to enable notifications on this device.";
  if (
    !("Notification" in window) ||
    !("serviceWorker" in navigator) ||
    !("PushManager" in window)
  )
    return "This browser does not support push notifications. Use a current version of Firefox or Chrome, including on Android.";
  return "";
}

function applicationServerKey(value: string) {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function browserOperation<T>(operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                "Your browser's notification service did not respond. Check your connection, then refresh devices or try enabling notifications again.",
              ),
            ),
          12000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function activeRegistration() {
  await browserOperation(
    navigator.serviceWorker.register("/sw.js", { scope: "/" }),
  );
  return browserOperation(navigator.serviceWorker.ready);
}

async function browserSubscription() {
  // Firefox can wait for its push service even when no permission was granted.
  // No usable subscription exists until the user opts in on this browser.
  if (browserSupport() || Notification.permission !== "granted") return null;
  const registration = await browserOperation(
    navigator.serviceWorker.getRegistration("/"),
  );
  return registration
    ? browserOperation(registration.pushManager.getSubscription())
    : null;
}

async function unsubscribeBrowser() {
  const subscription = await browserSubscription();
  if (subscription) await browserOperation(subscription.unsubscribe());
}

export function Notifications() {
  const [data, setData] = useState<Settings | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [name, setName] = useState("This browser");
  const [permission, setPermission] = useState<NotificationPermission | null>(
    null,
  );
  const [unsupported, setUnsupported] = useState("");
  const [browserState, setBrowserState] = useState<
    "checking" | "ready" | "failed"
  >("checking");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [canInstall, setCanInstall] = useState(false);
  const [installed, setInstalled] = useState(false);
  const device = data?.subscriptions.find((item) => item.endpoint === endpoint);
  const enabled = Boolean(
    device && permission === "granted" && browserState === "ready",
  );

  async function refresh() {
    setBrowserState("checking");
    setPermission("Notification" in window ? Notification.permission : null);
    await Promise.all([
      action(getNotificationSettings()).then(setData),
      browserSubscription()
        .then((subscription) => {
          setEndpoint(subscription?.endpoint || "");
          setBrowserState("ready");
        })
        .catch((error) => {
          setBrowserState("failed");
          throw error;
        }),
    ]);
  }

  useEffect(() => {
    let mounted = true;
    setUnsupported(browserSupport());
    setPermission("Notification" in window ? Notification.permission : null);
    const updateInstall = () => setCanInstall(Boolean(getInstallPrompt()));
    const updateInstalled = () =>
      setInstalled(window.matchMedia("(display-mode: standalone)").matches);
    const onInstalled = () => setInstalled(true);
    const onFocus = () => {
      setPermission("Notification" in window ? Notification.permission : null);
      updateInstalled();
    };
    updateInstall();
    updateInstalled();
    const unobserve = observeInstallPrompt(updateInstall);
    window.addEventListener("appinstalled", onInstalled);
    window.addEventListener("focus", onFocus);
    const settings = action(getNotificationSettings()).then((result) => {
      if (mounted) setData(result);
      return result;
    });
    // Render server settings independently of the native browser push service.
    void settings.catch((e: Error) => {
      if (mounted) setError(e.message);
    });
    browserSubscription()
      .then(async (subscription) => {
        if (!mounted) return;
        setEndpoint(subscription?.endpoint || "");
        setBrowserState("ready");
        const current = (await settings).subscriptions.find(
          (item) => item.endpoint === subscription?.endpoint,
        );
        if (mounted && current) setName(current.name);
      })
      .catch((e: Error) => {
        if (mounted) {
          setBrowserState("failed");
          setError(e.message);
        }
      });
    return () => {
      mounted = false;
      unobserve();
      window.removeEventListener("appinstalled", onInstalled);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  async function run(operation: () => Promise<void>, message: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
      await refresh();
      setNotice(message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function enable() {
    if (!data || unsupported || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      // Keep the permission request in the explicit click/submit gesture.
      const granted = await Notification.requestPermission();
      setPermission(granted);
      if (granted !== "granted") {
        setNotice(
          granted === "denied"
            ? "Notifications are blocked. Allow them in this site's browser permissions, then try again."
            : "Notifications were not enabled. You can try again when ready.",
        );
        return;
      }
      const registration = await activeRegistration();
      const key = applicationServerKey(data.publicKey);
      let subscription = await browserOperation(
        registration.pushManager.getSubscription(),
      );
      const previousKey = subscription?.options.applicationServerKey;
      if (
        subscription &&
        ((subscription.expirationTime !== null &&
          subscription.expirationTime <= Date.now()) ||
          !previousKey ||
          !new Uint8Array(previousKey).every(
            (value, index) => key[index] === value,
          ) ||
          previousKey.byteLength !== key.length)
      ) {
        await browserOperation(subscription.unsubscribe());
        subscription = null;
      }
      subscription ??= await browserOperation(
        registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: key,
        }),
      );
      const value = subscription.toJSON();
      if (!value.endpoint || !value.keys?.p256dh || !value.keys.auth)
        throw new Error(
          "The browser did not return a valid notification subscription. Please try again.",
        );
      await action(
        subscribeNotifications(
          {
            endpoint: value.endpoint,
            expirationTime: value.expirationTime,
            keys: { p256dh: value.keys.p256dh, auth: value.keys.auth },
          },
          name,
        ),
      );
      await refresh();
      setNotice(
        "Notifications enabled on this device. Send a test to check delivery.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`setup-layout ${styles.workspace}`}>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <p role="status" className={styles.notice}>
        {notice}
      </p>
      {!data ? (
        <p>
          {error
            ? "Reload this page to try again."
            : "Loading notification settings…"}
        </p>
      ) : (
        <>
          <section
            className={`setup-main ${styles.card}`}
            aria-labelledby="device-notifications"
          >
            <h2 id="device-notifications">
              <Bell size={18} />
              Notifications on this device
            </h2>
            <p>
              Get notified when a new error or fatal issue arrives, or a
              resolved issue reopens, in projects you can access. Repeated
              events on an open issue do not send another notification.
            </p>
            <div
              className={`${styles.status} ${enabled ? styles.enabled : ""}`}
            >
              {enabled ? <Check size={16} /> : <BellOff size={16} />}
              {enabled
                ? `Enabled · ${device?.name}`
                : permission === "denied"
                  ? "Blocked in this browser"
                  : browserState === "checking"
                    ? "Checking this browser…"
                    : browserState === "failed"
                      ? "Could not check this browser"
                      : "Not enabled on this device"}
            </div>
            {unsupported ? (
              <p>{unsupported}</p>
            ) : permission === "denied" ? (
              <p>
                Allow notifications in this site's browser permissions, then
                return here to enable them. Also check that notifications are
                allowed for your browser in your device settings.
              </p>
            ) : null}
            {!enabled && (
              <form
                className={styles.form}
                onSubmit={(event) => {
                  event.preventDefault();
                  void enable();
                }}
              >
                <label>
                  Device name
                  <input
                    className="text-input"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    maxLength={60}
                    required
                    placeholder="e.g. Firefox desktop or Android phone"
                  />
                </label>
                <button
                  className="button primary"
                  disabled={
                    busy ||
                    browserState === "checking" ||
                    Boolean(unsupported) ||
                    permission === "denied" ||
                    !name.trim()
                  }
                >
                  <Bell size={15} />
                  {busy ? "Please wait…" : "Enable notifications"}
                </button>
              </form>
            )}
            {(enabled || device) && (
              <div className={styles.buttons}>
                {enabled && (
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await action(sendTestNotification(endpoint));
                      }, "Test notification queued. It should arrive shortly. If it does not appear, check your browser and device notification settings.")
                    }
                  >
                    <Send size={15} />
                    Send test notification
                  </button>
                )}
                <button
                  className="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await action(unsubscribeNotifications(endpoint));
                      setData((current) =>
                        current
                          ? {
                              ...current,
                              subscriptions: current.subscriptions.filter(
                                (item) => item.endpoint !== endpoint,
                              ),
                            }
                          : current,
                      );
                      await unsubscribeBrowser();
                    }, "Notifications disabled on this device.")
                  }
                >
                  <BellOff size={15} />
                  Disable notifications
                </button>
              </div>
            )}
            <p>
              Notifications stay enabled until you disable them or remove this
              device, including after signing out. They can arrive with the
              CrashGuard tab closed; delivery depends on your browser,
              connectivity, and device settings.
            </p>
          </section>
          <section
            className={`setup-main ${styles.card}`}
            aria-labelledby="install-phone"
          >
            <h2 id="install-phone">
              <Smartphone size={18} />
              CrashGuard on Android
            </h2>
            {installed ? (
              <p>
                CrashGuard is installed on this device. Enable notifications
                above to receive alerts here.
              </p>
            ) : (
              <>
                <p>
                  Open this CrashGuard address in Firefox or Chrome on your
                  Android phone. In the browser menu, choose Install, Add app,
                  or Add to Home screen. Open CrashGuard from your home screen,
                  sign in, and enable notifications on that device.
                </p>
                {canInstall && (
                  <div className={styles.buttons}>
                    <button
                      className="button"
                      disabled={busy}
                      onClick={async () => {
                        const prompt = consumeInstallPrompt();
                        if (!prompt) return;
                        setError("");
                        try {
                          await prompt.prompt();
                          const choice = await prompt.userChoice;
                          if (choice.outcome === "accepted")
                            setNotice(
                              "Installation accepted. Enable notifications on each device where you want alerts.",
                            );
                        } catch {
                          setError(
                            "Could not open the install prompt. Use your browser menu to install CrashGuard.",
                          );
                        }
                      }}
                    >
                      <Download size={15} />
                      Install CrashGuard
                    </button>
                  </div>
                )}
              </>
            )}
            <p>
              Your phone needs the HTTPS address of your CrashGuard server. You
              can enable notifications in the browser without installing the
              app.
            </p>
          </section>
          <section
            className={`setup-main ${styles.card}`}
            aria-labelledby="notification-devices"
          >
            <div className={styles.cardHeading}>
              <h2 id="notification-devices">Your notification devices</h2>
              <button
                className="icon-button"
                aria-label="Refresh notification devices"
                title="Refresh devices"
                disabled={busy}
                onClick={() =>
                  void run(async () => {}, "Device list refreshed.")
                }
              >
                <RefreshCw size={15} />
              </button>
            </div>
            {!data.subscriptions.length ? (
              <p>
                No devices registered yet. Enable notifications on each browser
                or phone where you want alerts.
              </p>
            ) : (
              <ul className={styles.list}>
                {data.subscriptions.map((item) => (
                  <li key={item.id}>
                    <div>
                      <strong>{item.name}</strong>
                      <p>
                        Added {new Date(item.created_at).toLocaleDateString()}
                        {item.endpoint === endpoint ? " · This browser" : ""}
                      </p>
                    </div>
                    <button
                      className="button"
                      disabled={busy}
                      aria-label={`Remove ${item.name}`}
                      onClick={() =>
                        void run(async () => {
                          await action(removeNotificationDevice(item.id));
                          setData((current) =>
                            current
                              ? {
                                  ...current,
                                  subscriptions: current.subscriptions.filter(
                                    (entry) => entry.id !== item.id,
                                  ),
                                }
                              : current,
                          );
                          if (item.endpoint === endpoint)
                            await unsubscribeBrowser();
                        }, `${item.name} removed. Enable notifications on that device to subscribe again.`)
                      }
                    >
                      <Trash2 size={14} />
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
