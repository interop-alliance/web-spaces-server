/**
 * Pure and injectable-dependency logic shared by `pnpm perf:fs`,
 * `pnpm perf:pg` and `pnpm perf:remote` (`perf-fs.ts`, `perf-pg.ts`,
 * `perf-remote.ts`) and their seed scripts: CLI argument parsing, the backend
 * split and the Collection pool it needs, the run-length estimate, the
 * Markdown table formatting, the load-aggregation harnesses, the
 * Collection-size seeding over an injected backend, and the parts of a run
 * record (`pnpm perf:remote --record`). Kept free of side effects at import
 * time so it can be unit tested without spawning a server, k6, or any network
 * request.
 */
import { join } from 'node:path'

import { absoluteUrl } from '../../src/lib/paths.js'
import type { StorageBackend } from '../../src/types.js'

/**
 * Parses a command-line value as a positive integer.
 * @param value {string}
 * @returns {number}
 */
export function positiveInteger(value: string): number {
  const number = Number(value.trim())
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`Expected a positive integer, got "${value}".`)
  }
  return number
}

/**
 * Parses a command-line value as a non-negative integer (0 allowed).
 * @param value {string}
 * @returns {number}
 */
export function nonNegativeInteger(value: string): number {
  const trimmed = value.trim()
  const number = Number(trimmed)
  // `Number('')` is 0, so a blank value has to be refused before the check.
  if (trimmed === '' || !Number.isInteger(number) || number < 0) {
    throw new Error(`Expected a non-negative integer, got "${value}".`)
  }
  return number
}

/**
 * Parses a `--sizes` value (comma-separated Collection sizes) into the
 * deduped, sorted list and the edge sizes (smallest and largest) that the
 * signed write/delete/serial-write tests run at.
 * @param value {string}
 * @returns {{ sizes: number[], edgeSizes: number[] }}
 */
export function parseSizes(value: string): {
  sizes: number[]
  edgeSizes: number[]
} {
  const sizes = [...new Set(value.split(',').map(positiveInteger))].sort(
    (left, right) => left - right
  )
  const edgeSizes = sizes.filter(
    (_size, index) => index === 0 || index === sizes.length - 1
  )
  return { sizes, edgeSizes }
}

/**
 * The settings every load test reads, from the shared CLI options
 * (`--clients`, `--duration`, `--writes`, `--large-file-clients`).
 */
export interface LoadSettings {
  clients: number
  // The clients the payload matrix's 10 MiB tests run with, `clients` unless
  // capped: five clients sending 10 MiB each outgrow a 512 MB machine.
  largeFileClients: number
  durationSeconds: number
  serialWrites: number
}

/**
 * Parses the shared load-test CLI values into `LoadSettings`.
 * @param options {object}
 * @param options.clients {string}
 * @param options.duration {string}
 * @param options.writes {string}
 * @param [options.large-file-clients] {string}   defaults to `clients`
 * @returns {LoadSettings}
 */
export function parseLoadSettings({
  clients,
  duration,
  writes,
  'large-file-clients': largeFileClients
}: {
  clients: string
  duration: string
  writes: string
  'large-file-clients'?: string
}): LoadSettings {
  return {
    clients: positiveInteger(clients),
    largeFileClients: positiveInteger(largeFileClients ?? clients),
    durationSeconds: positiveInteger(duration),
    serialWrites: positiveInteger(writes)
  }
}

/**
 * The server backends a perf run can place a Collection on, by the fixed id
 * a Collection's `backend` names.
 */
export const serverBackendIds = ['fs', 'postgres'] as const

export type ServerBackendId = (typeof serverBackendIds)[number]

/**
 * One backend's share of a `--split`, in whole percent.
 */
export interface BackendShare {
  backend: ServerBackendId
  percent: number
}

/**
 * The most Collections a `--split` may need per test: any split in steps of
 * 5 percent. Every pool member is one more Collection filled to each size,
 * and a Space holds 100 Collections by default (`MAX_COLLECTIONS_PER_SPACE`).
 */
export const maxPoolSize = 20

/**
 * One Collection of the pool a test spreads its load over: the backend it is
 * created on, and the suffix its Collection id carries. A run with no
 * `--split` has a single member that names no backend and adds no suffix, so
 * its Collections keep the ids a seed dir or schema already holds.
 */
export interface PoolMember {
  backend?: ServerBackendId
  suffix: string
}

/**
 * A URL path a test sends requests to, with the backend of the Collection it
 * is in.
 */
export interface PoolTarget {
  path: string
  backend?: ServerBackendId
}

/**
 * The greatest common divisor of two non-negative integers.
 * @param left {number}
 * @param right {number}
 * @returns {number}
 */
function greatestCommonDivisor(left: number, right: number): number {
  return right === 0 ? left : greatestCommonDivisor(right, left % right)
}

/**
 * The Collections each test spreads its load over: the smallest pool that
 * realizes `split` exactly (2 for `50/50`, 4 for `25/75`, 10 for `30/70`),
 * each backend's members spaced evenly through it, so a test that stops
 * partway through the pool still sends each backend close to its share. A
 * member's suffix is `-<backend>-<n>`. With no split, the one member a run
 * on the server's default backend has.
 * @param [split] {BackendShare[]}
 * @returns {PoolMember[]}
 */
export function backendPool(split?: BackendShare[]): PoolMember[] {
  if (split === undefined) {
    return [{ suffix: '' }]
  }
  const divisor = split.reduce(
    (divisorSoFar, { percent }) => greatestCommonDivisor(divisorSoFar, percent),
    0
  )
  const spaced = split.flatMap(({ backend, percent }, order) => {
    const count = percent / divisor
    return Array.from({ length: count }, (_unused, index) => ({
      member: { backend, suffix: `-${backend}-${index}` },
      position: (index + 0.5) / count,
      order
    }))
  })
  spaced.sort(
    (left, right) => left.position - right.position || left.order - right.order
  )
  return spaced.map(({ member }) => member)
}

/**
 * Parses a `--split` value (comma-separated `<backend>=<percent>` entries,
 * e.g. `postgres=30,fs=70`) into each backend's share, in the order given.
 * The percents are whole numbers adding up to 100, and the pool they need
 * (`backendPool`) is at most `maxPoolSize` Collections.
 * @param value {string}
 * @returns {BackendShare[]}
 */
export function parseSplit(value: string): BackendShare[] {
  const split: BackendShare[] = []
  for (const entry of value.split(',')) {
    const [name = '', percent = '', ...rest] = entry
      .split('=')
      .map(part => part.trim())
    const backend = serverBackendIds.find(id => id === name)
    if (backend === undefined || rest.length > 0) {
      throw new Error(
        `Unknown --split entry "${entry.trim()}"; expected ` +
          `<backend>=<percent>, with a backend of ${serverBackendIds.join(', ')}.`
      )
    }
    if (split.some(share => share.backend === backend)) {
      throw new Error(`--split names "${backend}" twice.`)
    }
    split.push({ backend, percent: positiveInteger(percent) })
  }
  const total = split.reduce((sum, { percent }) => sum + percent, 0)
  if (total !== 100) {
    throw new Error(`--split percents add up to ${total}, not 100.`)
  }
  const poolSize = backendPool(split).length
  if (poolSize > maxPoolSize) {
    throw new Error(
      `--split ${value} needs ${poolSize} Collections per test; give ` +
        `percents in steps of 5, which need at most ${maxPoolSize}.`
    )
  }
  return split
}

/**
 * The distinct backends `pool` names, in first-seen order.
 * @param pool {Array<{ backend?: ServerBackendId }>}
 * @returns {ServerBackendId[]}
 */
export function poolBackends(
  pool: ReadonlyArray<{ backend?: ServerBackendId }>
): ServerBackendId[] {
  return [
    ...new Set(
      pool.flatMap(({ backend }) => (backend === undefined ? [] : [backend]))
    )
  ]
}

/**
 * The pool a split needs, as the report header and the estimate name it, in
 * the split's order, e.g. `10 Collections per test (3 on postgres, 7 on fs)`.
 * @param split {BackendShare[]}
 * @returns {string}
 */
export function describePool(split: BackendShare[]): string {
  const pool = backendPool(split)
  const counts = split.map(
    ({ backend }) =>
      `${pool.filter(member => member.backend === backend).length} on ${backend}`
  )
  const collections = pool.length === 1 ? 'Collection' : 'Collections'
  return `${pool.length} ${collections} per test (${counts.join(', ')})`
}

/**
 * The `backend` member a pool member's Collection is created with, to spread
 * into a `createCollection` description: none for a member on the server's
 * default backend.
 * @param member {PoolMember}
 * @returns {{ backend?: { id: ServerBackendId } }}
 */
export function collectionBackend({ backend }: PoolMember): {
  backend?: { id: ServerBackendId }
} {
  return backend === undefined ? {} : { backend: { id: backend } }
}

/**
 * The backends `split` names that a host's backends listing
 * (`GET /space/:spaceId/backends`) does not, so a run can stop before it
 * seeds anything.
 * @param options {object}
 * @param options.split {BackendShare[]}
 * @param options.listedIds {string[]}   the listing's backend ids
 * @returns {ServerBackendId[]}
 */
export function missingBackends({
  split,
  listedIds
}: {
  split: BackendShare[]
  listedIds: string[]
}): ServerBackendId[] {
  return split
    .map(({ backend }) => backend)
    .filter(backend => !listedIds.includes(backend))
}

/**
 * The member of `pool` the `index`th request goes to, round-robin.
 * @param options {object}
 * @param options.pool {Target[]}   at least one member
 * @param options.index {number}
 * @returns {Target}
 */
function roundRobin<Target>({
  pool,
  index
}: {
  pool: readonly Target[]
  index: number
}): Target {
  return pool[index % pool.length]!
}

export interface Measurement {
  rate: number
  avgMs?: number
  failed: number
  // Each backend's part of a test whose pool spans backends: the requests its
  // Collections answered over the whole test's time, so the parts' rates add
  // up to `rate`.
  byBackend?: Partial<Record<ServerBackendId, Measurement>>
}

export interface Row {
  test: string
  size: number
  result: Measurement | string
}

/**
 * Formats a number with thousands separators and fixed decimals.
 * @param value {number}
 * @param digits {number}
 * @returns {string}
 */
function formatNumber(value: number, digits: number): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  })
}

/**
 * One completed test as a plain progress line, printed as each test finishes
 * so a multi-minute run isn't silent. The final report (`formatPivotedTable`
 * / `formatScalingSummary`) is the polished table; this is just "something
 * happened."
 * @param row {Row}
 * @returns {string}
 */
export function formatProgressLine({ test, size, result }: Row): string {
  const sizeLabel = formatNumber(size, 0)
  if (typeof result === 'string') {
    return `${test} (size ${sizeLabel}): ${result}`
  }
  const avg = result.avgMs === undefined ? 'n/a' : formatNumber(result.avgMs, 2)
  return `${test} (size ${sizeLabel}): ${formatNumber(result.rate, 1)} req/s, ${avg} ms avg, ${result.failed} failed`
}

/**
 * One test's result at every size the run covers, aligned with `sizes`: a
 * `Measurement` where that (test, size) pair ran, the skip string where k6
 * was skipped, or `undefined` where that test was not run at that size (the
 * signed write/delete/serial-write tests only run at the edge sizes).
 */
export interface PivotedRow {
  test: string
  cells: Array<Measurement | string | undefined>
}

/**
 * Groups the run's flat `Row[]` by test, in first-seen order, into one
 * `PivotedRow` per test with one cell per size.
 * @param options {object}
 * @param options.sizes {number[]}
 * @param options.rows {Row[]}
 * @returns {PivotedRow[]}
 */
export function pivotRows({
  sizes,
  rows
}: {
  sizes: number[]
  rows: Row[]
}): PivotedRow[] {
  const order: string[] = []
  const cellsByTest = new Map<string, Array<Measurement | string | undefined>>()
  for (const row of rows) {
    if (!cellsByTest.has(row.test)) {
      order.push(row.test)
      cellsByTest.set(row.test, new Array(sizes.length).fill(undefined))
    }
    const index = sizes.indexOf(row.size)
    cellsByTest.get(row.test)![index] = row.result
  }
  return order.map(test => ({
    test,
    cells: cellsByTest.get(test) as Array<Measurement | string | undefined>
  }))
}

/**
 * One table cell as it reads: the skip string as-is, `--` for a gap, or
 * `<rate> <unit> (<avg> ms)`.
 * @param cell {Measurement | string | undefined}
 * @param [unit] {string}   `req/s` by default; the matrix counts `files/s`
 * @returns {string}
 */
function formatCell(
  cell: Measurement | string | undefined,
  unit = 'req/s'
): string {
  if (cell === undefined) {
    return '--'
  }
  if (typeof cell === 'string') {
    return cell
  }
  const avg = cell.avgMs === undefined ? 'n/a' : formatNumber(cell.avgMs, 2)
  return `${formatNumber(cell.rate, 1)} ${unit} (${avg} ms)`
}

/**
 * The pivoted results as a Markdown table: one row per test, one column per
 * size.
 * @param options {object}
 * @param options.sizes {number[]}
 * @param options.pivoted {PivotedRow[]}
 * @returns {string}
 */
export function formatPivotedTable({
  sizes,
  pivoted
}: {
  sizes: number[]
  pivoted: PivotedRow[]
}): string {
  const header = `| Test | ${sizes.map(size => `size ${size}`).join(' | ')} |`
  const divider = `|---|${sizes.map(() => '---:').join('|')}|`
  const body = pivoted.map(
    ({ test, cells }) =>
      `| ${test} | ${cells.map(cell => formatCell(cell)).join(' | ')} |`
  )
  return [header, divider, ...body].join('\n')
}

/**
 * One payload-matrix result: a Collection category and a payload, with its
 * read and write measurement (or the skip string, for a public read without
 * k6). Each counts whole files, however many requests one file takes.
 */
export interface MatrixRow {
  category: MatrixCategory
  payload: MatrixPayload
  read: Measurement | string
  write: Measurement | string
}

const matrixCategoryLabels: Record<MatrixCategory, string> = {
  public: 'Public',
  plaintext: 'Plaintext',
  encrypted: 'Encrypted'
}

const matrixPayloadLabels: Record<MatrixPayload, string> = {
  json: 'JSON',
  small: '100 KiB file',
  large: '10 MiB file'
}

/**
 * How a matrix cell is named in progress lines and failure lists, e.g.
 * `Encrypted, 10 MiB file`.
 * @param options {object}
 * @param options.category {MatrixCategory}
 * @param options.payload {MatrixPayload}
 * @returns {string}
 */
export function matrixLabel({
  category,
  payload
}: {
  category: MatrixCategory
  payload: MatrixPayload
}): string {
  return `${matrixCategoryLabels[category]}, ${matrixPayloadLabels[payload]}`
}

/**
 * One completed matrix test as a progress line, e.g.
 * `Encrypted, 10 MiB file, write: 12.3 files/s (80.10 ms), 0 failed`.
 * @param options {object}
 * @param options.category {MatrixCategory}
 * @param options.payload {MatrixPayload}
 * @param options.operation {string}   `read` or `write`
 * @param options.result {Measurement | string}
 * @returns {string}
 */
export function formatMatrixProgressLine({
  category,
  payload,
  operation,
  result
}: {
  category: MatrixCategory
  payload: MatrixPayload
  operation: string
  result: Measurement | string
}): string {
  const label = `${matrixLabel({ category, payload })}, ${operation}`
  if (typeof result === 'string') {
    return `${label}: ${result}`
  }
  return `${label}: ${formatCell(result, 'files/s')}, ${result.failed} failed`
}

/**
 * The payload matrix as a Markdown table, one row per category and payload,
 * followed by a failures line. A cell may be a gap (`backendCell` of a
 * backend that answered none of a test's requests).
 * @param rows {MatrixRow[]}
 * @returns {string}
 */
export function formatMatrixTable(
  rows: Array<{
    category: MatrixCategory
    payload: MatrixPayload
    read: Measurement | string | undefined
    write: Measurement | string | undefined
  }>
): string {
  const failures: string[] = []
  const body = rows.map(({ category, payload, read, write }) => {
    for (const [operation, result] of [
      ['read', read],
      ['write', write]
    ] as const) {
      if (
        result !== undefined &&
        typeof result !== 'string' &&
        result.failed > 0
      ) {
        failures.push(
          `${matrixLabel({ category, payload })} ${operation}: ${result.failed} failed`
        )
      }
    }
    return (
      `| ${matrixCategoryLabels[category]} | ${matrixPayloadLabels[payload]} | ` +
      `${formatCell(read, 'files/s')} | ${formatCell(write, 'files/s')} |`
    )
  })
  return [
    '| Collection | Payload | Read | Write |',
    '|---|---|---:|---:|',
    ...body,
    '',
    failures.length > 0 ? `Failures: ${failures.join('; ')}` : 'Failures: none'
  ].join('\n')
}

/**
 * One cell as `backend` alone answered it, for that backend's table: its part
 * of a measurement, the skip string as-is, or `undefined` for a gap or a
 * backend that answered none of the test's requests.
 * @param cell {Measurement | string | undefined}
 * @param backend {ServerBackendId}
 * @returns {Measurement | string | undefined}
 */
export function backendCell(
  cell: Measurement | string | undefined,
  backend: ServerBackendId
): Measurement | string | undefined {
  if (cell === undefined || typeof cell === 'string') {
    return cell
  }
  return cell.byBackend?.[backend]
}

/**
 * Reads a measurement out of k6's end-of-test summary metrics: the whole test,
 * and each backend's part from the submetrics `perf-unsigned-get.k6.js` tags
 * by backend (`http_reqs{backend:fs}` and so on).
 * @param options {object}
 * @param options.metrics {Record<string, { values: Record<string, number> }>}
 * @param options.backends {ServerBackendId[]}   the backends the test's pool
 *   spans; none for a pool on the server's default backend
 * @returns {Measurement}
 */
export function k6Measurement({
  metrics,
  backends
}: {
  metrics: Record<string, { values: Record<string, number> } | undefined>
  backends: ServerBackendId[]
}): Measurement {
  const read = (tag: string): Measurement => ({
    rate: metrics[`http_reqs${tag}`]?.values.rate ?? 0,
    avgMs: metrics[`http_req_duration${tag}`]?.values.avg,
    failed: metrics[`checks${tag}`]?.values.fails ?? 0
  })
  const measurement = read('')
  if (backends.length === 0) {
    return measurement
  }
  const byBackend: Partial<Record<ServerBackendId, Measurement>> = {}
  for (const backend of backends) {
    byBackend[backend] = read(`{backend:${backend}}`)
  }
  return { ...measurement, byBackend }
}

/**
 * How close a largest/smallest rate ratio has to be to 1 to read as flat.
 */
const flatRatioBand = 0.15

/**
 * Compares each test's rate at the smallest size against the largest, and
 * reports which tests slow down with Collection size, which stayed flat, and
 * any failures anywhere in the run. A test with a skipped (no k6) cell at
 * either endpoint is left out of the comparison -- there is no rate to
 * compare.
 * @param options {object}
 * @param options.sizes {number[]}
 * @param options.pivoted {PivotedRow[]}
 * @returns {string[]} one line per entry, ready to join with `\n`
 */
export function formatScalingSummary({
  sizes,
  pivoted
}: {
  sizes: number[]
  pivoted: PivotedRow[]
}): string[] {
  const smallest = sizes[0]
  const largest = sizes.at(-1) as number
  const changed: Array<{ test: string; factor: number; line: string }> = []
  const flat: string[] = []
  const failures: string[] = []

  for (const { test, cells } of pivoted) {
    cells.forEach((cell, index) => {
      if (cell !== undefined && typeof cell !== 'string' && cell.failed > 0) {
        failures.push(`${test} size ${sizes[index]}: ${cell.failed} failed`)
      }
    })
    const smallCell = cells[0]
    const largeCell = cells.at(-1)
    if (
      smallCell === undefined ||
      largeCell === undefined ||
      typeof smallCell === 'string' ||
      typeof largeCell === 'string'
    ) {
      continue
    }
    const factor = largeCell.rate / smallCell.rate
    if (factor >= 1 - flatRatioBand && factor <= 1 + flatRatioBand) {
      flat.push(test)
      continue
    }
    const direction = factor < 1 ? 'slower' : 'faster'
    const spoken = factor < 1 ? 1 / factor : factor
    changed.push({
      test,
      factor,
      line:
        `${test}: ${formatNumber(smallCell.rate, 1)} -> ` +
        `${formatNumber(largeCell.rate, 1)} req/s, ` +
        `${formatNumber(spoken, 1)}x ${direction}`
    })
  }
  changed.sort((left, right) => left.factor - right.factor)

  const lines = [`Smallest size (${smallest}) to largest (${largest}):`]
  for (const { line } of changed) {
    lines.push(`- ${line}`)
  }
  if (flat.length > 0) {
    lines.push(`- ${flat.join(', ')}: roughly flat`)
  }
  lines.push('')
  lines.push(
    failures.length > 0 ? `Failures: ${failures.join('; ')}` : 'Failures: none'
  )
  return lines
}

/**
 * Formats the run's CPU model, core count, and total RAM for the printed
 * header, so two compared runs can be checked for a matching environment at a
 * glance.
 * @param options {object}
 * @param options.cpuModel {string}
 * @param options.cores {number}
 * @param options.totalMemoryBytes {number}
 * @returns {string}
 */
export function formatMachine({
  cpuModel,
  cores,
  totalMemoryBytes
}: {
  cpuModel: string
  cores: number
  totalMemoryBytes: number
}): string {
  const gib = totalMemoryBytes / 1024 ** 3
  return `${cpuModel}, ${cores} cores, ${gib.toFixed(1)} GB RAM`
}

/**
 * How many Resources a fresh fill writes into the Collection-size Spaces: a
 * public and a private Collection per size and three Collections per edge
 * size, each filled to its size, once per pool member.
 * @param options {object}
 * @param options.sizes {number[]}
 * @param options.edgeSizes {number[]}
 * @param [options.poolSize] {number}   1 by default
 * @returns {number}
 */
export function seedResourceCount({
  sizes,
  edgeSizes,
  poolSize = 1
}: {
  sizes: number[]
  edgeSizes: number[]
  poolSize?: number
}): number {
  const sum = (values: number[]) =>
    values.reduce((total, value) => total + value, 0)
  return poolSize * (2 * sum(sizes) + 3 * sum(edgeSizes))
}

/**
 * Estimates how long a run takes with the given settings. Filling Collections
 * and the delete tests' untimed refills are the parts that vary most, so they
 * are priced at a representative signed-write rate (25 writes/s, from a prior
 * default-settings run).
 * @param options {object}
 * @param options.sizes {number[]}
 * @param options.edgeSizes {number[]}
 * @param options.durationSeconds {number}
 * @param options.serialWrites {number}
 * @param options.withK6 {boolean}
 * @param [options.matrix] {boolean}   whether the payload matrix runs too: 9
 *   reads (3 of them through k6) and 9 writes, the 6 binary writes with an
 *   untimed delete after each round, priced at half the test's length
 * @param [options.poolSize] {number}   the Collections each test spreads its
 *   load over, each one filled; 1 by default
 * @returns {number} minutes, rounded up
 */
export function estimateMinutes({
  sizes,
  edgeSizes,
  durationSeconds,
  serialWrites,
  warmUpWrites,
  pauseMs,
  withK6,
  filling,
  matrix = false,
  poolSize = 1
}: {
  sizes: number[]
  edgeSizes: number[]
  durationSeconds: number
  serialWrites: number
  warmUpWrites: number
  pauseMs: number
  withK6: boolean
  filling: boolean
  matrix?: boolean
  poolSize?: number
}): number {
  const writesPerSecond = 25
  const filled = filling ? seedResourceCount({ sizes, edgeSizes, poolSize }) : 0
  const matrixTests = matrix ? (withK6 ? 9 : 6) + 9 : 0
  const matrixCleanupSeconds = matrix ? 6 * durationSeconds * 0.5 : 0
  const loadTests =
    (withK6 ? 2 * sizes.length : 0) +
    sizes.length +
    2 * edgeSizes.length +
    matrixTests
  // a delete round refills its Resources at the write rate, about twice as slow
  // as it deletes them
  const refillSeconds = edgeSizes.length * durationSeconds * 1.8
  const serialSeconds =
    (edgeSizes.length * (warmUpWrites + serialWrites)) / writesPerSecond
  const pauseSeconds = ((loadTests + edgeSizes.length + 1) * pauseMs) / 1000
  const seconds =
    filled / writesPerSecond +
    loadTests * durationSeconds +
    refillSeconds +
    serialSeconds +
    matrixCleanupSeconds +
    pauseSeconds
  return Math.ceil(seconds / 60)
}

/**
 * The payload matrix's fixed Space ids: one Space holding the read targets,
 * one taking the timed writes, and one holding `--binary-total-mib` of extra
 * binary data that nothing reads.
 */
export const matrixSpaceIds = {
  read: 'perf-matrix-read',
  write: 'perf-matrix-write',
  ballast: 'perf-ballast'
} as const

/**
 * The matrix categories, each one a Collection of that id in both the read
 * and the write Space.
 */
export const matrixCategories = ['public', 'plaintext', 'encrypted'] as const

export type MatrixCategory = (typeof matrixCategories)[number]

/**
 * The matrix payloads. In the public and plaintext Collections each read
 * target's Resource id is the payload name; the encrypted Collection's ids
 * are EDV ids minted at seed time.
 */
export const matrixPayloads = ['json', 'small', 'large'] as const

export type MatrixPayload = (typeof matrixPayloads)[number]

/**
 * The encrypted read targets' EDV ids, by payload, for each payload the seed
 * wrote. The seed writes the same payloads in every category, so these keys
 * are also the payloads the matrix runs.
 */
export type EncryptedReadIds = Partial<Record<MatrixPayload, string>>

/**
 * Parses a `--payloads` value (comma-separated payload names) into the
 * matrix payloads it names, in the matrix's own order.
 * @param value {string}
 * @returns {MatrixPayload[]}
 */
export function parsePayloads(value: string): MatrixPayload[] {
  const names = value.split(',').map(name => name.trim())
  for (const name of names) {
    if (!(matrixPayloads as readonly string[]).includes(name)) {
      throw new Error(
        `Unknown payload "${name}"; expected some of ${matrixPayloads.join(', ')}.`
      )
    }
  }
  return matrixPayloads.filter(payload => names.includes(payload))
}

/**
 * Whether a value read back from a `seed-meta.json` is the encrypted read
 * targets' EDV ids: a string per matrix payload.
 * @param value {unknown}
 * @returns {boolean}
 */
export function isEncryptedIds(
  value: unknown
): value is Record<MatrixPayload, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    matrixPayloads.every(
      payload => typeof (value as Record<string, unknown>)[payload] === 'string'
    )
  )
}

/**
 * The small binary payload: under pws-client's 512 KiB threshold, so in an
 * encrypted Collection it is one EDV document.
 */
export const smallFileBytes = 100 * 1024

/**
 * The large binary payload: over the 512 KiB threshold, so in an encrypted
 * Collection it is one EDV document plus ten 1 MiB chunks.
 */
export const largeFileBytes = 10 * 1024 * 1024

/**
 * How many writes a seed runs at once, over signed HTTP or through a backend.
 */
export const seedConcurrency = 10

/**
 * The three Spaces each edge size gets, as `<label>-<size>`, by the test that
 * uses it: the signed write test, the signed delete test, and the serial
 * writes.
 */
export const edgeSpaceLabels = {
  write: 'perf-write',
  remove: 'perf-delete',
  serial: 'perf-serial'
} as const

/**
 * What a seed script is about to write, printed before it starts: where, then
 * the Collection sizes, the payload matrix and the ballast, each with the flag
 * that changes it.
 * @param options {object}
 * @param options.target {string}   where the seed goes, with its flags
 * @param options.sizes {number[]}
 * @param options.ballast {string}   the ballast line
 * @returns {string}
 */
export function formatSeedPlan({
  target,
  sizes,
  ballast
}: {
  target: string
  sizes: number[]
  ballast: string
}): string {
  return [
    `Seeding ${target}, replacing what it holds:`,
    `- Collection sizes: ${sizes.join(', ')} Resources (--sizes)`,
    '- Payload matrix: a JSON credential, a 100 KiB file and a 10 MiB file, ' +
      'in public, plaintext and encrypted Collections',
    `- Binary ballast: ${ballast}`,
    ''
  ].join('\n')
}

/**
 * The ids `vc-1` to `vc-<count>`.
 * @param count {number}
 * @returns {string[]}
 */
export function itemIds(count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `vc-${index + 1}`)
}

/**
 * The body every seeded Resource carries, whether seeded over signed HTTP
 * (`pnpm perf:fs`) or written directly through the backend
 * (`pnpm perf:fs:seed`, `pnpm perf:pg:seed`).
 * @param id {string}
 * @returns {object}
 */
export function credential(id: string): object {
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    type: ['VerifiableCredential'],
    issuer: 'did:key:z6MkExampleIssuer',
    validFrom: '2026-01-01T00:00:00Z',
    credentialSubject: { id: 'did:key:z6MkExampleSubject', name: id }
  }
}

/**
 * Writes one id at a time per worker, `concurrency` workers sharing one
 * iterator so each id is written exactly once. `pnpm perf:fs` and the seed
 * scripts share this shape but differ in how a single id gets written
 * (a signed HTTP `Collection.put` versus a direct backend `writeResource`),
 * so `write` is the seam between them.
 * @param options {object}
 * @param options.ids {string[]}
 * @param options.concurrency {number}
 * @param options.write {(id: string) => Promise<unknown>}
 * @returns {Promise<void>}
 */
export async function fillConcurrently({
  ids,
  concurrency,
  write
}: {
  ids: string[]
  concurrency: number
  write: (id: string) => Promise<unknown>
}): Promise<void> {
  const pending = ids.values()
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (const id of pending) {
        await write(id)
      }
    })
  )
}

/**
 * `err` and each error along its `cause` chain, outermost first, up to 10:
 * pws-client rethrows the transport's error as the `cause` of its own
 * `PwsError`.
 * @param err {unknown}
 * @returns {{ name?: unknown, message?: unknown, code?: unknown, requestUrl?: unknown }[]}
 */
function causeChain(err: unknown): {
  name?: unknown
  message?: unknown
  code?: unknown
  requestUrl?: unknown
}[] {
  const chain = []
  for (
    let link = err;
    typeof link === 'object' && link !== null && chain.length < 10;
    link = (link as { cause?: unknown }).cause
  ) {
    chain.push(link)
  }
  return chain
}

/**
 * The network faults `retryOnNetworkFault` runs a request again on, in the
 * order a report lists them.
 */
export const networkFaults = [
  'timed out',
  'never connected',
  'dropped'
] as const

export type NetworkFault = (typeof networkFaults)[number]

/**
 * The fault each undici and Node error code marks: a connection that never
 * opened (`UND_ERR_CONNECT_TIMEOUT`), or one that closed before the response
 * was read in full (`UND_ERR_SOCKET`, `ECONNRESET`; fetch reports it as
 * `terminated` once the headers arrived).
 */
const faultByCode = new Map<string, NetworkFault>([
  ['UND_ERR_CONNECT_TIMEOUT', 'never connected'],
  ['UND_ERR_SOCKET', 'dropped'],
  ['ECONNRESET', 'dropped']
])

/**
 * How many times `retryOnNetworkFault` has run a request again in this
 * process, by the fault that made it.
 */
const retriedFaults = new Map<NetworkFault, number>()

/**
 * The network fault along `err`'s cause chain: ky's `TimeoutError`, or an
 * error whose code `faultByCode` lists.
 * @param err {unknown}
 * @returns {NetworkFault | undefined}   undefined for any other error
 */
function networkFault(err: unknown): NetworkFault | undefined {
  for (const { name, code } of causeChain(err)) {
    if (name === 'TimeoutError') {
      return 'timed out'
    }
    const fault = typeof code === 'string' ? faultByCode.get(code) : undefined
    if (fault !== undefined) {
      return fault
    }
  }
  return undefined
}

/**
 * Runs an untimed, idempotent setup request (a seed write, a create, a
 * refill, a warm-up), running it again on a network fault, up to `attempts`
 * times in all. Over a long network path, a response now and then never
 * arrives although the server answered it, and pws-client gives a request
 * 10 s (ky's `TimeoutError`). Over some paths a third of new connections never
 * open either (undici's `UND_ERR_CONNECT_TIMEOUT`), and pws-client's timeout
 * often fires first, so the two cannot be told apart, and now and then a
 * connection closes partway through a response (`UND_ERR_SOCKET`,
 * `ECONNRESET`). All of them share the attempts; a run opens many
 * connections, so three would not carry it through. Any other error, and a
 * fault on the last attempt, is thrown. Each retry is counted, by its fault,
 * for `retriedFaultCounts`. A timed request is never retried: it counts as a
 * failure.
 * @param options {object}
 * @param options.op {() => Promise<Result>}
 * @param [options.attempts] {number}   8 by default
 * @returns {Promise<Result>}
 */
export async function retryOnNetworkFault<Result>({
  op,
  attempts = 8
}: {
  op: () => Promise<Result>
  attempts?: number
}): Promise<Result> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await op()
    } catch (err) {
      const fault = networkFault(err)
      if (fault === undefined || attempt >= attempts) {
        throw err
      }
      retriedFaults.set(fault, (retriedFaults.get(fault) ?? 0) + 1)
    }
  }
}

/**
 * How many times `retryOnNetworkFault` has run a request again in this
 * process so far, by the fault that made it.
 * @returns {Map<NetworkFault, number>}   a copy, holding only faults retried
 *   at least once
 */
export function retriedFaultCounts(): Map<NetworkFault, number> {
  return new Map(retriedFaults)
}

/**
 * The retries `counts` holds, for a report header: the total and each
 * fault's share, e.g. `37 (21 timed out, 14 never connected, 2 dropped)`, or
 * `none`.
 * @param counts {ReadonlyMap<NetworkFault, number>}
 * @returns {string}
 */
export function formatRetries(
  counts: ReadonlyMap<NetworkFault, number>
): string {
  const retried = networkFaults.flatMap(fault => {
    const count = counts.get(fault) ?? 0
    return count > 0 ? [{ fault, count }] : []
  })
  if (retried.length === 0) {
    return 'none'
  }
  const total = retried.reduce((sum, { count }) => sum + count, 0)
  const shares = retried.map(({ fault, count }) => `${count} ${fault}`)
  return `${total} (${shares.join(', ')})`
}

/**
 * `err`'s message, followed by what its `cause` chain adds (each cause's
 * message and code) and the URL it was requesting, so a transport failure
 * that pws-client reports as a bare `terminated` or `fetch failed` says what
 * happened, e.g.
 * `terminated (other side closed, UND_ERR_SOCKET) requesting "https://..."`.
 * @param err {unknown}
 * @returns {string}
 */
export function describeError(err: unknown): string {
  const [outer, ...causes] = causeChain(err)
  const message = String(outer?.message ?? err)
  const details: string[] = []
  for (const { message: causeMessage, code } of causes) {
    for (const detail of [causeMessage, code]) {
      if (
        typeof detail === 'string' &&
        detail !== '' &&
        detail !== message &&
        !details.includes(detail)
      ) {
        details.push(detail)
      }
    }
  }
  const requestUrl = [outer, ...causes]
    .map(link => link?.requestUrl)
    .find(url => typeof url === 'string')
  return [
    message,
    ...(details.length > 0 ? [`(${details.join(', ')})`] : []),
    ...(requestUrl !== undefined && !message.includes(requestUrl)
      ? [`requesting "${requestUrl}"`]
      : [])
  ].join(' ')
}

/**
 * Completed and failed requests, and the summed latency of the completed
 * ones.
 */
interface TallyCount {
  completed: number
  failed: number
  totalMs: number
}

/**
 * A count as a measurement over `elapsedMs` of timed work.
 * @param options {object}
 * @param options.count {TallyCount}
 * @param options.elapsedMs {number}
 * @returns {Measurement}
 */
function measure({
  count: { completed, failed, totalMs },
  elapsedMs
}: {
  count: TallyCount
  elapsedMs: number
}): Measurement {
  return {
    rate: completed / (elapsedMs / 1000),
    avgMs: completed ? totalMs / completed : undefined,
    failed
  }
}

/**
 * The running count behind every load harness, kept per backend.
 */
class Tally {
  #counts = new Map<ServerBackendId | undefined, TallyCount>()

  /**
   * Runs `op`, counting it as completed (with its latency) or failed, under
   * the backend of the Collection it went to.
   * @param op {() => Promise<unknown>}
   * @param [backend] {ServerBackendId}
   * @returns {Promise<boolean>} whether it completed
   */
  async time(
    op: () => Promise<unknown>,
    backend?: ServerBackendId
  ): Promise<boolean> {
    let count = this.#counts.get(backend)
    if (count === undefined) {
      count = { completed: 0, failed: 0, totalMs: 0 }
      this.#counts.set(backend, count)
    }
    const sent = performance.now()
    try {
      await op()
      count.completed++
      count.totalMs += performance.now() - sent
      return true
    } catch {
      count.failed++
      return false
    }
  }

  /**
   * The tally as a measurement over `elapsedMs` of timed work, with each
   * backend's part when any request went to a Collection that named one.
   * @param elapsedMs {number}
   * @returns {Measurement}
   */
  measurement(elapsedMs: number): Measurement {
    const total: TallyCount = { completed: 0, failed: 0, totalMs: 0 }
    const byBackend: Partial<Record<ServerBackendId, Measurement>> = {}
    for (const [backend, count] of this.#counts) {
      total.completed += count.completed
      total.failed += count.failed
      total.totalMs += count.totalMs
      if (backend !== undefined) {
        byBackend[backend] = measure({ count, elapsedMs })
      }
    }
    const measurement = measure({ count: total, elapsedMs })
    return Object.keys(byBackend).length > 0
      ? { ...measurement, byBackend }
      : measurement
  }
}

/**
 * The worker indexes `0` to `clients - 1`.
 * @param clients {number}
 * @returns {number[]}
 */
function workerIndexes(clients: number): number[] {
  return Array.from({ length: clients }, (_unused, worker) => worker)
}

/**
 * Runs `op` from `clients` concurrent clients until `durationSeconds` have
 * elapsed, reporting requests per second, average latency, and failures. Each
 * client sends one request at a time, moving to the next as soon as the
 * previous one settles. Successive requests, across every client, go to
 * successive members of `pool` round-robin, so each member takes the same
 * share of the load.
 * @param options {object}
 * @param options.clients {number}
 * @param options.durationSeconds {number}
 * @param options.pool {Target[]}   what each request goes to; a member's
 *   `backend` keys its part of the measurement
 * @param options.op {(target: Target, worker: number, count: number) => Promise<unknown>}
 * @returns {Promise<Measurement>}
 */
export async function load<Target extends { backend?: ServerBackendId }>({
  clients,
  durationSeconds,
  pool,
  op
}: {
  clients: number
  durationSeconds: number
  pool: readonly Target[]
  op: (target: Target, worker: number, count: number) => Promise<unknown>
}): Promise<Measurement> {
  const tally = new Tally()
  const started = performance.now()
  const deadline = started + durationSeconds * 1000
  let sent = 0
  await Promise.all(
    workerIndexes(clients).map(async worker => {
      for (let count = 0; performance.now() < deadline; count++) {
        const target = roundRobin({ pool, index: sent++ })
        await tally.time(() => op(target, worker, count), target.backend)
      }
    })
  )
  return tally.measurement(performance.now() - started)
}

/**
 * A minimal `PwsClient`-shaped dependency: the base server URL the client is
 * built from, and the signed-request escape hatch `deleteLoad` and
 * `serialWriteLoad` need.
 */
export interface RequestingClient {
  readonly baseServerUrl?: string
  request(options: {
    url: string
    method: string
    json?: object
  }): Promise<unknown>
}

/**
 * The absolute URL of a server path (`/space/...`) on the server `pws` is
 * built from.
 * @param options {object}
 * @param options.pws {RequestingClient}
 * @param options.path {string}
 * @returns {string}
 */
export function serverPathUrl({
  pws,
  path
}: {
  pws: RequestingClient
  path: string
}): string {
  if (pws.baseServerUrl === undefined) {
    throw new Error(
      `Cannot resolve ${path}: the client was built with no base server URL.`
    )
  }
  return absoluteUrl({ path, serverUrl: pws.baseServerUrl })
}

/**
 * Timed work from `clients` concurrent clients, in rounds: each round runs
 * `round` once, which returns how long its timed part took. Rounds repeat
 * until the timed parts add up to `durationSeconds`.
 * @param options {object}
 * @param options.durationSeconds {number}
 * @param options.round {(round: number) => Promise<number>}
 * @returns {Promise<number>} the summed timed milliseconds
 */
async function timedRounds({
  durationSeconds,
  round
}: {
  durationSeconds: number
  round: (round: number) => Promise<number>
}): Promise<number> {
  let timedMs = 0
  for (let index = 0; timedMs < durationSeconds * 1000; index++) {
    timedMs += await round(index)
  }
  return timedMs
}

/**
 * Signed deletes from `clients` concurrent clients, in rounds: each round
 * re-creates every client's `deleteRoundSize` Resources (untimed,
 * `seedConcurrency` at a time, so many clients don't burst the server with
 * `clients * deleteRoundSize` writes at once), then each
 * client deletes its own (timed). Rounds repeat until the timed part reaches
 * `durationSeconds`. The ids repeat every round, so each Collection stays
 * within `clients * deleteRoundSize` Resources of its starting size. A
 * round's ids, client by client, go to successive members of `pool`
 * round-robin, and the refill writes each one where its delete goes.
 * @param options {object}
 * @param options.clients {number}
 * @param options.durationSeconds {number}
 * @param options.deleteRoundSize {number}
 * @param options.pws {RequestingClient}
 * @param options.pool {object[]}   each Collection's path and backend, and a
 *   minimal `Collection`-shaped dependency: just the write this needs to
 *   refill the Resources it is about to delete
 * @returns {Promise<Measurement>}
 */
export async function deleteLoad({
  clients,
  durationSeconds,
  deleteRoundSize,
  pws,
  pool
}: {
  clients: number
  durationSeconds: number
  deleteRoundSize: number
  pws: RequestingClient
  pool: ReadonlyArray<
    PoolTarget & {
      collection: { put(resourceId: string, data: unknown): Promise<unknown> }
    }
  >
}): Promise<Measurement> {
  const idsOf = (worker: number) =>
    Array.from(
      { length: deleteRoundSize },
      (_unused, index) => `del-${worker}-${index}`
    )
  const workers = workerIndexes(clients)
  const targetOf = new Map(
    workers
      .flatMap(idsOf)
      .map((id, index) => [id, roundRobin({ pool, index })] as const)
  )
  const tally = new Tally()
  const timedMs = await timedRounds({
    durationSeconds,
    round: async () => {
      await fillConcurrently({
        ids: [...targetOf.keys()],
        concurrency: seedConcurrency,
        write: id =>
          retryOnNetworkFault({
            op: () => targetOf.get(id)!.collection.put(id, { resourceId: id })
          })
      })
      const started = performance.now()
      await Promise.all(
        workers.map(async worker => {
          for (const id of idsOf(worker)) {
            const { path, backend } = targetOf.get(id)!
            const url = serverPathUrl({ pws, path: `${path}/${id}` })
            await tally.time(
              () => pws.request({ url, method: 'DELETE' }),
              backend
            )
          }
        })
      )
      return performance.now() - started
    }
  })
  return tally.measurement(timedMs)
}

/**
 * Timed creates with an untimed cleanup, from `clients` concurrent clients,
 * in rounds: each round every client runs `create` once (timed, together),
 * then `remove` for what it created (untimed). Rounds repeat until the timed
 * part reaches `durationSeconds`, so the stored data never grows past one
 * round's worth, however large each create is. A failed create counts as a
 * failure and is not removed. Successive creates, client by client and round
 * by round, go to successive members of `pool` round-robin, and each remove
 * goes where its create went.
 * @param options {object}
 * @param options.clients {number}
 * @param options.durationSeconds {number}
 * @param options.pool {Target[]}   a member's `backend` keys its part of the
 *   measurement
 * @param options.create {(target: Target, worker: number, round: number) => Promise<unknown>}
 * @param options.remove {(target: Target, worker: number, round: number) => Promise<unknown>}
 * @returns {Promise<Measurement>}
 */
export async function createDeleteLoad<
  Target extends { backend?: ServerBackendId }
>({
  clients,
  durationSeconds,
  pool,
  create,
  remove
}: {
  clients: number
  durationSeconds: number
  pool: readonly Target[]
  create: (target: Target, worker: number, round: number) => Promise<unknown>
  remove: (target: Target, worker: number, round: number) => Promise<unknown>
}): Promise<Measurement> {
  const workers = workerIndexes(clients)
  const tally = new Tally()
  const timedMs = await timedRounds({
    durationSeconds,
    round: async round => {
      const targetOf = (worker: number) =>
        roundRobin({ pool, index: round * clients + worker })
      const created: number[] = []
      const started = performance.now()
      await Promise.all(
        workers.map(async worker => {
          const target = targetOf(worker)
          if (
            await tally.time(
              () => create(target, worker, round),
              target.backend
            )
          ) {
            created.push(worker)
          }
        })
      )
      const elapsedMs = performance.now() - started
      await Promise.all(
        created.map(worker =>
          remove(targetOf(worker), worker, round).catch(() => undefined)
        )
      )
      return elapsedMs
    }
  })
  return tally.measurement(timedMs)
}

/**
 * One client writing `serialWrites` new Resources in a row, after
 * `warmUpWrites` untimed warm-up writes. Successive writes, the warm-up ones
 * too, go to successive members of `pool` round-robin.
 * @param options {object}
 * @param options.pws {RequestingClient}
 * @param options.pool {PoolTarget[]}
 * @param options.warmUpWrites {number}
 * @param options.serialWrites {number}
 * @returns {Promise<Measurement>}
 */
export async function serialWriteLoad({
  pws,
  pool,
  warmUpWrites,
  serialWrites
}: {
  pws: RequestingClient
  pool: readonly PoolTarget[]
  warmUpWrites: number
  serialWrites: number
}): Promise<Measurement> {
  for (let index = 0; index < warmUpWrites; index++) {
    const { path } = roundRobin({ pool, index })
    await retryOnNetworkFault({
      op: () =>
        pws.request({
          url: serverPathUrl({ pws, path: `${path}/warm-${index}` }),
          method: 'PUT',
          json: { index }
        })
    })
  }
  const tally = new Tally()
  const started = performance.now()
  for (let index = 0; index < serialWrites; index++) {
    const { path, backend } = roundRobin({ pool, index })
    const url = serverPathUrl({ pws, path: `${path}/s-${index}` })
    await tally.time(
      () => pws.request({ url, method: 'PUT', json: { index } }),
      backend
    )
  }
  return tally.measurement(performance.now() - started)
}

/**
 * Writes one Resource per id directly through the backend, several at a
 * time, with `[createdBy]` as each Resource's `createdBy`.
 * @param options {object}
 * @param options.backend {StorageBackend}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.ids {string[]}
 * @param options.createdBy {`did:${string}`}
 * @returns {Promise<void>}
 */
async function fillThroughBackend({
  backend,
  spaceId,
  collectionId,
  ids,
  createdBy
}: {
  backend: StorageBackend
  spaceId: string
  collectionId: string
  ids: string[]
  createdBy: `did:${string}`
}): Promise<void> {
  await fillConcurrently({
    ids,
    concurrency: seedConcurrency,
    write: id =>
      backend.writeResource({
        spaceId,
        collectionId,
        resourceId: id,
        input: {
          kind: 'json',
          contentType: 'application/json',
          data: credential(id)
        },
        createdBy: [createdBy]
      })
  })
}

/**
 * Creates one Space with one Collection, filled to `size`, directly through
 * the backend.
 * @param options {object}
 * @param options.backend {StorageBackend}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.size {number}
 * @param options.controller {`did:${string}`}
 * @param options.makePublic {boolean}
 * @returns {Promise<void>}
 */
async function seedSpaceThroughBackend({
  backend,
  spaceId,
  collectionId,
  size,
  controller,
  makePublic
}: {
  backend: StorageBackend
  spaceId: string
  collectionId: string
  size: number
  controller: `did:${string}`
  makePublic: boolean
}): Promise<void> {
  await backend.writeSpace({
    spaceId,
    spaceMetadata: { id: spaceId, type: ['Space'], controller },
    createdBy: [controller]
  })
  await backend.writeCollection({
    spaceId,
    collectionId,
    collectionMetadata: { id: collectionId, type: ['Collection'] },
    createdBy: [controller]
  })
  await fillThroughBackend({
    backend,
    spaceId,
    collectionId,
    ids: itemIds(size),
    createdBy: controller
  })
  if (makePublic) {
    await backend.writePolicy({
      spaceId,
      collectionId,
      policy: { type: 'PublicCanRead' }
    })
  }
}

/**
 * Seeds, directly through `backend`, every Collection-size Space the runners
 * test, under the fixed ids `seededTargets` (in `perf-runner.ts`) reads back:
 * a `perf-public` Space (one public Collection per size), a `perf-private`
 * Space (one private Collection per size), and three Spaces per edge size
 * (`perf-write-<size>`, `perf-delete-<size>`, `perf-serial-<size>`), each
 * with a single `items` Collection. Every record is written under
 * `controller`, which is what a real signed write over HTTP would have
 * produced: `createdBy` (`[controller]`, a root invocation's list) and
 * `controller` match what the request handlers set from `createdByOf`.
 * @param options {object}
 * @param options.backend {StorageBackend}
 * @param options.sizes {number[]}
 * @param options.edgeSizes {number[]}
 * @param options.controller {`did:${string}`}
 * @returns {Promise<void>}
 */
export async function seedSizeSpaces({
  backend,
  sizes,
  edgeSizes,
  controller
}: {
  backend: StorageBackend
  sizes: number[]
  edgeSizes: number[]
  controller: `did:${string}`
}): Promise<void> {
  for (const size of sizes) {
    for (const [spaceId, makePublic] of [
      ['perf-public', true],
      ['perf-private', false]
    ] as const) {
      await seedSpaceThroughBackend({
        backend,
        spaceId,
        collectionId: `c-${size}`,
        size,
        controller,
        makePublic
      })
    }
  }
  for (const size of edgeSizes) {
    for (const label of Object.values(edgeSpaceLabels)) {
      await seedSpaceThroughBackend({
        backend,
        spaceId: `${label}-${size}`,
        collectionId: 'items',
        size,
        controller,
        makePublic: false
      })
    }
  }
}

/**
 * The shape version of a run record, raised when the shape changes, so a
 * file written before the change can be told apart.
 */
export const runRecordSchema = 1

/**
 * One measurement in a run record: a size test at one Collection size, or a
 * payload-matrix read or write, either as the whole test (`backend: 'all'`)
 * or as one backend's part of it. A skipped test carries the skip reason
 * instead of numbers.
 */
export interface RunResult {
  suite: 'sizes' | 'matrix'
  test: string
  size?: number
  category?: MatrixCategory
  payload?: MatrixPayload
  backend: 'all' | ServerBackendId
  rate?: number
  avg_ms?: number | null
  failed?: number
  skipped?: string
}

/**
 * The id a run record names a size test by: its report label in kebab case
 * (`Signed read` is `signed-read`), except the serial-write test, whose label
 * carries the `--writes` count (`Write, 1 client (100 in a row)`). Its id
 * leaves the count to the record's settings, so changing the flag doesn't
 * split the test's series in two.
 * @param test {string}   the report label
 * @returns {string}
 */
export function sizeTestId(test: string): string {
  return test.startsWith('Write, 1 client')
    ? 'serial-write'
    : test.toLowerCase().replaceAll(' ', '-')
}

/**
 * One test's result as run-record entries: the whole test, then the part of
 * each of `backends` that answered any of its requests, each carrying
 * `fields`. A skipped test is one entry.
 * @param options {object}
 * @param options.fields {Pick<RunResult, 'suite' | 'test' | 'size' | 'category' | 'payload'>}
 * @param options.result {Measurement | string}
 * @param options.backends {ServerBackendId[]}
 * @returns {RunResult[]}
 */
function resultEntries({
  fields,
  result,
  backends
}: {
  fields: Pick<RunResult, 'suite' | 'test' | 'size' | 'category' | 'payload'>
  result: Measurement | string
  backends: ServerBackendId[]
}): RunResult[] {
  if (typeof result === 'string') {
    return [{ ...fields, backend: 'all', skipped: result }]
  }
  const entry = (
    backend: RunResult['backend'],
    { rate, avgMs, failed }: Measurement
  ): RunResult => ({ ...fields, backend, rate, avg_ms: avgMs ?? null, failed })
  return [
    entry('all', result),
    ...backends.flatMap(backend => {
      const part = result.byBackend?.[backend]
      return part === undefined ? [] : [entry(backend, part)]
    })
  ]
}

/**
 * A run's measurements as the `results` of its run record, in the order the
 * run made them: the size tests, then the payload matrix, each cell's read
 * before its write. Each gets an entry per backend in `backends`, as the
 * report gets a table per backend: a run on one backend has none, since its
 * part would repeat the whole test.
 * @param options {object}
 * @param options.rows {Row[]}
 * @param options.matrixRows {MatrixRow[]}
 * @param [options.backends] {ServerBackendId[]}   the backends to give
 *   entries of their own, in order; none by default
 * @returns {RunResult[]}
 */
export function runResults({
  rows,
  matrixRows,
  backends = []
}: {
  rows: Row[]
  matrixRows: MatrixRow[]
  backends?: ServerBackendId[]
}): RunResult[] {
  return [
    ...rows.flatMap(({ test, size, result }) =>
      resultEntries({
        fields: { suite: 'sizes', test: sizeTestId(test), size },
        result,
        backends
      })
    ),
    ...matrixRows.flatMap(({ category, payload, read, write }) => [
      ...resultEntries({
        fields: { suite: 'matrix', test: 'read', category, payload },
        result: read,
        backends
      }),
      ...resultEntries({
        fields: { suite: 'matrix', test: 'write', category, payload },
        result: write,
        backends
      })
    ])
  ]
}

/**
 * The server version and build time a `/health` body reports
 * (`{ status, version, commit, builtAt }`), each null when it is absent: a
 * server with version disclosure off (`WAS_DISCLOSE_VERSION`) reports
 * neither, and one running from source, with no `dist/build-info.json`, has
 * no build time.
 * @param body {unknown}   the parsed body, or undefined if it wasn't JSON
 * @returns {{ version: string | null, builtAt: string | null }}
 */
export function healthBuild(body: unknown): {
  version: string | null
  builtAt: string | null
} {
  const field = (name: string): string | null => {
    const value =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)[name]
        : undefined
    return typeof value === 'string' ? value : null
  }
  return { version: field('version'), builtAt: field('builtAt') }
}

/**
 * Checks a `--runner` value, which names the folder its run records go in:
 * letters, digits, `.`, `_` and `-`, starting with a letter or digit, so it
 * is one path segment on every filesystem.
 * @param value {string}
 * @returns {string}
 */
export function parseRunner(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(
      `--runner "${value}" must be letters, digits, ".", "_" and "-", ` +
        'starting with a letter or digit, e.g. fly-iad.'
    )
  }
  return value
}

/**
 * Where a run record goes under `--record`'s dir:
 * `<runner>/<host>/<stamp>.json`. The host is `serverUrl`'s, with its port
 * after a `-` (`localhost-4455`), and the stamp is the run's start in UTC
 * with the colons dropped (`2026-10-29T164002Z`), so the names in a folder
 * sort by time and are valid on every filesystem.
 * @param options {object}
 * @param options.dir {string}
 * @param options.runner {string}
 * @param options.serverUrl {string}
 * @param options.startedAt {Date}
 * @returns {string}
 */
export function recordPath({
  dir,
  runner,
  serverUrl,
  startedAt
}: {
  dir: string
  runner: string
  serverUrl: string
  startedAt: Date
}): string {
  const { hostname, port } = new URL(serverUrl)
  const host = port === '' ? hostname : `${hostname}-${port}`
  const stamp = `${startedAt.toISOString().slice(0, 19).replaceAll(':', '')}Z`
  return join(dir, runner, host, `${stamp}.json`)
}
