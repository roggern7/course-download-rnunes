import test from 'node:test';
import assert from 'node:assert/strict';

import {
  autoSkipProtectedItem,
  isExplicitEmptyLessonText,
  isAuthorizationDownloadError,
  isProtectedMediaError,
  shouldStopBatchAfterItem,
  stopBatchOnItemFailure
} from '../batch-policy.js';

test('reconhece playlist protegida que deve ser ignorada automaticamente', () => {
  assert.equal(isProtectedMediaError('Playlist criptografada (METHOD=AES-128).'), true);
  assert.equal(isProtectedMediaError('Playlist criptografada (METHOD=SAMPLE-AES).'), true);
  assert.equal(isProtectedMediaError('HTTP 403 em master.m3u8'), false);
});

test('pula automaticamente uma aula protegida e avanca somente uma posicao', () => {
  const batch = { status: 'running', cursor: 4 };
  const item = {
    status: 'error',
    phase: 'Baixando',
    error: 'Playlist criptografada (METHOD=AES-128).'
  };

  assert.equal(autoSkipProtectedItem(batch, item, 1234), true);
  assert.equal(batch.cursor, 5);
  assert.deepEqual(item, {
    status: 'protected',
    phase: null,
    error: 'Playlist criptografada (METHOD=AES-128).',
    protectedReason: 'Playlist criptografada (METHOD=AES-128).',
    skippedAt: 1234
  });
  assert.equal(autoSkipProtectedItem(batch, item, 5678), false);
  assert.equal(batch.cursor, 5);
});

test('reconhece somente avisos explicitos de aula vazia', () => {
  assert.equal(isExplicitEmptyLessonText('Nenhum conteúdo ainda...'), true);
  assert.equal(isExplicitEmptyLessonText('Este conteúdo ainda está vazio.'), true);
  assert.equal(isExplicitEmptyLessonText('No content yet...'), true);
  assert.equal(isExplicitEmptyLessonText('Procurando o vídeo...'), false);
  assert.equal(isExplicitEmptyLessonText('sem URL de vídeo detectada'), false);
});

test('reconhece 401 e 403 como falhas que aceitam fallback com Referer', () => {
  assert.equal(isAuthorizationDownloadError('HTTP 403 em master.m3u8'), true);
  assert.equal(isAuthorizationDownloadError('HTTP 401 ao ler a playlist'), true);
  assert.equal(isAuthorizationDownloadError('HTTP 404 em master.m3u8'), false);
});

test('interrompe a fila em erro ou video nao detectado', () => {
  assert.equal(shouldStopBatchAfterItem({ status: 'error' }), true);
  assert.equal(shouldStopBatchAfterItem({ status: 'skipped' }), true);
  assert.equal(shouldStopBatchAfterItem({ status: 'done' }), false);
  assert.equal(shouldStopBatchAfterItem({ status: 'locked' }), false);
});

test('mantem o cursor exatamente na aula que falhou', () => {
  const batch = { status: 'running', cursor: 7 };
  assert.equal(stopBatchOnItemFailure(batch, { status: 'error' }, 1234), true);
  assert.deepEqual(batch, { status: 'failed', cursor: 7, finishedAt: 1234 });
});
