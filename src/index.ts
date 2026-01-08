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

    // Root - show configure page
    if (path === '' || path === '/') {
      const origin = `${url.protocol}//${url.host}`;
      return html(configurePage(origin));
    }

    // Parse path: first segment might be the config (base64url encoded JSON)
    const segments = path.split('/').filter(Boolean);
    
    // Check if first segment looks like a config token (base64 encoded)
    let tmdbKey: string | null = null;
    let includeTheatrical = false;
    let routeSegments = segments;
    
    if (segments.length > 0 && segments[0].length > 20 && !['manifest.json', 'catalog', 'meta', 'stream'].includes(segments[0])) {
      // First segment is the encoded config
      try {
        const decoded = decodeBase64Url(segments[0]);
        // Try to parse as JSON config, fallback to plain key
        if (decoded.startsWith('{')) {
          const config = JSON.parse(decoded);
          tmdbKey = config.key || null;
          includeTheatrical = config.includeTheatrical === true;
        } else {
          tmdbKey = decoded;
        }
        routeSegments = segments.slice(1);
      } catch {
        // Not a valid base64, treat as route
      }
    }
    
    // Also check query param as fallback
    if (!tmdbKey) {
      tmdbKey = url.searchParams.get('tmdbKey') || env.TMDB_API_KEY || null;
    }

    const routePath = '/' + routeSegments.join('/');

    // /manifest.json or /{config}/manifest.json
    if (routePath === '/manifest.json') {
      return json(manifest);
    }

    // /catalog/:type/:id.json
    if (routePath.startsWith('/catalog/')) {
      const catSegments = routePath.split('/').filter(Boolean);
      if (catSegments.length >= 3) {
        const type = catSegments[1];
        const id = catSegments[2].replace(/\.json$/i, '');
        const extra = parseExtra(url.searchParams.get('extra'));
        if (!isKnownCatalog(id, type)) {
          return json({ metas: [] });
        }
        return handleCatalog(id, type, extra, tmdbKey, includeTheatrical).catch((err) => errorResponse(err));
      }
    }

    // /meta/:type/:id.json
    if (routePath.startsWith('/meta/')) {
      const metaSegments = routePath.split('/').filter(Boolean);
      if (metaSegments.length >= 3) {
        const type = metaSegments[1];
        const id = metaSegments[2].replace(/\.json$/i, '');
        return handleMeta(type, id, tmdbKey).catch((err) => errorResponse(err));
      }
    }

    // /stream/:type/:id.json
    if (routePath.startsWith('/stream/')) {
      const streamSegments = routePath.split('/').filter(Boolean);
      if (streamSegments.length >= 3) {
        const type = streamSegments[1];
        const id = streamSegments[2].replace(/\.json$/i, '');
        return handleStream(type, id, tmdbKey).catch((err) => errorResponse(err));
      }
    }

    return new Response('Not found', { status: 404, headers: corsHeaders() });
  },
};

function encodeBase64Url(str: string): string {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64Url(str: string): string {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return atob(str);
}

const manifest = {
  id: 'com.telugu.catalog',
  version: '0.1.0',
  name: 'Telugu Catalog',
  description: 'Telugu Movies & Series for Stremio - Latest releases and Must-Watch collections.',
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

// Main catalog handler for all 4 catalogs
async function handleCatalog(id: string, type: string, extra: Record<string, unknown>, tmdbKey: string | null, includeTheatrical: boolean): Promise<Response> {
  const search = typeof extra.search === 'string' ? extra.search.trim() : '';
  const skip = typeof extra.skip === 'number' ? extra.skip : (typeof extra.skip === 'string' ? parseInt(extra.skip, 10) : 0);
  const page = Math.floor(skip / 20) + 1;

  if (type === 'movie') {
    if (id === 'latest-movies') {
      return fetchMovieCatalog('discover', 'primary_release_date.desc', page, search, tmdbKey, false, includeTheatrical);
    }
    if (id === 'must-watch-movies') {
      return fetchMovieCatalog('discover', 'vote_average.desc', page, search, tmdbKey, true, includeTheatrical);
    }
  }
  
  if (type === 'series') {
    if (id === 'latest-series') {
      return fetchSeriesCatalog('discover', 'first_air_date.desc', page, search, tmdbKey);
    }
    if (id === 'must-watch-series') {
      return fetchSeriesCatalog('discover', 'vote_average.desc', page, search, tmdbKey, true);
    }
  }

  return json({ metas: [] });
}

async function fetchMovieCatalog(
  endpoint: 'discover' | 'search',
  sortBy: string,
  page: number,
  search: string,
  tmdbKey: string | null,
  mustWatch: boolean = false,
  includeTheatrical: boolean = false
): Promise<Response> {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
  
  const params = new URLSearchParams({
    with_original_language: 'te',
    include_adult: 'false',
    language: 'en-US',
    page: page.toString(),
    'primary_release_date.lte': today,
  });

  if (search) {
    params.set('query', search);
    params.set('with_original_language', 'te');
    const url = `https://api.themoviedb.org/3/search/movie?${params.toString()}`;
    const data = await tmdbFetch(url, tmdbKey);
    const filteredResults = (data.results || [])
      .filter((item: any) => item.release_date && item.release_date <= today);
    
    // Fetch release dates for each movie to check HD availability
    const metasWithHD = await Promise.all(
      filteredResults.slice(0, 20).map(async (item: any) => {
        const releaseInfo = await getMovieReleaseInfo(item.id, tmdbKey);
        return toMetaPreviewWithHD(item, 'movie', releaseInfo, today);
      })
    );
    
    // Filter based on includeTheatrical setting
    let metas = includeTheatrical 
      ? metasWithHD 
      : metasWithHD.filter(m => m.hdAvailable);
    
    // Sort: theatrical (no HD) at top, then HD available
    if (includeTheatrical) {
      metas = metas.sort((a, b) => {
        if (a.hdAvailable === b.hdAvailable) return 0;
        return a.hdAvailable ? 1 : -1; // Non-HD (theatrical) first
      });
    }
    
    return json({ metas: metas.map(m => ({ ...m, hdAvailable: undefined, theatricalOnly: undefined })) });
  }

  params.set('sort_by', sortBy);
  if (mustWatch) {
    params.set('vote_count.gte', '10'); // Lower threshold for Telugu movies (TMDb has fewer votes)
    params.set('vote_average.gte', '7');
  }

  const url = `https://api.themoviedb.org/3/discover/movie?${params.toString()}`;
  const data = await tmdbFetch(url, tmdbKey);
  
  // Fetch release dates for each movie to check HD availability
  const metasWithHD = await Promise.all(
    (data.results || []).slice(0, 20).map(async (item: any) => {
      const releaseInfo = await getMovieReleaseInfo(item.id, tmdbKey);
      return toMetaPreviewWithHD(item, 'movie', releaseInfo, today);
    })
  );
  
  // Filter based on includeTheatrical setting
  let metas = includeTheatrical 
    ? metasWithHD 
    : metasWithHD.filter(m => m.hdAvailable);
  
  // Sort: theatrical (no HD) at top, then HD available
  if (includeTheatrical) {
    metas = metas.sort((a, b) => {
      if (a.hdAvailable === b.hdAvailable) return 0;
      return a.hdAvailable ? 1 : -1; // Non-HD (theatrical) first
    });
  }
  
  return json({ metas: metas.map(m => ({ ...m, hdAvailable: undefined, theatricalOnly: undefined })) });
}

// Fetch release dates for a movie (Digital = type 4, Physical = type 5)
async function getMovieReleaseInfo(movieId: number, tmdbKey: string | null): Promise<{
  theatricalDate: string | null;
  digitalDate: string | null;
  physicalDate: string | null;
}> {
  try {
    const url = `https://api.themoviedb.org/3/movie/${movieId}/release_dates`;
    const data = await tmdbFetch(url, tmdbKey);
    
    let theatricalDate: string | null = null;
    let digitalDate: string | null = null;
    let physicalDate: string | null = null;
    
    // Check all countries for release dates (prioritize IN for India, then US)
    const countries = ['IN', 'US', 'GB'];
    
    for (const result of (data.results || [])) {
      const countryCode = result.iso_3166_1;
      const priority = countries.indexOf(countryCode);
      
      for (const release of (result.release_dates || [])) {
        const date = release.release_date?.split('T')[0];
        if (!date) continue;
        
        // Type 3 = Theatrical, Type 4 = Digital, Type 5 = Physical
        if (release.type === 3 && (!theatricalDate || priority >= 0)) {
          theatricalDate = date;
        }
        if (release.type === 4 && (!digitalDate || priority >= 0)) {
          digitalDate = date;
        }
        if (release.type === 5 && (!physicalDate || priority >= 0)) {
          physicalDate = date;
        }
      }
    }
    
    return { theatricalDate, digitalDate, physicalDate };
  } catch {
    return { theatricalDate: null, digitalDate: null, physicalDate: null };
  }
}

function toMetaPreviewWithHD(
  item: any, 
  type: 'movie' | 'series', 
  releaseInfo: { theatricalDate: string | null; digitalDate: string | null; physicalDate: string | null },
  today: string
) {
  const title = item.title || item.name || item.original_title || item.original_name;
  const releaseDate = item.release_date || item.first_air_date;
  
  // Check if HD is available (digital or physical release date has passed)
  const hdAvailable = (releaseInfo.digitalDate && releaseInfo.digitalDate <= today) ||
                      (releaseInfo.physicalDate && releaseInfo.physicalDate <= today);
  
  // Build status badge for description
  let badge = '';
  if (releaseInfo.digitalDate && releaseInfo.digitalDate <= today) {
    badge = '🟢 HD Available';
  } else if (releaseInfo.physicalDate && releaseInfo.physicalDate <= today) {
    badge = '📀 Blu-ray/DVD Available';
  } else if (releaseInfo.theatricalDate && releaseInfo.theatricalDate <= today) {
    badge = '🎬 In Theaters (HD Coming Soon)';
  } else {
    badge = '🔴 Coming Soon';
  }
  
  // Add release dates to description
  let releaseDetails = '';
  if (releaseInfo.digitalDate) {
    releaseDetails += `\n📺 Digital: ${releaseInfo.digitalDate}`;
  }
  if (releaseInfo.physicalDate) {
    releaseDetails += `\n📀 Physical: ${releaseInfo.physicalDate}`;
  }
  
  const description = `${badge}${releaseDetails}\n\n${item.overview || ''}`;
  
  return {
    id: `tmdb:${item.id}`,
    type,
    name: title,
    poster: imageUrl(item.poster_path, 'w342'),
    background: imageUrl(item.backdrop_path, 'w780'),
    year: releaseDate ? Number(releaseDate.slice(0, 4)) : undefined,
    description: description.trim(),
    hdAvailable: hdAvailable || false,
  };
}

async function fetchSeriesCatalog(
  endpoint: 'discover' | 'search',
  sortBy: string,
  page: number,
  search: string,
  tmdbKey: string | null,
  mustWatch: boolean = false
): Promise<Response> {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
  
  const params = new URLSearchParams({
    with_original_language: 'te',
    include_adult: 'false',
    language: 'en-US',
    page: page.toString(),
    'first_air_date.lte': today,  // Only aired series (date <= today)
  });

  if (search) {
    params.set('query', search);
    params.set('with_original_language', 'te');
    const url = `https://api.themoviedb.org/3/search/tv?${params.toString()}`;
    const data = await tmdbFetch(url, tmdbKey);
    // Filter search results to only include aired series
    const metas = (data.results || [])
      .filter((item: any) => item.first_air_date && item.first_air_date <= today)
      .map((item: any) => toMetaPreview(item, 'series'));
    return json({ metas });
  }

  params.set('sort_by', sortBy);
  if (mustWatch) {
    params.set('vote_count.gte', '10'); // Lower threshold for Telugu series (TMDb has fewer votes)
    params.set('vote_average.gte', '7');
  }

  const url = `https://api.themoviedb.org/3/discover/tv?${params.toString()}`;
  const data = await tmdbFetch(url, tmdbKey);
  const metas = (data.results || []).map((item: any) => toMetaPreview(item, 'series'));
  return json({ metas });
}

function toMetaPreview(item: any, type: 'movie' | 'series') {
  const title = item.title || item.name || item.original_title || item.original_name;
  const releaseDate = item.release_date || item.first_air_date;
  return {
    id: `tmdb:${item.id}`,
    type,
    name: title,
    poster: imageUrl(item.poster_path, 'w342'),
    background: imageUrl(item.backdrop_path, 'w780'),
    year: releaseDate ? Number(releaseDate.slice(0, 4)) : undefined,
    description: item.overview,
  };
}

async function handleMeta(type: string, id: string, tmdbKey: string | null): Promise<Response> {
  const { tmdbId } = parseIds(id);
  if (!tmdbId) {
    return json({ meta: null });
  }
  
  const endpoint = type === 'series' ? 'tv' : 'movie';
  const url = `https://api.themoviedb.org/3/${endpoint}/${tmdbId}?` +
    new URLSearchParams({
      language: 'en-US',
      append_to_response: 'external_ids,credits',
    }).toString();

  const data = await tmdbFetch(url, tmdbKey);
  if (!data || data.success === false) {
    return json({ meta: null });
  }

  const meta = buildMetaObject(data, type);
  return json({ meta });
}

async function handleStream(type: string, id: string, tmdbKey: string | null): Promise<Response> {
  // Placeholder: Streams would be provided by Troorentio or other sources
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

function imageUrl(path: string | null | undefined, size: string) {
  return path ? `https://image.tmdb.org/t/p/${size}${path}` : undefined;
}

function buildMetaObject(data: any, type: string) {
  const imdbId = data.external_ids?.imdb_id || undefined;
  const directors = (data.credits?.crew || []).filter((c: any) => c.job === 'Director').slice(0, 2).map((c: any) => c.name);
  const cast = (data.credits?.cast || []).slice(0, 5).map((c: any) => c.name);
  const title = data.title || data.name || data.original_title || data.original_name;
  const releaseDate = data.release_date || data.first_air_date;

  return {
    id: `tmdb:${data.id}`,
    type,
    name: title,
    poster: imageUrl(data.poster_path, 'w342'),
    background: imageUrl(data.backdrop_path, 'w780'),
    imdbRating: data.vote_average ? Number(data.vote_average.toFixed(1)) : undefined,
    releaseInfo: releaseDate,
    description: data.overview,
    genres: data.genres?.map((g: any) => g.name) || [],
    directors,
    cast,
    runtime: data.runtime || (data.episode_run_time?.[0]),
    links: imdbId ? [{ name: 'IMDb', category: 'external', url: `https://www.imdb.com/title/${imdbId}/` }] : [],
  };
}

async function tmdbFetch(url: string, apiKey: string | null) {
  if (!apiKey) {
    throw new Error('TMDb API key is required');
  }
  
  // Append API key as query parameter (v3 API)
  const separator = url.includes('?') ? '&' : '?';
  const fullUrl = `${url}${separator}api_key=${apiKey}`;
  
  const res = await fetch(fullUrl, {
    headers: {
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`TMDb error ${res.status}`);
  }
  return res.json();
}

function configurePage(origin: string) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Telugu Catalog for Stremio</title>
  <style>
    :root { color-scheme: light dark; font-family: "Segoe UI", -apple-system, sans-serif; }
    body { margin: 0; padding: 24px; max-width: 720px; background: #1a1a2e; color: #eee; }
    h1 { margin-bottom: 8px; color: #fff; }
    p { margin-top: 0; line-height: 1.5; }
    .card { border: 1px solid #444; padding: 16px; border-radius: 12px; background: #16213e; }
    .row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
    input[type="text"] { flex: 1; padding: 12px; border-radius: 8px; border: 1px solid #555; font-size: 14px; background: #0f0f23; color: #fff; }
    button, a.button { display: inline-block; padding: 12px 20px; border-radius: 10px; border: none; background: #7b2cbf; color: white; text-decoration: none; font-weight: 600; cursor: pointer; }
    a.button:hover { background: #9d4edd; }
    .catalogs { margin-top: 16px; }
    .catalogs h4 { margin: 8px 0; color: #aaa; }
    .catalogs ul { margin: 0; padding-left: 20px; }
    .error { color: #ff6b6b; font-size: 14px; display: none; }
    .checkbox-row { display: flex; align-items: center; gap: 10px; margin: 16px 0; padding: 12px; background: #0f0f23; border-radius: 8px; border: 1px solid #555; }
    .checkbox-row input[type="checkbox"] { width: 20px; height: 20px; accent-color: #7b2cbf; cursor: pointer; }
    .checkbox-row label { cursor: pointer; flex: 1; }
    .checkbox-row .hint { font-size: 12px; color: #888; margin-top: 4px; }
  </style>
</head>
<body>
  <h1>🎬 Telugu Catalog for Stremio</h1>
  
  <div class="card">
    <h3>Configure & Install</h3>
    <p>Enter your <strong>TMDb API Key</strong> (the short one like "6fbb9931a67d2c26ad9edb7c7eac6e81"):</p>
    
    <div class="row">
      <input id="tmdbKey" type="text" placeholder="TMDb API Key (v3)" aria-label="TMDb API Key" />
    </div>
    
    <div class="checkbox-row">
      <input type="checkbox" id="includeTheatrical" />
      <div>
        <label for="includeTheatrical">🎬 Include theatrical releases (no HD yet)</label>
        <div class="hint">Show movies currently in theaters at the top of the catalog. These won't have HD streams available.</div>
      </div>
    </div>
    
    <p id="error" class="error">⚠️ Please enter your TMDb API Key first</p>
    
    <div class="row">
      <a class="button" id="install" href="#">Install in Stremio</a>
      <button id="copy" type="button">Copy Manifest URL</button>
    </div>
    
    <input type="hidden" id="manifest" />
    
    <div class="catalogs">
      <h4>Available Catalogs:</h4>
      <ul>
        <li>📽️ Latest Telugu Movies</li>
        <li>📺 Latest Telugu Series</li>
        <li>⭐ Must Watch Movies (Top Rated)</li>
        <li>⭐ Must Watch Series (Top Rated)</li>
      </ul>
    </div>
  </div>
  
  <script>
    const base = ${JSON.stringify(origin)};
    const manifestInput = document.getElementById('manifest');
    const tmdbInput = document.getElementById('tmdbKey');
    const theatricalCheckbox = document.getElementById('includeTheatrical');
    const installLink = document.getElementById('install');
    const copyBtn = document.getElementById('copy');
    const errorEl = document.getElementById('error');
    
    function encodeBase64Url(str) {
      return btoa(str).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
    }
    
    function update() {
      const key = tmdbInput.value.trim();
      const includeTheatrical = theatricalCheckbox.checked;
      
      if (key) {
        // Encode config as JSON with key and options
        const config = JSON.stringify({ key: key, includeTheatrical: includeTheatrical });
        const encoded = encodeBase64Url(config);
        const url = base + '/' + encoded + '/manifest.json';
        manifestInput.value = url;
        installLink.href = 'stremio://' + url.replace(/^https?:\\\\/\\\\//, '');
        errorEl.style.display = 'none';
      } else {
        manifestInput.value = '';
        installLink.href = '#';
        errorEl.style.display = 'block';
      }
    }
    
    installLink.addEventListener('click', function(e) {
      if (!tmdbInput.value.trim()) {
        e.preventDefault();
        errorEl.style.display = 'block';
      }
    });
    
    copyBtn.addEventListener('click', function() {
      if (manifestInput.value) {
        navigator.clipboard.writeText(manifestInput.value);
        copyBtn.textContent = 'Copied!';
        setTimeout(() => copyBtn.textContent = 'Copy URL', 2000);
      }
    });
    
    tmdbInput.addEventListener('input', update);
    theatricalCheckbox.addEventListener('change', update);
    update();
  </script>
</body>
</html>`;
}
