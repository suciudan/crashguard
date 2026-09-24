"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  startRegistration,
  startAuthentication,
  browserSupportsWebAuthn,
} from "@simplewebauthn/browser";
import {
  Fingerprint,
  Loader2,
  LogOut,
  ArrowLeft,
  Trash2,
  Plus,
} from "lucide-react";
import Logo from "./logo";
import { action } from "./shared";
import {
  getAuthStatus,
  listPasskeys,
  registrationOptions,
  registerPasskey,
  authenticationOptions,
  authenticatePasskey,
  signOut,
  removePasskey,
} from "@/app/actions/passkeys";

async function enroll(name: string) {
  const optionsJSON = await action(registrationOptions());
  const credential = await startRegistration({ optionsJSON });
  await action(registerPasskey(credential, name));
}
function message(error: unknown) {
  if (
    error instanceof Error &&
    (error.name === "NotAllowedError" ||
      error.message.includes("ceremony was sent an abort"))
  )
    return "The passkey request was cancelled or timed out. Try again when you’re ready.";
  return error instanceof Error
    ? error.message
    : "Unable to use your passkey. Please try again.";
}
export function Login({
  initiallyConfigured,
  destination,
}: {
  initiallyConfigured: boolean;
  destination: string;
}) {
  const [configured, setConfigured] = useState(initiallyConfigured);
  const [supported, setSupported] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  useEffect(() => {
    setSupported(window.isSecureContext && browserSupportsWebAuthn());
  }, []);
  return (
    <div className="auth-shell">
      <section className="auth-card">
        <Logo className="auth-logo" />
        <h1>
          {configured === false
            ? "Set up your passkey"
            : "Sign in to CrashGuard"}
        </h1>
        <p>
          {configured === false
            ? "Protect your workspace with a passkey. Use your fingerprint, face, device PIN, or a security key."
            : "Use your passkey to access your workspace."}
        </p>
        {!supported && (
          <div className="error-banner" role="alert">
            Passkeys aren’t available here. Open this page in a browser that
            supports passkeys, using HTTPS or localhost.
          </div>
        )}
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError("");
            try {
              if (!configured) await enroll(name);
              else {
                const optionsJSON = await action(authenticationOptions());
                const credential = await startAuthentication({ optionsJSON });
                await action(authenticatePasskey(credential));
              }
              window.location.assign(destination);
            } catch (error) {
              setError(message(error));
              const status = await action(getAuthStatus()).catch(() => null);
              if (status) setConfigured(status.configured);
            } finally {
              setBusy(false);
            }
          }}
        >
          {configured === false && (
            <>
              <label className="field-label" htmlFor="passkey-name">
                Passkey name
              </label>
              <input
                id="passkey-name"
                className="text-input"
                placeholder="e.g. My laptop"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={60}
                required
              />
            </>
          )}
          <button className="button primary" disabled={busy || !supported}>
            {busy ? (
              <Loader2 size={18} className="spin" />
            ) : (
              <Fingerprint size={18} />
            )}
            {configured === false ? "Create passkey" : "Sign in with passkey"}
          </button>
        </form>
      </section>
    </div>
  );
}
export function SignOut() {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await action(signOut());
          window.location.assign("/login");
        } catch {
          setBusy(false);
          window.alert("Could not sign out. Please try again.");
        }
      }}
    >
      <LogOut size={15} />
      Sign out
    </button>
  );
}
type Passkey = {
  id: string;
  name: string;
  created_at: number;
  current: boolean;
};
export function Security() {
  const [keys, setKeys] = useState<Passkey[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function load() {
    const result = await action(listPasskeys());
    setKeys(result.keys);
  }
  useEffect(() => {
    void load().catch((error) => setError(message(error)));
  }, []);
  return (
    <div className="security-shell">
      <header>
        <Link href="/" className="button">
          <ArrowLeft size={16} />
          Back to issues
        </Link>
        <SignOut />
      </header>
      <h1>Passkeys</h1>
      <p>
        Manage your account’s passkeys. Add a backup passkey so you can sign in
        from another device.
      </p>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      <section className="security-keys">
        {keys.map((key) => (
          <article key={key.id}>
            <Fingerprint size={24} />
            <div>
              <strong>{key.name}</strong>
              <p>
                Added {new Date(key.created_at).toLocaleDateString()}
                {key.current ? " · Current passkey" : ""}
              </p>
            </div>
            <button
              className="icon-button"
              aria-label={`Remove ${key.name}`}
              disabled={busy || key.current || keys.length <= 1}
              onClick={async () => {
                setBusy(true);
                setError("");
                setNotice("");
                try {
                  await action(removePasskey(key.id));
                  await load();
                  setNotice(
                    "Passkey removed. Its sessions have been signed out.",
                  );
                } catch (error) {
                  setError(message(error));
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Trash2 size={16} />
            </button>
          </article>
        ))}
      </section>
      <form
        className="security-add"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          setNotice("");
          try {
            await enroll(name);
            setName("");
            await load();
            setNotice("Passkey added.");
          } catch (error) {
            setError(message(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="field-label" htmlFor="backup-name">
          New passkey name
        </label>
        <input
          id="backup-name"
          className="text-input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={60}
          placeholder="e.g. Backup security key"
          required
        />
        <button disabled={busy} className="button primary">
          {busy ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}
          Add passkey
        </button>
      </form>
      <p className="auth-note">
        The current passkey and the last remaining passkey can’t be removed.
        Sign in with another passkey before removing the one you’re using.
      </p>
    </div>
  );
}
