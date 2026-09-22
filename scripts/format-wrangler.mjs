import { readFileSync, writeFileSync } from 'node:fs';
import { styleText } from 'node:util';
import { applyEdits, format, parse, printParseErrorCode } from 'jsonc-parser';

const configPath = new URL('../wrangler.jsonc', import.meta.url);

try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
    throw new Error('Usage: node scripts/format-wrangler.mjs [--check]');
  }
  const contents = readFileSync(configPath, 'utf8');
  const errors = [];
  const config = parse(contents, errors, { allowTrailingComma: true });
  if (errors.length) {
    throw new Error('Invalid wrangler.jsonc: ' + printParseErrorCode(errors[0].error) + '.');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('wrangler.jsonc must contain a JSON object.');
  }
  // Use the same formatter and defaults as Wrangler's configuration write-back.
  const formatted = applyEdits(contents, format(contents, undefined, {}));
  if (args.includes('--check') && contents !== formatted) {
    throw new Error('Run npm run format:wrangler to format wrangler.jsonc.');
  }
  if (!args.includes('--check') && contents !== formatted) {
    writeFileSync(configPath, formatted);
  }
  console.log('wrangler.jsonc is formatted.');
} catch (error) {
  console.error(styleText('red', error.message, { stream: process.stderr }));
  process.exitCode = 1;
}
