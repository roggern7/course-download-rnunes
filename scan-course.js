/**
 * Course Downloader RNUNES - varredura da navegacao do curso
 *
 * Injetado sob demanda por chrome.scripting.executeScript.
 *
 * ESTRUTURA REAL (confirmada no historico de navegacao de um curso memberkit):
 *
 *   /219199-captacao-na-gringa                       pagina do curso
 *   /219199-captacao-na-gringa/continue              atalho "comecar agora"
 *   /219199-captacao-na-gringa/sections/<id>-<slug>  MODULO  (lista aulas)
 *   /219199-captacao-na-gringa/<id>-<slug>           AULA    (tem o video)
 *
 * O que distingue uma aula de um modulo nao e o texto do link, e sim a FORMA
 * do caminho: uma aula tem exatamente um segmento depois do prefixo do curso;
 * um modulo tem um segmento container ("sections", "modules"...) antes do seu
 * proprio id. Alguns segmentos de um nivel so ("continue", "certificates") sao
 * atalhos, nunca aulas.
 *
 * Por isso a varredura tem tres estagios:
 *
 *   1. a pagina atual, como ela esta (serve quando ja lista as aulas);
 *   2. a pagina raiz do curso, buscada em same-origin e lida com DOMParser;
 *   3. se a raiz listar modulos em vez de aulas, cada pagina de modulo e lida
 *      para extrair as aulas dela.
 *
 * As requisicoes saem do contexto da propria pagina, same-origin - as mesmas
 * que o site faz ao navegar. A extensao nao le cookie, header nem token, e nao
 * contorna login: uma secao bloqueada continua bloqueada.
 */

(async () => {
  const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();

  /* Textos que quase nunca sao aula. */
  const SKIP_LINK =
    /^(pr[oó]xim|anterior|voltar|avan[cç]ar|continuar|comecar agora|come[cç]ar agora|in[ií]cio|home|sair|logout|entrar|login|assinar|comprar|checkout|suporte|ajuda|d[uú]vida|faq|perfil|minha conta|meu perfil|configura|coment|responder|curtir|ver mais|carregar mais|mostrar mais|todos os cursos|meus cursos|catalogo|cat[aá]logo|certificado|marcar como|concluir aula|baixar|download)/i;
  const SKIP_HEADING =
    /^(coment[aá]rios?|deixe seu|escreva|como voc[eê]|avalia|material de apoio|anexos?|sobre o|descri[cç][aã]o|d[uú]vidas)/i;

  /* Sufixos de estado que as plataformas coem no texto do link. */
  const TRAILING_NOISE =
    /\s*\b(conclu[ií]d[oa]s?|assistid[oa]s?|em andamento|n[aã]o iniciad[oa]|bloquead[oa]|liberad[oa]|novo|gr[aá]tis|preview)\b\s*$/i;
  const TRAILING_TIME = /\s*\b\d{1,2}:\d{2}(?::\d{2})?\s*$/;
  const LEADING_PLAYBACK = /^(?:tocando agora|reproduzindo agora|playing now)\s+/i;
  const TRAILING_AVAILABILITY =
    /\s+dispon[ií]vel(?:\s+(?:at[eé]|em|a partir de))?(?:\s|$).*$/i;

  /* Primeiro segmento que indica "isto agrupa aulas", nao "isto e uma aula". */
  const MODULE_SEGMENTS = new Set([
    'sections', 'section', 'secoes', 'modules', 'module', 'modulos', 'modulo',
    'chapters', 'chapter', 'capitulos', 'capitulo', 'trilhas', 'trilha', 'turmas'
  ]);

  /* Segmentos de um nivel que sao atalhos do site, nunca aulas. */
  const RESERVED_SLUGS = new Set([
    'continue', 'sections', 'modules', 'certificate', 'certificates', 'certificado',
    'comments', 'progress', 'about', 'sobre', 'members', 'membros', 'forum',
    'ranking', 'downloads', 'materiais', 'suporte', 'perfil', 'settings'
  ]);

  const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SUMMARY', 'LEGEND', 'DT']);
  const HEADING_CLASS =
    /(module|modulo|m[oó]dulo|chapter|capitulo|cap[ií]tulo|section-title|sectiontitle|unidade|unit|group-title|grouptitle|accordion|collapse-title|panel-title)/i;
  const MODULE_CARD = /^m[oó]dulo\s+\d+\s+aulas?\s+\d{1,3}%(?:\s|$)/i;

  const URL_ATTRS = ['href', 'data-href', 'data-url', 'data-link', 'data-to', 'data-path'];

  const MAX_MODULES = 60;
  const MAX_LESSONS = 600;

  /* ---------------------------------------------------------------- *
   * Helpers
   * ---------------------------------------------------------------- */

  function tidyTitle(text) {
    let out = clean(text).replace(LEADING_PLAYBACK, '');
    for (let i = 0; i < 3; i++) {
      const before = out;
      out = out
        .replace(TRAILING_AVAILABILITY, '')
        .replace(TRAILING_NOISE, '')
        .replace(TRAILING_TIME, '');
      if (out === before) break;
    }
    return clean(out.replace(/^[\s|·—–-]+|[\s|·—–-]+$/g, '')) || clean(text);
  }

  function moduleCardTitle(text) {
    return clean(text)
      .replace(/^m[oó]dulo\s+\d+\s+aulas?\s+\d{1,3}%\s*/i, '')
      .replace(/\s+acessar\s+\d{1,3}%.*$/i, '')
      .trim() || 'Módulo';
  }

  function textOf(el) {
    // innerText respeita o visivel; em menus fechados vem vazio e textContent
    // salva. Em documentos do DOMParser innerText nem existe.
    return clean(el.innerText || el.textContent || el.getAttribute('aria-label') || el.title);
  }

  function urlAttr(el) {
    for (const attr of URL_ATTRS) {
      const value = el.getAttribute && el.getAttribute(attr);
      if (value) return value;
    }
    return null;
  }

  function prefixesFor(pathname) {
    const segments = pathname.split('/').filter(Boolean);
    const out = [];

    // Area de membros da Eduzz/AlpaClass:
    //   /trilhas/<slug-do-curso>/aulas/<uuid-da-aula>
    // A raiz que identifica o curso e a pasta `aulas`, nao `/trilhas/`. Sem
    // este caso especial a busca da "raiz" mistura cursos diferentes ou tenta
    // abrir `/trilhas/<curso>/aulas`, que nao e uma pagina de indice.
    if (
      segments.length >= 3 &&
      segments[0].toLowerCase() === 'trilhas' &&
      segments[2].toLowerCase() === 'aulas'
    ) {
      out.push(`/${segments.slice(0, 3).join('/')}/`);
    }

    // Estando dentro de um modulo (/curso/sections/<id>), o prefixo do curso e
    // tudo ANTES do segmento container - senao as secoes irmas viram "aulas".
    const moduleAt = segments.findIndex((s) => MODULE_SEGMENTS.has(s.toLowerCase()));
    if (moduleAt > 0) out.push(`/${segments.slice(0, moduleAt).join('/')}/`);

    if (segments.length >= 2) out.push(`/${segments.slice(0, -1).join('/')}/`);
    if (segments.length >= 1) out.push(`/${segments[0]}/`);
    out.push('/');
    return [...new Set(out)];
  }

  /**
   * Decide o que um link e, pela forma do caminho relativo ao curso.
   * @returns {'lesson'|'module'|null}
   */
  function classify(url, prefix) {
    const rest = url.pathname.slice(prefix.length).split('/').filter(Boolean);

    // Aula identificada por query (/curso/?aula=3).
    if (rest.length === 0) return url.search ? 'lesson' : null;

    if (rest.length === 1) {
      return RESERVED_SLUGS.has(rest[0].toLowerCase()) ? null : 'lesson';
    }

    if (MODULE_SEGMENTS.has(rest[0].toLowerCase())) return 'module';

    // Caminhos mais fundos e desconhecidos: trata como aula (/c/1/l/2).
    return rest.length <= 3 ? 'lesson' : null;
  }

  /* ---------------------------------------------------------------- *
   * Coleta
   * ---------------------------------------------------------------- */

  function collect(doc, baseUrl, prefix) {
    const here = new URL(baseUrl);
    const lessons = [];
    const modules = [];
    const seen = new Set();

    const nodes = doc.querySelectorAll(
      'a[href], [data-href], [data-url], [data-link], [data-to], [data-path]'
    );

    for (const node of nodes) {
      const raw = urlAttr(node);
      if (!raw || raw.startsWith('#') || /^(javascript|mailto|tel):/i.test(raw)) continue;

      let url;
      try {
        url = new URL(raw, baseUrl);
      } catch {
        continue;
      }

      if (url.origin !== here.origin) continue;
      if (!url.pathname.startsWith(prefix)) continue;

      let kind = classify(url, prefix);
      if (!kind) continue;

      const title = tidyTitle(textOf(node));
      if (title.length < 2 || title.length > 200) continue;
      if (SKIP_LINK.test(title)) continue;
      // Na Hotmart, modulo e aula compartilham /content/<hash>. O texto do
      // cartao e a diferenca observavel: "Modulo 4 aulas 0% ... Acessar".
      if (MODULE_CARD.test(title)) kind = 'module';

      const key = kind + '|' + url.pathname + (url.search || '');
      if (seen.has(key)) continue;

      seen.add(key);
      const entry = {
        el: node,
        url: url.href,
        title: kind === 'module' && MODULE_CARD.test(title) ? moduleCardTitle(title) : title
      };
      if (kind === 'module') modules.push(entry);
      else lessons.push(entry);
    }

    return { lessons, modules };
  }

  /* ---------------------------------------------------------------- *
   * Agrupamento por titulo, para paginas que ja listam as aulas
   * ---------------------------------------------------------------- */

  function groupModules(doc, lessons) {
    const byEl = new Map(lessons.map((lesson) => [lesson.el, lesson]));

    const isInsideLesson = (node) => {
      for (let el = node.parentElement; el; el = el.parentElement) {
        if (byEl.has(el)) return true;
      }
      return false;
    };

    const headingText = (el) => {
      if (byEl.has(el) || isInsideLesson(el)) return null;
      const byTag = HEADING_TAGS.has(el.tagName);
      const cls = typeof el.className === 'string' ? el.className : '';
      const byClass = HEADING_CLASS.test(cls) && el.children.length === 0;
      if (!byTag && !byClass) return null;

      const text = clean(el.innerText || el.textContent);
      if (text.length < 2 || text.length > 90) return null;
      if (SKIP_HEADING.test(text)) return null;
      return text;
    };

    const found = [];
    let current = null;

    const root = doc.body || doc.documentElement;
    if (!root) return [];

    const walker = doc.createTreeWalker(root, 1 /* SHOW_ELEMENT */);
    for (let el = walker.nextNode(); el; el = walker.nextNode()) {
      const lesson = byEl.get(el);
      if (lesson) {
        if (!current) {
          current = { title: null, lessons: [] };
          found.push(current);
        }
        current.lessons.push({ title: lesson.title, url: lesson.url });
        continue;
      }

      const heading = headingText(el);
      if (!heading) continue;
      if (current && current.lessons.length === 0) current.title = heading;
      else {
        current = { title: heading, lessons: [] };
        found.push(current);
      }
    }

    return dedupeModules(found);
  }

  /** Remove aulas repetidas entre modulos e modulos que ficaram vazios. */
  function dedupeModules(list) {
    const seen = new Set();
    const out = [];
    for (const mod of list) {
      const unique = [];
      for (const lesson of mod.lessons) {
        if (seen.has(lesson.url)) continue;
        seen.add(lesson.url);
        unique.push(lesson);
        if (seen.size >= MAX_LESSONS) break;
      }
      if (unique.length) out.push({ title: mod.title || 'Aulas', lessons: unique });
    }
    return out;
  }

  function courseTitleFrom(doc, baseUrl, prefix) {
    const here = new URL(baseUrl);
    const home = prefix.replace(/\/$/, '');

    for (const anchor of doc.querySelectorAll('a[href]')) {
      try {
        const url = new URL(anchor.getAttribute('href'), baseUrl);
        if (url.origin === here.origin && url.pathname.replace(/\/$/, '') === home) {
          const text = clean(anchor.innerText || anchor.textContent);
          if (text.length >= 2 && text.length <= 90) return text;
        }
      } catch {
        /* href invalido */
      }
    }

    const h1 = doc.querySelector('h1');
    const fromH1 = h1 ? clean(h1.innerText || h1.textContent) : '';
    if (fromH1.length >= 2 && fromH1.length <= 90) return fromH1;

    const fromTitle = clean(doc.title).split(/\s+[|·—–-]\s+/)[0];
    return fromTitle.length >= 2 ? fromTitle.slice(0, 90) : 'Curso';
  }

  /* ---------------------------------------------------------------- *
   * Leitura das paginas auxiliares
   *
   * O XHR permanece sincrono porque cada documento precisa ser analisado na
   * ordem. A funcao externa e async apenas para aguardar a renderizacao dos
   * acordeoes; chrome.scripting.executeScript resolve a Promise antes de
   * devolver `injection.result`.
   * ---------------------------------------------------------------- */

  function getSync(url) {
    try {
      if (typeof XMLHttpRequest !== 'function') return null;
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, false);
      xhr.send(null);
      return { status: xhr.status, html: xhr.responseText || '' };
    } catch {
      return null;
    }
  }

  function parse(html) {
    try {
      return new DOMParser().parseFromString(html, 'text/html');
    } catch {
      return null;
    }
  }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Algumas areas Eduzz so montam as aulas de um modulo depois que o acordeao
   * e aberto. Aciona apenas controles recolhidos dentro da navegacao lateral;
   * nunca clica em uma aula nem em botoes do conteudo principal.
   */
  async function expandCourseNavigation() {
    const scopes = [
      ...document.querySelectorAll(
        'aside, nav, [class*="sidebar" i], [class*="side-bar" i], [class*="course-menu" i], [class*="lesson-menu" i]'
      )
    ];

    let scope = scopes.find((el) => /navegue\s+pelas\s+aulas/i.test(textOf(el)));
    if (!scope) {
      scope = scopes
        .map((el) => ({ el, count: el.querySelectorAll('[aria-expanded], [data-state]').length }))
        .sort((a, b) => b.count - a.count)[0]?.el;
    }
    if (!scope) return { count: 0, modules: [] };

    const discovered = [];
    const moduleTitle = (control) => {
      const child = control.querySelector(
        'h2, h3, h4, [class*="module-title" i], [class*="modulo-title" i], [class*="title" i]'
      );
      const raw = textOf(child || control)
        .replace(/\b\d{1,3}%\s*(conclu[ií]do)?\b.*$/i, '')
        .replace(/\b\d+\s*aulas?\b.*$/i, '');
      return tidyTitle(raw) || 'Aulas';
    };
    const capture = (control) => {
      const snapshot = read(document, location.href);
      if (!snapshot.lessons.length) return;
      discovered.push({
        title: moduleTitle(control),
        lessons: snapshot.lessons.map((lesson) => ({ title: lesson.title, url: lesson.url }))
      });
    };
    const isModuleControl = (el) => {
      if (urlAttr(el) || el.closest('a[href]')) return false;
      const text = textOf(el);
      if (text.length < 2 || text.length > 180 || SKIP_LINK.test(text)) return false;
      return el.matches('button, [role="button"], summary, [aria-controls]');
    };

    // Registra primeiro o modulo que ja estava aberto quando o usuario abriu
    // o popup. Em acordeoes de abertura unica ele sera desmontado em seguida.
    for (const open of scope.querySelectorAll('[aria-expanded="true"], [data-state="open"]')) {
      if (isModuleControl(open)) capture(open);
    }

    const controls = [...scope.querySelectorAll(
      '[aria-expanded="false"], button[data-state="closed"], [role="button"][data-state="closed"]'
    )].filter(isModuleControl);

    for (const control of controls.slice(0, MAX_MODULES)) {
      try {
        control.click();
        // React/Radix normalmente materializa o painel no proximo frame.
        await wait(35);
        capture(control);
      } catch {
        /* controle desmontado por outro acordeao */
      }
    }
    if (controls.length) await wait(180);
    return { count: controls.length, modules: dedupeModules(discovered) };
  }

  /* ---------------------------------------------------------------- *
   * Extracao
   * ---------------------------------------------------------------- */

  /**
   * Le um documento com o prefixo MAIS ESPECIFICO que encontrar algo. Prefixos
   * mais largos ("/") sempre acham mais links, mas acham lixo: menu do site,
   * outros cursos. Especificidade vence quantidade.
   */
  function read(doc, baseUrl) {
    for (const prefix of prefixesFor(new URL(baseUrl).pathname)) {
      const found = collect(doc, baseUrl, prefix);
      if (found.lessons.length || found.modules.length) return { ...found, prefix };
    }
    return { lessons: [], modules: [], prefix: '/' };
  }

  /**
   * A pagina do curso lista modulos. Abre cada um e recolhe as aulas de dentro,
   * usando como titulo do modulo o proprio texto do link.
   */
  function expandModules(moduleLinks, prefix) {
    const out = [];
    const falhas = [];

    for (const link of moduleLinks.slice(0, MAX_MODULES)) {
      const response = getSync(link.url);
      if (!response || response.status < 200 || response.status >= 400) {
        falhas.push({ modulo: link.title, status: response ? response.status : 'sem resposta' });
        continue;
      }

      const doc = parse(response.html);
      if (!doc) {
        falhas.push({ modulo: link.title, status: 'html invalido' });
        continue;
      }

      const { lessons } = collect(doc, link.url, prefix);
      if (lessons.length) {
        out.push({
          title: link.title,
          lessons: lessons.map((lesson) => ({ title: lesson.title, url: lesson.url }))
        });
      }
    }

    return { modules: dedupeModules(out), falhas };
  }

  /** Um unico link solto (breadcrumb, "proxima aula") nao e um curso. */
  const MIN_LESSONS = 2;

  function build(source, extra) {
    const lessonCount = source.modules.reduce((sum, mod) => sum + mod.lessons.length, 0);
    return { ok: lessonCount >= MIN_LESSONS, lessonCount, ...source, ...extra };
  }

  /* ---------------------------------------------------------------- *
   * Estagios
   * ---------------------------------------------------------------- */

  /**
   * Uma pagina de aula costuma ter poucos links irmaos (breadcrumb, "proxima").
   * Abaixo deste piso ela vira apenas um candidato, e quem achar mais vence.
   */
  const LOCAL_IS_ENOUGH = 5;

  const expandedNavigation = await expandCourseNavigation();

  const localRead = read(document, location.href);
  const groupedLocal = groupModules(document, localRead.lessons);
  const expandedCount = expandedNavigation.modules.reduce((sum, mod) => sum + mod.lessons.length, 0);
  const groupedCount = groupedLocal.reduce((sum, mod) => sum + mod.lessons.length, 0);
  const local = {
    modules: expandedCount > groupedCount ? expandedNavigation.modules : groupedLocal,
    courseTitle: courseTitleFrom(document, location.href, localRead.prefix),
    prefix: localRead.prefix
  };
  const localCount = local.modules.reduce((sum, mod) => sum + mod.lessons.length, 0);

  // Se a pagina expoe uma navegacao de modulos, o curso tem um nivel de secao:
  // vale mais descer nele (curso inteiro) do que ficar so com o que esta a vista.
  const temNavegacaoDeModulos = localRead.modules.length >= 2;

  if (localCount >= LOCAL_IS_ENOUGH && !temNavegacaoDeModulos) {
    return build(local, { source: 'pagina atual', currentUrl: location.href });
  }

  /* --- raiz do curso --- */

  const rootPath = prefixesFor(location.pathname).find((p) => p !== '/') || '/';
  const rootUrl = new URL(rootPath.replace(/\/$/, '') || '/', location.origin).href;
  const sameAsHere =
    rootUrl.replace(/\/$/, '') === location.href.split(/[?#]/)[0].replace(/\/$/, '');

  const rootDoc = sameAsHere ? document : null;
  let rootRead = sameAsHere ? localRead : null;
  let rootStatus = sameAsHere ? 200 : null;

  if (!sameAsHere) {
    const response = getSync(rootUrl);
    rootStatus = response ? response.status : null;
    if (response && response.status >= 200 && response.status < 400) {
      const doc = parse(response.html);
      if (doc) {
        rootRead = read(doc, rootUrl);
        rootRead.doc = doc;
        rootRead.baseUrl = rootUrl;
      }
    }
  } else {
    rootRead = { ...localRead, doc: document, baseUrl: location.href };
  }

  const falhaRaiz = () => {
    if (localCount >= MIN_LESSONS) {
      return build(local, { source: 'pagina atual', currentUrl: location.href });
    }
    return {
      ok: false,
      modules: [],
      reason:
        rootStatus && (rootStatus < 200 || rootStatus >= 400)
          ? `a pagina do curso (${rootPath}) respondeu HTTP ${rootStatus}.`
          : `nao encontrei a lista de aulas em ${rootPath}.`
    };
  };

  if (!rootRead) return falhaRaiz();

  /* --- a raiz lista modulos: abre cada um --- */

  if (rootRead.modules.length) {
    const expanded = expandModules(rootRead.modules, rootRead.prefix);

    if (expanded.modules.length) {
      const result = build(
        {
          modules: expanded.modules,
          courseTitle: courseTitleFrom(rootRead.doc, rootRead.baseUrl, rootRead.prefix),
          prefix: rootRead.prefix
        },
        {
          source: 'modulos do curso',
          sourceUrl: rootUrl,
          currentUrl: location.href,
          moduleCount: rootRead.modules.length,
          modulesSemAulas: expanded.falhas
        }
      );
      if (result.lessonCount >= localCount) return result;
    }
  }

  /* --- a raiz lista aulas direto --- */

  if (rootRead.lessons.length) {
    const result = build(
      {
        modules: groupModules(rootRead.doc, rootRead.lessons),
        courseTitle: courseTitleFrom(rootRead.doc, rootRead.baseUrl, rootRead.prefix),
        prefix: rootRead.prefix
      },
      { source: 'pagina do curso', sourceUrl: rootUrl, currentUrl: location.href }
    );
    if (result.lessonCount >= localCount) return result;
  }

  return falhaRaiz();
})();
