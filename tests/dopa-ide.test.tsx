import { expect, mock, test } from 'claude-code/testing'

// Off Windows, with the sound swallowed: a test that doesn't listen for it
// neither waits on a player nor starts a real PowerShell.
function quiet(on: Parameters<Parameters<typeof test>[1]>[1]) {
  mock.env(on, { OS: 'Linux' })
  on('audio.play', () => ({ value: undefined }) as never)
  on('audio.speak', () => ({ value: { via: 'system' } }) as never)
}
const band = (isWorking: boolean) => ({
  hasSurvey: false,
  isWorking,
  maxRows: 12,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 11 },
  view: {},
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: working shows progress and the current step, then Completed!`, async ($, on) => {
    const clock = mock.clock(on)
    quiet(on) // no real sound or PowerShell from a test

    // Stand in for the engine
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    on('turn.complete', (_$, e) => ({ text: e.answer }))
    on('tool.call', (_$, e) =>
      e.tool === 'TaskCreate'
        ? { result: { task: { id: e.tool_use_id, subject: String(e.subject) } } }
        : { result: 'ok' },
    )

    await $.turn.start({ text: 'build it', turnId: 't1' })
    await $.tool.call({ tool: 'TaskCreate', subject: 'Write the API', description: 'x', tool_use_id: 'a' })
    await $.tool.call({ tool: 'TaskCreate', subject: 'Test it', description: 'y', tool_use_id: 'b' })
    await $.tool.call({ tool: 'TaskUpdate', taskId: 'a', status: 'completed', tool_use_id: 'c' })
    await $.tool.call({ tool: 'Read', file_path: '/repo/src/app.ts', tool_use_id: 'd' })

    const working = await $.ui.mount({ plugin: 'dopa-ide', surface, component: 'AbovePrompt', props: band(true) })
    expect(await working.find({ text: /WORKING/ })).toBeDefined()
    expect(await working.find({ text: /1\/2/ })).toBeDefined()
    expect(await working.find({ text: /app\.ts を読む/ })).toBeDefined()

    await $.turn.complete({
      answer: 'done',
      durationMs: 1000,
      isAborted: false,
      turnId: 't1',
      reason: 'answer',
    })
    await clock.advance(500)

    const done = await $.ui.mount({ plugin: 'dopa-ide', surface, component: 'AbovePrompt', props: band(false) })
    expect(await done.find({ text: 'C' })).toBeDefined()
    expect(await done.find({ text: /🔧 4/ })).toBeDefined()
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: fireworks on completion, plan progress, spinner and combo`, { timeoutMs: 20000 }, async ($, on) => {
    const clock = mock.clock(on)
    quiet(on) // no real sound or PowerShell from a test
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    on('turn.complete', (_$, e) => ({ text: e.answer }))
    on('tool.call', () => ({ result: 'ok' }))
    // The engine's own drawing: the props it was handed, as text.
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>{JSON.stringify(e.props)}</Text>
    })

    await $.turn.start({ text: 'go', turnId: 't2' })
    const plan = 'mcp__ccd_turn__update_plan' as never
    await $.tool.call({
      tool: plan,
      items: [
        { content: 'one', status: 'in_progress' },
        { content: 'two', status: 'pending' },
        { content: 'three', status: 'pending' },
      ],
      tool_use_id: 'p1',
    } as never)
    await $.tool.call({ tool: plan, advance: true, tool_use_id: 'p2' } as never)

    const working = await $.ui.mount({ plugin: 'dopa-ide', surface, component: 'AbovePrompt', props: band(true) })
    expect(await working.find({ text: /1\/3/ })).toBeDefined()

    const hint = await $.ui.mount({
      plugin: 'dopa-ide',
      surface,
      component: 'PromptHint',
      props: { isDraft: false, isWorking: true, hint: 'esc to interrupt' } as never,
    })
    expect(JSON.stringify(await hint.drawn())).toMatch(/COMBO/)

    const spin = await $.ui.mount({
      plugin: 'dopa-ide',
      surface,
      component: 'Spinner',
      props: { word: 'Working', message: null, suffix: '…', mode: 'thinking' },
    })
    expect(JSON.stringify(await spin.drawn())).toMatch(/🧠/)

    await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't2', reason: 'answer' })
    await clock.advance(900)

    const done = await $.ui.mount({ plugin: 'dopa-ide', surface, component: 'AbovePrompt', props: band(false) })
    if (surface === 'desktop') {
      const svg = await done.find({ type: 'Svg' } as never)
      expect(svg).toBeDefined()
    } else {
      expect(JSON.stringify(await done.drawn())).toMatch(/[|*+✦]/)
    }

    // The show ends; the Completed! row stays.
    await clock.advance(7000)
    const after = await $.ui.mount({ plugin: 'dopa-ide', surface, component: 'AbovePrompt', props: band(false) })
    if (surface === 'desktop') expect(await after.find({ type: 'Svg' } as never)).toBeUndefined()
    expect(await after.find({ text: 'C' })).toBeDefined()
  })
}

test('completion marks this session unread in the sidebar, outside the run log', async ($, on) => {
  const clock = mock.clock(on)
  quiet(on) // no real sound or PowerShell from a test
  const calls: Record<string, unknown>[] = []
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('tool.call', (_$, e) => {
    calls.push(e as unknown as Record<string, unknown>)
    return { result: 'ok' }
  })

  await $.turn.start({ text: 'go', turnId: 't3' })
  await $.tool.call({ tool: 'Read', file_path: '/a.md', tool_use_id: 'r1' })
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't3', reason: 'answer' })
  await clock.advance(8000)

  const dots = calls.filter(c => c.tool === 'mcp__ccd_sidebar__set_unread')
  expect(dots.length).toBe(17)
  expect(dots.map(d => d.unread)).toEqual(Array.from({ length: 17 }, (_, i) => i % 2 === 0))
  for (const d of dots) expect(d.session_id).toBe('self')

  const done = await $.ui.mount({ plugin: 'dopa-ide', surface: 'desktop', component: 'AbovePrompt', props: band(false) })
  expect(await done.find({ text: /🔧 1/ })).toBeDefined()
})

test('an aborted turn leaves the dot alone', async ($, on) => {
  const calls: string[] = []
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('tool.call', (_$, e) => {
    calls.push(e.tool)
    return { result: 'ok' }
  })
  await $.turn.start({ text: 'go', turnId: 't4' })
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: true, turnId: 't4', reason: 'answer' })
  expect(calls).not.toContain('mcp__ccd_sidebar__set_unread')
})

test('a ✅ heads the title when a turn completes, and leaves when the next starts', async ($, on) => {
  const clock = mock.clock(on)
  quiet(on) // no real sound or PowerShell from a test
  let title = 'Fix the login bug'
  const sets: string[] = []
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('tool.call', (_$, e) => {
    const input = e as unknown as Record<string, unknown>
    if (e.tool === 'mcp__ccd_session_mgmt__get_session') {
      const text = JSON.stringify({ sessionId: 'local_1', title, group: null })
      return { result: text, text } as never
    }
    if (e.tool === 'mcp__ccd_session_mgmt__set_session_title') {
      title = String(input.title)
      sets.push(title)
    }
    return { result: 'ok' }
  })

  await $.turn.start({ text: 'go', turnId: 't5' })
  await clock.advance(50)
  expect(sets).toEqual([]) // nothing to take off yet

  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't5', reason: 'answer' })
  await clock.advance(5000)
  expect(title).toBe('✅ Fix the login bug')

  // Completing again does not stack marks.
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't5', reason: 'answer' })
  await clock.advance(5000)
  expect(title).toBe('✅ Fix the login bug')

  await $.turn.start({ text: 'next', turnId: 't6' })
  await clock.advance(50)
  expect(title).toBe('Fix the login bug')
  expect(sets).toEqual(['✅ Fix the login bug', 'Fix the login bug'])
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: completion lights every site, and the next prompt clears it`, { timeoutMs: 20000 }, async ($, on) => {
    const clock = mock.clock(on)
    quiet(on) // no real sound or PowerShell from a test
    const opened: string[] = []
    const closed: string[] = []
    const notified: string[] = []
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    on('turn.complete', (_$, e) => ({ text: e.answer }))
    on('tool.call', () => ({ result: 'ok' }))
    on('ui.open', (_$, e) => {
      opened.push(e.id)
      return { value: { isPlaced: true } } as never
    })
    on('ui.close', (_$, e) => {
      closed.push(e.id)
      return { value: undefined } as never
    })
    on('ui.notify', (_$, e) => {
      notified.push(String((e as unknown as { text: string }).text))
      return { value: { isSent: true, channel: 'test' } } as never
    })
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>{JSON.stringify(e.props)}</Text>
    })

    await $.turn.start({ text: 'make it shine', turnId: 't7' })
    await $.turn.complete({
      answer: 'First part.\n\nAll done here.',
      durationMs: 1000,
      isAborted: false,
      turnId: 't7',
      reason: 'answer',
    })
    await clock.advance(200)

    expect(opened).toContain('dopa-fireworks')
    expect(notified.some(t => t.includes('完了'))).toBe(true)

    const answer = await $.ui.mount({
      plugin: 'dopa-ide',
      surface,
      component: 'AssistantMessage',
      props: { text: 'All done here.', isFirstOfReply: false },
    })
    expect(await answer.find({ text: /✅ 完了/ })).toBeDefined()

    const other = await $.ui.mount({
      plugin: 'dopa-ide',
      surface,
      component: 'AssistantMessage',
      props: { text: 'Something older.', isFirstOfReply: true },
    })
    expect(await other.find({ text: /✅ 完了/ })).toBeUndefined()

    const prompt = await $.ui.mount({
      plugin: 'dopa-ide',
      surface,
      component: 'UserMessage',
      props: { text: 'make it shine', origin: { kind: 'human' } } as never,
    })
    expect(await prompt.drawn()).toMatchObject({ type: 'Box' })

    const hint = await $.ui.mount({
      plugin: 'dopa-ide',
      surface,
      component: 'PromptHint',
      props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } as never,
    })
    expect(await hint.find({ text: /完了/ })).toBeDefined()

    const mode = await $.ui.mount({ plugin: 'dopa-ide', surface, component: 'SessionMode', props: { modes: ['auto'] } })
    expect(JSON.stringify(await mode.drawn())).toMatch(/✅ 完了/)

    const pane = await $.ui.mount({
      plugin: 'dopa-ide',
      surface,
      component: 'Pane',
      requestId: 'dopa-fireworks',
      props: {
        title: '🎆 Completed!',
        isFocused: false,
        bodyColumns: 60,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 40 },
        view: {},
      } as never,
    } as never)
    if (surface === 'desktop') {
      // Docked: a portrait drawing, taller than wide, to fill the pane.
      const drawn = JSON.stringify(await pane.drawn()).replace(/\\"/g, '"')
      const m = /viewBox="0 0 (\d+) (\d+)"/.exec(drawn)
      expect(m).not.toBeNull()
      // Wide, and as tall as 40 body rows less two at 60 columns.
      expect(Number(m![1])).toBe(1680)
      expect(Number(m![2])).toBe(Math.round((420 * 38 * 2.2) / 60))
      expect(await pane.find({ text: /📐/ })).toBeUndefined()
    } else {
      expect(await pane.find({ text: /完了/ })).toBeDefined()
      expect(JSON.stringify(await pane.drawn()).length).toBeGreaterThan(200)
    }

    if (surface === 'terminal') {
      const line = await $.ui.mount({ plugin: 'dopa-ide', surface, component: 'TurnDuration', props: { word: 'Baked', durationMs: 3000 } })
      expect(JSON.stringify(await line.drawn())).toMatch(/✅ Baked/)
    }

    // The show ends: the pane closes, the hint goes back, the answer keeps its frame.
    await clock.advance(7000)
    expect(closed).toContain('dopa-fireworks')
    const calm = await $.ui.mount({
      plugin: 'dopa-ide',
      surface,
      component: 'PromptHint',
      props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } as never,
    })
    expect(await calm.find({ text: /完了/ })).toBeUndefined()
    const kept = await $.ui.mount({
      plugin: 'dopa-ide',
      surface,
      component: 'AssistantMessage',
      props: { text: 'All done here.', isFirstOfReply: false },
    })
    expect(await kept.find({ text: /✅ 完了/ })).toBeDefined()

    // The next prompt clears the marks.
    await $.turn.start({ text: 'again', turnId: 't8' })
    const cleared = await $.ui.mount({
      plugin: 'dopa-ide',
      surface,
      component: 'AssistantMessage',
      props: { text: 'All done here.', isFirstOfReply: false },
    })
    expect(await cleared.find({ text: /✅ 完了/ })).toBeUndefined()
    const mode2 = await $.ui.mount({ plugin: 'dopa-ide', surface, component: 'SessionMode', props: { modes: ['auto'] } })
    expect(JSON.stringify(await mode2.drawn())).not.toMatch(/✅ 完了/)
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the turn's tool rows blink green with the show, and sounds play`, async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, { OS: 'Linux' })
    const played: string[] = []
    const spoken: string[] = []
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    on('turn.complete', (_$, e) => ({ text: e.answer }))
    on('tool.call', () => ({ result: 'ok' }))
    on('audio.play', (_$, e) => {
      played.push(JSON.stringify(e).includes('audio/wav') ? 'audio/wav' : 'other')
      return { value: undefined } as never
    })
    on('audio.speak', (_$, e) => {
      spoken.push(String((e as unknown as { text: string }).text))
      return { value: { via: 'system' } } as never
    })
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>{JSON.stringify(e.props)}</Text>
    })

    await $.turn.start({ text: 'go', turnId: 't9' })
    await $.tool.call({ tool: 'Read', file_path: '/x.md', tool_use_id: 'mine' })
    await $.turn.complete({ answer: 'ok', durationMs: 10, isAborted: false, turnId: 't9', reason: 'answer' })
    await clock.advance(100)

    expect(played).toContain('audio/wav')
    expect(spoken.some(t => t.includes('完了'))).toBe(true)

    const row = (id: string) =>
      $.ui.mount({
        plugin: 'dopa-ide',
        surface,
        component: 'ToolUse',
        props: { tool_use_id: id, tool: 'Read', input: {}, isRunning: false, isErrored: false, isInterrupted: false },
      } as never)
    expect(await (await row('mine')).drawn()).toMatchObject({ type: 'Box' })
    expect(await (await row('older')).drawn()).toMatchObject({ type: 'Text' })

    await clock.advance(7000)
    expect(await (await row('mine')).drawn()).toMatchObject({ type: 'Text' })
  })
}

test('with sound off, completion and combos stay silent but still celebrate', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { OS: 'Linux' })
  mock.store(on, { sound: 'off' })
  const played: string[] = []
  const toasts: string[] = []
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: 'ok' }))
  on('audio.play', () => {
    played.push('play')
    return { value: undefined } as never
  })
  on('audio.speak', () => {
    played.push('speak')
    return { value: { via: 'system' } } as never
  })
  on('ui.toast', (_$, e) => {
    toasts.push(String((e as unknown as { text: string }).text))
    return { value: undefined } as never
  })

  await $.turn.start({ text: 'go', turnId: 't20' })
  for (let i = 0; i < 10; i++) await $.tool.call({ tool: 'Read', file_path: `/f${i}.md`, tool_use_id: `q${i}` })
  await $.turn.complete({ answer: 'ok', durationMs: 10, isAborted: false, turnId: 't20', reason: 'answer' })
  await clock.advance(200)

  expect(played).toEqual([])
  expect(toasts.some(t => t.includes('10 COMBO'))).toBe(true)
  expect(toasts.some(t => t.includes('Completed'))).toBe(true)
})

test('/dopa-sound turns the sound off, on, and flips it when bare', async ($, on) => {
  mock.store(on)
  const say = async (args: string) =>
    JSON.stringify(await $.command.run({ command: 'dopa-sound', args } as never))

  // Each bare flip reads what the last call stored.
  expect(await say('off')).toMatch(/OFF/)
  expect(await say('')).toMatch(/ON/)
  expect(await say('')).toMatch(/OFF/)
  expect(await say('on')).toMatch(/ON/)
  expect(await say('loud')).toMatch(/使い方/)
  expect(await say('')).toMatch(/OFF/) // the bad word changed nothing: still on, so this flips to off
})

// Records each process the mod starts.
function processes(on: Parameters<Parameters<typeof test>[1]>[1]) {
  const runs: { argv: readonly string[]; stdin?: string; env?: Record<string, string> }[] = []
  on('process.run', (_$, e) => {
    const input = e as unknown as { argv: readonly string[]; init?: { stdin?: string; env?: Record<string, string> } }
    runs.push({ argv: input.argv, stdin: input.init?.stdin, env: input.init?.env })
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  return runs
}

// The engine's stand-ins for a turn; registered before the test first calls $.
function turns(on: Parameters<Parameters<typeof test>[1]>[1]) {
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: 'ok' }))
}

async function completeOnce($: Parameters<Parameters<typeof test>[1]>[0], id: string) {
  await $.turn.start({ text: 'go', turnId: id })
  await $.turn.complete({ answer: 'ok', durationMs: 10, isAborted: false, turnId: id, reason: 'answer' })
}

const isOverlay = (r: { argv: readonly string[]; env?: Record<string, string> }) => r.env?.DOPA_TEXT !== undefined

test('on Windows, completion puts up the full-screen overlay, silently and in STA', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { OS: 'Windows_NT', SystemRoot: 'C:\\Windows' })
  const runs = processes(on)
  turns(on)
  await completeOnce($, 't30')
  await clock.advance(100)

  const overlay = runs.find(isOverlay)
  expect(overlay).toBeDefined()
  expect(overlay!.argv).toContain('-STA')
  expect(overlay!.argv).toContain('-EncodedCommand')
  expect(overlay!.stdin).toBeUndefined()
  expect(overlay!.env!.DOPA_TEXT.length).toBeGreaterThan(0)
})

test('/dopa-overlay off keeps the overlay away, and the sound still plays', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { OS: 'Windows_NT', SystemRoot: 'C:\\Windows' })
  mock.store(on)
  const runs = processes(on)
  turns(on)
  const said = JSON.stringify(await $.command.run({ command: 'dopa-overlay', args: 'off' } as never))
  expect(said).toMatch(/OFF/)

  await completeOnce($, 't31')
  await clock.advance(100)
  expect(runs.some(isOverlay)).toBe(false)
  expect(runs.some(r => r.stdin !== undefined)).toBe(true) // the fanfare
})

test('off Windows there is no overlay to start', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { OS: 'Linux' })
  const runs = processes(on)
  on('audio.play', () => ({ value: undefined }) as never)
  on('audio.speak', () => ({ value: { via: 'system' } }) as never)
  turns(on)
  await completeOnce($, 't32')
  await clock.advance(100)
  expect(runs.some(isOverlay)).toBe(false)
})

// A stand-in app for the title tools: `failSets` refusals before it keeps one.
function titleApp(on: Parameters<Parameters<typeof test>[1]>[1], start: string, failSets = 0) {
  const app = { title: start, sets: 0, failSets }
  on('tool.call', (_$, e) => {
    const input = e as unknown as Record<string, unknown>
    if (e.tool === 'mcp__ccd_session_mgmt__get_session') {
      const text = JSON.stringify({ sessionId: 'local_1', title: app.title })
      return { result: text, text } as never
    }
    if (e.tool === 'mcp__ccd_session_mgmt__set_session_title') {
      app.sets++
      if (app.failSets > 0) {
        app.failSets--
        return { deny: 'busy' } as never
      }
      app.title = String(input.title)
    }
    return { result: 'ok' }
  })
  return app
}

test('sending the next prompt takes every ✅ off at once', async ($, on) => {
  const clock = mock.clock(on)
  quiet(on) // no real sound or PowerShell from a test
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  const app = titleApp(on, '✅ ✅️ My work')

  await $.prompt.submit({ text: 'next', wait: false } as never)
  await clock.advance(50)
  expect(app.title).toBe('My work')
})

test('a refused removal is tried again, and the result is in the log', async ($, on) => {
  const clock = mock.clock(on)
  quiet(on) // no real sound or PowerShell from a test
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  const app = titleApp(on, '✅ My work', 2)

  await $.turn.start({ text: 'next', turnId: 't10' })
  await clock.advance(5000)
  expect(app.title).toBe('My work')
  expect(app.sets).toBe(3)

  const band = await $.ui.mount({
    plugin: 'dopa-ide',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: true, maxRows: 12, bodyColumns: 100, scroll: { offset: 0, bodyRows: 11 }, view: {} },
  })
  expect(JSON.stringify(await band.drawn())).toMatch(/タイトルの ✅ を外す/)
})

test('a removal that never goes through says so', async ($, on) => {
  const clock = mock.clock(on)
  quiet(on) // no real sound or PowerShell from a test
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  const app = titleApp(on, '✅ My work', 99)

  await $.turn.start({ text: 'next', turnId: 't11' })
  await clock.advance(10000)
  expect(app.title).toBe('✅ My work')
  expect(app.sets).toBe(4)

  const band = await $.ui.mount({
    plugin: 'dopa-ide',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: true, maxRows: 12, bodyColumns: 100, scroll: { offset: 0, bodyRows: 11 }, view: {} },
  })
  expect(JSON.stringify(await band.drawn())).toMatch(/✅ を外す: busy/)
})

test('a quick turn never leaves its ✅ crossed with the next removal', async ($, on) => {
  const clock = mock.clock(on)
  quiet(on) // no real sound or PowerShell from a test
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  const app = titleApp(on, 'My work')

  await $.turn.start({ text: 'a', turnId: 't12' })
  await $.turn.complete({ answer: 'ok', durationMs: 10, isAborted: false, turnId: 't12', reason: 'answer' })
  await $.prompt.submit({ text: 'b', wait: false } as never)
  await clock.advance(3000)
  expect(app.title).toBe('My work')
})


test('on Windows the fanfare and the voice go through PowerShell, from standard input', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { OS: 'Windows_NT', SystemRoot: 'C:\\Windows' })
  const runs: { argv: readonly string[]; stdin?: string; env?: Record<string, string> }[] = []
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: 'ok' }))
  on('process.run', (_$, e) => {
    const input = e as unknown as { argv: readonly string[]; init?: { stdin?: string; env?: Record<string, string> } }
    runs.push({ argv: input.argv, stdin: input.init?.stdin, env: input.init?.env })
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })

  await $.turn.start({ text: 'go', turnId: 't13' })
  await $.turn.complete({ answer: 'ok', durationMs: 10, isAborted: false, turnId: 't13', reason: 'answer' })
  await clock.advance(100)

  // Spelled out part by part, so a lost backslash cannot pass. The clip is the run fed on stdin.
  const exe = ['C:', 'Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'].join(String.fromCharCode(92))
  const ps = runs.find(r => r.argv[0] === exe && r.stdin !== undefined)
  expect(ps).toBeDefined()
  expect(ps!.argv).toContain('-EncodedCommand')
  expect(ps!.stdin?.startsWith('UklGR')).toBe(true) // base64 of "RIFF"
  expect(ps!.env?.DOPA_SAY).toMatch(/完了/)
})
