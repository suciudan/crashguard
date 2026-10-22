# Notifications and Android app

CrashGuard supports Web Push notifications in Firefox and compatible Android
browsers. Each browser or installed app opts in separately. Alerts are sent for
new error/fatal issues and resolved issues that recur, across projects your
account can access. Further events on an already-open issue do not send another
alert.

## Enable notifications in Firefox

1. Sign in and open **Notifications** near the bottom of the sidebar.
2. Give this device a recognizable name, then select **Enable notifications**.
3. Allow notifications in Firefox's permission prompt.
4. Select **Send test notification** to check delivery.

The app asks for notification permission only when you choose to enable it.
Each notification opens the relevant issue; sign in with your passkey if needed.
Push continues when the dashboard tab is closed. Device subscriptions stay active
until disabled or removed, including after signing out. Use **Notifications** to
disable this browser or remove another device from your account.

## Install on Android

1. Open your CrashGuard **HTTPS address** in Firefox or Chrome on your phone and
   sign in with a passkey.
2. In **Notifications**, choose **Install CrashGuard** if available. Otherwise use the
   browser menu's **Install**, **Add app to Home screen**, or **Add to Home screen**
   option (the label depends on the browser).
3. Launch CrashGuard from the home screen and enable notifications there. Allow
   Android's browser/app notification permission if prompted.
4. Send a test notification from the phone.

Installing does not enable notifications automatically. The installed app uses
the same account and projects as the website. It opens in its own window and
shows an offline page if the network is unavailable; private workspace pages
and error data are never stored in its offline cache.

## Hosting

- Set `APP_URL` (and `AUTH_ORIGIN`, if overridden) to a stable HTTPS origin that
  your phone can reach. HTTP on `localhost` is suitable for desktop development;
  an HTTP LAN IP is not a secure context for phone push or PWA installation.
- VAPID signing keys are generated automatically and stored in SQLite. Keep the
  existing persistent database and backups when deploying updates so browser
  subscriptions continue to work. No Firebase project or separate service is
  required.
- Optional `VAPID_SUBJECT` identifies the operator to the push service, using an
  HTTPS URL or `mailto:you@example.com`. It defaults to the configured HTTPS
  origin. In Docker, pass it through the Compose environment; the production
  workflow accepts a matching optional Environment secret.
- The server needs outbound HTTPS access to browser push services. Delivery uses
  the existing background worker, with a persistent queue and bounded retries.
  Expired subscriptions are removed automatically. Current project access is
  checked again before sending. Workspace passkey recovery removes registered
  devices.

Notifications contain a project name and a link, without error messages, stack
traces, or captured event context. You can register up to 20 devices per account.

## Troubleshooting

- **Permission blocked:** allow notifications in Firefox's site permissions (or
  the Android browser's site settings), then enable them again in CrashGuard.
- **No phone notification:** check Android notification permissions, Do Not
  Disturb, network connectivity, and background restrictions for your browser.
  Test delivery while the phone is online; the push service and OS control timing.
- **Device removed or subscription expired:** open Notifications on that device
  and enable it again. Removing a device elsewhere never silently re-enables it.
- **Install button unavailable:** use the Android browser menu. Confirm that the
  address uses HTTPS and that `/manifest.webmanifest`, `/sw.js`, and `/icons/`
  are served by your reverse proxy without an additional sign-in gateway.

Browser behavior follows the [Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)
and [PWA installation requirements](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable).
