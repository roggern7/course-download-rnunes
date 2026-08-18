/**
 * Fallback para areas de membros SPA (Eduzz/AlpaClass).
 *
 * Algumas delas desenham aulas como <button> e guardam id/titulo somente nos
 * dados do React. Este arquivo roda no MAIN world exclusivamente para ler essa
 * arvore ja entregue ao navegador. Nao le cookies, tokens ou storage e nao faz
 * requisicoes.
 */
(async () => {
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const match = location.pathname.match(/^(\/trilhas\/[^/]+\/aulas\/)([^/?#]+)/i);
  if (!match) return { ok: false, reason: 'a pagina nao usa uma rota de aula reconhecida.' };

  const prefix = match[1];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const titleKey = /^(title|titulo|t[ií]tulo|name|nome|label)$/i;
  const idKey = /^(id|uuid|lesson_?id|aula_?id|content_?id)$/i;
  const lessonKey = /(aulas?|lessons?|classes?|episodes?|episodios?|epis[oó]dios?)/i;
  const contentKey = /^(contents?|conteudos?|conte[uú]dos?|items?)$/i;
  const moduleKey = /(modules?|modulos?|m[oó]dulos?|sections?|secoes?|se[cç][oõ]es?|chapters?|capitulos?)/i;
  const mediaKey = /(video|player|media|duration|dura[cç][aã]o|lesson|aula|episode|epis[oó]dio)/i;
  const MAX_OBJECTS = 50000;
  const MAX_LESSONS = 1000;

  const ownEntries = (obj) => {
    try {
      return Object.entries(obj);
    } catch {
      return [];
    }
  };

  function directTitle(obj) {
    for (const [key, value] of ownEntries(obj)) {
      if (titleKey.test(key) && typeof value === 'string') {
        const title = clean(value);
        if (title.length >= 2 && title.length <= 200) return title;
      }
    }
    return '';
  }

  function directId(obj) {
    for (const [key, value] of ownEntries(obj)) {
      if (!idKey.test(key)) continue;
      const id = clean(value);
      if (uuid.test(id)) return id;
    }
    return '';
  }

  function directUrl(obj) {
    for (const [, value] of ownEntries(obj)) {
      if (typeof value !== 'string') continue;
      try {
        const url = new URL(value, location.origin);
        if (url.origin === location.origin && url.pathname.startsWith(prefix)) return url.href;
      } catch {
        /* nao era URL */
      }
    }
    return '';
  }

  function hasMediaEvidence(obj) {
    return ownEntries(obj).some(([key, value]) =>
      mediaKey.test(key) || (typeof value === 'string' && /^(aula|lesson|video)$/i.test(value))
    );
  }

  function asLesson(obj, assumedLesson = false) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const title = directTitle(obj);
    if (!title) return null;

    const explicitUrl = directUrl(obj);
    if (explicitUrl) return { title, url: explicitUrl };

    const id = directId(obj);
    if (!id || (!assumedLesson && !hasMediaEvidence(obj))) return null;
    return { title, url: new URL(prefix + id, location.origin).href };
  }

  function lessonsIn(value, assumedLesson, depth = 0) {
    const found = [];
    if (!value || typeof value !== 'object' || depth > 2) return found;

    if (Array.isArray(value)) {
      for (const item of value) {
        const lesson = asLesson(item, assumedLesson);
        if (lesson) found.push(lesson);
        else if (item && typeof item === 'object') found.push(...lessonsIn(item, assumedLesson, depth + 1));
      }
      return found;
    }

    const lesson = asLesson(value, assumedLesson);
    if (lesson) return [lesson];
    for (const [key, child] of ownEntries(value)) {
      if (!child || typeof child !== 'object') continue;
      if (lessonKey.test(key) || contentKey.test(key)) {
        found.push(...lessonsIn(child, true, depth + 1));
      }
    }
    return found;
  }

  const grouped = new Map();
  const addGroup = (title, lessons) => {
    if (!lessons.length) return;
    const safeTitle = clean(title) || 'Aulas';
    let group = grouped.get(safeTitle);
    if (!group) {
      group = new Map();
      grouped.set(safeTitle, group);
    }
    for (const lesson of lessons) {
      if (group.size >= MAX_LESSONS) break;
      group.set(lesson.url, lesson);
    }
  };

  const roots = [];
  if (window.__NEXT_DATA__ && typeof window.__NEXT_DATA__ === 'object') roots.push(window.__NEXT_DATA__);

  for (const script of document.querySelectorAll('script[type="application/json"]')) {
    try {
      roots.push(JSON.parse(script.textContent));
    } catch {
      /* JSON parcial ou de outra finalidade */
    }
  }

  // Expando properties do React existem apenas no MAIN world.
  for (const el of document.querySelectorAll('*')) {
    let names = [];
    try {
      names = Object.getOwnPropertyNames(el);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith('__reactProps$')) roots.push(el[name]);
      if (!name.startsWith('__reactFiber$')) continue;
      let fiber = el[name];
      for (let level = 0; fiber && level < 12; level++, fiber = fiber.return) {
        if (fiber.memoizedProps) roots.push(fiber.memoizedProps);
        if (fiber.pendingProps && fiber.pendingProps !== fiber.memoizedProps) roots.push(fiber.pendingProps);
      }
    }
  }

  const seenObjects = new WeakSet();
  const seenRoots = new WeakSet();
  const queue = [];
  for (const value of roots) {
    if (!value || typeof value !== 'object' || seenRoots.has(value)) continue;
    seenRoots.add(value);
    queue.push({ value, context: '', parentTitle: '' });
  }
  let cursor = 0;
  let visited = 0;

  while (cursor < queue.length && visited < MAX_OBJECTS) {
    const { value, context, parentTitle } = queue[cursor++];
    if (!value || typeof value !== 'object') continue;
    if (typeof Node === 'function' && value instanceof Node) continue;
    if (seenObjects.has(value)) continue;
    seenObjects.add(value);
    visited++;

    if (!Array.isArray(value)) {
      const objectTitle = directTitle(value);

      // Estrutura preferida: modulo -> aulas/lessons/classes.
      for (const [key, child] of ownEntries(value)) {
        if (!Array.isArray(child)) continue;
        if (lessonKey.test(key)) addGroup(objectTitle || parentTitle, lessonsIn(child, true));
        else if (contentKey.test(key)) {
          const contents = lessonsIn(child, false);
          if (contents.length) addGroup(objectTitle || parentTitle, contents);
        }
      }

      // Estrutura plana: a propria lista de aulas traz o nome do modulo.
      if (lessonKey.test(context)) {
        const lesson = asLesson(value, true);
        if (lesson) addGroup(parentTitle, [lesson]);
      }

      for (const [key, child] of ownEntries(value)) {
        if (!child || typeof child !== 'object') continue;
        // React elements apontam de volta para a arvore Fiber. Ela ja foi
        // adicionada de forma controlada acima; seguir esses links explodiria
        // a busca para o document/window inteiro.
        if (/^(_owner|return|stateNode|child|sibling|alternate)$/i.test(key)) continue;
        const nextParent = moduleKey.test(key) ? objectTitle : (objectTitle || parentTitle);
        queue.push({ value: child, context: key, parentTitle: nextParent });
      }
    } else {
      for (const child of value) {
        if (child && typeof child === 'object') queue.push({ value: child, context, parentTitle });
      }
    }
  }

  // Grupos nomeados vencem o agrupamento generico quando ha duplicatas.
  const ordered = [...grouped.entries()].sort(([a], [b]) => (a === 'Aulas') - (b === 'Aulas'));
  const used = new Set();
  const modules = [];
  for (const [title, lessonMap] of ordered) {
    const lessons = [...lessonMap.values()].filter((lesson) => {
      if (used.has(lesson.url)) return false;
      used.add(lesson.url);
      return true;
    });
    if (lessons.length) modules.push({ title, lessons });
  }

  const lessonCount = modules.reduce((sum, module) => sum + module.lessons.length, 0);
  const slug = decodeURIComponent(location.pathname.split('/')[2] || 'Curso');
  const courseTitle = slug
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

  return lessonCount >= 2
    ? {
        ok: true,
        modules,
        lessonCount,
        courseTitle: courseTitle || 'Curso',
        prefix,
        source: 'dados da pagina',
        currentUrl: location.href
      }
    : { ok: false, modules: [], reason: 'nao encontrei aulas nos dados carregados pela pagina.' };
})();
