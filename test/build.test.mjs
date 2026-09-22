import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../', import.meta.url));

function publication(slug = 'first-post') {
  const authorId = '11111111-1111-4111-8111-111111111111';
  return {
    version: '0.7',
    generator: 'starter-test',
    generated_at: '2026-01-02T00:00:00Z',
    site: {
      title: 'Fixture publication',
      description: 'A synthetic site.',
      url: 'https://site.example',
      locale: 'en-US',
      timezone: 'UTC',
      media_origin: '',
      posts_per_page: 10,
      date_style: 'medium',
      time_style: 'none',
      permalinks: {
        output_style: 'directory',
        posts: '/posts/:slug/',
        pages: '/:slug/',
        categories: '/category/:slug/',
        tags: '/tag/:slug/',
      },
    },
    content: {
      authors: [{ id: authorId, display_name: 'Editor' }],
      posts: [{
        public_id: 1,
        title: 'Fixture post',
        slug,
        content: '<p>A published paragraph.</p>',
        document_type: 'html',
        excerpt: '',
        published_at_iso: '2026-01-01T00:00:00Z',
        updated_at_iso: '2026-01-01T00:00:00Z',
        author_id: authorId,
        status: 'published',
        category_slugs: [],
        tag_slugs: [],
      }],
      pages: [{
        title: 'About the fixture',
        slug: 'about',
        content: '<p>A published page.</p>',
        document_type: 'html',
        excerpt: '',
        status: 'published',
      }],
      categories: [],
      tags: [],
    },
    menus: {},
  };
}

async function workspace(t, data = publication()) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'zeropress-starter-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await cp(path.join(projectRoot, 'theme'), path.join(cwd, 'theme'), { recursive: true });
  await cp(path.join(projectRoot, 'package.json'), path.join(cwd, 'package.json'));
  await symlink(path.join(projectRoot, 'node_modules'), path.join(cwd, 'node_modules'), 'junction');
  await save(cwd, data);
  return cwd;
}

async function save(cwd, data) {
  await writeFile(path.join(cwd, 'zeropress-preview-data.json'), JSON.stringify(data, null, 2) + '\n');
}

function build(cwd) {
  const npm = process.env.npm_execpath;
  return run(npm ? process.execPath : 'npm', npm ? [npm, 'run', 'build'] : ['run', 'build'], {
    cwd,
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1' },
  });
}

test('builds Studio data and public files without changing the publication source', async (t) => {
  const cwd = await workspace(t);
  const source = path.join(cwd, 'zeropress-preview-data.json');
  const original = await readFile(source, 'utf8');
  await mkdir(path.join(cwd, 'public'));
  await writeFile(path.join(cwd, 'public', 'guide.txt'), 'A public download.\n');

  await build(cwd);

  assert.match(await readFile(path.join(cwd, 'dist/index.html'), 'utf8'), /Fixture publication/);
  assert.match(await readFile(path.join(cwd, 'dist/posts/first-post/index.html'), 'utf8'), /A published paragraph\./);
  assert.match(await readFile(path.join(cwd, 'dist/about/index.html'), 'utf8'), /A published page\./);
  assert.match(await readFile(path.join(cwd, 'dist/sitemap.xml'), 'utf8'), /https:\/\/site\.example\/posts\/first-post\//);
  assert.equal(await readFile(path.join(cwd, 'dist/guide.txt'), 'utf8'), 'A public download.\n');
  assert.equal(await readFile(source, 'utf8'), original);
});

test('replaces old routes when Studio publishes a changed data file', async (t) => {
  const cwd = await workspace(t, publication('old-post'));
  await build(cwd);
  await readFile(path.join(cwd, 'dist/posts/old-post/index.html'));

  const next = publication('new-post');
  next.content.posts[0].content = '<p>The updated publication.</p>';
  await save(cwd, next);
  await build(cwd);

  assert.match(await readFile(path.join(cwd, 'dist/posts/new-post/index.html'), 'utf8'), /The updated publication\./);
  await assert.rejects(readFile(path.join(cwd, 'dist/posts/old-post/index.html')), { code: 'ENOENT' });
});

test('fails an invalid publication while preserving the last successful output', async (t) => {
  const cwd = await workspace(t);
  await build(cwd);
  const index = path.join(cwd, 'dist/index.html');
  const previous = await readFile(index, 'utf8');

  await writeFile(path.join(cwd, 'zeropress-preview-data.json'), '{ invalid json');
  await assert.rejects(build(cwd));
  assert.equal(await readFile(index, 'utf8'), previous);
});
