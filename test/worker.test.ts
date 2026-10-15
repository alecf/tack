import { createScheduledController, env, SELF } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import worker, { type Env, validPath } from "../src/worker";

declare global {
  namespace Cloudflare {
    interface Env {
      BUCKET: R2Bucket;
      MODE: "public";
      TACK_TOKEN: string;
    }
  }
}

interface Board {
  id: string;
  visibility: "public" | "private";
  label: string;
  createdAt: string;
  expiresAt: string | null;
  url: string;
  fileCount?: number;
  totalBytes?: number;
}

const publicEnv: Env = {
  ...env,
  PUBLIC_BASE: "https://public.example",
  PRIVATE_BASE: "https://private.example",
};
const privateEnv: Env = {
  ...publicEnv,
  MODE: "private",
  ACCESS_TEAM_DOMAIN: "tack-tests.cloudflareaccess.com",
  ACCESS_AUD: "test-audience",
};
const authorization = ["Bearer", env.TACK_TOKEN].join(" ");
let privateKey: CryptoKey;
let token: string;
let jwks: string;

async function sign(
  options: {
    issuer?: string;
    audience?: string;
    expiry?: number;
    key?: CryptoKey;
  } = {},
) {
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setSubject("owner@example.com")
    .setIssuer(options.issuer ?? `https://${privateEnv.ACCESS_TEAM_DOMAIN}`)
    .setAudience(options.audience ?? "test-audience")
    .setExpirationTime(options.expiry ?? Math.floor(Date.now() / 1000) + 300)
    .sign(options.key ?? privateKey);
}

async function call(
  path: string,
  init: RequestInit = {},
  bindings = publicEnv,
) {
  const response = await worker.fetch(
    new Request(`https://public.example${path}`, init),
    bindings,
  );
  return new Response(await response.arrayBuffer(), response);
}

function api(path = "", init: RequestInit = {}) {
  return call(`/api/boards${path}`, {
    ...init,
    headers: { Authorization: authorization, ...init.headers },
  });
}

async function board(
  visibility: "public" | "private" = "public",
  properties = {},
) {
  const response = await api("", {
    method: "POST",
    body: JSON.stringify({ visibility, ...properties }),
  });
  expect(response.status).toBe(201);
  return response.json<Board>();
}

function upload(id: string, path = "index.html", body = "<h1>Hello</h1>") {
  return api(`/${id}/${path}`, { method: "PUT", body });
}

function privateGet(path: string, jwt = token, bindings = privateEnv) {
  return call(path, { headers: { "Cf-Access-Jwt-Assertion": jwt } }, bindings);
}

function securityHeaders(response: Response) {
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
}

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  jwks = JSON.stringify({
    keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }],
  });
  token = await sign();
});

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    expect(String(input)).toBe(
      `https://${privateEnv.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`,
    );
    return new Response(jwks, {
      headers: { "Content-Type": "application/json" },
    });
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  let page: R2Objects;
  do {
    page = await env.BUCKET.list({ limit: 1000 });
    if (page.objects.length) {
      await env.BUCKET.delete(page.objects.map((object) => object.key));
    }
  } while (page.truncated);
});

describe("path validation", () => {
  it.each(["index.html", "assets/my-file_1.PNG", `${"a".repeat(196)}.txt`])(
    "accepts %s",
    (path) => {
      expect(validPath(path)).toBe(true);
    },
  );
  it.each([
    "",
    "/a.png",
    "a/",
    "a//b.png",
    "../a.png",
    "a/../b.png",
    ".env",
    "a/.hidden.png",
    "a..png",
    "a b.png",
    "a%2fb.png",
    "a\\b.png",
    "é.png",
    `${"a".repeat(197)}.txt`,
  ])("rejects %s", (path) => {
    expect(validPath(path)).toBe(false);
  });
  it("rejects invalid API paths without writing objects", async () => {
    const b = await board();
    for (const path of [
      "a//b.png",
      ".hidden.png",
      "a..png",
      "a%2Fb.png",
      "a/",
    ]) {
      expect((await upload(b.id, path)).status).toBe(400);
    }
    expect(
      (await env.BUCKET.list({ prefix: `public/${b.id}/` })).objects,
    ).toHaveLength(0);
  });
});

describe("uploads", () => {
  it.each([
    ["png", "image/png"],
    ["jpg", "image/jpeg"],
    ["jpeg", "image/jpeg"],
    ["gif", "image/gif"],
    ["webp", "image/webp"],
    ["avif", "image/avif"],
    ["svg", "image/svg+xml"],
    ["html", "text/html; charset=utf-8"],
    ["css", "text/css; charset=utf-8"],
    ["js", "text/javascript; charset=utf-8"],
    ["mjs", "text/javascript; charset=utf-8"],
    ["json", "application/json"],
    ["txt", "text/plain; charset=utf-8"],
    ["md", "text/markdown; charset=utf-8"],
    ["pdf", "application/pdf"],
    ["mp4", "video/mp4"],
    ["webm", "video/webm"],
    ["woff2", "font/woff2"],
    ["map", "application/json"],
    ["PNG", "image/png"],
  ])(
    "serves .%s with its mapped type, ignoring supplied type",
    async (ext, type) => {
      const b = await board();
      const response = await api(`/${b.id}/file.${ext}`, {
        method: "PUT",
        body: "content",
        headers: { "Content-Type": "text/evil" },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ url: `${b.url}file.${ext}` });
      const served = await call(`/b/${b.id}/file.${ext}`);
      expect(served.headers.get("Content-Type")).toBe(type);
      expect(new TextDecoder().decode(await served.arrayBuffer())).toBe(
        "content",
      );
    },
  );
  it.each(["exe", "zip", "htm", "constructor", "toString", ""])(
    "rejects .%s",
    async (ext) => {
      const b = await board();
      expect((await upload(b.id, `file.${ext}`)).status).toBe(415);
    },
  );
  it("rejects extensionless files even when their names match allowed extensions", async () => {
    const b = await board();
    expect((await upload(b.id, "png")).status).toBe(415);
    expect((await upload(b.id, "assets/html")).status).toBe(415);
  });
  it("overwrites and lists exact counts and sizes, then deletes one file", async () => {
    const b = await board("public", { label: "repo PR #12" });
    await upload(b.id, "a.txt", "one");
    await upload(b.id, "a.txt", "replacement");
    await upload(b.id, "nested/b.txt", "two");
    const list = await (await api()).json<Board[]>();
    expect(list).toEqual([{ ...b, fileCount: 2, totalBytes: 14 }]);
    expect(await (await call(`/b/${b.id}/a.txt`)).text()).toBe("replacement");
    expect((await api(`/${b.id}/a.txt`, { method: "DELETE" })).status).toBe(
      200,
    );
    expect((await call(`/b/${b.id}/a.txt`)).status).toBe(404);
    expect((await call(`/b/${b.id}/nested/b.txt`)).status).toBe(200);
  });
  it("limits both declared and streamed bodies to 25 MiB and preserves existing files", async () => {
    const b = await board();
    await upload(b.id, "a.txt", "original");
    const oversized = 25 * 1024 * 1024 + 1;
    expect(
      (
        await api(`/${b.id}/a.txt`, {
          method: "PUT",
          body: "small",
          headers: { "Content-Length": `${oversized}` },
        })
      ).status,
    ).toBe(413);
    let chunks = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
        if (++chunks === 26) controller.close();
      },
    });
    expect(
      (await api(`/${b.id}/a.txt`, { method: "PUT", body: stream })).status,
    ).toBe(413);
    expect(await (await call(`/b/${b.id}/a.txt`)).text()).toBe("original");
    expect((await api(`/${b.id}/empty.txt`, { method: "PUT" })).status).toBe(
      200,
    );
  });
});

describe("upload size boundary", () => {
  it("accepts exactly 25 MiB", async () => {
    const b = await board();
    const size = 25 * 1024 * 1024;
    const response = await api(`/${b.id}/large.txt`, {
      method: "PUT",
      body: new Uint8Array(size),
    });
    expect(response.status).toBe(200);
    expect((await env.BUCKET.head(`public/${b.id}/large.txt`))?.size).toBe(
      size,
    );
  });
});

describe("API authentication and board validation", () => {
  it("requires an exact bearer token on all API routes", async () => {
    for (const auth of [
      "",
      "Basic nope",
      ["Bearer", "wrong"].join(" "),
      `${authorization}x`,
    ]) {
      const response = await call("/api/boards", {
        headers: { Authorization: auth },
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("Content-Type")).toContain(
        "application/json",
      );
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      securityHeaders(response);
    }
    expect((await call("/api/anything")).status).toBe(401);
    expect((await api()).status).toBe(200);
    expect(
      (await call("/api/boards", {}, { ...publicEnv, TACK_TOKEN: undefined }))
        .status,
    ).toBe(503);
  });
  it("creates random base32 IDs and defaults to one year", async () => {
    const a = await board();
    const b = await board();
    expect(a.id).toMatch(/^[a-z2-7]{26}$/);
    expect(a.id).not.toBe(b.id);
    expect(a.label).toBe("");
    expect(Date.parse(a.expiresAt as string) - Date.parse(a.createdAt)).toBe(
      365 * 86400000,
    );
    expect(await env.BUCKET.get(`boards/${a.id}.json`)).not.toBeNull();
  });
  it.each([
    ["30d", 30],
    ["6m", 183],
    ["1y", 365],
    ["never", null],
  ] as const)("supports expiry %s", async (expires, days) => {
    const b = await board("public", { expires, label: "🚲".repeat(100) });
    expect(b.expiresAt).toBe(
      days === null
        ? null
        : new Date(Date.parse(b.createdAt) + days * 86400000).toISOString(),
    );
  });
  it.each([
    {},
    { visibility: "other" },
    { visibility: "public", label: 42 },
    { visibility: "public", label: "x".repeat(101) },
    { visibility: "public", expires: "2d" },
    { visibility: "public", expires: "constructor" },
    { visibility: "public", expires: null },
    [],
    null,
    "public",
  ])("rejects invalid create body %j", async (body) => {
    expect(
      (await api("", { method: "POST", body: JSON.stringify(body) })).status,
    ).toBe(400);
  });
  it("rejects malformed JSON and unsupported methods", async () => {
    expect((await api("", { method: "POST", body: "{" })).status).toBe(400);
    expect((await api("", { method: "PATCH" })).status).toBe(404);
  });
  it("uses request origin or configured bases without hardcoded hostnames", async () => {
    const response = await call(
      "/api/boards",
      {
        method: "POST",
        headers: { Authorization: authorization },
        body: '{"visibility":"public"}',
      },
      { ...publicEnv, PUBLIC_BASE: undefined },
    );
    const b = await response.json<Board>();
    expect(b.url).toBe(`https://public.example/b/${b.id}/`);
    const p = await board("private");
    expect(p.url).toBe(`https://private.example/p/${p.id}/`);
    expect(
      (
        await call(
          "/api/boards",
          {
            method: "POST",
            headers: { Authorization: authorization },
            body: '{"visibility":"private"}',
          },
          { ...publicEnv, PRIVATE_BASE: undefined },
        )
      ).status,
    ).toBe(503);
  });
});

describe("serving and separation", () => {
  it("serves index.html, relative assets, headers, and only the correct visibility and MODE", async () => {
    const pub = await board();
    const priv = await board("private");
    for (const b of [pub, priv]) {
      await upload(b.id);
      await upload(b.id, "assets/a.css", "body{}");
    }
    const publicFile = await call(`/b/${pub.id}/`);
    expect(await publicFile.text()).toBe("<h1>Hello</h1>");
    securityHeaders(publicFile);
    expect(publicFile.headers.get("Cache-Control")).toBe(
      "public, max-age=3600",
    );
    const privateFile = await privateGet(`/p/${priv.id}/`);
    expect(await privateFile.text()).toBe("<h1>Hello</h1>");
    securityHeaders(privateFile);
    expect(privateFile.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await privateGet(`/p/${priv.id}/assets/a.css`)).status).toBe(200);
    for (const path of [
      `/b/${priv.id}/`,
      `/p/${priv.id}/`,
      `/p/${pub.id}/`,
      `/b/${"a".repeat(26)}/`,
      `/b/${pub.id}/missing.png`,
      `/b/${pub.id}/.env`,
    ]) {
      const response = await call(path);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not found");
      securityHeaders(response);
    }
    for (const path of [
      `/p/${pub.id}/`,
      `/b/${pub.id}/`,
      `/b/${priv.id}/`,
      `/p/${priv.id}/missing.png`,
      "/",
      "/robots.txt",
      "/api/boards",
    ]) {
      expect((await privateGet(path)).status).toBe(404);
    }
    expect(
      (await call("/", {}, { ...publicEnv, MODE: "invalid" as Env["MODE"] }))
        .status,
    ).toBe(503);
  });
  it("does not list directories or serve other methods", async () => {
    const b = await board();
    expect((await call(`/b/${b.id}/`)).status).toBe(404);
    await upload(b.id, "dir/index.html");
    expect((await call(`/b/${b.id}/dir/`)).status).toBe(404);
    expect(
      (await call(`/b/${b.id}/dir/index.html`, { method: "POST" })).status,
    ).toBe(404);
    expect((await call("/unknown")).status).toBe(404);
  });
  it("serves unauthenticated Markdown instructions with the requesting host through the deployed handler", async () => {
    const response = await SELF.fetch("https://another.example/");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "text/markdown; charset=utf-8",
    );
    securityHeaders(response);
    const text = await response.text();
    expect(text).toContain("TACK_BASE='https://another.example'");
    expect(text).not.toContain("{{BASE}}");
    expect(text).toContain("$TACK_TOKEN");
    expect(text).toContain("Never commit images");
    expect(text).toContain("Authorization: $TACK_AUTH");
    expect(text).not.toContain("******");
    expect((await call("/robots.txt")).status).toBe(200);
    expect(await (await call("/robots.txt")).text()).toContain("Disallow: /");
  });
});

describe("Access JWT verification", () => {
  it("fails closed when either configuration variable is missing", async () => {
    for (const bindings of [
      { ...privateEnv, ACCESS_TEAM_DOMAIN: undefined },
      { ...privateEnv, ACCESS_AUD: undefined },
    ]) {
      const response = await privateGet("/", token, bindings);
      expect(response.status).toBe(503);
      securityHeaders(response);
    }
  });
  it("rejects absent, malformed, expired, wrong issuer/audience/signature and untrusted domains", async () => {
    const other = await generateKeyPair("RS256");
    for (const jwt of [
      "",
      "invalid",
      await sign({ expiry: 1 }),
      await sign({ issuer: "https://other.example" }),
      await sign({ audience: "other" }),
      await sign({ key: other.privateKey }),
    ]) {
      const response = await privateGet("/", jwt);
      expect(response.status).toBe(403);
      securityHeaders(response);
    }
    expect(
      (
        await privateGet("/", token, {
          ...privateEnv,
          ACCESS_TEAM_DOMAIN: "attacker.example",
        })
      ).status,
    ).toBe(403);
  });
  it("checks JWTs even on non-file routes and does not accept the API token as Access", async () => {
    expect(
      (
        await call(
          "/api/boards",
          { headers: { Authorization: authorization } },
          privateEnv,
        )
      ).status,
    ).toBe(403);
    expect((await privateGet("/")).status).toBe(404);
  });
});

describe("purge and expiry cron", () => {
  it("purges only the selected board and all nested files", async () => {
    const deleted = await board("private");
    const kept = await board();
    await upload(deleted.id);
    await upload(deleted.id, "dir/a.txt");
    await upload(kept.id);
    expect((await api(`/${deleted.id}`, { method: "DELETE" })).status).toBe(
      200,
    );
    expect(await env.BUCKET.get(`boards/${deleted.id}.json`)).toBeNull();
    expect(
      (await env.BUCKET.list({ prefix: `private/${deleted.id}/` })).objects,
    ).toHaveLength(0);
    expect((await call(`/b/${kept.id}/`)).status).toBe(200);
    expect((await api(`/${deleted.id}`, { method: "DELETE" })).status).toBe(
      404,
    );
  });
  it("paginates counts and purges more than 1000 real R2 files in bounded batches", async () => {
    const b = await board();
    for (let start = 0; start < 1003; start += 50) {
      await Promise.all(
        Array.from({ length: Math.min(50, 1003 - start) }, (_, offset) =>
          env.BUCKET.put(`public/${b.id}/${start + offset}.txt`, "x"),
        ),
      );
    }
    const listed = await (await api()).json<Board[]>();
    expect(listed[0]?.fileCount).toBe(1003);
    expect(listed[0]?.totalBytes).toBe(1003);
    const deletion = vi.spyOn(env.BUCKET, "delete");
    expect((await api(`/${b.id}`, { method: "DELETE" })).status).toBe(200);
    expect(
      deletion.mock.calls.every(
        ([keys]) => !Array.isArray(keys) || keys.length <= 1000,
      ),
    ).toBe(true);
    expect((await env.BUCKET.list()).objects).toHaveLength(0);
  }, 30000);
  it("refuses expired files immediately and cron purges both visibilities but keeps live/never boards", async () => {
    const expiredPublic = await board();
    const expiredPrivate = await board("private");
    const live = await board();
    const forever = await board("private", { expires: "never" });
    for (const b of [expiredPublic, expiredPrivate, live, forever])
      await upload(b.id);
    for (const b of [expiredPublic, expiredPrivate]) {
      await env.BUCKET.put(
        `boards/${b.id}.json`,
        JSON.stringify({ ...b, expiresAt: new Date(0).toISOString() }),
      );
    }
    expect((await call(`/b/${expiredPublic.id}/`)).status).toBe(404);
    expect((await privateGet(`/p/${expiredPrivate.id}/`)).status).toBe(404);
    expect((await upload(expiredPublic.id)).status).toBe(404);
    const controller = createScheduledController({ scheduledTime: Date.now() });
    await worker.scheduled(controller, privateEnv);
    expect(
      await env.BUCKET.get(`boards/${expiredPrivate.id}.json`),
    ).not.toBeNull();
    await worker.scheduled(controller, publicEnv);
    for (const b of [expiredPublic, expiredPrivate]) {
      expect(await env.BUCKET.get(`boards/${b.id}.json`)).toBeNull();
      expect(
        (await env.BUCKET.list({ prefix: `${b.visibility}/${b.id}/` })).objects,
      ).toHaveLength(0);
    }
    expect((await call(`/b/${live.id}/`)).status).toBe(200);
    expect((await privateGet(`/p/${forever.id}/`)).status).toBe(200);
  });
  it("paginates board metadata in listing and the cron", async () => {
    const template = await board();
    for (let start = 0; start < 1001; start += 50) {
      await Promise.all(
        Array.from({ length: Math.min(50, 1001 - start) }, (_, offset) => {
          const suffix = (start + offset)
            .toString(2)
            .replaceAll("0", "a")
            .replaceAll("1", "b");
          const id = suffix.padStart(26, "a");
          return env.BUCKET.put(
            `boards/${id}.json`,
            JSON.stringify({
              ...template,
              id,
              expiresAt: new Date(0).toISOString(),
            }),
          );
        }),
      );
    }
    expect(await (await api()).json<Board[]>()).toHaveLength(1002);
    await worker.scheduled(
      createScheduledController({ scheduledTime: Date.now() }),
      publicEnv,
    );
    expect((await env.BUCKET.list({ prefix: "boards/" })).objects).toHaveLength(
      1,
    );
    expect(await env.BUCKET.get(`boards/${template.id}.json`)).not.toBeNull();
  }, 60000);
});
