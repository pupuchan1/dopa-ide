import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Finale, LogEntry, Phase, Run, Step } from '../types'

// ---- state -------------------------------------------------------------

const EMPTY: Run = { phase: 'idle', startedAt: 0, endedAt: 0, tools: 0, log: [], steps: [] }

const run = atom({ plugin: 'dopa-ide', key: 'run' } as const, EMPTY)
const frame = atom({ plugin: 'dopa-ide', key: 'frame' } as const, 0)
const isAnimating = atom({ plugin: 'dopa-ide', key: 'isAnimating' } as const, false)
const finale = atom({ plugin: 'dopa-ide', key: 'finale' } as const, { prompt: '', answer: '', toolIds: [] } as Finale)

const PANE = 'dopa-log'
const FIREWORKS_PANE = 'dopa-fireworks'
const BLINK_MS = 500
const RAINBOW_MS = 90
const RAINBOW_FOR_MS = 6000
const HOVER_ROWS = 8
const FIREWORK_ROWS = 8
const CELL_ASPECT = 2.2 // a desktop cell's height over its width
const DOCK_WIDTH = 1680 // the docked drawing's width; its height follows the rows
const COMBO_AT = [10, 25, 50, 100]

// The one timer that drives blinking or the rainbow; reset on reload.
let timer: Timer | undefined

function stopTimer() {
  timer?.cancel()
  timer = undefined
}

// ---- pure helpers (no $) -----------------------------------------------

function hsl(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

function rainbow(text: string, shift: number): { ch: string; color: string }[] {
  return [...text].map((ch, i) => ({ ch, color: hsl((i * 32 + shift * 24) % 360, 1, 0.6) }))
}

function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function base(path: unknown): string {
  return typeof path === 'string' ? path.split('/').pop() || path : ''
}

function cut(text: unknown, n: number): string {
  const s = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

function describe(tool: string, input: Record<string, unknown>): { icon: string; label: string } {
  if (tool.endsWith('update_plan')) return { icon: '📋', label: 'タスクリスト更新' }
  switch (tool) {
    case 'Read':
      return { icon: '📖', label: `${base(input.file_path)} を読む` }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { icon: '📝', label: `${base(input.file_path ?? input.notebook_path)} を編集` }
    case 'Write':
      return { icon: '✍️', label: `${base(input.file_path)} を書く` }
    case 'Bash':
      return { icon: '💻', label: cut(input.description || input.command, 48) }
    case 'Grep':
    case 'Glob':
      return { icon: '🔍', label: `${cut(input.pattern, 40)} を検索` }
    case 'WebSearch':
      return { icon: '🌐', label: `「${cut(input.query, 36)}」を検索` }
    case 'WebFetch':
      return { icon: '🌐', label: cut(input.url, 48) }
    case 'Agent':
    case 'Task':
      return { icon: '🤖', label: `サブエージェント: ${cut(input.description, 36)}` }
    case 'TaskCreate':
      return { icon: '📋', label: `タスク追加: ${cut(input.subject, 36)}` }
    case 'TaskUpdate':
      return { icon: '📋', label: `タスク更新 → ${String(input.status ?? '')}` }
    case 'TodoWrite':
      return { icon: '📋', label: 'ToDoリスト更新' }
    default:
      return { icon: '🔧', label: tool }
  }
}

function progress(steps: Step[]): { done: number; total: number; bar: string } | null {
  if (steps.length === 0) return null
  const done = steps.filter(s => s.status === 'completed').length
  const width = 12
  const filled = Math.round((done / steps.length) * width)
  return { done, total: steps.length, bar: '█'.repeat(filled) + '░'.repeat(width - filled) }
}

// The desktop app's task list (update_plan): a whole list, or advance / done / start.
function applyPlan(steps: Step[], input: Record<string, unknown>): Step[] {
  const items = input.items as { content?: string; status?: Step['status'] }[] | undefined
  if (Array.isArray(items)) {
    return items.map((t, i) => ({ id: `plan-${i}`, title: String(t.content ?? ''), status: t.status ?? 'pending' }))
  }
  let next = steps.map(s => ({ ...s }))
  if (input.advance === true) {
    const at = next.findIndex(s => s.status === 'in_progress')
    if (at >= 0) next[at].status = 'completed'
    const pending = next.findIndex(s => s.status === 'pending')
    if (pending >= 0) next[pending].status = 'in_progress'
  }
  if (Array.isArray(input.done)) {
    for (const k of input.done as number[]) if (next[k - 1]) next[k - 1].status = 'completed'
  }
  if (typeof input.start === 'number' && next[input.start - 1]) {
    next = next.map(s => (s.status === 'in_progress' ? { ...s, status: 'pending' as const } : s))
    next[input.start - 1].status = 'in_progress'
  }
  return next
}

// A small seeded random, so each completion gets its own show.
function rng(seed: number): () => number {
  let s = (seed >>> 0) || 1
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

// Desktop: one SVG the sandboxed frame animates by itself with CSS, no ticks.
// Two waves of bursts with shock rings, confetti falling through, and a
// glowing COMPLETED! in the middle.
function fireworksSvg(seed: number, size: { width: number; height: number } = { width: 800, height: 220 }): string {
  const W = Math.round(size.width)
  const H = Math.round(size.height)
  const P = 2.6 // seconds per cycle
  const fontSize = Math.round(Math.min(46, W / 10.5))
  const rand = rng(seed)
  const css: string[] = [
    `.p{animation:burst ${P}s ease-out infinite;opacity:0}`,
    '@keyframes burst{0%,28%{transform:translateX(0);opacity:0}30%{opacity:1}70%{opacity:.95}100%{transform:translateX(var(--r));opacity:0}}',
    `.fall{animation:fall ${P}s ease-in infinite}`,
    '@keyframes fall{0%,28%{transform:translateY(0)}100%{transform:translateY(26px)}}',
    `.ring{animation:ring ${P}s ease-out infinite;opacity:0;fill:none;stroke-width:3}`,
    '@keyframes ring{0%,28%{r:2;opacity:0}30%{opacity:.9}60%{opacity:0}100%{r:var(--r);opacity:0}}',
    `.flash{animation:flash ${P}s ease-out infinite;opacity:0}`,
    '@keyframes flash{0%,28%{opacity:0}30%{opacity:.35}45%,100%{opacity:0}}',
    '.c{animation:conf linear infinite}',
    `@keyframes conf{0%{transform:translateY(-20px) rotate(0)}100%{transform:translateY(${H + 20}px) rotate(720deg)}}`,
    `.title{animation:pulse 1.2s ease-in-out infinite;transform-origin:${W / 2}px ${H / 2}px}`,
    '@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.08)}}',
    '.hue{animation:hue 2s linear infinite}',
    '@keyframes hue{to{filter:hue-rotate(360deg)}}',
  ]
  const parts: string[] = []
  // As many bursts as the area holds, in two waves, spread over all of it.
  const bursts = Math.max(6, Math.min(26, Math.round((W * H) / 17600) * 2))
  const perWave = Math.ceil(bursts / 2)
  for (let b = 0; b < bursts; b++) {
    const wave = b % 2
    const slot = b >> 1
    const x = Math.round(40 + ((slot + 0.5) / perWave) * (W - 80) + (rand() - 0.5) * 60)
    const y = Math.round(30 + rand() * Math.max(70, H * 0.72 - 30))
    const hue = Math.round(rand() * 360)
    const delay = (wave * P * 0.5 + ((slot * 0.18) % (P * 0.5)) + rand() * 0.15).toFixed(2)
    const r = Math.round(40 + rand() * 38)
    const color = hsl(hue, 1, 0.62)
    const glow = hsl((hue + 50) % 360, 1, 0.78)
    css.push(
      `@keyframes rk${b}{0%{transform:translateY(${H - y}px);opacity:1}28%{transform:translateY(0);opacity:1}29%,100%{opacity:0}}`,
    )
    const sparks: string[] = []
    const count = 22
    for (let i = 0; i < count; i++) {
      const angle = Math.round((360 / count) * i + rand() * 8)
      const rr = i % 2 === 0 ? r : Math.round(r * 0.6)
      sparks.push(
        `<g transform="rotate(${angle})"><circle class="p" r="${i % 2 === 0 ? 3 : 2}" fill="${i % 3 === 0 ? glow : color}" style="--r:${rr}px;animation-delay:${delay}s"/></g>`,
      )
    }
    parts.push(
      `<g transform="translate(${x} ${y})">` +
        `<circle r="2.6" fill="#FFF3B0" style="animation:rk${b} ${P}s ease-out infinite;animation-delay:${delay}s;opacity:0"/>` +
        `<circle class="flash" r="${r}" fill="${glow}" style="animation-delay:${delay}s"/>` +
        `<circle class="ring" stroke="${glow}" style="--r:${r + 14}px;animation-delay:${delay}s"/>` +
        `<g class="fall" style="animation-delay:${delay}s">${sparks.join('')}</g>` +
        `</g>`,
    )
  }
  const confetti: string[] = []
  for (let i = 0; i < Math.max(30, Math.round((W * H) / 3800)); i++) {
    const x = Math.round(rand() * W)
    const color = hsl(Math.round(rand() * 360), 0.95, 0.6)
    const dur = (2.2 + rand() * 2.2).toFixed(2)
    const delay = (-rand() * 4).toFixed(2)
    confetti.push(
      `<g transform="translate(${x} 0)"><rect class="c" x="-3" y="-2" width="${4 + Math.round(rand() * 5)}" height="${3 + Math.round(rand() * 3)}" fill="${color}" style="animation-duration:${dur}s;animation-delay:${delay}s"/></g>`,
    )
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
    `<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#FF4D6D"/><stop offset=".25" stop-color="#FFD400"/><stop offset=".5" stop-color="#22C55E"/><stop offset=".75" stop-color="#38BDF8"/><stop offset="1" stop-color="#A855F7"/></linearGradient>` +
    `<filter id="glow" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>` +
    `<radialGradient id="sky" cx=".5" cy="1" r="1"><stop offset="0" stop-color="#1B1F3A"/><stop offset="1" stop-color="#05060D"/></radialGradient></defs>` +
    `<style>${css.join('')}</style>` +
    `<rect width="${W}" height="${H}" fill="url(#sky)" rx="12"/>` +
    parts.join('') +
    confetti.join('') +
    `<g class="title"><text class="hue" x="${W / 2}" y="${Math.round(H / 2 + fontSize * 0.35)}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="${fontSize}" font-weight="900" fill="url(#g)" filter="url(#glow)" letter-spacing="${Math.round(fontSize / 12)}">✨ COMPLETED! ✨</text></g>` +
    `</svg>`
  )
}

type Cell = { ch: string; color: string }

// Terminal: the same idea in characters, one frame per tick.
function fireworksRows(n: number, columns: number, rows: number, seed: number): Cell[][] {
  const grid: (Cell | undefined)[][] = Array.from({ length: rows }, () => Array<Cell | undefined>(columns).fill(undefined))
  const put = (x: number, y: number, cell: Cell) => {
    if (y >= 0 && y < rows && x >= 0 && x < columns) grid[y][x] = cell
  }
  const PERIOD = 22
  const bursts = Math.max(2, Math.min(5, Math.floor(columns / 18)))
  for (let b = 0; b < bursts; b++) {
    const start = b * 5
    if (n < start) continue
    const t = (n - start) % PERIOD
    const cycle = Math.floor((n - start) / PERIOD)
    const rand = rng(seed + b * 97 + cycle * 7919)
    const x = Math.round(((b + 0.5) / bursts) * columns + (rand() - 0.5) * 8)
    const cy = 1 + Math.floor(rand() * 2)
    const hue = Math.round(rand() * 360)
    if (t < 5) {
      const y = Math.round(rows - 1 - (t / 5) * (rows - 1 - cy))
      put(x, y, { ch: '|', color: '#FFE45C' })
      put(x, y + 1, { ch: '.', color: '#8A7300' })
      continue
    }
    const age = t - 5
    if (age > 12) continue
    const radius = age * 0.55
    const drop = Math.floor((age * age) / 60)
    const light = Math.max(0.3, 0.7 - age * 0.03)
    const ch = age < 4 ? '*' : age < 8 ? '+' : '·'
    for (let i = 0; i < 12; i++) {
      const a = (Math.PI * 2 * i) / 12
      put(Math.round(x + Math.cos(a) * radius * 2), Math.round(cy + Math.sin(a) * radius) + drop, {
        ch,
        color: hsl((hue + i * 8) % 360, 1, light),
      })
    }
    if (age < 3) put(x, cy, { ch: '✦', color: '#FFFFFF' })
  }
  return grid.map(row => row.map(c => c ?? { ch: ' ', color: '' }))
}

// Runs of one color, so a row is a handful of Texts and not one per cell.
function spans(row: Cell[]): Cell[] {
  const out: Cell[] = []
  for (const c of row) {
    const last = out[out.length - 1]
    if (last && last.color === c.color) last.ch += c.ch
    else out.push({ ...c })
  }
  return out
}

// Green on and off, about three times a second at the rainbow's frame rate.
function green(n: number): string {
  return Math.floor(n / 4) % 2 === 0 ? '#22C55E' : '#14532D'
}

// The last block of the answer is the row that closes the turn.
function isAnswerTail(text: string, answer: string): boolean {
  const t = text.trim()
  return t.length > 0 && answer.trim().endsWith(t)
}

// ---- sound: synthesized here, so the mod ships no audio file ------------

const RATE = 16000
const FANFARE_GAIN = 2 // 0 to 4; how hard the fanfare is driven (1: as made)
const SAY = 'おつかれさま！完了しました'
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const t = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out +=
      B64[(t >> 18) & 63] +
      B64[(t >> 12) & 63] +
      (i + 1 < bytes.length ? B64[(t >> 6) & 63] : '=') +
      (i + 2 < bytes.length ? B64[t & 63] : '=')
  }
  return out
}

// 16-bit mono PCM in a WAV header, as base64. `drive` above 1 saturates the
// waveform (tanh) so it sounds louder at the same peak: Windows' player has
// no volume of its own.
function wav(samples: Float32Array, drive = 1): string {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const v = new DataView(bytes.buffer)
  const tag = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)))
  tag(0, 'RIFF')
  v.setUint32(4, 36 + samples.length * 2, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, RATE, true)
  v.setUint32(28, RATE * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  tag(36, 'data')
  v.setUint32(40, samples.length * 2, true)
  let peak = 0
  for (const x of samples) peak = Math.max(peak, Math.abs(x))
  const scale = peak > 0 ? 1 / peak : 1
  const shape = drive > 1 ? (x: number) => Math.tanh(x * drive) / Math.tanh(drive) : (x: number) => x
  samples.forEach((x, i) => v.setInt16(44 + i * 2, Math.round(shape(x * scale) * 0.92 * 32767), true))
  return base64(bytes)
}

function chime(out: Float32Array, at: number, freq: number, gain: number, decay: number) {
  const start = Math.round(at * RATE)
  for (let i = start; i < out.length; i++) {
    const t = (i - start) / RATE
    const env = Math.exp(-t * decay) * Math.min(1, t * 400)
    if (env < 0.001) break
    out[i] += gain * env * (Math.sin(2 * Math.PI * freq * t) + 0.3 * Math.sin(4 * Math.PI * freq * t))
  }
}

// Three rockets whistle up and boom one after another, crackles rain down,
// and a fanfare climbs to a ringing chord.
function fanfareSamples(): Float32Array {
  const out = new Float32Array(Math.round(RATE * 3.8))
  const rand = rng(7)
  const rockets = [
    { at: 0, from: 700, to: 2300 },
    { at: 0.28, from: 900, to: 2700 },
    { at: 0.56, from: 600, to: 2000 },
  ]
  for (const r of rockets) {
    let phase = 0
    const start = Math.round(r.at * RATE)
    for (let i = 0; i < RATE * 0.42; i++) {
      const t = i / RATE
      phase += (2 * Math.PI * (r.from + (t / 0.42) * (r.to - r.from))) / RATE
      out[start + i] += 0.14 * Math.sin(phase) * (t / 0.42) + 0.03 * (rand() * 2 - 1)
    }
    // the boom: low noise and a thump under it
    const boom = start + Math.round(RATE * 0.44)
    let low = 0
    for (let i = boom; i < out.length; i++) {
      const t = (i - boom) / RATE
      const env = Math.exp(-t * 4.5)
      if (env < 0.002) break
      low += (rand() * 2 - 1 - low) * 0.09
      out[i] += low * env * 2.2 + 0.7 * Math.sin(2 * Math.PI * (70 - t * 30) * t) * Math.exp(-t * 7)
    }
  }
  for (let i = Math.round(RATE * 0.6); i < out.length - 40; i++) {
    if (rand() < 0.007) {
      const g = (rand() * 0.4 + 0.12) * Math.exp(-(i / RATE - 0.6) * 0.9)
      for (let k = 0; k < 40; k++) out[i + k] += g * (rand() * 2 - 1) * Math.exp(-k / 7)
    }
  }
  // fanfare: up the arpeggio twice, then the chord rings out
  ;[1046.5, 1318.5, 1568, 2093].forEach((f, k) => chime(out, 0.6 + k * 0.08, f, 0.17, 4))
  ;[1568, 2093, 2637, 3136].forEach((f, k) => chime(out, 1.05 + k * 0.08, f, 0.17, 4))
  ;[1046.5, 1318.5, 1568, 2093, 2637].forEach(f => chime(out, 1.5, f, 0.14, 1.3))
  return out
}

function pipSamples(): Float32Array {
  const out = new Float32Array(Math.round(RATE * 0.35))
  chime(out, 0, 1568, 0.3, 14)
  chime(out, 0.08, 2093, 0.3, 10)
  return out
}

let fanfare: string | undefined
let pip: string | undefined

// Windows: the engine's player plays nothing there, so PowerShell plays the
// clip from standard input with the system's SoundPlayer, then speaks with
// the system voice (Japanese where one is installed). No file is written.
const WIN_PLAYER = [
  "$ErrorActionPreference = 'Stop'",
  '$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
  '$player = New-Object System.Media.SoundPlayer (New-Object System.IO.MemoryStream (,$bytes))',
  '$player.PlaySync()',
  'if ($env:DOPA_SAY) {',
  '  Add-Type -AssemblyName System.Speech',
  '  $voice = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  "  try { $voice.SelectVoiceByHints('NotSet', 'NotSet', 0, [Globalization.CultureInfo]'ja-JP') } catch {}",
  '  $voice.Volume = 100',
  '  $voice.Speak($env:DOPA_SAY)',
  '}',
].join('\n')

// Windows: a borderless, see-through, topmost window over the whole primary
// screen for about two seconds: confetti falling, a frame cycling through the
// rainbow, and a line of text in the middle. It never takes the focus, and it
// makes no sound of its own (the fanfare is the sound).
const OVERLAY_TEXT = 'Claude 返信きたよ！'
const WIN_OVERLAY = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

$w = New-Object System.Windows.Window
$w.WindowStyle = 'None'
$w.AllowsTransparency = $true
$w.Background = [System.Windows.Media.Brushes]::Transparent
$w.Topmost = $true
$w.ShowInTaskbar = $false
$w.ShowActivated = $false
$w.Left = 0; $w.Top = 0
$sw = [System.Windows.SystemParameters]::PrimaryScreenWidth
$sh = [System.Windows.SystemParameters]::PrimaryScreenHeight
$w.Width = $sw; $w.Height = $sh

$grid = New-Object System.Windows.Controls.Grid
$border = New-Object System.Windows.Controls.Border
$border.BorderThickness = 18
$grid.Children.Add($border) | Out-Null
$canvas = New-Object System.Windows.Controls.Canvas
$grid.Children.Add($canvas) | Out-Null

$label = New-Object System.Windows.Controls.TextBlock
$label.Text = $env:DOPA_TEXT
$label.FontSize = 64
$label.FontWeight = 'Bold'
$label.Foreground = [System.Windows.Media.Brushes]::White
$label.HorizontalAlignment = 'Center'
$label.VerticalAlignment = 'Center'
$label.Effect = New-Object System.Windows.Media.Effects.DropShadowEffect
$grid.Children.Add($label) | Out-Null
$w.Content = $grid

$colors = '#E24B4A','#EF9F27','#1D9E75','#378ADD','#7F77DD','#D4537E'
$brushes = $colors | ForEach-Object { New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString($_)) }
$rand = New-Object System.Random
$confetti = @()
for ($i = 0; $i -lt 120; $i++) {
  $r = New-Object System.Windows.Shapes.Rectangle
  $r.Width = 10; $r.Height = 16
  $r.Fill = $brushes[$i % 6]
  [System.Windows.Controls.Canvas]::SetLeft($r, $rand.NextDouble() * $sw)
  [System.Windows.Controls.Canvas]::SetTop($r, -$rand.NextDouble() * $sh * 0.5)
  $canvas.Children.Add($r) | Out-Null
  $confetti += [pscustomobject]@{ R = $r; VY = 8 + $rand.NextDouble() * 10; VX = ($rand.NextDouble() - 0.5) * 6 }
}

$script:tick = 0
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(30)
$timer.Add_Tick({
  $script:tick++
  $border.BorderBrush = $brushes[[int]($script:tick / 4) % 6]
  foreach ($p in $confetti) {
    [System.Windows.Controls.Canvas]::SetTop($p.R, [System.Windows.Controls.Canvas]::GetTop($p.R) + $p.VY)
    [System.Windows.Controls.Canvas]::SetLeft($p.R, [System.Windows.Controls.Canvas]::GetLeft($p.R) + $p.VX)
  }
  if ($script:tick -gt 50) { $w.Opacity = [Math]::Max(0, 1 - ($script:tick - 50) / 15) }
  if ($script:tick -gt 65) { $timer.Stop(); $w.Close() }
})
$w.Add_ContentRendered({ $timer.Start() })
$w.ShowDialog() | Out-Null
`

function utf16le(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length * 2)
  for (let i = 0; i < text.length; i++) {
    bytes[i * 2] = text.charCodeAt(i) & 255
    bytes[i * 2 + 1] = text.charCodeAt(i) >> 8
  }
  return bytes
}

let isWindows: boolean | undefined
let isSoundWarned = false

// By its full path: powershell.exe is not always on PATH.
async function powershellPath($: EngineInterface): Promise<string> {
  const root = (await $.env.get('SystemRoot')) ?? 'C:\\Windows'
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
}

async function playClip($: EngineInterface, clip: string, gain: number, say?: string) {
  isWindows ??= (await $.env.get('OS')) === 'Windows_NT'
  if (isWindows) {
    const ran = await $.process.run(
      [await powershellPath($), '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', base64(utf16le(WIN_PLAYER))],
      { stdin: clip, env: { DOPA_SAY: say ?? '' }, timeoutMs: 30000 },
    )
    if (ran.exitCode !== 0) throw new Error(cut(ran.stderr || `exit ${ran.exitCode}`, 80))
    return
  }
  await $.audio.play({ base64: clip, mime: 'audio/wav' }, { gain })
  if (say) await $.audio.speak(say)
}

function soundFailed($: EngineInterface, err: unknown) {
  if (isSoundWarned) return
  isSoundWarned = true
  $.ui.toast(`🔇 音を鳴らせませんでした: ${cut(err instanceof Error ? err.message : String(err), 80)}`)
}

// Switches kept in the plugin's store across sessions; each is on until turned off.
const SOUND_KEY = 'sound'
const OVERLAY_KEY = 'overlay'

async function isOn($: EngineInterface, key: string): Promise<boolean> {
  try {
    return (await $.store.get(key)) !== 'off'
  } catch {
    return true // a store that can't be read leaves the switch as it was made: on
  }
}

const isSoundOn = ($: EngineInterface) => isOn($, SOUND_KEY)

// `/<command> on`, `/<command> off`, or bare `/<command>` to flip it.
async function toggle(
  $: EngineInterface,
  key: string,
  args: string,
  say: { command: string; on: string; off: string },
): Promise<string> {
  const word = args.trim().toLowerCase()
  if (word !== '' && word !== 'on' && word !== 'off') {
    return `使い方: /${say.command} on | off（何も付けなければ切り替え）`
  }
  const isNowOn = word === '' ? !(await isOn($, key)) : word === 'on'
  await $.store.set(key, isNowOn ? 'on' : 'off')
  return isNowOn ? say.on : say.off
}

const setSound = ($: EngineInterface, args: string) =>
  toggle($, SOUND_KEY, args, {
    command: 'dopa-sound',
    on: '🔊 dopa-ide の音を ON にしました',
    off: '🔇 dopa-ide の音を OFF にしました（見た目の演出はそのまま）',
  })

const setOverlay = ($: EngineInterface, args: string) =>
  toggle($, OVERLAY_KEY, args, {
    command: 'dopa-overlay',
    on: '🎊 完了時の全画面演出を ON にしました（Windows のみ）',
    off: '🙈 完了時の全画面演出を OFF にしました（画面共有中などに）',
  })

// Built and played on a timer, so the hook that asks never waits for the synth.
function playFanfare($: EngineInterface) {
  $.clock.after(0, async () => {
    if (!(await isSoundOn($))) return
    fanfare ??= wav(fanfareSamples(), FANFARE_GAIN)
    void playClip($, fanfare, 1, SAY).catch(err => soundFailed($, err))
  })
}

let isOverlayWarned = false

// The full-screen celebration, Windows only; off with /dopa-overlay off.
function showOverlay($: EngineInterface) {
  $.clock.after(0, async () => {
    isWindows ??= (await $.env.get('OS')) === 'Windows_NT'
    if (!isWindows || !(await isOn($, OVERLAY_KEY))) return
    const argv = [
      await powershellPath($),
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      'Hidden',
      '-EncodedCommand',
      base64(utf16le(WIN_OVERLAY)),
    ]
    void $.process
      .run(argv, { env: { DOPA_TEXT: OVERLAY_TEXT }, timeoutMs: 20000 })
      .then(ran => {
        if (ran.exitCode !== 0) throw new Error(cut(ran.stderr || `exit ${ran.exitCode}`, 80))
      })
      .catch(err => {
        if (isOverlayWarned) return
        isOverlayWarned = true
        $.ui.toast(`🎊 全画面演出を出せませんでした: ${cut(err instanceof Error ? err.message : String(err), 80)}`)
      })
  })
}

function playPip($: EngineInterface) {
  $.clock.after(0, async () => {
    if (!(await isSoundOn($))) return
    pip ??= wav(pipSamples(), 1.5)
    void playClip($, pip, 0.6).catch(err => soundFailed($, err))
  })
}

// ---- timers (take $; top-level so validation can follow them) ----------

function startBlink($: EngineInterface) {
  stopTimer()
  timer = $.clock.every(BLINK_MS, () => {
    void update($, frame, n => n + 1)
  })
}

function startRainbow($: EngineInterface) {
  stopTimer()
  void update($, isAnimating, () => true)
  timer = $.clock.every(RAINBOW_MS, () => {
    void update($, frame, n => n + 1)
  })
  $.clock.after(RAINBOW_FOR_MS, () => {
    stopTimer()
    void update($, isAnimating, () => false)
    void $.ui.close({ id: FIREWORKS_PANE }).catch(() => undefined)
  })
}

// The desktop app's blue dot in the sidebar, set through its own tool; on a
// surface without that tool the call is refused and only a toast says so.
const UNREAD_TOOL = 'mcp__ccd_sidebar__set_unread'

const DOT_BLINKS = 8 // on/off pairs before it stays on
const DOT_BLINK_MS = 350

// Blinks the dot: on, off, on, off ... and on to stay. A refusal stops the rest.
function markUnread($: EngineInterface) {
  let isRefused = false
  for (let i = 0; i <= DOT_BLINKS * 2; i++) {
    $.clock.after(i * DOT_BLINK_MS, () => {
      if (isRefused) return
      void $.tool
        .call({ tool: UNREAD_TOOL, session_id: 'self', unread: i % 2 === 0 } as never)
        .catch((err: unknown) => {
          if (isRefused) return
          isRefused = true
          $.ui.toast(`🔵 未読ドットを付けられませんでした: ${cut(err instanceof Error ? err.message : String(err), 80)}`)
        })
    })
  }
}

// A ✅ at the head of the session's title in the sidebar: put on when a turn
// completes, taken off when the next one starts. The title itself is kept.
const GET_SESSION_TOOL = 'mcp__ccd_session_mgmt__get_session'
const TITLE_TOOL = 'mcp__ccd_session_mgmt__set_session_title'
const OWN_TOOLS = [UNREAD_TOOL, GET_SESSION_TOOL, TITLE_TOOL]
const DONE_MARK = '✅ '

function titleOf(text: string | undefined): string | undefined {
  if (!text) return undefined
  try {
    const data = JSON.parse(text) as { title?: unknown; session?: { title?: unknown } }
    const title = data.title ?? data.session?.title
    if (typeof title === 'string') return title
  } catch {
    // not JSON: fall through to the first "title" field in the text
  }
  const m = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)
  return m ? (JSON.parse(`"${m[1]}"`) as string) : undefined
}

// Every ✅ at the head, with or without its variation selector or a space.
const MARKS = /^(?:\s*✅️?\s*)+/u

function stripMarks(title: string): string {
  return title.replace(MARKS, '')
}

async function readTitle($: EngineInterface): Promise<string> {
  const got = await $.tool.call({ tool: GET_SESSION_TOOL, session_id: 'self' } as never)
  if (got.deny !== undefined || got.isError) throw new Error(got.deny ?? got.text ?? 'get_session failed')
  const title = titleOf(got.text)
  if (title === undefined) throw new Error('タイトルを読み取れませんでした')
  return title
}

// Changes the title, then reads it back: a change the app did not keep throws.
async function retitle($: EngineInterface, change: (title: string) => string) {
  const title = await readTitle($)
  const next = change(title)
  if (next === title) return
  const set = await $.tool.call({ tool: TITLE_TOOL, session_id: 'self', title: next } as never)
  if (set.deny !== undefined || set.isError) throw new Error(set.deny ?? set.text ?? 'set_session_title failed')
  const kept = await readTitle($)
  if (kept !== next) throw new Error(`反映されませんでした（今: ${cut(kept, 30)}）`)
}

function wait($: EngineInterface, ms: number): Promise<void> {
  return new Promise(resolve => $.clock.after(ms, () => resolve()))
}

// The result goes into the run log, so /dopa-log shows what became of it.
async function noteTitle($: EngineInterface, isDone: boolean, why?: string) {
  const entry: LogEntry = {
    id: `title-${await $.clock.now()}-${isDone ? 'on' : 'off'}`,
    at: await $.clock.now(),
    icon: '🏷️',
    label: (isDone ? 'タイトルに ✅' : 'タイトルの ✅ を外す') + (why ? `: ${why}` : ''),
    status: why ? 'fail' : 'ok',
  }
  await update($, run, r => ({ ...r, log: [...r.log, entry].slice(-200) }))
}

// One title change at a time, in the order asked, so a quick turn's ✅ and
// the next prompt's removal never cross. Each tries four times.
let titleQueue: Promise<void> = Promise.resolve()

function markTitle($: EngineInterface, isDone: boolean) {
  const change = isDone ? (t: string) => DONE_MARK + stripMarks(t) : stripMarks
  titleQueue = titleQueue.then(async () => {
    let why = ''
    for (let k = 0; k < 4; k++) {
      try {
        await retitle($, change)
        await noteTitle($, isDone)
        return
      } catch (err) {
        why = cut(err instanceof Error ? err.message : String(err), 80)
        if (k < 3) await wait($, 700 * (k + 1))
      }
    }
    await noteTitle($, isDone, why)
    $.ui.toast(`✅ タイトルを変えられませんでした: ${why}`)
  })
}

// ---- hooks -------------------------------------------------------------

export const register: Register = on => {
  // The next prompt takes the ✅ off at once.
  on('prompt.submit', async ($, e, next) => {
    markTitle($, false)
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'dopa-log',
      description: 'このターンで実行したことと、今やっていることをペインで開く',
    })
    await $.command.register({
      name: 'dopa-sound',
      description: 'dopa-ide の効果音と読み上げを ON / OFF する（on・off、なしで切り替え）',
    })
    await $.command.register({
      name: 'dopa-overlay',
      description: '完了時の全画面の紙吹雪と虹色の枠を ON / OFF する（Windows、on・off、なしで切り替え）',
    })
    return next(e)
  })

  on('command.run', { command: 'dopa-log' }, async $ => {
    await $.ui.open({ id: PANE, title: '🌈 dopa-ide log' })
    return { text: '実行履歴のペインを開きました。' }
  })

  on('command.run', { command: 'dopa-sound' }, async ($, e) => ({ text: await setSound($, e.args) }))

  on('command.run', { command: 'dopa-overlay' }, async ($, e) => ({ text: await setOverlay($, e.args) }))

  // A new main-loop turn: back to blinking yellow.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      await update($, run, () => ({ ...EMPTY, phase: 'working' as Phase, startedAt: now }))
      startBlink($)
      markTitle($, false)
      await update($, finale, () => ({ prompt: e.text ?? '', answer: '', toolIds: [] }))
      $.ui.status(undefined)
    }
    return next(e)
  })

  // Every tool call goes into the log; tasks and todos feed the progress bar.
  on('tool.call', async ($, e, next) => {
    if (OWN_TOOLS.includes(e.tool)) return next(e) // our own dot and title, not part of the run
    const input = e as unknown as Record<string, unknown>
    const { icon, label } = describe(e.tool, input)
    const entry: LogEntry = {
      id: e.tool_use_id,
      at: await $.clock.now(),
      icon: e.agentId === undefined ? icon : '🤖',
      label,
      status: 'run',
    }
    await update($, run, r => ({ ...r, tools: r.tools + 1, log: [...r.log, entry].slice(-200) }))

    const count = (await read($, run)).tools
    if (e.agentId === undefined && COMBO_AT.includes(count)) {
      $.ui.toast(`🔥 ${count} COMBO!`)
      playPip($)
    }

    if (e.tool.endsWith('update_plan')) {
      await update($, run, r => ({ ...r, steps: applyPlan(r.steps, input) }))
    }

    if (e.tool === 'TodoWrite') {
      const todos = (input.todos ?? []) as { content: string; status: Step['status'] }[]
      await update($, run, r => ({
        ...r,
        steps: todos.map((t, i) => ({ id: `todo-${i}`, title: t.content, status: t.status })),
      }))
    }

    const ran = await next(e)
    const failed = ran.deny !== undefined || ran.isError === true

    await update($, run, r => ({
      ...r,
      log: r.log.map(x => (x.id === entry.id ? { ...x, status: failed ? ('fail' as const) : ('ok' as const) } : x)),
    }))

    if (!failed && e.tool === 'TaskCreate') {
      const task = (ran.result as { task?: { id: string; subject: string } } | undefined)?.task
      if (task) {
        const step: Step = { id: task.id, title: task.subject, status: 'pending' }
        await update($, run, r => ({ ...r, steps: [...r.steps.filter(s => s.id !== step.id), step] }))
      }
    }

    if (!failed && e.tool === 'TaskUpdate') {
      const id = String(input.taskId ?? '')
      const status = input.status as Step['status'] | 'deleted' | undefined
      const subject = input.subject as string | undefined
      await update($, run, r => ({
        ...r,
        steps:
          status === 'deleted'
            ? r.steps.filter(s => s.id !== id)
            : r.steps.map(s =>
                s.id === id ? { ...s, status: status ?? s.status, title: subject ?? s.title } : s,
              ),
      }))
    }

    return ran
  }).catch(($, e, next) => next(e)) // a failure here never blocks the tool

  // The main loop finished: rainbow time.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      await update($, run, r => ({ ...r, phase: 'done' as Phase, endedAt: now }))
      if (e.isAborted) {
        stopTimer()
      } else {
        startRainbow($)
        $.ui.toast('🌈 Completed!')
        markUnread($)
        markTitle($, true)
        const ids = (await read($, run)).log.map(x => x.id)
        await update($, finale, f => ({ ...f, answer: e.answer ?? '', toolIds: ids }))
        $.ui.status('✅ 完了！')
        void $.ui.notify('✅ 完了しました', { title: 'dopa-ide' }).catch(() => undefined)
        void $.ui.open({ id: FIREWORKS_PANE, title: '🎆 Completed!' }).catch(() => undefined)
        playFanfare($)
        showOverlay($)
      }
    }
    return next(e)
  })

  // The band above the prompt.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const r = await read($, run)
    if (e.props.hasSurvey || r.phase === 'idle') return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const p = progress(r.steps)
    const current = [...r.log].reverse().find(x => x.status === 'run')
    const last = r.log[r.log.length - 1]
    const recent = r.log.slice(-HOVER_ROWS)
    const elapsed = clock((r.phase === 'done' ? r.endedAt : now) - r.startedAt)

    const details = (
      <Box flexDirection="column" display="none" hover={{ display: 'flex' }} paddingX={1}>
        <Text dimColor>── ここまでの実行（{r.log.length}件・全部は /dopa-log）──</Text>
        {recent.length === 0 && <Text dimColor>まだ何も実行していません</Text>}
        {recent.map(x => (
          <Text color={x.status === 'fail' ? 'error' : undefined} dimColor={x.status === 'ok'}>
            {x.status === 'run' ? '▶ ' : x.status === 'fail' ? '✗ ' : '✓ '}
            {x.icon} {x.label}
          </Text>
        ))}
        {p && (
          <Text dimColor>
            {r.steps.map(s => (s.status === 'completed' ? '☑' : s.status === 'in_progress' ? '◐' : '☐')).join('')}{' '}
            {r.steps.find(s => s.status === 'in_progress')?.title ?? ''}
          </Text>
        )}
      </Box>
    )

    if (r.phase === 'working') {
      const n = await read($, frame)
      const isOn = n % 2 === 0
      const bg = isOn ? '#FFD400' : '#8A7300'
      const fg = isOn ? '#1A1A1A' : '#FFF6C2'
      return (
        <Box key="dopa" flexDirection="column">
          <Box paddingX={1} backgroundColor={bg} hover={{ backgroundColor: '#FFE45C' }}>
            <Text color={fg} bold>
              ⚡ WORKING{' '}
            </Text>
            {p && (
              <Text color={fg}>
                {p.bar} {p.done}/{p.total}{' '}
              </Text>
            )}
            <Text color={fg} wrap="truncate-end">
              {current
                ? `▶ ${current.icon} ${current.label}`
                : last
                  ? `🧠 考え中…（直前: ${last.label}）`
                  : '🧠 考え中…'}
            </Text>
            <Text color={fg}>
              {'  '}⏱ {elapsed} · 🔧 {r.tools}
            </Text>
          </Box>
          {details}
        </Box>
      )
    }

    // done: fireworks while the celebration lasts, then the rainbow row stays.
    // The desktop's SVG animates itself, so it never reads the frame (a tick
    // would redraw it and restart the show); the terminal steps by the frame.
    const animating = await read($, isAnimating)
    const seed = r.endedAt
    let show: unknown = null
    let n = 0
    if (animating && e.surface === 'desktop') {
      const { Svg } = $.ui.resolve(e)
      show = <Svg source={fireworksSvg(seed)} alt="🎆 花火" isInteractive height={220} />
    } else if (animating) {
      n = await read($, frame)
      const columns = Math.max(20, e.props.bodyColumns ?? 80)
      const rows = Math.max(0, Math.min(FIREWORK_ROWS, e.props.maxRows - 2))
      show =
        rows > 0 ? (
          <Box flexDirection="column">
            {fireworksRows(n, columns, rows, seed).map(row => (
              <Text>
                {spans(row).map(s => (s.color ? <Text color={s.color}>{s.ch}</Text> : s.ch))}
              </Text>
            ))}
          </Box>
        ) : null
    }
    const letters = rainbow('✨ Completed! ✨', n)
    return (
      <Box key="dopa" flexDirection="column">
        {show}
        <Box paddingX={1} backgroundColor="#101418">
          {letters.map(l => (
            <Text color={l.color} bold>
              {l.ch}
            </Text>
          ))}
          <Text color="#9BE89B">
            {'  '}⏱ {elapsed} · 🔧 {r.tools}
            {p ? ` · ☑ ${p.done}/${p.total}` : ''}
          </Text>
        </Box>
        {details}
      </Box>
    )
  })

  // The spinner wears what the turn is doing, with a spark that changes
  // every blink.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const icon = { thinking: '🧠', requesting: '📡', responding: '✍️', 'tool-use': '⚡', 'tool-input': '⚡' }[e.props.mode]
    const spark = ['✨', '🔥', '💥', '🌟'][(await read($, frame)) % 4]
    return next({ ...e, props: { ...e.props, word: `${icon} ${e.props.word} ${spark}` } })
  })

  // The turn's tool rows blink green with the show.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const f = await read($, finale)
    if (!f.toolIds.includes(e.props.tool_use_id) || !(await read($, isAnimating))) return next(e)
    const inner = await next(e)
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={green(await read($, frame))}>
        {inner}
      </Box>
    )
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const f = await read($, finale)
    const isOurs = e.props.calls.some(c => c.tool_use_id !== undefined && f.toolIds.includes(c.tool_use_id))
    if (!isOurs || !(await read($, isAnimating))) return next(e)
    const inner = await next(e)
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={green(await read($, frame))}>
        {inner}
      </Box>
    )
  })

  // The hint under the prompt keeps the combo count while Claude works.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (!e.props.isDraft && !e.props.isWorking && (await read($, isAnimating))) {
      const { Text } = $.ui.resolve(e)
      const n = await read($, frame)
      return (
        <Text>
          <Text color={green(n)} bold>
            ✅ 完了！{' '}
          </Text>
          <Text dimColor>{e.props.hint}</Text>
        </Text>
      )
    }
    const r = await read($, run)
    if (!e.props.isWorking || e.props.isDraft || r.phase !== 'working' || r.tools === 0) return next(e)
    const combo = `🔥 ${r.tools} COMBO`
    return e.surface === 'terminal'
      ? next({ ...e, props: { ...e.props, tail: combo } })
      : next({ ...e, props: { ...e.props, hint: `${combo} · ${e.props.hint}` } })
  })

  // The answer that closed the turn: a green frame, blinking while the show
  // lasts, steady until the next prompt.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const f = await read($, finale)
    if (!f.answer || !isAnswerTail(e.props.text, f.answer)) return next(e)
    const inner = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    const live = await read($, isAnimating)
    const color = live ? green(await read($, frame)) : '#22C55E'
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
        {inner}
        <Text color={color} bold>
          ✅ 完了
        </Text>
      </Box>
    )
  })

  // The prompt that started it blinks green with it while the show lasts.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const f = await read($, finale)
    if (!f.answer || !f.prompt || e.props.text.trim() !== f.prompt.trim()) return next(e)
    if (!(await read($, isAnimating))) return next(e)
    const inner = await next(e)
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={green(await read($, frame))}>
        {inner}
      </Box>
    )
  })

  // The footer's mode labels say it is done until the next prompt.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const f = await read($, finale)
    if (!f.answer) return next(e)
    return next({ ...e, props: { ...e.props, modes: [...e.props.modes, '✅ 完了'] } })
  })

  // The terminal's closing line of each turn (`Baked for 3s`).
  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) =>
    next({ ...e, props: { ...e.props, word: `✅ ${e.props.word}` } }),
  )

  // A pane that opens on completion for the fireworks and closes after them.
  on('ui.render', { component: 'Pane', requestId: FIREWORKS_PANE }, async ($, e) => {
    const r = await read($, run)
    if (e.surface === 'desktop') {
      // The Svg takes the pane's width and its markup's aspect, so an aspect
      // from the body's cells (a cell about 2.2 times as tall as wide) fills
      // the dock top to bottom. Inline above the prompt it stays a band.
      const { Svg } = $.ui.resolve(e)
      const columns = Math.max(10, e.props.bodyColumns)
      const rows = Math.max(4, e.props.scroll.bodyRows - 2)
      const size =
        e.props.placement === 'dock'
          ? { width: DOCK_WIDTH, height: Math.round((420 * rows * CELL_ASPECT) / columns) }
          : { width: 800, height: 220 }
      return <Svg source={fireworksSvg(r.endedAt + 1, size)} alt="🎆 花火" isInteractive />
    }
    const { Box, Text } = $.ui.resolve(e)
    const n = await read($, frame)
    const columns = Math.max(20, e.props.bodyColumns ?? 60)
    const rows = Math.max(4, e.props.scroll.bodyRows - 2)
    return (
      <Box flexDirection="column">
        {fireworksRows(n, columns, rows, r.endedAt + 1).map(row => (
          <Text>{spans(row).map(s => (s.color ? <Text color={s.color}>{s.ch}</Text> : s.ch))}</Text>
        ))}
        <Text color={green(n)} bold>
          ✅ 完了！
        </Text>
      </Box>
    )
  })

  // The full log, for terminals that can't hover.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const r = await read($, run)
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 4)
    return (
      <Box flexDirection="column">
        {r.log.length === 0 && <Text dimColor>まだ何も実行していません</Text>}
        {r.log.slice(-room).map(x => (
          <Text color={x.status === 'fail' ? 'error' : x.status === 'run' ? 'warning' : undefined}>
            {x.status === 'run' ? '▶ ' : x.status === 'fail' ? '✗ ' : '✓ '}
            {x.icon} {x.label}
          </Text>
        ))}
      </Box>
    )
  })
}
