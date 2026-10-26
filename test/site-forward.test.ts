import test from 'node:test';import assert from 'node:assert/strict';import {registerHooks}from'node:module';
registerHooks({resolve(s,c,next){try{return next(s,c);}catch(e){if(s.startsWith('.')&&!/\.[a-z]+$/i.test(s))return next(s+'.ts',c);throw e;}}});
const {forwardSiteMcp}=await import('../src/site-forward.ts');
test('Site forwarding preserves JSON-RPC and strips visitor and platform credentials',async(t)=>{
 let forwarded:RequestInit|undefined;
 t.mock.method(globalThis,'fetch',async(target,init)=>{assert.equal(String(target),'https://example.workers.dev/mcp/private-path');forwarded=init;return Response.json({jsonrpc:'2.0',id:1,result:{ok:true}});});
 const body=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'});
 const r=await forwardSiteMcp(new Request('https://private.chatgpt.site/mcp',{method:'POST',headers:{'Content-Type':'application/json',Cookie:'private-cookie',Authorization:'Bearer private','OAI-Sites-Authorization':'Bearer platform','oai-authenticated-user-email':'owner@example.test'},body}),'https://example.workers.dev/mcp/private-path');
 assert.equal(r.status,200);assert.equal(forwarded?.body,body);const h=new Headers(forwarded?.headers);assert.equal(h.has('Cookie'),false);assert.equal(h.has('Authorization'),false);assert.equal(h.has('OAI-Sites-Authorization'),false);assert.equal(h.has('oai-authenticated-user-email'),false);assert.equal(r.headers.get('Cache-Control'),'no-store');
 assert.equal(forwarded?.redirect,'manual');
});

test('Site proxy refuses backend redirects without forwarding the capability elsewhere',async(t)=>{
 t.mock.method(globalThis,'fetch',async()=>new Response(null,{status:302,headers:{Location:'https://other.example/'}}));
 const r=await forwardSiteMcp(new Request('https://private.chatgpt.site/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),'https://example.workers.dev/mcp/private-path');
 assert.equal(r.status,502);assert.equal(r.headers.has('Location'),false);
});
