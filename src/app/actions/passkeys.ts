"use server";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type WebAuthnCredential,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import { db } from "@/lib/db";
import { ActionError, runAction } from "@/lib/action-guard";
import {
  authOrigin,
  CHALLENGE_COOKIE,
  cookieOptions,
  hasPasskeys,
  hashToken,
  identity,
  saveChallenge,
  SESSION_COOKIE,
  session,
  signIn,
  takeChallenge,
} from "@/lib/auth";

type Key = {
  id: string;
  public_key: Buffer;
  counter: number;
  transports: string;
  name: string;
  created_at: number;
};
export async function getAuthStatus() {
  return runAction(
    ({ current }) => ({
      configured: hasPasskeys(),
      authenticated: Boolean(current),
    }),
    { public: true },
  );
}
export async function listPasskeys() {
  return runAction(({ current }) => {
    const keys = db()
      .prepare("SELECT id, name, created_at FROM passkeys ORDER BY created_at")
      .all() as Pick<Key, "id" | "name" | "created_at">[];
    return {
      keys: keys.map((key) => ({
        ...key,
        current: key.id === current!.credential_id,
      })),
    };
  });
}
export async function registrationOptions() {
  return runAction(
    async ({ cookies, current }) => {
      if (hasPasskeys() && !current)
        throw new ActionError(
          "A passkey is already configured. Sign in to add another.",
        );
      const keys = db()
        .prepare("SELECT id, transports FROM passkeys")
        .all() as Key[];
      const options = await generateRegistrationOptions({
        rpName: "CrashGuard",
        rpID: authOrigin().rpID,
        userName: "CrashGuard workspace",
        userDisplayName: "CrashGuard workspace",
        userID: new Uint8Array(Buffer.from(identity(), "base64url")),
        attestationType: "none",
        authenticatorSelection: {
          residentKey: "required",
          userVerification: "required",
        },
        excludeCredentials: keys.map((key) => ({
          id: key.id,
          transports: JSON.parse(key.transports),
        })),
      });
      saveChallenge(
        cookies,
        options.challenge,
        "register",
        current?.token_hash || null,
      );
      return options;
    },
    { public: true },
  );
}
export async function registerPasskey(
  credentialResponse: RegistrationResponseJSON,
  name: string,
) {
  return runAction(
    async ({ cookies }) => {
      const challenge = takeChallenge({ cookies }, "register");
      const allowed = () =>
        challenge.session_hash
          ? session({ cookies })?.token_hash === challenge.session_hash
          : !hasPasskeys();
      if (!allowed())
        throw new ActionError(
          "Setup is complete. Sign in before adding another passkey.",
        );
      const { origin, rpID } = authOrigin();
      const result = await verifyRegistrationResponse({
        response: credentialResponse,
        expectedChallenge: challenge.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
      });
      if (!result.verified || !result.registrationInfo)
        throw new ActionError("Passkey registration could not be verified.");
      const credential = result.registrationInfo.credential;
      db()
        .transaction(() => {
          // Only one anonymous enrollment may win, even across concurrent requests.
          if (!allowed())
            throw new ActionError(
              "Setup is already complete. Sign in with the registered passkey.",
            );
          db()
            .prepare("INSERT INTO passkeys VALUES (?, ?, ?, ?, ?, ?)")
            .run(
              credential.id,
              Buffer.from(credential.publicKey),
              credential.counter,
              JSON.stringify(credential.transports || []),
              typeof name === "string"
                ? name.trim().slice(0, 60) || "My passkey"
                : "My passkey",
              Date.now(),
            );
          signIn(cookies, credential.id);
        })
        .immediate();
      return { verified: true };
    },
    { public: true },
  );
}
export async function authenticationOptions() {
  return runAction(
    async ({ cookies }) => {
      if (!hasPasskeys())
        throw new ActionError("Create your first passkey to get started.");
      const options = await generateAuthenticationOptions({
        rpID: authOrigin().rpID,
        userVerification: "required",
      });
      saveChallenge(cookies, options.challenge, "authenticate", null);
      return options;
    },
    { public: true },
  );
}
export async function authenticatePasskey(
  response: AuthenticationResponseJSON,
) {
  return runAction(
    async ({ cookies }) => {
      const challenge = takeChallenge({ cookies }, "authenticate");
      const key = db()
        .prepare("SELECT * FROM passkeys WHERE id = ?")
        .get(String(response?.id || "")) as Key | undefined;
      if (!key)
        throw new ActionError(
          "This passkey is not registered with CrashGuard.",
        );
      const credential: WebAuthnCredential = {
        id: key.id,
        publicKey: new Uint8Array(key.public_key),
        counter: key.counter,
        transports: JSON.parse(key.transports),
      };
      if (
        response.response?.userHandle &&
        response.response.userHandle !== identity()
      )
        throw new ActionError("Passkey user does not match this workspace.");
      const { origin, rpID } = authOrigin();
      const result = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential,
        requireUserVerification: true,
      });
      if (!result.verified)
        throw new ActionError("Passkey authentication could not be verified.");
      db()
        .transaction(() => {
          const changed = db()
            .prepare(
              "UPDATE passkeys SET counter = ? WHERE id = ? AND counter = ?",
            )
            .run(result.authenticationInfo.newCounter, key.id, key.counter);
          if (!changed.changes)
            throw new ActionError(
              "Passkey changed during authentication. Please try again.",
            );
          signIn(cookies, key.id);
        })
        .immediate();
      return { verified: true };
    },
    { public: true },
  );
}
export async function signOut() {
  return runAction(
    ({ cookies }) => {
      const token = cookies.get(SESSION_COOKIE)?.value;
      if (token)
        db()
          .prepare("DELETE FROM auth_sessions WHERE token_hash = ?")
          .run(hashToken(token));
      cookies.set(SESSION_COOKIE, "", cookieOptions(0));
      cookies.set(CHALLENGE_COOKIE, "", cookieOptions(0));
      return { ok: true };
    },
    { public: true },
  );
}
export async function removePasskey(id: string) {
  return runAction(({ current }) =>
    db()
      .transaction(() => {
        const count = (
          db().prepare("SELECT COUNT(*) AS count FROM passkeys").get() as {
            count: number;
          }
        ).count;
        if (count <= 1)
          throw new ActionError(
            "Add a backup passkey before removing the last one.",
          );
        if (id === current!.credential_id)
          throw new ActionError(
            "Sign in with another passkey before removing this one.",
          );
        if (typeof id !== "string" || id.length > 2048)
          throw new ActionError("Invalid passkey ID.");
        db().prepare("DELETE FROM passkeys WHERE id = ?").run(id);
        return { ok: true };
      })
      .immediate(),
  );
}
