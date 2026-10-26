import { HttpRequestError, readBoundedText } from './http-security';

// Invoked only after Sites verifies the owner. Forward protocol headers, never
// visitor identity, browser cookies, or the Sites service credential.
export async function forwardSiteMcp(request: Request, target: string): Promise<Response> {
  const url = new URL(target);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.workers.dev')) return new Response('Invalid backend configuration', {status:503});
  let body: string;
  try { body = await readBoundedText(request, 1_048_576, 'application/json'); }
  catch (error) { if (error instanceof HttpRequestError) return new Response(error.message, {status:error.status}); throw error; }
  const headers = new Headers({'Content-Type':'application/json',Accept:'application/json, text/event-stream'});
  const version = request.headers.get('MCP-Protocol-Version');
  if (version) headers.set('MCP-Protocol-Version', version);
  try {
    const response = await fetch(url.toString(), {method:'POST',headers,body,signal:AbortSignal.timeout(120_000),redirect:'manual'});
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return new Response('Unexpected backend redirect', {status:502});
    }
    const returned = new Headers(response.headers);
    returned.set('Cache-Control','no-store');returned.set('Referrer-Policy','no-referrer');
    return new Response(response.body,{status:response.status,headers:returned});
  } catch (error) {
    // Keep the capability and any nested URLs out of diagnostic messages.
    const message = (error instanceof Error ? error.message : 'Unknown fetch error')
      .replaceAll(target, '[backend]').replace(/https?:\/\/\S+/g, '[url]').slice(0, 300);
    console.error(JSON.stringify({event:'site_backend_unavailable',message}));
    return new Response('The Apple Music backend is temporarily unavailable. Do not repeat a playlist write until its outcome is checked.', {status:502});
  }
}
