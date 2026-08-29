#!/usr/bin/env bash
#
# Push the variables in .env up to Vercel, so you are not pasting 20 secrets
# into a web form by hand.
#
#   bash scripts/vercel-env.sh production
#   bash scripts/vercel-env.sh preview
#
# Run `vercel link` first so the project is known. Existing values are replaced.
#
set -euo pipefail

TARGET="${1:-production}"

if [ ! -f .env ]; then
  echo "No .env found. Copy .env.example to .env and fill it in first." >&2
  exit 1
fi

# Local-development-only variables. These are not read at runtime, so they do
# not belong in a deployed environment.
#   SUPABASE_DB_URL          - only used by `npm run db:push` and the db tests
#   *_RAZORPAY_KEY_*         - seeds for local test merchants; real merchants
#                              enter their own keys through the onboarding UI
SKIP="SUPABASE_DB_URL MANDATE_RAZORPAY_KEY_ID MANDATE_RAZORPAY_KEY_SECRET SWASEEKH_RAZORPAY_KEY_ID SWASEEKH_RAZORPAY_KEY_SECRET"

pushed=0
skipped=0
blank=0

while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in \#*|"") continue;; esac
  key="${line%%=*}"
  value="${line#*=}"
  # strip CR and surrounding whitespace
  value="$(printf '%s' "$value" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"

  case " $SKIP " in
    *" $key "*) echo "  skip  $key (local only)"; skipped=$((skipped+1)); continue;;
  esac

  if [ -z "$value" ]; then
    echo "  blank $key (not set locally)"
    blank=$((blank+1))
    continue
  fi

  # Replace rather than duplicate: remove any existing value, then add.
  vercel env rm "$key" "$TARGET" --yes >/dev/null 2>&1 || true
  printf '%s' "$value" | vercel env add "$key" "$TARGET" >/dev/null 2>&1
  echo "  set   $key"
  pushed=$((pushed+1))
done < .env

echo ""
echo "$pushed set, $skipped skipped as local-only, $blank blank."
echo ""
echo "IMPORTANT: TALLY_PUBLIC_URL must match your real deployed domain."
echo "Until it does, Twilio signature checks fail with 403 and the merchant"
echo "webhook URLs shown on the dashboard will be wrong. After your first"
echo "deploy, set it and redeploy:"
echo ""
echo "  vercel env rm TALLY_PUBLIC_URL $TARGET --yes"
echo "  printf 'https://your-app.vercel.app' | vercel env add TALLY_PUBLIC_URL $TARGET"
echo "  vercel --prod"
