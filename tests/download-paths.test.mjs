import test from 'node:test';
import assert from 'node:assert/strict';

import {
  downloadMatchesKind,
  downloadMatchesLesson,
  nativeVideoTarget
} from '../download-paths.js';

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

test('reconhece download antigo sem numeração na pasta do módulo', () => {
  const current = 'Course Downloader RNUNES/MDA Academy/01 - DOMINANDO AS FERRAMENTAS/01 - Aula 0 - Introdução';
  const oldNested = 'C:\\Users\\Test User\\Downloads\\Course Downloader RNUNES\\MDA Academy\\07 - DOMINANDO AS FERRAMENTAS\\09 - Aula 0 - Introdução\\Aula 0 - Introdução.mp4';
  const oldDirect = 'C:\\Users\\Test User\\Downloads\\Course Downloader RNUNES\\MDA Academy\\07 - DOMINANDO AS FERRAMENTAS\\09 - Aula 0 - Introdução.mp4';

  assert.equal(downloadMatchesLesson(oldNested, current, { videoOnly: true }), true);
  assert.equal(downloadMatchesLesson(oldDirect, current, { videoOnly: true }), true);
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

test('salva o video diretamente dentro do modulo', () => {
  assert.deepEqual(nativeVideoTarget(
    'Course Downloader RNUNES/MDA Academy/99% dos canais Dark/01 - Aula 0 - Introducao'
  ), {
    directory: 'Course Downloader RNUNES/MDA Academy/99% dos canais Dark',
    filename: '01 - Aula 0 - Introducao.mp4'
  });
});

test('reconhece aula depois que o portal renomeia o curso', () => {
  const current = 'Course Downloader RNUNES/Fórmula Youtube 2026/Introdução ao YouTube/01 - Introdução ao Treinamento';
  const old = 'C:\\Users\\Test User\\Downloads\\Course Downloader RNUNES\\Peter Jordan 2026\\Alterar nome para Formula Youtube 2026\\01 - Introdução ao YouTube\\01 - Introdução ao Treinamento.ts';

  assert.equal(downloadMatchesLesson(old, current, { videoOnly: true }), true);
});
