export const DOWNLOAD_ROOT = 'Course Downloader RNUNES';

export function normalizeDownloadPath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .normalize('NFC')
    .toLocaleLowerCase('pt-BR');
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function comparablePathPart(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/^\d+\s*-\s*/, '')
    .replace(/ \(\d+\)$/, '')
    .trim()
    .toLocaleLowerCase('pt-BR');
}

function compatibleCourseName(actual, expected) {
  const left = comparablePathPart(actual);
  const right = comparablePathPart(expected);
  return Boolean(left && right) && (
    left === right ||
    (right.length >= 6 && left.includes(right)) ||
    (left.length >= 6 && right.includes(left))
  );
}

/**
 * Alguns portais mudam o titulo do curso e, durante a transicao, expõem uma
 * pasta intermediaria como "Alterar nome para <novo titulo>". Reconhece a
 * aula pelo par estavel Modulo/Aula, mas exige que uma pasta ancestral ainda
 * identifique o curso para nao misturar cursos diferentes.
 */
function matchesRenamedCourse(downloadPath, lessonPath, videoOnly) {
  const expected = normalizeDownloadPath(lessonPath).split('/').filter(Boolean);
  if (expected.length < 3) return false;
  const expectedCourse = expected.at(-3);
  const expectedModule = comparablePathPart(expected.at(-2));
  const expectedLesson = comparablePathPart(expected.at(-1));

  const parts = normalizeDownloadPath(downloadPath).split('/').filter(Boolean);
  const leaf = parts.at(-1) || '';
  const leafWithoutExtension = leaf.replace(/\.[^.]+$/, '');
  const possibleLessonIndexes = [];
  if (comparablePathPart(leafWithoutExtension) === expectedLesson) {
    possibleLessonIndexes.push(parts.length - 1);
  }
  // Videos e recursos antigos tambem podem ficar dentro de uma pasta da aula.
  if (parts.length >= 2 && comparablePathPart(parts.at(-2)) === expectedLesson) {
    possibleLessonIndexes.push(parts.length - 2);
  }

  return possibleLessonIndexes.some((lessonIndex) => {
    const moduleIndex = lessonIndex - 1;
    if (moduleIndex < 1 || comparablePathPart(parts[moduleIndex]) !== expectedModule) return false;
    if (videoOnly && !/\.(?:mp4|ts|webm|mkv|mov)$/i.test(leaf)) return false;
    return parts.slice(0, moduleIndex).some((part) =>
      compatibleCourseName(part, expectedCourse)
    );
  });
}

/**
 * A versao antiga salvava em Downloads/Curso; a atual usa
 * Downloads/Course Downloader RNUNES/Curso. Os dois caminhos representam a
 * mesma aula no popup.
 */
export function lessonDownloadBases(lessonPath) {
  const normalized = normalizeDownloadPath(lessonPath);
  const root = `${normalizeDownloadPath(DOWNLOAD_ROOT)}/`;
  const legacy = normalized.startsWith(root) ? normalized.slice(root.length) : normalized;
  const bases = [normalized, legacy].filter(Boolean);
  const compatible = [];

  for (const base of bases) {
    const parts = base.split('/');
    const moduleAt = parts.length - 2;
    const lessonAt = parts.length - 1;
    const withoutNumber = (value) => String(value || '').replace(/^\d+\s*-\s*/, '');
    const moduleTitle = withoutNumber(parts[moduleAt]);
    const lessonTitle = withoutNumber(parts[lessonAt]);

    // Versões anteriores não numeravam a pasta do módulo e algumas também
    // não numeravam a pasta/arquivo da aula. Aceita todas as combinações ao
    // reconciliar, sem alterar o caminho usado nos downloads novos.
    for (const useRawModule of [false, true]) {
      for (const useRawLesson of [false, true]) {
        const variant = [...parts];
        if (moduleAt >= 0 && useRawModule) variant[moduleAt] = moduleTitle;
        if (lessonAt >= 0 && useRawLesson) variant[lessonAt] = lessonTitle;
        compatible.push(variant.join('/'));
      }
    }
  }

  return [...new Set(compatible)].filter(Boolean);
}

export function downloadMatchesKind(downloadPath, kind) {
  const path = normalizeDownloadPath(downloadPath);
  if (kind === 'video') return /\.(?:mp4|ts|webm|mkv|mov)$/i.test(path);
  if (kind === 'file') return /\.(?:docx?|pdf|xlsx?|pptx?|zip|rar|7z)$/i.test(path);
  if (kind === 'text') return /\.(?:txt|md)$/i.test(path);
  return true;
}

export function downloadMatchesLesson(downloadPath, lessonPath, { videoOnly = false } = {}) {
  const path = normalizeDownloadPath(downloadPath);
  const regularMatch = lessonDownloadBases(lessonPath).some((base) => {
    const escaped = escapeRegex(base);
    const video = new RegExp(
      `(?:^|/)${escaped}(?: \\(\\d+\\))?\\.(?:mp4|ts|webm|mkv|mov)$`,
      'i'
    );
    if (video.test(path)) return true;
    if (videoOnly) {
      if (new RegExp(`(?:^|/)${escaped}/[^/]+\\.(?:mp4|ts|webm|mkv|mov)$`, 'i').test(path)) {
        return true;
      }
    } else if (new RegExp(`(?:^|/)${escaped}/`, 'i').test(path)) {
      return true;
    }

    // A ordem retornada pela SPA pode mudar conforme o módulo atualmente
    // aberto. O índice organiza a pasta, mas não identifica a aula.
    const parts = base.split('/');
    if (parts.length < 3) return false;
    const rawModule = parts.at(-2).replace(/^\d+\s*-\s*/, '');
    const rawLesson = parts.at(-1).replace(/^\d+\s*-\s*/, '');
    const parent = parts.slice(0, -2).map(escapeRegex).join('/');
    const flexibleBase = [
      parent,
      `(?:\\d+\\s*-\\s*)?${escapeRegex(rawModule)}`,
      `(?:\\d+\\s*-\\s*)?${escapeRegex(rawLesson)}`
    ].join('/');
    const direct = new RegExp(
      `(?:^|/)${flexibleBase}(?: \\(\\d+\\))?\\.(?:mp4|ts|webm|mkv|mov)$`,
      'i'
    );
    if (direct.test(path)) return true;
    if (videoOnly) {
      return new RegExp(
        `(?:^|/)${flexibleBase}/[^/]+\\.(?:mp4|ts|webm|mkv|mov)$`,
        'i'
      ).test(path);
    }
    return new RegExp(`(?:^|/)${flexibleBase}/`, 'i').test(path);
  });
  return regularMatch || matchesRenamedCourse(path, lessonPath, videoOnly);
}

/**
 * O caminho da aula termina no nome do arquivo, nao em outra pasta:
 * Curso/Modulo/01 - Aula.mp4.
 */
export function nativeVideoTarget(lessonPath) {
  const parts = String(lessonPath || '').replace(/\\/g, '/').split('/').filter(Boolean);
  const lessonName = parts.pop() || 'Video';
  return {
    directory: parts.join('/'),
    filename: `${lessonName}.mp4`
  };
}
