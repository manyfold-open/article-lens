#!/usr/bin/env bash
# Article Lens production smoke test.
# Usage: ARTICLE_ACCESS_PASSCODE=123456 npm run smoke -- [baseUrl]
set -uo pipefail
BASE="${1:-https://mf-article-lens.netmind-ai.workers.dev}"
ACCESS_PASSCODE="${ARTICLE_ACCESS_PASSCODE:-}"
fails=0
pass(){ echo "  ✓ $1"; }
fail(){ echo "  ✗ $1"; fails=$((fails+1)); }

echo "smoke: $BASE"

gate=$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' "$BASE/")
echo "$gate" | grep -qE '^302 .*/access\?next=' && pass "access: gate enabled" || fail "access: expected redirect ($gate)"

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

# 1. analyze (pasted technical text, >220 chars so the captain runs 小词) —
#    expect plan + result, ≥1 jargon term, no fatal error
TXT="Modern LLM agents run an event-driven loop: the model calls tools, observes results, and iterates until done. Retrieval-augmented generation (RAG) fetches context from a vector database using HNSW approximate nearest-neighbour search, and int8 quantization shrinks the KV cache. Reward models and RLHF fine-tune behaviour, while an LLM-as-a-judge grades outputs against a rubric before deployment."
out=$(curl -s -N --max-time 170 -b "$cookie_jar" "$BASE/api/analyze" --data-urlencode "text=$TXT" -G)
echo "$out" | grep -q '"event":"plan"'   && pass "analyze: plan"   || fail "analyze: no plan"
echo "$out" | grep -q '"event":"result"' && pass "analyze: result" || fail "analyze: no result"
terms=$(echo "$out" | grep -oE '"term":"[^"]+"' | sort -u | wc -l | tr -d ' ')
[ "${terms:-0}" -ge 1 ] && pass "analyze: jargon terms ($terms)" || fail "analyze: 0 jargon terms"
echo "$out" | grep -q '"event":"error","message"' && fail "analyze: fatal error event" || pass "analyze: no fatal error"

# 2. translate (zh -> en)
tr=$(curl -s --max-time 60 -b "$cookie_jar" -X POST "$BASE/api/translate" -H 'Content-Type: application/json' -d '{"zh":["向量数据库"]}')
echo "$tr" | grep -q '"en":\["' && pass "translate: returns en" || fail "translate: bad ($tr)"

# 3. define (Ask 小词)
df=$(curl -s --max-time 60 -b "$cookie_jar" -X POST "$BASE/api/define" -H 'Content-Type: application/json' -d '{"term":"HNSW"}')
echo "$df" | grep -q '"explain"' && pass "define: returns explain" || fail "define: bad ($df)"

# 4. health snapshot
hb=$(curl -s --max-time 90 -b "$cookie_jar" "$BASE/api/health")
up=$(echo "$hb" | grep -oE '"up":[0-9]+' | grep -oE '[0-9]+' | head -1)
total=$(echo "$hb" | grep -oE '"total":[0-9]+' | grep -oE '[0-9]+' | head -1)
echo "  health: up=${up:-?}/${total:-?}"
[ -n "${up:-}" ] && pass "health: endpoint ok" || fail "health: bad ($hb)"

echo
if [ "$fails" -eq 0 ]; then echo "SMOKE PASS"; else echo "SMOKE FAIL ($fails)"; fi
exit "$fails"
