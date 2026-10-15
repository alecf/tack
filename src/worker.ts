import { createRemoteJWKSet, jwtVerify } from "jose";
import instructions from "./instructions.md";

export interface Env {
  BUCKET: R2Bucket;
  MODE: "public" | "private";
  TACK_TOKEN?: string;
  PUBLIC_BASE?: string;
  PRIVATE_BASE?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
}

interface Board {
  id: string;
  visibility: "public" | "private";
  label: string;
  createdAt: string;
  expiresAt: string | null;
}

const MAX_BYTES = 25 * 1024 * 1024;
const ID = /^[a-z2-7]{26}$/;
const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
  woff2: "font/woff2",
  map: "application/json",
};
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function validPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 200 &&
    /^[A-Za-z0-9._/-]+$/.test(path) &&
    !path.includes("..") &&
    path.split("/").every((segment) => segment && !segment.startsWith("."))
  );
}

function fileType(path: string): string {
  const extension = path.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? "";
  if (!Object.hasOwn(TYPES, extension))
    throw new HttpError(415, "Unsupported file type");
  return TYPES[extension] as string;
}

function newId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let value = 0;
  let id = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      id += alphabet[(value >>> bits) & 31];
    }
  }
  return id + alphabet[(value << (5 - bits)) & 31];
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

async function* objects(bucket: R2Bucket, prefix: string) {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    yield page.objects;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

async function getBoard(env: Env, id: string): Promise<Board | null> {
  if (!ID.test(id)) return null;
  const object = await env.BUCKET.get(`boards/${id}.json`);
  return object ? object.json<Board>() : null;
}

function expired(board: Board, now = Date.now()): boolean {
  return board.expiresAt !== null && Date.parse(board.expiresAt) <= now;
}

async function purge(env: Env, board: Board) {
  for await (const page of objects(
    env.BUCKET,
    `${board.visibility}/${board.id}/`,
  )) {
    if (page.length) await env.BUCKET.delete(page.map((object) => object.key));
  }
  // Keep metadata until all file deletions succeed so the cron can retry.
  await env.BUCKET.delete(`boards/${board.id}.json`);
}

function boardUrl(board: Board, request: Request, env: Env): string {
  const base =
    board.visibility === "public"
      ? env.PUBLIC_BASE || new URL(request.url).origin
      : env.PRIVATE_BASE;
  if (!base) throw new HttpError(503, "Set PRIVATE_BASE");
  return `${new URL(base).origin}/${board.visibility === "public" ? "b" : "p"}/${board.id}/`;
}

async function tokenAuth(request: Request, env: Env) {
  if (!env.TACK_TOKEN) throw new HttpError(503, "TACK_TOKEN is not configured");
  const header = request.headers.get("Authorization") ?? "";
  const digest = (value: string) =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const [actual, expected] = await Promise.all([
    digest(header),
    digest(["Bearer", env.TACK_TOKEN].join(" ")),
  ]);
  if (!crypto.subtle.timingSafeEqual(actual, expected)) {
    throw new HttpError(401, "Unauthorized");
  }
}

async function accessAuth(request: Request, env: Env) {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    throw new HttpError(503, "Access is not configured");
  }
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  try {
    if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_DOMAIN)) {
      throw new Error("Invalid Access team domain");
    }
    let jwks = jwksCache.get(issuer);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
      jwksCache.set(issuer, jwks);
    }
    await jwtVerify(
      request.headers.get("Cf-Access-Jwt-Assertion") ?? "",
      jwks,
      {
        issuer,
        audience: env.ACCESS_AUD,
        algorithms: ["RS256"],
        requiredClaims: ["exp", "sub"],
      },
    );
  } catch {
    throw new HttpError(403, "Forbidden");
  }
}

async function uploadBody(request: Request): Promise<ArrayBuffer> {
  const length = request.headers.get("Content-Length");
  if (length && Number(length) > MAX_BYTES)
    throw new HttpError(413, "File too large");
  const reader = request.body?.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw new HttpError(413, "File too large");
      }
      chunks.push(value);
    }
  }
  return new Blob(chunks).arrayBuffer();
}

async function api(
  request: Request,
  env: Env,
  pathname: string,
): Promise<Response> {
  await tokenAuth(request, env);
  if (pathname === "/api/boards") {
    if (request.method === "POST") {
      let input: Record<string, unknown>;
      try {
        const body = await request.json();
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw new Error();
        input = body as Record<string, unknown>;
      } catch {
        throw new HttpError(400, "Invalid JSON object");
      }
      const { visibility, label = "", expires = "1y" } = input;
      const days = { "30d": 30, "6m": 183, "1y": 365, never: null };
      if (
        (visibility !== "public" && visibility !== "private") ||
        typeof label !== "string" ||
        [...label].length > 100 ||
        typeof expires !== "string" ||
        !Object.hasOwn(days, expires)
      ) {
        throw new HttpError(400, "Invalid board properties");
      }
      const ttl = days[expires as keyof typeof days];
      const now = Date.now();
      const board: Board = {
        id: newId(),
        visibility,
        label,
        createdAt: new Date(now).toISOString(),
        expiresAt:
          ttl === null ? null : new Date(now + ttl * 86400000).toISOString(),
      };
      const url = boardUrl(board, request, env);
      await env.BUCKET.put(`boards/${board.id}.json`, JSON.stringify(board));
      return json({ ...board, url }, 201);
    }
    if (request.method === "GET") {
      const boards = [];
      for await (const page of objects(env.BUCKET, "boards/")) {
        for (const object of page) {
          const metadata = await env.BUCKET.get(object.key);
          if (!metadata) continue;
          const board = await metadata.json<Board>();
          let fileCount = 0;
          let totalBytes = 0;
          for await (const files of objects(
            env.BUCKET,
            `${board.visibility}/${board.id}/`,
          )) {
            fileCount += files.length;
            totalBytes += files.reduce((sum, file) => sum + file.size, 0);
          }
          boards.push({
            ...board,
            url: boardUrl(board, request, env),
            fileCount,
            totalBytes,
          });
        }
      }
      return json(boards);
    }
  }
  const match = /^\/api\/boards\/([a-z2-7]{26})(?:\/(.*))?$/.exec(pathname);
  if (!match) return new Response("Not found", { status: 404 });
  const board = await getBoard(env, match[1] as string);
  if (!board) return new Response("Not found", { status: 404 });
  const path = match[2];
  if (request.method === "DELETE" && path === undefined) {
    await purge(env, board);
    return json({ deleted: true });
  }
  if (
    path !== undefined &&
    (request.method === "PUT" || request.method === "DELETE")
  ) {
    if (!validPath(path)) throw new HttpError(400, "Invalid file path");
    const key = `${board.visibility}/${board.id}/${path}`;
    if (request.method === "DELETE") {
      await env.BUCKET.delete(key);
      return json({ deleted: true });
    }
    if (expired(board)) return new Response("Not found", { status: 404 });
    const type = fileType(path);
    const url = boardUrl(board, request, env) + path;
    await env.BUCKET.put(key, await uploadBody(request), {
      httpMetadata: { contentType: type },
    });
    return json({ url });
  }
  return new Response("Not found", { status: 404 });
}

async function route(request: Request, env: Env): Promise<Response> {
  if (env.MODE === "private") await accessAuth(request, env);
  else if (env.MODE !== "public") throw new HttpError(503, "Invalid MODE");
  const url = new URL(request.url);
  if (env.MODE === "public") {
    if (url.pathname.startsWith("/api/"))
      return api(request, env, url.pathname);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(instructions.replaceAll("{{BASE}}", url.origin), {
        headers: { "Content-Type": "text/markdown; charset=utf-8" },
      });
    }
    if (request.method === "GET" && url.pathname === "/robots.txt") {
      return new Response("User-agent: *\nDisallow: /\n", {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  }
  const match = /^\/(b|p)\/([a-z2-7]{26})\/(.*)$/.exec(url.pathname);
  const visibility = env.MODE;
  if (
    request.method === "GET" &&
    match &&
    match[1] === (visibility === "public" ? "b" : "p")
  ) {
    const board = await getBoard(env, match[2] as string);
    const path = match[3] || "index.html";
    if (
      board &&
      board.visibility === visibility &&
      !expired(board) &&
      validPath(path)
    ) {
      const file = await env.BUCKET.get(`${visibility}/${board.id}/${path}`);
      if (file) {
        return new Response(file.body, {
          headers: {
            "Content-Type": fileType(path),
            "Cache-Control":
              visibility === "public"
                ? "public, max-age=3600"
                : "private, no-store",
          },
        });
      }
    }
  }
  return new Response("Not found", { status: 404 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let response: Response;
    try {
      response = await route(request, env);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message =
        error instanceof HttpError ? error.message : "Internal server error";
      response = new URL(request.url).pathname.startsWith("/api/")
        ? json({ error: message }, status)
        : new Response(message, { status });
    }
    response.headers.set("X-Content-Type-Options", "nosniff");
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
    response.headers.set("Referrer-Policy", "no-referrer");
    if (!response.headers.has("Cache-Control"))
      response.headers.set("Cache-Control", "private, no-store");
    return response;
  },
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (env.MODE !== "public") return;
    for await (const page of objects(env.BUCKET, "boards/"))
      for (const object of page) {
        const metadata = await env.BUCKET.get(object.key);
        if (!metadata) continue;
        const board = await metadata.json<Board>();
        if (expired(board, controller.scheduledTime)) await purge(env, board);
      }
  },
} satisfies ExportedHandler<Env>;
