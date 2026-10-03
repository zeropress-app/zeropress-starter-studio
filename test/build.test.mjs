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
  await cp(path.join(projectRoot, 'public'), path.join(cwd, 'public'), { recursive: true });
  await cp(path.join(projectRoot, 'scripts'), path.join(cwd, 'scripts'), { recursive: true });
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
  await mkdir(path.join(cwd, 'public'), { recursive: true });
  await writeFile(path.join(cwd, 'public', 'guide.txt'), 'A public download.\n');

  await build(cwd);

  assert.match(await readFile(path.join(cwd, 'dist/index.html'), 'utf8'), /Fixture publication/);
  assert.match(await readFile(path.join(cwd, 'dist/posts/first-post/index.html'), 'utf8'), /A published paragraph\./);
  assert.match(await readFile(path.join(cwd, 'dist/about/index.html'), 'utf8'), /A published page\./);
  assert.match(await readFile(path.join(cwd, 'dist/sitemap.xml'), 'utf8'), /https:\/\/site\.example\/posts\/first-post\//);
  assert.equal(await readFile(path.join(cwd, 'dist/guide.txt'), 'utf8'), 'A public download.\n');
  assert.equal(await readFile(source, 'utf8'), original);
  const adapter = await readFile(path.join(cwd, 'dist/_zeropress/search.js'), 'utf8');
  assert.equal(adapter, await readFile(path.join(cwd, 'dist/_zeropress/search_pagefind.js'), 'utf8'));
  await readFile(path.join(cwd, 'dist/_zeropress/pagefind/pagefind.js'));
  await assert.rejects(readFile(path.join(cwd, 'dist/_zeropress/search.json')), { code: 'ENOENT' });
});

test('replaces the sample publication with Studio content and retains public files', async (t) => {
  const sample = JSON.parse(await readFile(path.join(projectRoot, 'zeropress-preview-data.json'), 'utf8'));
  const cwd = await workspace(t, sample);
  await build(cwd);
  const oldPost = path.join(cwd, 'dist/posts', sample.content.posts[0].slug, 'index.html');
  const sampleHome = await readFile(path.join(cwd, 'dist/index.html'), 'utf8');
  assert.match(sampleHome, /site-nav__submenu--nested/);
  assert.match(sampleHome, /widget-card--profile/);
  await readFile(oldPost);

  const next = publication('new-post');
  next.content.posts[0].content = '<p>The updated publication.</p>';
  next.content.pages[0].featured_image = '/demo/reading-desk.svg';
  await save(cwd, next);
  await build(cwd);

  assert.match(await readFile(path.join(cwd, 'dist/posts/new-post/index.html'), 'utf8'), /The updated publication\./);
  const home = await readFile(path.join(cwd, 'dist/index.html'), 'utf8');
  assert.match(home, /<h1>Latest posts<\/h1>/);
  assert.match(home, /Fixture publication/);
  assert.doesNotMatch(home, /<aside class="sidebar-stack">/);
  const about = await readFile(path.join(cwd, 'dist/about/index.html'), 'utf8');
  assert.match(about, /class="article-featured-image" src="\/demo\/reading-desk\.svg"/);
  for (const file of ['demo/reading-desk.svg', 'zp_form/config.json', 'zp_newsletter/config.json', 'favicon.svg']) {
    assert.deepEqual(await readFile(path.join(cwd, 'dist', file)), await readFile(path.join(cwd, 'public', file)));
  }
  await assert.rejects(readFile(oldPost), { code: 'ENOENT' });
});

test('builds the bundled sample with working menu destinations, rich text, images, and search', async (t) => {
  const sample = JSON.parse(await readFile(path.join(projectRoot, 'zeropress-preview-data.json'), 'utf8'));
  const cwd = await workspace(t, sample);
  const result = await build(cwd);
  assert.doesNotMatch(result.stderr, /MENU_MAX_DEPTH_EXCEEDED/);
  const output = path.join(cwd, 'dist');
  const home = await readFile(path.join(output, 'index.html'), 'utf8');
  assert.match(home, /data-cmdk-open/);
  assert.match(home, /data-newsletter-open/);
  await readFile(path.join(output, '_zeropress/search.js'));
  const checkMenu = async items => {
    for (const item of items) {
      await readFile(path.join(output, item.url.slice(1), 'index.html'));
      await checkMenu(item.children);
    }
  };
  await checkMenu(sample.menus.primary.items);
  await checkMenu(sample.menus.footer.items);
  const richPost = sample.content.posts.find(post => post.document_type === 'html');
  const html = await readFile(path.join(output, 'posts', richPost.slug, 'index.html'), 'utf8');
  assert.match(html, /<table>/);
  assert.match(html, /<figcaption>/);
  assert.ok(html.includes(sample.content.authors.find(author => author.id === richPost.author_id).display_name));
  for (const file of ['demo/reading-desk.svg', 'demo/type-study.svg', 'zp_form/index.html', 'zp_newsletter/index.html']) {
    assert.deepEqual(await readFile(path.join(output, file)), await readFile(path.join(cwd, 'public', file)));
  }
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

async function buildNative(cwd) {
  const manifestPath = path.join(cwd, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  delete manifest.scripts.postbuild;
  await writeFile(manifestPath, JSON.stringify(manifest));
  return build(cwd);
}

function replaceSearch(cwd) {
  return run(process.execPath, ['scripts/replace-search-with-pagefind.mjs'], {
    cwd,
    timeout: 30_000,
    env: { ...process.env, NO_COLOR: '1' },
  });
}

test('keeps usable ZeroPress search when the optional postbuild hook is removed', async (t) => {
  const cwd = await workspace(t);
  await buildNative(cwd);
  const search = JSON.parse(await readFile(path.join(cwd, 'dist/_zeropress/search.json'), 'utf8'));
  assert.deepEqual(search.map(item => item.url), ['/posts/first-post/', '/about/']);
  assert.match(await readFile(path.join(cwd, 'dist/_zeropress/search.js'), 'utf8'), /search\.json/);
});

for (const setting of ['site', 'theme']) {
  test(`builds successfully when ${setting} search is disabled`, async (t) => {
    const data = publication();
    if (setting === 'site') data.site.search = { enabled: false };
    const cwd = await workspace(t, data);
    if (setting === 'theme') {
      const themePath = path.join(cwd, 'theme/theme.json');
      const theme = JSON.parse(await readFile(themePath, 'utf8'));
      theme.features.search = false;
      await writeFile(themePath, JSON.stringify(theme));
    }
    const result = await build(cwd);
    assert.match(result.stdout, /Search is disabled; skipping replacement/);
    const home = await readFile(path.join(cwd, 'dist/index.html'), 'utf8');
    assert.match(home, /Fixture publication/);
    assert.doesNotMatch(home, /data-cmdk-open/);
  });
}

for (const content of ['empty', 'delisted']) {
  test(`keeps empty search results for a site with ${content} content`, async (t) => {
    const data = publication();
    if (content === 'empty') {
      data.content.posts = [];
      data.content.pages = [];
    } else {
      data.content.posts[0].discoverability = 'delist';
      data.content.pages[0].discoverability = 'delist';
    }
    const cwd = await workspace(t, data);
    const result = await build(cwd);
    assert.match(result.stdout, /No searchable posts or pages/);
    assert.deepEqual(JSON.parse(await readFile(path.join(cwd, 'dist/_zeropress/search.json'), 'utf8')), []);
    assert.match(await readFile(path.join(cwd, 'dist/_zeropress/search.js'), 'utf8'), /search\.json/);
    await readFile(path.join(cwd, 'dist/zp_form/index.html'));
  });
}

for (const artifact of ['search.json', 'search.js', 'search_pagefind.js']) {
  test(`requires a fresh build when ${artifact} is missing`, async (t) => {
    const cwd = await workspace(t);
    await buildNative(cwd);
    await rm(path.join(cwd, 'dist/_zeropress', artifact));
    await assert.rejects(replaceSearch(cwd), error => {
      assert.equal(error.code, 1);
      assert.ok(error.stderr.includes(`Missing dist/_zeropress/${artifact}`));
      assert.match(error.stderr, /Run npm run build/);
      return true;
    });
  });
}

for (const failure of ['createIndex', 'addDirectory', 'writeFiles']) {
  test(`preserves native search when Pagefind fails during ${failure}`, async (t) => {
    const cwd = await workspace(t);
    await buildNative(cwd);
    const search = path.join(cwd, 'dist/_zeropress');
    const adapterBefore = await readFile(path.join(search, 'search.js'), 'utf8');
    const indexBefore = await readFile(path.join(search, 'search.json'), 'utf8');
    // Replace only this fixture's dependency link with a synthetic Pagefind
    // service. No shared or installed package files are modified.
    await rm(path.join(cwd, 'node_modules'));
    const fakePackage = path.join(cwd, 'node_modules/pagefind');
    await mkdir(fakePackage, { recursive: true });
    await writeFile(path.join(fakePackage, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }));
    await writeFile(path.join(fakePackage, 'index.js'), `
      import { writeFile } from 'node:fs/promises';
      const failure = ${JSON.stringify(failure)};
      const result = name => ({ errors: name === failure ? ['Synthetic Pagefind failure'] : [] });
      export async function createIndex() {
        return { ...result('createIndex'), index: {
          addDirectory: async () => result('addDirectory'),
          writeFiles: async () => result('writeFiles'),
        } };
      }
      export async function close() { await writeFile('pagefind-closed', 'yes'); }
    `);
    await assert.rejects(replaceSearch(cwd), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Synthetic Pagefind failure/);
      return true;
    });
    assert.equal(await readFile(path.join(search, 'search.js'), 'utf8'), adapterBefore);
    assert.equal(await readFile(path.join(search, 'search.json'), 'utf8'), indexBefore);
    assert.equal(await readFile(path.join(cwd, 'pagefind-closed'), 'utf8'), 'yes');
  });
}
