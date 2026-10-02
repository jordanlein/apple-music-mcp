import test from 'node:test';
import assert from 'node:assert/strict';
import {forwardSitesCollection, withSitesScheduled} from '../src/sites-trigger.ts';

const url='https://example.owner.chatgpt.site/internal/collect';
test('Sites forwarding confirms a real collector result and sends both service headers', async()=>{
  let request: RequestInit | undefined;
  const result=await forwardSitesCollection(url,'test-service-token',async(input,init)=>{
    assert.equal(input,url); request=init;
    return Response.json({runId:'test-run',fetched:30,inserted:0});
  });
  assert.equal(result.runId,'test-run');
  assert.equal(request?.method,'POST');
  assert.equal(request?.body,'{}');
  assert.deepEqual(request?.headers,{'Content-Type':'application/json','OAI-Sites-Authorization':'Bearer test-service-token',Authorization:'Bearer test-service-token'});
});

test('Sites forwarding rejects unsafe destinations, failed calls and missing confirmation', async()=>{
  await assert.rejects(forwardSitesCollection('https://example.com/internal/collect','test-token'),/not configured/);
  await assert.rejects(forwardSitesCollection(url,'test-token',async()=>new Response('paused',{status:409})),/HTTP 409/);
  await assert.rejects(forwardSitesCollection(url,'test-token',async()=>Response.json({fetched:30})),/did not confirm/);
});

test('timer reuse preserves legacy fetch arguments and prevents the old scheduled collector from running', async()=>{
  const calls: unknown[][]=[];
  let oldScheduledCalls=0;
  const legacy={fetch:(...args:unknown[])=>{calls.push(args);return new Response('legacy MCP');},scheduled:()=>{oldScheduledCalls++;}};
  const bridge=withSitesScheduled(legacy as never);
  const request=new Request('https://legacy.example/mcp');
  const env={SITE_COLLECTOR_URL:url,SITE_SERVICE_TOKEN:'test-token'};
  const pending: Promise<unknown>[]=[];
  const ctx={waitUntil:(promise:Promise<unknown>)=>pending.push(promise)};
  assert.equal(await (await bridge.fetch!(request,env as never,ctx as never)).text(),'legacy MCP');
  assert.deepEqual(calls,[[request,env,ctx]]);
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>Response.json({runId:'scheduled-test',fetched:30,inserted:0});
  try { await bridge.scheduled!({} as never,env as never,ctx as never); await Promise.all(pending); }
  finally { globalThis.fetch=originalFetch; }
  assert.equal(oldScheduledCalls,0);
  assert.equal(pending.length,1);
});
