/** Texto que identifica controles que alteram a conclusao, nao a navegacao. */
export const COMPLETION_CONTROL_PATTERN = [
  '(?:aula\\s+)?conclu(?:ir|[ií]d[ao]s?)',
  'marcar\\s+(?:como\\s+)?conclu',
  'desmarcar(?:\\s+aula)?',
  'assistid[ao]s?',
  '(?:mark|unmark).*(?:complete|done)',
  'lesson[-_ ]?(?:complete|done)',
  'completion[-_ ]?(?:toggle|check)',
  'checkbox',
  'check[-_ ]?circle|circle[-_ ]?check'
].join('|');

export function looksLikeCompletionControlText(value) {
  return new RegExp(COMPLETION_CONTROL_PATTERN, 'i').test(String(value || ''));
}
