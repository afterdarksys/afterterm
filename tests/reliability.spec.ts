import { test, expect, type Page } from '@playwright/test';

async function harness(page: Page, options: { delaySpawn?: boolean; delayAttach?: boolean } = {}) {
  await page.addInitScript((options) => {
    const w = window as any;
    const callbacks = new Map<number, Function>();
    const listeners = new Map<number, {event:string;handler:number}>();
    let next = 1, session = 0;
    w.calls = []; w.pending = {}; w.sessions = {}; w.confirmFailures = 0;
    w.emit = (event:string, payload:unknown) => {
      for (const [id, listener] of listeners) if (listener.event === event) callbacks.get(listener.handler)?.({event,id,payload});
    };
    w.challenge = (id:number, requestId:number) => {
      const challenge = {request_id:requestId,action:`Review session ${id}`,expected:'unknown target',reason:'Fixture target unknown',input:'echo fixture\\r'};
      w.pending[id] = challenge; w.emit('pty:challenge',{id,challenge});
    };
    w.output = (id:number, sequence:number, text:string) => w.emit('pty:output',{id,sequence,data:btoa(text)});
    Object.defineProperty(navigator, 'clipboard', {value:{
      readText: () => new Promise<string>(resolve => { w.resolveClipboard = resolve; }),
      writeText: async (text:string) => {w.copied=text;},
    }});
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = {unregisterListener: (_:string,id:number) => listeners.delete(id)};
    w.__TAURI_INTERNALS__ = {
      metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},
      transformCallback:(callback:Function) => {const id=next++;callbacks.set(id,callback);return id;},
      invoke:async(command:string,args:any = {}) => {
        w.calls.push({command,args});
        switch(command) {
          case 'plugin:event|listen': {const id=next++;listeners.set(id,args);return id;}
          case 'plugin:event|unlisten': return;
          case 'prefs_load': return {theme:'signal',font_family:'monospace',font_size:13,transparency:1,cursor_style:'bar',scrollback:10000,reduced_motion:true,ai_enabled:false};
          case 'pty_spawn': {
            const id=++session; w.sessions[id]={reviewed:true};
            if(options.delaySpawn && id===1) await new Promise<void>(resolve => {w.resolveSpawn=resolve;});
            return id;
          }
          case 'pty_attach': {
            const snapshot={chunks:[{sequence:1,data:[...new TextEncoder().encode('boot-ready\r\n\x1b[?2004h')]}],sequence:1,dropped:0,exit:null,reviewed:w.sessions[args.id].reviewed,pending:w.pending[args.id] ?? null};
            if(options.delayAttach) await new Promise<void>(resolve=> {w.resolveAttach=resolve;});
            return snapshot;
          }
          case 'pty_set_title': case 'pty_resize': case 'prefs_save': return;
          case 'pty_kill': delete w.sessions[args.id]; delete w.pending[args.id]; return;
          case 'pty_write': return null;
          case 'pty_review': return w.pending[args.id] ?? null;
          case 'pty_confirm':
            if(w.confirmFailures-- > 0) throw Error('Injected delivery failure');
            if(w.pending[args.id]?.request_id===args.requestId) delete w.pending[args.id];
            if(w.loseReply) {w.loseReply=false;throw Error('Reply lost after execution');}
            return;
          case 'pty_set_reviewed':
            w.sessions[args.id].reviewed=args.reviewed;
            if(w.loseModeReply) {w.loseModeReply=false;throw Error('Mode reply lost');}
            return;
          case 'serial_ports': return [];
          default: throw Error(`Unexpected native command ${command}`);
        }
      },
    };
  }, options);
  await page.goto('/');
}
async function ready(page: Page) {
  await expect.poll(() => page.evaluate(() => (window as any).calls.filter((x:any)=>x.command==='pty_attach').length)).toBeGreaterThan(0);
  await expect(page.locator('.term-host.is-active .xterm-screen')).toBeVisible();
}
const calls = (page:Page, command:string) => page.evaluate(command => (window as any).calls.filter((call:any) => call.command === command), command);
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

test('closing a starting tab kills its late session without killing the replacement', async ({page}) => {
  await harness(page,{delaySpawn:true});
  await expect.poll(()=>page.evaluate(()=>typeof (window as any).resolveSpawn)).toBe('function');
  await page.getByLabel('Close shell',{exact:true}).click();
  await page.evaluate(()=>(window as any).resolveSpawn());
  await expect.poll(async()=>(await calls(page,'pty_kill')).map((x:any)=>x.args.id)).toEqual([1]);
  await expect.poll(()=>page.evaluate(()=>Object.keys((window as any).sessions))).toEqual(['2']);
});

test('shortcut paste uses bracketed paste and keeps its original destination across a tab switch', async ({page}) => {
  await harness(page); await ready(page);
  await page.locator('.term-host.is-active .xterm-helper-textarea').focus();
  await page.keyboard.press(`${mod}+v`);
  await expect.poll(()=>page.evaluate(()=>typeof (window as any).resolveClipboard)).toBe('function');
  await page.getByRole('button',{name:'New tab',exact:true}).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await page.evaluate(()=>(window as any).resolveClipboard('first\nsecond'));
  await expect.poll(async()=>(await calls(page,'pty_write')).filter((x:any)=>x.args.data.includes('first'))).toEqual([
    {command:'pty_write',args:{id:1,data:'\x1b[200~first\rsecond\x1b[201~'}}
  ]);
});

test('closing the destination cancels a delayed clipboard paste', async ({page}) => {
  await harness(page); await ready(page);
  await page.locator('.term-host.is-active .xterm-helper-textarea').focus();
  await page.keyboard.press(`${mod}+v`);
  await expect.poll(()=>page.evaluate(()=>typeof (window as any).resolveClipboard)).toBe('function');
  await page.getByLabel('Close shell',{exact:true}).click();
  await page.evaluate(()=>(window as any).resolveClipboard('never-send'));
  // Round-trip another native request after the clipboard promise settles.
  await ready(page);
  expect((await calls(page,'pty_write')).some((x:any)=>x.args.data.includes('never-send'))).toBe(false);
});

test('failed confirmation retains review and retry acknowledges the same request', async ({page}) => {
  await harness(page); await ready(page);
  await page.evaluate(()=>{(window as any).confirmFailures=1;(window as any).challenge(1,7);});
  await page.getByLabel('Confirmation text').fill('unknown target');
  await page.getByRole('button',{name:'Approve',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Injected delivery failure');
  await expect(page.locator('.submission-preview')).toHaveText('echo fixture\\r');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button',{name:'Approve',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await calls(page,'pty_confirm')).map((x:any)=>x.args.requestId)).toEqual([7,7]);
});

test('lost acknowledgement reconciles completed review without replay', async ({page}) => {
  await harness(page); await ready(page);
  await page.evaluate(()=>{(window as any).loseReply=true;(window as any).challenge(1,3);});
  await page.getByLabel('Confirmation text').fill('unknown target');
  await page.getByRole('button',{name:'Approve',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await calls(page,'pty_confirm')).toHaveLength(1);
  await expect(page.locator('footer')).toContainText('Reply lost after execution');
});

test('two session reviews remain queued rather than replacing one another', async ({page}) => {
  await harness(page); await ready(page);
  await page.getByRole('button',{name:'New tab',exact:true}).click();
  await expect.poll(async()=>(await calls(page,'pty_attach')).length).toBe(2);
  await page.evaluate(()=>{(window as any).challenge(1,1);(window as any).challenge(2,1);});
  await expect(page.getByRole('heading')).toHaveText('Review session 1');
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(page.getByRole('heading')).toHaveText('Review session 2');
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await calls(page,'pty_confirm')).map((x:any)=>x.args.id)).toEqual([1,2]);
});

test('target is unknown per session and disabling review requires explicit confirmation', async ({page}) => {
  await harness(page); await ready(page);
  await expect(page.locator('footer')).toContainText('target unknown · review every submission');
  await page.getByRole('button',{name:'Use direct terminal'}).click();
  await expect(page.getByRole('button',{name:'Approve',exact:true})).toBeDisabled();
  await page.getByLabel('Confirmation text').fill('DIRECT');
  await page.getByRole('button',{name:'Approve',exact:true}).click();
  await expect(page.locator('footer')).toContainText('direct terminal — review off');
  await page.getByRole('button',{name:'New tab',exact:true}).click();
  await expect(page.locator('footer')).toContainText('review every submission');
  expect(await calls(page,'pty_context')).toHaveLength(0);
});

test('lost mode-change reply reconciles the actual review state', async ({page}) => {
  await harness(page); await ready(page);
  await page.evaluate(()=>(window as any).loseModeReply=true);
  await page.getByRole('button',{name:'Use direct terminal'}).click();
  await page.getByLabel('Confirmation text').fill('DIRECT');
  await page.getByRole('button',{name:'Approve',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('footer')).toContainText('direct terminal — review off');
  expect(await calls(page,'pty_set_reviewed')).toHaveLength(1);
});

test('a delayed duplicate review event cannot reopen an acknowledged request', async ({page}) => {
  await harness(page); await ready(page);
  await page.evaluate(()=>(window as any).challenge(1,9));
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(()=>(window as any).challenge(1,9));
  await page.getByRole('button',{name:'New tab',exact:true}).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('output received during snapshot attachment is available in real terminal scrollback', async ({page}) => {
  await harness(page,{delayAttach:true}); await ready(page);
  await page.evaluate(()=>{
    (window as any).output(1,1,'boot-ready\r\n\x1b[?2004h');
    (window as any).output(1,2,'live-output\r\n');
    (window as any).resolveAttach();
  });
  await page.locator('.term-host.is-active .xterm-helper-textarea').focus();
  for (const text of ['boot-ready', 'live-output']) {
    await page.keyboard.press(`${mod}+f`);
    await page.getByLabel('Find in scrollback').fill(text);
    await page.getByLabel('Next match').click();
    await page.getByLabel('Close find').click();
    await page.keyboard.press(`${mod}+c`);
    await expect.poll(()=>page.evaluate(()=>(window as any).copied)).toBe(text);
  }
});
