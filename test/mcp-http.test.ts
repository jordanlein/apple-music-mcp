import test from 'node:test';import assert from 'node:assert/strict';import {registerHooks} from 'node:module';
registerHooks({resolve(s,c,next){try{return next(s,c);}catch(e){if(s.startsWith('.')&&!/\.[a-z]+$/i.test(s))return next(s+'.ts',c);throw e;}}});
const {handleMcp}=await import('../src/mcp-http.ts');
const headers={'Content-Type':'application/json',Accept:'application/json, text/event-stream'};
function request(id:number,method:string,params={}){return new Request('https://example.test/mcp',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id,method,params})});}
const context={env:{DB:{prepare(){return{async first(){return null;},bind(){return this;},async run(){return{meta:{changes:1}};}}}}},clientId:'test'} as any;
test('stateless MCP discovery and selected-tool dispatch retain all schemas and request identity',async()=>{
 const first=await handleMcp(request(1,'tools/list'),context);const one=await first.json();assert.equal(one.result.tools.length,14);
 const second=await handleMcp(request(2,'tools/list'),context);const two=await second.json();assert.equal(two.id,2);assert.deepEqual(one.result,two.result);
 const response=await handleMcp(request(3,'tools/call',{name:'apple_music_status',arguments:{}}),context);const call=await response.json();assert.equal(call.id,3);assert.equal(call.result.isError,undefined);const result=JSON.parse(call.result.content[0].text);assert.equal(result.connected,false);
});
test('MCP bounds streamed request bodies even without Content-Length',async()=>{
 const r=new Request('https://example.test/mcp',{method:'POST',headers,body:'x'.repeat(1_048_577)});const response=await handleMcp(r,context);assert.equal(response.status,413);
});

test('an uncertain append is not retried or reported as an accepted write',async(t)=>{
 const {AppleMusicApi}=await import('../src/apple.ts');
 const {AppleMusicWriteUncertainError}=await import('../src/apple-transport.ts');
 let reads=0,writes=0;
 t.mock.method(AppleMusicApi.prototype,'playlistTracks',async()=>{if(reads++===0)return[];throw new Error('readback unavailable');});
 t.mock.method(AppleMusicApi.prototype,'resolveSongIds',async()=>({resolved:[{id:'123',type:'songs',inputIndex:0,match:'provided_id'}],unresolved:[],ambiguous:[]}));
 t.mock.method(AppleMusicApi.prototype,'addTracksToPlaylist',async()=>{writes++;throw new AppleMusicWriteUncertainError();});
 const response=await handleMcp(request(4,'tools/call',{name:'apple_music_add_tracks_to_playlist',arguments:{playlistId:'test',tracks:[{id:'123'}],dryRun:false,allowPartial:false}}),context);
 const body=await response.json();const result=JSON.parse(body.result.content[0].text);
 assert.equal(writes,1);assert.equal(result.doNotRetry,true);assert.equal(result.writeOutcome,'unknown');assert.deepEqual(result.added,[]);assert.equal(result.pendingVerification.length,1);
});

test('tool input element budget blocks oversized structures while allowing a full 100-track preview',async(t)=>{
 const oversized=await handleMcp(request(5,'tools/call',{name:'apple_music_status',arguments:{extra:Array.from({length:2_049},()=>0)}}),context);
 const rejected=await oversized.json();assert.equal(rejected.result.isError,true);
 const {AppleMusicApi}=await import('../src/apple.ts');
 t.mock.method(AppleMusicApi.prototype,'playlistTracks',async()=>[]);
 const normal=await handleMcp(request(6,'tools/call',{name:'apple_music_add_tracks_to_playlist',arguments:{playlistId:'synthetic-playlist',tracks:Array.from({length:100},(_,i)=>({id:String(i+1)})),dryRun:true,allowPartial:false}}),context);
 const accepted=await normal.json();assert.equal(accepted.result.isError,undefined);
 const result=JSON.parse(accepted.result.content[0].text);assert.equal(result.requested,100);assert.equal(result.resolved.length,100);assert.equal(result.dryRun,true);assert.deepEqual(result.added,[]);
});
