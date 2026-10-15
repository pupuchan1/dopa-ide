export type Phase = 'idle' | 'working' | 'done'

export type LogEntry = {
  id: string
  at: number
  icon: string
  label: string
  status: 'run' | 'ok' | 'fail'
}

export type Step = { id: string; title: string; status: 'pending' | 'in_progress' | 'completed' }

export type Run = {
  phase: Phase
  startedAt: number
  endedAt: number
  tools: number
  log: LogEntry[]
  steps: Step[]
}

// The turn that just completed: its prompt and its answer, to find their rows.
export type Finale = { prompt: string; answer: string; toolIds: string[] }

declare module 'claude-code' {
  interface PluginState {
    'dopa-ide': { run: Run; frame: number; isAnimating: boolean; finale: Finale }
  }
}
