import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {once} from 'node:events';
import {readFileSync} from 'node:fs';
import {parseScenario} from '../packages/shared/scenario.js';
import {createPlayRouter} from '../apps/local-server/play-router.js';
import {createGameAI} from '../apps/local-server/game-ai.js';
import {responseRequest} from '../apps/relay/openai.js';
import type {LocalConfig} from '../apps/local-server/config.js';
const scenario=parseScenario(JSON.parse(readFileSync('scenarios/default.json','utf8')));
test('local Live routes keep relay token private and bind browser heartbeat to generation',async()=>{
 const calls:{path:string;body:any;authorization:string|null}[]=[];const token='a'.repeat(64);
 const fake:typeof fetch=async(input,init)=>{const path=new URL(String(input)).pathname;calls.push({path,body:init?.body?JSON.parse(String(init.body)):null,authorization:new Headers(init?.headers).get('authorization')});const body=path==='/health'?{mode:'live',models:{responses:'vision-model'}}:path==='/v1/sessions'?{token}:path==='/v1/live/sessions'?{session:{id:'live_test'},transport:{type:'webrtc',sdp:'answer'}}:{ok:true};return new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});};
 const config={scenario,relayUrl:'http://127.0.0.1:4311'} as LocalConfig;const play=createPlayRouter(config,{fetch:fake});const app=express();app.use('/api/play',play.router);const server=app.listen(0,'127.0.0.1');await once(server,'listening');const url='http://127.0.0.1:'+(server.address() as any).port;
 async function post(path:string,body:unknown){return fetch(url+'/api/play/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});}
 try{const response=await post('live',{sdp:'offer',passphrase:'secret'});assert.equal(response.status,201);const text=await response.text();assert.ok(!text.includes(token));assert.ok(!text.includes('secret'));const value=JSON.parse(text);assert.equal(value.sdp,'answer');assert.equal(value.opening.type,'session.commentary.append');assert.match(value.opening.content,/聞こえる/);assert.ok(Buffer.byteLength(value.opening.content)<=480);assert.equal((await post('heartbeat',{generation:value.generation+1,voiceState:'connected'})).status,409);assert.equal((await post('heartbeat',{generation:value.generation,voiceState:'connected'})).status,200);const started=await(await post('start',{})).json();assert.equal(started.status,'playing');assert.match(started.commands[0].content,/導入チュートリアルは終了/);assert.ok(!JSON.stringify(started).includes(scenario.obstacles[0].goal));assert.equal(calls.find(c=>c.path==='/v1/live/sessions')!.authorization,'Bearer '+token);await post('heartbeat',{generation:value.generation,voiceState:'disconnected'});assert.ok(calls.some(c=>c.path==='/v1/live/live_test/hangup'));}finally{await play.dispose();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
test('game Responses payload matches bounded relay schema and rejects malformed output',async()=>{let count=0;const ai=createGameAI(async(path,body)=>{assert.equal(path,'/v1/responses');responseRequest.parse(body);count++;return{output:[{type:'message',content:[{type:'output_text',text:count===1?JSON.stringify({items:[],usage:'',summary:'相談中'}):'{}'}]}]};},()=> 'vision-model');const context={scenario,obstacleIndex:0,situation:'部屋',inventory:[],photos:[],transcript:'何をしたらよい？'};assert.equal((await ai.recognize(context)).summary,'相談中');await assert.rejects(ai.recognize(context));});
