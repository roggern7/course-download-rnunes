/**
 * Course Downloader RNUNES - popup
 *
 * Tres visoes:
 *  - Esta aba: playlists detectadas na aba atual (download avulso);
 *  - Curso:    aulas do curso, por modulo (download em lote);
 *  - Todas:    o que foi detectado em cada aba.
 *
 * Um unico painel de atividade cobre tanto a fila quanto o download avulso,
 * com uma barra so. A logica de dados vive no service worker; aqui e so vista.
 */

import { formatBytes, formatDuration } from './hls.js';

const $ = (id) => document.getElementById(id);

const listEl = $('list');
const tabTitleEl = $('tab-title');
const clearBtn = $('clear');
const segCurrent = $('view-current');
const segCourse = $('view-course');
const segAll = $('view-all');
const countCurrentEl = $('count-current');
const countCourseEl = $('count-course');
const countAllEl = $('count-all');

const itemTpl = $('tpl-item');
const moduleTpl = $('tpl-module');
const lessonTpl = $('tpl-lesson');

const activityEl = $('activity');
const activityTitleEl = $('activity-title');
const activityBarEl = $('activity-bar');
const activityMetaEl = $('activity-meta');
const activityNoteEl = $('activity-note');
const activityFileEl = $('activity-file');
const activityPathEl = $('activity-path');
const activityShowEl = $('activity-show');
const activityCloseEl = $('activity-close');
const batchPauseEl = $('batch-pause');
const batchRetryEl = $('batch-retry');

const courseBarEl = $('course-bar');
const selectAllBtn = $('select-all');
const selectNoneBtn = $('select-none');
const rescanBtn = $('rescan');
const forgetBtn = $('forget');
const downloadSelectedBtn = $('download-selected');

let view = 'current';
let currentTab = null;
let data = { current: [], all: {}, job: null, batch: null, completed: {} };
let refreshTimer = null;

/** Playlists mestras ja lidas: url -> variantes. */
const probes = new Map();
const probing = new Set();

let course = null;
let courseError = null;
let scanning = false;
let cachedScan = false;
let selected = new Set();
/** Modulos expandidos, por indice. Fechados por padrao: 20 modulos abertos
 *  transformariam a lista em uma parede de 92 linhas. */
const openModules = new Set();

/* ------------------------------------------------------------------ */

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(response);
    });
  });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function sortStreams(list) {
  return [...list].sort((a, b) => {
    const ha = a.height || 0;
    const hb = b.height || 0;
    if (ha !== hb) return hb - ha;
    return a.detectedAt - b.detectedAt;
  });
}

const batchActive = () =>
  Boolean(data.batch && (data.batch.status === 'running' || data.batch.status === 'paused'));
const jobRunning = () => Boolean(data.job && data.job.status === 'running');
const busy = () => batchActive() || jobRunning();

const plural = (n, um, muitos) => `${n} ${n === 1 ? um : muitos}`;

/** "agora", "ha 5 min", "ontem" - para julgar se o scan esta velho. */
function desde(timestamp) {
  const min = Math.round((Date.now() - timestamp) / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `ha ${min} min`;
  const horas = Math.round(min / 60);
  if (horas < 24) return `ha ${horas}h`;
  const dias = Math.round(horas / 24);
  return dias === 1 ? 'ontem' : `ha ${dias} dias`;
}

/* ------------------------------------------------------------------ *
 * Painel de atividade (fila OU download avulso)
 * ------------------------------------------------------------------ */

function setNote(text, kind) {
  activityNoteEl.hidden = !text;
  activityNoteEl.textContent = text || '';
  if (text) activityNoteEl.dataset.kind = kind || 'info';
}

function setFile(job) {
  const path = job && (job.savedPath || job.relativePath);
  const mostrar = Boolean(path) && (job.status === 'done' || job.exists === false);
  activityFileEl.hidden = !mostrar;
  if (mostrar) {
    activityPathEl.textContent = path;
    activityPathEl.title = path;
    activityShowEl.disabled = !job.downloadId;
  }
}

function setBar(percent, indeterminado) {
  activityBarEl.style.width = `${percent}%`;
  activityBarEl.classList.toggle('indeterminate', Boolean(indeterminado));
  activityEl.querySelector('.bar').setAttribute('aria-valuenow', String(percent));
}

function contarFila(batch) {
  const counts = { done: 0, exists: 0, skipped: 0, error: 0 };
  for (const item of batch.items) {
    if (counts[item.status] !== undefined) counts[item.status]++;
  }
  counts.total = batch.items.length;
  counts.settled = counts.done + counts.exists + counts.skipped + counts.error;
  counts.percent = counts.total ? Math.round((counts.settled / counts.total) * 100) : 0;
  return counts;
}

function resumoFila(c) {
  const partes = [plural(c.done, 'baixada', 'baixadas')];
  if (c.exists) partes.push(`${c.exists} ja baixadas`);
  if (c.skipped) partes.push(`${c.skipped} sem video`);
  if (c.error) partes.push(`${c.error} com erro`);
  return partes.join(' · ');
}

function renderFila(batch, job) {
  const c = contarFila(batch);
  const rodando = batch.status === 'running';
  const pausada = batch.status === 'paused';
  const terminada = !rodando && !pausada;
  const atual = batch.items[batch.cursor];

  if (rodando && atual) {
    activityTitleEl.textContent = `Aula ${batch.cursor + 1} de ${c.total}`;
    activityTitleEl.title = atual.title;
    activityEl.dataset.tone = 'queue';
  } else if (pausada) {
    activityTitleEl.textContent = `Pausada · ${c.settled} de ${c.total}`;
    activityEl.dataset.tone = 'idle';
  } else if (batch.status === 'canceled') {
    activityTitleEl.textContent = `Cancelada · ${c.settled} de ${c.total}`;
    activityEl.dataset.tone = 'idle';
  } else {
    activityTitleEl.textContent = `Fila concluida · ${plural(c.total, 'aula', 'aulas')}`;
    activityEl.dataset.tone = c.error ? 'warn' : 'ok';
  }

  setBar(c.percent, false);

  // Uma barra so: o andamento da aula atual vira texto, nao uma segunda barra.
  if (rodando && atual) {
    const detalhes = [atual.title];
    if (job && job.status === 'running') {
      if (job.total) detalhes.push(`${Math.round((job.current / job.total) * 100)}%`);
      if (job.receivedBytes) detalhes.push(formatBytes(job.receivedBytes));
      else if (atual.phase) detalhes.push(atual.phase);
    } else if (atual.phase) {
      detalhes.push(atual.phase);
    }
    activityMetaEl.textContent = detalhes.join(' · ');
    activityMetaEl.title = atual.title;
  } else {
    activityMetaEl.textContent = resumoFila(c);
    activityMetaEl.title = '';
  }

  if (terminada) {
    const total = `${plural(c.total, 'aula', 'aulas')}: ${resumoFila(c)}.`;
    if (c.error) setNote(`${total} Use "Tentar novamente" para refazer so as que falharam.`, 'warn');
    else setNote(total, 'ok');
  } else {
    setNote('', null);
  }

  setFile(null);
  batchPauseEl.hidden = terminada;
  batchPauseEl.textContent = pausada ? 'Continuar' : 'Pausar';
  const repetiveis = c.error + c.skipped;
  batchRetryEl.hidden = !(terminada && repetiveis);
  batchRetryEl.textContent = `Tentar novamente (${repetiveis})`;
  activityCloseEl.textContent = terminada ? 'Fechar' : 'Cancelar';
}

function renderAvulso(job) {
  const percent = job.total ? Math.round((job.current / job.total) * 100) : 0;
  const rodando = job.status === 'running';

  if (rodando) {
    activityTitleEl.textContent = job.phase || 'Baixando…';
    activityEl.dataset.tone = 'queue';
  } else if (job.status === 'done') {
    activityTitleEl.textContent = 'Aula baixada';
    activityEl.dataset.tone = 'ok';
  } else if (job.status === 'canceled') {
    activityTitleEl.textContent = 'Download cancelado';
    activityEl.dataset.tone = 'idle';
  } else {
    activityTitleEl.textContent = 'O download falhou';
    activityEl.dataset.tone = 'error';
  }
  activityTitleEl.title = job.title || '';

  setBar(job.status === 'done' ? 100 : percent, rodando && !job.total);

  const meta = [];
  if (job.quality) meta.push(job.quality);
  if (job.duration) meta.push(formatDuration(job.duration));
  if (job.receivedBytes) meta.push(formatBytes(job.receivedBytes));
  if (job.total && rodando) meta.push(`${percent}%`);
  activityMetaEl.textContent = meta.join(' · ');
  activityMetaEl.title = '';

  if (job.error) {
    setNote(job.error, 'error');
  } else if (job.status === 'done' && job.container === 'ts') {
    setNote(
      'Arquivo em MPEG-TS. Arraste-o (ou a pasta do curso) para tools/remux.bat ' +
        'para virar MP4 sem recodificar — ou instale a conversao automatica com ' +
        'tools/instalar-auto-mp4.ps1.',
      'warn'
    );
  } else if (job.status === 'done' && job.remuxed) {
    setNote('Convertido para MP4 automaticamente.', 'ok');
  } else {
    setNote('', null);
  }

  setFile(job);
  batchPauseEl.hidden = true;
  batchRetryEl.hidden = true;
  activityCloseEl.textContent = rodando ? 'Cancelar' : 'Fechar';
}

function renderActivity() {
  if (!data.batch && !data.job) {
    activityEl.hidden = true;
    return;
  }
  activityEl.hidden = false;
  if (data.batch) renderFila(data.batch, data.job);
  else renderAvulso(data.job);
}

/* ------------------------------------------------------------------ *
 * Visao "Esta aba" / "Todas"
 * ------------------------------------------------------------------ */

async function probe(url) {
  if (probes.has(url) || probing.has(url)) return;
  probing.add(url);
  const result = await send({ type: 'probe-master', url });
  probing.delete(url);
  if (result) {
    probes.set(url, result);
    render(true);
  }
}

function qualityText(url) {
  const result = probes.get(url);
  if (!result) return 'lendo qualidades…';
  if (result.error) return `nao consegui ler: ${result.error}`;
  if (result.single) return 'playlist unica, sem variantes';
  if (!result.best) return 'nenhuma variante encontrada';

  const mbps = result.best.bandwidth
    ? ` · ${(result.best.bandwidth / 1_000_000).toFixed(1)} Mbps`
    : '';
  return `${result.variants.length} qualidades · melhor ${result.best.label}${mbps}`;
}

function buildItem(stream, { downloadable }) {
  const node = itemTpl.content.firstElementChild.cloneNode(true);

  const nameEl = node.querySelector('.name');
  nameEl.textContent = stream.name;
  nameEl.title = stream.name;

  const urlEl = node.querySelector('.url');
  urlEl.textContent = stream.url;
  urlEl.title = stream.url;

  const badges = node.querySelector('.badges');
  const probed = probes.get(stream.url);
  const bestLabel = probed && probed.best ? probed.best.label : stream.resolution;

  if (bestLabel) {
    const tag = document.createElement('span');
    tag.className = 'tag tag-res';
    tag.textContent = bestLabel;
    badges.appendChild(tag);
  }
  if (stream.master) {
    const tag = document.createElement('span');
    tag.className = 'tag tag-master';
    tag.textContent = 'master';
    tag.title = 'Playlist mestra: lista varias qualidades';
    badges.appendChild(tag);
  }

  node.querySelector('.quality').textContent = stream.format === 'file'
    ? `${stream.host} · arquivo MP4`
    : `${stream.host} · ${qualityText(stream.url)}`;
  if (stream.format !== 'file') probe(stream.url);

  const copyBtn = node.querySelector('.btn-copy');
  copyBtn.addEventListener('click', () => copyUrl(stream.url, copyBtn));

  const downloadBtn = node.querySelector('.btn-download');
  downloadBtn.disabled = !downloadable || busy();
  if (!downloadable) downloadBtn.title = 'Abra a aba correspondente para baixar esta aula.';
  else if (busy()) downloadBtn.title = 'Ja existe um download em andamento.';
  downloadBtn.addEventListener('click', () => startDownload(stream));

  return node;
}

async function copyUrl(url, button) {
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = url;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }

  const original = button.textContent;
  button.textContent = 'Copiado!';
  button.classList.add('copied');
  setTimeout(() => {
    button.textContent = original;
    button.classList.remove('copied');
  }, 1300);
}

async function startDownload(stream) {
  if (!currentTab) return;
  const response = await send({
    type: 'start-download',
    tabId: currentTab.id,
    url: stream.url,
    format: stream.format || 'hls'
  });
  if (response && response.ok === false) {
    activityEl.hidden = false;
    setNote(response.error, 'error');
  }
  await refresh();
}

/* ------------------------------------------------------------------ *
 * Visao "Curso"
 * ------------------------------------------------------------------ */

function courseCoversTab() {
  if (!course || !course.prefix || !currentTab) return false;
  try {
    const url = new URL(currentTab.url);
    return course.origin === url.origin && url.pathname.startsWith(course.prefix);
  } catch {
    return false;
  }
}

async function loadCourse(force = false) {
  if (!currentTab || scanning) return;
  scanning = true;
  courseError = null;
  cachedScan = false;
  render(true);

  const response = await send({ type: 'scan-course', tabId: currentTab.id, force });
  scanning = false;

  if (!response || !response.ok) {
    course = null;
    courseError = (response && response.error) || 'a varredura falhou';
  } else {
    course = response.course;
    cachedScan = Boolean(response.cached);
    openModules.clear();
    selected = new Set();
    for (const mod of course.modules) {
      for (const lesson of mod.lessons) {
        if (!(data.completed || {})[lesson.url]) selected.add(lesson.url);
      }
    }
  }

  render(true);
}

function batchStatusMap() {
  const map = new Map();
  if (data.batch) for (const item of data.batch.items) map.set(item.url, item);
  return map;
}

const STATE_LABEL = {
  pending: ['Na fila', 'state-wait'],
  active: ['Baixando', 'state-active'],
  done: ['Baixada', 'state-done'],
  exists: ['Ja baixada', 'state-done'],
  skipped: ['Sem video', 'state-skip'],
  error: ['Erro', 'state-err']
};

function buildLesson(lesson, statuses) {
  const node = lessonTpl.content.firstElementChild.cloneNode(true);
  const check = node.querySelector('.lesson-check');
  const titleEl = node.querySelector('.lesson-title');
  const stateEl = node.querySelector('.lesson-state');

  titleEl.textContent = lesson.title;
  titleEl.title = lesson.title;

  check.checked = selected.has(lesson.url);
  check.disabled = batchActive();
  check.addEventListener('change', () => {
    if (check.checked) selected.add(lesson.url);
    else selected.delete(lesson.url);
    syncSelectionUi();
  });

  const item = statuses.get(lesson.url);
  const completed = (data.completed || {})[lesson.url];

  if (item && STATE_LABEL[item.status]) {
    const [label, cls] = STATE_LABEL[item.status];
    stateEl.textContent = label;
    stateEl.className = `lesson-state ${cls}`;
    stateEl.title = item.error || item.savedPath || '';
  } else if (completed) {
    stateEl.textContent = 'Ja baixada';
    stateEl.className = 'lesson-state state-done';
    stateEl.title = completed.path || completed.filename || '';
  } else {
    stateEl.textContent = 'Disponivel';
    stateEl.className = 'lesson-state state-idle';
  }

  return node;
}

function renderCourseView() {
  if (scanning) {
    const box = document.createElement('div');
    box.className = 'empty';
    const spin = document.createElement('span');
    spin.className = 'spinner';
    const strong = document.createElement('strong');
    strong.textContent = 'Escaneando o curso…';
    const span = document.createElement('span');
    span.textContent =
      'Abrindo a pagina do curso e cada modulo. Leva alguns segundos e a pagina fica travada.';
    box.append(spin, strong, span);
    listEl.appendChild(box);
    return;
  }

  if (courseError) return showEmpty('Nao consegui mapear o curso', courseError);
  if (!course) return showEmpty('Curso ainda nao escaneado', 'Clique em "Reescanear" para listar as aulas.');

  const statuses = batchStatusMap();

  const head = document.createElement('div');
  head.className = 'course-head';
  const h2 = document.createElement('h2');
  h2.className = 'course-title';
  h2.textContent = course.courseTitle;
  h2.title = course.courseTitle;
  const sub = document.createElement('p');
  sub.className = 'course-sub';
  const partes = [
    plural(course.modules.length, 'modulo', 'modulos'),
    plural(course.lessonCount, 'aula', 'aulas')
  ];
  if (course.scannedAt) partes.push(cachedScan ? `escaneado ${desde(course.scannedAt)}` : 'escaneado agora');
  sub.textContent = partes.join(' · ');
  head.append(h2, sub);
  listEl.appendChild(head);

  course.modules.forEach((mod, index) => {
    const node = moduleTpl.content.firstElementChild.cloneNode(true);
    const check = node.querySelector('.module-check');
    const toggle = node.querySelector('.module-toggle');
    const titleEl = node.querySelector('.module-title');
    const countEl = node.querySelector('.module-count');
    const lessonsEl = node.querySelector('.module-lessons');

    titleEl.textContent = mod.title;
    titleEl.title = mod.title;
    check.disabled = batchActive();
    check.dataset.moduleIndex = String(index);

    const aberto = openModules.has(index);
    node.classList.toggle('is-open', aberto);
    lessonsEl.hidden = !aberto;
    toggle.setAttribute('aria-expanded', String(aberto));

    // Aulas so entram no DOM quando o modulo abre: 92 linhas de uma vez
    // deixariam a rolagem pesada e ilegivel.
    if (aberto) {
      for (const lesson of mod.lessons) lessonsEl.appendChild(buildLesson(lesson, statuses));
    }

    toggle.addEventListener('click', () => {
      if (openModules.has(index)) openModules.delete(index);
      else openModules.add(index);
      render(true);
    });

    check.addEventListener('change', () => {
      for (const lesson of mod.lessons) {
        if (check.checked) selected.add(lesson.url);
        else selected.delete(lesson.url);
      }
      for (const box of lessonsEl.querySelectorAll('.lesson-check')) box.checked = check.checked;
      syncSelectionUi();
    });

    listEl.appendChild(node);
  });

  syncSelectionUi();
}

/** Contadores e botao, sem redesenhar a lista (a rolagem saltaria). */
function syncSelectionUi() {
  if (!course) return;

  for (const node of listEl.querySelectorAll('.module')) {
    const check = node.querySelector('.module-check');
    const mod = course.modules[Number(check.dataset.moduleIndex)];
    if (!mod) continue;
    const escolhidas = mod.lessons.filter((l) => selected.has(l.url)).length;
    check.checked = escolhidas === mod.lessons.length;
    check.indeterminate = escolhidas > 0 && escolhidas < mod.lessons.length;
    node.querySelector('.module-count').textContent =
      escolhidas === mod.lessons.length
        ? `${mod.lessons.length}`
        : `${escolhidas}/${mod.lessons.length}`;
  }

  countCourseEl.textContent = String(selected.size);
  downloadSelectedBtn.textContent = selected.size
    ? `Baixar ${plural(selected.size, 'aula', 'aulas')}`
    : 'Baixar';
  downloadSelectedBtn.disabled = !selected.size || busy();
}

function setAllSelected(value) {
  if (!course) return;
  selected = new Set();
  if (value) {
    for (const mod of course.modules) for (const lesson of mod.lessons) selected.add(lesson.url);
  }
  for (const box of listEl.querySelectorAll('.lesson-check')) box.checked = value;
  syncSelectionUi();
}

async function downloadSelected() {
  if (!course || !currentTab || !selected.size) return;

  const items = [];
  course.modules.forEach((mod, moduleIndex) => {
    mod.lessons.forEach((lesson, lessonIndex) => {
      if (!selected.has(lesson.url)) return;
      items.push({
        url: lesson.url,
        title: lesson.title,
        moduleTitle: mod.title,
        moduleIndex: moduleIndex + 1,
        lessonIndex: lessonIndex + 1,
        // Ja baixadas vem desmarcadas; se esta marcada, foi escolha do usuario.
        force: Boolean((data.completed || {})[lesson.url])
      });
    });
  });

  const response = await send({
    type: 'start-batch',
    tabId: currentTab.id,
    courseTitle: course.courseTitle,
    items
  });

  if (response && response.ok === false) {
    activityEl.hidden = false;
    setNote(response.error, 'error');
  }
  await refresh();
}

selectAllBtn.addEventListener('click', () => setAllSelected(true));
selectNoneBtn.addEventListener('click', () => setAllSelected(false));
rescanBtn.addEventListener('click', () => loadCourse(true));
downloadSelectedBtn.addEventListener('click', downloadSelected);

// Escotilha de emergencia: se o registro ficar dessincronizado do disco, zera.
forgetBtn.addEventListener('click', async () => {
  await send({ type: 'forget-completed' });
  await refresh();
  if (course) {
    selected = new Set();
    for (const mod of course.modules) for (const l of mod.lessons) selected.add(l.url);
  }
  render(true);
});

activityShowEl.addEventListener('click', () => {
  send({ type: 'show-download', downloadId: data.job && data.job.downloadId });
});

activityCloseEl.addEventListener('click', async () => {
  if (batchActive()) await send({ type: 'cancel-batch' });
  else if (jobRunning()) await send({ type: 'cancel-download' });
  else await Promise.all([send({ type: 'dismiss-batch' }), send({ type: 'dismiss-job' })]);
  await refresh();
});

batchPauseEl.addEventListener('click', async () => {
  const pausada = data.batch && data.batch.status === 'paused';
  await send({ type: pausada ? 'resume-batch' : 'pause-batch' });
  await refresh();
});

batchRetryEl.addEventListener('click', async () => {
  await send({ type: 'retry-failed' });
  await refresh();
});

/* ------------------------------------------------------------------ *
 * Render
 * ------------------------------------------------------------------ */

function showEmpty(title, hint) {
  const box = document.createElement('div');
  box.className = 'empty';
  const strong = document.createElement('strong');
  strong.textContent = title;
  const span = document.createElement('span');
  span.textContent = hint;
  box.append(strong, span);
  listEl.appendChild(box);
}

let lastSignature = null;

async function render(force = false) {
  renderActivity();

  const allEntries = Object.entries(data.all).filter(([, list]) => list.length);
  const totalAll = allEntries.reduce((sum, [, list]) => sum + list.length, 0);

  countCurrentEl.textContent = String(data.current.length);
  countAllEl.textContent = String(totalAll);
  if (!course) countCourseEl.textContent = '0';

  const signature = JSON.stringify([
    view,
    busy(),
    probes.size,
    scanning,
    courseError,
    course ? [course.courseTitle, course.modules.map((m) => m.lessons.length)] : null,
    [...openModules].sort(),
    data.batch ? [data.batch.status, data.batch.cursor, data.batch.items.map((i) => i.status)] : null,
    Object.keys(data.completed || {}).length,
    data.current.map((s) => s.url),
    allEntries.map(([tabId, list]) => [tabId, list.length])
  ]);
  if (!force && signature === lastSignature) return;
  lastSignature = signature;

  listEl.replaceChildren();
  courseBarEl.hidden = view !== 'course';

  if (view === 'course') return renderCourseView();

  if (view === 'current') {
    if (!data.current.length) {
      return showEmpty(
        'Nenhuma playlist detectada',
        'Abra o video e deixe reproduzir alguns segundos. A lista atualiza sozinha.'
      );
    }
    for (const stream of sortStreams(data.current)) {
      listEl.appendChild(buildItem(stream, { downloadable: true }));
    }
    return;
  }

  if (!allEntries.length) {
    return showEmpty('Nada capturado ainda', 'Nenhuma aba gerou requisicoes .m3u8 nesta sessao.');
  }

  const titles = await Promise.all(
    allEntries.map(async ([tabId]) => {
      try {
        const tab = await chrome.tabs.get(Number(tabId));
        return tab.title || tab.url || `Aba ${tabId}`;
      } catch {
        return `Aba ${tabId} (fechada)`;
      }
    })
  );

  allEntries.forEach(([tabId, streams], index) => {
    const label = document.createElement('h2');
    label.className = 'group-label';
    label.textContent = `${titles[index]} · ${streams.length}`;
    label.title = titles[index];
    listEl.appendChild(label);

    const isCurrent = currentTab && Number(tabId) === currentTab.id;
    for (const stream of sortStreams(streams)) {
      listEl.appendChild(buildItem(stream, { downloadable: isCurrent }));
    }
  });
}

/* ------------------------------------------------------------------ */

async function refresh() {
  if (!currentTab) return;
  const response = await send({ type: 'get-state', tabId: currentTab.id });
  if (!response) return;
  data = response;
  await render();
}

function setView(next) {
  view = next;
  for (const [seg, name] of [[segCurrent, 'current'], [segCourse, 'course'], [segAll, 'all']]) {
    seg.classList.toggle('is-active', next === name);
    seg.setAttribute('aria-selected', String(next === name));
  }
  render(true);

  if (next === 'course' && !scanning && !courseError && !courseCoversTab()) loadCourse(false);
}

segCurrent.addEventListener('click', () => setView('current'));
segCourse.addEventListener('click', () => setView('course'));
segAll.addEventListener('click', () => setView('all'));

clearBtn.addEventListener('click', async () => {
  if (view === 'all') await send({ type: 'clear-all' });
  else if (currentTab) await send({ type: 'clear-tab', tabId: currentTab.id });
  probes.clear();
  await refresh();
});

(async function init() {
  currentTab = await getActiveTab();
  tabTitleEl.textContent = currentTab
    ? currentTab.title || currentTab.url || 'Aba sem titulo'
    : 'Nenhuma aba ativa';
  if (currentTab) tabTitleEl.title = currentTab.title || '';

  await refresh();
  if (batchActive()) setView('course');

  refreshTimer = setInterval(refresh, 700);
})();

window.addEventListener('pagehide', () => clearInterval(refreshTimer));
