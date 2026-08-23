import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findCourseFiles, placeInFolder } = require('../native/remux-host.js');

test('host recupera arquivos mesmo sem historico do Chrome', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'course-downloader-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const videoBase = 'Course Downloader RNUNES/Curso/01 - Modulo/01 - Aula';
  const textBase = 'Course Downloader RNUNES/Curso/02 - Extras/01 - Texto';
  const wrongBase = 'Course Downloader RNUNES/Curso/02 - Extras/02 - Video errado';
  fs.mkdirSync(path.join(root, path.dirname(videoBase)), { recursive: true });
  fs.writeFileSync(path.join(root, `${videoBase}.ts`), 'video');
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
  assert.match(result.matches.video, /01 - Aula\.ts$/);
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
