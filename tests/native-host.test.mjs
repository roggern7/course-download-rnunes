import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  findCourseFiles,
  hlsDuration,
  normalizeMediaHeaders,
  placeInFolder,
  safeDownloadTarget,
  selectBestHlsVariant
} = require('../native/remux-host.js');

test('soma a duracao da playlist para calcular percentual', () => {
  assert.equal(hlsDuration('#EXTM3U\n#EXTINF:4.5,\na.ts\n#EXTINF:5.25,\nb.ts'), 9.75);
  assert.equal(hlsDuration('#EXTM3U\n#EXT-X-VERSION:3'), null);
});

test('repassa contexto do player sem cookies ou autorizacao', () => {
  assert.deepEqual(normalizeMediaHeaders({
    origin: 'https://cf-embed.play.hotmart.com',
    referer: 'https://cf-embed.play.hotmart.com/embed/123',
    'user-agent': 'Chrome Test',
    cookie: 'nao-pode-vazar',
    authorization: 'Bearer nao-pode-vazar'
  }), {
    origin: 'https://cf-embed.play.hotmart.com',
    referer: 'https://cf-embed.play.hotmart.com/embed/123',
    userAgent: 'Chrome Test'
  });
});

test('seleciona a maior variante da playlist HLS', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=450000,RESOLUTION=640x360',
    'low/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=1280x720',
    'hd/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=4200000,RESOLUTION=1920x1080',
    'full-hd/index.m3u8'
  ].join('\n');

  assert.deepEqual(
    selectBestHlsVariant(master, 'https://cdn.example/course/master.m3u8'),
    {
      width: 1920,
      height: 1080,
      bandwidth: 4200000,
      url: 'https://cdn.example/course/full-hd/index.m3u8'
    }
  );
});

test('preserva a faixa de audio separada da melhor variante', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="main-audio",URI="audio/track.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080,AUDIO="main-audio"',
    'video/1080.m3u8'
  ].join('\n');

  const selected = selectBestHlsVariant(master, 'https://cdn.example/master.m3u8');
  assert.equal(selected.url, 'https://cdn.example/video/1080.m3u8');
  assert.equal(selected.audioUrl, 'https://cdn.example/audio/track.m3u8');
});

test('aceita somente pastas relativas dentro de Downloads', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'course-downloader-target-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const target = safeDownloadTarget(root, 'Course Downloader RNUNES/Curso/01 - Aula');
  assert.equal(target, path.join(root, 'Course Downloader RNUNES', 'Curso', '01 - Aula'));
  assert.equal(safeDownloadTarget(root, '../fora'), null);
  assert.equal(safeDownloadTarget(root, path.resolve(root, 'absoluto')), null);
});

test('host recupera arquivos mesmo sem historico do Chrome', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'course-downloader-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const videoBase = 'Course Downloader RNUNES/Curso/01 - Modulo/01 - Aula';
  const oldVideoBase = 'Course Downloader RNUNES/Curso/07 - Modulo/09 - Aula';
  const textBase = 'Course Downloader RNUNES/Curso/02 - Extras/01 - Texto';
  const wrongBase = 'Course Downloader RNUNES/Curso/02 - Extras/02 - Video errado';
  fs.mkdirSync(path.join(root, path.dirname(oldVideoBase)), { recursive: true });
  fs.writeFileSync(path.join(root, `${oldVideoBase}.ts`), 'video');
  fs.mkdirSync(path.join(root, textBase), { recursive: true });
  fs.writeFileSync(path.join(root, textBase, 'Texto.txt'), 'texto');
  fs.mkdirSync(path.join(root, path.dirname(wrongBase)), { recursive: true });
  fs.writeFileSync(path.join(root, `${wrongBase}.htm`), 'html');

  const result = findCourseFiles([
    { key: 'video', bases: [videoBase], kind: 'video' },
    { key: 'texto', bases: [textBase], kind: 'text' },
    { key: 'errado', bases: [wrongBase], kind: 'video' }
  ], root);

  assert.equal(result.ok, true);
  assert.match(result.matches.video, /09 - Aula\.ts$/);
  assert.match(result.matches.texto, /Texto\.txt$/);
  assert.equal(result.matches.errado, undefined);
});

test('organiza o MP4 do bonus dentro da pasta 03', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'course-downloader-order-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, '11 - Extras da trilha', '03 - Call Ao Vivo Gravada.mp4');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, 'video');

  const result = placeInFolder({
    file: source,
    folderName: '03 - Call Ao Vivo Gravada'
  }, root);

  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.existsSync(path.join(
    root,
    '11 - Extras da trilha',
    '03 - Call Ao Vivo Gravada',
    '03 - Call Ao Vivo Gravada.mp4'
  )), true);
});
