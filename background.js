/**
 * Course Downloader RNUNES - service worker (MV3)
 *
 * Responsabilidades:
 *  - observar requisicoes de rede e guardar as URLs .m3u8 vistas em cada aba;
 *  - ler a playlist mestra para descobrir a melhor qualidade disponivel;
 *  - orquestrar o download (executado no documento offscreen) e expor o
 *    progresso para o popup.
 *
 * Somente URLs de playlist sao lidas. Nenhum cabecalho, cookie ou token da
 * pagina e lido ou armazenado; quando o portal exige autenticacao, o proprio
 * navegador pode usar a sessao corrente. DRM e criptografia sao recusados.
 */

import {
  parseMaster,
  pickBestVariant,
  isMasterPlaylist,
  sanitizeFilename
} from './hls.js';
import {
  downloadMatchesKind,
  downloadMatchesLesson,
  lessonDownloadBases,
  nativeVideoTarget,
  normalizeDownloadPath
} from './download-paths.js';
import {
  autoSkipProtectedItem,
  EMPTY_LESSON_PATTERN,
  isAuthorizationDownloadError,
  isProtectedMediaError,
  stopBatchOnItemFailure
} from './batch-policy.js';
import { COMPLETION_CONTROL_PATTERN } from './navigation-policy.js';
import {
  extractorUrlFromDiagnostics,
  googleVideoKind,
  isGoogleVideoUrl,
  selectGoogleVideoPair,
  youtubeUrlFromDiagnostics
} from './youtube-policy.js';

const STORAGE_KEY = 'streams';
const MAX_PER_TAB = 200;
const LEGACY_FAKE_DATE_SCRIPT_ID = 'fake-date-main';
const LESSON_DEBUG_SCRIPT_ID = 'lesson-debug-main';
const LESSON_DEBUG_STORE_KEY = '__COURSE_DOWNLOADER_LESSON_DEBUG__';
const MEDIA_RESOLVER_TEMPLATE_KEY = 'mediaResolverTemplate';

const LESSON_DEBUG_SCRIPT = {
  id: LESSON_DEBUG_SCRIPT_ID,
  matches: ['http://*/*', 'https://*/*'],
  js: ['lesson-debug.js'],
  runAt: 'document_start',
  world: 'MAIN',
  allFrames: true,
  persistAcrossSessions: true
};

const OBSERVED_TYPES = [
  'main_frame',
  'xmlhttprequest',
  'media',
  'object',
  'other'
];

// Cobre: /video.m3u8, /video.m3u8?token=..., ?url=algo.m3u8&..., /hls/m3u8/, ?format=m3u8
const M3U8_RE = /\.m3u8(?![a-z0-9])|[?&/=]m3u8(?![a-z0-9])/i;
const MP4_RE = /\.mp4(?![a-z0-9])|[?&]format=mp4(?![a-z0-9])/i;
const MPD_RE = /\.mpd(?![a-z0-9])|[?&/=]mpd(?![a-z0-9])/i;
const WEBM_RE = /\.(?:webm|mkv|mov)(?![a-z0-9])|[?&]format=(?:webm|mkv|mov)(?![a-z0-9])/i;
const PANDA_HOST_RE = /(?:^|\.)pandavideo\.com\.br$/i;
const PANDA_FALLBACK_IDS = new Set([
  // Player Panda: substitutos internos para 403 e sharelock/comparison invalido.
  '48af5a59-3ac4-480e-abff-905690d94567',
  'cd676325-3f2d-4ad5-b95c-c2a683d7b0cc',
  // Vinheta generica "This video encountered an error".
  'f7a741ee-5cad-4f8c-87bc-f6a008776edb'
]);
const INTERNAL_MEDIA_RE = /(?:^|[\/_.-])(?:error|fallback|placeholder|preview)(?:[\/_.-]|$)/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @type {Map<number, Array<object>> | null} */
let tabStreams = null;
/** @type {Promise<void> | null} */
let loading = null;

/** Cache de leituras de playlist mestra: url -> { variants, best, error }. */
const masterCache = new Map();
/** Cache de validacao de arquivos diretos; impede salvar uma pagina HTML como video. */
const directMediaCache = new Map();

/** Estado do unico job de download ativo/recente. */
let job = null;

/** @type {Promise<void> | null} Evita criar dois documentos offscreen. */
let creatingOffscreen = null;

/** Instrumentacao temporaria: existe apenas em memoria e nunca altera status. */
const lessonDebugContexts = new Map();
const DEBUG_REQUEST_RE = /(graphql|api|video|media|playback|asset|stream|manifest|playlist|m3u8|mp4|lesson|content)/i;
const PLAYER_FLOW_RE = /(lesson|content|media|video|player|playback|asset|stream|watch)/i;
const PLAYER_ID_KEY_RE = /^(?:lesson|content|video|media|asset|playback)(?:_?id)?$|^id$/i;
const DEBUG_SECRET_RE = /(authorization|cookie|token|secret|password|signature|credential|api[-_]?key)/i;
let observedPlayerFlow = null;

async function syncLessonDebugScript() {
  const registered = await chrome.scripting.getRegisteredContentScripts({
    ids: [LESSON_DEBUG_SCRIPT_ID]
  });
  if (registered.length) await chrome.scripting.updateContentScripts([LESSON_DEBUG_SCRIPT]);
  else await chrome.scripting.registerContentScripts([LESSON_DEBUG_SCRIPT]);
}

async function removeLegacyFakeDate() {
  const registered = await chrome.scripting.getRegisteredContentScripts({
    ids: [LEGACY_FAKE_DATE_SCRIPT_ID]
  });
  if (registered.length) {
    await chrome.scripting.unregisterContentScripts({ ids: [LEGACY_FAKE_DATE_SCRIPT_ID] });
  }
  await Promise.all([
    chrome.storage.local.remove('fakeDateEnabled'),
    chrome.storage.session.remove('fakeDateRescanTabs')
  ]);
}

removeLegacyFakeDate().catch(() => {});
syncLessonDebugScript().catch(() => {});

/* ------------------------------------------------------------------ *
 * Persistencia das deteccoes
 * ------------------------------------------------------------------ */

function ensureLoaded() {
  if (tabStreams) return Promise.resolve();
  if (!loading) {
    loading = chrome.storage.session
      .get(STORAGE_KEY)
      .then((data) => {
        const raw = (data && data[STORAGE_KEY]) || {};
        tabStreams = new Map(
          Object.entries(raw).map(([tabId, list]) => [Number(tabId), list])
        );
      })
      .catch(() => {
        tabStreams = new Map();
      })
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

function persist() {
  const plain = {};
  for (const [tabId, list] of tabStreams) plain[tabId] = list;
  chrome.storage.session.set({ [STORAGE_KEY]: plain }).catch(() => {});
}

/* ------------------------------------------------------------------ *
 * Heuristicas de leitura da URL
 * ------------------------------------------------------------------ */

function detectResolution(url) {
  let path;
  try {
    const u = new URL(url);
    path = u.pathname + u.search;
  } catch {
    path = url;
  }

  const dims = path.match(/(\d{3,4})\s*[xX]\s*(\d{3,4})/);
  if (dims) return { label: `${dims[1]}x${dims[2]}`, height: Number(dims[2]) };

  const progressive = path.match(/(\d{3,4})[pP](?![a-zA-Z0-9])/);
  if (progressive) return { label: `${progressive[1]}p`, height: Number(progressive[1]) };

  const bare = path.match(/(?:^|[/_\-=])(2160|1440|1080|720|576|480|360|240|144)(?:[/_\-.]|$)/);
  if (bare) return { label: `${bare[1]}p`, height: Number(bare[1]) };

  const bitrate = path.match(/(\d{3,5})\s*k(?:bps)?(?![a-zA-Z0-9])/i);
  if (bitrate) return { label: `${bitrate[1]} kbps`, height: null };

  return null;
}

function looksLikeMaster(url) {
  return /(master|main|index|playlist|manifest)[^/]*\.m3u8/i.test(url);
}

function shortName(url) {
  try {
    const u = new URL(url);
    const file = u.pathname.split('/').filter(Boolean).pop();
    return file || u.hostname;
  } catch {
    return url.slice(0, 60);
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function pandaEmbedId(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!PANDA_HOST_RE.test(url.hostname) || !/^player-/i.test(url.hostname)) return null;
    const id = url.searchParams.get('v') || '';
    return UUID_RE.test(id) ? id.toLowerCase() : null;
  } catch {
    return null;
  }
}

function pandaMediaId(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!PANDA_HOST_RE.test(url.hostname)) return null;
    const id = url.pathname.split('/').filter(Boolean).find((part) => UUID_RE.test(part));
    return id ? id.toLowerCase() : null;
  } catch {
    return null;
  }
}

function isRejectedMediaUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const mediaId = pandaMediaId(url.href);
    const internalQuery = [...url.searchParams.keys()].some((key) =>
      /^(?:error|fallback|placeholder|preview)$/i.test(key)
    );
    return Boolean(
      (mediaId && PANDA_FALLBACK_IDS.has(mediaId)) ||
      INTERNAL_MEDIA_RE.test(`${url.hostname}${url.pathname}`) ||
      internalQuery
    );
  } catch {
    return true;
  }
}

function activeMediaBindings(frames = []) {
  const pandaIds = new Set();
  for (const frame of frames || []) {
    const urls = [
      typeof frame === 'string' ? frame : frame?.documentUrl,
      ...((typeof frame === 'object' && frame?.iframeUrls) || [])
    ];
    for (const url of urls) {
      const id = pandaEmbedId(url);
      if (id) pandaIds.add(id);
    }
  }
  return { pandaIds };
}

function playlistMatchesMediaIdentity(stream, probed) {
  const mediaId = stream.mediaId || pandaMediaId(stream.url);
  if (!mediaId || !probed?.variants?.length) return true;

  // O CDN Panda responde 200 para um video ausente, mas a playlist mestra
  // redireciona silenciosamente as variantes para a vinheta de erro. A URL
  // externa continua com o ID pedido; por isso a identidade precisa ser
  // conferida tambem dentro do manifesto.
  return probed.variants.every((variant) => {
    const variantId = pandaMediaId(variant.url);
    return !variantId || variantId === mediaId;
  });
}

/* ------------------------------------------------------------------ *
 * Estado por aba
 * ------------------------------------------------------------------ */

function updateBadge(tabId) {
  const count = (tabStreams.get(tabId) || []).length;
  const text = count ? String(Math.min(count, 999)) : '';
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  if (count) {
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#3b82f6' }).catch(() => {});
  }
}

function clearTab(tabId, { keepEntry = false } = {}) {
  if (keepEntry) tabStreams.set(tabId, []);
  else tabStreams.delete(tabId);
  persist();
  updateBadge(tabId);
}

async function addStream(tabId, url, type, formatHint = null, context = {}) {
  await ensureLoaded();

  if (isRejectedMediaUrl(url)) return false;

  const mediaId = pandaMediaId(url);
  const embedId = pandaEmbedId(context.documentUrl || context.initiator || '');
  // O player pode trocar sua source pela vinheta interna de erro. Se o frame
  // identifica a aula pelo ?v=, uma playlist Panda diferente nao pertence a ela.
  if (mediaId && embedId && mediaId !== embedId) return false;

  const list = tabStreams.get(tabId) || [];
  const existing = list.find((item) => item.url === url);
  if (existing) {
    if (embedId && mediaId === embedId) existing.boundToEmbed = true;
    if (!existing.documentUrl && context.documentUrl) existing.documentUrl = context.documentUrl;
    if (!existing.initiator && context.initiator) existing.initiator = context.initiator;
    if (!existing.contentType && context.contentType) existing.contentType = context.contentType;
    if (context.requestHeaders) existing.requestHeaders = context.requestHeaders;
    if (context.verifiedByHeaders) existing.verifiedByHeaders = true;
    if (existing.type !== type) existing.sources = [...new Set([...(existing.sources || [existing.type]), type])];
    persist();
    return true;
  }
  if (list.length >= MAX_PER_TAB) return false;

  const resolution = detectResolution(url);
  const googleKind = googleVideoKind(url);
  const format = formatHint || (M3U8_RE.test(url) ? 'hls' : (MPD_RE.test(url) ? 'dash' : 'file'));
  list.push({
    url,
    name: shortName(url),
    host: hostOf(url),
    type,
    format,
    master: looksLikeMaster(url),
    resolution: resolution ? resolution.label : null,
    height: resolution ? resolution.height : null,
    provider: mediaId ? 'panda' : null,
    mediaId,
    documentUrl: context.documentUrl || null,
    initiator: context.initiator || null,
    requestHeaders: context.requestHeaders || null,
    contentType: context.contentType || (googleKind ? `${googleKind}/mp4` : null),
    verifiedByHeaders: Boolean(context.verifiedByHeaders),
    boundToEmbed: Boolean(mediaId && embedId && mediaId === embedId),
    detectedAt: Date.now()
  });

  tabStreams.set(tabId, list);
  persist();
  updateBadge(tabId);
  return true;
}

function recordLessonNetwork(details, contentType = '') {
  const context = lessonDebugContexts.get(details.tabId);
  if (!context || context.network.length >= 150) return;
  if (!['main_frame', 'xmlhttprequest', 'media', 'object'].includes(details.type) &&
      !DEBUG_REQUEST_RE.test(details.url || '')) return;
  context.network.push({
    transport: 'webRequest',
    method: details.method || 'GET',
    type: details.type,
    url: details.url,
    status: details.statusCode || null,
    contentType: contentType || null
  });
}

/* ------------------------------------------------------------------ *
 * Captura
 * ------------------------------------------------------------------ */

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const { tabId, url, type } = details;
    if (tabId < 0) return;

    if (type === 'main_frame') {
      ensureLoaded().then(() => clearTab(tabId));
      return;
    }

    if (!M3U8_RE.test(url) && !MP4_RE.test(url) && !MPD_RE.test(url) &&
        !WEBM_RE.test(url) && !isGoogleVideoUrl(url)) return;
    const format = M3U8_RE.test(url) ? 'hls' : (MPD_RE.test(url) ? 'dash' : 'file');
    addStream(tabId, url, type, format, {
      documentUrl: details.documentUrl || null,
      initiator: details.initiator || null
    });
  },
  { urls: ['http://*/*', 'https://*/*'], types: OBSERVED_TYPES }
);

// Repassa somente contexto publico usado por CDNs contra hotlink. Cookies,
// Authorization e outros segredos nunca entram no estado da extensao.
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const { tabId, url, type, requestHeaders = [] } = details;
    if (tabId < 0 || (!M3U8_RE.test(url) && !MPD_RE.test(url) && !MP4_RE.test(url) &&
        !WEBM_RE.test(url) && !isGoogleVideoUrl(url))) return;
    const allowed = new Set(['origin', 'referer', 'user-agent']);
    const safeHeaders = {};
    for (const header of requestHeaders) {
      const name = String(header.name || '').toLowerCase();
      if (allowed.has(name) && header.value) safeHeaders[name] = header.value;
    }
    const format = M3U8_RE.test(url) ? 'hls' : (MPD_RE.test(url) ? 'dash' : 'file');
    addStream(tabId, url, type, format, {
      documentUrl: details.documentUrl || null,
      initiator: details.initiator || null,
      requestHeaders: safeHeaders
    });
  },
  { urls: ['http://*/*', 'https://*/*'], types: OBSERVED_TYPES },
  ['requestHeaders', 'extraHeaders']
);

// Alguns players usam uma URL assinada sem extensao. Nesse caso o cabecalho
// Content-Type e a unica forma confiavel de reconhecer a playlist/arquivo.
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const { tabId, url, type, responseHeaders = [] } = details;
    if (tabId < 0 || type === 'main_frame') return;
    const contentType = responseHeaders.find((header) => header.name.toLowerCase() === 'content-type');
    const value = (contentType && contentType.value) || '';
    recordLessonNetwork(details, value);
    const isHls = /(mpegurl|vnd\.apple\.mpegurl)/i.test(value);
    const isDash = /(application\/dash\+xml|application\/mpd)/i.test(value);
    const fathomContext = /https?:\/\/(?:[^/]+\.)?fathom\.video\b/i.test(
      `${details.documentUrl || ''} ${details.initiator || ''}`
    );
    // O bonus "Call Ao Vivo Gravada" monta o player do Fathom diretamente no
    // DOM do portal (sem iframe). Nesse caso documentUrl/initiator continuam
    // apontando para a Turing Academy, embora o arquivo venha do Google Video.
    // Durante a captura isolada de uma aula, o contexto ativo da propria aba e
    // um vinculo mais confiavel que o dominio do documento.
    const activeLessonCapture = lessonDebugContexts.has(tabId);
    const googleVideoAllowed = !/\.googlevideo\.com$/i.test(hostOf(url)) ||
      fathomContext || activeLessonCapture;
    const isMp4 = /video\/mp4/i.test(value) && googleVideoAllowed;
    const looksFragment = /\.(?:m4s|cmfv|cmfa|ts)(?:$|[?#])|(?:segment|chunk)[_/-]?\d/i.test(url);
    const isOtherVideo = !looksFragment && (
      /video\/(?:webm|quicktime|x-matroska|ogg)/i.test(value) ||
      (type === 'media' && /application\/octet-stream/i.test(value))
    );
    if (!isHls && !isDash && !isMp4 && !isOtherVideo) return;
    addStream(tabId, url, type, isHls ? 'hls' : (isDash ? 'dash' : 'file'), {
      documentUrl: details.documentUrl || null,
      initiator: details.initiator || null,
      contentType: value,
      verifiedByHeaders: true
    });
  },
  { urls: ['http://*/*', 'https://*/*'], types: OBSERVED_TYPES },
  ['responseHeaders']
);

chrome.tabs.onRemoved.addListener((tabId) => {
  ensureLoaded().then(() => {
    if (tabStreams.has(tabId)) {
      tabStreams.delete(tabId);
      persist();
    }
  });
});

/* ------------------------------------------------------------------ *
 * Leitura da playlist mestra (melhor qualidade)
 * ------------------------------------------------------------------ */

async function fetchText(url, signal) {
  const response = await fetch(url, {
    // A playlist pode pertencer ao proprio portal autenticado. Nao copiamos
    // nem persistimos cookies; o navegador decide quais credenciais da sessao
    // podem acompanhar esta requisicao.
    credentials: 'include',
    cache: 'no-store',
    signal
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ao ler a playlist`);
  }
  return response.text();
}

/**
 * Le a playlist e descobre as qualidades. Resultado fica em cache por URL.
 * @param {string} url
 */
async function probeMaster(url) {
  if (masterCache.has(url)) return masterCache.get(url);

  let result;
  try {
    const text = await fetchText(url);

    if (!isMasterPlaylist(text)) {
      result = { variants: [], best: null, single: true, error: null };
    } else {
      const { variants, sessionKey } = parseMaster(text, url);
      result = {
        variants: variants.map((v) => ({
          url: v.url,
          label: v.label,
          width: v.width,
          height: v.height,
          bandwidth: v.bandwidth
        })),
        best: pickBestVariant(variants),
        single: false,
        error: sessionKey ? `Playlist protegida (${sessionKey})` : null
      };
    }
  } catch (error) {
    result = { variants: [], best: null, single: false, error: error.message };
  }

  masterCache.set(url, result);
  return result;
}

async function probeDirectMedia(url) {
  if (directMediaCache.has(url)) return directMediaCache.get(url);
  const inspect = (response) => {
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    const finalUrl = response.url || url;
    const html = /(?:text\/html|application\/xhtml\+xml)/i.test(contentType);
    const mediaType = /^video\//i.test(contentType) ||
      /application\/(?:octet-stream|x-mpegurl)/i.test(contentType);
    const mediaUrl = MP4_RE.test(finalUrl) || WEBM_RE.test(finalUrl);
    return {
      valid: Boolean(response.ok && !html && (mediaType || mediaUrl)),
      rejectedHtml: html,
      contentType,
      finalUrl
    };
  };

  let result = { valid: false, rejectedHtml: false, contentType: '', finalUrl: url };
  try {
    const head = await fetch(url, {
      method: 'HEAD',
      credentials: 'include',
      cache: 'no-store',
      redirect: 'follow'
    });
    result = inspect(head);
    if (result.valid || result.rejectedHtml) {
      directMediaCache.set(url, result);
      return result;
    }
  } catch {
    /* alguns CDNs recusam HEAD; tenta apenas o primeiro byte */
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        credentials: 'include',
        cache: 'no-store',
        redirect: 'follow',
        signal: controller.signal
      });
      result = inspect(response);
      try { await response.body?.cancel(); } catch { /* corpo ja encerrado */ }
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    /* candidato nao verificavel nao e tratado como video */
  }
  directMediaCache.set(url, result);
  return result;
}

/* ------------------------------------------------------------------ *
 * Titulo da aula
 * ------------------------------------------------------------------ */

/**
 * Le o titulo visivel da aula na pagina. Cai para o titulo da aba se a
 * injecao nao for possivel (paginas internas do Chrome, por exemplo).
 */
async function getLessonTitle(tabId) {
  let tabTitle = '';
  try {
    const tab = await chrome.tabs.get(tabId);
    tabTitle = tab.title || '';
  } catch {
    /* aba fechada */
  }

  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
        const candidates = [
          'main h1',
          'article h1',
          'h1',
          '[class*="lesson"] [class*="title"]',
          '[class*="aula"] [class*="title"]',
          'h2'
        ];
        for (const selector of candidates) {
          for (const el of document.querySelectorAll(selector)) {
            const text = clean(el.innerText || el.textContent);
            if (text.length >= 3 && text.length <= 180) return text;
          }
        }
        return clean(document.title);
      }
    });
    if (injection && injection.result) return injection.result;
  } catch {
    /* sem permissao de injecao nesta pagina */
  }

  return tabTitle || 'aula';
}

/* ------------------------------------------------------------------ *
 * Documento offscreen (faz o download e monta o arquivo)
 * ------------------------------------------------------------------ */

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (creatingOffscreen) return creatingOffscreen;

  creatingOffscreen = chrome.offscreen
    .createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.BLOBS],
      justification:
        'Unir os segmentos da playlist HLS em um unico arquivo de video e salva-lo.'
    })
    .catch((error) => {
      // Corrida com outra chamada: o documento ja existe.
      if (!/single offscreen/i.test(String(error && error.message))) throw error;
    })
    .finally(() => {
      creatingOffscreen = null;
    });

  return creatingOffscreen;
}

/**
 * chrome.offscreen.createDocument pode resolver antes de offscreen.js registrar
 * o listener. Repete o envio por alguns instantes em vez de falhar na primeira
 * tentativa.
 */
async function sendToOffscreen(message, attempts = 12) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      if (attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

function newJob(fields) {
  job = {
    id: `job-${Date.now()}`,
    status: 'running',
    phase: 'Preparando…',
    current: 0,
    total: 0,
    receivedBytes: 0,
    filename: null,
    quality: null,
    container: null,
    error: null,
    startedAt: Date.now(),
    ...fields
  };
  return job;
}

/**
 * Inicia o download da aula.
 * @param {{ tabId: number, url: string }} params
 */
async function startDownload({ tabId, url, format = 'hls', baseName: explicitName }) {
  if (job && job.status === 'running') {
    return { ok: false, error: 'Ja existe um download em andamento.' };
  }

  // Em lote o caminho completo ja vem pronto; avulso usa a raiz padrao.
  const title = explicitName || (await getLessonTitle(tabId));
  const baseName = explicitName || `Course Downloader RNUNES/${sanitizeFilename(title)}`;

  newJob({ tabId, sourceUrl: url, title, baseName });

  try {
    await ensureOffscreen();
  } catch (error) {
    job.status = 'error';
    job.error = `Nao foi possivel iniciar o worker de download: ${error.message}`;
    return { ok: false, error: job.error };
  }

  sendToOffscreen({
    target: 'offscreen',
    type: 'run-job',
    jobId: job.id,
    url,
    format,
    baseName
  }).catch((error) => {
    job.status = 'error';
    job.phase = 'Falhou.';
    job.error = `Falha ao iniciar o job: ${error.message}`;
  });

  return { ok: true, job };
}

async function cancelDownload() {
  if (!job || job.status !== 'running') return { ok: false };
  job.phase = 'Cancelando…';
  try {
    await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'cancel-job',
      jobId: job.id
    });
  } catch {
    job.status = 'canceled';
    job.error = null;
  }
  return { ok: true };
}

/** downloadId -> jobId, para acompanhar a gravacao em disco. */
const downloadJobs = new Map();

/**
 * O service worker pode ser reiniciado no meio de um download (o estado em
 * memoria se perde, mas o documento offscreen continua trabalhando). Ao receber
 * um relatorio de um job desconhecido, remonta o registro para nao perder nem o
 * progresso na tela nem o arquivo pronto.
 */
function adoptJob(jobId) {
  if (job && job.id === jobId) return job;
  job = {
    id: jobId,
    status: 'running',
    phase: 'Retomando…',
    current: 0,
    total: 0,
    receivedBytes: 0,
    filename: null,
    quality: null,
    container: null,
    error: null,
    startedAt: Date.now()
  };
  return job;
}

/**
 * Recebe a blob URL montada no offscreen e grava o arquivo.
 * A API chrome.downloads nao existe no documento offscreen, por isso a
 * gravacao acontece aqui.
 */
async function saveBlob({ jobId, objectUrl, filename, container, size }) {
  adoptJob(jobId);

  job.phase = 'Salvando o arquivo…';
  job.container = container;
  job.receivedBytes = size;
  // Caminho relativo COMPLETO: so o nome do arquivo esconderia as pastas e
  // manda o usuario procurar na raiz de Downloads.
  job.relativePath = filename;
  job.filename = filename.split('/').pop();

  try {
    const downloadId = await chrome.downloads.download({
      url: objectUrl,
      filename,
      conflictAction: 'uniquify'
    });
    downloadJobs.set(downloadId, jobId);
    job.downloadId = downloadId;
  } catch (error) {
    job.status = 'error';
    job.error = `Nao foi possivel salvar: ${error.message}`;
    releaseBlob(jobId);
    closeOffscreenIfIdle();
  }
}

function releaseBlob(jobId) {
  chrome.runtime
    .sendMessage({ target: 'offscreen', type: 'release-blob', jobId })
    .catch(() => {});
}

/**
 * "Concluido" pela API nao prova que o arquivo esta la: antivirus, Safe
 * Browsing ou uma limpeza posterior podem remove-lo. Pergunta ao Chrome onde o
 * arquivo foi parar de verdade e se ele ainda existe.
 */
async function confirmDownload(downloadId) {
  try {
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (!item) return null;
    return {
      absolutePath: item.filename || null,
      exists: item.exists !== false,
      state: item.state,
      danger: item.danger,
      fileSize: item.fileSize || item.bytesReceived || 0
    };
  } catch {
    return null;
  }
}

chrome.downloads.onChanged.addListener(async (delta) => {
  const jobId = downloadJobs.get(delta.id);
  if (!jobId || !delta.state) return;

  if (delta.state.current === 'complete') {
    downloadJobs.delete(delta.id);
    const info = await confirmDownload(delta.id);

    if (job && job.id === jobId) {
      job.downloadId = delta.id;
      job.savedPath = info ? info.absolutePath : null;
      job.exists = info ? info.exists : null;

      if (info && info.exists === false) {
        job.status = 'error';
        job.phase = 'O arquivo sumiu depois de salvo.';
        job.error =
          `O Chrome gravou em "${info.absolutePath}" mas o arquivo nao esta mais la. ` +
          'Verifique o antivirus ou a pasta de quarentena.';
      } else {
        // Se o host de conversao estiver instalado, o .ts vira .mp4 aqui.
        if (job.container === 'ts') {
          job.phase = 'Convertendo para MP4…';
          await tryAutoRemux(job);
        }
        job.status = 'done';
        job.phase = 'Concluido.';
      }
    }

    // Na fila, guarda o caminho por aula.
    if (batch) {
      const item = batch.items.find((entry) => entry.jobId === jobId);
      if (item && info) {
        item.savedPath = info.absolutePath;
        item.exists = info.exists;
        saveBatch();
      }
    }

    releaseBlob(jobId);
    closeOffscreenIfIdle();
  } else if (delta.state.current === 'interrupted') {
    downloadJobs.delete(delta.id);
    if (job && job.id === jobId) {
      job.status = 'error';
      job.error = `Gravacao interrompida (${(delta.error && delta.error.current) || 'motivo desconhecido'}).`;
      job.phase = 'Falhou.';
    }
    releaseBlob(jobId);
    closeOffscreenIfIdle();
  }
});

/* ------------------------------------------------------------------ *
 * Conversao automatica TS -> MP4 (opcional)
 *
 * Uma extensao nao pode executar o FFmpeg sozinha. Se o usuario instalar o
 * host de mensagens nativas (tools/instalar-auto-mp4.ps1), o arquivo .ts vira
 * .mp4 sozinho logo apos o download. Sem o host, nada muda: o arquivo .ts
 * continua salvo e o popup segue indicando o remux manual.
 * ------------------------------------------------------------------ */

const REMUX_HOST = 'com.course_downloader.remux';
/** null = ainda nao testado; false = host ausente (nao tenta mais). */
let remuxHostAvailable = null;

function sendNative(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(REMUX_HOST, message, (response) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(response || { ok: false, error: 'sem resposta do host' });
      });
    } catch (error) {
      resolve({ ok: false, error: error.message });
    }
  });
}

function sendNativeDownload(message, onProgress) {
  return new Promise((resolve) => {
    let settled = false;
    let port;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
      try { port.disconnect(); } catch { /* porta ja encerrada */ }
    };
    try {
      port = chrome.runtime.connectNative(REMUX_HOST);
      port.onMessage.addListener((response) => {
        if (response?.type === 'download-progress') {
          if (typeof onProgress === 'function') onProgress(response);
          return;
        }
        finish(response || { ok: false, error: 'sem resposta do host' });
      });
      port.onDisconnect.addListener(() => {
        if (settled) return;
        finish({
          ok: false,
          error: chrome.runtime.lastError?.message || 'o host encerrou antes de concluir o download'
        });
      });
      port.postMessage(message);
    } catch (error) {
      finish({ ok: false, error: error.message });
    }
  });
}

/**
 * @param {object} target job ou item da fila, com savedPath e container
 * @returns {Promise<boolean>} true se virou .mp4
 */
async function tryAutoRemux(target) {
  if (!target || target.container !== 'ts' || !target.savedPath) return false;
  if (remuxHostAvailable === false) return false;

  const response = await sendNative({ action: 'remux', file: target.savedPath, deleteSource: true });

  if (!response.ok) {
    // Host ausente: para de tentar nesta sessao e mantem o fluxo manual.
    if (/not found|nao encontrado|Specified native messaging host/i.test(response.error || '')) {
      remuxHostAvailable = false;
    }
    target.remuxError = response.error || null;
    return false;
  }

  remuxHostAvailable = true;
  target.savedPath = response.output;
  target.filename = String(response.output).split(/[\\/]/).pop();
  target.container = 'mp4';
  target.remuxed = true;
  return true;
}

async function nativeFileExists(file) {
  if (!file || remuxHostAvailable === false) return false;
  const response = await sendNative({ action: 'exists', file });
  if (!response.ok && /not found|nao encontrado|Specified native messaging host/i.test(response.error || '')) {
    remuxHostAvailable = false;
  } else if (response.ok) {
    remuxHostAvailable = true;
  }
  return Boolean(response.ok && response.exists);
}

/**
 * O documento offscreen monta HLS, mas um manifesto DASH pode separar audio e
 * video em trilhas diferentes. O host nativo entrega a URL ao FFmpeg e grava o
 * MP4 na mesma pasta indicada por um pequeno arquivo marcador do Chrome.
 */
async function downloadNativeMedia(
  item,
  url,
  { referer = null, headers = null, audioUrl = null } = {}
) {
  if (remuxHostAvailable === false) {
    return {
      ok: false,
      error: 'o vídeo precisa do conversor automático (FFmpeg/host nativo) instalado'
    };
  }

  const target = nativeVideoTarget(item.path);
  item.progressPercent = 0;
  item.receivedBytes = 0;
  item.downloadMode = 'FFmpeg';
  item.downloadStartedAt = Date.now();
  item.downloadBytesPerSecond = 0;
  item.downloadEtaSeconds = null;
  const response = await sendNativeDownload({
    action: 'download-media',
    url,
    audioUrl,
    directory: target.directory,
    name: target.filename,
    referer: referer || item.actualUrl || item.url || '',
    headers
  }, (progress) => {
    const now = Date.now();
    const previousBytes = Number(item.progressSampleBytes ?? item.receivedBytes ?? 0);
    const previousAt = Number(item.progressSampleAt || 0);
    if (!item.downloadStartedAt) item.downloadStartedAt = now;
    if (Number.isFinite(progress.percent)) item.progressPercent = progress.percent;
    if (Number.isFinite(progress.bytes)) item.receivedBytes = progress.bytes;
    if (progress.quality) item.downloadQuality = progress.quality;
    if (Number.isFinite(progress.current)) item.progressCurrentSeconds = progress.current;
    if (Number.isFinite(progress.duration)) item.progressDurationSeconds = progress.duration;
    if (progress.speed) item.ffmpegSpeed = progress.speed;
    const elapsedSeconds = Math.max(0.001, (now - item.downloadStartedAt) / 1000);
    if (previousAt && item.receivedBytes > previousBytes && now > previousAt) {
      const instantRate = (item.receivedBytes - previousBytes) / ((now - previousAt) / 1000);
      item.downloadBytesPerSecond = item.downloadBytesPerSecond > 0
        ? item.downloadBytesPerSecond * 0.65 + instantRate * 0.35
        : instantRate;
    } else if (!(item.downloadBytesPerSecond > 0) && elapsedSeconds >= 1) {
      item.downloadBytesPerSecond = item.receivedBytes / elapsedSeconds;
    }
    item.progressSampleBytes = item.receivedBytes;
    item.progressSampleAt = now;
    item.downloadEtaSeconds = Number.isFinite(progress.eta)
      ? progress.eta
      : item.progressPercent > 0 && item.progressPercent < 100
      ? elapsedSeconds * (100 - item.progressPercent) / item.progressPercent
      : null;
    const details = [];
    if (progress.quality) details.push(progress.quality);
    if (!Number.isFinite(progress.percent) && progress.current) details.push(`${Math.floor(progress.current)}s baixados`);
    if (progress.speed) details.push(progress.speed);
    item.phase = details.length ? `Baixando · ${details.join(' · ')}` : 'Baixando...';
    saveBatch();
  });
  if (!response.ok) {
    if (/not found|nao encontrado|Specified native messaging host/i.test(response.error || '')) {
      remuxHostAvailable = false;
    }
    return { ok: false, error: response.error || 'o conversor não conseguiu baixar o vídeo' };
  }

  remuxHostAvailable = true;
  item.progressPercent = 100;
  item.downloadEtaSeconds = 0;
  let output = response.output;
  if (item.isBonus && output) {
    const folderName = String(item.path || '').split('/').filter(Boolean).pop();
    const organized = await sendNative({
      action: 'place-in-folder',
      file: output,
      folderName
    });
    if (organized.ok && organized.output) output = organized.output;
  }
  return {
    ok: true,
    status: 'done',
    filename: String(output).split(/[\\/]/).pop(),
    savedPath: output,
    container: 'mp4',
    downloadId: null,
    downloadIds: [],
    remuxed: true,
    native: true,
    quality: response.quality || null,
    progressPercent: 100,
    exists: true
  };
}

async function closeOffscreenIfIdle() {
  if (job && job.status === 'running') return;
  try {
    if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
  } catch {
    /* ja fechado */
  }
}

/* ------------------------------------------------------------------ *
 * Curso: varredura da navegacao
 * ------------------------------------------------------------------ */

async function scanCourse(tabId) {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      files: ['scan-course.js']
    });
    const result = injection && injection.result;

    // SPAs da Eduzz e Hotmart podem navegar por botoes, sem href no DOM
    // isolado. Nesse caso le somente os dados React que a pagina ja recebeu
    // (MAIN world). A comparacao tambem evita aceitar apenas o primeiro modulo
    // visivel.
    let dataResult = null;
    const isEduzzTrail = result && /^\/trilhas\/[^/]+\/aulas\//i.test(result.prefix || '');
    const isHotmartContent =
      result &&
      /\/club\/[^/]+\/products\/[^/]+\/content\//i.test(
        (result.currentUrl || '') + (result.prefix || '')
      );
    if (!result || !result.ok || isEduzzTrail || isHotmartContent) {
      const [dataInjection] = await chrome.scripting.executeScript({
        target: { tabId },
        files: ['scan-page-data.js'],
        world: 'MAIN'
      });
      dataResult = dataInjection && dataInjection.result;
    }
    if (dataResult?.ok && result?.ok) {
      // Os dois scanners veem partes diferentes na Turing Academy: o DOM
      // comum encontra as aulas e os dados React encontram "Extras da trilha".
      // Escolher apenas a lista maior descartava exatamente os quatro bônus.
      const modules = result.modules.map((module) => ({
        ...module,
        lessons: module.lessons.map((lesson) => ({ ...lesson }))
      }));
      const modulesByTitle = new Map(
        modules.map((module) => [String(module.title || '').trim().toLocaleLowerCase('pt-BR'), module])
      );
      const lessonsByUrl = new Map(
        modules.flatMap((module) => module.lessons.map((lesson) => [lesson.url, lesson]))
      );

      for (const dataModule of dataResult.modules) {
        const moduleKey = String(dataModule.title || '').trim().toLocaleLowerCase('pt-BR');
        let target = modulesByTitle.get(moduleKey);
        for (const dataLesson of dataModule.lessons) {
          const existing = lessonsByUrl.get(dataLesson.url);
          if (existing) {
            if (dataLesson.identifiers) existing.identifiers = dataLesson.identifiers;
            if (dataLesson.kind) existing.kind = dataLesson.kind;
            continue;
          }
          if (!target) {
            target = { title: dataModule.title || 'Itens', lessons: [] };
            modules.push(target);
            modulesByTitle.set(moduleKey, target);
          }
          const added = { ...dataLesson };
          target.lessons.push(added);
          lessonsByUrl.set(added.url, added);
        }
      }
      return {
        ok: true,
        course: {
          ...result,
          modules,
          lessonCount: modules.reduce((sum, module) => sum + module.lessons.length, 0),
          source: `${result.source || 'pagina'} + dados da pagina`
        }
      };
    }
    if (dataResult?.ok) return { ok: true, course: dataResult };
    if (result && result.ok) return { ok: true, course: result };

    return {
      ok: false,
      error:
        (dataResult && dataResult.reason) ||
        (result && result.reason) ||
        'nao foi possivel ler a navegacao desta pagina'
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/* ------------------------------------------------------------------ *
 * Cache do scan, por curso
 *
 * A varredura e cara (abre a pagina do curso e cada modulo). Guardar o
 * resultado evita repeti-la a cada abertura do popup. A logica do scanner nao
 * muda - muda so quando ele e acionado.
 * ------------------------------------------------------------------ */

const COURSE_KEY = 'courses';
const COURSE_SCAN_SCHEMA = 2;

async function getCourseCache() {
  try {
    const data = await chrome.storage.local.get(COURSE_KEY);
    return data[COURSE_KEY] || {};
  } catch {
    return {};
  }
}

/**
 * O scan salvo cobre a aba atual? Vale quando a URL da aba cai dentro do
 * prefixo do curso escaneado. Prefixo "/" e amplo demais para identificar um
 * curso, entao nunca e reaproveitado.
 */
function cacheCovers(entry, tabUrl) {
  if (!entry || !entry.prefix || entry.prefix === '/') return false;
  if (!entry.lessonCount) return false;
  if (entry.scanSchema !== COURSE_SCAN_SCHEMA) return false;
  try {
    const url = new URL(tabUrl);
    return entry.origin === url.origin &&
      url.pathname.toLowerCase().startsWith(entry.prefix.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Devolve o curso da aba: reaproveita o scan salvo quando ele cobre a aba e
 * tem aulas; caso contrario (sem scan, scan vazio, outro curso, ou `force`)
 * roda a varredura e guarda o resultado.
 */
async function courseScan(tabId, { force = false } = {}) {
  let tabUrl = '';
  try {
    tabUrl = (await chrome.tabs.get(tabId)).url || '';
  } catch {
    /* aba fechada */
  }

  if (!force && tabUrl) {
    const cache = await getCourseCache();
    const hit = Object.values(cache).find((entry) => cacheCovers(entry, tabUrl));
    if (hit) {
      const completed = await reconcileCourseDownloads(hit);
      return { ok: true, course: hit, completed, cached: true };
    }
  }

  const result = await scanCourse(tabId);
  if (!result.ok) return result;

  let origin = '';
  try {
    origin = new URL(result.course.currentUrl || tabUrl).origin;
  } catch {
    /* sem origem utilizavel */
  }

  const entry = {
    ...result.course,
    origin,
    scannedAt: Date.now(),
    scanSchema: COURSE_SCAN_SCHEMA
  };

  if (origin && entry.prefix && entry.prefix !== '/' && entry.lessonCount) {
    const cache = await getCourseCache();
    cache[origin + entry.prefix] = entry;
    await chrome.storage.local.set({ [COURSE_KEY]: cache }).catch(() => {});
  }

  const completed = await reconcileCourseDownloads(entry);
  return { ok: true, course: entry, completed, cached: false };
}

/* ------------------------------------------------------------------ *
 * Registro do que ja foi baixado
 * ------------------------------------------------------------------ */

const DONE_KEY = 'completed';

async function getCompleted() {
  try {
    const data = await chrome.storage.local.get(DONE_KEY);
    return data[DONE_KEY] || {};
  } catch {
    return {};
  }
}

async function markCompleted(lessonUrl, info) {
  const all = await getCompleted();
  const downloadIds = Array.isArray(info.downloadIds)
    ? info.downloadIds.filter((id) => Number.isInteger(id))
    : (Number.isInteger(info.downloadId) ? [info.downloadId] : []);
  all[lessonUrl] = {
    filename: info.filename || null,
    path: info.savedPath || null,
    downloadId: downloadIds[0] || null,
    downloadIds,
    container: info.container || null,
    remuxed: Boolean(info.remuxed),
    validatedBonus: Boolean(info.validatedBonus),
    at: Date.now()
  };
  await chrome.storage.local.set({ [DONE_KEY]: all }).catch(() => {});
}

/** O arquivo daquele registro ainda esta no disco? Na duvida, responde nao. */
async function arquivoAindaExiste(registro) {
  const ids = Array.isArray(registro?.downloadIds) && registro.downloadIds.length
    ? registro.downloadIds
    : (registro?.downloadId ? [registro.downloadId] : []);
  if (!ids.length) {
    return Boolean(registro?.path) && await nativeFileExists(registro.path);
  }
  try {
    const found = await Promise.all(ids.map(async (id) => {
      const [item] = await chrome.downloads.search({ id });
      return Boolean(item) && item.exists !== false;
    }));
    if (found.every(Boolean)) return true;
    return ids.length === 1 && /\.mp4$/i.test(registro?.path || '') &&
      await nativeFileExists(registro.path);
  } catch {
    return false;
  }
}

/**
 * "Ja baixada" so vale se o arquivo ainda existir. Confere cada registro com o
 * Chrome e descarta os que sumiram (apagados, movidos, quarentena), para que a
 * aula volte a ser oferecida em vez de ser pulada para sempre.
 *
 * Registros sem downloadId vem de versoes antigas e nao sao verificaveis:
 * saem tambem, porque baixar de novo e melhor que pular em silencio.
 */
async function verifyCompleted() {
  const all = await getCompleted();
  const entradas = Object.entries(all);
  if (!entradas.length) return all;

  let mudou = false;
  for (const [url, entry] of entradas) {
    const ids = Array.isArray(entry?.downloadIds) && entry.downloadIds.length
      ? entry.downloadIds
      : (entry?.downloadId ? [entry.downloadId] : []);
    if (!ids.length && entry?.path && await nativeFileExists(entry.path)) continue;
    if (!ids.length) {
      delete all[url];
      mudou = true;
      continue;
    }
    try {
      const items = await Promise.all(ids.map(async (id) => {
        const [item] = await chrome.downloads.search({ id });
        return item || null;
      }));
      const item = items[0];
      const missing = items.some((download) => !download || download.exists === false);
      const remuxedExists = missing && ids.length === 1 && /\.mp4$/i.test(entry?.path || '') &&
        await nativeFileExists(entry.path);
      if (missing && !remuxedExists) {
        delete all[url];
        mudou = true;
      } else if (!missing && item.filename && item.filename !== entry.path) {
        entry.path = item.filename; // o usuario pode ter movido o arquivo
        mudou = true;
      }
    } catch {
      /* mantem o registro se nao der para conferir */
    }
  }

  if (mudou) await chrome.storage.local.set({ [DONE_KEY]: all }).catch(() => {});
  return all;
}

/**
 * Reconstrói o registro por Curso/Módulo/Item usando o histórico do Chrome.
 * Isso recupera downloads feitos antes de o mapa `completed` existir e também
 * associa um .ts removido ao .mp4 criado pelo host de conversão.
 */
async function reconcileCourseDownloads(course) {
  const all = await getCompleted();
  let downloads = [];
  try {
    downloads = await chrome.downloads.search({
      state: 'complete',
      limit: 10000,
      orderBy: ['-startTime']
    });
  } catch {
    return all;
  }

  const history = downloads
    .filter((download) => download && download.filename)
    .map((download) => ({ download, path: normalizeDownloadPath(download.filename) }));
  const matches = [];

  course.modules.forEach((module, moduleIndex) => {
    module.lessons.forEach((lesson, lessonIndex) => {
      const base = lessonPath(course.courseTitle, {
        moduleTitle: module.title,
        moduleIndex: moduleIndex + 1,
        title: lesson.title,
        lessonIndex: lessonIndex + 1
      });
      const candidates = history.filter(({ path }) =>
        downloadMatchesLesson(path, base, { videoOnly: lesson.kind === 'video' }) &&
        downloadMatchesKind(path, lesson.kind)
      );
      const preferred = candidates.find(({ path }) =>
        lesson.kind === 'file'
          ? /\.(?:docx?|pdf|xlsx?|pptx?|zip|rar|7z)$/i.test(path)
          : lesson.kind === 'text'
            ? /\.(?:txt|md)$/i.test(path)
            : /\/conteudo(?: \(\d+\))?\.md$/i.test(path)
      ) || candidates[0];
      matches.push({ lesson, preferred, base });
    });
  });

  // O historico do Chrome pode ser apagado sem remover os arquivos. Quando
  // isso acontece, usa o host local ja instalado para conferir diretamente os
  // caminhos esperados dentro de Downloads.
  const missingFromHistory = matches.filter(({ preferred }) => !preferred);
  if (missingFromHistory.length && remuxHostAvailable !== false) {
    const response = await sendNative({
      action: 'find-course-files',
      items: missingFromHistory.map(({ lesson, base }) => ({
        key: lesson.url,
        bases: lessonDownloadBases(base),
        kind: lesson.kind || null
      }))
    });
    if (response.ok) {
      remuxHostAvailable = true;
      for (const match of missingFromHistory) {
        const filename = response.matches?.[match.lesson.url];
        if (!filename) continue;
        match.preferred = {
          path: normalizeDownloadPath(filename),
          download: { id: null, filename, exists: true, state: 'complete', native: true }
        };
      }
    } else if (/not found|nao encontrado|Specified native messaging host/i.test(response.error || '')) {
      remuxHostAvailable = false;
    }
  }

  const missingTs = [...new Set(matches
    .map(({ preferred }) => preferred?.download)
    .filter((download) => download?.exists === false && /\.ts$/i.test(download.filename || ''))
    .map((download) => download.filename))];
  let remuxedBySource = {};
  if (missingTs.length && remuxHostAvailable !== false) {
    const response = await sendNative({ action: 'find-remuxed-many', files: missingTs });
    if (response.ok) {
      remuxHostAvailable = true;
      remuxedBySource = response.matches || {};
    } else if (/not found|nao encontrado|Specified native messaging host/i.test(response.error || '')) {
      remuxHostAvailable = false;
    }
  }

  let changed = false;
  for (const { lesson, preferred } of matches) {
    const download = preferred?.download;
    const remuxedPath = download ? remuxedBySource[download.filename] : null;
    const valid = Boolean(download && (download.exists !== false || remuxedPath));
    if (!valid) {
      const existing = all[lesson.url];
      const existingPath = existing?.path || existing?.filename || '';
      if (existing && (
        !downloadMatchesKind(existingPath, lesson.kind) ||
        !(await arquivoAindaExiste(existing))
      )) {
        delete all[lesson.url];
        changed = true;
      }
      continue;
    }

    const savedPath = remuxedPath || download.filename;
    const previous = all[lesson.url];
    if (!previous || previous.downloadId !== download.id || previous.path !== savedPath) changed = true;
    all[lesson.url] = {
      filename: String(savedPath).split(/[\\/]/).pop(),
      path: savedPath,
      downloadId: Number.isInteger(download.id) ? download.id : null,
      downloadIds: Number.isInteger(download.id) ? [download.id] : [],
      container: /\.mp4$/i.test(savedPath) ? 'mp4' : (/\.ts$/i.test(savedPath) ? 'ts' : null),
      remuxed: Boolean(remuxedPath),
      validatedBonus: Boolean(lesson.isBonus),
      at: previous?.at || Date.now()
    };
  }

  if (changed) await chrome.storage.local.set({ [DONE_KEY]: all }).catch(() => {});
  return all;
}

/* ------------------------------------------------------------------ *
 * Fila de download (uma aula por vez)
 * ------------------------------------------------------------------ */

const BATCH_KEY = 'batch';
const WATCHDOG = 'batch-watchdog';
const STREAM_TIMEOUT_MS = 20000;
const PAGE_TIMEOUT_MS = 30000;

/** @type {object | null} */
let batch = null;
/** Evita duas execucoes simultaneas da fila. */
let pumping = false;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A Hotmart alterna o segmento /content/ para /CONTENT/ em alguns produtos.
 * Compara a estrutura da rota sem diferenciar caixa, preservando a caixa do
 * ultimo segmento porque o hash da aula pode ser case-sensitive.
 */
function sameLessonUrl(left, right) {
  try {
    const a = new URL(left);
    const b = new URL(right);
    if (a.origin !== b.origin) return false;
    const aParts = a.pathname.split('/').filter(Boolean);
    const bParts = b.pathname.split('/').filter(Boolean);
    if (aParts.length !== bParts.length) return false;
    return aParts.every((part, index) =>
      index === aParts.length - 1
        ? part === bParts[index]
        : part.toLowerCase() === bParts[index].toLowerCase()
    );
  } catch {
    return false;
  }
}

function saveBatch() {
  chrome.storage.session.set({ [BATCH_KEY]: batch }).catch(() => {});
}

async function loadBatch() {
  if (batch) return batch;
  try {
    const data = await chrome.storage.session.get(BATCH_KEY);
    batch = data[BATCH_KEY] || null;
  } catch {
    batch = null;
  }
  return batch;
}

/** Monta Raiz/Curso/Modulo/Aula, numerando so o que ainda nao comeca com numero. */
function lessonPath(courseTitle, item) {
  const pad = (n) => String(n).padStart(2, '0');
  const numbered = (index, title) =>
    /^\d/.test(String(title).trim()) ? title : `${pad(index)} - ${title}`;

  return [
    'Course Downloader RNUNES',
    sanitizeFilename(courseTitle, 'Curso'),
    // A posição pode mudar conforme o módulo aberto quando a Hotmart monta a
    // navegação. O título do módulo é a parte estável do caminho.
    sanitizeFilename(item.moduleTitle, `Modulo ${pad(item.moduleIndex)}`),
    sanitizeFilename(numbered(item.lessonIndex, item.title), `Aula ${pad(item.lessonIndex)}`)
  ].join('/');
}

/** Aguarda um download comum (texto, anexo ou ZIP), sem usar o worker de vídeo. */
async function waitForChromeDownload(downloadId, timeoutMs = 10 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [download] = await chrome.downloads.search({ id: downloadId });
    if (!download) return { ok: false, error: 'o download desapareceu da lista do Chrome' };
    if (download.state === 'complete') {
      return download.exists === false
        ? { ok: false, error: 'o arquivo foi removido depois do download' }
        : { ok: true, download };
    }
    if (download.state === 'interrupted') {
      return { ok: false, error: download.error || 'download interrompido' };
    }
    if (batchCanceled()) return { ok: false, canceled: true, error: 'fila cancelada' };
    await delay(350);
  }
  return { ok: false, error: 'tempo limite ao salvar o recurso' };
}

async function saveChromeResource(url, filename) {
  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename,
      conflictAction: 'uniquify',
      saveAs: false
    });
    const result = await waitForChromeDownload(downloadId);
    return { ...result, downloadId };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * Extrai apenas o conteúdo que a página já exibiu ao usuário. Além do texto,
 * registra links, anexos e repositórios GitHub. React props são consultadas no
 * MAIN world para alcançar botões de arquivo que não usam <a href>.
 */
async function capturePageResources(tabId, expectedTitle) {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [expectedTitle],
      func: (wantedTitle) => {
        const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const normalized = (value) => clean(value).toLocaleLowerCase('pt-BR');
        const wanted = normalized(wantedTitle);
        const visible = (el) => {
          if (!el || !el.isConnected) return false;
          const style = getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden';
        };

        const titleCandidates = [];
        for (const el of document.querySelectorAll('body *')) {
          const text = normalized(el.innerText || el.textContent);
          if (!visible(el) || !text || el.closest('aside, nav, header')) continue;
          if (text === wanted) {
            const childRepeats = [...el.children].some((child) =>
              normalized(child.innerText || child.textContent) === text
            );
            if (childRepeats) continue;
            titleCandidates.push(el);
          }
        }
        titleCandidates.sort((left, right) =>
          right.getBoundingClientRect().left - left.getBoundingClientRect().left
        );
        const titleElement = titleCandidates.find((el) =>
          el.getBoundingClientRect().left > innerWidth * 0.2
        ) || null;

        const semanticSelector = [
          'article', '[role="main"]', 'main',
          '[class*="lesson-content" i]', '[class*="content-body" i]',
          '[class*="lesson-body" i]', '[class*="article-body" i]'
        ].join(',');
        let localContainer = null;
        for (let node = titleElement?.parentElement; node && node !== document.body; node = node.parentElement) {
          const length = clean(node.innerText || node.textContent).length;
          const hasResource = Boolean(node.querySelector(
            'a[href], [download], [data-download-url], [data-file-url], iframe[src], embed[src], object[data]'
          )) || [...node.querySelectorAll('button, [role="button"]')].some((button) =>
            /baixar|download|anexo|arquivo|modelo/i.test(button.innerText || button.textContent)
          );
          if ((hasResource || length >= wanted.length + 100) && length <= 20000) {
            localContainer = node;
            break;
          }
          if (length > 20000) break;
        }
        const scope = localContainer || titleElement?.closest(semanticSelector) ||
          [...document.querySelectorAll(semanticSelector)].find(visible) || document.body;

        const clone = scope.cloneNode(true);
        for (const el of clone.querySelectorAll(
          'script, style, noscript, nav, aside, header, footer, iframe, video, audio, canvas, svg, form, [aria-hidden="true"]'
        )) el.remove();
        const blockTags = new Set([
          'ADDRESS', 'ARTICLE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIGCAPTION',
          'FIGURE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'MAIN', 'P', 'PRE',
          'SECTION', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL', 'OL'
        ]);
        const textParts = [];
        const walkText = (node) => {
          if (node.nodeType === Node.TEXT_NODE) {
            textParts.push(node.nodeValue || '');
            return;
          }
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          if (node.tagName === 'BR') textParts.push('\n');
          const block = blockTags.has(node.tagName);
          if (block) textParts.push('\n');
          for (const child of node.childNodes) walkText(child);
          if (block) textParts.push('\n');
        };
        walkText(clone);
        let text = textParts.join('')
          .replace(/[ \t]+/g, ' ')
          .replace(/\r/g, '')
          .replace(/[ \t]+\n/g, '\n')
          .replace(/\n[ \t]+/g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        if (text.length > 500000) text = text.slice(0, 500000) + '\n\n[conteúdo truncado]';

        const links = new Map();
        const attachments = new Map();
        const repositories = new Map();
        const fileExt = /\.(?:pdf|docx?|xlsx?|pptx?|csv|tsv|zip|rar|7z|txt|md|rtf|odt|ods|odp|epub)(?:$|[?#])/i;
        const addUrl = (raw, label = '', forceAttachment = false) => {
          if (typeof raw !== 'string' || !raw.trim()) return;
          let url;
          try { url = new URL(raw, location.href); } catch { return; }
          if (!/^https?:$/.test(url.protocol)) return;
          const href = url.href;
          const safeLabel = clean(label) || href;

          if (/^(?:www\.)?github\.com$/i.test(url.hostname)) {
            const parts = url.pathname.split('/').filter(Boolean);
            if (parts.length === 2 && !/^(?:settings|marketplace|features|topics|collections)$/i.test(parts[0])) {
              const repoName = decodeURIComponent(parts[1].replace(/\.git$/i, ''));
              const canonical = `https://github.com/${parts[0]}/${repoName}`;
              repositories.set(canonical, {
                url: canonical,
                name: `${decodeURIComponent(parts[0])} - ${repoName}`,
                archiveUrl: `${canonical}/archive/HEAD.zip`
              });
            }
          }

          links.set(href, { url: href, label: safeLabel });
          const looksDownload = forceAttachment || fileExt.test(href) ||
            /(?:baixar|download|attachment|arquivo|anexo|modelo|template)/i.test(url.pathname + ' ' + safeLabel);
          if (!looksDownload || /github\.com$/i.test(url.hostname)) return;
          const fromPath = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '');
          attachments.set(href, { url: href, name: clean(label) || fromPath || 'Anexo' });
        };

        for (const el of scope.querySelectorAll(
          'a[href], [download], [data-download-url], [data-file-url], [data-href], [data-url], iframe[src], embed[src], object[data]'
        )) {
          const label = clean(el.innerText || el.textContent || el.getAttribute('aria-label') || el.title);
          const raw = el.getAttribute('href') || el.getAttribute('data-download-url') ||
            el.getAttribute('data-file-url') || el.getAttribute('data-href') || el.getAttribute('data-url') ||
            el.getAttribute('src') || el.getAttribute('data');
          addUrl(raw, el.getAttribute('download') || label, el.hasAttribute('download'));
        }
        for (const match of text.matchAll(/https?:\/\/[^\s<>()\[\]"']+/gi)) {
          addUrl(match[0].replace(/[.,;:!?]+$/, ''), match[0]);
        }

        // URLs escondidas nas props dos botões React (caso comum em ARQUIVO).
        const seen = new WeakSet();
        const queue = [];
        for (const el of scope.querySelectorAll('button, [role="button"], a, [class*="download" i], [class*="anexo" i]')) {
          let propertyNames = [];
          try { propertyNames = Object.getOwnPropertyNames(el); } catch { /* nó protegido */ }
          for (const key of propertyNames) {
            if (key.startsWith('__reactProps$')) queue.push({ value: el[key], depth: 0 });
          }
        }
        let visited = 0;
        while (queue.length && visited < 3000) {
          const { value, depth } = queue.shift();
          if (!value || typeof value !== 'object' || seen.has(value) || depth > 5) continue;
          seen.add(value);
          visited++;
          let entries = [];
          try { entries = Object.entries(value); } catch { continue; }
          for (const [key, child] of entries) {
            if (typeof child === 'string') {
              if (/url|href|download|file|arquivo|anexo/i.test(key) || /^https?:\/\//i.test(child)) {
                addUrl(child, key, /download|file|arquivo|anexo/i.test(key));
              }
            } else if (child && typeof child === 'object' &&
                       !/^(_owner|return|stateNode|child|sibling|alternate)$/i.test(key)) {
              queue.push({ value: child, depth: depth + 1 });
            }
          }
        }

        return {
          title: clean(wantedTitle) || clean(document.title),
          matchedTitle: Boolean(titleElement),
          sourceUrl: location.href,
          text,
          links: [...links.values()].slice(0, 300),
          attachments: [...attachments.values()].slice(0, 30),
          repositories: [...repositories.values()].slice(0, 20)
        };
      }
    });
    return injection?.result || null;
  } catch (error) {
    return { error: error.message, text: '', links: [], attachments: [], repositories: [] };
  }
}

function buildResourceText(capture) {
  const title = String(capture.title || '').replace(/\s+/g, ' ').trim();
  const normalizedTitle = title.toLocaleLowerCase('pt-BR');
  const contentLines = String(capture.text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => {
      const normalized = line.toLocaleLowerCase('pt-BR');
      return line &&
        normalized !== normalizedTitle &&
        normalized !== 'bônus selecionado' &&
        normalized !== 'bonus selecionado' &&
        !/^(?:texto|arquivo|vídeo|video|fechar)$/i.test(line) &&
        !/^b[oô]nus\s+\d+$/i.test(line);
    });
  const lines = [contentLines.join('\r\n')];
  const missingLinks = (capture.links || []).filter((link) =>
    link.url && !String(capture.text || '').includes(link.url)
  );
  if (missingLinks.length) {
    lines.push('', 'LINKS');
    for (const link of missingLinks) lines.push(`${link.label}\n${link.url}`);
  }
  return lines.join('\r\n').trim() + '\r\n';
}

function resourceFilename(rawName, fallback, sourceUrl = '') {
  let name = String(rawName || '').trim();
  let sourceExt = '';
  try {
    const url = new URL(sourceUrl);
    const hinted = url.searchParams.get('filename') || url.searchParams.get('file') ||
      url.searchParams.get('name') || '';
    sourceExt = decodeURIComponent(hinted || url.pathname).match(/\.[a-z0-9]{1,8}$/i)?.[0] || '';
  } catch {
    /* URL sem nome de arquivo */
  }
  if (!/\.[a-z0-9]{1,8}$/i.test(name) && sourceExt) name += sourceExt;
  return sanitizeFilename(name, fallback);
}

async function probeResourceExtension(url) {
  try {
    const response = await fetch(url, { method: 'HEAD', credentials: 'include', cache: 'no-store' });
    if (!response.ok) return '';
    const disposition = response.headers.get('content-disposition') || '';
    const encoded = disposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
    const plain = disposition.match(/filename\s*=\s*"?([^";]+)"?/i)?.[1];
    const filename = decodeURIComponent(encoded || plain || '').trim();
    const byName = filename.match(/\.[a-z0-9]{1,8}$/i)?.[0];
    if (byName) return byName;
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (/application\/pdf/.test(contentType)) return '.pdf';
    if (/wordprocessingml/.test(contentType)) return '.docx';
    if (/msword/.test(contentType)) return '.doc';
    if (/spreadsheetml/.test(contentType)) return '.xlsx';
    if (/presentationml/.test(contentType)) return '.pptx';
    if (/text\/plain/.test(contentType)) return '.txt';
    return '';
  } catch {
    return '';
  }
}

async function saveCapturedResources(item, capture) {
  if (!capture || capture.error) {
    return { ok: false, error: capture?.error || 'não foi possível ler o conteúdo da página' };
  }
  if (item.isBonus && !capture.matchedTitle) {
    return { ok: false, error: `a página aberta não corresponde ao bônus "${item.title}"` };
  }
  const hasUsefulContent = capture.text || capture.links.length ||
    capture.attachments.length || capture.repositories.length;
  if (!hasUsefulContent) return { ok: false, error: 'a página não exibiu texto, links ou anexos' };
  if (item.kind === 'file' && !capture.attachments.length) {
    return { ok: false, error: 'o bônus é um arquivo, mas o link do anexo não foi encontrado' };
  }

  const results = [];
  const usedNames = new Set();
  const uniqueName = (raw, fallback, url) => {
    const original = resourceFilename(raw, fallback, url);
    let name = original;
    let copy = 2;
    while (usedNames.has(name.toLowerCase())) {
      const match = original.match(/^(.*?)(\.[^.]+)?$/);
      name = `${match[1]} (${copy++})${match[2] || ''}`;
    }
    usedNames.add(name.toLowerCase());
    return name;
  };

  for (const [index, attachment] of capture.attachments.entries()) {
    if (batchCanceled()) break;
    item.phase = `Salvando anexo ${index + 1} de ${capture.attachments.length}…`;
    saveBatch();
    let requestedName = item.kind === 'file' && capture.attachments.length === 1
      ? item.title
      : attachment.name;
    if (item.kind === 'file' && !/\.[a-z0-9]{1,8}$/i.test(
      resourceFilename(requestedName, '', attachment.url)
    )) {
      requestedName += await probeResourceExtension(attachment.url);
    }
    const name = uniqueName(requestedName, `Anexo ${index + 1}`, attachment.url);
    results.push({
      type: 'attachment',
      label: name,
      result: await saveChromeResource(attachment.url, `${item.path}/${name}`)
    });
  }

  if (item.kind === 'file') {
    const savedAttachment = results.find((entry) =>
      entry.type === 'attachment' && entry.result.ok
    );
    const failedAttachment = results.find((entry) =>
      entry.type === 'attachment' && !entry.result.ok
    );
    if (!savedAttachment) {
      return {
        ok: false,
        error: 'o anexo do contrato falhou: ' + (failedAttachment?.result.error || 'erro desconhecido')
      };
    }
    return {
      ok: true,
      downloadId: savedAttachment.result.downloadId,
      downloadIds: results.filter((entry) => entry.result.ok).map((entry) => entry.result.downloadId),
      filename: savedAttachment.label,
      savedPath: savedAttachment.result.download?.filename || `${item.path}/${savedAttachment.label}`,
      warnings: results.filter((entry) => !entry.result.ok).map((entry) => entry.result.error)
    };
  }

  if (batchCanceled()) return { ok: false, canceled: true, error: 'fila cancelada' };
  item.phase = 'Salvando o conteúdo…';
  saveBatch();
  const contentText = buildResourceText(capture);
  const contentUrl = `data:text/plain;charset=utf-8,${encodeURIComponent(contentText)}`;
  const indexName = `${sanitizeFilename(item.title, 'Conteudo')}.txt`;
  const indexResult = await saveChromeResource(contentUrl, `${item.path}/${indexName}`);
  results.unshift({ type: 'index', label: indexName, result: indexResult });

  const saved = results.filter((entry) => entry.result.ok);
  const failed = results.filter((entry) => !entry.result.ok && !entry.result.canceled);
  if (!indexResult.ok) return { ok: false, error: `não foi possível salvar ${indexName}: ${indexResult.error}` };
  if (item.kind === 'file' && !saved.some((entry) => entry.type === 'attachment')) {
    return { ok: false, error: 'o índice foi salvo, mas o anexo falhou: ' + failed.map((entry) => entry.result.error).join(' · ') };
  }
  return {
    ok: true,
    downloadId: indexResult.downloadId,
    downloadIds: saved.map((entry) => entry.result.downloadId),
    filename: indexName,
    savedPath: indexResult.download?.filename || `${item.path}/${indexName}`,
    warnings: failed.map((entry) => `${entry.label}: ${entry.result.error}`)
  };
}

/**
 * Navega como o proprio menu do curso. Nessa area de membros o player e
 * criado corretamente pela rota interna do React; recarregar a URL inteira
 * pode reconstruir apenas a pagina textual e nunca inicializar o video.
 */
async function navigateToLesson(tabId, lessonUrl, lessonTitle, { byTitleOnly = false } = {}) {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [lessonUrl, lessonTitle, byTitleOnly, COMPLETION_CONTROL_PATTERN],
      func: async (targetUrl, targetTitle, titleOnly, completionControlPattern) => {
        const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const completionControlRe = new RegExp(completionControlPattern, 'i');
        const target = new URL(targetUrl, location.href);
        const samePath = (left, right) => {
          const a = left.pathname.split('/').filter(Boolean);
          const b = right.pathname.split('/').filter(Boolean);
          if (left.origin !== right.origin || a.length !== b.length) return false;
          return a.every((part, index) =>
            index === a.length - 1
              ? part === b[index]
              : part.toLowerCase() === b[index].toLowerCase()
          );
        };
        if (!titleOnly && samePath(new URL(location.href), target)) {
          return { ok: true, method: 'current' };
        }
        if (titleOnly) {
          const wanted = clean(targetTitle);
          const alreadyOpen = [...document.querySelectorAll('body *')].some((el) => {
            if (clean(el.innerText || el.textContent) !== wanted) return false;
            const childRepeats = [...el.children].some((child) =>
              clean(child.innerText || child.textContent) === wanted
            );
            if (childRepeats) return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && rect.left > innerWidth * 0.2;
          });
          if (alreadyOpen) return { ok: true, method: 'current-bonus' };
        }

        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const urlAttrs = ['href', 'data-href', 'data-url', 'data-link', 'data-to', 'data-path'];
        const sameTarget = (raw) => {
          if (!raw) return false;
          try {
            const url = new URL(raw, location.href);
            return samePath(url, target);
          } catch {
            return false;
          }
        };
        const isCompletionControl = (el) => {
          if (!el) return false;
          if (el.matches?.('input[type="checkbox"], [role="checkbox"], [aria-checked]')) return true;
          const explicit = [
            el.getAttribute?.('aria-label'),
            el.getAttribute?.('title'),
            el.getAttribute?.('name'),
            el.getAttribute?.('data-testid'),
            el.getAttribute?.('data-action')
          ].filter(Boolean).join(' ');
          if (completionControlRe.test(explicit)) return true;

          const className = typeof el.className === 'string' ? el.className : '';
          if (/(?:checkbox|check[-_ ]?circle|circle[-_ ]?check|completion[-_ ]?(?:toggle|check))/i.test(className)) {
            return true;
          }

          // Usa o texto apenas em controles pequenos. Um card de navegacao
          // pode conter um selo "concluida", mas o botao de check costuma ter
          // somente esse rotulo.
          const text = clean(el.innerText || el.textContent);
          return text.length <= 60 && completionControlRe.test(text);
        };
        const clickable = (el, exactUrl = false) => {
          if (!el) return null;
          const semantic = el.closest('a, button, [role="button"], [role="link"]');
          // Um link com a URL exata da aula e evidencia mais forte que classes
          // visuais como "completed" aplicadas ao card inteiro.
          if (semantic && exactUrl && semantic.matches('a[href]') && sameTarget(semantic.href)) {
            return semantic;
          }
          if (semantic && !isCompletionControl(semantic)) return semantic;

          // Alguns menus React usam <div> clicavel sem role/onclick no HTML.
          const start = semantic?.parentElement || el;
          for (let node = start; node && node !== document.documentElement; node = node.parentElement) {
            if (isCompletionControl(node)) continue;
            let names = [];
            try { names = Object.getOwnPropertyNames(node); } catch { continue; }
            for (const name of names) {
              if (!name.startsWith('__reactProps$')) continue;
              try {
                if (typeof node[name]?.onClick === 'function') return node;
              } catch {
                /* props inacessiveis */
              }
            }
          }
          return null;
        };
        const menuScopes = [...document.querySelectorAll(
          'aside, nav, [class*="sidebar" i], [class*="side-bar" i], [class*="course-menu" i], [class*="lesson-menu" i]'
        )];
        const scope = menuScopes.find((el) =>
          /navegue\s+pelas\s+aulas/i.test(el.innerText || el.textContent)
        ) || menuScopes[0] || document;
        const findTarget = () => {
          if (!titleOnly) {
            for (const el of document.querySelectorAll(
              'a[href], [data-href], [data-url], [data-link], [data-to], [data-path]'
            )) {
              if (urlAttrs.some((attr) => sameTarget(el.getAttribute(attr)))) {
                const targetControl = clickable(el, true);
                if (targetControl) return targetControl;
              }
            }
          }

          // Quando a URL existe apenas no estado do React, localiza o texto
          // folha da aula e sobe ate o botao/link real. Nao procura o UUID nas
          // props do contêiner: ele contem o curso inteiro e causava clique no
          // elemento errado, embora a rotina informasse sucesso.
          const wanted = clean(targetTitle);
          if (wanted) {
            for (const el of scope.querySelectorAll('*')) {
              if (el.children.length && !el.matches('a, button, [role="button"]')) continue;
              const text = clean(el.innerText || el.textContent);
              if (text !== wanted && !text.startsWith(`${wanted} `)) continue;
              const targetControl = clickable(el);
              if (targetControl) return targetControl;
            }
          }
          return null;
        };

        let link = findTarget();
        if (link) {
          link.click();
          return { ok: true, method: 'menu' };
        }

        // Aulas de modulos fechados podem nem existir no DOM. Abre cada
        // acordeao e procura novamente antes de passar ao proximo.
        const controls = [...scope.querySelectorAll(
          '[aria-expanded="false"], button[data-state="closed"], [role="button"][data-state="closed"]'
        )].filter((control) => !isCompletionControl(control));
        for (const control of controls.slice(0, 100)) {
          try { control.click(); } catch { continue; }
          await wait(60);
          link = findTarget();
          if (link) {
            link.click();
            return { ok: true, method: 'menu-expanded' };
          }
        }
        return { ok: false, method: 'not-found' };
      }
    });
    return (injection && injection.result) || { ok: false, method: 'no-result' };
  } catch (error) {
    return { ok: false, method: 'script-error', error: error.message };
  }
}

async function waitForTabLoad(tabId, expectedUrl, timeoutMs = PAGE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  await delay(250); // deixa a navegacao comecar antes de ler o status
  const expected = (() => {
    try { return new URL(expectedUrl); } catch { return null; }
  })();
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      let correctPage = true;
      if (expected) {
        const current = new URL(tab.url || 'about:blank');
        correctPage = sameLessonUrl(current.href, expected.href);
      }
      if (correctPage && tab.status === 'complete') {
        // `complete` antecede a hidratacao do React e a criacao do iframe.
        await delay(900);
        return true;
      }
    } catch {
      return false; // aba fechada
    }
    await delay(250);
  }
  return false;
}

/** Confirma que o conteúdo central aberto corresponde ao card de bônus clicado. */
async function waitForOpenedTitle(tabId, expectedTitle, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  await delay(300);
  while (Date.now() < deadline) {
    try {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId },
        args: [expectedTitle],
        func: (title) => {
          const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('pt-BR');
          const wanted = clean(title);
          const candidates = [];
          for (const el of document.querySelectorAll('body *')) {
            if (el.closest('aside, nav, header')) continue;
            if (clean(el.innerText || el.textContent) !== wanted) continue;
            const childRepeats = [...el.children].some((child) =>
              clean(child.innerText || child.textContent) === wanted
            );
            if (!childRepeats) candidates.push(el);
          }
          return candidates.some((el) => el.getBoundingClientRect().left > innerWidth * 0.2);
        }
      });
      if (injection?.result) {
        const tab = await chrome.tabs.get(tabId);
        return { ok: true, url: tab.url || '' };
      }
    } catch {
      /* página ainda navegando */
    }
    await delay(300);
  }
  return { ok: false, url: '' };
}

/** Identifica no item da navegacao quando a propria Hotmart adia a liberacao. */
async function detectLessonLock(tabId, lessonTitle) {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [lessonTitle],
      func: (targetTitle) => {
        const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const wanted = clean(targetTitle);
        if (!wanted) return null;
        const lockRe =
          /(libera[cç][aã]o|liberad[oa]|dispon[ií]vel|available|unlocks?)\s*(?:em|in|daqui a)?\s*\d+\s*(dias?|days?|horas?|hours?)/i;
        const nodes = document.querySelectorAll(
          'a, button, [role=button], li, [class*=lesson i], [class*=aula i], [class*=content i]'
        );
        for (const el of nodes) {
          const text = clean(el.innerText || el.textContent);
          if (!text.includes(wanted)) continue;
          for (let node = el, level = 0; node && level < 4; node = node.parentElement, level++) {
            const nearby = String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
            const match = nearby.match(lockRe);
            if (match) return match[0];
          }
        }
        return null;
      }
    });
    return (injection && injection.result) || null;
  } catch {
    return null;
  }
}

/** Reconhece apenas o estado vazio declarado pela propria plataforma. */
async function detectEmptyLesson(tabId) {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [EMPTY_LESSON_PATTERN.source, EMPTY_LESSON_PATTERN.flags],
      func: (pattern, flags) => {
        const emptyRe = new RegExp(pattern, flags);
        const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const visible = (el) => {
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' &&
            Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
        };
        for (const el of document.querySelectorAll('h1, h2, h3, h4, p, [role="status"], [class*="empty" i]')) {
          const text = clean(el.innerText || el.textContent);
          if (emptyRe.test(text) && visible(el)) return text;
        }
        return null;
      }
    });
    return injection?.result || null;
  } catch {
    return null;
  }
}

/**
 * Alguns players so pedem a playlist quando o video comeca. Isso apenas aciona
 * play() no elemento de video ja presente na pagina - nao contorna login,
 * paywall nem protecao.
 */
async function nudgePlay(tabId, { deep = false } = {}) {
  try {
    const frames = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      args: [deep, COMPLETION_CONTROL_PATTERN],
      func: async (deepScan, completionControlPattern) => {
        const completionControlRe = new RegExp(completionControlPattern, 'i');
        const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const isCompletionControl = (candidate) => {
          if (!candidate) return false;
          if (candidate.matches?.('input[type="checkbox"], [role="checkbox"], [aria-checked]')) return true;
          const evidence = [
            candidate.getAttribute?.('aria-label'),
            candidate.getAttribute?.('title'),
            candidate.getAttribute?.('name'),
            candidate.getAttribute?.('data-testid'),
            candidate.getAttribute?.('data-action'),
            clean(candidate.innerText || candidate.textContent).slice(0, 80)
          ].filter(Boolean).join(' ');
          return completionControlRe.test(evidence);
        };
        const urls = new Set();
        const hinted = [];
        const embedUrls = new Set();
        let videoCount = 0;
        let videoStarted = false;
        let needsGesture = false;
        let playClickTarget = '';
        const videos = [];
        const roots = [document];
        for (let index = 0; index < roots.length; index++) {
          for (const el of roots[index].querySelectorAll('*')) {
            if (el.shadowRoot) roots.push(el.shadowRoot);
          }
        }
        const queryAll = (selector) => roots.flatMap((root) => [...root.querySelectorAll(selector)]);

        // O player do YouTube usa faixas adaptativas separadas. Solicitar o
        // maior nivel faz o proprio player revelar as URLs de video e audio
        // correspondentes, que depois serao unidas pelo host nativo.
        if (/(?:^|\.)youtube\.com$/i.test(location.hostname)) {
          try {
            const youtubePlayer = document.querySelector('#movie_player');
            const levels = youtubePlayer?.getAvailableQualityLevels?.() || [];
            const bestLevel = levels[0];
            if (bestLevel) {
              youtubePlayer.setPlaybackQualityRange?.(bestLevel, bestLevel);
              youtubePlayer.setPlaybackQuality?.(bestLevel);
            }
          } catch {
            /* API interna do player indisponivel; a captura de rede continua */
          }
        }

        for (const iframe of queryAll('iframe')) {
          try {
            const lazySrc = iframe.getAttribute('data-src') ||
              iframe.getAttribute('data-lazy-src') ||
              iframe.getAttribute('data-url') ||
              iframe.getAttribute('data-embed-url');
            const declaredSrc = iframe.getAttribute('src') || '';
            if ((!declaredSrc || /^about:blank$/i.test(declaredSrc)) && lazySrc) iframe.src = lazySrc;
            for (const raw of [iframe.getAttribute('src'), lazySrc]) {
              if (!raw) continue;
              const resolved = new URL(raw, location.href);
              if (/^https?:$/.test(resolved.protocol)) embedUrls.add(resolved.href);
            }
            for (const attribute of iframe.attributes || []) {
              const raw = String(attribute.value || '').trim();
              if (!raw || !/(?:src|url|embed|player)/i.test(attribute.name)) continue;
              const resolved = new URL(raw, location.href);
              if (/^https?:$/.test(resolved.protocol)) embedUrls.add(resolved.href);
            }
            iframe.scrollIntoView({ block: 'center', inline: 'nearest' });
          } catch {
            /* iframe protegido */
          }
        }

        for (const video of queryAll('video')) {
          try {
            videoCount++;
            videos.push(video);
            if (video.currentSrc) urls.add(video.currentSrc);
            if (video.src) urls.add(video.src);
            for (const source of video.querySelectorAll('source[src]')) urls.add(source.src);
            video.muted = true;
            video.autoplay = true;
            if (!video.currentSrc && (video.src || video.querySelector('source[src]'))) video.load();
            const played = video.play();
            if (played && typeof played.then === 'function') {
              const outcome = await Promise.race([
                played.then(() => 'played', () => 'rejected'),
                new Promise((resolve) => setTimeout(() => resolve('pending'), 800))
              ]);
              if (outcome !== 'played' && video.paused) needsGesture = true;
            }
            // Alguns players antigos retornam undefined em play(); outros
            // resolvem a Promise antes de atualizar o estado. O estado real do
            // elemento decide se ainda precisamos acionar o controle visual.
            if (video.paused) needsGesture = true;
            else videoStarted = true;
          } catch {
            needsGesture = true;
          }
        }

        // Players que so criam o <video> depois do primeiro gesto.
        if (!videoCount || (!videoStarted && needsGesture)) {
          const paused = videos.find((video) => video.paused) || videos[0];
          let play = null;
          const inChildFrame = window !== window.top;
          const knownPlayerFrame = /(?:^|\.)(?:(?:play|pay|player)\.hotmart\.com|pandavideo\.com\.br|fathom\.video)$/i.test(
            location.hostname
          );

          // Primeiro tenta exatamente o elemento desenhado sobre o centro do
          // video. Isso nunca usa a pagina do curso como alvo aproximado.
          if (paused) {
            const rect = paused.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            const root = paused.getRootNode();
            const centered = typeof root.elementFromPoint === 'function'
              ? root.elementFromPoint(x, y)
              : document.elementFromPoint(x, y);
            if (centered && !isCompletionControl(centered)) {
              const centeredControl = typeof centered.closest === 'function'
                ? centered.closest('button, [role="button"], [class*="play" i]') || centered
                : centered;
              if (!isCompletionControl(centeredControl)) play = centeredControl;
            }
          }

          const playCandidates = queryAll([
            '.vjs-big-play-button', '.plyr__control--overlaid', '.ytp-large-play-button',
            '.jw-display-icon-container', '.jw-icon-playback',
            '[class*="play-button" i]', '[data-testid*="play" i]',
            'button[aria-label*="play" i]', 'button[title*="play" i]',
            'button[aria-label*="reprodu" i]'
          ].join(','));
          if (!play) {
            play = playCandidates.find((candidate) => {
              if (isCompletionControl(candidate)) return false;
              const rect = candidate.getBoundingClientRect();
              if (!rect.width || !rect.height) return false;
              return (inChildFrame && knownPlayerFrame) || Boolean(candidate.closest(
                '[class*="player" i], [class*="video" i], [data-player], video'
              ));
            });
          }
          if (!play && inChildFrame && /(?:^|\.)fathom\.video$/i.test(location.hostname)) {
            // O player de gravações do Fathom usa apenas um botão circular com
            // SVG, sem classe/aria-label contendo "play".
            const centerX = innerWidth / 2;
            const centerY = innerHeight / 2;
            play = queryAll('button, [role="button"]')
              .filter((candidate) => {
                if (isCompletionControl(candidate)) return false;
                const rect = candidate.getBoundingClientRect();
                const text = String(candidate.innerText || candidate.textContent || '').trim();
                const compact = rect.width >= 28 && rect.height >= 28 &&
                  rect.width <= 180 && rect.height <= 180;
                const central = inChildFrame || rect.left > innerWidth * 0.2;
                return compact && central && text.length <= 20 &&
                  (candidate.querySelector('svg') || /[▶►]|play|reprodu|assist/i.test(text));
              })
              .sort((left, right) => {
                const a = left.getBoundingClientRect();
                const b = right.getBoundingClientRect();
                const da = Math.hypot(a.left + a.width / 2 - centerX, a.top + a.height / 2 - centerY);
                const db = Math.hypot(b.left + b.width / 2 - centerX, b.top + b.height / 2 - centerY);
                return da - db;
              })[0] || null;
          }
          if (play) {
            try {
              playClickTarget = `${play.tagName || 'element'}${play.className ? '.' + String(play.className).split(/\s+/).slice(0, 2).join('.') : ''}`.slice(0, 120);
              play.scrollIntoView({ block: 'center', inline: 'center' });
              // Um unico click no controle comprovado evita disparar handlers
              // vizinhos de conclusao/progresso.
              play.click();
            } catch {
              /* controle protegido */
            }
          }
        }

        try {
          for (const entry of performance.getEntriesByType('resource')) {
            if (/\.m3u8(?![a-z0-9])|\.mp4(?![a-z0-9])|\.mpd(?![a-z0-9])|\.(?:webm|mkv|mov)(?![a-z0-9])|[?&/=](?:m3u8|mpd)(?![a-z0-9])|https?:\/\/[^/]*googlevideo\.com\/videoplayback/i.test(entry.name)) {
              urls.add(entry.name);
            }
          }
        } catch {
          /* Performance API indisponivel */
        }

        // Antes do play, varias bibliotecas guardam a playlist apenas nas
        // props React/JSON do player. Isso e essencial para a fila automatica,
        // que nao recebe um clique humano em cada aula.
        if (deepScan) {
          const dataRoots = [];
          if (window.__NEXT_DATA__ && typeof window.__NEXT_DATA__ === 'object') dataRoots.push(window.__NEXT_DATA__);
          for (const script of document.querySelectorAll('script[type="application/json"]')) {
            try { dataRoots.push(JSON.parse(script.textContent)); } catch { /* nao era JSON completo */ }
          }

          // Next/React tambem serializa dados em scripts JavaScript comuns.
          // Extrai apenas URLs de midia, sem executar ou armazenar o restante.
          for (const script of document.scripts) {
            const text = (script.textContent || '').replace(/\\u0026/gi, '&').replace(/\\\//g, '/');
            const matches = text.match(/https?:[^\s"'<>\\]+/gi) || [];
            for (const raw of matches.slice(0, 200)) {
              const url = raw.replace(/[),;\]}]+$/, '');
              try {
                const host = new URL(url).hostname;
                if (/(?:^|\.)(?:youtube(?:-nocookie)?\.com|player\.vimeo\.com|fast\.wistia\.(?:net|com)|loom\.com|vidyard\.com|iframe\.mediadelivery\.net|pandavideo\.com\.br|fathom\.video|(?:play|pay|player)\.hotmart\.com)$/i.test(host)) {
                  embedUrls.add(url);
                }
              } catch { /* URL incompleta */ }
              if (/\.m3u8(?![a-z0-9])|[?&/=]m3u8(?![a-z0-9])/i.test(url)) {
                hinted.push({ url, format: 'hls' });
              } else if (/\.mpd(?![a-z0-9])|[?&/=]mpd(?![a-z0-9])/i.test(url)) {
                hinted.push({ url, format: 'dash' });
              } else if (/\.(?:mp4|webm|mkv|mov)(?![a-z0-9])|[?&]format=(?:mp4|webm|mkv|mov)/i.test(url)) {
                hinted.push({ url, format: 'file' });
              }
            }
          }
          for (const el of document.querySelectorAll('*')) {
            let names = [];
            try { names = Object.getOwnPropertyNames(el); } catch { continue; }
            for (const name of names) {
              if (name.startsWith('__reactProps$')) dataRoots.push(el[name]);
              if (!name.startsWith('__reactFiber$')) continue;
              let fiber = el[name];
              for (let level = 0; fiber && level < 8; level++, fiber = fiber.return) {
                if (fiber.memoizedProps) dataRoots.push(fiber.memoizedProps);
              }
            }
          }

          const seen = new WeakSet();
          const queue = dataRoots.map((value) => ({ value, context: '' }));
          let cursor = 0;
          let visited = 0;
          while (cursor < queue.length && visited < 18000 && hinted.length < 40) {
            const { value, context } = queue[cursor++];
            if (!value || typeof value !== 'object' || seen.has(value)) continue;
            if (typeof Node === 'function' && value instanceof Node) continue;
            seen.add(value);
            visited++;
            let entries = [];
            try { entries = Object.entries(value); } catch { continue; }
            for (const [key, child] of entries) {
              const nextContext = `${context}.${key}`.slice(-160);
              if (typeof child === 'string') {
                const raw = child.replace(/\\u0026/gi, '&').replace(/\\\//g, '/');
                if (/^https?:/i.test(raw)) {
                  if (/(?:iframe|embed|player).*(?:url|src)|(?:url|src).*(?:iframe|embed|player)/i.test(nextContext)) {
                    embedUrls.add(raw);
                  }
                  if (/\.m3u8(?![a-z0-9])|[?&/=]m3u8(?![a-z0-9])/i.test(raw)) {
                    hinted.push({ url: raw, format: 'hls' });
                  } else if (/\.mpd(?![a-z0-9])|[?&/=]mpd(?![a-z0-9])/i.test(raw)) {
                    hinted.push({ url: raw, format: 'dash' });
                  } else if (/\.(?:mp4|webm|mkv|mov)(?![a-z0-9])|[?&]format=(?:mp4|webm|mkv|mov)/i.test(raw)) {
                    hinted.push({ url: raw, format: 'file' });
                  } else if (/(?:download|recording|video|media|playback|asset).*(?:url|src)/i.test(key)) {
                    // Fathom costuma guardar a URL assinada sem extensao em
                    // propriedades como recordingUrl ou download_url.
                    hinted.push({ url: raw, format: 'file' });
                  } else if (/(hls|m3u8|manifest|playlist)/i.test(nextContext)) {
                    hinted.push({ url: raw, format: 'hls' });
                  }
                }
              } else if (child && typeof child === 'object' &&
                         !/^(_owner|return|stateNode|child|sibling|alternate)$/i.test(key)) {
                queue.push({ value: child, context: nextContext });
              }
            }
          }
        }
        const iframeUrls = [...embedUrls];
        const iframeHosts = iframeUrls.map((src) => {
          try { return new URL(src).hostname; } catch { return 'iframe'; }
        });
        return {
          documentUrl: location.href,
          urls: [...urls].slice(-30),
          hinted,
          videoCount,
          videoPausedCount: videos.filter((video) => video.paused).length,
          videoBlobCount: videos.filter((video) => /^(?:blob|mediastream):/i.test(video.currentSrc || video.src || '')).length,
          playClickTarget,
          iframeCount: iframeHosts.length,
          iframeUrls: iframeUrls.slice(0, 20),
          iframeHosts: [...new Set(iframeHosts)].slice(0, 5),
          shadowRoots: Math.max(0, roots.length - 1)
        };
      }
    });

    const diagnostics = [];
    for (const frame of frames) {
      if (frame.result) diagnostics.push(frame.result);
      for (const url of (frame.result && frame.result.urls) || []) {
        if (M3U8_RE.test(url) || MP4_RE.test(url) || MPD_RE.test(url) ||
            WEBM_RE.test(url) || isGoogleVideoUrl(url)) {
          await addStream(tabId, url, 'player', null, {
            documentUrl: frame.result.documentUrl,
            contentType: googleVideoKind(url) ? `${googleVideoKind(url)}/mp4` : null
          });
        }
      }
      for (const source of (frame.result && frame.result.hinted) || []) {
        try {
          const url = new URL(source.url, frame.result.documentUrl || undefined).href;
          await addStream(tabId, url, 'player-config', source.format, {
            documentUrl: frame.result.documentUrl
          });
        } catch {
          /* URL de configuracao invalida */
        }
      }
    }
    return diagnostics;
  } catch {
    /* pagina sem permissao de injecao */
    return [];
  }
}

/**
 * Recria somente o iframe de video. O novo documento recebe lesson-debug.js
 * em document_start e revela a requisicao que originalmente criou o blob.
 */
async function restartEmbeddedPlayer(tabId) {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const playerHost = /(?:^|\.)(?:(?:play|pay|player)\.hotmart\.com|pandavideo\.com\.br|fathom\.video)$/i;
        const frames = [...document.querySelectorAll('iframe[src]')].filter((iframe) => {
          try { return playerHost.test(new URL(iframe.src, location.href).hostname); }
          catch { return false; }
        });
        for (const iframe of frames) {
          const replacement = iframe.cloneNode(true);
          replacement.setAttribute('data-course-downloader-restarted', 'true');
          iframe.replaceWith(replacement);
        }
        return frames.length;
      }
    });
    const count = Number(injection?.result || 0);
    if (count) await delay(1200);
    return count;
  } catch {
    return 0;
  }
}

/**
 * Escolhe entre as playlists detectadas na aula. O nome do arquivo nao serve
 * como criterio (muitas mestras se chamam main.m3u8, que nao parece "master"),
 * entao a decisao vem da leitura da playlist: vale a que declara variantes.
 * Reaproveita o cache de probeMaster.
 */
async function pickStream(list, frames = []) {
  const { pandaIds } = activeMediaBindings(frames);
  let candidates = list.filter((stream) => !isRejectedMediaUrl(stream.url));

  // Havendo um embed Panda na aula atual, somente sua propria identidade de
  // playback pode ser escolhida. Assets do player e fallbacks ficam de fora.
  if (pandaIds.size) {
    candidates = candidates.filter((stream) => {
      const mediaId = stream.mediaId || pandaMediaId(stream.url);
      return Boolean(mediaId && pandaIds.has(mediaId));
    });
  }

  candidates.sort((left, right) => {
    const score = (stream) =>
      (stream.boundToEmbed ? 100 : 0) +
      (stream.type === 'player' ? 30 : 0) +
      (/^media-resolver/.test(stream.type || '') ? 20 : 0);
    return score(right) - score(left) || (left.detectedAt || 0) - (right.detectedAt || 0);
  });

  const youtubePair = selectGoogleVideoPair(candidates);
  // Videos adaptativos do YouTube nao contem audio. A politica retorna null
  // ate a segunda faixa aparecer, evitando salvar silenciosamente um MP4 mudo.
  if (youtubePair) return youtubePair;

  const hls = candidates.filter((stream) => stream.format === 'hls');
  let validSingle = null;
  let headerVerified = null;
  for (const stream of hls) {
    const confirmedHls = stream.verifiedByHeaders && /mpegurl/i.test(stream.contentType || '');
    if (confirmedHls && /(?:^|\.)portal\.turingacademy\.com\.br$/i.test(hostOf(stream.url))) {
      return stream;
    }
    if (confirmedHls && !headerVerified) headerVerified = stream;
    const probed = await probeMaster(stream.url);
    if (!playlistMatchesMediaIdentity(stream, probed)) continue;
    if (probed && !probed.error && probed.variants.length) return stream;
    if (probed && !probed.error && probed.single && !validSingle) validSingle = stream;
  }
  if (validSingle) return validSingle;
  // Se o proprio Chrome recebeu Content-Type de playlist enquanto a aula
  // estava tocando, a URL e real. Uma segunda leitura pelo service worker pode
  // falhar por SameSite/referrer, mas isso nao deve apagar a deteccao valida.
  if (headerVerified) return headerVerified;
  const dash = candidates.find((stream) => stream.format === 'dash');
  if (dash) return dash;
  for (const stream of candidates.filter((candidate) => candidate.format === 'file')) {
    const probed = await probeDirectMedia(stream.url);
    if (probed.valid) {
      return { ...stream, url: probed.finalUrl, contentType: probed.contentType };
    }
  }
  return null;
}

/** Espera a aba revelar uma playlist, dando tempo para as variantes chegarem. */
async function waitForStream(tabId, timeoutMs = STREAM_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let firstSeenAt = null;
  let lastNudge = 0;
  let lastDeepScan = 0;
  let diagnostics = [];

  while (Date.now() < deadline) {
    if (Date.now() - lastNudge >= 1000) {
      lastNudge = Date.now();
      const deep = Date.now() - lastDeepScan >= 5000;
      if (deep) lastDeepScan = Date.now();
      const latestDiagnostics = await nudgePlay(tabId, { deep });
      if (latestDiagnostics.length) diagnostics = latestDiagnostics;
    }
    await ensureLoaded();
    const list = tabStreams.get(tabId) || [];

    if (list.length) {
      if (!firstSeenAt) firstSeenAt = Date.now();
      if (Date.now() - firstSeenAt > 1200) {
        const stream = await pickStream(list, diagnostics);
        if (stream) return { stream, diagnostics };
      }
    }

    await delay(300);
  }

  return { stream: null, diagnostics };
}

async function waitForJob(jobId, timeoutMs = 45 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (job && job.id === jobId && job.status !== 'running') return job;
    await delay(400);
  }
  return { status: 'error', error: 'tempo limite do download excedido' };
}

function lessonIdFromUrl(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
  } catch {
    return '';
  }
}

function startLessonDebug(tabId, item) {
  const pageUrl = item.actualUrl || item.url;
  lessonDebugContexts.set(tabId, {
    title: item.title,
    lessonUrl: pageUrl,
    lessonId: lessonIdFromUrl(pageUrl),
    network: [],
    attempts: [],
    videoUrl: null,
    mediaResolver: null
  });
}

function noteLessonDebug(tabId, message) {
  const context = lessonDebugContexts.get(tabId);
  if (context) context.attempts.push(message);
}

async function prepareLessonPageDebug(tabId, item, { reset = false } = {}) {
  const pageUrl = item.actualUrl || item.url;
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['lesson-debug.js'],
      world: 'MAIN'
    });
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      args: [
        LESSON_DEBUG_STORE_KEY,
        {
          title: item.title,
          url: pageUrl,
          lessonId: lessonIdFromUrl(pageUrl),
          identifiers: item.identifiers || null
        },
        reset
      ],
      func: (storeKey, lesson, shouldReset) => {
        const state = window[storeKey];
        if (!state) return;
        if (shouldReset) state.records.length = 0;
        state.lesson = lesson;
      }
    });
  } catch {
    /* instrumentacao nunca interfere no fluxo */
  }
}

async function collectLessonPageDebug(tabId) {
  try {
    const frames = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      args: [LESSON_DEBUG_STORE_KEY],
      func: (storeKey) => {
        const state = window[storeKey];
        if (!state) return null;
        return {
          documentUrl: location.href,
          lesson: state.lesson,
          records: state.records.slice(-120),
          snapshots: state.snapshot()
        };
      }
    });
    return frames
      .filter((frame) => frame.result)
      .map((frame) => ({ ...frame.result, frameId: frame.frameId }));
  } catch {
    return [];
  }
}

const debugScalar = (value) =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? value
    : null;

function debugRelatedValue(related, pattern) {
  for (const entry of related) {
    if (!pattern.test(entry.path || '')) continue;
    const value = debugScalar(entry.value);
    if (value !== null) return value;
  }
  return null;
}

function normalizePlayerIdKey(key) {
  const raw = String(key || '').split('.').pop().replace(/[^a-z0-9]/gi, '').toLowerCase();
  for (const entity of ['lesson', 'content', 'video', 'media', 'asset', 'playback']) {
    if (raw === entity || raw === `${entity}id`) return `${entity}id`;
  }
  return raw === 'id' ? 'id' : '';
}

function mergePlayerIdentifiers(target, source) {
  let added = 0;
  for (const [rawKey, value] of Object.entries(source || {})) {
    const key = normalizePlayerIdKey(rawKey);
    if (!key || key === 'id' || value === '' || value == null) continue;
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    if (!Object.prototype.hasOwnProperty.call(target, key) || target[key] !== value) added++;
    target[key] = value;
  }
  return added;
}

function identifierValueKeys(identifiers) {
  const values = new Map();
  for (const [key, value] of Object.entries(identifiers || {})) {
    if (value === '' || value == null) continue;
    const scalar = String(value);
    if (values.has(scalar) && values.get(scalar) !== key) values.set(scalar, null);
    else if (!values.has(scalar)) values.set(scalar, key);
  }
  return values;
}

function playerSemanticHint(value) {
  const text = String(value || '');
  for (const entity of ['playback', 'video', 'media', 'asset', 'content', 'lesson']) {
    if (new RegExp(entity, 'i').test(text)) return `${entity}id`;
  }
  return null;
}

function playerParameterNames(value, path = '', names = []) {
  if (!value || typeof value !== 'object' || names.length >= 120) return names;
  for (const [key, child] of Object.entries(value)) {
    const nextPath = path ? `${path}.${key}` : key;
    names.push(nextPath);
    if (child && typeof child === 'object') playerParameterNames(child, nextPath, names);
    if (names.length >= 120) break;
  }
  return names;
}

function playerBodyStructure(value, key = '') {
  if (typeof value === 'string') {
    if (/^__MEDIA_RESOLVER_ID:[^_]+__$/.test(value)) return value;
    if (/^(query|document)$/i.test(key)) return value.replace(/\s+/g, ' ').trim();
    return 'string';
  }
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (value == null) return 'null';
  if (Array.isArray(value)) return value.map((child) => playerBodyStructure(child, key));
  return Object.fromEntries(
    Object.entries(value).map(([childKey, child]) => [childKey, playerBodyStructure(child, childKey)])
  );
}

function safeDebugUrl(value) {
  try {
    const url = new URL(String(value));
    for (const key of [...url.searchParams.keys()]) {
      if (DEBUG_SECRET_RE.test(key)) url.searchParams.set(key, '[REDACTED]');
    }
    return url.href.replace(
      /__MEDIA_RESOLVER_ID%3A([^_]+)__/gi,
      '__MEDIA_RESOLVER_ID:$1__'
    );
  } catch {
    return String(value || '').replace(
      /((?:authorization|token|secret|password|signature|api[-_]?key)\s*[=:]\s*)[^&\s,}\]]+/gi,
      '$1[REDACTED]'
    );
  }
}

function playerOperationName(record) {
  if (record.requestBody?.operationName) return record.requestBody.operationName;
  try {
    return new URL(record.url).searchParams.get('operationName') || null;
  } catch {
    return null;
  }
}

function playerTemplateSignature(template) {
  return JSON.stringify({
    method: template.method,
    endpoint: template.endpoint,
    operationName: template.operationName,
    urlParameters: template.urlParameterNames,
    body: template.body ? playerBodyStructure(template.body.value) : null
  });
}

function templatePlayerValue(value, key, valueKeys, required, semanticHint = null) {
  const normalizedKey = normalizePlayerIdKey(key);
  if (typeof value === 'string') {
    const known = valueKeys.has(value);
    const knownKey = valueKeys.get(value);
    const semanticKey = normalizedKey && normalizedKey !== 'id'
      ? normalizedKey
      : knownKey || (known ? semanticHint : null);
    if (semanticKey) {
      required.add(semanticKey);
      return `__MEDIA_RESOLVER_ID:${semanticKey}__`;
    }
    return value;
  }
  if (typeof value === 'number') {
    const scalar = String(value);
    const known = valueKeys.has(scalar);
    const knownKey = valueKeys.get(scalar);
    const semanticKey = normalizedKey && normalizedKey !== 'id'
      ? normalizedKey
      : knownKey || (known ? semanticHint : null);
    if (semanticKey) {
      required.add(semanticKey);
      return `__MEDIA_RESOLVER_ID:${semanticKey}__`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((child) => templatePlayerValue(child, key, valueKeys, required, semanticHint));
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([childKey, child]) => [
      childKey,
      templatePlayerValue(child, childKey, valueKeys, required, semanticHint)
    ])
  );
}

function templatePlayerUrl(rawUrl, frameUrl, valueKeys, required, semanticHint) {
  try {
    const url = new URL(String(rawUrl || ''), frameUrl || undefined);
    url.pathname = url.pathname.split('/').map((part) => {
      let decoded = part;
      try { decoded = decodeURIComponent(part); } catch { /* segmento invalido */ }
      const known = valueKeys.has(decoded);
      const semanticKey = valueKeys.get(decoded) || (known ? semanticHint : null);
      if (!semanticKey) return part;
      required.add(semanticKey);
      return `__MEDIA_RESOLVER_ID:${semanticKey}__`;
    }).join('/');
    for (const [key, rawValue] of [...url.searchParams.entries()]) {
      if (DEBUG_SECRET_RE.test(key)) return null;
      const normalizedKey = normalizePlayerIdKey(key);
      const known = valueKeys.has(rawValue);
      const knownKey = valueKeys.get(rawValue);
      const semanticKey = normalizedKey && normalizedKey !== 'id'
        ? normalizedKey
        : knownKey || (known ? semanticHint : null);
      if (semanticKey) {
        required.add(semanticKey);
        url.searchParams.set(key, `__MEDIA_RESOLVER_ID:${semanticKey}__`);
        continue;
      }
      if (/^variables$/i.test(key)) {
        try {
          const variables = JSON.parse(rawValue);
          url.searchParams.set(
            key,
            JSON.stringify(templatePlayerValue(variables, '', valueKeys, required, semanticHint))
          );
        } catch {
          /* variables nao estavam em JSON */
        }
      }
    }
    return url.href.replace(
      /__MEDIA_RESOLVER_ID%3A([^_]+)__/gi,
      '__MEDIA_RESOLVER_ID:$1__'
    );
  } catch {
    return null;
  }
}

function playerTemplateFromRecord(record, frame, valueKeys) {
  if (!record || record.transport === 'media-resolver') return null;
  const status = Number(record.status);
  if (!Number.isFinite(status) || status < 200 || status >= 400) return null;
  const operationName = playerOperationName(record);
  const semanticHint = playerSemanticHint(`${operationName || ''} ${record.url || ''}`);
  const relatedPaths = (record.related || []).map((entry) => entry.path || '').join(' ');
  if (!PLAYER_FLOW_RE.test(`${record.url || ''} ${operationName || ''} ${relatedPaths}`)) return null;

  const required = new Set();
  const url = templatePlayerUrl(record.url, frame.documentUrl, valueKeys, required, semanticHint);
  if (!url) return null;
  const body = record.requestBody?.value !== undefined
    ? {
        format: record.requestBody.format,
        keys: record.requestBody.keys || [],
        operationName,
        value: templatePlayerValue(record.requestBody.value, '', valueKeys, required, semanticHint)
      }
    : null;
  const serialized = JSON.stringify({ url, body });
  if (/\[REDACTED\]|\[BINARY\]/.test(serialized)) return null;
  if (!required.size || !/__MEDIA_RESOLVER_ID:/.test(serialized)) return null;

  let frameOrigin = null;
  try { frameOrigin = new URL(frame.documentUrl).origin; } catch { /* frame sem URL */ }
  let requestOrigin = null;
  try { requestOrigin = new URL(url).origin; } catch { /* endpoint invalido */ }

  // Nunca repete uma chamada autenticada em outro origin. Os gateways da
  // Hotmart usam bearer/OIDC na chamada original; como credenciais nao sao
  // copiadas pelo resolver, repetir a URL pode disparar o prompt HTTP Basic
  // do navegador em um loop.
  if (!frameOrigin || requestOrigin !== frameOrigin) return null;

  let endpoint = url;
  try {
    const parsed = new URL(url);
    endpoint = parsed.origin + parsed.pathname;
  } catch { /* URL relativa */ }
  const urlParameterNames = (() => {
    try { return [...new URL(url).searchParams.keys()].sort(); } catch { return []; }
  })();
  const provides = [];
  for (const key of Object.keys(record.identifiers || {})) {
    const normalized = normalizePlayerIdKey(key);
    if (normalized && normalized !== 'id' && !provides.includes(normalized)) provides.push(normalized);
  }
  const template = {
    method: record.method || 'GET',
    url,
    endpoint,
    operationName,
    urlParameterNames,
    parameterNames: [...new Set([
      ...playerParameterNames(body?.value),
      ...urlParameterNames
    ])],
    body,
    frameOrigin,
    requires: [...required],
    provides,
    producesMedia: Boolean((record.mediaUrls || []).length)
  };
  template.signature = playerTemplateSignature(template);
  return template;
}

function identifiersFromFrames(frames, item) {
  const identifiers = {};
  mergePlayerIdentifiers(identifiers, item?.identifiers);
  mergePlayerIdentifiers(identifiers, { lessonId: lessonIdFromUrl(item?.actualUrl || item?.url) });
  for (const frame of frames) {
    for (const record of frame.records || []) mergePlayerIdentifiers(identifiers, record.identifiers);
    for (const snapshot of frame.snapshots || []) mergePlayerIdentifiers(identifiers, snapshot.identifiers);
  }
  const related = frames.flatMap((frame) => [
    ...(frame.records || []).flatMap((record) => record.related || []),
    ...(frame.snapshots || []).flatMap((snapshot) => snapshot.related || [])
  ]);
  for (const entry of related) {
    const key = String(entry.path || '').split('.').pop();
    if (!PLAYER_ID_KEY_RE.test(key)) continue;
    const value = debugScalar(entry.value);
    const normalized = normalizePlayerIdKey(key);
    if (normalized && normalized !== 'id' && value !== null && value !== '') identifiers[normalized] = value;
  }
  return identifiers;
}

function mediaCandidatesFromFrames(frames) {
  return [...new Set(frames.flatMap((frame) => [
    ...(frame.records || []).flatMap((record) => record.mediaUrls || []),
    ...(frame.snapshots || []).flatMap((snapshot) => snapshot.mediaUrls || [])
  ]))];
}

async function rememberPlayerFlow(tabId, item) {
  const frames = await collectLessonPageDebug(tabId);
  const sourceIdentifiers = identifiersFromFrames(frames, item);
  const valueKeys = identifierValueKeys(sourceIdentifiers);
  const templates = [];
  const seen = new Set();
  const records = frames
    .flatMap((frame) => (frame.records || []).map((record) => ({ record, frame })))
    .sort((left, right) => (left.record.at || 0) - (right.record.at || 0));
  for (const { record, frame } of records) {
    const template = playerTemplateFromRecord(record, frame, valueKeys);
    mergePlayerIdentifiers(sourceIdentifiers, record.identifiers);
    const refreshedValueKeys = identifierValueKeys(sourceIdentifiers);
    valueKeys.clear();
    for (const [value, key] of refreshedValueKeys) valueKeys.set(value, key);
    if (!template || seen.has(template.signature)) continue;
    seen.add(template.signature);
    templates.push(template);
    if (templates.length >= 24) break;
  }
  if (!templates.length) return;
  let origin = null;
  try { origin = new URL(item.actualUrl || item.url).origin; } catch { /* URL invalida */ }
  observedPlayerFlow = {
    version: 4,
    origin,
    learnedAt: Date.now(),
    templates
  };
  await chrome.storage.session.set({ [MEDIA_RESOLVER_TEMPLATE_KEY]: observedPlayerFlow }).catch(() => {});
  noteLessonDebug(tabId, `cadeia do MEDIA RESOLVER aprendida: ${templates.length} operacao(oes)`);
}

async function loadObservedPlayerFlow(item) {
  let origin = null;
  try { origin = new URL(item.actualUrl || item.url).origin; } catch { return null; }
  if (!observedPlayerFlow) {
    const data = await chrome.storage.session.get(MEDIA_RESOLVER_TEMPLATE_KEY).catch(() => ({}));
    observedPlayerFlow = data[MEDIA_RESOLVER_TEMPLATE_KEY] || null;
  }
  return observedPlayerFlow?.version === 4 && observedPlayerFlow.origin === origin
    ? observedPlayerFlow
    : null;
}

async function addResolvedMediaCandidate(tabId, rawUrl, baseUrl, source) {
  try {
    const url = new URL(rawUrl, baseUrl || undefined).href;
    if (M3U8_RE.test(url) || MP4_RE.test(url) || MPD_RE.test(url) || WEBM_RE.test(url)) {
      const format = M3U8_RE.test(url) ? 'hls' : (MPD_RE.test(url) ? 'dash' : 'file');
      const added = await addStream(tabId, url, source, format, {
        documentUrl: baseUrl || null
      });
      return { playable: Boolean(added), dash: format === 'dash', url };
    }
    if (/^https?:/i.test(url)) {
      const probed = await probeDirectMedia(url);
      if (probed.valid) {
        const added = await addStream(tabId, probed.finalUrl, source, 'file', {
          documentUrl: baseUrl || null
        });
        return { playable: Boolean(added), dash: false, url: probed.finalUrl };
      }
    }
  } catch {
    /* candidato invalido */
  }
  return { playable: false, dash: false, url: null };
}

async function resolveLessonMedia(tabId, item, playerFrames = []) {
  const context = lessonDebugContexts.get(tabId);
  const frames = await collectLessonPageDebug(tabId);
  const flow = await loadObservedPlayerFlow(item);
  const identifiers = identifiersFromFrames(frames, item);
  const bindings = activeMediaBindings([...frames, ...playerFrames]);
  if (bindings.pandaIds.size === 1) {
    mergePlayerIdentifiers(identifiers, { videoId: [...bindings.pandaIds][0] });
  }
  const templates = flow?.templates || [];
  const attempts = [];
  const dashManifests = [];

  console.groupCollapsed('[MEDIA RESOLVER] ' + item.title);
  console.log('[MEDIA RESOLVER]');
  console.log('Aula:', item.title);
  console.log('IDs iniciais:', { ...identifiers });
  console.log('Operacoes estruturais disponiveis:', templates.map((template) => ({
    method: template.method,
    endpoint: safeDebugUrl(template.endpoint),
    operationName: template.operationName,
    requires: template.requires,
    provides: template.provides
  })));

  for (const rawUrl of mediaCandidatesFromFrames(frames)) {
    const candidate = await addResolvedMediaCandidate(
      tabId,
      rawUrl,
      item.actualUrl || item.url,
      'media-resolver-state'
    );
    if (candidate.dash) dashManifests.push(candidate.url);
  }

  const pending = new Set(templates.map((_template, index) => index));
  let pass = 0;
  while (pending.size && pass++ <= templates.length) {
    let executedInPass = false;
    for (const index of [...pending]) {
      const template = templates[index];
      const missing = (template.requires || []).filter((key) =>
        !Object.prototype.hasOwnProperty.call(identifiers, key)
      );
      if (missing.length) continue;
      pending.delete(index);
      executedInPass = true;

      let targetFrame = frames.find((frame) => {
        try { return new URL(frame.documentUrl).origin === template.frameOrigin; } catch { return false; }
      });
      if (!targetFrame) targetFrame = frames.find((frame) => frame.frameId === 0) || frames[0];

      let result = null;
      try {
        const injection = await chrome.scripting.executeScript({
          target: { tabId, frameIds: [targetFrame?.frameId ?? 0] },
          world: 'MAIN',
          args: [LESSON_DEBUG_STORE_KEY, [{ ...template, identifiers: { ...identifiers } }]],
          func: async (storeKey, requests) => {
            const state = window[storeKey];
            if (!state || typeof state.resolveApiOperations !== 'function') return [];
            return state.resolveApiOperations(requests);
          }
        });
        result = injection?.[0]?.result?.[0] || null;
      } catch (error) {
        result = {
          operationName: template.operationName,
          endpoint: template.endpoint,
          status: 'injection-error',
          error: error.message
        };
      }
      if (!result) continue;

      const attempt = {
        ...result,
        requires: template.requires || [],
        provides: template.provides || []
      };
      attempts.push(attempt);
      console.log(`Operacao ${attempts.length}:`, {
        Endpoint: safeDebugUrl(result.endpoint || template.endpoint),
        Operation: template.operationName,
        Requires: template.requires || [],
        Provides: template.provides || [],
        Status: result.status,
        Resultado: result.error || result.responseKeys || []
      });

      if (Number(result.status) === 401 || Number(result.status) === 403) {
        attempt.error = `HTTP ${result.status}: caminho encerrado por autorizacao`;
        continue;
      }

      mergePlayerIdentifiers(identifiers, result.identifiers);
      for (const rawUrl of result.mediaUrls || []) {
        const candidate = await addResolvedMediaCandidate(
          tabId,
          rawUrl,
          template.endpoint || template.frameOrigin,
          'media-resolver-api'
        );
        if (candidate.dash) dashManifests.push(candidate.url);
      }
    }
    if (!executedInPass) break;
  }

  await ensureLoaded();
  const candidates = tabStreams.get(tabId) || [];
  const stream = candidates.length
    ? await pickStream(candidates, [...frames, ...playerFrames])
    : null;
  const unresolved = [...pending].map((index) => {
    const template = templates[index];
    return {
      operationName: template.operationName,
      endpoint: safeDebugUrl(template.endpoint),
      missing: (template.requires || []).filter((key) =>
        !Object.prototype.hasOwnProperty.call(identifiers, key)
      )
    };
  });
  const foundIds = {
    lessonId: identifiers.lessonid || null,
    contentId: identifiers.contentid || null,
    videoId: identifiers.videoid || null,
    playbackId: identifiers.playbackid || null,
    assetId: identifiers.assetid || null,
    mediaId: identifiers.mediaid || null
  };

  console.log('IDs resolvidos:', foundIds);
  console.log('Operacoes pendentes:', unresolved);
  console.log('Manifest DASH detectado:', dashManifests.map(safeDebugUrl));
  console.log('Manifest/arquivo reproduzivel:', stream ? safeDebugUrl(stream.url) : null);
  console.log('RESULTADO:', stream ? 'STREAM ENCONTRADO' : 'NENHUM STREAM OBTIDO');
  console.groupEnd();

  if (context) {
    context.mediaResolver = {
      attempts,
      identifiers: foundIds,
      unresolved,
      dashManifests,
      manifest: stream ? stream.url : null,
      result: stream ? 'STREAM ENCONTRADO' : 'NENHUM STREAM OBTIDO'
    };
  }
  noteLessonDebug(
    tabId,
    templates.length
      ? `MEDIA RESOLVER: ${attempts.length} operacao(oes), ${stream ? 'stream encontrado' : 'nenhum stream'}`
      : `MEDIA RESOLVER: sem cadeia aprendida; ${stream ? 'midia encontrada no payload' : 'nenhuma midia no payload'}`
  );
  return {
    stream,
    diagnostics: [],
    attempts,
    hadObservedFlow: templates.length > 0
  };
}

async function reportLessonDebug(tabId, item) {
  const context = lessonDebugContexts.get(tabId);
  if (!context) return;
  try {
    const [frames, domLock] = await Promise.all([
      collectLessonPageDebug(tabId),
      detectLessonLock(tabId, item.title)
    ]);
    const responseRecords = frames.flatMap((frame) => frame.records || []);
    const snapshots = frames.flatMap((frame) => frame.snapshots || []);
    const related = [
      ...responseRecords.flatMap((record) => record.related || []),
      ...snapshots.flatMap((snapshot) => snapshot.related || [])
    ];
    const responseKeys = [...new Set([
      ...responseRecords.flatMap((record) => record.responseKeys || []),
      ...snapshots.flatMap((snapshot) => snapshot.responseKeys || [])
    ])].slice(0, 150);
    const accessIndicators = related.filter((entry) =>
      /(locked|available|release|access|drip|blocked|denied|forbidden)/i.test(entry.path || '')
    ).slice(0, 40);
    const requests = [
      ...context.network,
      ...responseRecords.map((record) => ({
        transport: record.transport,
        method: record.method,
        url: record.url,
        status: record.status,
        requestBody: record.requestBody || null
      }))
    ].map((request) => ({
      ...request,
      url: safeDebugUrl(request.url),
      requestBody: request.requestBody
        ? {
            format: request.requestBody.format || null,
            keys: request.requestBody.keys || [],
            operationName: request.requestBody.operationName || null
          }
        : null
    }));
    const stateOrigin = domLock
      ? 'HTML/DOM (texto de liberacao junto ao item da aula)'
      : accessIndicators.length
        ? 'Resposta JSON ou estado JavaScript/React'
        : item.status === 'skipped'
          ? 'Detector local waitForStream: nenhuma URL HLS/MP4 encontrada'
          : 'Fluxo local da fila';
    const videoUrl = context.videoUrl ||
      related.find((entry) =>
        typeof entry.value === 'string' &&
        /(?:\.m3u8|\.mp4|[?&/=]m3u8)/i.test(entry.value)
      )?.value || null;

    console.groupCollapsed('[DEBUG LESSON] ' + item.title);
    console.log('[DEBUG LESSON]');
    console.log('Título:', item.title);
    console.log('Lesson ID:', context.lessonId || null);
    console.log('Estado detectado:', domLock ? 'locked (' + domLock + ')' : item.status);
    console.log('Origem do estado:', stateOrigin);
    console.log('Request utilizado:', requests.slice(0, 200));
    console.log('HTTP status:', requests.map(({ method, url, status }) => ({ method, url, status })));
    console.log('Response keys:', responseKeys);
    console.log('Video ID:', debugRelatedValue(related, /video.?id$/i));
    console.log('Playback ID:', debugRelatedValue(related, /playback.?id$/i));
    console.log('Media ID:', debugRelatedValue(related, /media.?id$/i));
    console.log('Asset ID:', debugRelatedValue(related, /asset.?id$/i));
    console.log('Video URL:', videoUrl ? safeDebugUrl(videoUrl) : null);
    console.log('Indicadores de acesso:', accessIndicators);
    console.log('Tentativas antes do resultado:', context.attempts);
    console.log(
      'Motivo de não continuar:',
      item.status === 'done' ? 'fluxo continuou para o downloader' : item.error || item.status
    );
    console.log('Respostas JSON resumidas:', responseRecords.map((record) => ({
      transport: record.transport,
      method: record.method,
      url: safeDebugUrl(record.url),
      status: record.status,
      operationName: record.requestBody?.operationName || null,
      responseKeys: record.responseKeys || [],
      related: (record.related || []).slice(0, 40)
    })));
    console.log('Estado JavaScript/React resumido:', snapshots.slice(0, 30).map((snapshot) => ({
      source: snapshot.source,
      responseKeys: snapshot.responseKeys || [],
      related: snapshot.related || [],
      identifiers: snapshot.identifiers || {},
      mediaUrls: (snapshot.mediaUrls || []).map(safeDebugUrl)
    })));
    console.log('Cadeia estrutural do MEDIA RESOLVER:', (observedPlayerFlow?.templates || []).map((template) => ({
      method: template.method,
      endpoint: safeDebugUrl(template.endpoint),
      operationName: template.operationName,
      parameterNames: template.parameterNames,
      bodyFormat: template.body?.format || null,
      requires: template.requires || [],
      provides: template.provides || []
    })));
    if (context.mediaResolver) {
      console.log('[MEDIA RESOLVER]', {
        Aula: item.title,
        LessonID: context.lessonId || null,
        Tentativas: context.mediaResolver.attempts.map((attempt) => ({
          operationName: attempt.operationName || null,
          endpoint: safeDebugUrl(attempt.endpoint || ''),
          status: attempt.status,
          requires: attempt.requires || [],
          provides: attempt.provides || [],
          responseKeys: attempt.responseKeys || [],
          videoId: attempt.identifiers?.videoId || attempt.identifiers?.video_id || null,
          playbackId: attempt.identifiers?.playbackId || attempt.identifiers?.playback_id || null,
          assetId: attempt.identifiers?.assetId || attempt.identifiers?.asset_id || null,
          mediaId: attempt.identifiers?.mediaId || attempt.identifiers?.media_id || null,
          url: (attempt.mediaUrls || []).map(safeDebugUrl),
          error: attempt.error || null
        })),
        IDs: context.mediaResolver.identifiers,
        Pendentes: context.mediaResolver.unresolved,
        Manifest: context.mediaResolver.manifest ? safeDebugUrl(context.mediaResolver.manifest) : null,
        Resultado: context.mediaResolver.result
      });
    }
    console.groupEnd();
  } catch (error) {
    console.warn('[DEBUG LESSON] falha ao consolidar diagnostico:', error);
  } finally {
    lessonDebugContexts.delete(tabId);
  }
}

/** Pausar so vale entre aulas; cancelar interrompe na hora. */
const batchCanceled = () => !batch || batch.status === 'canceled';

async function runBatchItem(item) {
  item.status = 'active';
  item.phase = 'Abrindo a aula…';
  item.error = null;
  saveBatch();

  // Pular exige DUAS condicoes: constar no registro E o arquivo ainda estar la.
  // Sem a segunda, apagar a pasta faz a fila passar reto por tudo.
  // `force` vem da selecao explicita do usuario e vence as duas.
  if (!item.force) {
    const completed = await getCompleted();
    const registro = completed[item.url];
    if (await arquivoAindaExiste(registro)) {
      item.status = 'exists';
      item.savedPath = registro.path || null;
      item.phase = null;
      return;
    }
  }

  const debugTabId = batch.tabId;
  startLessonDebug(debugTabId, item);
  try {
  await prepareLessonPageDebug(debugTabId, item, { reset: true });
  noteLessonDebug(debugTabId, 'instrumentacao instalada antes da navegacao');

  // Nunca deixa a playlist da aula anterior satisfazer a proxima iteracao.
  await ensureLoaded();
  clearTab(batch.tabId, { keepEntry: true });
  noteLessonDebug(debugTabId, 'URLs de mídia da aula anterior removidas de tabStreams');

  const navigation = await navigateToLesson(
    batch.tabId,
    item.url,
    item.title,
    { byTitleOnly: item.isBonus }
  );
  noteLessonDebug(debugTabId, 'navigateToLesson: ' + navigation.method);
  if (!navigation.ok) {
    if (item.isBonus) {
      item.status = 'error';
      item.error = `não encontrei o card do bônus "${item.title}" para abrir`;
      return;
    }
    try {
      await chrome.tabs.update(batch.tabId, { url: item.url });
      navigation.method = 'recarregamento';
      noteLessonDebug(debugTabId, 'fallback chrome.tabs.update: recarregamento completo');
    } catch (error) {
      item.status = 'error';
      item.error = `nao foi possivel abrir a aba (${error.message})`;
      return;
    }
  }
  item.navigation = navigation.method;

  let loaded;
  if (item.isBonus) {
    const opened = await waitForOpenedTitle(batch.tabId, item.title);
    loaded = opened.ok;
    if (opened.ok) {
      item.actualUrl = opened.url;
      const context = lessonDebugContexts.get(debugTabId);
      if (context) {
        context.lessonUrl = opened.url;
        context.lessonId = lessonIdFromUrl(opened.url);
      }
      saveBatch();
    }
  } else {
    loaded = await waitForTabLoad(batch.tabId, item.url);
  }
  if (!item.isBonus && !loaded && navigation.ok && navigation.method !== 'current') {
    try {
      await chrome.tabs.update(batch.tabId, { url: item.url });
      navigation.method += '+recarregamento';
      item.navigation = navigation.method;
      loaded = await waitForTabLoad(batch.tabId, item.url);
    } catch {
      /* a mensagem detalhada e montada abaixo */
    }
  }
  noteLessonDebug(debugTabId, 'waitForTabLoad: ' + (loaded ? 'URL esperada carregada' : 'falhou/redirect/timeout'));
  await prepareLessonPageDebug(debugTabId, item);
  if (!loaded) {
    const lockReason = await detectLessonLock(batch.tabId, item.title);
    if (lockReason) {
      item.status = 'locked';
      item.error = `aula bloqueada pela Hotmart (${lockReason})`;
      return;
    }
    item.status = 'error';
    try {
      const actual = (await chrome.tabs.get(batch.tabId)).url || '';
      item.error = item.isBonus
        ? `o card foi clicado, mas o conteúdo "${item.title}" não abriu`
        : actual && !sameLessonUrl(actual, item.url)
        ? `a aula redirecionou para outra pagina (${actual})`
        : 'a pagina nao terminou de carregar';
    } catch {
      item.error = 'a pagina nao terminou de carregar';
    }
    return;
  }
  if (batchCanceled()) return;

  const emptyReason = await detectEmptyLesson(batch.tabId);
  if (emptyReason) {
    item.status = 'empty';
    item.emptyReason = emptyReason;
    item.phase = null;
    item.skippedAt = Date.now();
    noteLessonDebug(debugTabId, `aula vazia declarada pela plataforma: ${emptyReason}`);
    return;
  }

  // Bônus de texto/arquivo não devem esperar por um player que a própria
  // plataforma declarou inexistente.
  if (item.kind && item.kind !== 'video') {
    item.phase = 'Lendo texto, links e anexos…';
    saveBatch();
    const capture = await capturePageResources(batch.tabId, item.title);
    const saved = await saveCapturedResources(item, capture);
    if (saved.ok) {
      item.status = 'done';
      item.filename = saved.filename;
      item.savedPath = saved.savedPath;
      item.downloadIds = saved.downloadIds;
      item.error = saved.warnings.length ? saved.warnings.join(' · ') : null;
      await markCompleted(item.url, { ...saved, validatedBonus: item.isBonus });
    } else if (saved.canceled) {
      item.status = 'pending';
    } else {
      item.status = 'error';
      item.error = saved.error;
    }
    return;
  }

  item.phase = 'Procurando o video…';
  saveBatch();
  noteLessonDebug(debugTabId, 'nudgePlay deep: video/src, performance entries, JSON, scripts e React props');
  await nudgePlay(batch.tabId, { deep: true });

  let detection = await waitForStream(batch.tabId, item.isBonus ? 45000 : STREAM_TIMEOUT_MS);
  let stream = detection.stream;
  let streamCameFromResolver = false;
  noteLessonDebug(
    debugTabId,
    stream
      ? 'waitForStream encontrou mídia e selecionou uma URL'
      : 'waitForStream encerrou sem HLS/MP4/DASH; nudge a cada 1s e deep scan a cada 5s'
  );
  if (!stream) {
    const extractorUrl = extractorUrlFromDiagnostics(detection.diagnostics || []);
    if (extractorUrl) {
      stream = {
        url: extractorUrl,
        format: 'extractor',
        extractor: true,
        youtube: /(?:^|\.)youtube(?:-nocookie)?\.com$/i.test(new URL(extractorUrl).hostname),
        documentUrl: extractorUrl
      };
      noteLessonDebug(debugTabId, `pagina do player detectada: ${extractorUrl}`);
    }
  }
  if (!stream && !batchCanceled()) {
    item.phase = 'Reiniciando o player para capturar a URL...';
    saveBatch();
    const restartedFrames = await restartEmbeddedPlayer(batch.tabId);
    if (restartedFrames) {
      noteLessonDebug(debugTabId, `player reiniciado: ${restartedFrames} iframe(s)`);
      await prepareLessonPageDebug(debugTabId, item);
      const retriedDetection = await waitForStream(batch.tabId, 20000);
      detection = {
        stream: retriedDetection.stream,
        diagnostics: [
          ...(detection.diagnostics || []),
          ...(retriedDetection.diagnostics || [])
        ]
      };
      stream = detection.stream;
    }
  }
  if (!stream && !batchCanceled()) {
    item.phase = 'MEDIA RESOLVER: consultando APIs...';
    saveBatch();
    const resolved = await resolveLessonMedia(batch.tabId, item, detection.diagnostics || []);
    stream = resolved.stream;
    streamCameFromResolver = Boolean(stream);
    item.mediaResolverDeferred = !resolved.hadObservedFlow;
    detection.diagnostics = [
      ...(detection.diagnostics || []),
      ...(resolved.diagnostics || [])
    ];
  }
  if (!stream) {
    const diagnostics = detection.diagnostics || [];
    item.status = 'skipped';
    const videos = diagnostics.reduce((sum, frame) => sum + (frame.videoCount || 0), 0);
    const pausedVideos = diagnostics.reduce((sum, frame) => sum + (frame.videoPausedCount || 0), 0);
    const blobVideos = diagnostics.reduce((sum, frame) => sum + (frame.videoBlobCount || 0), 0);
    const iframes = diagnostics.reduce((sum, frame) => sum + (frame.iframeCount || 0), 0);
    const hosts = [...new Set(diagnostics.flatMap((frame) => frame.iframeHosts || []))];
    const network = lessonDebugContexts.get(debugTabId)?.network || [];
    const mediaNetwork = network.filter((entry) =>
      entry.type === 'media' || /^(?:video\/|audio\/)|mpegurl|dash\+xml|octet-stream/i.test(entry.contentType || '')
    );
    const networkHosts = [...new Set(mediaNetwork.map((entry) => hostOf(entry.url)).filter(Boolean))];
    const networkTypes = [...new Set(mediaNetwork.map((entry) => entry.contentType).filter(Boolean))];
    item.error = [
      'sem URL de video detectada',
      `${diagnostics.length} frame(s) inspecionado(s)`,
      `${videos} video(s)`,
      pausedVideos ? `${pausedVideos} pausado(s)` : null,
      blobVideos ? `${blobVideos} blob/MediaSource` : null,
      `${iframes} iframe(s)`,
      hosts.length ? `player: ${hosts.join(', ')}` : null,
      networkHosts.length ? `rede: ${networkHosts.slice(0, 3).join(', ')}` : null,
      networkTypes.length ? `tipo: ${networkTypes.slice(0, 2).join(', ')}` : null,
      `navegacao: ${item.navigation || 'desconhecida'}`
    ].filter(Boolean).join(' · ');
    return;
  }
  if (!streamCameFromResolver) await rememberPlayerFlow(debugTabId, item);
  const debugContext = lessonDebugContexts.get(debugTabId);
  if (debugContext) debugContext.videoUrl = stream.url;
  if (batchCanceled()) return;

  item.phase = 'Baixando…';
  saveBatch();

  if (stream.format === 'dash' || item.isBonus || stream.extractor || stream.youtube) {
    let nativeStream = stream;
    let finished = null;
    let fallbackHls = stream.format === 'hls' ? stream : null;
    let remaining = [...(tabStreams.get(batch.tabId) || [])];
    const nativeErrors = [];
    for (let attempt = 1; attempt <= 5 && nativeStream && !batchCanceled(); attempt++) {
      item.phase = attempt === 1
        ? 'Baixando e montando o vídeo…'
        : `Tentando outra fonte do vídeo (${attempt}/5)…`;
      saveBatch();
      finished = await downloadNativeMedia(item, nativeStream.url, {
        audioUrl: nativeStream.audioUrl || null,
        referer: nativeStream.documentUrl || nativeStream.initiator || item.actualUrl || item.url || '',
        headers: nativeStream.requestHeaders || null
      });
      if (finished.ok) break;
      nativeErrors.push(finished.error || 'fonte recusada pelo conversor');
      remaining = remaining.filter((candidate) => candidate.url !== nativeStream.url);
      nativeStream = await pickStream(remaining, detection.diagnostics || []);
      if (nativeStream?.format === 'hls' && !fallbackHls) fallbackHls = nativeStream;
    }

    if (finished?.ok) {
      item.status = 'done';
      item.filename = finished.filename;
      item.savedPath = finished.savedPath;
      item.container = finished.container;
      item.downloadIds = finished.downloadIds;
      await markCompleted(item.url, { ...finished, validatedBonus: item.isBonus });
    } else if (!fallbackHls) {
      item.status = 'error';
      item.error = nativeErrors.slice(-3).join(' · ') || 'nenhuma fonte de vídeo pôde ser baixada';
    } else {
      // HLS ainda tem o montador do navegador como reserva se o FFmpeg falhar.
      item.phase = 'Tentando o download pelo navegador…';
      saveBatch();
      const fallback = await startDownload({
        tabId: batch.tabId,
        url: fallbackHls.url,
        format: fallbackHls.format,
        baseName: item.path
      });
      if (!fallback.ok) {
        item.status = 'error';
        item.error = `${nativeErrors.slice(-1)[0] || 'FFmpeg falhou'} · ${fallback.error}`;
        return;
      }
      item.jobId = job.id;
      saveBatch();
      const fallbackFinished = await waitForJob(job.id);
      if (fallbackFinished.status === 'done') {
        item.status = 'done';
        item.filename = fallbackFinished.filename;
        item.savedPath = fallbackFinished.savedPath || null;
        item.container = fallbackFinished.container || null;
        await markCompleted(item.url, { ...fallbackFinished, validatedBonus: true });
      } else if (fallbackFinished.status === 'canceled') {
        item.status = 'pending';
      } else {
        item.status = 'error';
        item.error = fallbackFinished.error || nativeErrors.slice(-1)[0] || 'o download falhou';
      }
    }
    return;
  }

  const started = await startDownload({
    tabId: batch.tabId,
    url: stream.url,
    format: stream.format,
    baseName: item.path
  });
  if (!started.ok) {
    item.status = 'error';
    item.error = started.error;
    return;
  }

  item.jobId = job.id;
  saveBatch();

  const finished = await waitForJob(job.id);

  if (finished.status === 'done') {
    item.status = 'done';
    item.filename = finished.filename;
    item.savedPath = finished.savedPath || null;
    item.container = finished.container || null;
    await markCompleted(item.url, { ...finished, validatedBonus: item.isBonus });
  } else if (finished.status === 'canceled') {
    item.status = 'pending'; // fila cancelada: o item volta a fila
  } else if (isAuthorizationDownloadError(finished.error)) {
    // Alguns CDNs aceitam a requisicao feita pelo player, mas recusam a mesma
    // URL quando ela parte do documento offscreen da extensao. O host nativo
    // pode repetir o download com o Referer verdadeiro do iframe da aula.
    item.phase = 'Acesso recusado; tentando novamente pelo conversor...';
    saveBatch();
    const nativeFinished = await downloadNativeMedia(item, stream.url, {
      referer: stream.documentUrl || stream.initiator || item.actualUrl || item.url || '',
      headers: stream.requestHeaders || null
    });
    if (nativeFinished.ok) {
      item.status = 'done';
      item.filename = nativeFinished.filename;
      item.savedPath = nativeFinished.savedPath;
      item.container = nativeFinished.container;
      item.downloadIds = nativeFinished.downloadIds;
      await markCompleted(item.url, { ...nativeFinished, validatedBonus: item.isBonus });
    } else {
      item.status = 'error';
      item.error = `${finished.error} · tentativa com Referer: ${nativeFinished.error}`;
    }
  } else {
    item.status = 'error';
    item.error = finished.error || 'o download falhou';
  }
  } finally {
    await reportLessonDebug(debugTabId, item);
  }
}

async function pumpBatch() {
  if (pumping) return;
  pumping = true;

  try {
    while (true) {
      await loadBatch();
      if (!batch || batch.status !== 'running') break;

      if (batch.cursor >= batch.items.length) {
        const deferredIndex = observedPlayerFlow
          ? batch.items.findIndex((item) =>
              item.status === 'skipped' && item.mediaResolverDeferred && !item.mediaResolverRetried
            )
          : -1;
        if (deferredIndex >= 0) {
          const deferred = batch.items[deferredIndex];
          deferred.status = 'pending';
          deferred.error = null;
          deferred.phase = null;
          deferred.mediaResolverRetried = true;
          batch.cursor = deferredIndex;
          saveBatch();
          continue;
        }
        batch.status = 'done';
        batch.finishedAt = Date.now();
        saveBatch();
        break;
      }

      const item = batch.items[batch.cursor];
      if (item.status === 'pending' || item.status === 'active') {
        await runBatchItem(item);
      }

      if (batchCanceled()) break;

      // Criptografia/DRM e uma limitacao definitiva desta aula. Registra a
      // protecao e segue automaticamente; erros recuperaveis continuam
      // parando no item exato para permitir nova tentativa.
      if (autoSkipProtectedItem(batch, item)) {
        saveBatch();
        continue;
      }

      // Nao avanca silenciosamente para a proxima aula. Mantemos o cursor na
      // falha para que "Tentar novamente" reabra exatamente o mesmo item.
      if (stopBatchOnItemFailure(batch, item)) {
        saveBatch();
        break;
      }

      batch.cursor++;
      saveBatch();

      // Pausa pedida durante a aula: para aqui, com a aula ja concluida.
      if (batch.status === 'paused') break;
    }
  } finally {
    pumping = false;

    if (batch && batch.status !== 'running' && batch.status !== 'paused') {
      chrome.alarms.clear(WATCHDOG).catch(() => {});
      if (batch.returnUrl) {
        chrome.tabs.update(batch.tabId, { url: batch.returnUrl }).catch(() => {});
      }
    }
  }
}

async function startBatch({ tabId, courseTitle, items }) {
  await loadBatch();
  if (batch && (batch.status === 'running' || batch.status === 'paused')) {
    return { ok: false, error: 'Ja existe uma fila em andamento.' };
  }
  if (job && job.status === 'running') {
    return { ok: false, error: 'Ha um download avulso em andamento.' };
  }
  if (!items || !items.length) {
    return { ok: false, error: 'Nenhum item selecionado.' };
  }

  let returnUrl = null;
  try {
    returnUrl = (await chrome.tabs.get(tabId)).url;
  } catch {
    /* aba fechada */
  }

  batch = {
    id: `batch-${Date.now()}`,
    tabId,
    courseTitle,
    returnUrl,
    status: 'running',
    cursor: 0,
    startedAt: Date.now(),
    items: items.map((item) => ({
      url: item.url,
      title: item.title,
      kind: ['video', 'text', 'file', 'resource'].includes(item.kind) ? item.kind : null,
      isBonus: Boolean(item.isBonus),
      identifiers: item.identifiers && typeof item.identifiers === 'object'
        ? Object.fromEntries(
            Object.entries(item.identifiers).filter(([key, value]) =>
              PLAYER_ID_KEY_RE.test(key) &&
              (typeof value === 'string' || typeof value === 'number')
            )
          )
        : null,
      moduleTitle: item.moduleTitle,
      moduleIndex: item.moduleIndex,
      lessonIndex: item.lessonIndex,
      // Selecionada de proposito mesmo constando como baixada: refaz.
      force: Boolean(item.force),
      path: lessonPath(courseTitle, item),
      status: 'pending',
      phase: null,
      error: null,
      filename: null
    }))
  };
  saveBatch();

  chrome.alarms.create(WATCHDOG, { periodInMinutes: 0.5 });
  pumpBatch();

  return { ok: true };
}

async function cancelBatch() {
  await loadBatch();
  if (!batch || (batch.status !== 'running' && batch.status !== 'paused')) return { ok: false };

  batch.status = 'canceled';
  batch.finishedAt = Date.now();
  saveBatch();
  await cancelDownload();
  chrome.alarms.clear(WATCHDOG).catch(() => {});

  return { ok: true };
}

/**
 * Pausa entre aulas: a aula em andamento termina de baixar (nao se joga fora
 * um download quase pronto) e a fila para antes da proxima.
 */
async function pauseBatch() {
  await loadBatch();
  if (!batch || batch.status !== 'running') return { ok: false };
  batch.status = 'paused';
  saveBatch();
  return { ok: true, aguardandoAulaAtual: Boolean(job && job.status === 'running') };
}

async function resumeBatch() {
  await loadBatch();
  if (!batch || batch.status !== 'paused') return { ok: false };
  batch.status = 'running';
  saveBatch();
  chrome.alarms.create(WATCHDOG, { periodInMinutes: 0.5 });
  pumpBatch();
  return { ok: true };
}

/** Recoloca falhas na fila e continua pendentes, sem refazer o que deu certo. */
async function retryFailed() {
  await loadBatch();
  if (!batch || batch.status === 'running') return { ok: false };

  batch.items.forEach((item) => {
    if (item.status !== 'error' && item.status !== 'skipped') return;
    item.status = 'pending';
    item.error = null;
    item.phase = null;
  });

  const primeiro = batch.items.findIndex(
    (item) => item.status === 'pending' || item.status === 'active'
  );
  if (primeiro < 0) return { ok: false, error: 'Nenhum item restante.' };

  batch.cursor = primeiro;
  batch.status = 'running';
  delete batch.finishedAt;
  saveBatch();

  chrome.alarms.create(WATCHDOG, { periodInMinutes: 0.5 });
  pumpBatch();
  return { ok: true };
}

/** Ignora somente a aula protegida atual e retoma a fila na seguinte. */
async function skipProtectedAndContinue() {
  await loadBatch();
  if (!batch || batch.status !== 'failed') {
    return { ok: false, error: 'A fila nao esta parada em uma falha.' };
  }
  const item = batch.items[batch.cursor];
  if (!item || !isProtectedMediaError(item.error)) {
    return { ok: false, error: 'A falha atual nao e uma midia protegida.' };
  }

  if (!autoSkipProtectedItem(batch, item)) {
    return { ok: false, error: 'Nao foi possivel ignorar a midia protegida.' };
  }
  batch.status = 'running';
  delete batch.finishedAt;
  saveBatch();

  chrome.alarms.create(WATCHDOG, { periodInMinutes: 0.5 });
  pumpBatch();
  return { ok: true };
}

/**
 * O service worker pode ser encerrado durante uma pausa longa da fila (uma aula
 * sem video, por exemplo). Este alarme o traz de volta e retoma de onde parou.
 */
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== WATCHDOG) return;
  if (pumping) return;

  await loadBatch();
  if (!batch || batch.status !== 'running') {
    chrome.alarms.clear(WATCHDOG).catch(() => {});
    return;
  }

  const item = batch.items[batch.cursor];
  if (item && item.status === 'active') item.status = 'pending';
  pumpBatch();
});

/* ------------------------------------------------------------------ *
 * Mensagens
 * ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const type = message && message.type;

  // Mensagens destinadas ao documento offscreen nao sao tratadas aqui.
  if (message && message.target === 'offscreen') return false;

  if (type === 'get-state') {
    Promise.all([ensureLoaded(), loadBatch(), getCompleted()]).then(([, , completed]) => {
      const tabId = message.tabId;
      sendResponse({
        current: tabStreams.get(tabId) || [],
        all: Object.fromEntries(tabStreams),
        job,
        batch,
        completed
      });
    });
    return true;
  }

  if (type === 'scan-course') {
    courseScan(message.tabId, { force: Boolean(message.force) }).then(sendResponse);
    return true;
  }

  if (type === 'start-batch') {
    startBatch(message).then(sendResponse);
    return true;
  }

  if (type === 'cancel-batch') {
    cancelBatch().then(sendResponse);
    return true;
  }

  if (type === 'pause-batch') {
    pauseBatch().then(sendResponse);
    return true;
  }

  if (type === 'resume-batch') {
    resumeBatch().then(sendResponse);
    return true;
  }

  if (type === 'retry-failed') {
    retryFailed().then(sendResponse);
    return true;
  }

  if (type === 'skip-protected') {
    skipProtectedAndContinue().then(sendResponse);
    return true;
  }

  if (type === 'verify-completed') {
    verifyCompleted().then((completed) => sendResponse({ ok: true, completed }));
    return true;
  }

  if (type === 'dismiss-batch') {
    loadBatch().then(() => {
      if (batch && batch.status !== 'running') {
        batch = null;
        chrome.storage.session.remove(BATCH_KEY).catch(() => {});
      }
      sendResponse({ ok: true });
    });
    return true;
  }

  if (type === 'forget-completed') {
    chrome.storage.local.remove(DONE_KEY).then(
      () => sendResponse({ ok: true }),
      () => sendResponse({ ok: false })
    );
    return true;
  }

  if (type === 'probe-master') {
    probeMaster(message.url).then((result) => {
      sendResponse({
        variants: result.variants,
        best: result.best
          ? {
              label: result.best.label,
              width: result.best.width,
              height: result.best.height,
              bandwidth: result.best.bandwidth
            }
          : null,
        single: result.single,
        error: result.error
      });
    });
    return true;
  }

  if (type === 'start-download') {
    startDownload({ tabId: message.tabId, url: message.url, format: message.format }).then(sendResponse);
    return true;
  }

  if (type === 'cancel-download') {
    cancelDownload().then(sendResponse);
    return true;
  }

  if (type === 'show-download') {
    // Abre o Explorador ja com o arquivo selecionado.
    try {
      if (message.downloadId) chrome.downloads.show(message.downloadId);
      else chrome.downloads.showDefaultFolder();
      sendResponse({ ok: true });
    } catch (error) {
      chrome.downloads.showDefaultFolder();
      sendResponse({ ok: false, error: error.message });
    }
    return true;
  }

  if (type === 'dismiss-job') {
    if (job && job.status !== 'running') job = null;
    closeOffscreenIfIdle();
    sendResponse({ ok: true });
    return true;
  }

  if (type === 'clear-tab') {
    ensureLoaded().then(() => {
      clearTab(message.tabId, { keepEntry: true });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (type === 'clear-all') {
    ensureLoaded().then(() => {
      const ids = [...tabStreams.keys()];
      tabStreams.clear();
      persist();
      masterCache.clear();
      directMediaCache.clear();
      ids.forEach(updateBadge);
      sendResponse({ ok: true });
    });
    return true;
  }

  /* --- relatorios vindos do documento offscreen --- */

  if (type === 'job-progress') {
    const activeJob = adoptJob(message.jobId);
    Object.assign(activeJob, message.patch);
    const elapsedSeconds = Math.max(0.001, (Date.now() - activeJob.startedAt) / 1000);
    if (activeJob.receivedBytes > 0) {
      activeJob.bytesPerSecond = activeJob.receivedBytes / elapsedSeconds;
    }
    if (activeJob.total > 0 && activeJob.current > 0 && activeJob.current < activeJob.total) {
      activeJob.etaSeconds = elapsedSeconds * (activeJob.total - activeJob.current) / activeJob.current;
    } else {
      activeJob.etaSeconds = null;
    }
    return false;
  }

  if (type === 'job-blob') {
    saveBlob(message);
    return false;
  }

  if (type === 'job-done') {
    Object.assign(adoptJob(message.jobId), message.patch, {
      status: message.patch.status || 'done'
    });
    closeOffscreenIfIdle();
    return false;
  }

  return false;
});
