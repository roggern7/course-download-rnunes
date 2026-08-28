import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const script = await readFile(new URL('../scan-page-data.js', import.meta.url), 'utf8');

function fakePage(state) {
  class FakeNode {}
  const document = {
    title: 'Curso de Teste',
    querySelectorAll() { return []; }
  };
  const location = {
    origin: 'https://curso.example',
    pathname: '/trilhas/curso-de-teste/aulas/00000000-0000-4000-8000-000000000001',
    href: 'https://curso.example/trilhas/curso-de-teste/aulas/00000000-0000-4000-8000-000000000001'
  };
  const window = { __INITIAL_STATE__: state };
  return vm.createContext({
    URL,
    WeakSet,
    Node: FakeNode,
    decodeURIComponent,
    document,
    location,
    window
  });
}

function fakeHotmartPage(state) {
  class FakeNode {}
  const document = {
    title: 'Mestres do Algoritmo 2.0 | Hotmart Club',
    querySelectorAll() { return []; }
  };
  const location = {
    origin: 'https://hotmart.com',
    pathname: '/pt-BR/club/mda-academy/products/produto-123/content/aula-atual',
    href: 'https://hotmart.com/pt-BR/club/mda-academy/products/produto-123/content/aula-atual'
  };
  const window = { __INITIAL_STATE__: state };
  return vm.createContext({
    URL,
    WeakSet,
    Node: FakeNode,
    decodeURIComponent,
    document,
    location,
    window
  });
}

class FakeElement {
  constructor(text = '', attributes = {}) {
    this.innerText = text;
    this.textContent = text;
    this.parentElement = null;
    this.children = [];
    this.attributes = Object.entries(attributes).map(([name, value]) => ({ name, value }));
  }

  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
    return this;
  }

  querySelectorAll() {
    return this.children.flatMap((child) => [child, ...child.querySelectorAll('*')]);
  }

  getAttribute(name) {
    return this.attributes.find((attribute) => attribute.name === name)?.value || null;
  }

  closest() { return this.parentElement; }
}

test('inclui os bônus e preserva texto, vídeo e arquivo', async () => {
  const state = {
    trail: {
      title: 'Curso de Teste',
      lessons: [
        { title: 'Aula comum', uuid: '00000000-0000-4000-8000-000000000010', type: 'video' },
        { title: 'Outra aula', uuid: '00000000-0000-4000-8000-000000000011', type: 'video' }
      ],
      bonuses: [
        { title: 'Kit de vendas', uuid: '00000000-0000-4000-8000-000000000020', type: 'text' },
        { title: 'Biblioteca de 100 Nichos Lucrativos', uuid: '00000000-0000-4000-8000-000000000021', type: 'texto' },
        { title: 'Call Ao Vivo Gravada', uuid: '00000000-0000-4000-8000-000000000022', type: 'video' },
        { title: 'Modelo de Contrato', uuid: '00000000-0000-4000-8000-000000000023', type: 'arquivo' }
      ]
    }
  };

  const result = await new vm.Script(script).runInContext(fakePage(state));
  assert.equal(result.ok, true);
  assert.equal(result.lessonCount, 6);

  const extras = result.modules.find((module) => module.title === 'Extras da trilha');
  assert.ok(extras, JSON.stringify(result.modules));
  assert.deepEqual(
    Array.from(extras.lessons, (lesson) => [lesson.title, lesson.kind]),
    [
      ['Kit de vendas', 'text'],
      ['Biblioteca de 100 Nichos Lucrativos', 'text'],
      ['Call Ao Vivo Gravada', 'video'],
      ['Modelo de Contrato', 'file']
    ]
  );
});

test('descobre extras visíveis mesmo quando a coleção React tem nome desconhecido', async () => {
  class FakeNode {}
  Object.setPrototypeOf(FakeElement.prototype, FakeNode.prototype);
  const body = new FakeElement();
  const section = new FakeElement(
    'Extras da trilha\n01\nKit de vendas\nTEXTO\nBonus 2\n02\nBiblioteca de Nichos\nTEXTO\nBonus 4\n03\nCall Gravada\nVIDEO\nAssista\n04\nModelo de Contrato\nARQUIVO\nAnexo'
  );
  const heading = new FakeElement('Extras da trilha');
  const definitions = [
    ['Kit de vendas', 'TEXTO', '00000000-0000-4000-8000-000000000020'],
    ['Biblioteca de Nichos', 'TEXTO', '00000000-0000-4000-8000-000000000021'],
    ['Call Gravada', 'VIDEO', '00000000-0000-4000-8000-000000000022'],
    ['Modelo de Contrato', 'ARQUIVO', '00000000-0000-4000-8000-000000000023']
  ];
  section.append(heading);
  for (const [index, [title, kind, uuid]] of definitions.entries()) {
    const card = new FakeElement(`${index + 1}\n${title}\n${kind}\nDescrição`);
    card.__reactProps$test = { premiumContentCard: { title, uuid, type: kind } };
    card.append(new FakeElement(kind));
    section.append(card);
  }
  body.append(section);
  const all = body.querySelectorAll('*');
  const document = {
    title: 'Curso de Teste',
    body,
    querySelectorAll(selector) {
      if (selector === '*') return all;
      if (selector === 'script[type="application/json"]') return [];
      return [];
    }
  };
  const location = {
    origin: 'https://curso.example',
    pathname: '/trilhas/curso-de-teste/aulas/00000000-0000-4000-8000-000000000001',
    href: 'https://curso.example/trilhas/curso-de-teste/aulas/00000000-0000-4000-8000-000000000001'
  };
  const context = vm.createContext({
    URL,
    WeakSet,
    Node: FakeNode,
    decodeURIComponent,
    document,
    location,
    window: {}
  });

  const result = await new vm.Script(script).runInContext(context);
  const extras = result.modules.find((module) => module.title === 'Extras da trilha');
  assert.ok(extras, JSON.stringify(result.modules));
  assert.equal(extras.lessons.length, 4);
  assert.deepEqual(
    Array.from(extras.lessons, (lesson) => lesson.kind),
    ['text', 'text', 'video', 'file']
  );
  assert.ok(extras.lessons.every((lesson) => lesson.isBonus));
  assert.ok(extras.lessons.every((lesson) => lesson.url.includes('/__bonus__-')));
});

test('Hotmart preserva módulos dentro de Todos os conteúdos', async () => {
  const lesson = (title, hash) => ({ title, hash, type: 'video' });
  const state = {
    navigation: {
      title: 'Todos os conteúdos',
      contents: [
        {
          title: 'START - O COMEÇO DA SUA JORNADA',
          url: '/pt-BR/club/mda-academy/products/produto-123/content/modulo-start',
          lessonCount: 2,
          contents: [
            lesson('Boas-vindas', 'aula-boas-vindas'),
            lesson('Como usar o curso', 'aula-como-usar')
          ]
        },
        {
          title: 'MÃO NA MASSA',
          url: '/pt-BR/club/mda-academy/products/produto-123/content/modulo-pratica',
          lessonCount: 2,
          contents: [
            lesson('Criando o canal', 'aula-criando-canal'),
            lesson('Primeiro vídeo', 'aula-primeiro-video')
          ]
        }
      ]
    }
  };

  const result = await new vm.Script(script).runInContext(fakeHotmartPage(state));
  assert.equal(result.ok, true);
  assert.equal(result.lessonCount, 4);
  assert.deepEqual(
    Array.from(result.modules, (module) => [
      module.title,
      Array.from(module.lessons, (item) => item.title)
    ]),
    [
      ['START - O COMEÇO DA SUA JORNADA', ['Boas-vindas', 'Como usar o curso']],
      ['MÃO NA MASSA', ['Criando o canal', 'Primeiro vídeo']]
    ]
  );
});

test('Hotmart não transforma cartões resumidos de módulos em aulas', async () => {
  const state = {
    navigation: {
      title: 'Todos os conteúdos',
      contents: [
        {
          title: 'Módulo 6 aulas 17% START - O COMEÇO DA SUA JORNADA',
          url: '/pt-BR/club/mda-academy/products/produto-123/content/modulo-start'
        },
        {
          title: 'Módulo 17 aulas 0% MÃO NA MASSA',
          url: '/pt-BR/club/mda-academy/products/produto-123/content/modulo-pratica'
        }
      ]
    }
  };

  const result = await new vm.Script(script).runInContext(fakeHotmartPage(state));
  assert.equal(result.ok, false);
  assert.equal(result.modules.length, 0);
});

test('Hotmart prioriza modulos reais sobre Todos os conteudos duplicado', async () => {
  const lesson = (title, hash) => ({ title, hash, type: 'video' });
  const first = lesson('Boas-vindas', 'aula-boas-vindas');
  const second = lesson('Criando o canal', 'aula-criando-canal');
  const state = {
    genericNavigation: {
      title: 'Todos os conteúdos',
      lessons: [first, second]
    },
    modules: [
      { title: 'Introdução', lessons: [first] },
      { title: 'Prática', lessons: [second] }
    ]
  };

  const result = await new vm.Script(script).runInContext(fakeHotmartPage(state));
  assert.equal(result.ok, true);
  assert.deepEqual(
    Array.from(result.modules, (module) => module.title),
    ['Introdução', 'Prática']
  );
  assert.equal(result.lessonCount, 2);
});
