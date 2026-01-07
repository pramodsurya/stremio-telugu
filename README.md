# Troorentio Telugu Stremio Add-on

Free, stateless Stremio add-on focused on Telugu catalogs (Latest Movies, Latest Series, Must-Watch Movies/Series). Deployed on Vercel.

**How it works**: Users bring their own free TMDb v4 token; the add-on uses it to fetch Telugu catalogs. No server-side API quotas.

## Deploy to Vercel

1. Push this repo to GitHub:
   ```bash
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<repo-name>.git
   git push -u origin main
   ```

2. Go to [vercel.com](https://vercel.com), sign in with GitHub, and click "New Project".
3. Select this repository and click "Import".
4. **Do NOT add any environment variables** (users will paste their TMDb token on the configure page).
5. Click "Deploy".
6. After deploy, you'll get a URL like `https://your-addon.vercel.app/`.

## Use in Stremio

1. Open `https://your-addon.vercel.app/` in your browser.
2. Paste your free TMDb v4 Bearer token into the field.
3. The manifest URL will update to include your token (`?tmdbKey=...`).
4. Copy the manifest URL or click "Install in Stremio".
5. In Stremio, you should see 4 Telugu catalogs.

## Local Testing

```bash
npm install
npm run dev
```
Open `http://127.0.0.1:8787/`, paste your TMDb token, and test.

## Endpoints

- Configure/install page (enter your TMDb token; it’s not stored): `/`
- Manifest: `/manifest.json` (can accept `?tmdbKey=...` to override per-user)
- Catalog: `/catalog/:type/:id.json?extra=` (supports `search`, `skip` for `latest-movies`)
- Meta: `/meta/:type/:id.json`
- Stream: `/stream/:type/:id.json` (stub, to be filled by Troorentio links)

## Notes

- Uses TMDb as the source of truth; IDs are `tmdb:<id>` with optional `imdb` links.
- Only `latest-movies` catalog is live; others return empty lists until filled.
- Add your stream resolution/audio/subtitles in `handleStream` once Troorentio provides URLs.
