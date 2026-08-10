import { parsePositiveInteger, parseStrictPositiveInteger } from "../utils/env-parsing.js";

export type TransportOptions = { kind: "stdio" } | { kind: "http"; port: number; host?: string };

export function parseCsvEnv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const values = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

export function parseHttpEnvironmentOptions(env: NodeJS.ProcessEnv = process.env) {
  return {
    authToken: env.NOTEBOOKLM_HTTP_AUTH_TOKEN,
    allowedOrigins: parseCsvEnv(env.NOTEBOOKLM_ALLOWED_ORIGINS),
    allowedHosts: parseCsvEnv(env.NOTEBOOKLM_ALLOWED_HOSTS),
    maxBodyBytes: parsePositiveInteger(env.NOTEBOOKLM_HTTP_MAX_BODY_BYTES, 1024 * 1024),
    maxSessions: parsePositiveInteger(env.NOTEBOOKLM_HTTP_MAX_SESSIONS, 32),
  };
}

export function parseTransportOptions(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): TransportOptions {
  const envTransport = env.NOTEBOOKLM_TRANSPORT;
  let kind: "stdio" | "http" =
    envTransport === "http" || envTransport === "stdio" ? envTransport : "stdio";
  let port = parsePositiveInteger(env.NOTEBOOKLM_PORT, 3000, 65_535);
  let host: string | undefined = env.NOTEBOOKLM_HOST;
  let explicitPort: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--transport") {
      const next = argv[i + 1];
      if (next === "http" || next === "stdio") {
        kind = next;
        i++;
      }
    } else if (arg.startsWith("--transport=")) {
      const value = arg.slice("--transport=".length);
      if (value === "http" || value === "stdio") kind = value;
    } else if (arg === "--port") {
      if (i + 1 < argv.length) explicitPort = argv[++i];
    } else if (arg.startsWith("--port=")) explicitPort = arg.slice(7);
    else if (arg === "--host") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        host = next;
        i++;
      }
    } else if (arg.startsWith("--host=")) host = arg.slice(7);
  }
  if (explicitPort !== undefined) {
    const parsed = parseStrictPositiveInteger(explicitPort, 65_535);
    if (parsed === undefined) {
      if (kind === "http")
        throw new Error(`Invalid HTTP port: ${explicitPort}. Expected an integer from 1 to 65535.`);
    } else port = parsed;
  }
  return kind === "http" ? { kind, port, ...(host === undefined ? {} : { host }) } : { kind };
}
