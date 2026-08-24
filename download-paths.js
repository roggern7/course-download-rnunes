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

/**
 * A versao antiga salvava em Downloads/Curso; a atual usa
 * Downloads/Course Downloader RNUNES/Curso. Os dois caminhos representam a
 * mesma aula no popup.
 */
export function lessonDownloadBases(lessonPath) {
  const normalized = normalizeDownloadPath(lessonPath);
  const root = `${normalizeDownloadPath(DOWNLOAD_ROOT)}/`;
  const legacy = normalized.startsWith(root) ? normalized.slice(root.length) : normalized;
  return [...new Set([normalized, legacy])].filter(Boolean);
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
  return lessonDownloadBases(lessonPath).some((base) => {
    const escaped = escapeRegex(base);
    const video = new RegExp(
      `(?:^|/)${escaped}(?: \\(\\d+\\))?\\.(?:mp4|ts|webm|mkv|mov)$`,
      'i'
    );
    if (video.test(path)) return true;
    if (videoOnly) {
      return new RegExp(`(?:^|/)${escaped}/[^/]+\\.(?:mp4|ts|webm|mkv|mov)$`, 'i').test(path);
    }
    return new RegExp(`(?:^|/)${escaped}/`, 'i').test(path);
  });
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
