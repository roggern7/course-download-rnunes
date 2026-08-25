/** Regras puras da fila, separadas para poderem ser verificadas sem o Chrome. */

/** Falhas de acesso ao arquivo podem ser refeitas pelo host nativo com Referer. */
export function isAuthorizationDownloadError(error) {
  return /\bHTTP\s+(?:401|403)\b/i.test(String(error || ''));
}

/** Conteudo protegido nao deve ser refeito em loop. */
export function isProtectedMediaError(error) {
  return /playlist criptografada|METHOD=(?:AES-128|SAMPLE-AES)|\bDRM\b/i.test(String(error || ''));
}

/** Marca a aula protegida e avanca somente um item, sem interromper a fila. */
export function autoSkipProtectedItem(batch, item, now = Date.now()) {
  if (!batch || item?.status !== 'error' || !isProtectedMediaError(item.error)) return false;
  item.status = 'protected';
  item.protectedReason = item.error;
  item.phase = null;
  item.skippedAt = now;
  batch.cursor++;
  return true;
}

/** Uma falha real nunca deve fazer o cursor consumir a aula seguinte. */
export function shouldStopBatchAfterItem(item) {
  return item?.status === 'error' || item?.status === 'skipped';
}

/** Marca a fila sem tocar no cursor, que continua apontando para a falha. */
export function stopBatchOnItemFailure(batch, item, now = Date.now()) {
  if (!batch || !shouldStopBatchAfterItem(item)) return false;
  batch.status = 'failed';
  batch.finishedAt = now;
  return true;
}
