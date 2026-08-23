(() => {
  const STORE_KEY = '__COURSE_DOWNLOADER_LESSON_DEBUG__';
  const relevantPage =
    /\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?club\/[^/]+\/products\/[^/]+(?:\/|$)|\/trilhas\/[^/]+(?:\/|$)/i;
  const isFathomFrame = /(?:^|\.)fathom\.video$/i.test(location.hostname);
  if ((!relevantPage.test(location.pathname) && !isFathomFrame) || window[STORE_KEY]?.version === 5) return;

  const RELATED_KEY = /(video|media|recording|download|playback|asset|stream|manifest|player|content|url|source|lesson|locked|available|release|access|\bid\b)/i;
  const SENSITIVE_KEY = /(authorization|cookie|token|secret|password|signature|credential|api[-_]?key)/i;
  const MEDIA_URL = /(?:\.m3u8|\.mpd|\.mp4|\.webm|\.mkv|\.mov)(?![a-z0-9])|[?&/=](?:m3u8|mpd)(?![a-z0-9])/i;
  const MEDIA_KEY = /(?:download|recording|video|media|playback|asset).*(?:url|src)/i;
  const MAX_RECORDS = 120;

  const redactText = (value) => {
    const text = String(value || '');
    if (/^(?:https?:)?\/\//i.test(text) || text.startsWith('/')) {
      try {
        const url = new URL(text, location.href);
        for (const key of [...url.searchParams.keys()]) {
          if (SENSITIVE_KEY.test(key)) url.searchParams.set(key, '[REDACTED]');
        }
        return url.href;
      } catch {
        /* texto semelhante a URL, mas invalido */
      }
    }
    return text
      .replace(/((?:authorization|token|secret|password|signature|api[-_]?key)\s*[=:]\s*)[^&\s,}\]]+/gi, '$1[REDACTED]')
      .slice(0, 2000);
  };

  const summarize = (value) => {
    if (typeof value === 'string') return redactText(value).slice(0, 500);
    if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
    if (Array.isArray(value)) {
      return { type: 'array', length: value.length, sample: value.slice(0, 5).map(summarize) };
    }
    try {
      return { type: 'object', keys: Object.keys(value).slice(0, 40) };
    } catch {
      return { type: typeof value };
    }
  };

  function inspectPayload(payload) {
    if (!payload || typeof payload !== 'object') return { responseKeys: [], related: [] };
    let responseKeys = [];
    try { responseKeys = Object.keys(payload).slice(0, 60); } catch { /* objeto protegido */ }

    const related = [];
    const seen = new WeakSet();
    const queue = [{ value: payload, path: '', depth: 0 }];
    let visited = 0;
    while (queue.length && visited < 600 && related.length < 40) {
      const current = queue.shift();
      if (!current.value || typeof current.value !== 'object' || seen.has(current.value)) continue;
      seen.add(current.value);
      visited++;

      let entries = [];
      try { entries = Object.entries(current.value); } catch { continue; }
      for (const [key, value] of entries) {
        const path = current.path ? `${current.path}.${key}` : key;
        if (RELATED_KEY.test(key)) related.push({ path: path.slice(-240), value: summarize(value) });
        if (current.depth < 5 && value && typeof value === 'object' &&
            !/^(_owner|return|stateNode|child|sibling|alternate)$/i.test(key)) {
          queue.push({ value, path, depth: current.depth + 1 });
        }
      }
    }
    return { responseKeys, related };
  }

  function snapshot() {
    const roots = [];
    for (const key of ['__NEXT_DATA__', '__INITIAL_STATE__', '__PRELOADED_STATE__', '__APOLLO_STATE__', '__NUXT__']) {
      if (window[key] && typeof window[key] === 'object') roots.push({ source: key, value: window[key] });
    }
    for (const script of document.querySelectorAll('script[type="application/json"]')) {
      try { roots.push({ source: 'script[type=application/json]', value: JSON.parse(script.textContent) }); }
      catch { /* JSON parcial */ }
    }
    for (const el of [...document.querySelectorAll('*')].slice(0, 3000)) {
      let names = [];
      try { names = Object.getOwnPropertyNames(el); } catch { continue; }
      for (const name of names) {
        if (name.startsWith('__reactProps$')) roots.push({ source: 'React props', value: el[name] });
      }
      if (roots.length >= 30) break;
    }

    return roots.slice(0, 30).map(({ source, value }) => ({
      source,
      ...inspectPayload(value),
      ...mediaAndIds(value)
    }));
  }

  const state = {
    version: 5,
    lesson: null,
    records: [],
    inspectPayload,
    snapshot
  };
  Object.defineProperty(window, STORE_KEY, { value: state, configurable: true });

  const push = (record) => {
    state.records.push({ at: Date.now(), ...record });
    if (state.records.length > MAX_RECORDS) state.records.splice(0, state.records.length - MAX_RECORDS);
  };

  const sanitizeValue = (value, depth = 0) => {
    if (depth > 8) return null;
    if (typeof value === 'string') return redactText(value).slice(0, 200000);
    if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
    if (Array.isArray(value)) return value.slice(0, 200).map((item) => sanitizeValue(item, depth + 1));
    if (typeof value !== 'object') return null;
    const clean = {};
    let entries = [];
    try { entries = Object.entries(value).slice(0, 200); } catch { return null; }
    for (const [key, child] of entries) {
      clean[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitizeValue(child, depth + 1);
    }
    return clean;
  };

  const describeBody = (body) => {
    if (body == null) return null;
    if (typeof URLSearchParams === 'function' && body instanceof URLSearchParams) {
      const value = {};
      for (const [key, entry] of body.entries()) value[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : entry;
      return { format: 'urlencoded', keys: Object.keys(value), operationName: value.operationName || null, value };
    }
    if (typeof FormData === 'function' && body instanceof FormData) {
      const value = {};
      for (const [key, entry] of body.entries()) {
        value[key] = SENSITIVE_KEY.test(key)
          ? '[REDACTED]'
          : typeof entry === 'string' ? entry.slice(0, 200000) : '[BINARY]';
      }
      return { format: 'form-data', keys: Object.keys(value), operationName: value.operationName || null, value };
    }
    if (typeof body !== 'string' || body.length > 2_000_000) return null;
    try {
      const parsed = sanitizeValue(JSON.parse(body));
      return {
        format: 'json',
        keys: parsed && typeof parsed === 'object' ? Object.keys(parsed).slice(0, 40) : [],
        operationName: parsed?.operationName || null,
        value: parsed
      };
    } catch {
      return { format: 'text', keys: [], operationName: null, value: redactText(body) };
    }
  };

  const mediaAndIds = (payload) => {
    const mediaUrls = [];
    const identifiers = {};
    const seen = new WeakSet();
    const queue = [{ value: payload, key: '', entity: '', depth: 0 }];
    let visited = 0;
    while (queue.length && visited < 1500) {
      const { value, key, entity, depth } = queue.shift();
      if (typeof value === 'string') {
        if (MEDIA_URL.test(value) || (/^https?:/i.test(value) && MEDIA_KEY.test(key))) mediaUrls.push(value);
        if (/^id$/i.test(key) && entity) identifiers[`${entity}Id`] = value;
        else if (/(?:^|_)(?:lesson|content|video|media|asset|playback)(?:_?id)?$/i.test(key)) identifiers[key] = value;
        continue;
      }
      if (typeof value === 'number' && (/^id$/i.test(key) ? entity : /(?:^|_)(?:lesson|content|video|media|asset|playback)(?:_?id)?$/i.test(key))) {
        identifiers[/^id$/i.test(key) ? `${entity}Id` : key] = value;
        continue;
      }
      if (!value || typeof value !== 'object' || seen.has(value) || depth > 8) continue;
      seen.add(value);
      visited++;
      let entries = [];
      try { entries = Object.entries(value); } catch { continue; }
      for (const [childKey, child] of entries) {
        const match = childKey.match(/^(lesson|content|video|media|asset|playback)(?:_?id)?$/i);
        queue.push({
          value: child,
          key: childKey,
          entity: match ? match[1].toLowerCase() : entity,
          depth: depth + 1
        });
      }
    }
    return { mediaUrls: [...new Set(mediaUrls)].slice(0, 20), identifiers };
  };

  const encodeBody = (body) => {
    if (!body) return undefined;
    if (body.format === 'json') return JSON.stringify(body.value);
    if (body.format === 'urlencoded') return new URLSearchParams(body.value).toString();
    if (body.format === 'form-data') {
      const form = new FormData();
      for (const [key, value] of Object.entries(body.value || {})) {
        if (value !== '[BINARY]' && value !== '[REDACTED]') form.append(key, value);
      }
      return form;
    }
    return typeof body.value === 'string' ? body.value : undefined;
  };

  const nativeFetch = window.fetch;
  state.resolveApiOperations = async (templates) => {
    const results = [];
    const discovered = {};
    const replace = (value) => {
      if (typeof value === 'string') {
        const exact = value.match(/^__MEDIA_RESOLVER_ID:([^_]+)__$/);
        if (exact) return Object.prototype.hasOwnProperty.call(discovered, exact[1]) ? discovered[exact[1]] : value;
        return value.replace(/__MEDIA_RESOLVER_ID:([^_]+)__/g, (match, key) =>
          Object.prototype.hasOwnProperty.call(discovered, key) ? String(discovered[key]) : match
        );
      }
      if (Array.isArray(value)) return value.map(replace);
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replace(child)]));
    };

    for (const template of templates || []) {
      Object.assign(discovered, template.identifiers || {});
      const url = replace(template.url);
      const body = template.body ? { ...template.body, value: replace(template.body.value) } : null;
      const unresolved = JSON.stringify({ url, body }).match(/__MEDIA_RESOLVER_ID:[^_]+__/g);
      if (unresolved) {
        results.push({
          operationName: template.operationName,
          endpoint: redactText(url),
          status: 'skipped',
          error: `IDs ausentes: ${[...new Set(unresolved)].join(', ')}`
        });
        continue;
      }
      let requestOrigin = null;
      try { requestOrigin = new URL(url, location.href).origin; } catch { /* URL invalida */ }
      if (!requestOrigin || requestOrigin !== location.origin) {
        results.push({
          operationName: template.operationName,
          endpoint: redactText(url),
          status: 'skipped',
          error: 'Operacao cross-origin nao repetida para evitar desafio de autenticacao'
        });
        continue;
      }
      try {
        const headers = {};
        if (body?.format === 'json') headers['content-type'] = 'application/json';
        if (body?.format === 'urlencoded') headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
        const response = await Reflect.apply(nativeFetch, window, [url, {
          method: template.method || 'GET',
          body: /^(GET|HEAD)$/i.test(template.method || 'GET') ? undefined : encodeBody(body),
          headers,
          credentials: 'include',
          cache: 'no-store'
        }]);
        const contentType = response.headers.get('content-type') || '';
        let payload = null;
        if (/json/i.test(contentType)) payload = await response.clone().json().catch(() => null);
        else payload = await response.clone().text().catch(() => null);
        const found = mediaAndIds(payload);
        for (const [key, value] of Object.entries(found.identifiers)) {
          discovered[String(key).replace(/[^a-z0-9]/gi, '').toLowerCase()] = value;
        }
        const inspected = inspectPayload(payload);
        push({
          transport: 'media-resolver',
          method: template.method || 'GET',
          url: redactText(url),
          status: response.status,
          requestBody: body ? { format: body.format, keys: body.keys, operationName: body.operationName } : null,
          ...inspected
        });
        results.push({
          operationName: template.operationName,
          endpoint: redactText(url),
          status: response.status,
          responseKeys: inspected.responseKeys,
          identifiers: found.identifiers,
          mediaUrls: found.mediaUrls
        });
      } catch (error) {
        results.push({
          operationName: template.operationName,
          endpoint: redactText(url),
          status: 'network-error',
          error: error.message
        });
      }
    }
    return results;
  };

  if (typeof nativeFetch === 'function') {
    window.fetch = async function (...args) {
      const input = args[0];
      const init = args[1] || {};
      const request = typeof Request === 'function' && input instanceof Request ? input : null;
      const url = String(request ? request.url : input);
      const method = String(init.method || request?.method || 'GET').toUpperCase();
      const requestBodyPromise = init.body != null
        ? Promise.resolve(describeBody(init.body))
        : request && !/^(GET|HEAD)$/i.test(method)
          ? request.clone().text().then(describeBody, () => null)
          : Promise.resolve(null);
      try {
        const response = await Reflect.apply(nativeFetch, this, args);
        const requestBody = await requestBodyPromise;
        const record = {
          transport: 'fetch',
          method,
          url,
          status: response.status,
          requestBody,
          contentType: response.headers.get('content-type') || ''
        };
        const contentType = response.headers.get('content-type') || '';
        const responseUrl = response.url || url;
        const looksFragment = /\.(?:m4s|cmfv|cmfa|ts)(?:$|[?#])|(?:segment|chunk)[_/-]?\d/i.test(responseUrl);
        if (!looksFragment && /^(?:video\/|application\/(?:octet-stream|dash\+xml|x-mpegurl))/i.test(contentType)) {
          record.mediaUrls = [responseUrl];
        }
        if (/json/i.test(contentType)) {
          response.clone().json().then(
            (payload) => push({ ...record, ...inspectPayload(payload), ...mediaAndIds(payload) }),
            () => push(record)
          );
        } else push(record);
        return response;
      } catch (error) {
        const requestBody = await requestBodyPromise;
        push({ transport: 'fetch', method, url, status: 'network-error', requestBody, error: error.message });
        throw error;
      }
    };
  }

  const xhrMeta = new WeakMap();
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    xhrMeta.set(this, { method: String(method || 'GET').toUpperCase(), url: String(url) });
    return Reflect.apply(nativeOpen, this, [method, url, ...rest]);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const meta = xhrMeta.get(this) || { method: 'GET', url: '' };
    meta.requestBody = describeBody(body);
    this.addEventListener('loadend', () => queueMicrotask(() => {
      const record = {
        transport: 'xhr',
        method: meta.method,
        url: meta.url,
        status: this.status || 'network-error',
        requestBody: meta.requestBody
      };
      try {
        const contentType = this.getResponseHeader('content-type') || '';
        record.contentType = contentType;
        const responseUrl = this.responseURL || meta.url;
        const looksFragment = /\.(?:m4s|cmfv|cmfa|ts)(?:$|[?#])|(?:segment|chunk)[_/-]?\d/i.test(responseUrl);
        if (!looksFragment && /^(?:video\/|application\/(?:octet-stream|dash\+xml|x-mpegurl))/i.test(contentType)) {
          record.mediaUrls = [responseUrl];
        }
        if (this.responseType === 'json' && this.response) {
          Object.assign(record, inspectPayload(this.response), mediaAndIds(this.response));
        }
        else if (/json/i.test(contentType) && (!this.responseType || this.responseType === 'text')) {
          const payload = JSON.parse(this.responseText);
          Object.assign(record, inspectPayload(payload), mediaAndIds(payload));
        }
      } catch {
        /* resposta nao JSON ou inacessivel */
      }
      push(record);
    }), { once: true });
    return Reflect.apply(nativeSend, this, [body]);
  };
})();
