#!/usr/bin/env node
/**
 * Orders and annotates the open roadmap from its dependency fields.
 *
 * Reads `ROADMAP.md` and `archived-roadmap.md`, then for every `### WSS-N`
 * item:
 *
 *   - resolves `blocked-by` (and `depends-on`, where present) against the open
 *     items and the archive (an archived target counts as satisfied; a
 *     `WASS-`/`WC-`/`FW-`-style id counts as an external, open blocker);
 *   - writes `blocks:` as the reverse of the open edges;
 *   - sorts the items inside each `##` section so every dependency precedes
 *     its dependents, tie-broken by priority, then the prior order; a section
 *     whose intro carries `<!-- roadmap-order: by-id -->` is sorted by id
 *     number instead;
 *   - rewrites the computed title markers: the priority tag `[H]`/`[M]`/`[L]`
 *     read off the `priority` field, the backend code `(fs)`/`(pg)`/`(*)`
 *     read off the `backend` field, then `[blocks N]` and `[after WSS-X]`;
 *   - regenerates the index block under the H1.
 *
 * Anything it cannot resolve (an unknown id, a cycle, an item with no field
 * block) is printed to stderr and left as it was. Section membership and
 * the section order are never changed.
 *
 * Usage:
 *   node scripts/roadmap-order.mjs            rewrite in place
 *   node scripts/roadmap-order.mjs --check    report only; exit 1 if a
 *                                             rewrite would change the file
 *   node scripts/roadmap-order.mjs --satisfied
 *                                             also list the blocked-by lines
 *                                             naming archived items
 *   node scripts/roadmap-order.mjs --roadmap <path> --archive <path>
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const check = args.includes('--check')
function argValue(flag, fallback) {
  const at = args.indexOf(flag)
  return at === -1 ? fallback : args[at + 1]
}
const roadmapPath = argValue('--roadmap', path.join(here, '..', 'ROADMAP.md'))
const archivePath = argValue(
  '--archive',
  path.join(here, '..', 'archived-roadmap.md')
)

const INDEX_START = '<!-- roadmap-order:index:start -->'
const INDEX_END = '<!-- roadmap-order:index:end -->'
const BY_ID_MARKER = '<!-- roadmap-order: by-id -->'
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 }
const PRIORITY_TAG = { high: 'H', medium: 'M', low: 'L' }
const BACKEND_CODES = new Set(['fs', 'pg', '*'])
const EXTERNAL_ID =
  /\b(?:WASS|WCL|WC|CLI|FW|DCW|WBU|WR|WSR|SC|ECS|PWSCS)-\d+\b/g
const ITEM_HEADING =
  /^### (WSS-\d+):\s*((?:(?:\[[^\]]*\]|\((?:fs|pg|\*)\))\s*)*)(.*)$/

const problems = []
const satisfied = []
function problem(text) {
  problems.push(text)
}

/**
 * Splits the roadmap into its preamble, the index block, and the sections,
 * each section carrying its intro lines and its items.
 */
function parseRoadmap(text) {
  const lines = text.split('\n')
  const sections = []
  let preamble = []
  let current = null
  let index = null
  let inIndex = false
  for (const line of lines) {
    if (line === INDEX_START) {
      inIndex = true
      index = []
      // The blank line the writer puts before the block is re-added on
      // render, so drop it here to keep a rewrite idempotent.
      if (preamble.at(-1)?.trim() === '') preamble.pop()
      continue
    }
    if (line === INDEX_END) {
      inIndex = false
      continue
    }
    if (inIndex) {
      index.push(line)
      continue
    }
    if (line.startsWith('## ')) {
      current = { heading: line, intro: [], items: [] }
      sections.push(current)
      continue
    }
    if (/^### WSS-\d+/.test(line) && current) {
      current.items.push({ heading: line, body: [] })
      continue
    }
    if (!current) {
      preamble.push(line)
    } else if (current.items.length === 0) {
      current.intro.push(line)
    } else {
      current.items.at(-1).body.push(line)
    }
  }
  return { preamble, hadIndex: index !== null, sections }
}

/**
 * Reads the field block at the top of an item body: `- key: value` lines
 * with indented continuation lines, ending at the first blank line.
 */
function parseFields(body) {
  const fields = new Map()
  let start = 0
  while (start < body.length && body[start].trim() === '') start += 1
  let end = start
  let key = null
  for (; end < body.length; end += 1) {
    const line = body[end]
    if (line.trim() === '') break
    const head = line.match(/^- ([a-z-]+):\s*(.*)$/)
    if (head) {
      key = head[1]
      fields.set(key, { line: end, value: head[2] })
    } else if (key && /^\s/.test(line)) {
      fields.get(key).value += ' ' + line.trim()
    } else {
      break
    }
  }
  return { fields, start, end }
}

function idsIn(value) {
  return [...new Set(value.match(/\bWSS-\d+\b/g) ?? [])]
}

function externalIdsIn(value) {
  return [...new Set(value.match(EXTERNAL_ID) ?? [])]
}

/**
 * Builds the item model: id, title, priority, fields, and the raw edges.
 */
function modelItem(raw, sectionHeading) {
  const match = raw.heading.match(ITEM_HEADING)
  if (!match) {
    problem(`unparseable heading in "${sectionHeading}": ${raw.heading}`)
    return null
  }
  const [, id, , title] = match
  const { fields, start, end } = parseFields(raw.body)
  if (!fields.has('status')) {
    problem(`${id} has no field block (no "- status:" line)`)
  }
  const priorityWord = (fields.get('priority')?.value ?? '').split(/\s+/)[0]
  if (!(priorityWord in PRIORITY_RANK)) {
    problem(`${id} has no priority (high / medium / low); no tag written`)
  }
  const backendCode = (fields.get('backend')?.value ?? '').split(/\s+/)[0]
  if (!BACKEND_CODES.has(backendCode)) {
    problem(`${id} has no backend (fs / pg / *); no code written`)
  }
  const dependsOn = fields.get('depends-on')?.value ?? ''
  const blockedBy = fields.get('blocked-by')?.value ?? ''
  const blockedByIsNone = /^none\b/i.test(blockedBy)
  return {
    id,
    title,
    priorityTag: PRIORITY_TAG[priorityWord] ?? null,
    backendCode: BACKEND_CODES.has(backendCode) ? backendCode : null,
    raw,
    section: sectionHeading,
    fields,
    fieldStart: start,
    fieldEnd: end,
    priority: PRIORITY_RANK[priorityWord] ?? 3,
    dependsOnIds: idsIn(dependsOn).concat(
      blockedByIsNone ? [] : idsIn(blockedBy)
    ),
    externalBlockers: blockedByIsNone
      ? []
      : externalIdsIn(blockedBy).concat(externalIdsIn(dependsOn)),
    openBlockers: [],
    blocks: []
  }
}

/**
 * Resolves every edge: open targets become blockers, archived ones are
 * satisfied, unknown ones are reported and dropped.
 */
function resolveEdges(items, archivedIds) {
  const byId = new Map(items.map(item => [item.id, item]))
  for (const item of items) {
    for (const target of item.dependsOnIds) {
      if (target === item.id) continue
      if (byId.has(target)) {
        item.openBlockers.push(target)
        byId.get(target).blocks.push(item.id)
      } else if (archivedIds.has(target)) {
        satisfied.push(
          `${item.id} is blocked by ${target}, which is archived (line can go)`
        )
      } else {
        problem(
          `${item.id} is blocked by ${target}, which is neither open nor archived`
        )
      }
    }
  }
  return byId
}

function byIdNumber(left, right) {
  return Number(left.slice(4)) - Number(right.slice(4))
}

/**
 * Kahn's algorithm inside one section. Ready items are taken in tie-break
 * order; a cycle leaves its members in their prior order at the end.
 */
function orderSection(items, byId) {
  const inSection = new Set(items.map(item => item.id))
  const position = new Map(items.map((item, at) => [item.id, at]))
  const remainingDeps = new Map()
  for (const item of items) {
    remainingDeps.set(
      item.id,
      new Set(item.openBlockers.filter(dep => inSection.has(dep)))
    )
  }
  function tieBreak(left, right) {
    if (left.priority !== right.priority) return left.priority - right.priority
    return position.get(left.id) - position.get(right.id)
  }
  const ordered = []
  const pending = new Set(items.map(item => item.id))
  while (pending.size > 0) {
    const ready = [...pending]
      .filter(id => remainingDeps.get(id).size === 0)
      .map(id => byId.get(id))
      .sort(tieBreak)
    if (ready.length === 0) {
      const stuck = [...pending].sort(byIdNumber)
      problem(`dependency cycle among ${stuck.join(', ')}; left in prior order`)
      for (const id of stuck) ordered.push(byId.get(id))
      break
    }
    const next = ready[0]
    ordered.push(next)
    pending.delete(next.id)
    for (const dependent of next.blocks) {
      remainingDeps.get(dependent)?.delete(next.id)
    }
  }
  return ordered
}

/**
 * Rebuilds the heading with the priority tag and backend code first and the
 * computed markers after them, and the field block with `blocks:` reflecting
 * the reverse edges.
 */
function renderItem(item) {
  const markers = []
  if (item.priorityTag) markers.push(`[${item.priorityTag}]`)
  if (item.backendCode) markers.push(`(${item.backendCode})`)
  if (item.blocks.length > 0) markers.push(`[blocks ${item.blocks.length}]`)
  const after = item.openBlockers
    .slice()
    .sort(byIdNumber)
    .concat(item.externalBlockers)
  if (after.length > 0) markers.push(`[after ${after.join(', ')}]`)
  const heading = `### ${item.id}: ${markers.length ? markers.join(' ') + ' ' : ''}${item.title}`

  const body = item.raw.body.slice()
  const blocksField = item.fields.get('blocks')
  const blocksLine =
    item.blocks.length > 0
      ? `- blocks: ${item.blocks.slice().sort(byIdNumber).join(', ')}`
      : null
  if (blocksField) {
    // Replace the existing line and any continuation lines under it.
    let span = 1
    while (
      blocksField.line + span < item.fieldEnd &&
      /^\s/.test(body[blocksField.line + span])
    ) {
      span += 1
    }
    body.splice(blocksField.line, span, ...(blocksLine ? [blocksLine] : []))
  } else if (blocksLine) {
    const anchor =
      item.fields.get('blocked-by') ?? item.fields.get('depends-on')
    let at
    if (anchor) {
      at = anchor.line + 1
      while (at < item.fieldEnd && /^\s/.test(body[at])) at += 1
    } else {
      const acceptance =
        item.fields.get('touches') ?? item.fields.get('acceptance')
      at = acceptance ? acceptance.line : item.fieldEnd
    }
    body.splice(at, 0, blocksLine)
  }
  while (body.length > 0 && body.at(-1).trim() === '') body.pop()
  return [heading, ...body]
}

function itemLabel(item) {
  const tag = item.priorityTag ? `[${item.priorityTag}] ` : ''
  const code = item.backendCode ? `(${item.backendCode}) ` : ''
  return `${item.id} ${tag}${code}${item.title}`
}

/**
 * Greedy word wrap at prettier's print width, so `pnpm format` leaves the
 * generated index as the script wrote it. `first` prefixes the first line and
 * `rest` every continuation line, so a wrapped list item stays one item.
 */
function wrap(text, { first = '', rest = '', width = 80 } = {}) {
  // A word that would read as a list or heading marker at a line start is
  // glued to its predecessor, as prettier does ("(blocks 2)" stays whole).
  const words = []
  for (const word of text.split(' ')) {
    if (words.length > 0 && /^(?:\d+[.)]|[-+*>]|#+)$/.test(word)) {
      words[words.length - 1] += ` ${word}`
    } else {
      words.push(word)
    }
  }
  const lines = []
  let line = ''
  for (const word of words) {
    const prefix = lines.length === 0 ? first : rest
    const candidate = line ? `${line} ${word}` : word
    if (line && prefix.length + candidate.length > width) {
      lines.push(prefix + line)
      line = word
    } else {
      line = candidate
    }
  }
  lines.push((lines.length === 0 ? first : rest) + line)
  return lines
}

function bullet(text, depth = 0) {
  const lead = '  '.repeat(depth)
  return wrap(text, { first: `${lead}- `, rest: `${lead}  ` })
}

/**
 * The generated index: per section, the items nothing open blocks, then
 * every foundation item with its dependents beneath it.
 */
function renderIndex(sections, byId) {
  const out = [INDEX_START, '', '## Index (generated)', '']
  out.push(
    ...wrap(
      'Regenerated by `pnpm roadmap` (`node scripts/roadmap-order.mjs`); do not edit by hand. Per section: the items no open item blocks, in section order, then each item others wait on with its dependents beneath it.'
    ),
    ''
  )
  for (const section of sections) {
    if (section.models.length === 0) continue
    const name = section.heading.replace(/^## /, '')
    out.push(`**${name}**`, '')
    const ready = section.models.filter(
      item =>
        item.openBlockers.length === 0 && item.externalBlockers.length === 0
    )
    out.push('Ready:', '')
    if (ready.length === 0) out.push('- (none)')
    for (const item of ready) {
      const blocks = item.blocks.length ? ` (blocks ${item.blocks.length})` : ''
      out.push(...bullet(`${itemLabel(item)}${blocks}`))
    }
    const foundations = section.models.filter(item => item.blocks.length > 0)
    if (foundations.length > 0) {
      out.push('', 'Chains:', '')
      for (const item of foundations) {
        out.push(...bullet(itemLabel(item)))
        for (const dependentId of item.blocks.slice().sort(byIdNumber)) {
          const dependent = byId.get(dependentId)
          const elsewhere =
            dependent.section === item.section
              ? ''
              : ` (in "${dependent.section.replace(/^## /, '')}")`
          out.push(...bullet(`${itemLabel(dependent)}${elsewhere}`, 1))
        }
      }
    }
    const external = section.models.filter(
      item => item.externalBlockers.length > 0
    )
    if (external.length > 0) {
      out.push('', 'Waiting on another repo:', '')
      for (const item of external) {
        out.push(
          ...bullet(
            `${itemLabel(item)} (after ${item.externalBlockers.join(', ')})`
          )
        )
      }
    }
    out.push('')
  }
  out.push(INDEX_END)
  return out
}

function main() {
  const original = fs.readFileSync(roadmapPath, 'utf8')
  const archiveText = fs.readFileSync(archivePath, 'utf8')
  const archivedIds = new Set(
    archiveText.match(/^### (WSS-\d+)/gm)?.map(line => line.slice(4)) ?? []
  )

  const { preamble, sections } = parseRoadmap(original)
  for (const section of sections) {
    section.byId = section.intro.some(line => line.trim() === BY_ID_MARKER)
    section.models = section.items
      .map(raw => modelItem(raw, section.heading))
      .filter(Boolean)
  }
  const allItems = sections.flatMap(section => section.models)
  const seen = new Set()
  for (const item of allItems) {
    if (seen.has(item.id)) problem(`${item.id} appears more than once`)
    seen.add(item.id)
    if (archivedIds.has(item.id)) problem(`${item.id} is open and archived`)
  }
  const byId = resolveEdges(allItems, archivedIds)
  for (const section of sections) {
    section.models = section.byId
      ? section.models
          .slice()
          .sort((left, right) => byIdNumber(left.id, right.id))
      : orderSection(section.models, byId)
  }

  // The index sits after the `nextAvailableId` line's paragraph.
  const out = []
  let indexPlaced = false
  const cleanPreamble = preamble.slice()
  while (cleanPreamble.length > 0 && cleanPreamble.at(-1).trim() === '') {
    cleanPreamble.pop()
  }
  for (let at = 0; at < cleanPreamble.length; at += 1) {
    out.push(cleanPreamble[at])
    if (!indexPlaced && /^nextAvailableId:/.test(cleanPreamble[at])) {
      out.push('', ...renderIndex(sections, byId))
      indexPlaced = true
    }
  }
  if (!indexPlaced) {
    problem('no nextAvailableId line; index appended to the preamble')
    out.push('', ...renderIndex(sections, byId))
  }
  for (const section of sections) {
    const intro = section.intro.slice()
    while (intro.length > 0 && intro.at(-1).trim() === '') intro.pop()
    out.push('', section.heading, ...intro)
    for (const item of section.models) out.push('', ...renderItem(item))
  }
  const rewritten = out.join('\n') + '\n'

  for (const text of problems) console.error(`roadmap-order: ${text}`)
  if (args.includes('--satisfied')) {
    for (const text of satisfied) console.error(`roadmap-order: ${text}`)
  } else if (satisfied.length > 0) {
    console.error(
      `roadmap-order: ${satisfied.length} blocked-by lines name archived items (--satisfied lists them)`
    )
  }
  const changed = rewritten !== original
  const summary = `${allItems.length} items in ${sections.length} sections; ${
    allItems.filter(item => item.blocks.length > 0).length
  } foundations, ${allItems.filter(item => item.openBlockers.length > 0).length} blocked on an open item, ${
    allItems.filter(item => item.externalBlockers.length > 0).length
  } waiting on another repo`
  if (check) {
    console.log(
      `roadmap-order: ${summary}; ${changed ? 'file would change' : 'file up to date'}`
    )
    process.exit(changed ? 1 : 0)
  }
  if (changed) fs.writeFileSync(roadmapPath, rewritten)
  console.log(
    `roadmap-order: ${summary}; ${changed ? 'rewritten' : 'unchanged'}`
  )
}

main()
