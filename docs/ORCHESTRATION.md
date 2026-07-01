# Article Lens — Agent Orchestration (design)

The office is a **tunable multi-agent workflow**. The user arranges the crew to trade
**quality ⇄ token cost**, picking the right shape for the task. Recipes are just
**presets** of one tunable spec; free-tuning edits the same spec; a **token meter**
makes the cost visible and moves as you tune.

## Goals
1. Different orchestrations → different effects **and** different token cost (save tokens).
2. Right method for the right task (task-shaped presets).
3. User freely tunes the workflow to maximise performance × efficiency (visible token meter).

## The crew & the real dependency graph
```
              ┌─ 小摘 sum ─┐
  raw input ─→┼─ 小詞 jargon┼─→ 小導 ctx(verdict) ─→ 合成 synth(QA) ─→ report
              └─ 小潛 comments┘
             ‖ parallel: read raw input, no dep     → sequential: downstream needs upstream
```
- `sum/jargon/comments` read raw input independently → **parallel is correct** (relay between
  them adds ~nothing; that was the dead end).
- `ctx` needs sum+comments; `synth` needs all → **sequential is correct** here.

## Orchestration primitives
```
‖  parallel   independent readers on raw input
→  sequential downstream consumes upstream output (only where a real dep exists)
⇉  vote×N     run same agent N times, merge/best (reliability / coverage)   [v2]
◎  toggle     include/skip an agent (biggest token saver)
🔆 effort      low/med/high per agent (≈ linear token trade)
─→ edge       add a *meaningful* dependency (e.g. jargon→ctx)               [v1.5]
⊕  merge      fan-in / debate resolver                                      [v2]
```

## Tunable spec (graphConfig v2)
```jsonc
{
  "v": 2,
  "nodes": {
    "sum":      { "enabled": true, "effort": "med" },
    "jargon":   { "enabled": true, "effort": "med", "replicas": 1 },   // replicas v2
    "comments": { "enabled": true, "effort": "med" },
    "ctx":      { "enabled": true },
    "synth":    { "enabled": true }
  },
  "edges":  [ ["jargon","ctx"] ],   // optional extra deps      [v1.5]
  "groups": [ ... mode parallel|relay ... ]   // legacy, kept working
}
```
Invariant: **absent / default spec ⇒ today's behaviour, byte-for-byte.**

## Effort → concrete knobs (real token impact)
| agent | low | med (= today) | high |
|---|---|---|---|
| sum | short TL;DR, ≤3 points | current | +more key points |
| jargon | 1 window, ≤6 terms | 2 windows (current) | 3 windows, ≤16 terms |
| comments | small comment budget | current | larger budget, more camps |
| ctx / synth | — | current | — |

## Rough token cost model (for the FE estimate meter; BE reports actual)
| agent | low | med | high |
|---|--:|--:|--:|
| sum | 2k | 4k | 6k |
| jargon | 5k | 10k | 16k |
| comments | 4k | 8k | 12k |
| ctx | 2k | 2k | 3k |
| synth | 4k | 4k | 5k |

## Recipes = presets
| preset | spec | ~tokens | you get |
|---|---|--:|---|
| ⚡ 快速掃描 | sum(low)+ctx; jargon/comments off | ~6–8k | verdict + short summary |
| 📄 標準 | all med, parallel (= default/no-graph) | ~20–35k | full report |
| 🎯 術語特訓 | jargon(high)[+vote v2]+ctx; sum(low); comments off | ~30–45k | deep reliable glossary |
| 🔬 深度精讀 | all high [+ jargon→ctx edge v1.5] | ~25–40k | most-considered verdict + thesis-aligned jargon |
| 🛡️ 可靠 [v2] | every reader ×2 vote | ~40–60k | nothing missed |
| 💸 省錢漸進 [v2] | sum+ctx first; escalate only if "worth reading" | ~7k→~25k | spend only when warranted |
| 🎭 辯論裁定 [v2] | 2× ctx (pro/con) → merge | +~4k | balanced verdict |
| 🗣️ 受眾切換 [v2] | synth tone: beginner/expert | same | same info, different framing |

## Token meter
- BE: capture each agent call's input+output tokens (prefer real usage from the A2A
  result; else estimate ≈ chars/2.5). Accumulate; emit SSE `{event:"usage", agent, tokens}`
  per agent and `result.usage = { total, byAgent }`.
- FE: show a live **estimate** (from the cost model above) as the user tunes, and swap in the
  **actual** total after the run. A small number + bar in the office corner.

## Build phases
- **v1 (now):** graphConfig v2 (nodes: enabled+effort) · effort→params in orchestrator ·
  token measurement + `usage` SSE + meter · 4 presets (⚡📄🎯🔬) · effort knob in edit mode.
- **v1.5:** meaningful `edges` (jargon→ctx) · layered office (tiers + wires).
- **v2:** vote×N (fixes jargon-returns-0) · debate merge · conditional escalate (💸) · audience tone.
