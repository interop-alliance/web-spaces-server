/**
 * Vitest global setup. Reports the suites a run leaves out when
 * `WAS_TEST_DATABASE_URL` is unset, once before the run and once after it, so
 * the notice is not lost above the test output.
 */
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const DATABASE_URL_VARIABLE = 'WAS_TEST_DATABASE_URL'

/**
 * The test files that read the test database URL, found by their source so
 * the list follows the suites.
 * @returns {Promise<string[]>}
 */
async function postgresTestFiles(): Promise<string[]> {
  const testDir = import.meta.dirname
  const names = await readdir(testDir)
  const matches: string[] = []
  for (const name of names.filter(name => name.endsWith('.test.ts')).sort()) {
    const source = await readFile(path.join(testDir, name), 'utf8')
    if (source.includes(DATABASE_URL_VARIABLE)) {
      matches.push(name)
    }
  }
  return matches
}

/**
 * @param files {string[]}
 * @returns {string}
 */
function skipNotice(files: string[]): string {
  return [
    '',
    `WARNING: ${DATABASE_URL_VARIABLE} is unset. This run did NOT cover:`,
    ...files.map(name => `  - test/${name} (Postgres tests skipped)`),
    '  - the hardQuota / exactUsage storage-contract tests (concurrent',
    '    hard quota, count-quota create serialization, count-bytes-once',
    '    races), which no backend in this run supports',
    'Start the Postgres container and run `pnpm test:pg` to include them.',
    ''
  ].join('\n')
}

/**
 * @returns {Promise<(() => void) | undefined>}   the teardown, when there is
 *   something to report
 */
export default async function setup(): Promise<(() => void) | undefined> {
  if (process.env[DATABASE_URL_VARIABLE]) {
    return undefined
  }
  const notice = skipNotice(await postgresTestFiles())
  process.stderr.write(notice)
  return function teardown() {
    process.stderr.write(notice)
  }
}
