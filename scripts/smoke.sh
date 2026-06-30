#!/usr/bin/env bash
# HN Lens smoke test — hits the live (or $1) endpoints and asserts basic health.
# Usage: bash scripts/smoke.sh [baseUrl]
set -uo pipefail
BASE="${1:-https://hn-lens.zack-chen.workers.dev}"
fails=0
pass(){ echo "  ✓ $1"; }
fail(){ echo "  ✗ $1"; fails=$((fails+1)); }

echo "smoke: $BASE"

# 1. analyze (pasted technical text, >220 chars so the captain runs 小詞) —
#    expect plan + result, ≥1 jargon term, no fatal error
TXT="Modern LLM agents run an event-driven loop: the model calls tools, observes results, and iterates until done. Retrieval-augmented generation (RAG) fetches context from a vector database using HNSW approximate nearest-neighbour search, and int8 quantization shrinks the KV cache. Reward models and RLHF fine-tune behaviour, while an LLM-as-a-judge grades outputs against a rubric before deployment."
out=$(curl -s -N --max-time 170 "$BASE/api/analyze" --data-urlencode "text=$TXT" -G)
echo "$out" | grep -q '"event":"plan"'   && pass "analyze: plan"   || fail "analyze: no plan"
echo "$out" | grep -q '"event":"result"' && pass "analyze: result" || fail "analyze: no result"
terms=$(echo "$out" | grep -oE '"term":"[^"]+"' | sort -u | wc -l | tr -d ' ')
[ "${terms:-0}" -ge 1 ] && pass "analyze: jargon terms ($terms)" || fail "analyze: 0 jargon terms"
echo "$out" | grep -q '"event":"error","message"' && fail "analyze: fatal error event" || pass "analyze: no fatal error"

# 2. translate (zh -> en)
tr=$(curl -s --max-time 60 -X POST "$BASE/api/translate" -H 'Content-Type: application/json' -d '{"zh":["向量資料庫"]}')
echo "$tr" | grep -q '"en":\["' && pass "translate: returns en" || fail "translate: bad ($tr)"

# 3. define (Ask 小詞)
df=$(curl -s --max-time 60 -X POST "$BASE/api/define" -H 'Content-Type: application/json' -d '{"term":"HNSW"}')
echo "$df" | grep -q '"explain"' && pass "define: returns explain" || fail "define: bad ($df)"

# 4. health snapshot
hb=$(curl -s --max-time 90 "$BASE/api/health")
up=$(echo "$hb" | grep -oE '"up":[0-9]+' | grep -oE '[0-9]+' | head -1)
total=$(echo "$hb" | grep -oE '"total":[0-9]+' | grep -oE '[0-9]+' | head -1)
echo "  health: up=${up:-?}/${total:-?}"
[ -n "${up:-}" ] && pass "health: endpoint ok" || fail "health: bad ($hb)"

echo
if [ "$fails" -eq 0 ]; then echo "SMOKE PASS"; else echo "SMOKE FAIL ($fails)"; fi
exit "$fails"
