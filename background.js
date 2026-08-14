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
 * pagina e lido, armazenado ou reenviado; as requisicoes da extensao saem sem
 * credenciais. Playlists criptografadas ou com DRM sao recusadas.
 */

import {
  parseMaster,
  pickBestVariant,
  isMasterPlaylist,
  sanitizeFilename
} from './hls.js';

const STORAGE_KEY = 'streams';
const MAX_PER_TAB = 200;

const OBSERVED_TYPES = [
  'main_frame',
  'xmlhttprequest',
  'media',
  'object',
  'other'
];

// Cobre: /video.m3u8, /video.m3u8?token=..., ?url=algo.m3u8&..., /hls/m3u8/, ?format=m3u8
const M3U8_RE = /\.m3u8(?![a-z0-9])|[?&/=]m3u8(?![a-z0-9])/i;

/** @type {Map<number, Array<object>> | null} */
let tabStreams = null;
/** @type {Promise<void> | null} */
let loading = null;

/** Cache de leituras de playlist mestra: url -> { variants, best, error }. */
const masterCache = new Map();

/** Estado do unico job de download ativo/recente. */
let job = null;

/** @type {Promise<void> | null} Evita criar dois documentos offscreen. */
let creatingOffscreen = null;

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

async function addStream(tabId, url, type) {
  await ensureLoaded();

  const list = tabStreams.get(tabId) || [];
  if (list.some((item) => item.url === url)) return;
  if (list.length >= MAX_PER_TAB) return;

  const resolution = detectResolution(url);
  list.push({
    url,
    name: shortName(url),
    host: hostOf(url),
    type,
    master: looksLikeMaster(url),
    resolution: resolution ? resolution.label : null,
    height: resolution ? resolution.height : null,
    detectedAt: Date.now()
  });

  tabStreams.set(tabId, list);
  persist();
  updateBadge(tabId);
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

    if (!M3U8_RE.test(url)) return;
    addStream(tabId, url, type);
  },
  { urls: ['http://*/*', 'https://*/*'], types: OBSERVED_TYPES }
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
    credentials: 'omit',
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
async function startDownload({ tabId, url, baseName: explicitName }) {
  if (job && job.status === 'running') {
    return { ok: false, error: 'Ja existe um download em andamento.' };
  }

  // Em lote o caminho ja vem pronto (Curso/Modulo/Aula); avulso, le da pagina.
  const title = explicitName || (await getLessonTitle(tabId));
  const baseName = explicitName || sanitizeFilename(title);

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
      saveAs: false,
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
    if (!result || !result.ok) {
      return {
        ok: false,
        error: (result && result.reason) || 'nao foi possivel ler a navegacao desta pagina'
      };
    }
    return { ok: true, course: result };
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
  try {
    const url = new URL(tabUrl);
    return entry.origin === url.origin && url.pathname.startsWith(entry.prefix);
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

  // Momento certo para reconferir o que ja foi baixado: e agora que a lista de
  // aulas sera montada e marcada.
  await verifyCompleted();

  if (!force && tabUrl) {
    const cache = await getCourseCache();
    const hit = Object.values(cache).find((entry) => cacheCovers(entry, tabUrl));
    if (hit) return { ok: true, course: hit, cached: true };
  }

  const result = await scanCourse(tabId);
  if (!result.ok) return result;

  let origin = '';
  try {
    origin = new URL(result.course.currentUrl || tabUrl).origin;
  } catch {
    /* sem origem utilizavel */
  }

  const entry = { ...result.course, origin, scannedAt: Date.now() };

  if (origin && entry.prefix && entry.prefix !== '/' && entry.lessonCount) {
    const cache = await getCourseCache();
    cache[origin + entry.prefix] = entry;
    await chrome.storage.local.set({ [COURSE_KEY]: cache }).catch(() => {});
  }

  return { ok: true, course: entry, cached: false };
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
  all[lessonUrl] = {
    filename: info.filename || null,
    path: info.savedPath || null,
    downloadId: info.downloadId || null,
    at: Date.now()
  };
  await chrome.storage.local.set({ [DONE_KEY]: all }).catch(() => {});
}

/** O arquivo daquele registro ainda esta no disco? Na duvida, responde nao. */
async function arquivoAindaExiste(registro) {
  if (!registro || !registro.downloadId) return false;
  try {
    const [item] = await chrome.downloads.search({ id: registro.downloadId });
    return Boolean(item) && item.exists !== false;
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
    if (!entry || !entry.downloadId) {
      delete all[url];
      mudou = true;
      continue;
    }
    try {
      const [item] = await chrome.downloads.search({ id: entry.downloadId });
      if (!item || item.exists === false) {
        delete all[url];
        mudou = true;
      } else if (item.filename && item.filename !== entry.path) {
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

/** Monta Curso/Modulo/Aula, numerando so o que ainda nao comeca com numero. */
function lessonPath(courseTitle, item) {
  const pad = (n) => String(n).padStart(2, '0');
  const numbered = (index, title) =>
    /^\d/.test(String(title).trim()) ? title : `${pad(index)} - ${title}`;

  return [
    sanitizeFilename(courseTitle, 'Curso'),
    sanitizeFilename(numbered(item.moduleIndex, item.moduleTitle), `Modulo ${pad(item.moduleIndex)}`),
    sanitizeFilename(numbered(item.lessonIndex, item.title), `Aula ${pad(item.lessonIndex)}`)
  ].join('/');
}

async function waitForTabLoad(tabId, timeoutMs = PAGE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  await delay(400); // deixa a navegacao comecar antes de ler o status
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') return true;
    } catch {
      return false; // aba fechada
    }
    await delay(250);
  }
  return false;
}

/**
 * Alguns players so pedem a playlist quando o video comeca. Isso apenas aciona
 * play() no elemento de video ja presente na pagina - nao contorna login,
 * paywall nem protecao.
 */
async function nudgePlay(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        for (const video of document.querySelectorAll('video')) {
          try {
            video.muted = true;
            const played = video.play();
            if (played && played.catch) played.catch(() => {});
          } catch {
            /* autoplay bloqueado */
          }
        }
      }
    });
  } catch {
    /* pagina sem permissao de injecao */
  }
}

/**
 * Escolhe entre as playlists detectadas na aula. O nome do arquivo nao serve
 * como criterio (muitas mestras se chamam main.m3u8, que nao parece "master"),
 * entao a decisao vem da leitura da playlist: vale a que declara variantes.
 * Reaproveita o cache de probeMaster.
 */
async function pickStream(list) {
  for (const stream of list) {
    const probed = await probeMaster(stream.url);
    if (probed && !probed.error && probed.variants.length) return stream;
  }
  return list[0];
}

/** Espera a aba revelar uma playlist, dando tempo para as variantes chegarem. */
async function waitForStream(tabId, timeoutMs = STREAM_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let firstSeenAt = null;

  while (Date.now() < deadline) {
    await ensureLoaded();
    const list = tabStreams.get(tabId) || [];

    if (list.length) {
      if (!firstSeenAt) firstSeenAt = Date.now();
      if (Date.now() - firstSeenAt > 1200) return pickStream(list);
    }

    await delay(300);
  }

  return null;
}

async function waitForJob(jobId, timeoutMs = 45 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (job && job.id === jobId && job.status !== 'running') return job;
    await delay(400);
  }
  return { status: 'error', error: 'tempo limite do download excedido' };
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

  try {
    await chrome.tabs.update(batch.tabId, { url: item.url });
  } catch (error) {
    item.status = 'error';
    item.error = `nao foi possivel abrir a aba (${error.message})`;
    return;
  }

  if (!(await waitForTabLoad(batch.tabId))) {
    item.status = 'error';
    item.error = 'a pagina nao terminou de carregar';
    return;
  }
  if (batchCanceled()) return;

  item.phase = 'Procurando o video…';
  saveBatch();
  await nudgePlay(batch.tabId);

  const stream = await waitForStream(batch.tabId);
  if (!stream) {
    item.status = 'skipped';
    item.error = 'sem video nesta aula';
    return;
  }
  if (batchCanceled()) return;

  item.phase = 'Baixando…';
  saveBatch();

  const started = await startDownload({
    tabId: batch.tabId,
    url: stream.url,
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
    await markCompleted(item.url, finished);
  } else if (finished.status === 'canceled') {
    item.status = 'pending'; // fila cancelada: o item volta a fila
  } else {
    item.status = 'error';
    item.error = finished.error || 'o download falhou';
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
    return { ok: false, error: 'Nenhuma aula selecionada.' };
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

/** Recoloca na fila tudo que falhou, sem refazer o que ja deu certo. */
async function retryFailed() {
  await loadBatch();
  if (!batch || batch.status === 'running') return { ok: false };

  let primeiro = -1;
  batch.items.forEach((item, index) => {
    if (item.status !== 'error') return;
    item.status = 'pending';
    item.error = null;
    item.phase = null;
    if (primeiro < 0) primeiro = index;
  });

  if (primeiro < 0) return { ok: false, error: 'Nenhuma aula com erro.' };

  batch.cursor = primeiro;
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
    startDownload({ tabId: message.tabId, url: message.url }).then(sendResponse);
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
      ids.forEach(updateBadge);
      sendResponse({ ok: true });
    });
    return true;
  }

  /* --- relatorios vindos do documento offscreen --- */

  if (type === 'job-progress') {
    Object.assign(adoptJob(message.jobId), message.patch);
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
