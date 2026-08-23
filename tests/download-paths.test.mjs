import test from 'node:test';
import assert from 'node:assert/strict';

import { downloadMatchesKind, downloadMatchesLesson } from '../download-paths.js';

const lesson = 'Course Downloader RNUNES/Agentes De Ia Na Pratica V2/01 - Introducao/01 - Navegue pelas aulas';

test('reconhece aula salva na raiz atual e na raiz antiga', () => {
  assert.equal(downloadMatchesLesson(
    'C:\\Users\\Test User\\Downloads\\Course Downloader RNUNES\\Agentes De Ia Na Pratica V2\\01 - Introducao\\01 - Navegue pelas aulas.mp4',
    lesson,
    { videoOnly: true }
  ), true);
  assert.equal(downloadMatchesLesson(
    'C:\\Users\\Test User\\Downloads\\Agentes De Ia Na Pratica V2\\01 - Introducao\\01 - Navegue pelas aulas.mp4',
    lesson,
    { videoOnly: true }
  ), true);
});

test('bonus de video ignora o HTML errado e aceita MP4', () => {
  const bonus = 'Course Downloader RNUNES/Agentes De Ia Na Pratica V2/11 - Extras da trilha/03 - Call Ao Vivo Gravada';
  const html = 'C:\\Users\\Test User\\Downloads\\Agentes De Ia Na Pratica V2\\11 - Extras da trilha\\03 - Call Ao Vivo Gravada.htm';
  const mp4 = 'C:\\Users\\Test User\\Downloads\\Course Downloader RNUNES\\Agentes De Ia Na Pratica V2\\11 - Extras da trilha\\03 - Call Ao Vivo Gravada.mp4';

  assert.equal(downloadMatchesLesson(html, bonus, { videoOnly: true }), false);
  assert.equal(downloadMatchesKind(html, 'video'), false);
  assert.equal(downloadMatchesLesson(mp4, bonus, { videoOnly: true }), true);
  assert.equal(downloadMatchesKind(mp4, 'video'), true);
  assert.equal(downloadMatchesLesson(
    'C:\\Users\\Test User\\Downloads\\Course Downloader RNUNES\\Agentes De Ia Na Pratica V2\\11 - Extras da trilha\\03 - Call Ao Vivo Gravada\\03 - Call Ao Vivo Gravada.mp4',
    bonus,
    { videoOnly: true }
  ), true);
});

test('bonus de texto reconhece arquivo dentro da pasta antiga', () => {
  const bonus = 'Course Downloader RNUNES/Agentes De Ia Na Pratica V2/11 - Extras da trilha/02 - Biblioteca de 100 Nichos Lucrativos';
  const txt = 'C:\\Users\\Test User\\Downloads\\Agentes De Ia Na Pratica V2\\11 - Extras da trilha\\02 - Biblioteca de 100 Nichos Lucrativos\\Biblioteca de 100 Nichos Lucrativos.txt';
  assert.equal(downloadMatchesLesson(txt, bonus), true);
  assert.equal(downloadMatchesKind(txt, 'text'), true);
});
