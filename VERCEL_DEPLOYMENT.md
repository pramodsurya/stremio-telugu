# Deployment Steps for Vercel

1. Push your code to GitHub.
2. Go to [vercel.com](https://vercel.com) and sign in with GitHub.
3. Click "New Project" and import this repository.
4. Add environment variable:
   - Key: `TMDB_API_KEY`
   - Value: your TMDb v4 Bearer token
5. Click "Deploy".
6. Once deployed, your add-on will be at `https://<your-project>.vercel.app/`.

## Install in Stremio

- Open `https://<your-project>.vercel.app/` in your browser to see the configure page.
- Paste your TMDb token (or it will use the env var).
- Copy the manifest URL or click "Install in Stremio".
- If using the env var (recommended for prod), just use `https://<your-project>.vercel.app/manifest.json`.

## Environment Variables

Set in Vercel Project Settings → Environment Variables:
- `TMDB_API_KEY`: Your TMDb v4 Bearer token (keep secret).
