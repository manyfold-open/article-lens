import type { SSEEvent } from './schema'

export interface SSEStream {
  stream: ReadableStream
  emit: (event: SSEEvent) => void
  close: () => void
}

export function createSSEStream(): SSEStream {
  let controller: ReadableStreamDefaultController<Uint8Array>
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    start(c) { controller = c },
  })

  function emit(event: SSEEvent) {
    try {
      const line = 'data: ' + JSON.stringify(event) + '\n\n'
      controller.enqueue(encoder.encode(line))
    } catch { /* stream already closed */ }
  }

  function close() {
    try { controller.close() } catch {}
  }

  return { stream, emit, close }
}

export function sseResponse(stream: ReadableStream): Response {
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  })
}
