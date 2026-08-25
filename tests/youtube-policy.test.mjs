import test from 'node:test';
import assert from 'node:assert/strict';

import {
  googleVideoKind,
  isGoogleVideoUrl,
  selectGoogleVideoPair,
  youtubeUrlFromDiagnostics
} from '../youtube-policy.js';

const google = (kind, itag, size = '') =>
  `https://rr1---sn.example.googlevideo.com/videoplayback?mime=${kind}%2Fmp4&itag=${itag}${size ? `&size=${size}` : ''}`;

test('reconhece as faixas adaptativas do YouTube', () => {
  assert.equal(isGoogleVideoUrl(google('video', '137')), true);
  assert.equal(googleVideoKind(google('video', '137')), 'video');
  assert.equal(googleVideoKind(google('audio', '140')), 'audio');
});

test('escolhe o maior video e anexa a faixa de audio', () => {
  const audio = google('audio', '140');
  const selected = selectGoogleVideoPair([
    { url: google('video', '136', '1280x720'), height: 720 },
    { url: google('video', '137', '1920x1080'), height: 1080 },
    { url: audio, height: 0 }
  ]);
  assert.equal(selected.height, 1080);
  assert.equal(selected.audioUrl, audio);
  assert.equal(selected.youtube, true);
});

test('nao aceita video adaptativo sem audio', () => {
  const selected = selectGoogleVideoPair([
    { url: google('video', '137', '1920x1080'), height: 1080 }
  ]);
  assert.equal(selected, null);
});

test('aceita formato progressivo que ja contem audio', () => {
  const selected = selectGoogleVideoPair([
    { url: google('video', '22', '1280x720'), height: 720 }
  ]);
  assert.equal(selected.audioUrl, null);
});

test('recupera a URL do iframe incorporado do YouTube', () => {
  const url = youtubeUrlFromDiagnostics([
    { iframeUrls: ['https://www.youtube.com/embed/abcDEF_1234?rel=0'] }
  ]);
  assert.equal(url, 'https://www.youtube.com/embed/abcDEF_1234?rel=0');
});
