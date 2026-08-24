import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPLETION_CONTROL_PATTERN,
  looksLikeCompletionControlText
} from '../navigation-policy.js';

test('rejeita rotulos de marcar e desmarcar aula concluida', () => {
  assert.equal(looksLikeCompletionControlText('Marcar como concluída'), true);
  assert.equal(looksLikeCompletionControlText('Aula concluída'), true);
  assert.equal(looksLikeCompletionControlText('Desmarcar aula'), true);
  assert.equal(looksLikeCompletionControlText('Marcar como assistido'), true);
  assert.equal(looksLikeCompletionControlText('lesson-complete'), true);
});

test('nao confunde o titulo normal da aula com controle de conclusao', () => {
  assert.equal(looksLikeCompletionControlText('START - O COMEÇO DA SUA JORNADA'), false);
  assert.equal(looksLikeCompletionControlText('MÃO NA MASSA (CRIANDO O CANAL)'), false);
  assert.doesNotThrow(() => new RegExp(COMPLETION_CONTROL_PATTERN, 'i'));
});
