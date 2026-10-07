import { readWithDeadline } from './current-read.mjs';

// Transport facts only. Success and authoritative business refusal belong to
// the domain client, which knows the command and its versioned contract.
export function createMcpRequests({ fetchImpl = globalThis.fetch, headers = {}, typedContent = true, clock = globalThis } = {}) {
  let id = 0;
  return async (name, args = {}, { signal, timeoutMs } = {}) => {
    const request = async signal => {
      let response;
      try {
        response = await fetchImpl('/mcp', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json', ...headers },
          ...(signal ? { signal } : {}),
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
        });
      } catch (cause) { return { kind: 'unconfirmed', reason: 'network', cause }; }
      const status = response.status;
      if (status === 401 || status === 403) return { kind: 'authorization', status };
      if (!response.ok) {
        let body = '', payload;
        try {
          if (response.text) {
            body = await response.text();
            try { payload = JSON.parse(body); } catch { /* diagnostic text */ }
          } else payload = await response.json();
        } catch { /* a diagnostic cannot confirm the request */ }
        return { kind: 'unconfirmed', reason: 'http', status, body: body.slice(0, 500), payload };
      }
      let envelope;
      try { envelope = await response.json(); }
      catch (cause) { return { kind: 'unconfirmed', reason: 'envelope', status, cause }; }
      if (envelope?.error) return { kind: 'unconfirmed', reason: 'rpc', status, cause: envelope.error };
      const content = envelope?.result?.content;
      if (!Array.isArray(content) || (typedContent && !content.every(item => item !== null && typeof item === 'object' &&
        typeof item.type === 'string' && (item.type !== 'text' || typeof item.text === 'string')))) {
        return { kind: 'unconfirmed', reason: 'content', cause: envelope };
      }
      const text = typedContent ? content.find(item => item.type === 'text')?.text : content[0]?.text;
      if (text === undefined) return { kind: 'unconfirmed', reason: 'missing', cause: envelope };
      let payload;
      try { payload = JSON.parse(text); }
      catch (cause) { return { kind: 'unconfirmed', reason: 'payload', cause }; }
      return { kind: 'payload', payload, isError: Boolean(envelope.result.isError) };
    };
    try {
      return await (timeoutMs ? readWithDeadline(request, { signal, timeoutMs, clock }) : request(signal));
    } catch (cause) { return { kind: 'unconfirmed', reason: 'deadline', cause }; }
  };
}

export function unknownMcpOutcome(cause) {
  return Object.assign(new Error('The server did not confirm the result. Retry the same request key.'),
    { code: 'unknown_outcome', cause });
}
