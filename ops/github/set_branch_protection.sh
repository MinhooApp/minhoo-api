#!/usr/bin/env bash
set -euo pipefail

OWNER="${GITHUB_OWNER:-}"
REPO="${GITHUB_REPO:-}"
BRANCH="${GITHUB_BRANCH:-main}"
TOKEN="${GITHUB_TOKEN:-}"
CHECK_NAME="${REQUIRED_CHECK_NAME:-Realtime Stable Suite}"

if [[ -z "$OWNER" || -z "$REPO" || -z "$TOKEN" ]]; then
  echo "Usage:"
  echo "  GITHUB_OWNER=MinhooApp GITHUB_REPO=minhoo-api GITHUB_TOKEN=*** ./ops/github/set_branch_protection.sh"
  echo "Optional:"
  echo "  GITHUB_BRANCH=main REQUIRED_CHECK_NAME='Realtime Stable Suite'"
  exit 1
fi

payload="$(cat <<JSON
{
  "required_status_checks": {
    "strict": true,
    "checks": [
      { "context": "${CHECK_NAME}" }
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false
  },
  "restrictions": null,
  "required_linear_history": false,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_conversation_resolution": true,
  "lock_branch": false,
  "allow_fork_syncing": true
}
JSON
)"

curl -sS -X PUT \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/repos/${OWNER}/${REPO}/branches/${BRANCH}/protection" \
  -d "$payload" \
  | jq '{url, required_status_checks, enforce_admins, required_pull_request_reviews}'

echo "Branch protection updated for ${OWNER}/${REPO}:${BRANCH}"
