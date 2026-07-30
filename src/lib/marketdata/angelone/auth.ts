import { authenticator } from "otplib";
import { MarketDataUnavailableError } from "./errors";
import { angelThrottle, withRetry } from "./throttle";

const BASE_URL =
  process.env.ANGEL_ONE_BASE_URL ?? "https://apiconnect.angelone.in";

export type AngelSession = {
  jwtToken: string;
  refreshToken: string;
  feedToken?: string;
  clientCode: string;
  obtainedAt: number;
};

let cachedSession: AngelSession | null = null;

export function hasAngelCredentials(): boolean {
  return Boolean(
    process.env.ANGEL_ONE_API_KEY &&
      process.env.ANGEL_ONE_CLIENT_CODE &&
      process.env.ANGEL_ONE_PIN &&
      process.env.ANGEL_ONE_TOTP_SECRET,
  );
}

export function isDemoMarketDataMode(): boolean {
  if (process.env.MARKETDATA_DEMO_MODE === "true") return true;
  if (process.env.MARKETDATA_DEMO_MODE === "false") return false;
  return !hasAngelCredentials();
}

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new MarketDataUnavailableError(
      `Missing env ${name}`,
      "AUTH",
      { retryable: false },
    );
  }
  return v;
}

function commonHeaders(apiKey: string, jwt?: string): HeadersInit {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-UserType": "USER",
    "X-SourceID": "WEB",
    "X-ClientLocalIP": "127.0.0.1",
    "X-ClientPublicIP": "127.0.0.1",
    "X-MACAddress": "00:00:00:00:00:00",
    "X-PrivateKey": apiKey,
  };
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  return headers;
}

type AngelEnvelope<T> = {
  status: boolean | string;
  message?: string;
  errorcode?: string;
  data?: T;
};

async function angelFetch<T>(
  path: string,
  init: RequestInit & { auth?: boolean } = {},
): Promise<T> {
  const apiKey = requiredEnv("ANGEL_ONE_API_KEY");
  let jwt: string | undefined;
  if (init.auth !== false && path !== "/rest/auth/angelbroking/user/v1/loginByPassword") {
    const session = await getSession();
    jwt = session.jwtToken;
  }

  return angelThrottle.schedule(async () =>
    withRetry(async () => {
      const res = await fetch(`${BASE_URL}${path}`, {
        ...init,
        headers: {
          ...commonHeaders(apiKey, jwt),
          ...(init.headers ?? {}),
        },
        cache: "no-store",
      });

      if (res.status === 429) {
        throw new MarketDataUnavailableError(
          "Angel One rate limited",
          "RATE_LIMITED",
          { status: 429, retryable: true },
        );
      }
      if (res.status >= 500) {
        throw new MarketDataUnavailableError(
          `Angel One server error ${res.status}`,
          "DOWN",
          { status: res.status, retryable: true },
        );
      }

      let body: AngelEnvelope<T>;
      try {
        body = (await res.json()) as AngelEnvelope<T>;
      } catch (cause) {
        throw new MarketDataUnavailableError(
          "Invalid JSON from Angel One",
          "DOWN",
          { retryable: true, cause },
        );
      }

      const ok = body.status === true || body.status === "true";
      if (!ok) {
        const code = body.errorcode ?? "";
        const authFail = code.startsWith("AB100") || /login|token|auth/i.test(body.message ?? "");
        throw new MarketDataUnavailableError(
          body.message ?? "Angel One request failed",
          authFail ? "AUTH" : res.status === 429 ? "RATE_LIMITED" : "INVALID",
          { status: res.status, retryable: !authFail },
        );
      }
      return body.data as T;
    }),
  );
}

export async function loginWithTotp(): Promise<AngelSession> {
  const clientCode = requiredEnv("ANGEL_ONE_CLIENT_CODE");
  const pin = requiredEnv("ANGEL_ONE_PIN");
  const totpSecret = requiredEnv("ANGEL_ONE_TOTP_SECRET");
  const totp = authenticator.generate(totpSecret);

  const data = await angelFetch<{
    jwtToken: string;
    refreshToken: string;
    feedToken?: string;
  }>("/rest/auth/angelbroking/user/v1/loginByPassword", {
    method: "POST",
    auth: false,
    body: JSON.stringify({
      clientcode: clientCode,
      password: pin,
      totp,
    }),
  });

  cachedSession = {
    jwtToken: data.jwtToken,
    refreshToken: data.refreshToken,
    feedToken: data.feedToken,
    clientCode,
    obtainedAt: Date.now(),
  };
  return cachedSession;
}

export async function refreshSession(refreshToken: string): Promise<AngelSession> {
  const clientCode = requiredEnv("ANGEL_ONE_CLIENT_CODE");
  const data = await angelFetch<{
    jwtToken: string;
    refreshToken: string;
    feedToken?: string;
  }>("/rest/auth/angelbroking/jwt/v1/generateTokens", {
    method: "POST",
    auth: false,
    body: JSON.stringify({ refreshToken }),
    headers: commonHeaders(requiredEnv("ANGEL_ONE_API_KEY")),
  });

  cachedSession = {
    jwtToken: data.jwtToken,
    refreshToken: data.refreshToken ?? refreshToken,
    feedToken: data.feedToken,
    clientCode,
    obtainedAt: Date.now(),
  };
  return cachedSession;
}

/**
 * Session stays valid until midnight IST per Angel One docs.
 * We refresh proactively if older than 6 hours or missing.
 */
export async function getSession(): Promise<AngelSession> {
  if (cachedSession) {
    const ageMs = Date.now() - cachedSession.obtainedAt;
    if (ageMs < 6 * 60 * 60 * 1000) return cachedSession;
    try {
      return await refreshSession(cachedSession.refreshToken);
    } catch {
      return loginWithTotp();
    }
  }
  return loginWithTotp();
}

export async function angelPost<T>(path: string, body: unknown): Promise<T> {
  return angelFetch<T>(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function clearSession(): void {
  cachedSession = null;
}
