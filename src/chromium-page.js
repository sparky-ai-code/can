// Page-side half of the Chromium backend (src/canchromium.js). Chrome runs this function in every page, before the
// page's own scripts (Page.addScriptToEvaluateOnNewDocument). It defines window.__canBrowser, a small API that gives
// the real browser the same vocabulary as the built-in browser: an outline with refs such as [e3], and click, type,
// select and submit by ref, CSS selector or visible text. Every method returns {value} or {error, code}.
//
// It is one plain function so Node can check its syntax and send its text to Chrome. It must not refer to anything
// outside the page.
export function canBrowserPage() {
  if (window.__canBrowser) return;

  const refs = { byEl: new WeakMap(), byId: new Map(), next: 1 };
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const lower = (s) => norm(s).toLowerCase();
  const q = (s) => JSON.stringify(String(s ?? ''));
  const ok = (value) => ({ value });
  const fail = (code, error) => ({ error, code });

  function ref(el) {
    let r = refs.byEl.get(el);
    if (!r) {
      r = `e${refs.next++}`;
      refs.byEl.set(el, r);
      refs.byId.set(r, el);
    }
    return r;
  }

  function labelText(el) {
    if (el.labels && el.labels.length) return norm([...el.labels].map((l) => l.textContent).join(' '));
    const wrap = el.closest && el.closest('label');
    return wrap ? norm(wrap.textContent) : '';
  }

  function nameOf(el) {
    const tag = el.tagName;
    const isButtonInput = tag === 'INPUT' && ['button', 'submit', 'reset', 'image'].includes(el.type);
    const name = el.getAttribute('aria-label')
      || (isButtonInput ? el.value : '')
      || labelText(el)
      || el.getAttribute('placeholder')
      || el.getAttribute('title')
      || (tag === 'IMG' ? el.getAttribute('alt') : '')
      || el.textContent
      || (tag === 'INPUT' || tag === 'TEXTAREA' ? '' : el.value)
      || el.getAttribute('name')
      || '';
    return norm(name).slice(0, 200);
  }

  function describe(el) {
    const tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return `heading ${q(norm(el.textContent).slice(0, 200))} level=${tag[1]}`;
    if (tag === 'a') return `link ${q(nameOf(el))} [${ref(el)}] -> ${q(el.getAttribute('href'))}`;
    if (tag === 'form') return `form ${q(el.getAttribute('name') || el.getAttribute('action') || '')} [${ref(el)}]`;
    if (tag === 'summary') return `summary ${q(nameOf(el))} [${ref(el)}]`;
    if (tag === 'img') return `image ${q(el.getAttribute('alt'))}`;
    const dis = el.disabled ? ' disabled' : '';
    const isButton = tag === 'button'
      || el.getAttribute('role') === 'button'
      || (tag === 'input' && ['button', 'submit', 'reset', 'image'].includes(el.type));
    if (isButton) return `button ${q(nameOf(el))} [${ref(el)}]${dis}`;
    if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) {
      return `${el.type} ${q(nameOf(el))} [${ref(el)}] ${el.checked ? 'checked' : 'unchecked'}${dis}`;
    }
    if (tag === 'input' && el.type === 'file') return `file ${q(nameOf(el))} [${ref(el)}]${dis}`;
    if (tag === 'select') {
      const opts = [...el.options].slice(0, 30).map((o) => q(norm(o.text))).join(', ');
      return `combobox ${q(nameOf(el))} [${ref(el)}] value=${q(el.value)} options=[${opts}]${dis}`;
    }
    // Passwords are listed without their value.
    const shown = el.value && el.type !== 'password' ? ` value=${q(el.value)}` : '';
    return `textbox ${q(nameOf(el))} [${ref(el)}]${shown}${dis}`;
  }

  // The outline lists controls and headings with refs, and static text as "text" lines, as the built-in browser
  // does. A run of text and inline elements between two controls is one line, so "Signed in as <span>ada</span>.
  // <a>Log in</a>" gives the line "Signed in as ada." and then the link.
  const ROLES = '[role="button"], [role="link"], [role="checkbox"], [role="textbox"]';
  const OUTLINE = `h1, h2, h3, h4, h5, h6, a[href], button, input, select, textarea, summary, img[alt], form, ${ROLES}`;
  const BLOCK = 'p, li, td, th, dt, dd, blockquote, figcaption, pre, caption, div, section, article, header, footer, nav, main, aside, ul, ol, table, tr, thead, tbody, dl, body';
  const SKIP = 'script, style, template, noscript';

  function walk(parent, out, mute) {
    let run = '';
    const flush = () => {
      const t = norm(run).slice(0, 500);
      if (t && !mute) out.push(`- text ${q(t)}`);
      run = '';
    };
    for (const n of parent.childNodes) {
      if (n.nodeType === 3) { run += n.textContent; continue; }
      if (n.nodeType !== 1 || n.matches(SKIP)) continue;
      const el = n;
      if (el.tagName === 'INPUT' && el.type === 'hidden') continue;
      if (el.getClientRects().length === 0) continue; // display:none and its kin
      if (el.tagName === 'FORM') {
        flush();
        out.push(`- ${describe(el)}`);
        walk(el, out, mute);
      } else if (el.matches(OUTLINE)) {
        flush();
        out.push(`- ${describe(el)}`);
      } else if (el.tagName === 'LABEL') {
        flush();
        walk(el, out, true); // the label's text is the name of its control, so it is not listed again
      } else if (el.querySelector(`${OUTLINE}, ${BLOCK}`)) {
        flush();
        walk(el, out, mute); // a container: its children carry the lines
      } else if (el.matches(BLOCK)) {
        flush();
        const t = norm(el.textContent).slice(0, 500);
        if (t && !mute) out.push(`- text ${q(t)}`);
      } else {
        run += el.textContent; // inline element with no controls inside: part of the current run
      }
    }
    flush();
  }

  function snapshot() {
    const lines = [`Page: ${q(document.title)}`, `URL: ${location.href}`];
    walk(document.body ?? document.documentElement, lines, false);
    return lines.join('\n');
  }

  const CONTROLS = 'a[href], button, input, select, textarea, label, summary, [role="button"], [role="link"], [role="checkbox"], [role="textbox"]';
  const FIELDS = 'input, textarea, select, label';

  // A snapshot ref, a CSS selector, or the visible name (or name attribute) of a control. With fieldsOnly, a name
  // is matched among form fields and their labels first, so "Search" finds the search box, not a link called Search.
  function resolve(target, fieldsOnly = false) {
    const t = norm(target);
    if (!t) return fail('EINVAL', 'no target given');
    if (/^e\d+$/.test(t)) {
      const el = refs.byId.get(t);
      if (!el) return fail('ENOENT', `unknown ref ${t}; take a snapshot first`);
      if (!el.isConnected) return fail('ENOENT', `ref ${t} is stale (the element was removed); take a new snapshot`);
      return { el };
    }
    let el = null;
    try { el = document.querySelector(t); } catch { /* not a selector: try the name below */ }
    if (el) return { el };
    const want = lower(t);
    const pool = [...document.querySelectorAll(fieldsOnly ? FIELDS : CONTROLS)].filter((e) => e.getClientRects().length > 0);
    el = pool.find((e) => lower(nameOf(e)) === want)
      ?? pool.find((e) => e.getAttribute('name') === t)
      ?? pool.find((e) => lower(nameOf(e)).includes(want));
    if (!el) return fail('ENOENT', `no element matches ${q(t)}`);
    return { el };
  }

  // The form control behind a label, or the element itself.
  function fieldOf(el) {
    if (el.tagName === 'LABEL') return el.control ?? el.querySelector('input, textarea, select');
    return el;
  }

  function click(target) {
    const r = resolve(target);
    if (r.error) return r;
    r.el.click();
    return ok({ tag: r.el.tagName.toLowerCase() });
  }

  function type(target, text) {
    const r = resolve(target, true);
    if (r.error) return r;
    const el = fieldOf(r.el);
    const textual = el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT'
      && !['checkbox', 'radio', 'file', 'submit', 'button', 'reset', 'image', 'hidden'].includes(el.type)));
    if (!textual) return fail('EINVAL', `${q(target)} is not a text field`);
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(
      el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value',
    ).set;
    setter.call(el, String(text ?? ''));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return ok(el.value);
  }

  function select(target, value) {
    const r = resolve(target, true);
    if (r.error) return r;
    const el = fieldOf(r.el);
    if (!el || el.tagName !== 'SELECT') return fail('EINVAL', `${q(target)} is not a select`);
    const want = (Array.isArray(value) ? value : [value]).map((v) => String(v));
    const matches = (o, w) => o.value === w || lower(o.text) === lower(w);
    const missing = want.filter((w) => ![...el.options].some((o) => matches(o, w)));
    if (missing.length) return fail('ENOENT', `no option matches ${q(missing.join(', '))}`);
    for (const o of el.options) o.selected = want.some((w) => matches(o, w));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return ok(el.multiple ? [...el.selectedOptions].map((o) => o.value) : el.value);
  }

  // Submits the form the way a user would: requestSubmit fires the submit event and runs validation.
  function submit(target) {
    let form;
    if (target === null || target === undefined || norm(target) === '') {
      form = document.forms[0];
    } else {
      // A field's name first (its form is submitted), then any control, such as a button called "Go".
      let r = resolve(target, true);
      if (r.error) r = resolve(target);
      if (r.error) return r;
      form = r.el.tagName === 'FORM' ? r.el : (r.el.form ?? r.el.closest('form'));
    }
    if (!form) return fail('ENOENT', 'there is no form on the page');
    if (form.requestSubmit) form.requestSubmit();
    else form.submit();
    return ok(true);
  }

  function text(target) {
    if (target === null || target === undefined) return ok(document.body ? document.body.innerText : '');
    const r = resolve(target);
    if (r.error) return r;
    return ok(r.el.innerText ?? r.el.textContent ?? '');
  }

  function html(target) {
    if (target === null || target === undefined) return ok(document.documentElement.outerHTML);
    const r = resolve(target);
    if (r.error) return r;
    return ok(r.el.outerHTML);
  }

  function query(selector) {
    let els;
    try {
      els = [...document.querySelectorAll(String(selector))];
    } catch {
      return fail('EINVAL', `invalid CSS selector ${q(selector)}`);
    }
    return ok(els.slice(0, 200).map((el) => ({
      tag: el.tagName.toLowerCase(),
      text: norm(el.textContent).slice(0, 200),
      attrs: Object.fromEntries([...el.attributes].map((a) => [a.name, a.value])),
    })));
  }

  function state() {
    return ok({ url: location.href, title: document.title });
  }

  // Links as {text, href}. The browser resolves each href to an absolute URL, so a relative link comes out whole.
  function links() {
    return ok([...document.querySelectorAll('a[href]')].slice(0, 500).map((a) => ({
      text: norm(a.textContent).slice(0, 200),
      href: a.href,
    })));
  }

  Object.defineProperty(window, '__canBrowser', {
    value: Object.freeze({ snapshot: () => ok(snapshot()), click, type, select, submit, text, html, query, links, state }),
    enumerable: false,
    configurable: false,
    writable: false,
  });
}
