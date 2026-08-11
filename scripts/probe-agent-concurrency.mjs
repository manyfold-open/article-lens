#!/usr/bin/env node
// Measure whether one Manyfold agent serves concurrent A2A tasks in parallel or
// serialises them.
//
// MAX_CONCURRENT_PER_AGENT in src/crew/mf.ts is a guess. It matters because the
// connect model lets all five roles resolve to the same agent, which the
// peer-mint model made impossible: stage 1 can then open four concurrent
// streams against one agent. If the agent parallelises, the cap should rise to
// 4; if it serialises, holding it at 1 stops us paying for queueing we cannot
// use.
//
// THIS BILLS REAL TURNS — one per concurrent slot per round, seven in total.
// Run it by hand against staging. It is deliberately not wired into CI.
//
//   node scripts/probe-agent-concurrency.mjs <rpcUrl> <bearer>
//
// Reading the result: with N concurrent calls each taking t seconds alone,
// wall-clock ~t means the agent parallelises, wall-clock ~N*t means it
// serialises. Anything in between is a partial limit; take the largest N whose
// wall clock is still close to t.

const [, , rpcUrl, token] = process.argv;

if (!rpcUrl || !token) {
  console.error('usage: node scripts/probe-agent-concurrency.mjs <rpcUrl> <bearer>');
  process.exit(2);
}

const PROMPT = 'Reply with exactly the word: ok';

async function oneTurn(index) {
  const started = Date.now();
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      authorization: `Bearer ${token}`,
    },
    redirect: 'manual',
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'message/stream',
      id: crypto.randomUUID(),
      params: {
        message: {
          kind: 'message',
          role: 'user',
          messageId: `probe-${Date.now()}-${index}`,
          parts: [{ kind: 'text', text: PROMPT }],
        },
        configuration: { acceptedOutputModes: ['text/plain'] },
      },
    }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  // Drain the stream; only the wall clock matters here.
  const reader = response.body.getReader();
  let firstEventAt = 0;
  while (true) {
    const { done } = await reader.read();
    if (!firstEventAt) firstEventAt = Date.now() - started;
    if (done) break;
  }
  return { total: Date.now() - started, firstEventAt };
}

const rounds = [1, 2, 4];
const results = [];

for (const n of rounds) {
  const started = Date.now();
  const settled = await Promise.allSettled(
    Array.from({ length: n }, (_, index) => oneTurn(index)),
  );
  const wall = Date.now() - started;
  const ok = settled.filter(entry => entry.status === 'fulfilled');
  const slowest = Math.max(0, ...ok.map(entry => entry.value.total));
  results.push({ n, wall, slowest, failures: settled.length - ok.length });
  console.log(
    `concurrency ${n}: wall ${(wall / 1000).toFixed(1)}s · slowest single ${(slowest / 1000).toFixed(1)}s`
    + `${settled.length - ok.length ? ` · ${settled.length - ok.length} failed` : ''}`,
  );
}

const base = results[0]?.wall ?? 0;
console.log('\nInterpretation:');
for (const { n, wall } of results.slice(1)) {
  const ratio = base ? wall / base : 0;
  console.log(
    `  ${n} concurrent took ${ratio.toFixed(1)}x a single call — `
    + (ratio < 1.4 ? 'parallel' : ratio > n * 0.75 ? 'serialised' : 'partially limited'),
  );
}
console.log('\nSet MAX_CONCURRENT_PER_AGENT in src/crew/mf.ts to the largest');
console.log('concurrency that still reads as parallel, and record the date here.');
