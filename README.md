# ZeroPress Site Starter for Studio

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/zeropress-app/zeropress-starter-studio/tree/latest)

A static site published from [ZeroPress Studio](https://github.com/zeropress-app/zeropress-studio), with the Minimal theme. Sample posts and an About page are included.

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
| `npm run build` | Build the site into `dist/` |
| `npm run preview` | Build and preview locally with Wrangler |
| `npm run deploy:dry-run` | Build and validate deployment without uploading |
| `npm run deploy` | Deploy the existing build to Cloudflare |
| `npm test` | Check the build and content replacement flow |

For a manual deployment, run `npm run build` before `npm run deploy`.

## Customize

- Edit `theme/` to change the layout and styles. The theme supports the
  `primary` and `footer` menu slots.
- Add a `public/` directory for a favicon, images, or other files to serve as-is.
- Manage posts, pages, menus, and site settings in Studio. Publishing replaces
  `zeropress-preview-data.json`, including any manual edits to that file.
- Edit `wrangler.jsonc` for Cloudflare deployment settings, then run
  `npm run format:wrangler`.

The sample has no canonical site URL. Studio's site URL supplies the canonical
links, sitemap, and enabled RSS feed on your next publication.

The generated `dist/` directory can also be served by another static host at
the domain root.

## License

[MIT](LICENSE)
