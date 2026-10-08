// Runs the unit tests and prints UNIT PASS only if they all pass.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MIN_TESTS = 14;
const file = fileURLToPath(new URL('./game.test.mjs', import.meta.url));
const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], { encoding: 'utf8' });
process.stdout.write(run.stdout);
process.stderr.write(run.stderr);

const count = (label) => Number((run.stdout.match(new RegExp(`^# ${label} (\\d+)$`, 'm')) || [])[1] ?? NaN);
const pass = count('pass');
const fail = count('fail');

if (run.status !== 0 || fail !== 0 || !(pass >= MIN_TESTS)) {
  console.error(`unit tests failed: status=${run.status} pass=${pass} fail=${fail} (need >= ${MIN_TESTS} passing)`);
  process.exit(1);
}
console.log(`UNIT PASS (${pass} tests)`);
