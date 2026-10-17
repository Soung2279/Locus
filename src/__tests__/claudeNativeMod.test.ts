import { describe, expect, it, vi } from 'vitest';
// This is the same self-contained module embedded in the Rust CLI launcher.
// @ts-expect-error Claude loads this JavaScript module directly.
import { register } from '../../src-tauri/src/llm/claude_code_cli/native_mod.js';

function harness(answer: unknown = { callId: 't1', result: { stdout: 'local', stderr: '', interrupted: false } }) {
  const hooks = new Map<string, { run: Function; fail?: Function; matcher?: object }>();
  const describeHooks: { run: Function; matcher?: object }[] = [];
  register((name: string, matchOrRun: Function | object, handler?: Function) => {
    const run = handler || matchOrRun as Function;
    const entry = { run, fail: undefined as Function | undefined, matcher: handler ? matchOrRun as object : undefined };
    hooks.set(name, entry);
    if (name === 'tool.describe') describeHooks.push(entry);
    return { catch(handler: Function) { entry.fail = handler; } };
  });
  const fetch = vi.fn(async (_url: string, _init: { body: string }) => ({ ok: true, status: 200, text: JSON.stringify(answer) }));
  const api = { env: { get: vi.fn(async (key: string) => key.endsWith('_URL') ? 'http://127.0.0.1:19200' : 'test-token') }, http: { fetch }, clock: { every: vi.fn(), now: vi.fn(async () => Date.now()) } };
  const next = vi.fn(async () => ({ result: 'original tool ran' }));
  return { hooks, describeHooks, api, fetch, next };
}

async function inputHarness(options: Record<string, any>) {
  const h = harness(options);
  const draft = { text: '' };
  const fill = vi.fn(async ({ text, mode }: { text: string; mode: string }) => {
    draft.text = mode === 'append' ? draft.text + text : text;
    return { isFilled: true };
  });
  const read = vi.fn(async () => ({ ...draft, cursor: draft.text.length }));
  const api = { ...h.api, env: { get: async (key: string) => key === 'LOCUS_CLAUDE_TUI' ? '1' : key.endsWith('_URL') ? 'http://127.0.0.1:19200' : 'test-token' },
    session: { id: async () => 'session', model: async () => 'claude-opus-5-5' }, prompt: { fill, read } };
  await h.hooks.get('session.start')!.run(api, {}, h.next);
  const poll = (h.api.clock.every.mock.calls[0] as unknown as [number, () => Promise<void>])[1];
  const events = () => h.fetch.mock.calls.map(call => JSON.parse(call[1].body)).filter(event => event.type);
  return { ...h, api, draft, fill, read, poll, events };
}

describe('Claude native tools Mod', () => {
  it.each(['user', 'attachment'])('persists a checkpoint for consumed mid-turn %s meta rows', async (type) => {
    const options = { active: true, inputId: 'main', insertion: { inputId: 'insert', submissionId: 'draft', prompt: 'New direction' } };
    const h = await inputHarness(options);
    await h.hooks.get('prompt.submit')!.run(h.api, { text: 'insert' }, h.next);
    const event = { uuid: 'native-insertion', door: 'note', message: { type, role: 'user', isMeta: true, content: [{ type: 'text', text: 'New direction' }] } };
    await h.hooks.get('session.append')!.run(h.api, event, h.next);
    expect(h.events().find(e => e.type === 'input_consumed')).toMatchObject({ id: 'draft', checkpoint: { version: 1, uuid: 'native-insertion', sessionId: 'session' } });
    expect(h.events().find(e => e.type === 'checkpoint')).toMatchObject({ uuid: 'native-insertion', submissionId: 'draft', user: true });
    await h.hooks.get('session.append')!.run(h.api, { ...event, uuid: 'later-reminder' }, h.next);
    expect(h.events().filter(e => e.type === 'input_consumed')).toHaveLength(1);
  });

  it.each([false, true])('limits interruption to old tools when Claude absorbs input inside the same native turn (during submit: %s)', async (duringSubmit) => {
    const options: Record<string, any> = { active: true, inputId: 'main', prompt: 'Original' };
    const h = await inputHarness(options);
    h.fetch.mockImplementation(async (url, init) => {
      const body = JSON.parse(init.body);
      return { ok: true, status: 200, text: JSON.stringify(url.endsWith('/options') ? options : { ok: true, callId: body.callId, result: 'done' }) };
    });
    const api = { ...h.api, session: { ...h.api.session, usage: async () => ({ context: {} }) } };
    await h.hooks.get('prompt.submit')!.run(api, { text: 'main' }, h.next);
    await h.hooks.get('turn.start')!.run(api, { turnId: 'unchanged-native-turn' }, h.next);
    await h.hooks.get('tool.call')!.run(api, { tool: 'mcp__locus__probe', tool_use_id: 'old' }, h.next);
    options.insertion = { inputId: 'insert', submissionId: 'draft', prompt: 'Continue thoroughly' };
    const absorb = async () => {
      await h.hooks.get('session.append')!.run(api, { uuid: 'receipt', door: 'note', message: { type: 'attachment', role: 'user', isMeta: true, content: [{ type: 'text', text: 'Continue thoroughly' }] } }, h.next);
      const stream = Object.assign((async function* () {})(), { result: Promise.resolve({ answer: '', toolUses: [], usage: {} }) });
      for await (const _ of h.hooks.get('turn.step')!.run(api, { turnId: 'unchanged-native-turn' }, () => stream)) { /* drain */ }
    };
    await h.hooks.get('prompt.submit')!.run(api, { text: 'insert' }, duringSubmit ? async () => { await absorb(); return {}; } : h.next);
    if (!duringSubmit) await absorb();
    await h.hooks.get('tool.call')!.run(api, { tool: 'mcp__locus__probe', tool_use_id: 'new' }, h.next);
    const calls = h.fetch.mock.calls.map(call => JSON.parse(call[1].body));
    const old = calls.find(e => e.callId === 'old');
    const fresh = calls.find(e => e.callId === 'new');
    expect(fresh.turnId).toBe(old.turnId);
    expect(fresh.executionId).not.toBe(old.executionId);
    expect(calls.filter(e => e.type === 'turn_interrupted').map(e => e.id)).toEqual([old.executionId]);
  });
  it('waits for each native image paste before appending text and authorizing Enter', async () => {
    const h = await inputHarness({ active: true, inputId: 'images', imageCount: 2, terminalText: 'images @"/cache/file.txt"' });
    await h.poll();
    expect(h.fill).toHaveBeenCalledExactlyOnceWith({ text: '', mode: 'replace' });
    await h.poll();
    expect(h.events()).toEqual([{ protocol: 1, type: 'input_images', runId: 'images', id: 'images', count: 0 }]);
    h.draft.text = '"/cache/image-1.png"';
    await h.poll();
    expect(h.events()).toHaveLength(1);
    h.draft.text = '[Image #1]';
    await h.poll();
    await h.poll();
    expect(h.events().map(e => e.count)).toEqual([0, 1]);
    expect(h.fill).toHaveBeenCalledTimes(1);
    h.draft.text = '[Image #1] [Image #2]';
    await h.poll();
    expect(h.fill).toHaveBeenLastCalledWith({ text: ' images @"/cache/file.txt" ', mode: 'append' });
    expect(h.draft.text).toBe('[Image #1] [Image #2] images @"/cache/file.txt" ');
    expect(h.events().map(e => [e.type, e.count])).toEqual([
      ['input_images', 0], ['input_images', 1], ['input_images', 2], ['input_ready', undefined],
    ]);
    await h.poll();
    expect(h.fill).toHaveBeenCalledTimes(2);
  });

  it('keeps image readiness scoped to inserted input and does not restage the main prompt', async () => {
    const options: Record<string, any> = { active: true, inputId: 'main', terminalText: 'main' };
    const h = await inputHarness(options);
    await h.poll();
    h.draft.text = '';
    options.insertion = { inputId: 'insert', imageCount: 1 };
    await h.poll();
    await h.poll();
    h.draft.text = '[Image #3]';
    await h.poll();
    expect(h.events().slice(-3)).toEqual([
      { protocol: 1, type: 'input_images', runId: 'main', id: 'insert', count: 0 },
      { protocol: 1, type: 'input_images', runId: 'main', id: 'insert', count: 1 },
      { protocol: 1, type: 'input_ready', runId: 'main', id: 'insert' },
    ]);
    h.draft.text = '';
    delete options.insertion;
    await h.poll();
    expect(h.draft.text).toBe('');
    expect(h.fill).toHaveBeenCalledTimes(3);
    options.inputId = options.terminalText = 'next';
    options.imageCount = 1;
    await h.poll();
    await h.poll();
    h.draft.text = '[Image #4]';
    await h.poll();
    expect(h.events().slice(-1)[0]).toEqual({ protocol: 1, type: 'input_ready', runId: 'next', id: 'next' });
  });

  it('retries a blocked text fill without clearing or pasting the images again', async () => {
    const h = await inputHarness({ active: true, inputId: 'input', imageCount: 1 });
    await h.poll();
    await h.poll();
    h.draft.text = '[Image #1]';
    h.fill.mockResolvedValueOnce({ isFilled: false });
    await h.poll();
    expect(h.events().some(e => e.type === 'input_ready')).toBe(false);
    await h.poll();
    expect(h.draft.text).toBe('[Image #1] input ');
    expect(h.events().filter(e => e.type === 'input_images').map(e => e.count)).toEqual([0, 1]);
    expect(h.events().filter(e => e.type === 'input_ready')).toHaveLength(1);
  });

  it.each(['extra', 'removed', 'read-error'])('fails before Enter when staged images change (%s)', async (failure) => {
    const h = await inputHarness({ active: true, inputId: 'input', imageCount: 2 });
    await h.poll();
    await h.poll();
    h.draft.text = '[Image #1]';
    await h.poll();
    if (failure === 'read-error') h.read.mockRejectedValueOnce(new Error('native image input unavailable'));
    else h.draft.text = failure === 'extra' ? '[Image #1] [Image #2] [Image #3]' : '';
    await h.poll();
    expect(h.events().slice(-1)[0]).toMatchObject({ type: 'input_staging_error', runId: 'input', id: 'input', error: expect.any(String) });
    expect(h.events().some(e => e.type === 'input_ready')).toBe(false);
    await h.poll();
    expect(h.events().filter(e => e.type === 'input_staging_error')).toHaveLength(1);
  });

  it('blocks idle main and auxiliary model steps before invoking the CLI inference stream', async () => {
    const h = harness({ active: false });
    const api = { ...h.api, env: { get: async (key: string) => key === 'LOCUS_CLAUDE_TUI' ? '1' : key.endsWith('_URL') ? 'http://127.0.0.1:19200' : 'test-token' },
      session: { id: async () => 'idle-native', model: async () => 'claude-opus-5-5' } };
    await h.hooks.get('session.start')!.run(api, {}, h.next);
    const inference = vi.fn();
    for (const event of [{}, { agentId: 'background' }]) {
      const consume = async () => { for await (const _ of h.hooks.get('turn.step')!.run(api, event, inference)) { /* consume */ } };
      await expect(consume()).rejects.toThrow('Claude is idle');
    }
    expect(inference).not.toHaveBeenCalled();
  });
  it('does not refill input while an earlier input-ready receipt is pending', async () => {
    const h = harness({ active: true, inputId: 'input', terminalText: 'hello' });
    const fill = vi.fn(async () => ({ isFilled: true }));
    const api = { ...h.api, env: { get: async (key: string) => key === 'LOCUS_CLAUDE_TUI' ? '1' : key.endsWith('_URL') ? 'http://127.0.0.1:19200' : 'test-token' },
      session: { id: async () => 'session', model: async () => 'claude-opus-5-5' }, prompt: { fill } };
    await h.hooks.get('session.start')!.run(api, {}, h.next);
    let release!: (answer: any) => void;
    h.fetch.mockImplementation(async (_url, request) => JSON.parse(request.body).type === 'input_ready'
      ? await new Promise(resolve => { release = resolve; })
      : { ok: true, status: 200, text: JSON.stringify({ active: true, inputId: 'input', terminalText: 'hello' }) });
    const poll = (h.api.clock.every.mock.calls[0] as unknown as [number, () => Promise<void>])[1];
    const first = poll();
    while (!release) await Promise.resolve();
    await poll();
    expect(fill).toHaveBeenCalledTimes(1);
    release({ ok: true, status: 200, text: '{"ok":true}' });
    await first;
    await poll();
    expect(fill).toHaveBeenCalledTimes(1);
  });

  it('keeps auxiliary native rows without a checkpoint round trip while retaining user and tool-result barriers', async () => {
    const h = harness({ active: true, inputId: 'input', prompt: 'hello' });
    const api = { ...h.api, env: { get: async (key: string) => key === 'LOCUS_CLAUDE_TUI' ? '1' : key.endsWith('_URL') ? 'http://127.0.0.1:19200' : 'test-token' }, session: { id: async () => 'session', model: async () => 'claude-opus-5-5' } };
    await h.hooks.get('session.start')!.run(api, {}, h.next);
    await h.hooks.get('prompt.submit')!.run(api, { text: 'input' }, h.next);
    const append = vi.fn(async (event) => event);
    const row = { uuid: 'aux', door: 'attachment', message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'Native attachment' }] } };
    await h.hooks.get('session.append')!.run(api, row, append);
    expect(append).toHaveBeenCalledExactlyOnceWith(row);
    expect(h.fetch.mock.calls.map(call => JSON.parse(call[1].body)).filter(event => event.type === 'checkpoint')).toHaveLength(0);
    await h.hooks.get('session.append')!.run(api, { ...row, uuid: 'user', door: 'prompt' }, append);
    await h.hooks.get('session.append')!.run(api, { ...row, uuid: 'result', message: { ...row.message, content: [{ type: 'tool_result', tool_use_id: 'tool-1' }] } }, append);
    expect(h.fetch.mock.calls.map(call => JSON.parse(call[1].body)).filter(event => event.type === 'checkpoint')).toEqual([
      expect.objectContaining({ uuid: 'user', user: true }), expect.objectContaining({ uuid: 'result', results: ['tool-1'] }),
    ]);
  });

  it('registers unchanged definitions once and refuses changes to the cached schema', async () => {
    const options = { active: true, inputId: 'input', prompt: 'hello', tools: [
      { name: 'python', description: 'Run locally', input_schema: { type: 'object', properties: {} } },
      { name: 'read', description: 'Native Read', input_schema: { type: 'object' } },
    ] };
    const h = harness(options);
    const registerTool = vi.fn(async () => ({}));
    const api = { ...h.api, env: { get: async (key: string) => key === 'LOCUS_CLAUDE_TUI' ? '1' : key.endsWith('_URL') ? 'http://127.0.0.1:19200' : 'test-token' },
      session: { id: async () => 'session', model: async () => 'claude-opus-5-5' }, tool: { register: registerTool } };
    await h.hooks.get('session.start')!.run(api, {}, h.next);
    expect(registerTool).toHaveBeenCalledTimes(1); // rehydrate before native history resumes
    await h.hooks.get('prompt.submit')!.run(api, { text: 'input' }, h.next);
    await h.hooks.get('prompt.submit')!.run(api, { text: 'input' }, h.next);
    expect(registerTool).toHaveBeenCalledTimes(1);
    options.tools[0]!.description = 'Updated local tool';
    await expect(h.hooks.get('prompt.submit')!.run(api, { text: 'input' }, h.next)).rejects.toThrow('definition changed');
    expect(registerTool).toHaveBeenCalledTimes(1);
  });

  it('keeps ToolSearch enabled from the first request with no Skill catalog', async () => {
    const h = harness();
    const bootstrap = h.describeHooks.find(entry => (entry.matcher as { tool?: string })?.tool === 'TaskList')!;
    const api = { ...h.api, env: { get: async () => '1' } };
    await expect(bootstrap.run(api, { tool: 'TaskList' }, async () => ({ description: 'List tasks' })))
      .resolves.toEqual({ description: 'List tasks', isDeferred: true });
    await expect(bootstrap.run({ ...api, env: { get: async () => '0' } }, { tool: 'TaskList' }, async () => ({ description: 'List tasks' })))
      .resolves.toEqual({ description: 'List tasks' });
  });

  it('registers a late Skill delta before returning the result, without invalidating descriptions or leaking schemas', async () => {
    const definition = { name: 'skill_action', description: 'Skill tool', input_schema: { type: 'object' }, defer_loading: true };
    const h = harness({ callId: 't1', result: 'Skill loaded', toolCatalogDelta: [definition] });
    const registerTool = vi.fn(async () => ({}));
    const invalidate = vi.fn();
    const api = { ...h.api, tool: { register: registerTool }, ui: { invalidate } };
    const event = { tool: 'Read', tool_use_id: 't1', file_path: 'SKILL.md' };
    expect(await h.hooks.get('tool.call')!.run(api, event, h.next)).toEqual({ result: 'Skill loaded' });
    expect(registerTool).toHaveBeenCalledExactlyOnceWith({ name: 'skill_action', description: 'Skill tool', inputSchema: { type: 'object' } });
    expect(invalidate).not.toHaveBeenCalled();
    const describe = h.hooks.get('tool.describe')!;
    const nativeDescribe = async () => ({ description: 'Skill tool' });
    expect(await describe.run(api, { tool: 'mcp__locus__skill_action' }, nativeDescribe)).toEqual({ description: 'Skill tool', isDeferred: true });
    await h.hooks.get('tool.call')!.run(api, event, h.next);
    expect(registerTool).toHaveBeenCalledTimes(1);
    expect(await describe.run(api, { tool: 'mcp__locus__skill_action' }, nativeDescribe)).toHaveProperty('isDeferred', true);
  });

  it('samples response stop before the native consumer finishes its tools', async () => {
    const h=harness({active:true,inputId:'timing',prompt:'Sample'});
    let now=100;
    const api={...h.api,clock:{...h.api.clock,now:async()=>now},env:{get:async(key:string)=>key==='LOCUS_CLAUDE_TUI'?'1':key.endsWith('_URL')?'http://127.0.0.1:19200':'test-token'},session:{model:async()=>'claude-opus-5-5',id:async()=>'session',usage:async()=>({context:{}})}};
    await h.hooks.get('session.start')!.run(api,{},h.next);
    await h.hooks.get('prompt.submit')!.run(api,{text:'timing'},h.next);
    const usage={model:'test',output_tokens:50};
    const stream=Object.assign((async function*(){now=300;yield {kind:'text',text:'sample'};now=1100;yield {kind:'stop',usage};now=21100;})(),{result:Promise.resolve({answer:'sample',toolUses:[],usage})});
    for await(const _ of h.hooks.get('turn.step')!.run(api,{},()=>stream)){/* consume */}
    expect(h.fetch.mock.calls.map(call=>JSON.parse(call[1].body)).find(event=>event.type==='usage').timing)
      .toEqual({version:1,source:'claude-turn-step',requestStartedAtMs:100,firstOutputAtMs:300,responseStoppedAtMs:1100,resultReadyAtMs:21100,bridgeDurationMs:0,consumerPauseMs:0,outputChunks:1});
  });
  it.each([false, true])('keeps native WebSearch in the CLI and records its outcome (error=%s)', async (fails) => {
    const h=harness({active:true,inputId:'search',prompt:'Search'});
    const api={...h.api,env:{get:async(key:string)=>key==='LOCUS_CLAUDE_TUI'?'1':key.endsWith('_URL')?'http://127.0.0.1:19200':'test-token'},session:{model:async()=>'claude-opus-5-5',id:async()=>'session'}};
    await h.hooks.get('session.start')!.run(api,{},h.next);
    await h.hooks.get('prompt.submit')!.run(api,{text:'search'},h.next);
    const native=vi.fn(async()=>{if(fails)throw Error('Search endpoint unavailable');return {result:{query:'probe',results:[{tool_use_id:'web',content:[{title:'Official',url:'https://code.claude.com/'}]}],durationSeconds:1}};});
    const call=h.hooks.get('tool.call')!.run(api,{tool:'WebSearch',tool_use_id:'web',query:'probe'},native);
    if(fails)await expect(call).rejects.toThrow('Search endpoint unavailable');else await expect(call).resolves.toHaveProperty('result.query','probe');
    expect(native).toHaveBeenCalledTimes(1);
    const events=h.fetch.mock.calls.map(call=>JSON.parse(call[1].body));
    expect(events.find(event=>event.type==='tool_result')).toMatchObject({id:'web',isError:fails});
    expect(h.fetch.mock.calls.every(call=>!call[0].endsWith('/call'))).toBe(true);
    const check=vi.fn(async()=>({decision:'allow'}));
    await expect(h.hooks.get('tool.check')!.run(api,{tool:'WebSearch'},check)).resolves.toEqual({decision:'allow'});
    expect(check).toHaveBeenCalledTimes(1);
  });
  it('synchronizes the actual native task list without rerunning a mutation', async () => {
    const h=harness({active:true,inputId:'main',prompt:'Tasks'});
    const task={id:'1',subject:'Task A',description:'details',status:'completed',blocks:[],blockedBy:[]};
    const api={...h.api,env:{get:async(key:string)=>key==='LOCUS_CLAUDE_TUI'?'1':key.endsWith('_URL')?'http://127.0.0.1:19200':'test-token'},session:{model:async()=>'claude-opus-5-5',id:async()=>'session'},tool:{call:vi.fn(async(input:{tool:string})=>input.tool==='TaskList'?{result:{tasks:[task]}}:{result:{task}})}};
    await h.hooks.get('session.start')!.run(api,{},h.next);
    await h.hooks.get('prompt.submit')!.run(api,{text:'main'},h.next);
    const mutate=vi.fn(async()=>({result:{success:true}}));
    await h.hooks.get('tool.call')!.run(api,{tool:'TaskUpdate',tool_use_id:'t1',taskId:'1',status:'completed'},mutate);
    expect(mutate).toHaveBeenCalledOnce();
    expect(api.tool.call.mock.calls.map(call=>call[0].tool)).toEqual(['TaskList','TaskGet']);
    const event=h.fetch.mock.calls.map(call=>JSON.parse(call[1].body)).find(event=>event.type==='tool_result');
    expect(JSON.parse(event.output).locusTodoSnapshot).toMatchObject({version:1,tasks:[task],items:[{content:'Task A',status:'completed',priority:'medium'}]});
  });
  it.each(['error', 'result', 'return'])('preserves interrupted response text before the next answer (%s)', async (ending) => {
    const options: Record<string, any> = { active: true, inputId: 'main', prompt: 'Original request' };
    const h = harness(options);
    const api = { ...h.api, env: { get: async (key: string) => key === 'LOCUS_CLAUDE_TUI' ? '1' : key.endsWith('_URL') ? 'http://127.0.0.1:19200' : 'test-token' }, session: { model: async () => 'claude-opus-5-5', id: async () => 'session', usage: async () => ({ context: {} }) } };
    await h.hooks.get('session.start')!.run(api, {}, h.next);
    await h.hooks.get('prompt.submit')!.run(api, { text: 'main' }, h.next);
    const stream = Object.assign((async function* () {
      yield { kind: 'text', text: 'PARTIAL_BEFORE_INSERT' };
      options.insertion = { inputId: 'insert', submissionId: 'draft', prompt: 'New request' };
      await h.hooks.get('prompt.submit')!.run(api, { text: 'insert', turnId: 'old-turn' }, h.next);
      if (ending === 'error') throw new Error('interrupted');
    })(), { result: Promise.resolve({ answer: 'PARTIAL_BEFORE_INSERT', toolUses: [], usage: {} }) });
    const run = async () => { for await (const _ of h.hooks.get('turn.step')!.run(api, { turnId: 'old-turn' }, () => stream)) { /* consume */ } };
    if (ending === 'return') {
      const iterator=h.hooks.get('turn.step')!.run(api,{turnId:'old-turn'},()=>stream);
      await iterator.next();
      options.insertion={inputId:'insert',submissionId:'draft',prompt:'New request'};
      await h.hooks.get('prompt.submit')!.run(api,{text:'insert',turnId:'old-turn'},h.next);
      await iterator.return();
    } else if (ending === 'error') await expect(run()).rejects.toThrow('interrupted');
    else await run();
    const events = h.fetch.mock.calls.map(call => JSON.parse(call[1].body));
    expect(events.filter(event => event.type === 'interrupted_assistant')).toEqual([expect.objectContaining({ message: { content: [{ type: 'text', text: 'PARTIAL_BEFORE_INSERT' }] } })]);
    expect(events.some(event => event.type === 'complete')).toBe(false);
  });

  it('blocks inference when native @image expansion omitted an image', async () => {
    const h = harness({ active: true, inputId: 'input', expectedImageCount: 1, prompt: 'Inspect the image' });
    const api = { ...h.api, env: { get: async (key: string) => key === 'LOCUS_CLAUDE_TUI' ? '1' : key.endsWith('_URL') ? 'http://127.0.0.1:19200' : 'test-token' }, session: { model: async () => 'claude-opus-5-5', id: async () => 'session', messages: async () => [] } };
    await h.hooks.get('session.start')!.run(api, {}, h.next);
    await h.hooks.get('prompt.submit')!.run(api, { text: 'input' }, h.next);
    const inference = vi.fn();
    const stream = h.hooks.get('turn.step')!.run(api, {}, inference);
    await expect(stream.next()).rejects.toThrow('did not load every image');
    expect(inference).not.toHaveBeenCalled();
    expect(h.fetch.mock.calls.map(call => JSON.parse(call[1].body)).find(event => event.type === 'complete')).toMatchObject({ reason: 'error' });
  });

  it('preserves native images and rejects a partially staged attachment set', async () => {
    const options = { active: true, inputId: 'input', imageCount: 2, prompt: 'Inspect both images' };
    const h = harness(options);
    const api = { ...h.api, env: { get: async (key: string) => key === 'LOCUS_CLAUDE_TUI' ? '1' : key.endsWith('_URL') ? 'http://127.0.0.1:19200' : 'test-token' }, session: { model: async () => 'claude-opus-5-5', id: async () => 'session' } };
    await h.hooks.get('session.start')!.run(api, {}, h.next);
    const attachments = [{ type: 'image', filename: '1.png' }, { type: 'image', filename: '2.png' }];
    const next = vi.fn(async (input) => input);
    await h.hooks.get('prompt.submit')!.run(api, { text: '[Image #1] [Image #2] input', attachments }, next);
    expect(next).toHaveBeenCalledExactlyOnceWith({ text: options.prompt, attachments });
    next.mockClear();
    expect(await h.hooks.get('prompt.submit')!.run(api, { text: '[Image #1] input', attachments: attachments.slice(0, 1) }, next)).toHaveProperty('drop');
    expect(next).not.toHaveBeenCalled();
    expect(h.fetch.mock.calls.map(call => JSON.parse(call[1].body).type)).toContain('input_error');
  });

  it('acknowledges inserted input only after the native session kept its media row', async () => {
    const h = harness({ active: true, inputId: 'main', insertion: { inputId: 'insert', submissionId: 'draft', prompt: 'New direction', imageCount: 0 }, attachmentMappings: [{ path: '/cache/file.txt', label: 'C:/project/file.txt' }] });
    const api = { ...h.api, env: { get: async (key: string) => key === 'LOCUS_CLAUDE_TUI' ? '1' : key.endsWith('_URL') ? 'http://127.0.0.1:19200' : 'test-token' }, session: { model: async () => 'claude-opus-5-5', id: async () => 'session' } };
    await h.hooks.get('session.start')!.run(api, {}, h.next);
    await h.hooks.get('prompt.submit')!.run(api, { text: 'insert' }, h.next);
    expect(h.fetch.mock.calls.map(call => JSON.parse(call[1].body).type)).toContain('input_queued');
    expect(h.fetch.mock.calls.map(call => JSON.parse(call[1].body).type)).not.toContain('input_consumed');
    const media = { type: 'image', source: { type: 'base64', data: 'native-owned' } };
    const queuedRow = { uuid: 'queued-row', door: 'queue', message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'New direction /cache/file.txt' }, media] } };
    const queueNext = vi.fn(async (event) => event);
    await h.hooks.get('session.append')!.run(api, queuedRow, queueNext);
    expect(h.fetch.mock.calls.map(call => JSON.parse(call[1].body).type)).not.toContain('input_consumed');
    expect(h.fetch.mock.calls.map(call => JSON.parse(call[1].body).type)).not.toContain('checkpoint');
    expect(queueNext).toHaveBeenCalledExactlyOnceWith(queuedRow);
    const next = vi.fn(async (event) => {
      expect(h.fetch.mock.calls.map(call => JSON.parse(call[1].body).type)).not.toContain('input_consumed');
      return event;
    });
    await h.hooks.get('session.append')!.run(api, { uuid: 'row', door: 'prompt', message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'New direction /cache/file.txt' }, media] } }, next);
    expect(next.mock.calls[0]![0].message.content).toEqual([{ type: 'text', text: 'New direction C:/project/file.txt' }, media]);
    const events = h.fetch.mock.calls.map(call => JSON.parse(call[1].body));
    expect(events.find(event => event.type === 'input_consumed')).toMatchObject({ runId: 'main', id: 'draft' });
    expect(events.find(event => event.type === 'checkpoint')).toMatchObject({ uuid: 'row', user: true, submissionId: 'draft' });
  });

  it('reports the summary returned by native compaction without rewriting its messages', async () => {
    const h = harness({ active: true, inputId: 'input', prompt: 'test' });
    const api = { ...h.api, env: { get: async (key: string) => key === 'LOCUS_CLAUDE_TUI' ? '1' : key.endsWith('_URL') ? 'http://127.0.0.1:19200' : 'test-token' }, session: { model: async () => 'claude-opus-5-5', id: async () => 'session', usage: async () => ({ context: { tokens: 500 } }) } };
    await h.hooks.get('session.start')!.run(api, {}, h.next);
    await h.hooks.get('prompt.submit')!.run(api, { text: 'input' }, h.next);
    const compacted = { messages: [{ role: 'user', text: 'Native summary', toolUses: [], handle: 'opaque' }], tokensAfter: 500 };
    const next = vi.fn(async () => compacted);
    expect(await h.hooks.get('session.compact')!.run(api, { trigger: 'manual', messages: [1, 2, 3] }, next)).toBe(compacted);
    expect(h.fetch.mock.calls.map(call => JSON.parse(call[1].body)).find(event => event.type === 'compact_done')).toMatchObject({ before: 3, after: 1, summary: 'Native summary', tokens: 500 });
  });

  it('keeps synthetic CLI notices in native storage but out of conversation events', async () => {
    const h=harness({active:true,inputId:'input',prompt:'question'});
    const api={...h.api,env:{get:async(key:string)=>key==='LOCUS_CLAUDE_TUI'?'1':key.endsWith('_URL')?'http://127.0.0.1:19200':'test-token'},session:{id:async()=>'session',model:async()=>'claude-opus-5-5'}};
    await h.hooks.get('session.start')!.run(api,{},h.next);
    await h.hooks.get('prompt.submit')!.run(api,{text:'input'},h.next);
    const event={uuid:'error-row',door:'response',origin:{kind:'model',model:'<synthetic>'},message:{type:'assistant',role:'assistant',content:[{type:'text',text:'Run /model'}]}};
    const append=vi.fn(async e=>e);
    await h.hooks.get('session.append')!.run(api,event,append);
    expect(append).toHaveBeenCalledExactlyOnceWith(event);
    let events=h.fetch.mock.calls.map(call=>JSON.parse(call[1].body));
    expect(events.filter(e=>['checkpoint','assistant','text'].includes(e.type))).toEqual([]);
    expect(events.find(e=>e.type==='diagnostic')).toMatchObject({text:'Run /model'});
    // Identical text from the actual model is conversation content.
    await h.hooks.get('session.append')!.run(api,{...event,uuid:'actual-row',origin:{kind:'model',model:'claude-opus-5-5'}},append);
    events=h.fetch.mock.calls.map(call=>JSON.parse(call[1].body));
    expect(events.find(e=>e.type==='checkpoint')).toMatchObject({uuid:'actual-row',text:'Run /model'});
  });

  it('removes only the CLI environment attachment, including on resume and hook failure', async () => {
    const h = harness();
    const api = { ...h.api, env: { get: async () => '1' } };
    const hook = h.hooks.get('prompt.attachment')!;
    const remote = {type:'environment', text:'Platform: linux; cwd: /remote/terminal'};
    // This can run before session.start and can re-render old attachments on resume.
    expect(await hook.run(api, remote, h.next)).toEqual({text:null});
    expect(h.next).not.toHaveBeenCalled();
    expect(await hook.fail!(api, remote, h.next)).toEqual({text:null});
    await hook.run(api, {type:'model',text:'actual model'}, h.next);
    expect(h.next).toHaveBeenCalledOnce();
  });
  it('reports requested and returned models separately and sends per-response usage', async () => {
    const h = harness({ ok: true, active: true });
    const api = { ...h.api, env: { get: async (key: string) => key === 'LOCUS_CLAUDE_TUI' ? '1' : key.endsWith('_URL') ? 'http://127.0.0.1:19200' : 'test-token' },
      session: { model: async () => 'claude-opus-5-5', id: async () => 'session', usage: async () => ({ context: { window: 200000, tokens: 999 } }) } };
    await h.hooks.get('session.start')!.run(api, {}, h.next);
    const usage = { model: 'actual-model', input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 80, cache_creation_input_tokens: 0 };
    const stream = Object.assign((async function* () { yield { kind: 'text', text: 'answer' }; })(), {
      result: Promise.resolve({ answer: 'answer', toolUses: [], usage }),
    });
    const next = vi.fn(() => stream);
    for await (const _chunk of h.hooks.get('turn.step')!.run(api, { model: 'requested-model' }, next)) { /* consume */ }
    const events = h.fetch.mock.calls.map(call => JSON.parse(call[1].body));
    expect(events.find(event => event.type === 'step_start')).toMatchObject({ model: 'requested-model' });
    expect(events.find(event => event.type === 'usage')).toMatchObject({ usage, context: { window: 200000 } });
    expect(events.findIndex(event => event.type === 'usage')).toBeLessThan(events.findIndex(event => event.type === 'assistant'));
  });

  it('preserves the CLI-resolved model instead of sending the GUI alias upstream', async () => {
    const h = harness({ active: true, inputId: 'input-model', model: 'opus', prompt: 'hello' });
    const api = { ...h.api, env: { get: async (key: string) => key === 'LOCUS_CLAUDE_TUI' ? '1' : key.endsWith('_URL') ? 'http://127.0.0.1:19200' : 'test-token' },
      session: { model: async () => 'claude-opus-5-5', id: async () => 'session', usage: async () => ({ context: {} }) } };
    await h.hooks.get('session.start')!.run(api, {}, h.next);
    await h.hooks.get('prompt.submit')!.run(api, { text: 'input-model' }, h.next);
    const stream = Object.assign((async function* () { yield { kind: 'text', text: 'ok' }; })(),
      { result: Promise.resolve({ answer: 'ok', toolUses: [], usage: { model: 'claude-opus-5-5' } }) });
    const infer = vi.fn(() => stream);
    for await (const _ of h.hooks.get('turn.step')!.run(api, { model: 'claude-opus-5-5' }, infer)) { /* consume */ }
    expect(infer).toHaveBeenCalledExactlyOnceWith({ model: 'claude-opus-5-5' });
    expect(h.fetch.mock.calls.map(call => JSON.parse(call[1].body)).find(e => e.type === 'step_start')).toMatchObject({ model: 'claude-opus-5-5' });
  });

  it.each(['model', 'help', 'context', 'cost', 'compact'])('does not adapt /%s chat commands into conversation output', async (command) => {
    const h = harness({ active: true, inputId: 'input-model' });
    const api = { ...h.api, env: { get: async (key: string) => key === 'LOCUS_CLAUDE_TUI' ? '1' : key.endsWith('_URL') ? 'http://127.0.0.1:19200' : 'test-token' },
      session: { id: async () => 'session', model: async () => 'vendor/actual' } };
    await h.hooks.get('session.start')!.run(api, {}, h.next);
    h.next.mockClear();
    expect(await h.hooks.get('command.run')!.run(api, { command, args: '' }, h.next)).toEqual({ text: '' });
    expect(h.next).not.toHaveBeenCalled();
    const events = h.fetch.mock.calls.map(call => JSON.parse(call[1].body));
    expect(events.some(e => ['command', 'text', 'assistant'].includes(e.type))).toBe(false);
    expect(events.find(e => e.type === 'input_error')).toBeDefined();
  });

  it('runs explicit GUI compaction without emitting command text as an assistant reply', async () => {
    const h = harness({ active: true, inputId: 'compact', control: 'compact' });
    const api = { ...h.api, env: { get: async (key: string) => key === 'LOCUS_CLAUDE_TUI' ? '1' : key.endsWith('_URL') ? 'http://127.0.0.1:19200' : 'test-token' }, session: { model: async () => 'claude-opus-5-5', id: async () => 'session' } };
    await h.hooks.get('session.start')!.run(api, {}, h.next);
    h.next.mockClear();
    await h.hooks.get('command.run')!.run(api, { command: 'compact', args: '' }, h.next);
    expect(h.next).toHaveBeenCalledExactlyOnceWith({ command: 'compact', args: '' });
    const event = h.fetch.mock.calls.map(call => JSON.parse(call[1].body)).find(e => e.type === 'command');
    expect(event).toEqual({ protocol: 1, type: 'command', runId: 'compact' });
  });

  it('never executes local or native tools while compacting interrupted history', async () => {
    const h = harness({ active: true, inputId: 'compact', control: 'compact' });
    const api = { ...h.api, env: { get: async (key: string) => key === 'LOCUS_CLAUDE_TUI' ? '1' : key.endsWith('_URL') ? 'http://127.0.0.1:19200' : 'test-token' },
      session: { model: async () => 'claude-opus-5-5', id: async () => 'session' } };
    await h.hooks.get('session.start')!.run(api, {}, h.next);
    await h.hooks.get('command.run')!.run(api, { command: 'compact', args: '' }, h.next);
    h.next.mockClear();
    h.fetch.mockClear();
    for (const tool of ['Edit', 'Bash', 'mcp__locus__unity_recompile', 'TaskUpdate', 'WebSearch']) {
      expect(await h.hooks.get('tool.call')!.run(api, { tool, tool_use_id: 'interrupted' }, h.next))
        .toEqual({ deny: 'Tool execution is disabled during Locus compaction.' });
      expect(await h.hooks.get('tool.check')!.run(api, { tool, input: {} }, h.next))
        .toMatchObject({ decision: 'deny' });
    }
    expect(h.next).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('preserves the native failure reason when compaction fails', async () => {
    const h = harness();
    const next = Object.assign(vi.fn(async () => ({ skip: 'native failure' })), {
      called: true, error: { kind: 'throw', message: 'Compaction failed: request timed out' },
    });
    await h.hooks.get('session.compact')!.fail!(h.api, { trigger: 'manual' }, next);
    const error = h.fetch.mock.calls.map(call => JSON.parse(call[1].body)).find(event => event.type === 'input_error');
    expect(error.error).toContain('Compaction failed: request timed out');
  });

  it('refuses unadapted commands that could bypass the local tool guard', async () => {
    const h = harness({ inputId: 'command' });
    const api = { ...h.api, env: { get: async (key: string) => key === 'LOCUS_CLAUDE_TUI' ? '1' : key.endsWith('_URL') ? 'http://127.0.0.1:19200' : 'test-token' }, session: { model: async () => 'claude-opus-5-5', id: async () => 'session' } };
    await h.hooks.get('session.start')!.run(api, {}, h.next);
    h.next.mockClear();
    const result = await h.hooks.get('command.run')!.run(api, { command: 'export', args: 'remote-file.md' }, h.next);
    expect(result.text).toBe('');
    expect(h.next).not.toHaveBeenCalled();
    expect(h.fetch.mock.calls.map(call => JSON.parse(call[1].body).type)).toContain('command_start');
    expect((await h.hooks.get('command.run')!.fail!(api, {}, h.next)).text).toContain('未回退');
    expect(h.next).not.toHaveBeenCalled();
  });
  it('intercepts Bash with its exact ID and input without calling the original tool', async () => {
    const h = harness();
    const answer = await h.hooks.get('tool.call')!.run(h.api, { tool: 'Bash', tool_use_id: 't1', command: 'pwd', timeout: 3000 }, h.next);
    expect(answer.result.stdout).toBe('local');
    expect(h.next).not.toHaveBeenCalled();
    expect(JSON.parse(h.fetch.mock.calls[0]![1].body)).toEqual({ protocol: 1, tool: 'Bash', callId: 't1', agentId: null, input: { command: 'pwd', timeout: 3000 } });
  });

  it.each(['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'TaskOutput', 'TaskStop', 'AskUserQuestion'])('forwards %s without renaming the native tool', async (tool) => {
    const h = harness({ callId: 't1', deny: 'user rejected' });
    expect(await h.hooks.get('tool.call')!.run(h.api, { tool, tool_use_id: 't1', file_path: 'a' }, h.next)).toEqual({ deny: 'user rejected' });
    expect(h.next).not.toHaveBeenCalled();
  });

  it('keeps session bookkeeping on its existing path', async () => {
    const h = harness();
    for (const tool of ['TodoWrite', 'ToolSearch']) {
      await h.hooks.get('tool.call')!.run(h.api, { tool }, h.next);
    }
    expect(h.next).toHaveBeenCalledTimes(2);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it.each([false, true])('routes renamed Mod tools locally even before TUI startup (started=%s)', async (started) => {
    const blocks = [{ type: 'text', text: 'LOCAL' }];
    const h = harness({ callId: 't1', result: blocks });
    const api = { ...h.api, env: { get: async (key: string) => key === 'LOCUS_CLAUDE_TUI' ? '1' : key.endsWith('_URL') ? 'http://127.0.0.1:19200' : 'test-token' },
      session: { model: async () => 'claude-opus-5-5', id: async () => 'session' } };
    if (started) await h.hooks.get('session.start')!.run(api, {}, h.next);
    h.next.mockClear();
    h.fetch.mockClear();
    for (const tool of ['mcp__locus__python', 'mcp__locus__unity_execute']) {
      expect(await h.hooks.get('tool.call')!.run(api, { tool, tool_use_id: 't1', code: 'print(await locus.wait_task("t1", timeout=30))', readonly: true }, h.next)).toEqual({ result: blocks });
      const calls = h.fetch.mock.calls.filter(call => call[0].endsWith('/call'));
      const call = calls[calls.length - 1]!;
      expect(JSON.parse(call[1].body)).toMatchObject({ tool, callId: 't1', input: { code: 'print(await locus.wait_task("t1", timeout=30))', readonly: true } });
      expect(await h.hooks.get('tool.check')!.run(api, { tool }, h.next)).toMatchObject({ decision: 'deny' });
    }
    h.fetch.mockRejectedValueOnce(new Error('SSH disconnected'));
    const hook = h.hooks.get('tool.call')!;
    await expect(hook.run(api, { tool: 'mcp__locus__python', tool_use_id: 't1' }, h.next)).rejects.toThrow('SSH disconnected');
    expect(await hook.fail!(api, {}, h.next)).toMatchObject({ deny: expect.stringContaining('no fallback') });
    expect(h.next).not.toHaveBeenCalled();
  });

  it('registers Python for task control without duplicating native Read or adding a task-output tool', async () => {
    const h = harness({ active: true, inputId: 'input', prompt: 'Read the local file', tools: [
      { name: 'read', description: 'Locus read', input_schema: {} },
      { name: 'python', description: 'Locus Python', input_schema: {} },
    ] });
    const register = vi.fn(async () => ({}));
    const api = { ...h.api, env: { get: async (key: string) => key === 'LOCUS_CLAUDE_TUI' ? '1' : key.endsWith('_URL') ? 'http://127.0.0.1:19200' : 'test-token' },
      session: { model: async () => 'claude-opus-5-5', id: async () => 'session' }, tool: { register } };
    await h.hooks.get('session.start')!.run(api, {}, h.next);
    h.next.mockClear();
    await h.hooks.get('prompt.submit')!.run(api, { text: 'input' }, h.next);
    expect(register).toHaveBeenCalledExactlyOnceWith({ name: 'python', description: 'Locus Python', inputSchema: {} });
    const describe = h.hooks.get('tool.describe')!;
    expect(describe.matcher).toEqual({ tool: /^mcp__locus__/ });
    expect(await describe.run(api, { tool: 'mcp__locus__python' }, async () => ({ description: 'Locus Python', isDeferred: true })))
      .toEqual({ description: 'Locus Python', isDeferred: false });
    expect(h.next).toHaveBeenCalledExactlyOnceWith({ text: 'Read the local file' });
  });

  it('refuses unknown tools instead of executing them on the Claude host', async () => {
    const h = harness();
    expect((await h.hooks.get('tool.call')!.run(h.api, { tool: 'FutureNativeTool' }, h.next)).deny).toContain('not adapted');
    expect(h.next).not.toHaveBeenCalled();
  });

  it('does not accept a response from a different call', async () => {
    const h = harness({ callId: 'other', result: 'wrong' });
    await expect(h.hooks.get('tool.call')!.run(h.api, { tool: 'Read', tool_use_id: 't1' }, h.next)).rejects.toThrow('ID mismatch');
    expect(h.next).not.toHaveBeenCalled();
  });

  it('polls slow local results without submitting a tool twice', async () => {
    const h=harness();
    h.fetch.mockResolvedValueOnce({ok:true,status:202,text:JSON.stringify({pending:'receipt1'})});
    h.fetch.mockResolvedValueOnce({ok:true,status:202,text:JSON.stringify({pending:'receipt1'})});
    const answer=await h.hooks.get('tool.call')!.run(h.api,{tool:'Bash',tool_use_id:'t1',command:'sleep 45'},h.next);
    expect(answer.result.stdout).toBe('local');
    expect(h.fetch.mock.calls.map(call=>new URL(call[0]).pathname)).toEqual(['/call','/poll','/poll']);
    expect(JSON.parse(h.fetch.mock.calls[1]![1].body)).toEqual({protocol:1,ticket:'receipt1'});
    expect(h.next).not.toHaveBeenCalled();
  });

  it('fails closed on hook errors, and independently denies native execution', async () => {
    const h = harness();
    expect((await h.hooks.get('tool.call')!.fail!(h.api, {}, { called: false })).deny).toContain('bridge failed');
    expect(await h.hooks.get('tool.check')!.run(h.api, { tool: 'Bash' }, h.next)).toMatchObject({ decision: 'deny' });
    expect(await h.hooks.get('tool.check')!.fail!()).toMatchObject({ decision: 'deny' });
    expect(h.next).not.toHaveBeenCalled();
  });

  it('preserves an already completed passthrough result when an observer fails', async () => {
    const h = harness();
    const completed = Object.assign(vi.fn(async () => ({ result: 'already completed' })), { called: true });
    expect(await h.hooks.get('tool.call')!.fail!(h.api, {}, completed)).toEqual({ result: 'already completed' });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('handshakes without an inference request', async () => {
    const h = harness({ ok: true });
    await h.hooks.get('session.start')!.run(h.api, {}, h.next);
    expect(h.fetch.mock.calls[0]![0]).toMatch(/\/ready$/);
    expect(h.next).toHaveBeenCalledOnce();
  });
});
