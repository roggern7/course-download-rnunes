/**
 * Fallback para areas de membros SPA (Eduzz/AlpaClass e Hotmart Club).
 *
 * Algumas delas desenham aulas como <button> e guardam id/titulo somente nos
 * dados do React. Este arquivo roda no MAIN world exclusivamente para ler essa
 * arvore ja entregue ao navegador. Nao le cookies, tokens ou storage e nao faz
 * requisicoes.
 */
(async () => {
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const hotmartHash = /^[a-z0-9_-]{6,128}$/i;

  function routeFrom(pathname) {
    const eduzz = pathname.match(/^(\/trilhas\/([^/]+)\/aulas\/)([^/?#]+)/i);
    if (eduzz) {
      return {
        platform: 'eduzz',
        prefix: eduzz[1],
        courseSlug: eduzz[2],
        currentLessonId: eduzz[3],
        acceptsId: (value) => uuid.test(value)
      };
    }

    // Hotmart Club atual:
    // /pt-BR/club/<area>/products/<produto>/content/<hash-da-aula>
    // O locale e opcional porque links internos podem omiti-lo.
    const hotmart = pathname.match(
      /^(\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?club\/([^/]+)\/products\/([^/]+)\/content\/)([^/?#]+)/i
    );
    if (hotmart) {
      return {
        platform: 'hotmart',
        prefix: hotmart[1],
        courseSlug: hotmart[2],
        productId: hotmart[3],
        currentLessonId: hotmart[4],
        acceptsId: (value) => hotmartHash.test(value) && value !== hotmart[3]
      };
    }

    return null;
  }

  const route = routeFrom(location.pathname);
  if (!route) return { ok: false, reason: 'a pagina nao usa uma rota de aula reconhecida.' };

  const prefix = route.prefix;
  const titleKey = /^(title|titulo|t[ií]tulo|name|nome|label)$/i;
  const strongIdKey = /^(uuid|hash|lesson_?id|aula_?id|content_?id|page_?id)$/i;
  const idKey = /^(id|uuid|hash|lesson_?id|aula_?id|content_?id|page_?id)$/i;
  const lessonKey = /(aulas?|lessons?|classes?|pages|paginas|p[aá]ginas|episodes?|episodios?|epis[oó]dios?)/i;
  // "Extras da trilha" costuma vir em uma coleção separada do array de
  // aulas. Os itens continuam usando a mesma rota /aulas/<uuid>, mas podem
  // ser texto, arquivo ou vídeo.
  const resourceKey = /(b[oô]nus|bonus(?:es)?|extras?)/i;
  const contentKey = /^(contents?|conteudos?|conte[uú]dos?|items?)$/i;
  const moduleKey = /(modules?|modulos?|m[oó]dulos?|sections?|secoes?|se[cç][oõ]es?|chapters?|capitulos?|b[oô]nus|bonus(?:es)?|extras?)/i;
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
    const entries = ownEntries(obj);
    // A navigation da Hotmart traz hash; prioriza identificadores de aula
    // antes do id generico, que no mesmo objeto pode ser o id do produto.
    for (const strongOnly of [true, false]) {
      for (const [key, value] of entries) {
        if (!idKey.test(key) || (strongOnly && !strongIdKey.test(key))) continue;
        const id = clean(value);
        if (route.acceptsId(id)) return id;
      }
    }
    return '';
  }

  function hasStrongId(obj) {
    return ownEntries(obj).some(([key, value]) =>
      strongIdKey.test(key) && route.acceptsId(clean(value))
    );
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

  function looksLikeModuleSummary(obj, title = directTitle(obj)) {
    if (/^m[oó]dulo\s+\d+\s+aulas?\s+\d{1,3}%(?:\s|$)/i.test(clean(title))) return true;
    return ownEntries(obj).some(([key, value]) =>
      /^(lesson|aula|content)_?count$/i.test(key) && Number(value) > 1
    );
  }

  function nestedContentCollections(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
    return ownEntries(obj).filter(([key, value]) =>
      Array.isArray(value) &&
      (lessonKey.test(key) || resourceKey.test(key) || contentKey.test(key))
    );
  }

  function directKind(obj) {
    for (const [key, value] of ownEntries(obj)) {
      if (!/^(type|tipo|kind|format|content_?type|lesson_?type)$/i.test(key)) continue;
      const raw = clean(value).toLowerCase();
      if (/video|vídeo|live|record/.test(raw)) return 'video';
      if (/file|arquivo|attachment|anexo|document/.test(raw)) return 'file';
      if (/text|texto|article|artigo/.test(raw)) return 'text';
      if (/link|url|resource|recurso/.test(raw)) return 'resource';
    }
    return null;
  }

  function lessonIdentifiers(obj, lessonId) {
    const identifiers = {};
    if (lessonId) identifiers.lessonId = lessonId;
    const entityIdKey = /^(lesson|content|video|media|asset|playback)_?id$/i;
    const queue = [{ value: obj, entity: '', depth: 0 }];
    const seen = new WeakSet();
    let visited = 0;
    while (queue.length && visited < 1000) {
      const { value, entity, depth } = queue.shift();
      if (!value || typeof value !== 'object' || seen.has(value) || depth > 5) continue;
      seen.add(value);
      visited++;
      for (const [key, child] of ownEntries(value)) {
        const match = key.match(entityIdKey);
        if (match && (typeof child === 'string' || typeof child === 'number')) {
          identifiers[`${match[1].toLowerCase()}Id`] = child;
        } else if (/^id$/i.test(key) && entity &&
                   (typeof child === 'string' || typeof child === 'number')) {
          identifiers[`${entity}Id`] = child;
        } else if (child && typeof child === 'object' &&
                   !/^(_owner|return|stateNode|child|sibling|alternate)$/i.test(key)) {
          const entityMatch = key.match(/^(lesson|content|video|media|asset|playback)$/i);
          queue.push({
            value: child,
            entity: entityMatch ? entityMatch[1].toLowerCase() : entity,
            depth: depth + 1
          });
        }
      }
    }
    return identifiers;
  }

  function asLesson(obj, assumedLesson = false) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const title = directTitle(obj);
    if (!title) return null;

    // A navegação nova da Hotmart expõe os módulos dentro de `contents` e
    // fornece uma URL para cada cartão. URL interna, sozinha, não transforma
    // um cartão "Módulo 6 aulas 17% ..." em aula.
    if (looksLikeModuleSummary(obj, title)) return null;

    const explicitUrl = directUrl(obj);
    let id = directId(obj);
    if (!id && explicitUrl) {
      try { id = decodeURIComponent(new URL(explicitUrl).pathname.split('/').filter(Boolean).pop() || ''); }
      catch { /* URL ja foi validada por directUrl */ }
    }
    const kind = directKind(obj);
    if (explicitUrl) return { title, url: explicitUrl, kind, identifiers: lessonIdentifiers(obj, id) };

    if (!id || (!assumedLesson && !hasStrongId(obj) && !hasMediaEvidence(obj))) return null;
    return {
      title,
      url: new URL(prefix + id, location.origin).href,
      kind,
      identifiers: lessonIdentifiers(obj, id)
    };
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
      if (lessonKey.test(key) || resourceKey.test(key) || contentKey.test(key)) {
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
  for (const key of ['__INITIAL_STATE__', '__PRELOADED_STATE__', '__APOLLO_STATE__', '__NUXT__']) {
    if (window[key] && typeof window[key] === 'object') roots.push(window[key]);
  }

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
        if (fiber.memoizedState) roots.push(fiber.memoizedState);
        if (fiber.pendingProps && fiber.pendingProps !== fiber.memoizedProps) roots.push(fiber.pendingProps);
      }
    }
  }

  /**
   * A Turing Academy renderiza "Extras da trilha" fora das coleções normais
   * de aulas. Os cards são a fonte mais estável para descobrir os títulos;
   * o UUID ainda vem dos props/dados React já presentes em `roots`.
   */
  function bonusCardsFromDom() {
    const all = [...document.querySelectorAll('*')];
    const textOf = (el) => clean(el?.innerText || el?.textContent);
    const kindOf = (value) => {
      const label = clean(value).toLowerCase();
      if (/^(v[ií]deo|video)$/.test(label)) return 'video';
      if (/^(arquivo|file)$/.test(label)) return 'file';
      if (/^(texto|text)$/.test(label)) return 'text';
      return null;
    };
    const heading = all.find((el) => /^extras\s+da\s+trilha$/i.test(textOf(el)));
    if (!heading) return new Map();

    let section = heading.parentElement;
    for (let node = heading.parentElement; node && node !== document.body; node = node.parentElement) {
      const labels = String(node.innerText || node.textContent || '')
        .split(/\r?\n/)
        .map(clean)
        .filter((line) => kindOf(line));
      if (labels.length >= 2) {
        section = node;
        break;
      }
    }
    if (!section) return new Map();

    const cards = new Map();
    const typeElements = [section, ...section.querySelectorAll('*')]
      .filter((el) => kindOf(textOf(el)));
    for (const typeElement of typeElements) {
      const kind = kindOf(textOf(typeElement));
      let card = typeElement.parentElement;
      for (let node = typeElement.parentElement; node && node !== section.parentElement; node = node.parentElement) {
        const lines = String(node.innerText || node.textContent || '')
          .split(/\r?\n/)
          .map(clean)
          .filter(Boolean);
        const typeCount = lines.filter((line) => kindOf(line)).length;
        if (typeCount > 1) break;
        if (typeCount === 1 && lines.length >= 2 && clean(lines.join(' ')).length <= 500) card = node;
        if (node === section) break;
      }
      if (!card) continue;

      const lines = String(card.innerText || card.textContent || '')
        .split(/\r?\n/)
        .map(clean)
        .filter(Boolean);
      const typeAt = lines.findIndex((line) => kindOf(line));
      let title = '';
      for (let index = typeAt - 1; index >= 0; index--) {
        if (/^\d{1,3}$/.test(lines[index])) continue;
        if (/^extras\s+da\s+trilha$/i.test(lines[index])) continue;
        title = lines[index];
        break;
      }
      if (!title || title.length > 200) continue;

      let explicitUrl = '';
      let explicitId = '';
      for (const el of [card, ...card.querySelectorAll('*')]) {
        let attrs = [];
        try { attrs = [...el.attributes].map((attr) => attr.value); } catch { /* sem atributos */ }
        for (const raw of attrs) {
          if (!explicitId && route.acceptsId(clean(raw))) explicitId = clean(raw);
          try {
            const url = new URL(raw, location.href);
            if (!explicitUrl && url.origin === location.origin && url.pathname.startsWith(prefix)) {
              explicitUrl = url.href;
            }
          } catch {
            const match = String(raw).match(/[0-9a-f]{8}-[0-9a-f-]{27,36}/i);
            if (!explicitId && match && route.acceptsId(match[0])) explicitId = match[0];
          }
        }
      }
      cards.set(title.toLocaleLowerCase('pt-BR'), {
        title,
        kind,
        url: explicitUrl || (explicitId ? new URL(prefix + explicitId, location.origin).href : '')
      });
    }
    return cards;
  }

  const visibleBonusCards = bonusCardsFromDom();
  const bonusUrl = (title) => new URL(
    `${prefix}__bonus__-${encodeURIComponent(clean(title).toLocaleLowerCase('pt-BR'))}`,
    location.origin
  ).href;

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
      const visibleBonus = visibleBonusCards.get(objectTitle.toLocaleLowerCase('pt-BR'));
      if (visibleBonus) {
        const lesson = asLesson(value, true);
        if (lesson) addGroup('Extras da trilha', [{
          ...lesson,
          title: visibleBonus.title,
          kind: visibleBonus.kind || lesson.kind,
          isBonus: true
        }]);
      }

      // Estrutura preferida: modulo -> aulas/lessons/classes.
      for (const [key, child] of ownEntries(value)) {
        if (!Array.isArray(child)) continue;
        if (lessonKey.test(key) || resourceKey.test(key)) {
          const groupTitle = resourceKey.test(key) && !resourceKey.test(objectTitle)
            ? 'Extras da trilha'
            : (objectTitle || parentTitle || 'Extras da trilha');
          addGroup(groupTitle, lessonsIn(child, true));
        }
        else if (contentKey.test(key)) {
          const containers = child.filter((item) => nestedContentCollections(item).length);
          const leaves = child.filter((item) => !nestedContentCollections(item).length);

          // Hotmart: `Todos os conteúdos -> módulo -> contents -> aulas`.
          // Mantém cada módulo como grupo e só transforma as folhas em aulas.
          for (const container of containers) {
            const groupTitle = directTitle(container) || objectTitle || parentTitle;
            for (const [nestedKey, nested] of nestedContentCollections(container)) {
              addGroup(groupTitle, lessonsIn(
                nested,
                lessonKey.test(nestedKey) || resourceKey.test(nestedKey)
              ));
            }
          }

          const contents = lessonsIn(leaves, false);
          if (contents.length) addGroup(objectTitle || parentTitle, contents);
        }
      }

      // Estrutura plana: a propria lista de aulas traz o nome do modulo.
      if (lessonKey.test(context) || resourceKey.test(context)) {
        const lesson = asLesson(value, true);
        if (lesson) addGroup(
          resourceKey.test(context) ? 'Extras da trilha' : parentTitle,
          [lesson]
        );
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

  // UUIDs encontrados em props podem ser IDs de conteúdo, não IDs de rota.
  // Para bônus, usa uma chave sintética estável e navega pelo card/título.
  // Assim nunca tentamos abrir uma URL inventada pela barra do navegador.
  if (visibleBonusCards.size) {
    let extras = grouped.get('Extras da trilha');
    if (!extras) {
      extras = new Map();
      grouped.set('Extras da trilha', extras);
    }
    for (const bonus of visibleBonusCards.values()) {
      for (const [url, lesson] of extras) {
        if (clean(lesson.title).toLocaleLowerCase('pt-BR') ===
            clean(bonus.title).toLocaleLowerCase('pt-BR')) extras.delete(url);
      }
      const url = bonusUrl(bonus.title);
      extras.set(url, {
        title: bonus.title,
        url,
        kind: bonus.kind,
        isBonus: true
      });
    }
  }

  // Grupos nomeados vencem agrupamentos genericos quando ha duplicatas. A
  // Hotmart usa "Todos os conteudos" como uma visao parcial/lazy da secao
  // aberta; se ela vier primeiro, rouba as URLs dos modulos reais.
  const genericGroup = (title) => /^(?:aulas|todos os conte[uú]dos|all contents?)$/i.test(clean(title));
  const ordered = [...grouped.entries()].sort(([a], [b]) =>
    Number(genericGroup(a)) - Number(genericGroup(b))
  );
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

  // O rótulo TEXTO/VÍDEO/ARQUIVO às vezes existe só no cartão renderizado,
  // não no objeto da API. Usa-o para evitar procurar player em bônus estático.
  const lessonsByTitle = new Map();
  for (const module of modules) {
    for (const lesson of module.lessons) {
      const key = clean(lesson.title).toLocaleLowerCase('pt-BR');
      if (key) lessonsByTitle.set(key, lesson);
    }
  }
  for (const el of document.querySelectorAll('h1, h2, h3, h4, strong, [class*="title" i]')) {
    const key = clean(el.innerText || el.textContent).toLocaleLowerCase('pt-BR');
    const lesson = lessonsByTitle.get(key);
    if (!lesson || lesson.kind) continue;
    const card = el.closest('a, button, li, [role="button"], [class*="card" i], [class*="item" i]');
    const label = clean((card || el.parentElement || el).innerText || (card || el).textContent).toLowerCase();
    if (/\b(v[ií]deo|video)\b/.test(label)) lesson.kind = 'video';
    else if (/\b(arquivo|file)\b/.test(label)) lesson.kind = 'file';
    else if (/\b(texto|text)\b/.test(label)) lesson.kind = 'text';
  }

  const lessonCount = modules.reduce((sum, module) => sum + module.lessons.length, 0);
  const pageTitle =
    route.platform === 'hotmart' ? clean(document.title).split(/\s+\|\s+/)[0] : '';
  const slug = decodeURIComponent(route.courseSlug || 'Curso');
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
        courseTitle:
          (pageTitle && !/^hotmart(?: club)?$/i.test(pageTitle) ? pageTitle.slice(0, 90) : '') ||
          courseTitle ||
          'Curso',
        prefix,
        source: 'dados da pagina',
        currentUrl: location.href
      }
    : { ok: false, modules: [], reason: 'nao encontrei aulas nos dados carregados pela pagina.' };
})();
