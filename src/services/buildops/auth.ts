/**
 * BuildOps credential login.
 * Exchanges a tenant's OAuth client credentials for a Bearer access token via
 * POST /v1/auth/token. The token is what every other BuildOps call sends as
 * `Authorization: Bearer <token>` and is mirrored into buildops_tenants.access_token.
 */

export interface LoginCredentials {
  clientId: string;
  clientSecret: string;
  /** BuildOps internal tenant UUID — the same value stored as buildops_tenants.buildops_tenant_id. */
  tenantId: string;
}

export interface LoginResult {
  accessToken: string;
  /** Always `bearer` from BuildOps; passed through so callers do not hardcode the scheme. */
  tokenType: string;
  /** Seconds until the token expires. BuildOps returns 10800 (3 hours). */
  expiresIn: number | null;
  /** Token expiry as an ISO-8601 string, or null when neither expires_in nor a JWT `exp` claim is present. */
  expiresAt: string | null;
}

/** Thrown when BuildOps rejects the credentials or the auth call fails. Carries the upstream HTTP status. */
export class BuildOpsAuthError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'BuildOpsAuthError';
  }
}

/**
 * Reads the `exp` claim from a JWT without verifying the signature.
 * BuildOps does not return `expires_in`, so expiry is only visible inside the token.
 *
 * @param token - Raw JWT string
 * @returns Expiry as an ISO-8601 string, or null if the token is not a JWT or has no `exp`
 */
function expiryFromJwt(token: string): string | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const exp = (JSON.parse(json) as { exp?: number }).exp;
    return typeof exp === 'number' ? new Date(exp * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

/**
 * Logs in to BuildOps with client credentials and returns a fresh access token.
 *
 * @param apiUrl      - BuildOps API base URL, e.g. `https://public-api.live.buildops.com`
 * @param credentials - clientId, clientSecret, and the BuildOps tenant UUID
 * @returns Fresh access token plus its expiry when derivable
 * @throws BuildOpsAuthError when BuildOps returns a non-2xx status or a response with no access_token
 */
export async function login(apiUrl: string, credentials: LoginCredentials): Promise<LoginResult> {
  const res = await fetch(`${apiUrl}/v1/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      tenantId: credentials.tenantId,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new BuildOpsAuthError(`BuildOps auth failed (${res.status}): ${text}`, res.status);
  }

  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    token_type?: string;
    expires_in?: number;
  };
  if (!data.access_token) {
    throw new BuildOpsAuthError('BuildOps auth response missing access_token', 502);
  }

  const expiresAt = typeof data.expires_in === 'number'
    ? new Date(Date.now() + data.expires_in * 1000).toISOString()
    : expiryFromJwt(data.access_token);

  return {
    accessToken: data.access_token,
    tokenType: data.token_type ?? 'bearer',
    expiresIn: data.expires_in ?? null,
    expiresAt,
  };
}
