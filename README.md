# ZeroPress Site Starter for Studio

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/zeropress-app/zeropress-starter-studio/tree/latest)

A static site published from [ZeroPress Studio](https://github.com/zeropress-app/zeropress-studio), with the Blog theme from `@zeropress/create-theme`.

The sample includes nested menus, multiple authors, illustrated posts and pages,
tables, sidebar widgets, search, and light and dark colors. Small sample images
are included in `public/demo/`.

## Deploy and connect Studio

1. Select **Deploy to Cloudflare** and create your GitHub repository. Keep the
   build command `npm run build` and deploy command `npm run deploy`.
2. Once the sample site is deployed, open `zeropress-preview-data.json` on your
   new repository's `main` branch and copy its GitHub file URL.
3. In Studio, open **Site Settings → Publishing**, paste that URL, and use
   **Create GitHub token** to create a token for the new repository with
   **Contents: write** permission. Paste the token into Studio.
4. Enable publishing, check the connection, and save. Set your public site URL
   in Studio's site settings.
5. Open **Publish**, select **Publish to GitHub**, and confirm.

Studio replaces the sample data with your site's content. Cloudflare builds and
deploys each commit on the connected branch. Check Cloudflare's build status
after publishing.

The sample disallows crawling with `site.robots.allow_indexing: false`. After
connecting Studio, publications use its indexing setting. Enable it in Studio's
site output settings and publish when your own site is ready for search engines
to crawl.

The JSON file must remain at the path used by the build command. Keep the GitHub
token in Studio; this repository needs no application secrets.

## Work locally

Use Node.js 22.22 or later; Node.js 24 is selected for Cloudflare Builds.

```sh
npm ci
npm run dev
```

The development server previews your theme and watches the data file for changes.

| Command | Action |
| --- | --- |
| `npm run build` | Build the site into `dist/` and replace its search with Pagefind |
| `npm run preview` | Build and preview the deployment output, including Pagefind, locally with Wrangler |
| `npm run deploy:dry-run` | Build and validate deployment without uploading |
| `npm run deploy` | Deploy the existing build to Cloudflare |
| `npm test` | Check the build and content replacement flow |

For a manual deployment, run `npm run build` before `npm run deploy`.

## Search

The development server uses ZeroPress's built-in search. Production builds use
[Pagefind](https://pagefind.app/) with the same search dialog and keyboard controls.
Use `npm run preview` to check Pagefind locally.

After the ZeroPress build, `postbuild` runs `search:replace-with-pagefind`. It
generates the Pagefind index in `dist/_zeropress/pagefind/`, replaces `search.js`
with the generated Pagefind adapter, and removes the unused `search.json`.
Pagefind is installed with the project and its version is recorded in the lockfile.
If index generation fails, the build fails before the search adapter is replaced.

Search covers published posts and pages, including their titles, headings,
excerpts, categories, and tags. Delisted content and navigation, sidebar, and
comment interface text are excluded. Disabling search in Studio skips Pagefind;
a site with no searchable posts or pages keeps an empty ZeroPress index.

Pagefind uses its own ranking and language handling. The built-in search's
field weights and recent-post boost are not carried over.

To use ZeroPress's built-in search in production, remove the `postbuild` entry
from `package.json` and rebuild. You can also remove the
`search:replace-with-pagefind` command, its script, and the Pagefind dependency
if you no longer use them.

## Optional HTML processing

After building, you can process the HTML in `dist/`:

- `npm run dist:prettify` formats HTML with Prettier for easier reading.
- `npm run dist:minify` reduces HTML whitespace and removes comments.

These commands do not rebuild the site or run during the default build. They
use versions pinned in `scripts/prettify.mjs` and `scripts/minify.mjs`, fetched
through npm when needed. Only HTML files are processed; JavaScript, CSS, and
Pagefind assets remain unchanged. Prettier uses the options in its script.

To enable minification for your deployment, set the hosting build command to:

```sh
npm run build && npm run dist:minify
```

Use `dist:prettify` instead if you prefer formatted HTML.

## Customize

- Edit `theme/` to change the layout and styles. The `primary` menu supports
  three levels and the `footer` menu supports one. Deeper items remain in
  Preview Data, but are omitted from the site with a build warning.
- Manage sidebar widgets in Studio's `sidebar` area. Widgets appear on listing,
  post, and page views; listing pages use one column when no widgets are set.
- Use `public/` for a favicon, images, or other files to serve as-is. You can
  replace the sample illustrations in `public/demo/` with your own files.
- Manage posts, pages, menus, and site settings in Studio. Publishing replaces
  `zeropress-preview-data.json`, including any manual edits to that file.
- Edit `wrangler.jsonc` for Cloudflare deployment settings, then run
  `npm run format:wrangler`.

On narrow screens, **Menu** opens navigation over the page and keeps keyboard
focus inside. **Escape** closes the innermost submenu first, then the panel.
Without JavaScript, navigation remains available as nested lists.

The blog uses system fonts: sans-serif for body text and controls, serif for
headings, and monospace for code. It makes no webfont requests by default.
Customize `--font-body`, `--font-heading`, and `--font-mono` in
`theme/assets/style.css`. To use webfonts, add their stylesheet or `@font-face`
rule and override these variables in the theme, or through Preview Data's
`custom_html.head_end` and `custom_css.content`. The standalone form and
newsletter pages use their own `style.css` files.

The sample has no canonical site URL. Studio's site URL supplies the canonical
links, sitemap, and enabled RSS feed on your next publication.

The generated `dist/` directory can also be served by another static host at
the domain root.

## Forms, newsletters, and comments

These features are optional. The sample newsletter entry stays visible and
shows setup guidance until an endpoint is available.

- Set `form_endpoint` in `public/zp_form/config.json` for the message form.
- Set `newsletter_endpoint` in `public/zp_newsletter/config.json` for newsletter
  signup, confirmation, and unsubscribe requests.
- Studio provides these addresses and a **Copy config.json** action in the
  Form settings and Newsletter screen after you set **Edge URL**.

Keep each folder's HTML, CSS, JavaScript, and configuration together. Preserve
your `config.json` values when updating the other files. Only keep the folders
you use, and update any links to them in Studio.

For comments, configure ZeroPress Edge and enable comments in Studio, including
on the posts or pages that should accept them. Publishing supplies the comment
connection to the theme.

Setting `newsletter_endpoint` explicitly is recommended. If it is empty, the
blog's same-origin newsletter iframe can infer `/api/newsletters/default` from
the site's enabled ZeroPress comment connection. Standalone newsletter links
still need an explicit endpoint. The corresponding Edge feature must be enabled.

After connecting Studio, its newsletter settings control the footer entry.
Use `/zp_newsletter/` as the embed URL, or disable the entry if you do not use it.
Studio publishing replaces the data file; it does not edit these public files
or provision Edge services.

## License

MIT
