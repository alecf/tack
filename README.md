# Tack

A tiny personal file host for PR screenshots and shareable, multi-file HTML
artifacts. A board groups files under a random URL; its trailing-slash URL serves
`index.html`. Use public boards for PR images and private boards for artifacts.
There is no dashboard: the public root serves curl-readable agent instructions,
and a bearer-authenticated JSON API manages both kinds of boards.

Two Cloudflare Workers share one **non-public R2 bucket**:

| Wrangler environment | Worker | Purpose |
| --- | --- | --- |
| `public` | `tack` | Instructions, management API, public `/b/<id>/…` files, expiry cron |
| `private` | `tack-private` | Access-protected `/p/<id>/…` files only |

Private files are never served by the public worker. The private worker has no
management API. Public URLs are unlisted, **not secret or access-controlled**.
Do not upload sensitive information to public boards.

## From scratch

These are operator instructions, not a record of a deployment. **No deployment
has been performed and no Cloudflare credentials have been supplied.** Replace
`<account>` with your account's actual workers.dev subdomain; do not infer a
custom domain.

1. Install [Bun](https://bun.sh/docs/installation), then clone this repository
   and enter its root:

   ```bash
   curl -fsSL https://bun.sh/install | bash
   # Restart your shell so bun is on PATH.
   bun install --frozen-lockfile
   bunx wrangler login
   bunx wrangler r2 bucket create tack
   ```

   Enable R2 in your Cloudflare account if prompted. Keep the bucket private:
   do not enable an r2.dev URL or attach a public R2 custom domain.

2. The environments in
   `/home/runner/work/artifacts/artifacts/wrangler.jsonc` already bind `BUCKET`
   to the same `tack` bucket and set `MODE` to `public` or `private`.
   `workers_dev` is enabled and `preview_urls` is `false`. Deploy the private
   worker first:

   ```bash
   bun run deploy:private
   ```

   Until Access variables are configured, it deliberately returns **503** to
   every request. Leave it fail-closed while completing Access setup below.

3. Configure Access, copy its team domain and application AUD, add the private
   variables, then deploy the private worker again. Do not expose a private
   board before this is complete.

4. Add `PRIVATE_BASE` to the **public environment's** vars, then deploy public:

   ```jsonc
   // env.public.vars
   {
     "MODE": "public",
     "PRIVATE_BASE": "https://tack-private.<account>.workers.dev"
   }
   ```

   ```bash
   bun run deploy:public
   bunx wrangler secret put TACK_TOKEN --env public
   ```

   Enter a strong, unique token at Wrangler's interactive secret prompt. Store
   the same value in your password manager and agent environment as
   `TACK_TOKEN`; never put it in vars, source control, command arguments, URLs,
   or logs. Setting the secret after the initial public deployment is fine:
   the API fails closed with **503** until the secret exists. Wrong or missing
   bearer credentials then return **401**.

### Configure Cloudflare Access (owner-only OTP)

Follow the current
[Workers Access setup](https://developers.cloudflare.com/workers/configuration/cloudflare-access/):

1. Open **Workers & Pages → tack-private → Access → Protect this Worker behind
   Access → All traffic → Apply Access**. Older dashboards called this the
   workers.dev **Cloudflare Access** toggle. Protect the **entire production
   `tack-private.<account>.workers.dev` hostname**, not just previews or one
   path. Leave preview URLs disabled.
2. In Zero Trust, open **Integrations → Identity providers → Add → One-time
   PIN** if it is absent. New organizations may not have this provider.
3. Under **Access controls → Applications**, edit the generated application.
   Select **One-time PIN as its only identity provider**. Use an **Allow**
   policy whose **Emails** selector contains only your exact owner email.
   Remove broad/default Allow policies (such as Everyone or whole email
   domains). Do not add a Bypass rule.
4. In that application's **Additional settings**, copy **Application Audience
   (AUD) Tag**. Enabling the Workers toggle does **not** automatically provide
   an AUD binding to the worker.
5. Get your team domain from **Zero Trust settings**. Add these to the private
   environment's vars in
   `/home/runner/work/artifacts/artifacts/wrangler.jsonc`:

   ```jsonc
   // env.private.vars
   {
     "MODE": "private",
     "ACCESS_TEAM_DOMAIN": "<team>.cloudflareaccess.com",
     "ACCESS_AUD": "<application-aud-tag>"
   }
   ```

   `ACCESS_TEAM_DOMAIN` must be the bare hostname: no `https://`, path, or
   trailing slash. `ACCESS_AUD` belongs to this generated private application.
   These are configuration identifiers, not bearer-token secrets.
6. Run `bun run deploy:private` again. Confirm an unauthenticated browser is
   challenged by Access and your owner email can sign in with an emailed PIN.
   A missing board still returns 404 after successful authentication.

The worker independently verifies the `Cf-Access-Jwt-Assertion` JWT using the
team's remote signing keys: RS256 signature, issuer, audience, expiration, and
required subject (`sub`). Missing Access configuration returns **503**;
malformed configuration or missing/invalid assertions return **403** at the
worker. The Access edge may instead redirect an unauthenticated browser to
login. Unknown `MODE` values fail closed with **503**.

To share a private artifact, add the viewer's **exact email** to the Access
application's Allow policy. They authenticate with OTP; never give them
`TACK_TOKEN`, disable Access, or make the bucket public.

### URL configuration and later custom domains

| Setting | Where | Behavior |
| --- | --- | --- |
| `TACK_TOKEN` | Public worker secret | Required for every management API request |
| `PRIVATE_BASE` | Public worker vars | Required to create private boards and generate their URLs; use the private worker's HTTPS origin |
| `PUBLIC_BASE` | Public worker vars, optional | Overrides the origin for public board URLs; otherwise uses the incoming request's origin |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | Private worker vars | Required for private JWT validation |

Use origins, not path prefixes; generated URLs use the configured URL's origin.
Without `PRIVATE_BASE`, private board creation returns 503 without creating
metadata; listing boards also requires it if private boards exist.
There is no custom-domain discovery. If you add custom domains later, protect
the private custom hostname with Access too, keep the workers.dev links working
and protected, and update `PUBLIC_BASE`/`PRIVATE_BASE` explicitly. Ensure the
private worker's AUD matches the applicable Access application.

## Agent and Claude Code setup

Copy this exact line into an agent instruction file, replacing `<account>`
with your real workers.dev subdomain:

> For PR screenshots and shareable HTML artifacts, run `curl -s https://tack.<account>.workers.dev/` and follow it. The token is in `$TACK_TOKEN`.

For Claude Code cloud sessions, allow network access to **both**
`tack.<account>.workers.dev` and `tack-private.<account>.workers.dev`. Store
`TACK_TOKEN` as an environment secret. Read the public root with **curl, not
fetch**, which may summarize away instructions. Root instructions use Bash,
curl, and jq. Do not print the token, enable shell tracing, or follow redirects
while sending it. Network diagnostics must include only the blocked hostname,
never credentials.

Use one public board per PR, labeled `<repo> PR #<n>`, and reuse it on later
pushes. Upload images and embed their returned URLs; do not commit screenshots
or create image branches. Use a private board for other artifacts, uploading
`index.html` plus relative CSS/JS/image/font assets. Do not upload dependencies,
hidden files, credentials, or private source data.

## API and file rules

All management happens on the public worker with an `Authorization` header
whose value is `Bearer`, one space, then the value of `$TACK_TOKEN`.
Access login is not API authentication; cookies and query-string tokens are
not accepted. API success bodies are JSON;
validation/authentication exceptions return JSON `{"error":"…"}`. Unmatched
routes and missing resources return plain-text 404 responses.

| Method and route | Result |
| --- | --- |
| `POST /api/boards` | JSON object with required `visibility: "public" \| "private"`, optional `label` and `expires`; returns board metadata and URL (201) |
| `GET /api/boards` | JSON array of both kinds of boards with metadata, URL, `fileCount`, and `totalBytes`; may include expired boards awaiting cleanup |
| `PUT /api/boards/<id>/<path>` | Raw file body, not multipart; creates or overwrites a file and returns `{"url":"…"}` |
| `DELETE /api/boards/<id>/<path>` | Deletes that file; returns `{"deleted":true}` |
| `DELETE /api/boards/<id>` | Irreversibly purges every file and board metadata; returns `{"deleted":true}` |

Send `Content-Type: application/json` for board creation. Visibility is explicit
and cannot be changed after creation. Labels default to empty and may contain
up to **100 Unicode code points**. IDs contain 26 random base32 characters.
There is no file-listing UI or general-purpose directory index; only the board
root falls back to `index.html`. File reads use GET.

* Maximum file size: **25 MiB** (26,214,400 bytes), enforced while reading the
  body, including when Content-Length is absent; oversized uploads return 413.
* Paths: 1–200 ASCII characters from `A-Z a-z 0-9 . _ / -`. No `..`, empty
  segments, dot-prefixed segments, leading slash, or trailing slash. Paths are
  literal: no percent-decoding or encoded-path aliases.
* Extensions are case-insensitive and determine Content-Type, not the
  uploader's header. Allowed: `png jpg jpeg gif webp avif svg html css js mjs
  json txt md pdf mp4 webm woff2 map`. Unsupported extensions return 415.
* Expiry options: `30d` = 30 days, `6m` = 183 days, `1y` = 365 days
  (**default**), or `never`. Expiry is fixed when the board is created;
  overwriting a file does not extend it.
* Expired file reads and uploads return **404 immediately** at the worker.
  Public content already cached by clients can remain visible until its
  one-hour cache lifetime ends.
* The public worker's daily **03:00 UTC** cron physically purges expired
  boards. Purges paginate through R2 and delete batches of **at most 1,000
  keys**, deleting metadata last so failed cleanup can be retried.
* There are **no multiwriter/transaction guarantees**. The owner must serialize
  writes versus board purges, including scheduled expiry cleanup; do not
  upload to a board concurrently with its deletion.

## Headers, caches, and active content

Every worker response sets:

```text
X-Content-Type-Options: nosniff
X-Robots-Tag: noindex, nofollow
Referrer-Policy: no-referrer
```

Successful public file responses use `Cache-Control: public, max-age=3600`.
Private files use `Cache-Control: private, no-store`; all other responses,
including API, instructions, robots.txt, and errors, also use
`private, no-store`. Overwrites/deletions cannot revoke existing public caches:
use a new filename for immediately distinguishable screenshot versions.
The public robots.txt disallows all crawlers, but robots directives and random
URLs are not authentication.

HTML, JavaScript, and SVG are intentionally served as **active content**;
there is no sandbox/CSP isolation between boards on the same host. Treat
uploaded pages as untrusted, including private pages: private artifacts share
the private origin and its authenticated browser context. View untrusted
artifacts in an isolated browser/profile with no secrets; never enter or store
`TACK_TOKEN` in a hosted page or browser storage. The upload token grants
management access to **all** boards. Only trusted agents should receive it.
Do not host a privileged application on either artifact origin.

## Decisions

* [Expiry and labels](#api-and-file-rules): TTLs are fixed day counts, not
  calendar months/years; labels count Unicode code points, not bytes.
* [Literal paths](#api-and-file-rules): use the strict ASCII allowlist, without
  decoding encoded paths.
* [URL origins](#url-configuration-and-later-custom-domains): public URLs default
  to the request origin; private URLs require explicit `PRIVATE_BASE` in public
  environment vars.
* [Upload buffering](#api-and-file-rules): file bodies are buffered, with a
  25 MiB input limit enforced during reading; this is not streaming to R2.
* [Single-owner mutations](#api-and-file-rules): serialize writes and purges;
  distributed multiwriter coordination is not implemented.
* [Active content](#headers-caches-and-active-content): per-board sandbox/origin
  isolation is not built; use a separate browser/profile with no secrets.

## Development and automation

From the repository root:

```bash
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test
bun run deploy:public
bun run deploy:private
```

Use `bunx wrangler` for direct CLI commands. The dev/deploy package scripts use
plain `wrangler`, invoked with `bun run`, honoring the official CLI's runtime
shebang. Do **not** force `--bun` on Wrangler: current Wrangler fails with
`this.#runtimeDispatcher?.close is not a function` under the forced Bun runtime.
The test script, by contrast, explicitly uses `bun --bun vitest run`.

Tests use Vitest 5 with `@cloudflare/vitest-plugin`, the supported replacement
for the deprecated `@cloudflare/vitest-pool-workers`. The Cloudflare Vitest
plugin runs tests in the Workers pool; keep the plugin and Vitest versions
compatible when updating dependencies.

The **CI** workflow runs lint, typecheck, and tests for pull requests and pushes
to `main`, using Bun commands only. The deployment workflow runs only after a
successful CI **push** run on `main`, checks out that run's **exact head SHA**,
installs the frozen lockfile, then deploys private and public in one serialized
production job. PR CI never triggers deployment. Checkout credentials are not
persisted; workflow permissions are read-only.

Before enabling automated deployment, complete the manual setup above and add
GitHub repository secrets `CLOUDFLARE_API_TOKEN` (least-privilege Workers deploy
and R2 access for this account) and `CLOUDFLARE_ACCOUNT_ID`. `TACK_TOKEN` stays a
Cloudflare worker secret; CI does not need it. Keep the configured base URLs
and Access vars in the Wrangler environments. Neither workflow creates the R2
bucket, configures Access policies, or provisions the upload secret.
