import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OutputReplay, type Snapshot } from './outputReplay.ts';
const chunk = (sequence:number,text:string) => ({sequence,data:[...new TextEncoder().encode(text)]});
const snapshot = (chunks: ReturnType<typeof chunk>[], sequence:number):Snapshot => ({chunks,sequence,dropped:0,exit:null,reviewed:true,pending:null});
test('replay merges snapshot with concurrent and duplicate events exactly once',()=>{
 const output:string[]=[], notices:string[]=[];
 const replay=new OutputReplay(data=>output.push(new TextDecoder().decode(data)),text=>notices.push(text));
 replay.receive(chunk(1,'boot'));replay.receive(chunk(3,'third'));replay.receive(chunk(2,'second'));
 replay.attach(snapshot([chunk(1,'boot'),chunk(2,'second')],2));
 replay.receive(chunk(3,'third'));replay.receive(chunk(4,'fourth'));
 assert.deepEqual(output,['boot','second','third','fourth']);assert.deepEqual(notices,[]);
});
test('bounded replay reports lost history and a live sequence gap',()=>{
 const notices:string[]=[];const replay=new OutputReplay(()=>{},text=>notices.push(text));
 replay.attach({...snapshot([chunk(5,'retained')],5),dropped:100});replay.receive(chunk(7,'gap'));
 assert.deepEqual(notices,['100 bytes of early output dropped','Terminal output gap detected']);
});
