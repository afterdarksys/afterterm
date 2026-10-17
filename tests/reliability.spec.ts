import { test, expect, type Page } from '@playwright/test';

async function harness(page: Page, options: { delaySpawn?: boolean; delayAttach?: boolean; launchArgs?: string[]; direct?: boolean; prefsFail?: boolean; platform?: string } = {}) {
  await page.addInitScript((options) => {
    const w = window as any;
    // Both the app and xterm read navigator.platform when they load.
    if (options.platform) Object.defineProperty(navigator, 'platform', {value:options.platform});
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
          case 'launch_args': return options.launchArgs ?? [];
          case 'plugin:event|listen': {const id=next++;listeners.set(id,args);return id;}
          case 'plugin:event|unlisten': return;
          case 'prefs_load': if (options.prefsFail) throw Error('prefs.json is not valid JSON'); return {theme:'signal',font_family:'monospace',font_size:13,transparency:1,cursor_style:'bar',scrollback:10000,reduced_motion:true,ai_enabled:false};
          case 'pty_spawn': {
            const id=++session; w.sessions[id]={reviewed:!options.direct};
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
          case 'pty_write': if (w.failWrite) throw Error('pty write failed: broken pipe'); return null;
          case 'pty_review': return w.pending[args.id] ?? null;
          case 'pty_confirm':
            if(w.confirmFailures-- > 0) throw Error('Injected delivery failure');
            if(w.pending[args.id]?.request_id===args.requestId) delete w.pending[args.id];
            if(w.loseReply) {w.loseReply=false;throw Error('Reply lost after execution');}
            return;
          case 'pty_set_reviewed':
            if(w.failMode) throw Error('Resolve the pending submission before changing modes');
            w.sessions[args.id].reviewed=args.reviewed;
            if(w.loseModeReply) {w.loseModeReply=false;throw Error('Mode reply lost');}
            return;
          case 'pty_info': return {id:args.id,title:'shell',program:'/bin/zsh',args:[],pid:4242,foreground_pgid:w.foreground ?? 4242,start_cwd:'/Users/test',cwd:'/tmp',rows:24,cols:80,started_at_ms:0,bytes_in:10,bytes_out:2048,exit:null,reviewed:false,log:w.logError ? {path:'/tmp/s.log',bytes:5,error:w.logError,active:false} : null};
          case 'pty_signal': return 'foreground process group 4242';
          case 'serial_ports': return [];
          case 'plugin:clipboard-manager|read_text': return new Promise<string>(resolve => { w.resolveClipboard = resolve; });
          case 'plugin:clipboard-manager|write_text': w.copied = args.text; return;
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

test('SAH launch arguments apply only to the initial tab', async ({page}) => {
  await harness(page, {launchArgs: ['connect', 'web1', '--root']}); await ready(page);
  expect((await calls(page, 'pty_spawn'))[0].args.sahArgs).toEqual(['connect', 'web1', '--root']);
  await page.getByRole('button', {name:'New tab', exact:true}).click();
  await expect.poll(async () => (await calls(page, 'pty_spawn')).length).toBe(2);
  expect((await calls(page, 'pty_spawn'))[1].args.sahArgs).toEqual([]);
});

test('SAH panel connects with literal host arguments and supports login', async ({page}) => {
  await harness(page); await ready(page);
  await page.getByRole('button', {name:'Connect SAH', exact:true}).click();
  await page.getByLabel('Host name or host ID').fill('web1; echo nope');
  await expect(page.getByRole('button', {name:'Connect', exact:true})).toBeDisabled();
  await page.getByLabel('Host name or host ID').fill('web1');
  await page.getByRole('button', {name:'Connect', exact:true}).click();
  await expect.poll(async () => (await calls(page, 'pty_spawn')).length).toBe(2);
  expect((await calls(page, 'pty_spawn'))[1].args.sahArgs).toEqual(['connect','web1']);
  await page.getByRole('button', {name:'Connect SAH', exact:true}).click();
  await page.getByRole('button', {name:'Sign in to SAH', exact:true}).click();
  await expect.poll(async () => (await calls(page, 'pty_spawn')).length).toBe(3);
  expect((await calls(page, 'pty_spawn'))[2].args.sahArgs).toEqual(['login']);
});

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

const menu = (page:Page, id:string) => page.evaluate(id => (window as any).emit('afterterm:menu', id), id);
const status = (page:Page) => page.locator('footer [role=status]');

test('Edit menu paste uses the same bracketed, review-aware path as the shortcut', async ({page}) => {
  await harness(page); await ready(page);
  await menu(page, 'edit.paste');
  await expect.poll(()=>page.evaluate(()=>typeof (window as any).resolveClipboard)).toBe('function');
  await page.evaluate(()=>(window as any).resolveClipboard('menu-paste'));
  await expect.poll(async()=>(await calls(page,'pty_write')).filter((x:any)=>x.args.data.includes('menu-paste'))).toEqual([
    {command:'pty_write',args:{id:1,data:'\x1b[200~menu-paste\x1b[201~'}}
  ]);
});

test('Edit menu select all, copy and cut use the native clipboard and announce the result', async ({page}) => {
  await harness(page); await ready(page);
  await menu(page, 'edit.copy');
  await expect(status(page)).toContainText('Nothing is selected');
  await menu(page, 'edit.select-all');
  await menu(page, 'edit.cut');
  await expect.poll(()=>page.evaluate(()=>(window as any).copied)).toContain('boot-ready');
  await expect(status(page)).toContainText('Cut works like Copy');
});

test('Session Info opens from the menu, takes focus, and Escape returns focus to the terminal', async ({page}) => {
  await harness(page); await ready(page);
  await page.locator('.term-host.is-active .xterm-helper-textarea').focus();
  await menu(page, 'view.session-info');
  await expect(page.getByRole('heading', {name:'Session info'})).toBeFocused();
  await expect(page.getByRole('dialog', {name:'Session info'})).toContainText('/bin/zsh');
  await expect(page.getByRole('dialog', {name:'Session info'})).toContainText('24 rows by 80 columns');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', {name:'Session info'})).toHaveCount(0);
  await expect(page.locator('.term-host.is-active .xterm-helper-textarea')).toBeFocused();
});

test('stty controls compose one command and send it only on Apply; signals go by name', async ({page}) => {
  await harness(page); await ready(page);
  await menu(page, 'view.session-info');
  const panel = page.getByRole('dialog', {name:'Session info'});
  await panel.getByLabel('Echo typed characters (echo)').selectOption('off');
  await panel.getByLabel('Erase character').fill('^h');
  await expect(panel).toContainText("Command to send: stty -echo erase '^H'");
  expect((await calls(page,'pty_write')).some((x:any)=>x.args.data.includes('stty'))).toBe(false);
  await panel.getByRole('button', {name:'Apply'}).click();
  await expect.poll(async()=>(await calls(page,'pty_write')).filter((x:any)=>x.args.data.includes('stty')).map((x:any)=>x.args.data)).toEqual(["\u0015stty -echo erase '^H'\n"]);
  await panel.getByLabel('Erase character').fill('$(id)');
  await expect(panel.getByRole('button', {name:'Apply'})).toBeDisabled();
  await panel.getByRole('button', {name:'Terminate (SIGTERM)'}).click();
  await expect.poll(async()=>(await calls(page,'pty_signal')).map((x:any)=>x.args)).toEqual([{id:1,signal:'TERM'}]);
  await expect(status(page)).toContainText('Sent SIGTERM to foreground process group 4242');
});

test('Preferences announce a theme chosen by name and ask before resetting everything', async ({page}) => {
  await harness(page); await ready(page);
  await menu(page, 'app.prefs');
  const panel = page.getByRole('dialog', {name:'Preferences'});
  await expect(panel.getByRole('combobox', {name:'Theme', exact:true})).toBeFocused();
  await panel.getByRole('combobox', {name:'Theme', exact:true}).selectOption({label:'Nocturne'});
  await expect(status(page)).toContainText('Theme Nocturne applied');
  await panel.getByRole('button', {name:'Reset all preferences to defaults…'}).click();
  await expect(panel.getByRole('button', {name:'Cancel'})).toBeFocused();
  await panel.getByRole('button', {name:'Reset to defaults'}).click();
  await expect(panel.getByRole('combobox', {name:'Theme', exact:true})).toHaveValue('signal');
  await expect(status(page)).toContainText('All preferences reset to defaults');
});

test('typed commands go to another foreground program only after typing SEND', async ({page}) => {
  await harness(page); await ready(page);
  await page.evaluate(()=>{(window as any).foreground = 999;});
  await menu(page, 'shell.stty-show');
  const dialog = page.getByRole('dialog', {name:/foreground/});
  await expect(dialog).toContainText('process group 999');
  expect((await calls(page,'pty_write')).some((x:any)=>x.args.data.includes('stty'))).toBe(false);
  await page.getByLabel('Confirmation text').fill('SEND');
  await page.getByRole('button',{name:'Approve',exact:true}).click();
  await expect.poll(async()=>(await calls(page,'pty_write')).filter((x:any)=>x.args.data.includes('stty')).map((x:any)=>x.args.data)).toEqual(['stty -a\n']);
});

test('a failed write is announced instead of a success message', async ({page}) => {
  await harness(page); await ready(page);
  await page.evaluate(()=>{(window as any).failWrite = true;});
  await menu(page, 'shell.reset');
  await expect(status(page)).toContainText('Write failed');
  await page.waitForTimeout(200);
  await expect(status(page)).not.toContainText('stty sane sent');
});

test('edit commands in a number field or other control never reach the terminal', async ({page}) => {
  await harness(page); await ready(page);
  await menu(page, 'app.prefs');
  const field = page.getByRole('spinbutton', {name:'Scrollback lines'});
  await field.focus();
  await menu(page, 'edit.paste');
  await expect.poll(()=>page.evaluate(()=>typeof (window as any).resolveClipboard)).toBe('function');
  await page.evaluate(()=>(window as any).resolveClipboard('5000'));
  await expect(field).toHaveValue('5000');
  expect((await calls(page,'pty_write')).some((x:any)=>x.args.data.includes('5000'))).toBe(false);
  await page.getByRole('combobox', {name:'Bell'}).focus();
  await menu(page, 'edit.paste');
  await expect(status(page)).toContainText('move focus there first');
});

test('a failed review toggle never announces that review is on', async ({page}) => {
  await harness(page, {direct:true}); await ready(page);
  await page.evaluate(()=>{(window as any).failMode = true;});
  await menu(page, 'shell.toggle-review');
  await expect(status(page)).toContainText('Resolve the pending submission');
  await page.waitForTimeout(200);
  await expect(status(page)).not.toContainText('Submission review on');
});

test('a shortcut and its menu echo run once, but two quick presses both run', async ({page}) => {
  await harness(page); await ready(page);
  await page.locator('.term-host.is-active .xterm-helper-textarea').focus();
  await page.keyboard.press(`${mod}+Equal`);
  await menu(page, 'view.font-larger');
  await ready(page);
  const sizes = async () => (await calls(page,'prefs_save')).map((x:any)=>x.args.prefs.font_size);
  await expect.poll(sizes).toEqual([14]);
  await page.keyboard.press(`${mod}+Equal`);
  await page.keyboard.press(`${mod}+Equal`);
  await expect.poll(sizes).toEqual([14, 15, 16]);
  await menu(page, 'view.font-larger');
  await expect.poll(sizes).toEqual([14, 15, 16]);
  await page.mouse.click(5, 300);
  await menu(page, 'view.font-larger');
  await expect.poll(sizes).toEqual([14, 15, 16, 17]);
});

test('unreadable preferences stay announced after the shell starts', async ({page}) => {
  await harness(page, {prefsFail:true}); await ready(page);
  await expect(status(page)).toContainText('Shell ready. Preferences could not be read');
});

test('a session log that stops on its own is announced', async ({page}) => {
  await harness(page); await ready(page);
  await page.evaluate(()=>{(window as any).logError = 'the log file could not keep up with terminal output';});
  await menu(page, 'view.session-info');
  await expect(status(page)).toContainText('Session log stopped: the log file could not keep up');
  await expect(page.getByRole('checkbox', {name:'Log session output to a file'})).not.toBeChecked();
});

test('tabs are a keyboard tab list with separate, labelled close buttons', async ({page}) => {
  await harness(page); await ready(page);
  await page.getByRole('button', {name:'New tab', exact:true}).click();
  await page.getByRole('button', {name:'New tab', exact:true}).click();
  const tabs = page.getByRole('tablist', {name:'Terminal sessions'}).getByRole('tab');
  await expect(tabs).toHaveCount(3);
  await expect.poll(async()=>(await calls(page,'pty_attach')).length).toBe(3);
  // The close control is its own button, not part of the tab's name.
  await expect(tabs.nth(2)).toHaveAccessibleName(/^shell/);
  await expect(tabs.nth(2)).not.toHaveAccessibleName(/Close|×/);
  await expect(tabs.nth(2)).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'false');
  const controls = await tabs.nth(2).getAttribute('aria-controls');
  await expect(page.locator(`#${controls}`)).toHaveAttribute('role', 'tabpanel');
  await expect(page.locator(`#${controls}`)).toHaveClass(/is-active/);
  // Only the selected tab is in the Tab order, and its Close button comes next.
  await expect(tabs.nth(2)).toHaveAttribute('tabindex', '0');
  await expect(tabs.nth(0)).toHaveAttribute('tabindex', '-1');
  await tabs.nth(2).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', {name:'Close shell'}).nth(2)).toBeFocused();
  // Arrow keys move focus between tabs (wrapping); Enter opens the focused tab.
  await tabs.nth(2).focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.nth(0)).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(tabs.nth(2)).toBeFocused();
  await page.keyboard.press('Home');
  await expect(tabs.nth(0)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.term-host.is-active .xterm-helper-textarea')).toBeFocused();
  // Delete on a tab that is not selected closes it and keeps focus in the tab list.
  await tabs.nth(0).focus();
  await page.keyboard.press('End');
  await page.keyboard.press('Delete');
  await expect(tabs).toHaveCount(2);
  await expect.poll(async()=>(await calls(page,'pty_kill')).map((x:any)=>x.args.id)).toEqual([3]);
  await expect(tabs.nth(1)).toBeFocused();
  await expect(status(page)).toContainText('Closed shell');
  // Command+W (Control+Shift+W elsewhere) still closes the selected tab.
  await page.locator('.term-host.is-active .xterm-helper-textarea').focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+KeyW' : 'Control+Shift+KeyW');
  await expect(tabs).toHaveCount(1);
});

for (const platform of [undefined, 'Linux x86_64']) {
  test(`Send Control-C delivers exactly one Control-C from the keyboard and its menu echo (${platform ?? 'this platform'})`, async ({page}) => {
    await harness(page, {platform}); await ready(page);
    const linux = platform !== undefined || process.platform !== 'darwin';
    const writes = async () => (await calls(page,'pty_write')).map((x:any)=>x.args.data);
    await page.locator('.term-host.is-active .xterm-helper-textarea').focus();
    // Off macOS the chord is Control+Shift+Alt+C, which xterm would otherwise turn into ESC ^C.
    await page.keyboard.press(linux ? 'Control+Shift+Alt+KeyC' : 'Control+Shift+KeyC');
    await menu(page, 'shell.interrupt');
    await ready(page);
    await expect.poll(writes).toEqual(['\x03']);
    await page.waitForTimeout(200);
    expect(await writes()).toEqual(['\x03']);
    // A plain Control-C is the shell's: xterm sends it once and the app does not add another.
    await page.keyboard.press('Control+KeyC');
    await expect.poll(writes).toEqual(['\x03', '\x03']);
    await page.waitForTimeout(200);
    expect(await writes()).toEqual(['\x03', '\x03']);
  });
}

test('paste into a text field honors maxLength and can be undone', async ({page}) => {
  await harness(page); await ready(page);
  await page.getByRole('button', {name:'Connect SAH', exact:true}).click();
  const field = page.getByLabel('Host name or host ID');
  await field.fill('web');
  await field.evaluate((input: HTMLInputElement) => { input.maxLength = 6; input.setSelectionRange(3, 3); });
  await menu(page, 'edit.paste');
  await expect.poll(()=>page.evaluate(()=>typeof (window as any).resolveClipboard)).toBe('function');
  await page.evaluate(()=>(window as any).resolveClipboard('123456789'));
  await expect(field).toHaveValue('web123');
  await expect(status(page)).toContainText('Pasted 3 of 9 characters');
  await expect(page.getByRole('button', {name:'Connect', exact:true})).toBeEnabled();
  await page.evaluate(() => document.execCommand('undo'));
  await expect(field).toHaveValue('web');
  expect((await calls(page,'pty_write')).some((x:any)=>x.args.data.includes('123'))).toBe(false);
});
