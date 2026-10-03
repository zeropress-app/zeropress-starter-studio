import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { devNull } from 'node:os';
import { fileURLToPath } from 'node:url';
import { styleText } from 'node:util';

const projectRoot = new URL('../', import.meta.url);
const packageSpec = 'prettier@3.9.9';

try {
  try {
    await access(new URL('dist/index.html', projectRoot));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error('No built site found in dist/. Run npm run build first.');
  }

  const npm = process.env.npm_execpath;
  if (!npm) throw new Error('Run npm run dist:prettify to format the built HTML.');

  console.log(`[Prettier] Formatting dist/ HTML with ${packageSpec}...`);
  // Run npm through Node so Windows does not need an npx.cmd shell wrapper.
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      npm, 'exec', '--yes', `--package=${packageSpec}`, '--', 'prettier',
      'dist/**/*.html', '--write', '--ignore-path', devNull,
      '--print-width', '2000',
      '--no-config', '--no-editorconfig', '--html-whitespace-sensitivity', 'strict',
      '--embedded-language-formatting', 'off', '--log-level', 'warn',
    ], { cwd: fileURLToPath(projectRoot), stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', code => resolve(code ?? 1));
  });
  if (process.exitCode === 0) console.log('[Prettier] HTML formatting complete.');
} catch (error) {
  console.error(styleText('red', `[Prettier] ${error.message}`, { stream: process.stderr }));
  process.exitCode = 1;
}
