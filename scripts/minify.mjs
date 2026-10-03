import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { styleText } from 'node:util';

const projectRoot = new URL('../', import.meta.url);
const packageSpec = 'html-minifier-terser@7.2.0';

try {
  try {
    await access(new URL('dist/index.html', projectRoot));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error('No built site found in dist/. Run npm run build first.');
  }

  const npm = process.env.npm_execpath;
  if (!npm) throw new Error('Run npm run dist:minify to minify the built HTML.');

  console.log(`[Minify] Minifying dist/ HTML with ${packageSpec}...`);
  // Run npm through Node so Windows does not need an npx.cmd shell wrapper.
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      npm, 'exec', '--yes', `--package=${packageSpec}`, '--', 'html-minifier-terser',
      '--input-dir', 'dist', '--output-dir', 'dist', '--file-ext', 'html',
      '--collapse-whitespace', '--conservative-collapse', '--remove-comments',
    ], { cwd: fileURLToPath(projectRoot), stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', code => resolve(code ?? 1));
  });
  if (process.exitCode === 0) console.log('[Minify] HTML minification complete.');
} catch (error) {
  console.error(styleText('red', `[Minify] ${error.message}`, { stream: process.stderr }));
  process.exitCode = 1;
}
