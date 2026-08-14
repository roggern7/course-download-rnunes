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
 *   { "action": "ping" }
 *
 * Resposta:
 *   { "ok": true, "output": "C:\\...\\aula.mp4", "ms": 1234 }
 *   { "ok": false, "error": "..." }
 *
 * Nao acessa a rede e so toca no arquivo indicado.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MAX_MESSAGE = 64 * 1024 * 1024;
const FFMPEG_TIMEOUT_MS = 15 * 60 * 1000;

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
  return respond({ ok: false, error: `acao desconhecida: ${pedido.action}` });
}

try {
  main();
} catch (erro) {
  respond({ ok: false, error: `host falhou: ${erro.message}` });
}
