import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isAuthorizationDownloadError,
  shouldStopBatchAfterItem,
  stopBatchOnItemFailure
} from '../batch-policy.js';

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
