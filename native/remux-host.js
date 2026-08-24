#!/usr/bin/env node
/**
 * Course Downloader RNUNES - host de mensagens nativas para converter TS em MP4.
 *
 * Uma extensao Chrome nao pode executar o FFmpeg. Este host, quando instalado
 * (tools/instalar-auto-mp4.ps1), recebe o caminho do .ts recem-baixado e o
 * converte com `-c copy`: sem recodificar, sem perda de qualidade.
 *
 * Protocolo (Chrome native messaging): cada mensagem e um inteiro de 32 bits
 * little-endian com o tamanho, seguido do JSON em UTF-8, por stdin/stdout.
 *
 * Mensagem aceita:
 *   { "action": "remux", "file": "C:\\...\\aula.ts", "deleteSource": true }
 *   { "action": "exists", "file": "C:\\...\\aula.mp4" }
 *   { "action": "find-remuxed", "file": "C:\\...\\aula.ts" }
 *   { "action": "find-course-files", "items": [{ "key": "...", "bases": ["Curso/Modulo/Aula"], "kind": "video" }] }
 *   { "action": "place-in-folder", "file": "C:\\...\\03 - Video.mp4", "folderName": "03 - Video" }
 *   { "action": "download-media", "url": "https://.../manifest.mpd", "directory": "Course Downloader RNUNES/Curso/Aula", "name": "Video.mp4" }
 *   { "action": "ping" }
 *
 * Resposta:
 *   { "ok": true, "output": "C:\\...\\aula.mp4", "ms": 1234 }
 *   { "ok": false, "error": "..." }
 *
 * A acao download-media acessa somente a URL recebida e grava o resultado em
 * uma pasta relativa validada dentro de Downloads. As demais acoes sao locais.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const MAX_MESSAGE = 64 * 1024 * 1024;
const FFMPEG_TIMEOUT_MS = 15 * 60 * 1000;
const MEDIA_TIMEOUT_MS = 3 * 60 * 60 * 1000;

/* ---------------------------------------------------------------- */

function respond(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

/** Procura o ffmpeg no PATH e nos lugares onde o winget costuma instalar. */
function findFfmpeg() {
  const candidatos = [];

  if (process.env.COURSE_DOWNLOADER_FFMPEG) {
    candidatos.push(process.env.COURSE_DOWNLOADER_FFMPEG);
  }

  const exts = (process.env.PATHEXT || '.EXE').split(';');
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      candidatos.push(path.join(dir, `ffmpeg${ext.toLowerCase()}`));
    }
  }

  const local = process.env.LOCALAPPDATA;
  if (local) {
    const raiz = path.join(local, 'Microsoft', 'WinGet', 'Packages');
    try {
      for (const pasta of fs.readdirSync(raiz)) {
        if (!/ffmpeg/i.test(pasta)) continue;
        const pilha = [path.join(raiz, pasta)];
        while (pilha.length) {
          const atual = pilha.pop();
          for (const entrada of fs.readdirSync(atual, { withFileTypes: true })) {
            const cheio = path.join(atual, entrada.name);
            if (entrada.isDirectory()) pilha.push(cheio);
            else if (/^ffmpeg\.exe$/i.test(entrada.name)) candidatos.push(cheio);
          }
        }
      }
    } catch {
      /* winget nao usado */
    }
  }

  candidatos.push('C:\\ffmpeg\\bin\\ffmpeg.exe');

  for (const candidato of candidatos) {
    try {
      if (fs.existsSync(candidato) && fs.statSync(candidato).isFile()) return candidato;
    } catch {
      /* caminho invalido */
    }
  }
  return null;
}

function nomeLivre(base) {
  let alvo = `${base}.mp4`;
  let n = 1;
  while (fs.existsSync(alvo)) alvo = `${base} (${n++}).mp4`;
  return alvo;
}

function remux({ file, deleteSource }) {
  if (!file || typeof file !== 'string') return { ok: false, error: 'caminho ausente' };
  if (!/\.ts$/i.test(file)) return { ok: false, error: 'so converto arquivos .ts' };
  if (!fs.existsSync(file)) return { ok: false, error: `arquivo nao encontrado: ${file}` };

  const ffmpeg = findFfmpeg();
  if (!ffmpeg) {
    return { ok: false, error: 'FFmpeg nao encontrado. Instale com: winget install Gyan.FFmpeg' };
  }

  const saida = nomeLivre(file.replace(/\.ts$/i, ''));
  const inicio = Date.now();

  try {
    execFileSync(
      ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-y',
       '-i', file,
       '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart',
       saida],
      { timeout: FFMPEG_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch (erro) {
    try { if (fs.existsSync(saida)) fs.unlinkSync(saida); } catch { /* ignora */ }
    const detalhe = (erro.stderr && erro.stderr.toString().trim().split('\n').pop()) || erro.message;
    return { ok: false, error: `ffmpeg falhou: ${detalhe}` };
  }

  if (!fs.existsSync(saida) || fs.statSync(saida).size === 0) {
    return { ok: false, error: 'ffmpeg terminou sem gerar o arquivo' };
  }

  // So apaga o .ts depois de confirmar que o .mp4 tem tamanho coerente.
  const origem = fs.statSync(file).size;
  const destino = fs.statSync(saida).size;
  let removido = false;
  if (deleteSource && destino > origem * 0.5) {
    try { fs.unlinkSync(file); removido = true; } catch { /* em uso */ }
  }

  return {
    ok: true,
    output: saida,
    ms: Date.now() - inicio,
    bytes: destino,
    sourceRemoved: removido,
    ffmpeg
  };
}

function nomeSeguro(raw) {
  let cleaned = String(raw || 'Video.mp4')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  cleaned = cleaned.replace(/\.mp4$/i, '').replace(/[. ]+$/g, '').trim();
  return `${cleaned || 'Video'}.mp4`;
}

function hlsAttributes(line) {
  const attrs = {};
  const input = String(line || '').replace(/^#EXT-X-STREAM-INF:/i, '');
  const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
  let match;
  while ((match = pattern.exec(input))) {
    attrs[match[1].toUpperCase()] = match[2].replace(/^"|"$/g, '');
  }
  return attrs;
}

function hlsDuration(playlistText) {
  let duration = 0;
  for (const match of String(playlistText || '').matchAll(/^#EXTINF:([0-9.]+)/gmi)) {
    duration += Number(match[1]) || 0;
  }
  return duration || null;
}

/** Seleciona a maior resolucao e usa bitrate como desempate. */
function selectBestHlsVariant(masterText, masterUrl) {
  const lines = String(masterText || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const variants = [];
  const audioGroups = new Map();
  let pending = null;
  for (const line of lines) {
    if (/^#EXT-X-MEDIA:/i.test(line)) {
      const attrs = hlsAttributes(line);
      if (/^AUDIO$/i.test(attrs.TYPE || '') && attrs['GROUP-ID'] && attrs.URI) {
        try { audioGroups.set(attrs['GROUP-ID'], new URL(attrs.URI, masterUrl).href); }
        catch { audioGroups.set(attrs['GROUP-ID'], attrs.URI); }
      }
      continue;
    }
    if (/^#EXT-X-STREAM-INF:/i.test(line)) {
      const attrs = hlsAttributes(line);
      const dimensions = String(attrs.RESOLUTION || '').match(/^(\d+)x(\d+)$/i);
      pending = {
        width: dimensions ? Number(dimensions[1]) : 0,
        height: dimensions ? Number(dimensions[2]) : 0,
        bandwidth: Number(attrs['AVERAGE-BANDWIDTH'] || attrs.BANDWIDTH || 0)
      };
      if (attrs.AUDIO) pending.audioGroup = attrs.AUDIO;
      continue;
    }
    if (!line.startsWith('#') && pending) {
      try { pending.url = new URL(line, masterUrl).href; }
      catch { pending.url = line; }
      variants.push(pending);
      pending = null;
    }
  }
  if (!variants.length) return null;
  const best = variants.sort((left, right) => {
    const area = right.width * right.height - left.width * left.height;
    return area || right.bandwidth - left.bandwidth;
  })[0];
  if (best.audioGroup && audioGroups.has(best.audioGroup)) {
    best.audioUrl = audioGroups.get(best.audioGroup);
  }
  return best;
}

async function resolveBestHlsInput(url, headers) {
  if (!/\.m3u8(?:$|[?#])/i.test(url) || typeof fetch !== 'function') {
    return { url, audioUrl: null, quality: null };
  }
  try {
    const requestHeaders = {
      'user-agent': headers.userAgent
    };
    if (headers.referer) requestHeaders.referer = headers.referer;
    if (headers.origin) requestHeaders.origin = headers.origin;
    const response = await fetch(url, { headers: requestHeaders, redirect: 'follow', cache: 'no-store' });
    if (!response.ok) return { url, audioUrl: null, quality: null };
    const masterText = await response.text();
    const best = selectBestHlsVariant(masterText, response.url || url);
    if (!best?.url) {
      return { url, audioUrl: null, quality: null, duration: hlsDuration(masterText) };
    }
    let duration = null;
    try {
      const mediaResponse = await fetch(best.url, {
        headers: requestHeaders,
        redirect: 'follow',
        cache: 'no-store'
      });
      if (mediaResponse.ok) duration = hlsDuration(await mediaResponse.text());
    } catch {
      /* o FFmpeg ainda pode baixar mesmo sem duracao antecipada */
    }
    return {
      url: best.url,
      audioUrl: best.audioUrl || null,
      quality: best.height ? `${best.width}x${best.height}` : `${Math.round(best.bandwidth / 1000)} kbps`,
      duration
    };
  } catch {
    return { url, audioUrl: null, quality: null };
  }
}

function runFfmpegWithProgress(ffmpeg, args, { duration = null, onProgress = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let progress = {};
    let detectedQuality = null;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill();
      reject(new Error('tempo limite do FFmpeg excedido'));
    }, MEDIA_TIMEOUT_MS);
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const emit = () => {
      const micros = Number(progress.out_time_us || progress.out_time_ms || 0);
      const current = micros > 0 ? micros / 1_000_000 : 0;
      const percent = duration && current
        ? Math.max(0, Math.min(100, Math.round((current / duration) * 100)))
        : null;
      if (typeof onProgress === 'function') {
        onProgress({
          current,
          duration,
          percent,
          bytes: Number(progress.total_size || 0),
          speed: progress.speed || null,
          quality: detectedQuality
        });
      }
      progress = {};
    };
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() || '';
      for (const line of lines) {
        const separator = line.indexOf('=');
        if (separator < 0) continue;
        progress[line.slice(0, separator)] = line.slice(separator + 1);
        if (line.startsWith('progress=')) emit();
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4 * 1024 * 1024);
      if (!detectedQuality) {
        const resolution = stderr.match(/,\s*(\d{2,5})x(\d{2,5})(?:[\s,])/);
        if (resolution) detectedQuality = `${resolution[1]}x${resolution[2]}`;
      }
      if (!duration) {
        const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
        if (match) duration = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
      }
    });
    child.on('error', finish);
    child.on('close', (code) => {
      if (code === 0) finish();
      else {
        const detail = stderr.trim().split(/\r?\n/).filter(Boolean).pop() || `codigo ${code}`;
        finish(new Error(detail));
      }
    });
  });
}

function normalizeMediaHeaders(headers, referer) {
  const source = headers && typeof headers === 'object' ? headers : {};
  const userAgent = String(source['user-agent'] || source['User-Agent'] ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36');
  let safeReferer = String(source.referer || source.Referer || referer || '');
  let origin = String(source.origin || source.Origin || '');
  try {
    const parsed = new URL(safeReferer);
    if (!/^https?:$/.test(parsed.protocol)) safeReferer = '';
    else if (!origin) origin = parsed.origin;
  } catch {
    safeReferer = '';
  }
  try {
    const parsedOrigin = new URL(origin);
    origin = /^https?:$/.test(parsedOrigin.protocol) ? parsedOrigin.origin : '';
  } catch {
    origin = '';
  }
  return { referer: safeReferer, origin, userAgent };
}

async function downloadMedia(
  { url, marker, directory: relativeDirectory, name, referer, headers },
  downloadsRoot = path.join(os.homedir(), 'Downloads'),
  onProgress = null
) {
  if (!url || typeof url !== 'string') return { ok: false, error: 'URL de mídia ausente' };
  let parsed;
  try { parsed = new URL(url); } catch { return { ok: false, error: 'URL de mídia inválida' }; }
  if (!/^https?:$/.test(parsed.protocol)) return { ok: false, error: 'protocolo de mídia não permitido' };

  let outputDirectory = null;
  if (marker && typeof marker === 'string') {
    if (!fs.existsSync(marker) || !fs.statSync(marker).isFile()) {
      return { ok: false, error: `arquivo marcador não encontrado: ${marker}` };
    }
    outputDirectory = path.dirname(path.resolve(marker));
  } else {
    outputDirectory = safeDownloadTarget(downloadsRoot, relativeDirectory);
    if (!outputDirectory || outputDirectory === path.resolve(downloadsRoot)) {
      return { ok: false, error: 'pasta relativa de destino inválida' };
    }
    try {
      fs.mkdirSync(outputDirectory, { recursive: true });
    } catch (error) {
      return { ok: false, error: `não foi possível criar a pasta do vídeo: ${error.message}` };
    }
  }

  const ffmpeg = findFfmpeg();
  if (!ffmpeg) {
    try { if (marker) fs.unlinkSync(marker); } catch { /* marcador sem importância */ }
    return { ok: false, error: 'FFmpeg não encontrado. Instale com: winget install Gyan.FFmpeg' };
  }

  const safeName = nomeSeguro(name);
  const base = path.join(outputDirectory, safeName.replace(/\.mp4$/i, ''));
  const output = nomeLivre(base);
  const startedAt = Date.now();
  const requestHeaders = normalizeMediaHeaders(headers, referer);
  const selectedInput = await resolveBestHlsInput(parsed.href, requestHeaders);
  const httpArgs = ['-user_agent', requestHeaders.userAgent];
  const headerLines = [
    requestHeaders.referer ? `Referer: ${requestHeaders.referer}` : null,
    requestHeaders.origin ? `Origin: ${requestHeaders.origin}` : null
  ].filter(Boolean);
  if (headerLines.length) httpArgs.push('-headers', `${headerLines.join('\r\n')}\r\n`);

  try {
    const inputs = [...httpArgs, '-i', selectedInput.url];
    if (selectedInput.audioUrl) inputs.push(...httpArgs, '-i', selectedInput.audioUrl);
    const maps = selectedInput.audioUrl
      ? ['-map', '0:v:0?', '-map', '1:a:0?']
      : ['-map', '0:v:0?', '-map', '0:a:0?'];
    await runFfmpegWithProgress(
      ffmpeg,
      ['-hide_banner', '-loglevel', 'info', '-y', '-progress', 'pipe:1', '-nostats',
       ...inputs,
       ...maps,
       '-c', 'copy', '-movflags', '+faststart',
       output],
      {
        duration: selectedInput.duration,
        onProgress: typeof onProgress === 'function'
          ? (progress) => onProgress({
              ...progress,
              quality: selectedInput.quality || progress.quality
            })
          : null
      }
    );
  } catch (error) {
    try { if (fs.existsSync(output)) fs.unlinkSync(output); } catch { /* ignora */ }
    return { ok: false, error: `ffmpeg não conseguiu baixar o vídeo: ${error.message}` };
  } finally {
    try { if (marker && fs.existsSync(marker)) fs.unlinkSync(marker); } catch { /* marcador sem importância */ }
  }

  if (!fs.existsSync(output) || fs.statSync(output).size === 0) {
    return { ok: false, error: 'ffmpeg terminou sem gerar o vídeo' };
  }
  return {
    ok: true,
    output,
    ms: Date.now() - startedAt,
    bytes: fs.statSync(output).size,
    sourceRemoved: true,
    quality: selectedInput.quality,
    ffmpeg
  };
}

function fileExists(file) {
  if (!file || typeof file !== 'string') return { ok: false, exists: false, error: 'caminho ausente' };
  try {
    return { ok: true, exists: fs.existsSync(file) && fs.statSync(file).isFile(), path: file };
  } catch (error) {
    return { ok: false, exists: false, error: error.message };
  }
}

/** Localiza o MP4 criado ao lado de um download .ts já removido pelo remux. */
function findRemuxed(file) {
  if (!file || typeof file !== 'string') return { ok: false, found: false, error: 'caminho ausente' };
  const directory = path.dirname(file);
  const base = path.basename(file).replace(/\.ts$/i, '').replace(/ \(\d+\)$/i, '');
  try {
    const matches = fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => {
        const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`^${escaped}(?: \\(\\d+\\))?\\.mp4$`, 'i').test(name);
      })
      .sort();
    if (!matches.length) return { ok: true, found: false };
    return { ok: true, found: true, path: path.join(directory, matches[0]) };
  } catch (error) {
    return { ok: false, found: false, error: error.message };
  }
}

function findRemuxedMany(files) {
  if (!Array.isArray(files)) return { ok: false, matches: {}, error: 'lista de caminhos ausente' };
  const matches = {};
  for (const file of files.slice(0, 2000)) {
    const result = findRemuxed(file);
    if (result.ok && result.found) matches[file] = result.path;
  }
  return { ok: true, matches };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeDownloadTarget(downloadsRoot, relative) {
  if (!relative || typeof relative !== 'string' || path.isAbsolute(relative)) return null;
  const root = path.resolve(downloadsRoot);
  const target = path.resolve(root, relative.replace(/[\\/]+/g, path.sep));
  return target === root || target.startsWith(root + path.sep) ? target : null;
}

function allowedResource(name, kind) {
  if (kind === 'file') return /\.(?:docx?|pdf|xlsx?|pptx?|zip|rar|7z)$/i.test(name);
  if (kind === 'text') return /\.(?:txt|md)$/i.test(name);
  return !/\.html?$/i.test(name);
}

/**
 * Recupera a associacao aula -> arquivo quando o usuario apagou o historico
 * de downloads do Chrome. Somente caminhos relativos abaixo de Downloads sao
 * aceitos; nenhum arquivo e aberto, movido ou alterado.
 */
function findCourseFiles(items, downloadsRoot = path.join(os.homedir(), 'Downloads')) {
  if (!Array.isArray(items)) return { ok: false, matches: {}, error: 'lista de aulas ausente' };
  const matches = {};

  for (const item of items.slice(0, 3000)) {
    if (!item || typeof item.key !== 'string' || !Array.isArray(item.bases)) continue;
    let found = null;
    for (const relative of item.bases.slice(0, 4)) {
      const base = safeDownloadTarget(downloadsRoot, relative);
      if (!base) continue;
      const directory = path.dirname(base);
      const stem = path.basename(base);

      if (item.kind === 'video' || !item.kind) {
        try {
          const videoPattern = new RegExp(
            `^${escapeRegex(stem)}(?: \\(\\d+\\))?\\.(?:mp4|ts|webm|mkv|mov)$`,
            'i'
          );
          const video = fs.readdirSync(directory, { withFileTypes: true })
            .find((entry) => entry.isFile() && videoPattern.test(entry.name));
          if (video) found = path.join(directory, video.name);
        } catch {
          /* modulo/pasta inexistente */
        }
        if (!found) {
          try {
            const nestedVideo = fs.readdirSync(base, { withFileTypes: true })
              .find((entry) => entry.isFile() && /\.(?:mp4|ts|webm|mkv|mov)$/i.test(entry.name));
            if (nestedVideo) found = path.join(base, nestedVideo.name);
          } catch {
            /* pasta da aula inexistente */
          }
        }
      }

      if (!found && item.kind !== 'video') {
        try {
          const resource = fs.readdirSync(base, { withFileTypes: true })
            .find((entry) => entry.isFile() && allowedResource(entry.name, item.kind));
          if (resource) found = path.join(base, resource.name);
        } catch {
          /* pasta de recurso inexistente */
        }
      }

      if (found) break;
    }
    if (found) matches[item.key] = found;
  }

  return { ok: true, matches, root: path.resolve(downloadsRoot) };
}

function placeInFolder({ file, folderName }, downloadsRoot = path.join(os.homedir(), 'Downloads')) {
  if (!file || typeof file !== 'string') return { ok: false, error: 'arquivo ausente' };
  if (!folderName || typeof folderName !== 'string' || /[\\/:*?"<>|]/.test(folderName)) {
    return { ok: false, error: 'nome de pasta invalido' };
  }
  const root = path.resolve(downloadsRoot);
  const source = path.resolve(file);
  if (!source.startsWith(root + path.sep)) return { ok: false, error: 'arquivo fora de Downloads' };
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
    return { ok: false, error: 'arquivo nao encontrado' };
  }
  const parent = path.dirname(source);
  if (path.basename(parent).toLocaleLowerCase() === folderName.toLocaleLowerCase()) {
    return { ok: true, output: source, moved: false };
  }
  const directory = path.join(parent, folderName);
  fs.mkdirSync(directory, { recursive: true });
  let destination = path.join(directory, path.basename(source));
  if (fs.existsSync(destination)) {
    const ext = path.extname(destination);
    const base = destination.slice(0, -ext.length);
    let index = 1;
    while (fs.existsSync(destination)) destination = `${base} (${index++})${ext}`;
  }
  fs.renameSync(source, destination);
  return { ok: true, output: destination, moved: true };
}

/* ---------------------------------------------------------------- *
 * Uma mensagem por execucao: e assim que sendNativeMessage funciona.
 * ---------------------------------------------------------------- */

function ler(fd, tamanho) {
  const buffer = Buffer.alloc(tamanho);
  let lido = 0;
  while (lido < tamanho) {
    let n;
    try {
      n = fs.readSync(fd, buffer, lido, tamanho - lido, null);
    } catch (erro) {
      if (erro.code === 'EAGAIN') continue;
      if (erro.code === 'EOF') break;
      throw erro;
    }
    if (n === 0) break;
    lido += n;
  }
  return lido === tamanho ? buffer : null;
}

async function main() {
  const header = ler(0, 4);
  if (!header) return; // stdin fechou: nada a fazer

  const tamanho = header.readUInt32LE(0);
  if (tamanho === 0 || tamanho > MAX_MESSAGE) {
    return respond({ ok: false, error: `tamanho de mensagem invalido: ${tamanho}` });
  }

  const corpo = ler(0, tamanho);
  if (!corpo) return respond({ ok: false, error: 'mensagem incompleta' });

  let pedido;
  try {
    pedido = JSON.parse(corpo.toString('utf8'));
  } catch (erro) {
    return respond({ ok: false, error: `JSON invalido: ${erro.message}` });
  }

  if (pedido.action === 'ping') {
    return respond({ ok: true, pong: true, ffmpeg: findFfmpeg() });
  }
  if (pedido.action === 'remux') {
    return respond(remux(pedido));
  }
  if (pedido.action === 'download-media') {
    const result = await downloadMedia(pedido, undefined, (progress) => {
      respond({ type: 'download-progress', ...progress });
    });
    return respond({ type: 'download-complete', ...result });
  }
  if (pedido.action === 'exists') {
    return respond(fileExists(pedido.file));
  }
  if (pedido.action === 'find-remuxed') {
    return respond(findRemuxed(pedido.file));
  }
  if (pedido.action === 'find-remuxed-many') {
    return respond(findRemuxedMany(pedido.files));
  }
  if (pedido.action === 'find-course-files') {
    return respond(findCourseFiles(pedido.items));
  }
  if (pedido.action === 'place-in-folder') {
    return respond(placeInFolder(pedido));
  }
  return respond({ ok: false, error: `acao desconhecida: ${pedido.action}` });
}

if (require.main === module) {
  main().catch((erro) => {
    respond({ ok: false, error: `host falhou: ${erro.message}` });
  });
}

module.exports = {
  downloadMedia,
  findCourseFiles,
  placeInFolder,
  safeDownloadTarget,
  hlsDuration,
  normalizeMediaHeaders,
  selectBestHlsVariant
};
