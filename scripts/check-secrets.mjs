import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binary = process.env.GITLEAKS_BINARY || 'gitleaks';
const available = spawnSync(binary, ['version'], { stdio: 'ignore' });
if (available.error || available.status !== 0) {
  console.error('Gitleaks is required. Install version 8.30.1 or set GITLEAKS_BINARY.');
  process.exit(2);
}
const temporary = mkdtempSync(join(tmpdir(), 'publish-secret-check-'));
let status = 0;
try {
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root }).toString().split('\0').filter(Boolean);
  for (const name of new Set(files)) {
    const source = join(root, name);
    let stat;
    try { stat = lstatSync(source); } catch { continue; }
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    const target = join(temporary, name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
  const common = ['--redact=100', '--no-banner', '--no-color', '--ignore-gitleaks-allow'];
  const result = spawnSync(binary, ['dir', temporary, ...common], { cwd: root, stdio: 'inherit' });
  status = result.status ?? 2;
  if (process.argv.includes('--history')) {
    const history = spawnSync(binary, ['git', root, '--log-opts=--all', ...common], { cwd: root, stdio: 'inherit' });
    status = status || history.status || (history.error ? 2 : 0);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
process.exitCode = status;
