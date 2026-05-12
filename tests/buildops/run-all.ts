/**
 * Runs all BuildOps API endpoint tests and reports pass/fail/skip.
 *
 * Usage:
 *   npx tsx tests/buildops/run-all.ts              # read-only tests
 *   npx tsx tests/buildops/run-all.ts --writes     # include write/mutate tests
 *   npx tsx tests/buildops/run-all.ts --slow       # include getcustomers full-sync (slow)
 *   npx tsx tests/buildops/run-all.ts --writes --slow
 *
 * Add these to .env for tests that need specific data:
 *   TEST_CUSTOMER_PHONE=    10-digit phone of any known customer (used by several tests)
 *   TEST_CUSTOMER_ID=       BuildOps customer UUID (for get_customer_by_id)
 *   TEST_REP_CELL_PHONE=    Cell phone to register on the test customer (add_representative)
 *   TEST_JOB_ID=            BuildOps job UUID (for create_task)
 */

import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const WRITES = process.argv.includes('--writes');
const SLOW   = process.argv.includes('--slow');

const G = '\x1b[32m';  // green
const R = '\x1b[31m';  // red
const Y = '\x1b[33m';  // yellow
const B = '\x1b[1m';   // bold
const X = '\x1b[0m';   // reset

type TestCase = {
  name: string;
  file: string;
  args: () => string[];
  requires?: string[];  // env var names that must be non-empty
  writes?: boolean;     // mutates BuildOps data — skipped unless --writes
  slow?: boolean;       // takes >10s — skipped unless --slow
};

const TESTS: TestCase[] = [
  // ── No-arg read tests ──────────────────────────────────────────────────────
  {
    name: 'get_all_properties',
    file: 'get_all_properties.ts',
    args: () => [],
  },
  {
    name: 'get_job_types',
    file: 'get_job_types.ts',
    args: () => [],
  },
  {
    name: 'get_department_id',
    file: 'get_department_id.ts',
    args: () => [],
  },

  // ── Tests requiring TEST_CUSTOMER_PHONE ────────────────────────────────────
  {
    name: 'get_customer_properties',
    file: 'get_customer_properties.ts',
    args: () => [process.env.TEST_CUSTOMER_PHONE!],
    requires: ['TEST_CUSTOMER_PHONE'],
  },
  {
    name: 'get_representatives',
    file: 'get_representatives.ts',
    args: () => [process.env.TEST_CUSTOMER_PHONE!],
    requires: ['TEST_CUSTOMER_PHONE'],
  },

  // ── Tests requiring TEST_CUSTOMER_ID ──────────────────────────────────────
  {
    name: 'get_customer_by_id',
    file: 'get_customer_by_id.ts',
    args: () => [process.env.TEST_CUSTOMER_ID!],
    requires: ['TEST_CUSTOMER_ID'],
  },

  // ── Slow tests (skipped unless --slow) ────────────────────────────────────
  {
    name: 'getcustomers (full sync — slow)',
    file: 'getcustomers.ts',
    args: () => [],
    slow: true,
  },

  // ── Write tests (skipped unless --writes) ─────────────────────────────────
  {
    name: 'create_property',
    file: 'create_property.ts',
    args: () => [process.env.TEST_CUSTOMER_PHONE!],
    requires: ['TEST_CUSTOMER_PHONE'],
    writes: true,
  },
  {
    name: 'create_job',
    file: 'create_job.ts',
    // second arg: use env override or fall back to the hardcoded T&M job type
    args: () => [process.env.TEST_CUSTOMER_PHONE!, process.env.TEST_JOB_TYPE ?? '04df1a40-16b1-43f4-aa9b-8eafcec812ad'],
    requires: ['TEST_CUSTOMER_PHONE'],
    writes: true,
  },
  {
    name: 'add_representative',
    file: 'add_representative.ts',
    args: () => [
      process.env.TEST_CUSTOMER_PHONE!,
      process.env.TEST_REP_FIRST_NAME ?? 'Test',
      process.env.TEST_REP_LAST_NAME  ?? 'User',
      process.env.TEST_REP_CELL_PHONE!,
    ],
    requires: ['TEST_CUSTOMER_PHONE', 'TEST_REP_CELL_PHONE'],
    writes: true,
  },
  {
    name: 'create_task',
    file: 'create_task.ts',
    args: () => [process.env.TEST_JOB_ID!, 'Test task from run-all'],
    requires: ['TEST_JOB_ID'],
    writes: true,
  },
  {
    name: 'customer_creation',
    file: 'customer_creation.ts',
    args: () => [],
    writes: true,
  },
];

// ── Runner ────────────────────────────────────────────────────────────────────

const apiDir = path.resolve(__dirname, 'api_endpoints');
const isWin  = process.platform === 'win32';
const npx    = isWin ? 'npx.cmd' : 'npx';

let passed = 0;
let failed = 0;
let skipped = 0;

console.log(`\n${B}BuildOps API tests${X}  ${WRITES ? '[writes on]' : '[read-only]'}  ${SLOW ? '[slow on]' : ''}\n`);

for (const test of TESTS) {
  const label = test.name.padEnd(38);

  if (test.writes && !WRITES) {
    console.log(`${Y}  SKIP${X}  ${label}  --writes not set`);
    skipped++;
    continue;
  }

  if (test.slow && !SLOW) {
    console.log(`${Y}  SKIP${X}  ${label}  --slow not set`);
    skipped++;
    continue;
  }

  const missing = (test.requires ?? []).filter(v => !process.env[v]);
  if (missing.length > 0) {
    console.log(`${Y}  SKIP${X}  ${label}  ${missing.join(', ')} not set in .env`);
    skipped++;
    continue;
  }

  const filePath = path.resolve(apiDir, test.file);
  const start = Date.now();
  const result = spawnSync(npx, ['tsx', filePath, ...test.args()], {
    encoding: 'utf-8',
    env: process.env,
    timeout: test.slow ? 180_000 : 60_000,
    shell: isWin,
  });
  const ms = Date.now() - start;

  if (result.status === 0 && result.error == null) {
    console.log(`${G}  PASS${X}  ${label}  ${ms}ms`);
    passed++;
  } else {
    const reason = result.error?.message ?? `exit ${result.status ?? 'timeout'}`;
    console.log(`${R}  FAIL${X}  ${label}  ${reason}  ${ms}ms`);
    const out = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    if (out) {
      out.split('\n').slice(0, 20).forEach(l => console.log(`         ${l}`));
    }
    failed++;
  }
}

console.log(`\n${B}${passed + failed + skipped} total:  ${G}${passed} passed${X}  ${R}${failed} failed${X}  ${Y}${skipped} skipped${X}${B}${X}\n`);

if (failed > 0) process.exit(1);
