/**
 * Course Downloader RNUNES - parser de playlists HLS (M3U8)
 *
 * Modulo puro: nao faz requisicoes, apenas interpreta texto de playlist.
 * Usado tanto pelo service worker quanto pelo documento offscreen.
 */

/** Resolve uma URI relativa da playlist contra a URL da propria playlist. */
export function resolveUrl(baseUrl, uri) {
  try {
    return new URL(uri, baseUrl).href;
  } catch {
    return uri;
  }
}

/** Le atributos no formato HLS: CHAVE=valor,CHAVE="valor, com virgula". */
function parseAttrs(input) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let match;
  while ((match = re.exec(input))) {
    let value = match[2];
    if (value.startsWith('"')) value = value.slice(1, -1);
    attrs[match[1]] = value;
  }
  return attrs;
}

function toLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function isMasterPlaylist(text) {
  return /^#EXT-X-STREAM-INF:/m.test(text);
}

/**
 * Interpreta uma playlist mestra e devolve as variantes disponiveis.
 * @returns {{ variants: Array<object>, sessionKey: string|null }}
 */
export function parseMaster(text, baseUrl) {
  const lines = toLines(text);
  const variants = [];
  let sessionKey = null;
  let pending = null;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-SESSION-KEY:')) {
      const attrs = parseAttrs(line.slice('#EXT-X-SESSION-KEY:'.length));
      if (attrs.METHOD && attrs.METHOD !== 'NONE') sessionKey = attrs.METHOD;
      continue;
    }

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = parseAttrs(line.slice('#EXT-X-STREAM-INF:'.length));
      const dims = (attrs.RESOLUTION || '').match(/^(\d+)x(\d+)$/i);
      pending = {
        bandwidth: Number(attrs.BANDWIDTH || attrs['AVERAGE-BANDWIDTH'] || 0),
        width: dims ? Number(dims[1]) : null,
        height: dims ? Number(dims[2]) : null,
        codecs: attrs.CODECS || null,
        frameRate: attrs['FRAME-RATE'] ? Number(attrs['FRAME-RATE']) : null
      };
      continue;
    }

    if (line.startsWith('#')) continue;

    if (pending) {
      pending.url = resolveUrl(baseUrl, line);
      pending.label = pending.height
        ? `${pending.width}x${pending.height}`
        : pending.bandwidth
          ? `${Math.round(pending.bandwidth / 1000)} kbps`
          : 'variante';
      variants.push(pending);
      pending = null;
    }
  }

  return { variants, sessionKey };
}

/**
 * Escolhe a melhor variante: maior area de imagem e, em empate, maior bitrate.
 * @param {Array<object>} variants
 */
export function pickBestVariant(variants) {
  if (!variants.length) return null;
  return [...variants].sort((a, b) => {
    const areaA = (a.width || 0) * (a.height || 0);
    const areaB = (b.width || 0) * (b.height || 0);
    if (areaA !== areaB) return areaB - areaA;
    return (b.bandwidth || 0) - (a.bandwidth || 0);
  })[0];
}

/**
 * Interpreta uma playlist de midia (lista de segmentos).
 * @returns {{
 *   segments: Array<{url:string,duration:number}>,
 *   initUrl: string|null,
 *   encryption: string|null,
 *   isLive: boolean,
 *   duration: number
 * }}
 */
export function parseMedia(text, baseUrl) {
  const lines = toLines(text);
  const segments = [];
  let initUrl = null;
  let encryption = null;
  let hasEndList = false;
  let duration = 0;
  let nextDuration = 0;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttrs(line.slice('#EXT-X-KEY:'.length));
      if (attrs.METHOD && attrs.METHOD !== 'NONE') encryption = attrs.METHOD;
      continue;
    }

    if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttrs(line.slice('#EXT-X-MAP:'.length));
      if (attrs.URI) initUrl = resolveUrl(baseUrl, attrs.URI);
      continue;
    }

    if (line.startsWith('#EXT-X-ENDLIST')) {
      hasEndList = true;
      continue;
    }

    if (line.startsWith('#EXTINF:')) {
      nextDuration = parseFloat(line.slice('#EXTINF:'.length)) || 0;
      continue;
    }

    if (line.startsWith('#')) continue;

    segments.push({ url: resolveUrl(baseUrl, line), duration: nextDuration });
    duration += nextDuration;
    nextDuration = 0;
  }

  return { segments, initUrl, encryption, isLive: !hasEndList, duration };
}

/**
 * Decide o container de saida a partir da extensao dos segmentos.
 * fMP4/CMAF (init + .m4s) concatenado ja e um MP4 valido.
 * MPEG-TS concatenado precisa de remux com FFmpeg.
 * @returns {'mp4'|'ts'}
 */
export function detectContainer(media) {
  if (media.initUrl) return 'mp4';
  const first = media.segments[0];
  if (!first) return 'ts';
  const path = (() => {
    try {
      return new URL(first.url).pathname.toLowerCase();
    } catch {
      return first.url.toLowerCase();
    }
  })();
  if (/\.(m4s|mp4|cmfv|m4v)$/.test(path)) return 'mp4';
  return 'ts';
}

/** Transforma o titulo da aula em nome de arquivo seguro no Windows/macOS/Linux. */
export function sanitizeFilename(title, fallback = 'aula') {
  let name = String(title || '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
    .trim();

  if (name.length > 120) name = name.slice(0, 120).trim();
  return name || fallback;
}

/** Formata bytes para exibicao no popup. */
export function formatBytes(bytes) {
  if (!bytes) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(1)} MB`;
}

/** Formata segundos como mm:ss / hh:mm:ss. */
export function formatDuration(seconds) {
  const total = Math.round(seconds || 0);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
