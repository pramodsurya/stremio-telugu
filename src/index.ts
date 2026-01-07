import { Env } from './types';

// Simple router for Stremio add-on endpoints on Cloudflare Workers.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (path === '' || path === '/') {
      const origin = `${url.protocol}//${url.host}`;
      return html(configurePage(origin));
    }

    if (path === '/manifest.json') {
      return json(manifest);
    }

    // /catalog/:type/:id.json
    if (path.startsWith('/catalog/')) {
      const segments = path.split('/').filter(Boolean);
      // segments: ["catalog", type, idWithJson]
      if (segments.length >= 3) {
        const type = segments[1];
        const id = segments[2].replace(/\.json$/i, '');
        const extra = parseExtra(url.searchParams.get('extra'));
        const tmdbKey = getTmdbKey(url, env);
        if (!isKnownCatalog(id, type)) {
          return json({ metas: [] });
        }
        if (id === 'latest-movies') {
          return handleLatestMoviesCatalog(type, extra, env, tmdbKey).catch((err) => errorResponse(err));
        }
        // Other catalogs can be added later
        return json({ metas: [] });
      }
    }

    // /meta/:type/:id.json
    if (path.startsWith('/meta/')) {
      const segments = path.split('/').filter(Boolean);
      if (segments.length >= 3) {
        const type = segments[1];
        const id = segments[2].replace(/\.json$/i, '');
        const tmdbKey = getTmdbKey(url, env);
        return handleMeta(type, id, env, tmdbKey).catch((err) => errorResponse(err));
      }
    }

    // /stream/:type/:id.json
    if (path.startsWith('/stream/')) {
      const segments = path.split('/').filter(Boolean);
      if (segments.length >= 3) {
        const type = segments[1];
        const id = segments[2].replace(/\.json$/i, '');
        const tmdbKey = getTmdbKey(url, env);
        return handleStream(type, id, env, tmdbKey).catch((err) => errorResponse(err));
      }
    }

    return new Response('Not found', { status: 404, headers: corsHeaders() });
  },
};

const manifest = {
  id: 'com.troorentio.telugu',
  version: '0.1.0',
  name: 'Troorentio Telugu',
  description: 'Telugu latest and must-watch catalog for Stremio (Troorentio-backed).',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tmdb:', 'imdb:', 'tlg:'],
  catalogs: [
    { id: 'latest-movies', type: 'movie', name: 'Latest Telugu Movies', extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
    { id: 'latest-series', type: 'series', name: 'Latest Telugu Series', extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
    { id: 'must-watch-movies', type: 'movie', name: 'Must Watch Movies', extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
    { id: 'must-watch-series', type: 'series', name: 'Must Watch Series', extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
  ],
  behaviorHints: { adult: false },
};

function corsHeaders(): HeadersInit {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Content-Type': 'application/json; charset=utf-8',
  };
}

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { ...corsHeaders(), ...(init?.headers || {}) },
  });
}

function errorResponse(err: unknown): Response {
  const message = err instanceof Error ? err.message : 'Unexpected error';
  return json({ error: message }, { status: 502 });
}

function html(content: string, init?: ResponseInit): Response {
  return new Response(content, {
    ...init,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      ...(init?.headers || {}),
    },
  });
}

function parseExtra(extraParam: string | null) {
  if (!extraParam) return {};
  try {
    return JSON.parse(decodeURIComponent(extraParam));
  } catch (err) {
    return {};
  }
}

function isKnownCatalog(id: string, type: string) {
  return manifest.catalogs.some((c) => c.id === id && c.type === type);
}

async function handleLatestMoviesCatalog(type: string, extra: Record<string, unknown>, env: Env, tmdbKey: string | null): Promise<Response> {
  const search = typeof extra.search === 'string' ? extra.search.trim() : '';
  const skip = Number.isFinite(extra.skip as number) ? Number(extra.skip) : 0;
  const page = Math.floor(skip / 20) + 1; // TMDb pages are 1-based

  const params = new URLSearchParams({
    with_original_language: 'te',
    sort_by: search ? 'popularity.desc' : 'primary_release_date.desc',
    include_adult: 'false',
    language: 'te-IN',
    region: 'IN',
    with_release_type: '3|4',
    page: page.toString(),
  });

  if (search) {
    params.set('query', search);
    const url = `https://api.themoviedb.org/3/search/movie?${params.toString()}`;
    const data = await tmdbFetch(url, tmdbKey);
    const metas = (data.results || []).map(toMetaPreviewFromSearch);
    return json({ metas });
  }

  const url = `https://api.themoviedb.org/3/discover/movie?${params.toString()}`;
  const data = await tmdbFetch(url, tmdbKey);
  const metas = (data.results || []).map(toMetaPreviewFromDiscover);
  return json({ metas });
}

async function handleMeta(type: string, id: string, env: Env, tmdbKey: string | null): Promise<Response> {
  const { tmdbId, imdbId } = parseIds(id);
  if (!tmdbId) {
    return json({ meta: null });
  }
  const url = `https://api.themoviedb.org/3/movie/${tmdbId}?` +
    new URLSearchParams({
      language: 'te-IN',
      append_to_response: 'external_ids,watch/providers,credits,translations',
    }).toString();

  const data = await tmdbFetch(url, tmdbKey);
  if (!data || data.success === false) {
    return json({ meta: null });
  }

  const meta = buildMetaObject(data, imdbId);
  return json({ meta });
}

async function handleStream(type: string, id: string, env: Env, tmdbKey: string | null): Promise<Response> {
  // Placeholder: Troorentio will supply actual streams.
  return json({ streams: [] });
}

function parseIds(id: string) {
  if (id.startsWith('tmdb:')) {
    return { tmdbId: id.replace('tmdb:', ''), imdbId: null as string | null };
  }
  if (id.startsWith('imdb:')) {
    return { tmdbId: null as string | null, imdbId: id.replace('imdb:', '') };
  }
  return { tmdbId: id, imdbId: null as string | null };
}

function toMetaPreviewFromDiscover(item: any) {
  return {
    id: `tmdb:${item.id}`,
    type: 'movie',
    name: item.title || item.original_title,
    poster: imageUrl(item.poster_path, 'w342'),
    background: imageUrl(item.backdrop_path, 'w780'),
    year: item.release_date ? Number(item.release_date.slice(0, 4)) : undefined,
    description: item.overview,
  };
}

function toMetaPreviewFromSearch(item: any) {
  return {
    id: `tmdb:${item.id}`,
    type: 'movie',
    name: item.title || item.original_title,
    poster: imageUrl(item.poster_path, 'w342'),
    background: imageUrl(item.backdrop_path, 'w780'),
    year: item.release_date ? Number(item.release_date.slice(0, 4)) : undefined,
    description: item.overview,
  };
}

function imageUrl(path: string | null | undefined, size: string) {
  return path ? `https://image.tmdb.org/t/p/${size}${path}` : undefined;
}

function buildMetaObject(data: any, imdbIdOverride: string | null) {
  const imdbId = data.external_ids?.imdb_id || imdbIdOverride || undefined;
  const directors = (data.credits?.crew || []).filter((c: any) => c.job === 'Director').slice(0, 2).map((c: any) => c.name);
  const cast = (data.credits?.cast || []).slice(0, 5).map((c: any) => c.name);

  return {
    id: `tmdb:${data.id}`,
    type: 'movie',
    name: data.title || data.original_title,
    poster: imageUrl(data.poster_path, 'w342'),
    background: imageUrl(data.backdrop_path, 'w780'),
    logo: imageUrl(data.logo_path, 'w500'),
    imdbRating: data.vote_average ? Number(data.vote_average.toFixed(1)) : undefined,
    releaseInfo: data.release_date,
    description: data.overview,
    genres: data.genres?.map((g: any) => g.name) || [],
    directors,
    cast,
    runtime: data.runtime,
    links: imdbId ? [{ name: 'IMDb', category: 'external', url: `https://www.imdb.com/title/${imdbId}/` }] : [],
    videos: [],
  };
}

async function tmdbFetch(url: string, providedKey: string | null) {
  if (!providedKey) {
    throw new Error('TMDb key is required');
  }
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${providedKey}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`TMDb error ${res.status}`);
  }
  return res.json();
}

function getTmdbKey(url: URL, env: Env): string | null {
  const fromQuery = url.searchParams.get('tmdbKey');
  if (fromQuery && fromQuery.trim()) return fromQuery.trim();
  if (env.TMDB_API_KEY) return env.TMDB_API_KEY;
  return null;
}

function configurePage(origin: string) {
  const manifestUrl = `${origin}/manifest.json`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Troorentio Telugu Add-on</title>
  <style>
    :root { color-scheme: light dark; font-family: "Segoe UI", -apple-system, sans-serif; }
    body { margin: 0; padding: 24px; max-width: 720px; }
    h1 { margin-bottom: 8px; }
    p { margin-top: 0; line-height: 1.5; }
    .card { border: 1px solid #ccc; padding: 16px; border-radius: 12px; }
    .row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
    input { width: 100%; padding: 10px; border-radius: 8px; border: 1px solid #aaa; font-size: 14px; }
    button, a.button { display: inline-block; padding: 10px 16px; border-radius: 10px; border: none; background: #0f7bff; color: white; text-decoration: none; font-weight: 600; cursor: pointer; }
    code { padding: 2px 6px; border-radius: 6px; background: #eee; }
  </style>
</head>
<body>
  <h1>Troorentio Telugu Add-on</h1>
  <p>Install this Stremio add-on for Telugu catalogs (Latest, Must-Watch). Streams are provided by Troorentio separately.</p>
  <div class="card">
    <h3>Install via URL</h3>
    <p style="margin-top:0;">Paste your TMDb v4 token (Bearer) locally. It is never stored on the server; it is only embedded in your install URL.</p>
    <div class="row" style="margin-bottom:8px;">
      <input id="tmdbKey" type="password" placeholder="TMDb v4 token (Bearer)" aria-label="TMDb v4 token" />
    </div>
    <div class="row" style="margin-bottom:8px;">
      <input id="manifest" value="${manifestUrl}" readonly />
      <a class="button" id="install" href="stremio://add-addon?url=${encodeURIComponent(manifestUrl)}">Install in Stremio</a>
    </div>
    <p>After entering your TMDb token, copy the manifest URL above (it will include your token) and paste it in Stremio → Add-ons → Community → Install via URL. Do not share this URL.</p>
  </div>
  <script>
    const base = ${JSON.stringify(origin)};
    const manifestInput = document.getElementById('manifest');
    const tmdbInput = document.getElementById('tmdbKey');
    const installLink = document.getElementById('install');
    function update() {
      const key = tmdbInput.value.trim();
      const url = key ? base + '/manifest.json?tmdbKey=' + encodeURIComponent(key) : base + '/manifest.json';
      manifestInput.value = url;
      installLink.href = 'stremio://add-addon?url=' + encodeURIComponent(url);
    }
    tmdbInput.addEventListener('input', update);
    update();
  </script>
</body>
</html>`;
}
