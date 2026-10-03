import { copyFile, readFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { styleText } from 'node:util';

const projectRoot = new URL('../', import.meta.url);
const output = new URL('dist/', projectRoot);
const searchDirectory = new URL('_zeropress/', output);

async function readJson(url) {
  return JSON.parse(await readFile(url, 'utf8'));
}

async function readBuildFile(name) {
  try {
    return await readFile(new URL(name, searchDirectory), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error(`Missing dist/_zeropress/${name}. Run npm run build before replacing search with Pagefind.`);
  }
}

function checkPagefind(result) {
  if (result.errors?.length) {
    throw new Error(result.errors.join('\n'));
  }
  return result;
}

async function replaceSearchWithPagefind() {
  const [publication, theme] = await Promise.all([
    readJson(new URL('zeropress-preview-data.json', projectRoot)),
    readJson(new URL('theme/theme.json', projectRoot)),
  ]);
  if (publication.site?.search?.enabled === false || theme.features?.search !== true) {
    console.log('[Pagefind] Search is disabled; skipping replacement.');
    return;
  }

  const [nativeIndex] = await Promise.all([
    readBuildFile('search.json'),
    readBuildFile('search.js'),
    readBuildFile('search_pagefind.js'),
  ]);
  const documents = JSON.parse(nativeIndex);
  if (!Array.isArray(documents)) {
    throw new Error('Invalid ZeroPress search index. Run npm run build to regenerate it.');
  }
  // With no searchable documents, Pagefind's HTML crawl would otherwise index
  // unmarked pages such as archives, forms, or delisted content.
  if (documents.length === 0) {
    console.log('[Pagefind] No searchable posts or pages; keeping the empty ZeroPress index.');
    return;
  }

  const pagefind = await import('pagefind');
  console.log('[Pagefind] Generating the search index...');
  try {
    const { index } = checkPagefind(await pagefind.createIndex());
    checkPagefind(await index.addDirectory({ path: fileURLToPath(output) }));
    checkPagefind(await index.writeFiles({ outputPath: fileURLToPath(new URL('pagefind/', searchDirectory)) }));
  } finally {
    await pagefind.close();
  }

  console.log('[Pagefind] Replacing the ZeroPress search adapter...');
  await copyFile(new URL('search_pagefind.js', searchDirectory), new URL('search.js', searchDirectory));
  console.log('[Pagefind] Removing the unused search.json...');
  await unlink(new URL('search.json', searchDirectory));
}

try {
  await replaceSearchWithPagefind();
} catch (error) {
  console.error(styleText('red', `[Pagefind] ${error.message || String(error)}`, { stream: process.stderr }));
  process.exitCode = 1;
}
