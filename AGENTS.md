# Tack agent guidance

For PR screenshots and shareable HTML artifacts, run `curl -s https://tack.alecflett.workers.dev/` and follow it. The token is in `$TACK_TOKEN`.

Use curl, not fetch. Never print, commit, or put the token in a URL; never
enable shell tracing or follow redirects with the Authorization header.
For Claude Code cloud sessions, allow both `tack.alecflett.workers.dev` and
`tack-private.alecflett.workers.dev`, and store `TACK_TOKEN` as an environment
secret. Private viewers use Access OTP, not the upload token.

## Commands

Run from the repository root:

```bash
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test
```

Deployment is an explicit operator action, requiring Cloudflare credentials:
`bun run deploy:private` and `bun run deploy:public`. Never deploy merely to
validate a change. Use Bun, not npm, npx, or node commands.
Use `bunx wrangler` for direct Wrangler commands; dev/deploy scripts invoke
plain `wrangler` via `bun run` and honor its official runtime shebang. Never
force `--bun` on Wrangler. The test script uses `bun --bun vitest run`.

## Files and invariants

* `src/worker.ts`: routing, bearer API,
  Access JWT verification, R2 storage, and expiry cleanup.
* `src/instructions.md`: curl-readable
  instructions served at the public root.
* `wrangler.jsonc`: `public` / `tack`
  and `private` / `tack-private` share the non-public `tack` R2 bucket.
* `README.md`: deployment/Access setup,
  API contract, and security decisions.
* `package.json`: existing commands and
  dependency constraints; tests use Vitest 5 with `@cloudflare/vitest-plugin`
  and its Workers pool. Keep their versions compatible.

Do not weaken fail-closed MODE, token, or Access checks. Keep previews disabled,
protect the entire private production hostname, and never add an Access Bypass
policy or expose R2 directly. `PRIVATE_BASE` is required in public vars;
`PUBLIC_BASE` is optional and otherwise uses the request origin. The private
vars require a bare `<team>.cloudflareaccess.com` and explicit application AUD;
enabling Access does not supply an AUD binding.

Preserve 25 MiB streaming limits, Unicode label length, case-insensitive
extension checks, request-time expiry, no-store errors/private responses, and
paginated purge batches of at most 1,000 keys with metadata deleted last.
Owner operations must serialize writes versus purges; there are no multiwriter
guarantees. Public overwrites may be cached for an hour.

Public URLs are unlisted, not secret. HTML/JS/SVG are active same-origin
untrusted content: use an isolated browser with no secrets. Never commit
screenshots; use one public board per PR and private boards for other artifacts.
Keep changes surgical, update related docs, and validate with the existing
targeted commands unless the task explicitly prohibits running them.
