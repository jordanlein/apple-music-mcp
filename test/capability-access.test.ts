import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
registerHooks({resolve(specifier, context, next) { try { return next(specifier, context); } catch(error) { if(specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(specifier+'.ts', context); throw error; } }});
const { capabilityPath, hasCapabilityPath, hasCapabilityToken } = await import('../src/capability-access.ts');
const { AppleMusicApi } = await import('../src/apple.ts');

test('capability URLs require the complete high-entropy existing secret and are not a generic public MCP route', async () => {
  const secret = 'a'.repeat(64);
  const path = await capabilityPath(secret);
  assert.match(path, /^\/mcp\/[a-f0-9]{64}$/);
  assert.equal(path.includes(secret), false);
  assert.equal(await hasCapabilityPath(path, secret), true);
  assert.equal(await hasCapabilityPath(path, 'b'.repeat(64)), false);
  assert.equal(await hasCapabilityPath('/mcp', secret), false);
  assert.equal(await hasCapabilityPath(path+'/extra', secret), false);
  assert.equal(await hasCapabilityPath(path), false);
  assert.equal(await hasCapabilityPath(path, 'short'), false);
});

test('vault-based clients use the exact same capability in a bearer header', async () => {
  const secret = 'existing-key-'.repeat(5);
  const token = (await capabilityPath(secret)).slice('/mcp/'.length);
  assert.equal(await hasCapabilityToken(token, secret), true);
  assert.equal(await hasCapabilityToken(token, 'different-key-'.repeat(5)), false);
  assert.equal(await hasCapabilityToken(token.slice(1), secret), false);
  assert.equal(await hasCapabilityToken(token, 'short'), false);
  assert.equal(await hasCapabilityToken(token), false);
});

test('one hundred song preflight uses bounded private chunks and preserves positions and resolution failures', async () => {
  const calls: number[] = [];
  const env = { CATALOG_RESOLVER: { async resolve(tracks: any[]) {
    calls.push(tracks.length);
    return {resolved: tracks.slice(1).map((track,index)=>({id:track.name,type:'songs',match:'exact',inputIndex:index+1})),
      unresolved:[{inputIndex:0,input:tracks[0],reason:'unresolved',candidates:[]}],ambiguous:[]};
  } } } as any;
  const result = await new AppleMusicApi(env).resolveSongIds(Array.from({length:100},(_,i)=>({name:String(i)})));
  assert.equal(calls.length,10);
  assert.equal(Math.max(...calls),10);
  assert.equal(result.resolved.length,90);
  assert.deepEqual(result.unresolved.map(x=>x.inputIndex),[0,10,20,30,40,50,60,70,80,90]);
  assert.equal(result.resolved.at(-1)?.inputIndex,99);
});
