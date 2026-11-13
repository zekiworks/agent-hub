// The sign-in page: create a passkey from an invite link (/auth#invite=<token>), sign in with one, sign a device in
// from another one's QR code (/auth#link=<code>), list and remove your passkeys and devices, see and decide the
// machines whose agents are on the bus, sign out.
import type { AgentTokenInfo, HealthResponse } from "@agent-bus/protocol";
import { api, postJson, PROFILE_KEY, SESSION_KEY } from "./api";
import { el } from "./html";
import { qrSvg } from "./qr";

const show = (id: string): void => {
  el(id).hidden = false;
};
const msg = el<HTMLDivElement>("auth-msg");

const toB64url = (buf: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const fromB64url = (text: string): ArrayBuffer => {
  const bin = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer;
};

interface CreationOptions {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: Array<{ type: "public-key"; alg: number }>;
  authenticatorSelection: AuthenticatorSelectionCriteria;
  attestation: AttestationConveyancePreference;
  excludeCredentials: Array<{ type: "public-key"; id: string }>;
  timeout: number;
}

async function enroll(invite: string): Promise<void> {
  const o = await postJson<CreationOptions>("/api/auth/register/options", { invite });
  const credential = (await navigator.credentials.create({
    publicKey: {
      ...o,
      challenge: fromB64url(o.challenge),
      user: { ...o.user, id: fromB64url(o.user.id) },
      excludeCredentials: o.excludeCredentials.map((c) => ({ type: c.type, id: fromB64url(c.id) })),
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("No passkey was made");
  const response = credential.response as AuthenticatorAttestationResponse;
  const done = await postJson<{ session: string }>("/api/auth/register/verify", {
    invite,
    credential: { id: credential.id, type: credential.type, response: { clientDataJSON: toB64url(response.clientDataJSON), attestationObject: toB64url(response.attestationObject) } },
  });
  localStorage.setItem(SESSION_KEY, done.session);
  history.replaceState(null, "", "/auth");
}

async function signIn(): Promise<void> {
  // The profile picked on the conversations page: its passkeys are named in the request (see loginOptions).
  const human = localStorage.getItem(PROFILE_KEY) ?? undefined;
  const o = await postJson<{
    challenge: string;
    rpId: string;
    userVerification: UserVerificationRequirement;
    timeout: number;
    allowCredentials: Array<{ type: "public-key"; id: string; transports: AuthenticatorTransport[] }>;
  }>("/api/auth/login/options", { human });
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: fromB64url(o.challenge),
      rpId: o.rpId,
      userVerification: o.userVerification,
      timeout: o.timeout,
      allowCredentials: o.allowCredentials.map((c) => ({ ...c, id: fromB64url(c.id) })),
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("No passkey was chosen");
  const response = credential.response as AuthenticatorAssertionResponse;
  const done = await postJson<{ session: string }>("/api/auth/login/verify", {
    credential: {
      id: credential.id,
      type: credential.type,
      response: {
        clientDataJSON: toB64url(response.clientDataJSON),
        authenticatorData: toB64url(response.authenticatorData),
        signature: toB64url(response.signature),
        userHandle: response.userHandle ? toB64url(response.userHandle) : "",
      },
    },
  });
  localStorage.setItem(SESSION_KEY, done.session);
}

async function renderMe(me: string): Promise<void> {
  show("auth-me");
  el("auth-me-name").textContent = me;
  localStorage.setItem(PROFILE_KEY, me);
  const { credentials } = await api<{ credentials: Array<{ id: string; label: string; createdAt: number; lastUsedAt: number | null }> }>("/api/auth/credentials");
  const list = el<HTMLUListElement>("auth-credentials");
  list.replaceChildren(
    ...credentials.map((c) => {
      const li = document.createElement("li");
      const when = c.lastUsedAt ? `last used ${new Date(c.lastUsedAt).toISOString().slice(0, 16).replace("T", " ")}Z` : "not used to sign in yet";
      li.textContent = `${c.label} · made ${new Date(c.createdAt).toISOString().slice(0, 10)} · ${when} `;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "link-btn";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        if (!confirm(`Remove the passkey "${c.label}"? You will be signed out everywhere.`)) return;
        postJson(`/api/auth/credentials/${encodeURIComponent(c.id)}/remove`, {}).then(
          () => {
            localStorage.removeItem(SESSION_KEY);
            location.reload();
          },
          (err: Error) => (msg.textContent = err.message)
        );
      });
      li.append(remove);
      return li;
    })
  );
  await renderDevices();
  await renderMachines();
}

const shortTime = (ms: number): string => new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

/** The browsers this person is signed in on, each with Sign out (this one: "this browser"). */
async function renderDevices(): Promise<string[]> {
  const { sessions } = await api<{ sessions: Array<{ id: string; label: string; createdAt: number; lastSeenAt: number; current: boolean }> }>(
    "/api/auth/sessions"
  );
  el<HTMLUListElement>("auth-devices").replaceChildren(
    ...sessions.map((s) => {
      const li = document.createElement("li");
      li.textContent = `${s.label}${s.current ? " (this browser)" : ""} · signed in ${shortTime(s.createdAt)} · last seen ${shortTime(s.lastSeenAt)} `;
      if (!s.current) {
        const end = document.createElement("button");
        end.type = "button";
        end.className = "link-btn";
        end.textContent = "Sign out";
        end.addEventListener("click", () => {
          if (!confirm(`Sign out ${s.label}?`)) return;
          postJson(`/api/auth/sessions/${encodeURIComponent(s.id)}/end`, {}).then(
            () => void renderDevices(),
            (err: Error) => (msg.textContent = err.message)
          );
        });
        li.append(end);
      }
      return li;
    })
  );
  return sessions.map((s) => s.id);
}

/**
 * Addresses the bus answers on that a device could open: this page's own first, then the bus's network addresses
 * (plain http works for a linked device; passkeys need the https host name).
 */
async function busAddresses(state: { rpId: string; httpsPort: number | null }): Promise<string[]> {
  const health = await api<HealthResponse>("/api/health");
  const https = state.httpsPort ? health.lanUrls.map((u) => u.replace(/^http:(.*):\d+$/, `https:$1:${state.httpsPort}`)) : [];
  const named = state.httpsPort ? [`https://${state.rpId}:${state.httpsPort}`] : [];
  return [...new Set([location.origin, ...named, ...https, ...health.lanUrls])];
}

let linkTimer: ReturnType<typeof setInterval> | undefined;

/** "Add a device": a one-time code as a QR code; the list of devices refreshes when it is used. */
async function showLink(state: { rpId: string; httpsPort: number | null }): Promise<void> {
  clearInterval(linkTimer);
  const before = new Set(await renderDevices());
  const { code, expiresAt } = await postJson<{ code: string; expiresAt: number }>("/api/auth/link", {});
  const select = el<HTMLSelectElement>("auth-link-origin");
  if (select.options.length === 0) {
    for (const address of await busAddresses(state)) select.append(new Option(address, address));
  }
  const status = el("auth-link-status");
  const draw = (): void => {
    const url = `${select.value}/auth#link=${code}`;
    el("auth-link-qr").replaceChildren(qrSvg(url, 240));
    const a = el<HTMLAnchorElement>("auth-link-url");
    a.href = url;
    a.textContent = url;
  };
  select.onchange = draw;
  draw();
  el("auth-link").hidden = false;
  linkTimer = setInterval(() => {
    const left = Math.round((expiresAt - Date.now()) / 1000);
    if (left <= 0) {
      clearInterval(linkTimer);
      el("auth-link").hidden = true;
      msg.textContent = "The code expired; choose Add a device for a new one.";
      return;
    }
    status.textContent = `Valid for ${left} s more.`;
    if (left % 3 === 0) {
      void renderDevices().then((ids) => {
        if (!ids.some((id) => !before.has(id))) return;
        clearInterval(linkTimer);
        el("auth-link").hidden = true;
        msg.textContent = "The new device is signed in.";
      });
    }
  }, 1000);
}

/** Signs this device in with a code from another device's "Add a device", then opens the conversations. */
async function redeemLink(code: string): Promise<void> {
  const done = await postJson<{ human: string; session: string }>("/api/auth/link/redeem", { code });
  localStorage.setItem(SESSION_KEY, done.session);
  localStorage.setItem(PROFILE_KEY, done.human);
  history.replaceState(null, "", "/auth");
  location.assign("/");
}

/** The machine accounts' agent tokens, with Allow (waiting, denied) or Revoke (allowed). */
async function renderMachines(): Promise<void> {
  const { tokens } = await api<{ tokens: AgentTokenInfo[] }>("/api/agent-tokens");
  const list = el<HTMLUListElement>("auth-machines");
  if (tokens.length === 0) {
    list.replaceChildren(Object.assign(document.createElement("li"), { textContent: "None yet." }));
    return;
  }
  list.replaceChildren(
    ...tokens.map((t) => {
      const li = document.createElement("li");
      const used = t.lastUsedAt ? `last used ${new Date(t.lastUsedAt).toLocaleString()}` : "not used yet";
      const state = t.state === "approved" ? "allowed" : t.state === "denied" ? "denied" : `waiting, code ${t.code}`;
      li.textContent = `${t.host ?? "?"}${t.addr ? ` (${t.addr})` : ""} · ${t.agents.join(", ") || "no agents yet"} · ${state} · ${used} `;
      const action = t.state === "approved" ? "deny" : "approve";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "link-btn";
      button.textContent = t.state === "approved" ? "Revoke" : "Allow";
      button.addEventListener("click", () => {
        if (action === "deny" && !confirm(`Revoke ${t.host ?? "this machine"}? Its agents leave the bus until someone allows it again.`)) return;
        postJson(`/api/agent-tokens/${encodeURIComponent(t.id)}/${action}`, {}).then(
          () => void renderMachines(),
          (err: Error) => (msg.textContent = err.message)
        );
      });
      li.append(button);
      return li;
    })
  );
}

/** Runs a passkey ceremony; on success the conversations page opens (it needs the session this sets). */
const run = (action: () => Promise<void>) => (): void => {
  msg.textContent = "";
  action().then(
    () => location.assign("/"),
    (err: Error) => {
      // InvalidStateError at enrollment: this device already holds one of this person's passkeys (often synced from
      // another device through iCloud Keychain or Google Password Manager), so it refuses to make another.
      msg.textContent =
        err.name === "NotAllowedError"
          ? "Cancelled (or this device has no passkey for this bus)."
          : err.name === "InvalidStateError"
            ? "This device already has a passkey for you on this bus (perhaps synced from another device). Sign in with it instead: open /auth and choose Sign in with a passkey."
            : err.message;
    }
  );
};

async function boot(): Promise<void> {
  // A device link needs no passkey, so it works on a plain-http page too.
  const link = new URLSearchParams(location.hash.slice(1)).get("link");
  if (link) {
    try {
      await redeemLink(link);
    } catch (err) {
      history.replaceState(null, "", "/auth");
      msg.textContent = (err as Error).message;
    }
    return;
  }
  const state = await api<{ rpId: string; httpsPort: number | null; me: string | null }>("/api/auth/state");
  const secure = window.isSecureContext && window.PublicKeyCredential !== undefined;
  const invite = new URLSearchParams(location.hash.slice(1)).get("invite");
  if (invite && secure) {
    try {
      const o = await postJson<CreationOptions>("/api/auth/register/options", { invite });
      show("auth-enroll");
      el("auth-enroll-human").textContent = o.user.name;
      el("auth-enroll-btn").addEventListener("click", run(() => enroll(invite)));
    } catch (err) {
      msg.textContent = (err as Error).message;
    }
    return;
  }
  if (state.me) {
    el("auth-link-btn").addEventListener("click", () => {
      msg.textContent = "";
      showLink(state).catch((err: Error) => (msg.textContent = err.message));
    });
    return renderMe(state.me);
  }
  if (!secure) {
    show("auth-insecure");
    const link = el<HTMLAnchorElement>("auth-secure-link");
    const base = state.httpsPort ? `https://${state.rpId}:${state.httpsPort}` : `https://${state.rpId}`;
    link.href = `${base}/auth${location.hash}`;
    link.textContent = `${base}/auth`;
    return;
  }
  show("auth-signin");
  el("auth-signin-btn").addEventListener("click", run(signIn));
}

// An invite link pasted into this page's address bar changes only the hash, which does not reload the page.
window.addEventListener("hashchange", () => location.reload());

el("auth-signout-btn").addEventListener("click", () => {
  void postJson("/api/auth/logout", {}).finally(() => {
    localStorage.removeItem(SESSION_KEY);
    location.reload();
  });
});

void boot();
