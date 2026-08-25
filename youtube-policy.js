const GOOGLEVIDEO_HOST_RE = /(?:^|\.)googlevideo\.com$/i;
const PROGRESSIVE_ITAGS = new Set(['18', '22', '37', '38', '59', '78']);

export function googleVideoKind(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!GOOGLEVIDEO_HOST_RE.test(url.hostname)) return null;
    const mime = String(url.searchParams.get('mime') || url.searchParams.get('type') || '');
    if (/^video\//i.test(mime)) return 'video';
    if (/^audio\//i.test(mime)) return 'audio';
    return null;
  } catch {
    return null;
  }
}

export function isGoogleVideoUrl(rawUrl) {
  try { return GOOGLEVIDEO_HOST_RE.test(new URL(rawUrl).hostname); }
  catch { return false; }
}

export function youtubeUrlFromDiagnostics(frames = []) {
  for (const frame of frames || []) {
    for (const rawUrl of frame?.iframeUrls || []) {
      try {
        const url = new URL(rawUrl);
        if (!/(?:^|\.)youtube(?:-nocookie)?\.com$/i.test(url.hostname)) continue;
        if (/^\/embed\/[A-Za-z0-9_-]{6,}/i.test(url.pathname)) return url.href;
        if (/^\/watch$/i.test(url.pathname) && url.searchParams.get('v')) return url.href;
      } catch {
        /* iframe sem URL absoluta */
      }
    }
  }
  return null;
}

const EXTRACTOR_PLAYER_HOST_RE = /(?:^|\.)(?:youtube(?:-nocookie)?\.com|player\.vimeo\.com|fast\.wistia\.(?:net|com)|loom\.com|vidyard\.com|iframe\.mediadelivery\.net|pandavideo\.com\.br|fathom\.video|(?:play|pay|player)\.hotmart\.com)$/i;

/** URL de pagina de player que o yt-dlp consegue resolver na melhor qualidade. */
export function extractorUrlFromDiagnostics(frames = []) {
  const youtube = youtubeUrlFromDiagnostics(frames);
  if (youtube) return youtube;
  for (const frame of frames || []) {
    for (const rawUrl of frame?.iframeUrls || []) {
      try {
        const url = new URL(rawUrl);
        if (/^https?:$/.test(url.protocol) && EXTRACTOR_PLAYER_HOST_RE.test(url.hostname)) {
          return url.href;
        }
      } catch {
        /* URL relativa ou vazia */
      }
    }
  }
  return null;
}

export function selectGoogleVideoPair(candidates) {
  const videos = candidates
    .filter((stream) => googleVideoKind(stream.url) === 'video')
    .sort((left, right) => (right.height || 0) - (left.height || 0));
  if (!videos.length) return null;

  const video = videos[0];
  let itag = '';
  try { itag = new URL(video.url).searchParams.get('itag') || ''; } catch { /* URL invalida */ }
  if (PROGRESSIVE_ITAGS.has(itag)) {
    return { ...video, youtube: true, audioUrl: null };
  }

  const audio = candidates
    .filter((stream) => googleVideoKind(stream.url) === 'audio')
    .sort((left, right) => {
      const leftMp4 = /audio%2Fmp4|audio\/mp4/i.test(left.url) ? 1 : 0;
      const rightMp4 = /audio%2Fmp4|audio\/mp4/i.test(right.url) ? 1 : 0;
      return rightMp4 - leftMp4 || (right.detectedAt || 0) - (left.detectedAt || 0);
    })[0];

  return audio ? { ...video, youtube: true, audioUrl: audio.url } : null;
}
