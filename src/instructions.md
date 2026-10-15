# Tack: screenshots and HTML artifacts

Tack is a tiny personal file host. Read these instructions with **curl**, not a
web-fetch tool that may summarize away commands. The upload token is in
`$TACK_TOKEN`: never print it, commit it, put it in a URL, or enable shell tracing.
Commands below use curl, jq, and Bash. Stop if any command fails.

```bash
set -euo pipefail
TACK_BASE='{{BASE}}'
TACK_AUTH="$(printf '%s %s' Bearer "$TACK_TOKEN")"
```

## PR screenshots

Create **one public board per PR**, labeled `<repo> PR #<n>` (for example,
`owner/repo PR #412`). Screenshots must not show real personal data.
Never commit images or push image branches. On later pushes, reuse the board:

```bash
LABEL='owner/repo PR #412' # replace with this PR's repo and number
BOARDS=$(curl --fail-with-body -sS "$TACK_BASE/api/boards" \
  -H "Authorization: $TACK_AUTH")
BOARD=$(printf '%s' "$BOARDS" | jq -c --arg label "$LABEL" \
  '[.[] | select(.label == $label and .visibility == "public") |
    select(.expiresAt == null or .expiresAt > (now | todate))][0] // empty')
if [ -z "$BOARD" ]; then
  BOARD=$(curl --fail-with-body -sS "$TACK_BASE/api/boards" \
    -H "Authorization: $TACK_AUTH" -H 'Content-Type: application/json' \
    --data "$(jq -n --arg label "$LABEL" '{visibility:"public",label:$label}')")
fi
ID=$(printf '%s' "$BOARD" | jq -er '.id')
BOARD_URL=$(printf '%s' "$BOARD" | jq -er '.url')
IMAGE_URL=$(curl --fail-with-body -sS -X PUT \
  "$TACK_BASE/api/boards/$ID/screenshot.png" \
  -H "Authorization: $TACK_AUTH" --data-binary @./screenshot.png | jq -er '.url')
printf '![Screenshot](%s)\n' "$IMAGE_URL"
```

Embed that Markdown in the PR description, with useful alt text. Use distinct
filenames for distinct screenshots. Uploading the same path overwrites it;
public responses may be cached for an hour.

## Artifacts: private by default

For mockups, diagrams, or multi-file HTML, create a private board. Put `index.html`
at its root and use relative links for CSS, JavaScript, images, and fonts.
Private viewing requires Cloudflare Access; ask the owner to add a viewer's
email to its policy if necessary. Do not change visibility to bypass Access.

```bash
BOARD=$(curl --fail-with-body -sS "$TACK_BASE/api/boards" \
  -H "Authorization: $TACK_AUTH" -H 'Content-Type: application/json' \
  --data '{"visibility":"private","label":"Interactive mockup","expires":"1y"}')
ID=$(printf '%s' "$BOARD" | jq -er '.id')
BOARD_URL=$(printf '%s' "$BOARD" | jq -er '.url')
DIR='./artifact' # directory containing index.html
while IFS= read -r -d '' FILE; do
  REL=${FILE#"$DIR"/}
  curl --fail-with-body -sS -X PUT "$TACK_BASE/api/boards/$ID/$REL" \
    -H "Authorization: $TACK_AUTH" --data-binary @"$FILE"
done < <(find "$DIR" -type f -print0)
printf '%s\n' "$BOARD_URL"
```

Give the user `BOARD_URL` (the trailing slash serves `index.html`).
Paths must contain only `A-Z a-z 0-9 . _ / -`, at most 200 characters,
with no `..`, empty segments, or dot-prefixed segments. Exclude hidden files,
dependencies, credentials, and source data from the upload directory.
Allowed extensions (case-insensitive): png jpg jpeg gif webp avif svg html css js
mjs json txt md pdf mp4 webm woff2 map. Maximum size: 25 MiB per file.
Expiry choices: `30d`, `6m`, `1y` (default), `never`.

## List and delete

```bash
# Includes id, visibility, label, timestamps, url, fileCount, totalBytes.
curl --fail-with-body -sS "$TACK_BASE/api/boards" \
  -H "Authorization: $TACK_AUTH" | jq .

# Delete one file from the board selected above.
curl --fail-with-body -sS -X DELETE "$TACK_BASE/api/boards/$ID/screenshot.png" \
  -H "Authorization: $TACK_AUTH"

# Purge the selected board and all its files (irreversible).
curl --fail-with-body -sS -X DELETE "$TACK_BASE/api/boards/$ID" \
  -H "Authorization: $TACK_AUTH"
```

If the network blocks a request, tell the user the exact hostname to allow:
the API host from `TACK_BASE`, or the private host from the returned board URL.
Never include the token in diagnostics. Do not follow redirects with the token.
