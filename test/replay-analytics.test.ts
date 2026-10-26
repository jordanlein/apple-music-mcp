import assert from 'node:assert/strict';
import test from 'node:test';
import {registerHooks} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
registerHooks({resolve(s,c,next){try{return next(s,c);}catch(e){if(s.startsWith('.')&&!/\.[a-z]+$/i.test(s))return next(s+'.ts',c);throw e;}}});
const {appleReplaySummary,listeningSummary,topListeningStats}=await import('../src/analytics.ts');
const {AppleMusicApi}=await import('../src/apple.ts');

function replay(){return{data:[{id:'summary',type:'music-summaries',attributes:{year:new Date().getUTCFullYear(),period:'year'},views:{
 'top-songs':{data:['3','1','404'].map(id=>({id:'period-'+id,type:'song-period-summaries',attributes:{playCount:5},relationships:{song:{data:[{id,type:'songs',attributes:id==='3'?{name:'Original title'}:undefined}]}}}))},
 'top-albums':{data:[{id:'album-period',type:'album-period-summaries',relationships:{album:{data:[{id:'123',type:'albums',attributes:{name:'Synthetic album',trackCount:19}}]}}}]},
 'top-artists':{data:[]}
}}]};}

test('Replay resolves missing song metadata in a batch without altering ranks or making album counts into totals',async(t)=>{
 t.mock.method(AppleMusicApi.prototype,'replaySummary',async()=>replay());
 let lookups=0;t.mock.method(AppleMusicApi.prototype,'catalogSongs',async(ids)=>{lookups++;assert.deepEqual(ids,['3','1','404']);return ['1','3'].map(id=>({id,type:'songs',attributes:{name:'Catalog '+id,artistName:'Synthetic artist',url:'https://music.apple.com/us/song/'+id}}));});
 const result=await appleReplaySummary({} as any);
 assert.equal(lookups,1);assert.deepEqual(result.topSongs.map(x=>x.resource?.id),['3','1','404']);assert.deepEqual(result.topSongs.map(x=>x.rank),[1,2,3]);
 assert.equal(result.topSongs[0].resource?.name,'Original title');assert.equal(result.topSongs[0].resource?.artistName,'Synthetic artist');assert.equal(result.topSongs[1].metadataStatus,'catalog_enriched');assert.equal(result.topSongs[2].metadataStatus,'unavailable');
 assert.deepEqual(result.totals,[]);assert.equal(result.totalsAvailable,false);assert.equal(result.songMetadata.unavailable,1);assert.equal(result.coverage.periodState,'in_progress');assert.equal(result.rankingInfo['top-albums'].returned,1);assert.equal(result.rankingInfo['top-artists'].returned,0);
});

test('Replay catalog failure keeps official ranks and reports unavailable metadata without exposing the error',async(t)=>{
 t.mock.method(AppleMusicApi.prototype,'replaySummary',async()=>replay());
 t.mock.method(AppleMusicApi.prototype,'catalogSongs',async()=>{throw new Error('private upstream diagnostics');});
 const result=await appleReplaySummary({} as any);assert.equal(result.topSongs.length,3);assert.equal(result.songMetadata.lookupFailed,true);assert.equal(result.songMetadata.unavailable,3);assert.doesNotMatch(JSON.stringify(result),/private upstream/);
});

test('Replay totals are limited to explicit summary listening metrics',async(t)=>{
 const response=replay();Object.assign(response.data[0].attributes,{totalPlays:250,totalListeningMinutes:90,trackCount:700,updateTime:'2026-01-01T00:00:00Z'});
 t.mock.method(AppleMusicApi.prototype,'replaySummary',async()=>response);t.mock.method(AppleMusicApi.prototype,'catalogSongs',async()=>[]);
 const result=await appleReplaySummary({} as any);assert.equal(result.totalsAvailable,true);assert.deepEqual(result.totals.map(x=>x.value),[250,90]);assert.ok(result.totals.every(x=>x.path.startsWith('$.summary.attributes.')));
});

function database(){
 const sqlite=new DatabaseSync(':memory:');for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(x=>x.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 const db={prepare(sql:string){return{values:[] as any[],bind(...v:any[]){this.values=v;return this;},async first(){return sqlite.prepare(sql).get(...this.values)??null;},async run(){const r=sqlite.prepare(sql).run(...this.values);return{meta:{changes:r.changes}};},sql};},async batch(stmts:any[]){return stmts.map(s=>({results:sqlite.prepare(s.sql).all(...s.values)}));}};
 return{sqlite,env:{DB:db} as any};
}

test('all observed ranking categories expose names, album references are real, and anchored queries align',async(t)=>{
 const {sqlite,env}=database();t.after(()=>sqlite.close());
 const insert=sqlite.prepare('INSERT INTO listen_events(event_key,track_id,resource_type,name,artist_name,album_name,duration_ms,genre_names_json,apple_url,observed_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
 insert.run('event-1','1','songs','Synthetic song','Synthetic artist','Synthetic album',180000,'["Synthetic genre"]','https://music.apple.com/us/album/synthetic/123?i=1','2026-01-10T00:00:00Z');
 insert.run('event-2','2','songs','Other song','Other artist','Other album',180000,'["Other genre"]','https://other.example/album/456?i=2','2026-01-11T00:00:00Z');
 const options={preset:'30d' as const,asOf:'2026-01-15T00:00:00Z'};const summary=await listeningSummary(env,options);
 for(const list of [summary.topTracks,summary.topArtists,summary.topAlbums,summary.topGenres])assert.ok(list.every(x=>typeof x.name==='string'&&x.name.length));
 const album=summary.topAlbums.find(x=>x.name==='Synthetic album')!;assert.equal(album.id,'123');assert.equal(album.url,'https://music.apple.com/us/album/synthetic/123');assert.equal(album.sample?.id,'123');assert.equal(summary.topAlbums.find(x=>x.name==='Other album')?.id,undefined);
 const top=await topListeningStats(env,options,'genres',10);assert.deepEqual(top.timeframe,summary.timeframe);assert.equal(top.items[0].name,top.items[0].key);
});

test('catalog hydration deduplicates 100 IDs into one read and uses the storefront-scoped cache',async(t)=>{
 const {sqlite,env}=database();t.after(()=>sqlite.close());env.CATALOG_RESOLVER={};let requests=0;
 class Api extends AppleMusicApi{async userStorefront(){return'us';}protected async request(path:string,options:any){requests++;assert.equal(options.user,false);const ids=new URL('https://example.test'+path).searchParams.get('ids')!.split(',');assert.equal(ids.length,100);return{data:ids.map(id=>({id,type:'songs',attributes:{name:'Synthetic '+id}}))};}}
 const api=new Api(env);const ids=Array.from({length:100},(_,i)=>String(i));assert.equal((await api.catalogSongs([...ids,'0'])).length,100);assert.equal((await api.catalogSongs([...ids].reverse())).length,100);assert.equal(requests,1);await assert.rejects(api.catalogSongs(Array.from({length:301},(_,i)=>String(i))),/300/);
});

test('album references can be enriched from archived catalog IDs, while mismatches stay unavailable',async(t)=>{
 const {sqlite,env}=database();t.after(()=>sqlite.close());
 const raw=JSON.stringify({id:'i.synthetic',type:'library-songs',attributes:{playParams:{catalogId:'111'}}});
 sqlite.prepare('INSERT INTO track_resource_versions(resource_hash,track_id,resource_type,raw_json,first_observed_at) VALUES(?,?,?,?,?)').run('synthetic-hash','i.synthetic','library-songs',raw,'2026-01-10T00:00:00Z');
 sqlite.prepare('INSERT INTO listen_events(event_key,track_id,resource_type,name,artist_name,album_name,resource_hash,observed_at) VALUES(?,?,?,?,?,?,?,?)').run('archive-event','i.synthetic','library-songs','Synthetic song','Synthetic artist','Synthetic album','synthetic-hash','2026-01-10T00:00:00Z');
 t.mock.method(AppleMusicApi.prototype,'catalogSongs',async(ids)=>{assert.deepEqual(ids,['111']);return[{id:'111',type:'songs',attributes:{albumName:'Synthetic album',artistName:'Synthetic artist'},relationships:{albums:{data:[{id:'222',type:'albums'}]}}}];});
 t.mock.method(AppleMusicApi.prototype,'catalogAlbums',async(ids)=>{assert.deepEqual(ids,['222']);return[{id:'222',type:'albums',attributes:{name:'Synthetic album',url:'https://music.apple.com/us/album/synthetic/222'}}];});
 const result=await topListeningStats(env,{preset:'all_time'},'albums',5);assert.equal(result.items[0].id,'222');assert.equal(result.items[0].url,'https://music.apple.com/us/album/synthetic/222');assert.equal(result.items[0].sample?.metadataStatus,'catalog_enriched');
 t.mock.method(AppleMusicApi.prototype,'catalogSongs',async()=>[{id:'111',type:'songs',attributes:{albumName:'Different edition',artistName:'Synthetic artist'},relationships:{albums:{data:[{id:'222',type:'albums'}]}}}]);
 const mismatch=await topListeningStats(env,{preset:'all_time'},'albums',5);assert.equal(mismatch.items[0].id,undefined);
});
