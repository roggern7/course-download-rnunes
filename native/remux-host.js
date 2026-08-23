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
 *   { "action": "download-media", "url": "https://.../manifest.mpd", "marker": "C:\\...\\.destino.tmp", "name": "Video.mp4" }
 *   { "action": "ping" }
 *
 * Resposta:
 *   { "ok": true, "output": "C:\\...\\aula.mp4", "ms": 1234 }
 *   { "ok": false, "error": "..." }
 *
 * A acao download-media acessa somente a URL recebida e grava o resultado na
 * pasta do marcador criado pelo Chrome. As demais acoes continuam locais.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

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

function downloadMedia({ url, marker, name, referer }) {
  if (!url || typeof url !== 'string') return { ok: false, error: 'URL de mídia ausente' };
  let parsed;
  try { parsed = new URL(url); } catch { return { ok: false, error: 'URL de mídia inválida' }; }
  if (!/^https?:$/.test(parsed.protocol)) return { ok: false, error: 'protocolo de mídia não permitido' };
  if (!marker || typeof marker !== 'string') return { ok: false, error: 'arquivo marcador ausente' };
  if (!fs.existsSync(marker) || !fs.statSync(marker).isFile()) {
    return { ok: false, error: `arquivo marcador não encontrado: ${marker}` };
  }

  const ffmpeg = findFfmpeg();
  if (!ffmpeg) {
    try { fs.unlinkSync(marker); } catch { /* marcador sem importância */ }
    return { ok: false, error: 'FFmpeg não encontrado. Instale com: winget install Gyan.FFmpeg' };
  }

  const directory = path.dirname(path.resolve(marker));
  const safeName = nomeSeguro(name);
  const base = path.join(directory, safeName.replace(/\.mp4$/i, ''));
  const output = nomeLivre(base);
  const startedAt = Date.now();
  const inputArgs = [];
  if (referer && typeof referer === 'string') {
    try {
      const parsedReferer = new URL(referer);
      if (/^https?:$/.test(parsedReferer.protocol)) {
        inputArgs.push('-headers', `Referer: ${parsedReferer.href}\r\n`);
      }
    } catch {
      /* referer opcional e invalido */
    }
  }

  try {
    execFileSync(
      ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-y',
       ...inputArgs,
       '-i', parsed.href,
       '-map', '0:v:0?', '-map', '0:a:0?',
       '-c', 'copy', '-movflags', '+faststart',
       output],
      { timeout: MEDIA_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024 }
    );
  } catch (error) {
    try { if (fs.existsSync(output)) fs.unlinkSync(output); } catch { /* ignora */ }
    const detail = (error.stderr && error.stderr.toString().trim().split('\n').pop()) || error.message;
    return { ok: false, error: `ffmpeg não conseguiu baixar o vídeo: ${detail}` };
  } finally {
    try { if (fs.existsSync(marker)) fs.unlinkSync(marker); } catch { /* marcador sem importância */ }
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

function main() {
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
    return respond(downloadMedia(pedido));
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
  try {
    main();
  } catch (erro) {
    respond({ ok: false, error: `host falhou: ${erro.message}` });
  }
}

module.exports = { findCourseFiles, placeInFolder };
