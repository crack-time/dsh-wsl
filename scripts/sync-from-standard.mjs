/**
 * scripts/sync-from-standard.mjs — regenerate the `standard-wsl` user preset
 * from the shipped `standard` preset, applying the WSL overrides on top.
 *
 * Why: DSH presets have no inheritance, so `standard-wsl` is a frozen copy that
 * drifts when shipped `standard` gains rows. This script re-derives it from the
 * shipped copy each run so it stays in sync, then applies the WSL deltas:
 *   - persona: add a WSL-clause line
 *   - shell: force `tool-bash` + `tool-pwsh` disabled, and mount `tool-wsl`
 *     (`@crack/dsh-wsl/tool`)
 * Every other row is copied verbatim (including `!!js` expressions and
 * comments).
 *
 * Usage: `node scripts/sync-from-standard.mjs [--standard <dir>] [--out <dir>]`
 * Defaults: standard dir auto-located under the installed DSH; out dir is the
 * harness home user preset `standard-wsl`.
 *
 * This is deliberately LINE-based, not YAML-parsed: the shipped file carries
 * `!!js process.platform === 'win32'` tags that js-yaml rejects.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')

// Parse --standard / --out / --distro
function arg(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/**
 * Probe the default WSL distro via `wsl.exe -l -q`. Returns undefined on failure.
 *
 * `wsl.exe` emits UTF-16LE when piped (not a TTY), which decodes to ASCII as
 * `U\0b\0u\0n\0t\0u\0`. Detect it by the interleaved-NUL pattern (no BOM present)
 * rather than assuming a BOM or UTF-8.
 */
function detectDefaultDistro() {
  try {
    const buf = execFileSync('wsl.exe', ['-l', '-q'], { timeout: 10000 })
    const looksUtf16 = buf.length >= 4 && Array.from({ length: Math.min(8, Math.floor(buf.length / 2)) })
      .some((_, i) => buf[i * 2 + 1] === 0)
    const text = looksUtf16 ? buf.toString('utf16le') : buf.toString('utf8')
    const first = text
      .trim()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)[0]
    // `wsl -l -q` can echo a bare distro name; anything else is a spurious line.
    return first && !/^wsl|error/i.test(first) ? first : undefined
  } catch {
    return undefined
  }
}

/** Locate the shipped standard preset dir by probing known install paths. */
function findStandardDir(explicit) {
  if (explicit) {
    const d = explicit.endsWith('agent.cordis.yml') ? dirname(explicit) : explicit
    if (existsSync(join(d, 'agent.cordis.yml'))) return d
    throw new Error(`--standard path has no agent.cordis.yml: ${explicit}`)
  }
  const globalRoots = [
    process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets', 'standard') : null,
    process.env.NPM_CONFIG_PREFIX ? join(process.env.NPM_CONFIG_PREFIX, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets', 'standard') : null,
    'node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-presets/presets/standard',
    'node_modules/@deepseek-ai/dsh-agent-presets/presets/standard',
  ].filter(Boolean).map((p) => resolve(REPO, p));
  for (const d of globalRoots) {
    if (existsSync(join(d, 'agent.cordis.yml'))) return d
  }
  throw new Error(
    'Could not locate the shipped standard preset. Pass --standard <dir> pointing at ' +
    '.../@deepseek-ai/dsh-agent-presets/presets/standard',
  )
}

// ── WSL overrides ───────────────────────────────────────────────────────────
const WSL_PERSONA_LINES = [
  '      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.',
  '      This session runs inside a WSL distro; use the wsl tool to run shell commands.',
]
const WSL_PERSONA_PREFIX_LINE = '    text: >-'

function makeToolWslBlock(distro) {
  return `- id: tool-wsl
  name: '@crack/dsh-wsl/tool'
  config:
    distro: '${distro}'
    runtime: 'daemon'
    daemon:
      host: '127.0.0.1'
      port: 37778
`
}
const PRESET_YML = `name: WSL Standard
description: The standard coding mode for WSL workspaces. Disables the native bash/pwsh tools and runs commands inside the WSL distro through the wsl tool (resident exec-server preferred, one-shot wsl.exe bridge as fallback). All other tools, skills, planning and delegation match the standard mode. Select this preset only for WSL workspaces.
order: 1
`

function transform(standardAgentYml, distro) {
  const lines = standardAgentYml.split('\n')
  const out = []
  let currentId = null
  let inPersonaText = false
  let personaTextEmitted = false
  let toolWslInserted = false
  const toolWslBlock = makeToolWslBlock(distro)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const rowStart = /^- id:\s+(\S+)/.exec(line)

    if (rowStart) {
      currentId = rowStart[1]
      inPersonaText = personaTextEmitted = false
    }

    // Persona text fold: replace the content after `text: >-`.
    if (currentId === 'persona' && /^\s*text: >-/.test(line)) {
      out.push(line)
      inPersonaText = true
      continue
    }
    if (inPersonaText) {
      // Content lines are ≥6-space indented; a blank or a new row ends them.
      const isContent = /^\s{6,}\S/.test(line)
      if (isContent && !personaTextEmitted) {
        out.push(...WSL_PERSONA_LINES)
        personaTextEmitted = true
        continue
      }
      if (isContent && personaTextEmitted) {
        continue // drop the original persona content
      }
      // blank or dedent → persona fold done
      inPersonaText = false
      // fall through to the normal copy below
    }

    // Force tool-bash / tool-pwsh disabled (and mount tool-wsl right after
    // tool-pwsh, keeping it in the shell section).
    if ((currentId === 'tool-bash' || currentId === 'tool-pwsh') && /^\s*disabled:/.test(line)) {
      out.push('  disabled: true')
      if (currentId === 'tool-pwsh' && !toolWslInserted) {
        out.push('')
        out.push(...toolWslBlock.split('\n'))
        toolWslInserted = true
      }
      continue
    }

    // Disable the native filesystem tools entirely: on a WSL-UNC workspace the
    // host file tools can't write (atomic rename ENOTSUP) or grep (ripgrep
    // os error 3) against the share. `tool-fs` bundles read/write/edit and
    // `tool-fs-search` bundles glob+grep, so disabling the whole row is the
    // only granularity the loader offers — the model must use `wsl` (bash) for
    // every file operation. Inject a `disabled:` row right after the `name:` of
    // each package (these rows carry no existing `disabled:` to rewrite).
    if ((currentId === 'tool-fs' || currentId === 'tool-fs-search') &&
        /^ {2}name:\s*['"]@deepseek-ai\/dsh-tool-fs(-search)?['"]\s*$/.test(line)) {
      out.push(line)
      out.push('  disabled: true')
      continue
    }

    out.push(line)
  }

  // Safety: if tool-wsl wasn't inserted (no tool-pwsh row?), append it.
  if (!toolWslInserted) {
    out.push('')
    out.push(...toolWslBlock.split('\n'))
  }
  return out.join('\n')
}

// ── run ─────────────────────────────────────────────────────────────────────
const standardDir = findStandardDir(arg('--standard'))
const outDir = arg('--out') ?? join(homedir(), '.dsh', '.agent-presets', 'standard-wsl')
const distro = arg('--distro') || detectDefaultDistro() || 'Ubuntu-22.04'
mkdirSync(outDir, { recursive: true })

const source = readFileSync(join(standardDir, 'agent.cordis.yml'), 'utf8')
const regenerated = transform(source, distro)
writeFileSync(join(outDir, 'agent.cordis.yml'), regenerated + '\n')
writeFileSync(join(outDir, 'preset.yml'), PRESET_YML)

console.log(`standard  : ${standardDir}`)
console.log(`distro    : ${distro}${arg('--distro') ? ' (from --distro)' : detectDefaultDistro() ? ' (detected from wsl.exe -l -q)' : ' (default)'}`)
console.log(`written to: ${outDir}/agent.cordis.yml + preset.yml`)
console.log('tool-wsl  : ' + (source.includes('@crack/dsh-wsl/tool') ? 'already present (re-applied)' : 'inserted'))
console.log('Done. Review the generated preset (comments from `standard` are preserved; `!!js` rows are kept).')