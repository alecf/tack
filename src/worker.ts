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

async function* objects(
  bucket: R2Bucket,
  prefix: string,
  include: R2ListOptions["include"] = [],
) {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000, include });
    yield page.objects;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

async function getBoard(env: Env, id: string): Promise<Board | null> {
  if (!ID.test(id)) return null;
  const object = await env.BUCKET.get(`boards/${id}.json`);
  return object ? object.json<Board>() : null;
}

// Board fields are mirrored into customMetadata so listing boards (API and cron)
// needs one R2 list per 1000 boards instead of one GET per board.
export async function saveBoard(bucket: R2Bucket, board: Board) {
  await bucket.put(`boards/${board.id}.json`, JSON.stringify(board), {
    customMetadata: {
      visibility: board.visibility,
      label: board.label,
      createdAt: board.createdAt,
      expiresAt: board.expiresAt ?? "",
    },
  });
}

async function listBoards(bucket: R2Bucket): Promise<Board[]> {
  const boards: Board[] = [];
  for await (const page of objects(bucket, "boards/", ["customMetadata"])) {
    for (const object of page) {
      const id = object.key.slice("boards/".length, -".json".length);
      const meta = object.customMetadata ?? {};
      if (
        !ID.test(id) ||
        (meta.visibility !== "public" && meta.visibility !== "private") ||
        !meta.createdAt
      )
        continue;
      boards.push({
        id,
        visibility: meta.visibility,
        label: meta.label ?? "",
        createdAt: meta.createdAt,
        expiresAt: meta.expiresAt || null,
      });
    }
  }
  return boards;
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
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_DOMAIN)) {
    throw new HttpError(
      503,
      "ACCESS_TEAM_DOMAIN must be a bare <team>.cloudflareaccess.com",
    );
  }
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  try {
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
      await saveBoard(env.BUCKET, board);
      return json({ ...board, url }, 201);
    }
    if (request.method === "GET") {
      const stats = new Map<
        string,
        { fileCount: number; totalBytes: number }
      >();
      for (const visibility of ["public", "private"]) {
        for await (const page of objects(env.BUCKET, `${visibility}/`)) {
          for (const file of page) {
            const board = file.key.split("/", 2).join("/");
            const entry = stats.get(board) ?? { fileCount: 0, totalBytes: 0 };
            entry.fileCount += 1;
            entry.totalBytes += file.size;
            stats.set(board, entry);
          }
        }
      }
      const boards = (await listBoards(env.BUCKET)).map((board) => ({
        ...board,
        url: boardUrl(board, request, env),
        ...(stats.get(`${board.visibility}/${board.id}`) ?? {
          fileCount: 0,
          totalBytes: 0,
        }),
      }));
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
  const visibility = env.MODE;
  const prefix = visibility === "public" ? "b" : "p";
  const match = /^\/(b|p)\/([a-z2-7]{26})(\/.*)?$/.exec(url.pathname);
  if (
    (request.method === "GET" || request.method === "HEAD") &&
    match &&
    match[1] === prefix
  ) {
    if (match[3] === undefined) {
      return new Response(null, {
        status: 301,
        headers: { Location: `/${prefix}/${match[2]}/` },
      });
    }
    const board = await getBoard(env, match[2] as string);
    let path = match[3].slice(1);
    if (path === "" || path.endsWith("/")) path += "index.html";
    if (
      board &&
      board.visibility === visibility &&
      !expired(board) &&
      validPath(path)
    ) {
      const response = await serveFile(
        request,
        env,
        `${visibility}/${board.id}/${path}`,
        path,
      );
      if (response) {
        response.headers.set(
          "Cache-Control",
          visibility === "public"
            ? "public, max-age=3600"
            : "private, no-store",
        );
        return response;
      }
    }
  }
  return new Response("Not found", { status: 404 });
}

// Serves an R2 object with ETag/conditional and single byte-range support
// (Safari needs ranges to play video). Returns null when the object is missing.
async function serveFile(
  request: Request,
  env: Env,
  key: string,
  path: string,
): Promise<Response | null> {
  const headers = new Headers({
    "Content-Type": fileType(path),
    "Accept-Ranges": "bytes",
  });
  if (request.method === "HEAD") {
    const head = await env.BUCKET.head(key);
    if (!head) return null;
    headers.set("ETag", head.httpEtag);
    headers.set("Content-Length", String(head.size));
    return new Response(null, { headers });
  }
  const ranged = request.headers.has("Range");
  let file: R2Object | R2ObjectBody | null;
  try {
    file = await env.BUCKET.get(key, {
      onlyIf: request.headers,
      ...(ranged ? { range: request.headers } : {}),
    });
  } catch {
    // R2 rejects unsatisfiable or malformed ranges.
    const head = await env.BUCKET.head(key);
    if (!head) return null;
    headers.set("Content-Range", `bytes */${head.size}`);
    return new Response("Range not satisfiable", { status: 416, headers });
  }
  if (!file) return null;
  headers.set("ETag", file.httpEtag);
  if (!("body" in file)) return new Response(null, { status: 304, headers });
  const range = file.range as
    | { offset?: number; length?: number; suffix?: number }
    | undefined;
  if (ranged && range) {
    const offset =
      range.suffix !== undefined
        ? Math.max(0, file.size - range.suffix)
        : (range.offset ?? 0);
    const length =
      range.suffix !== undefined
        ? file.size - offset
        : (range.length ?? file.size - offset);
    headers.set(
      "Content-Range",
      `bytes ${offset}-${offset + length - 1}/${file.size}`,
    );
    return new Response(file.body, { status: 206, headers });
  }
  return new Response(file.body, { headers });
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
    for (const board of await listBoards(env.BUCKET)) {
      if (expired(board, controller.scheduledTime)) await purge(env, board);
    }
  },
} satisfies ExportedHandler<Env>;
