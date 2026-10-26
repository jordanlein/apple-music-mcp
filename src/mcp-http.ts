import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createAppleMusicMcp } from './mcp';
import type { ToolContext } from './types';
import { HttpRequestError, readBoundedText } from './http-security';

let discoveryResult: string | undefined;

export async function handleMcp(request: Request, context: ToolContext): Promise<Response> {
  if (request.method === 'GET' || request.method === 'DELETE') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  if (Number(request.headers.get('Content-Length') ?? '0') > 1_048_576) return new Response('Request too large', { status: 413 });
  let body: string;
  try { body = await readBoundedText(request, 1_048_576, 'application/json'); }
  catch (error) { if (error instanceof HttpRequestError) return new Response(error.message, {status:error.status}); throw error; }
  let message: {method?: string; id?: string | number; params?: {name?: string}} | undefined;
  try { const parsed = JSON.parse(body); if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') message = parsed; } catch { /* SDK reports malformed JSON. */ }
  const headers = {'Content-Type':'application/json','Cache-Control':'no-store','Referrer-Policy':'no-referrer'};
  const accept = request.headers.get('Accept') ?? '';
  if (message?.method === 'tools/list' && message.id !== undefined && discoveryResult &&
      accept.includes('application/json') && accept.includes('text/event-stream') && !request.headers.has('MCP-Protocol-Version')) {
    return new Response(`{"jsonrpc":"2.0","id":${JSON.stringify(message.id)},"result":${discoveryResult}}`, {headers});
  }
  const onlyTool = message?.method === 'tools/call' && typeof message.params?.name === 'string' ? message.params.name : undefined;
  const server = createAppleMusicMcp(context, onlyTool);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 1_048_576 });
  try {
    await server.connect(transport);
    const forwarded = new Request(request.url,{method:request.method,headers:request.headers,body,signal:request.signal});
    const response = await transport.handleRequest(forwarded);
    if (message?.method === 'tools/list' && response.ok) {
      const result = await response.clone().json<{result?: {tools?: unknown[]}}>();
      if (result.result?.tools) discoveryResult = JSON.stringify(result.result);
    }
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Referrer-Policy', 'no-referrer');
    return response;
  } finally { await server.close(); }
}
