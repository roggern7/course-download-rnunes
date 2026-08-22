/**
 * Course Downloader RNUNES - documento offscreen
 *
 * Baixa os segmentos da playlist HLS e monta um unico arquivo.
 * Roda fora do service worker porque precisa de URL.createObjectURL e de um
 * contexto que nao seja encerrado no meio do download.
 *
 * Todas as requisicoes saem com `credentials: 'omit'`: nenhum cookie, token ou
 * cabecalho da pagina e reutilizado. Playlists criptografadas sao recusadas.
 */

import {
  parseMaster,
  parseMedia,
  pickBestVariant,
  isMasterPlaylist,
  detectContainer,
  formatDuration
} from './hls.js';

const CONCURRENCY = 5;
const RETRIES = 3;
const PROGRESS_INTERVAL_MS = 200;
const PANDA_HOST_RE = /(?:^|\.)pandavideo\.com\.br$/i;
const PANDA_FALLBACK_IDS = new Set([
  '48af5a59-3ac4-480e-abff-905690d94567',
  'cd676325-3f2d-4ad5-b95c-c2a683d7b0cc',
  'f7a741ee-5cad-4f8c-87bc-f6a008776edb'
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @type {{ id: string, controller: AbortController } | null} */
let active = null;

/** Blob URLs vivas ate o download terminar: jobId -> objectUrl. */
const liveUrls = new Map();

/* ------------------------------------------------------------------ */

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

function assertRealPandaMedia(masterUrl, variants = []) {
  const expectedId = pandaMediaId(masterUrl);
  if (expectedId && PANDA_FALLBACK_IDS.has(expectedId)) {
    throw new Error('O player devolveu uma mídia interna de erro, não o vídeo da aula.');
  }
  if (!expectedId) return;
  const redirected = variants.find((variant) => {
    const variantId = pandaMediaId(variant.url);
    return variantId && variantId !== expectedId;
  });
  if (redirected) {
    throw new Error('O manifesto da aula foi substituído por uma mídia interna de erro do player.');
  }
}

/* ------------------------------------------------------------------ */

function send(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

function report(jobId, patch) {
  send({ type: 'job-progress', jobId, patch });
}

function finish(jobId, patch) {
  send({ type: 'job-done', jobId, patch });
}

/* ------------------------------------------------------------------ */

async function fetchWithRetry(url, signal, asText = false) {
  let lastError;

  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        credentials: 'omit',
        cache: 'no-store',
        signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return asText ? await response.text() : await response.blob();
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      lastError = error;
      if (attempt < RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
      }
    }
  }

  throw new Error(`${lastError.message} em ${new URL(url).pathname.split('/').pop()}`);
}

/**
 * Baixa uma lista de URLs preservando a ordem, com concorrencia limitada.
 * @returns {Promise<Blob[]>}
 */
async function fetchAllInOrder(urls, signal, onTick) {
  const parts = new Array(urls.length);
  let nextIndex = 0;
  let completed = 0;
  let bytes = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= urls.length) return;

      const blob = await fetchWithRetry(urls[index], signal);
      parts[index] = blob;
      completed++;
      bytes += blob.size;
      onTick(completed, bytes);
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker);
  await Promise.all(workers);
  return parts;
}

/* ------------------------------------------------------------------ */

async function runJob({ jobId, url, format = 'hls', baseName }) {
  const controller = new AbortController();
  active = { id: jobId, controller };
  const { signal } = controller;

  try {
    assertRealPandaMedia(url);
    if (format === 'file') {
      report(jobId, { phase: 'Baixando o arquivo de video...', container: 'mp4' });
      const blob = await fetchWithRetry(url, signal);
      if (signal.aborted) throw new DOMException('Cancelado', 'AbortError');

      const objectUrl = URL.createObjectURL(blob);
      liveUrls.set(jobId, objectUrl);
      send({
        type: 'job-blob',
        jobId,
        objectUrl,
        filename: `Course Downloader RNUNES/${baseName}.mp4`,
        container: 'mp4',
        size: blob.size
      });
      return;
    }

    report(jobId, { phase: 'Lendo a playlist…' });

    const firstText = await fetchWithRetry(url, signal, true);

    let mediaUrl = url;
    let mediaText = firstText;
    let quality = null;

    if (isMasterPlaylist(firstText)) {
      const { variants, sessionKey } = parseMaster(firstText, url);

      assertRealPandaMedia(url, variants);

      if (sessionKey) {
        throw new Error(
          `Playlist protegida (METHOD=${sessionKey}). Esta extensao nao remove criptografia nem DRM.`
        );
      }
      if (!variants.length) {
        throw new Error('A playlist mestra nao lista nenhuma variante.');
      }

      const best = pickBestVariant(variants);
      quality = best.label;
      mediaUrl = best.url;

      report(jobId, {
        quality,
        variantCount: variants.length,
        phase: `Melhor qualidade: ${quality} — lendo segmentos…`
      });

      mediaText = await fetchWithRetry(mediaUrl, signal, true);
    }

    const media = parseMedia(mediaText, mediaUrl);

    if (media.encryption) {
      throw new Error(
        `Playlist criptografada (METHOD=${media.encryption}). Esta extensao nao remove criptografia nem DRM.`
      );
    }
    if (media.isLive) {
      throw new Error('Transmissao ao vivo (sem #EXT-X-ENDLIST) nao e suportada.');
    }
    if (!media.segments.length) {
      throw new Error('A playlist nao contem segmentos.');
    }

    const container = detectContainer(media);
    const urls = media.initUrl
      ? [media.initUrl, ...media.segments.map((s) => s.url)]
      : media.segments.map((s) => s.url);

    report(jobId, {
      total: urls.length,
      container,
      quality,
      duration: media.duration,
      phase: `Baixando ${urls.length} segmentos (${formatDuration(media.duration)})…`
    });

    let lastTick = 0;
    const parts = await fetchAllInOrder(urls, signal, (completed, bytes) => {
      const now = Date.now();
      if (now - lastTick < PROGRESS_INTERVAL_MS && completed < urls.length) return;
      lastTick = now;
      report(jobId, {
        current: completed,
        total: urls.length,
        receivedBytes: bytes,
        phase: `Baixando segmentos ${completed}/${urls.length}…`
      });
    });

    if (signal.aborted) throw new DOMException('Cancelado', 'AbortError');

    report(jobId, { phase: 'Montando o arquivo…' });

    const blob = new Blob(parts, {
      type: container === 'mp4' ? 'video/mp4' : 'video/mp2t'
    });
    const objectUrl = URL.createObjectURL(blob);
    liveUrls.set(jobId, objectUrl);

    const filename = `Course Downloader RNUNES/${baseName}.${container}`;

    send({
      type: 'job-blob',
      jobId,
      objectUrl,
      filename,
      container,
      size: blob.size
    });
  } catch (error) {
    controller.abort(); // interrompe os segmentos ainda em voo
    if (error.name === 'AbortError') {
      finish(jobId, { status: 'canceled', phase: 'Download cancelado.' });
    } else {
      finish(jobId, { status: 'error', error: error.message, phase: 'Falhou.' });
    }
  } finally {
    if (active && active.id === jobId) active = null;
  }
}

/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.target !== 'offscreen') return false;

  if (message.type === 'run-job') {
    runJob(message);
    return false;
  }

  if (message.type === 'cancel-job') {
    if (active && active.id === message.jobId) active.controller.abort();
    return false;
  }

  if (message.type === 'release-blob') {
    const objectUrl = liveUrls.get(message.jobId);
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      liveUrls.delete(message.jobId);
    }
    return false;
  }

  return false;
});
