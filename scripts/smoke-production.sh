#!/usr/bin/env bash
# Article Lens production smoke test.
# Usage: ARTICLE_ACCESS_PASSCODE=123456 npm run smoke -- [baseUrl]
set -uo pipefail
BASE="${1:-https://mf-article-lens.netmind-ai.workers.dev}"
ACCESS_PASSCODE="${ARTICLE_ACCESS_PASSCODE:-}"
# Whether the deployment is expected to enforce the visitor access gate.
# The gate is currently bypassed on purpose (see "Temporarily disable the
# access-code gate"), and this script used to assert unconditionally that it
# redirected, so every deploy since then has been red on a check that was
# simply out of date. Stating the expectation here keeps the assertion strict
# in both directions: flip this to 1 in the same commit that restores the gate.
ACCESS_GATE_ENFORCED="${ACCESS_GATE_ENFORCED:-0}"
fails=0
pass(){ echo "  ✓ $1"; }
fail(){ echo "  ✗ $1"; fails=$((fails+1)); }

echo "smoke: $BASE"

gate=$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' "$BASE/")
if [ "$ACCESS_GATE_ENFORCED" = "1" ]; then
  echo "$gate" | grep -qE '^302 .*/access\?next=' \
    && pass "access: gate enforced" \
    || fail "access: expected a redirect to /access ($gate)"
else
  echo "$gate" | grep -qE '^200 ' \
    && pass "access: gate bypassed as configured" \
    || fail "access: expected 200 while the gate is bypassed ($gate)"
fi

access_status=$(curl -sS --max-time 30 "$BASE/api/access/status")
if echo "$access_status" | grep -q '"configured":true' \
  && echo "$access_status" | grep -q '"ready":true'; then
  pass "access: production configuration ready"
else
  fail "access: passcode or signing secret is not configured ($access_status)"
fi

if ! [[ "$ACCESS_PASSCODE" =~ ^[0-9]{6}$ ]]; then
  page=$(curl -sS --max-time 30 "$BASE/access")
  echo "$page" | grep -q 'Enter access code' && pass "access: login page" || fail "access: login page missing"
  echo "  protected endpoint checks skipped: set ARTICLE_ACCESS_PASSCODE"
  exit "$fails"
fi

cookie_jar=$(mktemp)
trap 'rm -f "$cookie_jar"' EXIT
login=$(printf '{"passcode":"%s"}' "$ACCESS_PASSCODE" \
  | curl -sS --max-time 30 -c "$cookie_jar" -H 'Content-Type: application/json' --data-binary @- "$BASE/api/access/login")
echo "$login" | grep -q '"authenticated":true' && pass "access: passcode login" || fail "access: login failed"

# 1. analyze (pasted technical text, >220 chars so the captain runs Jargon) —
#    expect plan + result, ≥1 jargon term, no fatal error
TXT="Modern LLM agents run an event-driven loop: the model calls tools, observes results, and iterates until done. Retrieval-augmented generation (RAG) fetches context from a vector database using HNSW approximate nearest-neighbour search, and int8 quantization shrinks the KV cache. Reward models and RLHF fine-tune behaviour, while an LLM-as-a-judge grades outputs against a rubric before deployment."
out=$(curl -s -N --max-time 170 -b "$cookie_jar" "$BASE/api/analyze" --data-urlencode "text=$TXT" -G)
echo "$out" | grep -q '"event":"plan"'   && pass "analyze: plan"   || fail "analyze: no plan"
echo "$out" | grep -q '"event":"result"' && pass "analyze: result" || fail "analyze: no result"
terms=$(echo "$out" | grep -oE '"term":"[^"]+"' | sort -u | wc -l | tr -d ' ')
[ "${terms:-0}" -ge 1 ] && pass "analyze: jargon terms ($terms)" || fail "analyze: 0 jargon terms"
echo "$out" | grep -q '"event":"error","message"' && fail "analyze: fatal error event" || pass "analyze: no fatal error"

# 2. define (Ask Jargon)
df=$(curl -s --max-time 60 -b "$cookie_jar" -X POST "$BASE/api/define" -H 'Content-Type: application/json' -d '{"term":"HNSW"}')
echo "$df" | grep -q '"explain"' && pass "define: returns explain" || fail "define: bad ($df)"

# 3. health snapshot
# ?live=1 is load-bearing. /api/health serves a cached snapshot, so a deploy
# that dropped every agent still reported the previous run's healthy counts and
# this gate passed against state that no longer existed.
hb=$(curl -s --max-time 120 -b "$cookie_jar" "$BASE/api/health?live=1")
up=$(echo "$hb" | grep -oE '"up":[0-9]+' | grep -oE '[0-9]+' | head -1)
total=$(echo "$hb" | grep -oE '"total":[0-9]+' | grep -oE '[0-9]+' | head -1)
echo "  health: up=${up:-?}/${total:-?}"
[ -n "${up:-}" ] && pass "health: endpoint ok" || fail "health: bad ($hb)"
# total=0 means no agents are connected, so the app is serving local mock
# results. The analyze and define checks above pass against mock output, so
# without this gate a deploy with no connected agents looks entirely healthy.
if [ "${total:-0}" -eq 0 ]; then
  fail "health: no agents connected — the app is in mock mode, connect one on /settings"
else
  [ "${up:-0}" -eq "${total:-0}" ] && pass "health: all connected agents reachable" \
    || fail "health: only ${up:-0}/${total} agents reachable"
fi

echo
if [ "$fails" -eq 0 ]; then echo "SMOKE PASS"; else echo "SMOKE FAIL ($fails)"; fi
exit "$fails"
