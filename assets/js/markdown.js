/* PeergosEasyEdit - Markdown files (.md and the like): edited formatted (WYSIWYG) or as their source text.
 *
 * A Markdown file opens formatted, in the formatted editor (Toast UI - the library Peergos' own viewer uses); one
 * button in the bar switches to its Source, the exact text in the normal editor, and back. The formatting buttons
 * (Options → Formatting buttons) work in both: formatted they format, in Source they write the Markdown. A file that
 * cannot be edited (read-only) is shown formatted, read-only.
 * The text in the normal editor (doc.area) stays the one truth: saving, drafts, undo and the edit history all work on
 * it. A formatted edit is written back into it by mdmerge.js, which keeps every block the user did not change exactly
 * as it is in the file. Math ($…$, $$…$$, \(…\), \[…\]) is shown with KaTeX: in the formatted editor each formula is
 * one piece that keeps its exact source (edited in Source). H~2~O and X^2^ show as sub- and superscript. Pictures and
 * links to other files work inside granted folders - the app may read nothing else. The libraries are loaded with the
 * first Markdown file. An HTML file opens as a browser shows it (Preview, without its scripts); Source is its text. */
'use strict';

const Markdown = (() => {
  const EXT = /\.(md|markdown|mdown|mkd|mkdn)$/i;
  const HTML_EXT = /\.(html?|xhtml)$/i;
  const MERGE_DELAY_MS = 200;
  // The formatted editor (Toast UI) takes long to load big files - 1.8 s for 0.35 MB, 10 s for 0.58 MB (measured
  // 2026-10-26): a Markdown file bigger than this opens as text; Formatted is one click away.
  const LARGE_CHARS = 400000;
  const HTML_TAG = /<[A-Za-z!/][^>]*>/;
  const MATH_TOKEN = /PEEMATH([DI])(\d+)X/g;
  // H~2~O (not ~~struck out~~) and X^2^, as Pandoc writes them
  const SUB_SUP = /(?<![~\\])~([^\s~]+)~(?!~)|(?<![\\^])\^([^\s^]+)\^/g;
  let libs = null;          // promise: Toast UI loaded
  let katexLoad = null;
  let Parser = null;        // the editor's Markdown parser (ToastMark), to cut texts into blocks

  const isMd = doc => !!doc && EXT.test(doc.name);
  const isHtml = doc => !!doc && HTML_EXT.test(doc.name);
  // a file shown with the Markdown buttons: a .md file, or any text while the formatting buttons are on
  const usable = doc => !!doc && doc.loaded && (isMd(doc) || isHtml(doc) || App.settings.mdTools);

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = el('script', {src});
      s.onload = resolve;
      s.onerror = () => reject(new Error('could not load ' + src));
      document.head.append(s);
    });
  }

  function loadCss(href) {
    document.head.append(el('link', {rel: 'stylesheet', href}));
  }

  function loadLibs() {
    if (!libs) {
      loadCss('vendor/toastui/toastui-editor.min.css');
      libs = loadScript('vendor/toastui/toastui-editor-all.min.js').catch(e => { libs = null; throw e; });
    }
    return libs;
  }

  function loadKatex() {
    if (!katexLoad) {
      loadCss('vendor/katex/katex.min.css');
      katexLoad = loadScript('vendor/katex/katex.min.js').catch(e => { katexLoad = null; throw e; });
    }
    return katexLoad;
  }

  /* ---------- the state of one document ---------- */

  function state(doc) {
    if (!doc.md) {
      const box = el('div', {className: 'md-box'});
      box.hidden = true;
      doc.area.after(box);
      const large = isMd(doc) && doc.area.value.length > LARGE_CHARS;
      if (large)
        Docs.showBanner(doc, 'md', 'info', 'This Markdown file is large (' + Math.round(doc.area.value.length / 1000) +
                        ' thousand characters), so it opens as text: the formatted view can take a while to appear.',
                        [['OK', () => Docs.hideBanner(doc, 'md')]]);
      doc.md = {view: (isMd(doc) || isHtml(doc)) && !large ? 'formatted' : 'source', box, mode: null, shown: null, viewer: null, viewerEl: null, editor: null,
                editorEl: null, src: null, base: null, math: [], timer: null, urls: new Map(), warned: false,
                unsafe: false};
      wireBox(doc);
    }
    return doc.md;
  }

  const formatted = doc => usable(doc) && !!doc.md && doc.md.view === 'formatted';

  // Shows the formatted view or the text box of a document; called for every document on every change.
  function layout(doc, shown) {
    if (!usable(doc)) {
      if (doc.md)
        doc.md.box.hidden = true;
      return;
    }
    const st = state(doc);
    const f = st.view === 'formatted';
    doc.area.hidden = !shown || f;
    st.box.hidden = !shown || !f;
    if (shown && f)
      render(doc);
  }

  // The buttons in the bar for the document shown.
  function bar(doc) {
    const md = usable(doc);
    $('mdButtons').hidden = !md;
    const st = md ? state(doc) : null;
    const source = !!st && st.view === 'source';
    const btn = $('mdModeBtn');
    const html = isHtml(doc);
    btn.textContent = source ? (html ? 'Preview' : 'Formatted') : 'Source';
    btn.title = source ? (html ? 'The page as a browser shows it' : 'Back to the formatted view, where you edit the text as it looks')
                       : 'The text itself, exactly as it is in the file';
    btn.setAttribute('aria-pressed', String(source));
    $('mdTools').hidden = !md || html || !App.settings.mdTools || !canEdit(doc) || (!source && st.mode === 'view');
  }

  /* ---------- formatted: the formatted editor, or read-only for a file that cannot be edited ---------- */

  function render(doc) {
    const st = doc.md;
    const text = doc.area.value;
    if (isHtml(doc)) {
      if (st.mode !== 'html' || st.shown !== text)
        showHtml(doc, text);
      return;
    }
    const mode = canEdit(doc) && !st.unsafe ? 'edit' : 'view';
    if (st.mode === mode && st.shown === text)
      return;
    if (!window.toastui) {
      if (!st.box.querySelector('.md-loading'))
        st.box.append(el('p', {className: 'md-loading', textContent: 'Formatting…'}));
      loadLibs().then(() => {
        st.mode = null;
        App.changed(doc);
      }).catch(e => {
        toast('The formatted view could not be loaded: ' + describeError(e) + ' The text is shown as it is.', 'error');
        st.view = 'source';
        App.changed(doc);
      });
      return;
    }
    for (const p of st.box.querySelectorAll('.md-loading'))
      p.remove();
    if (st.mode === 'edit' && mode !== 'edit')
      flush(doc);
    if (mode === 'view')
      showViewer(doc, text);
    else
      showEditor(doc, text);
    Markdown.bar(doc);
  }

  function showViewer(doc, text) {
    const st = doc.md;
    if (!st.viewer) {
      st.viewerEl = el('div', {className: 'md-view'});
      st.box.append(st.viewerEl);
      st.viewer = toastui.Editor.factory({el: st.viewerEl, viewer: true, usageStatistics: false,
                                          customHTMLRenderer: {image: imageRenderer}});
    }
    if (st.editorEl)
      st.editorEl.hidden = true;
    if (st.htmlEl)
      st.htmlEl.hidden = true;
    st.viewerEl.hidden = false;
    const {md, math} = extractMath(text);
    st.viewer.setMarkdown(md);
    st.mode = 'view';
    st.shown = text;
    showMath(st.viewerEl, math);
    showSubSup(st.viewerEl);
    for (const img of st.viewerEl.querySelectorAll('img'))
      showPicture(doc, img.getAttribute('data-src') || img.getAttribute('src') || '', img);
  }

  // Pictures are not loaded by the browser from the address in the file (that would ask the app's own server):
  // the editor reads them from the granted folders itself.
  function imageRenderer(node, context) {
    const alt = context.getChildrenText(node);
    context.skipChildren();
    return {type: 'openTag', tagName: 'img', selfClose: true,
            attributes: {'data-src': node.destination || '', alt, title: node.title || alt}};
  }

  function showEditor(doc, text) {
    const st = doc.md;
    if (!st.editor) {
      st.editorEl = el('div', {className: 'md-edit'});
      st.box.append(st.editorEl);
      st.editor = new toastui.Editor({el: st.editorEl, initialEditType: 'wysiwyg', hideModeSwitch: true,
                                      toolbarItems: [], usageStatistics: false, height: '100%', initialValue: '',
                                      plugins: [ctx => editorPlugin(doc, ctx)],
                                      customHTMLRenderer: {image: imageRenderer}});   // its hidden preview: no requests
      st.editor.on('change', () => {
        clearTimeout(st.timer);
        st.timer = setTimeout(() => flush(doc), MERGE_DELAY_MS);
      });
    }
    if (st.viewerEl)
      st.viewerEl.hidden = true;
    if (st.htmlEl)
      st.htmlEl.hidden = true;
    st.editorEl.hidden = false;
    clearTimeout(st.timer);
    st.timer = null;
    // math goes in as one piece per formula, so the editor's Markdown rules cannot touch it
    const {md, math} = extractMath(text);
    st.math = math;
    if (math.length && !window.katex)
      loadKatex().then(() => redraw(st)).catch(() => {});
    // loaded again (after Undo, or back from Source): where the user was stays in view
    const scroller = st.editorEl.querySelector('.toastui-editor-ww-container .ProseMirror');
    const top = scroller ? scroller.scrollTop : 0;
    st.editor.setMarkdown(md, false);
    if (scroller)
      scroller.scrollTop = top;
    st.nodeMd = new WeakMap();
    st.src = split(text, st.editor);
    st.base = restore(st, editorParts(st));
    if (!st.src) {
      // the parser's positions do not fit the text: formatted editing could change parts nobody touched
      st.unsafe = true;
      Docs.showBanner(doc, 'md', 'info', 'This file cannot be edited formatted without changing parts of it you do ' +
                      'not edit, so the formatted view is read-only. Edit it in Source.', [['OK', () => Docs.hideBanner(doc, 'md')]]);
      showViewer(doc, text);
      return;
    }
    st.mode = 'edit';
    st.shown = text;
    spellcheck();
  }

  // The formatted editor's Markdown made comparable with the file's: its formulas back as they were written, and
  // H\~2\~O (how it writes a tilde) back to H~2~O.
  function restore(st, parts) {
    const fix = t => t.replace(MATH_TOKEN, (m, kind, i) => st.math[Number(i)] ? st.math[Number(i)].raw : m)
                      .replace(/\\~([^\s~\\]+)\\~/g, '~$1~');
    return {blocks: parts.blocks.map(b => ({type: b.type, text: fix(b.text)})), seps: parts.seps};
  }

  function redraw(st) {
    const view = st.editor && st.editor.wwEditor && st.editor.wwEditor.view;
    if (view)
      view.dispatch(view.state.tr.setMeta('peeRedraw', true));
  }

  // The formatted editor's Markdown, block by block. Each top-level block is converted once and kept until it
  // changes (ProseMirror keeps an unchanged block as the same object): converting the whole of a big file after
  // every pause took 140 ms for 0.2 MB (2026-10-26). Block kinds named as the Markdown parser names them.
  const BLOCK_KINDS = {bulletList: 'list', orderedList: 'list'};

  function editorParts(st) {
    const pmDoc = st.editor.wwEditor.view.state.doc;
    const blocks = [];
    pmDoc.forEach(node => {
      let md = st.nodeMd.get(node);
      if (md === undefined) {
        md = st.editor.convertor.toMarkdownText(pmDoc.type.create(null, node)).replace(/\n+$/, '');
        st.nodeMd.set(node, md);
      }
      if (md.trim())
        blocks.push({type: BLOCK_KINDS[node.type.name] || node.type.name, text: md});
    });
    return {blocks, seps: []};
  }

  // A text cut into top-level blocks by the editor's own Markdown parser (ToastMark), used on its own: a hidden
  // editor loading the text scrolled the editor being typed in (2026-10-25).
  function split(text, editor) {
    if (!Parser)
      Parser = editor.toastMark.constructor;
    const nodes = [];
    for (let n = new Parser(text).getRootNode().firstChild; n; n = n.next)
      nodes.push({type: n.type, sourcepos: n.sourcepos});
    const parts = MdMerge.split(text, nodes);
    return parts && MdMerge.join(parts) === text ? parts : null;
  }

  // Writes what was changed in the formatted editor into the text; nothing else of the file changes.
  function flush(doc) {
    const st = doc.md;
    if (!st || st.mode !== 'edit' || !st.src)
      return;
    clearTimeout(st.timer);
    st.timer = null;
    // the text was changed elsewhere (Source, undo, a restored draft) since the formatted editor got it: what the
    // formatted editor holds is older and must not be written back; it is loaded again when shown
    if (doc.area.value !== st.shown)
      return;
    const r = MdMerge.merge(st.src, st.base, restore(st, editorParts(st)));
    const old = doc.area.value;
    if (r.text === old)
      return;
    doc.area.value = r.text;
    st.shown = r.text;
    Docs.edited(doc, r.text.length > old.length ? 'type' : r.text.length < old.length ? 'delete' : 'other');
    if (!st.warned && r.replaced.some(i => HTML_TAG.test(st.src.blocks[i].text))) {
      st.warned = true;
      Docs.showBanner(doc, 'md', 'info', 'A part you changed had HTML in it, which the formatted editor cannot keep. ' +
                      'Undo brings it back; in Source you can edit it with its HTML.', [['OK', () => Docs.hideBanner(doc, 'md')]]);
    }
  }

  /* ---------- HTML files: the page as a browser shows it ---------- */

  // In a frame without scripts, forms or pop-ups (sandbox), under the app's own Content-Security-Policy: nothing is
  // loaded from other web sites. Only the editor itself looks inside (allow-same-origin, no allow-scripts) to show
  // pictures and stylesheets from the granted folders and to follow links, as in Markdown.
  function showHtml(doc, text) {
    const st = doc.md;
    if (!st.htmlEl) {
      st.htmlEl = el('iframe', {className: 'md-html', title: 'Preview'});
      st.htmlEl.setAttribute('sandbox', 'allow-same-origin');
      st.box.append(st.htmlEl);
    }
    for (const e of [st.viewerEl, st.editorEl])
      if (e)
        e.hidden = true;
    for (const p of st.box.querySelectorAll('.md-loading'))
      p.remove();
    st.htmlEl.hidden = false;
    const page = new DOMParser().parseFromString(text, 'text/html');
    const scripts = page.querySelectorAll('script');
    for (const e of [...scripts, ...page.querySelectorAll('base')])
      e.remove();
    for (const img of page.querySelectorAll('img[src]')) {
      img.setAttribute('data-pee-src', img.getAttribute('src'));
      img.removeAttribute('src');
    }
    for (const link of page.querySelectorAll('link[href]')) {
      link.setAttribute('data-pee-href', link.getAttribute('href'));
      link.removeAttribute('href');
    }
    st.htmlEl.onload = () => decorateHtml(doc, st.htmlEl);
    st.htmlEl.srcdoc = '<!DOCTYPE html>' + page.documentElement.outerHTML;
    st.mode = 'html';
    st.shown = text;
    if (scripts.length && !st.warned) {
      st.warned = true;
      Docs.showBanner(doc, 'md', 'info', 'This page has scripts; the preview does not run them.',
                      [['OK', () => Docs.hideBanner(doc, 'md')]]);
    }
  }

  function decorateHtml(doc, frame) {
    const page = frame.contentDocument;
    if (!page)
      return;
    for (const img of page.querySelectorAll('img[data-pee-src]'))
      showPicture(doc, img.getAttribute('data-pee-src'), img);
    for (const link of page.querySelectorAll('link[data-pee-href]')) {
      if (!/\bstylesheet\b/i.test(link.getAttribute('rel') || ''))
        continue;
      const path = pathOf(doc, link.getAttribute('data-pee-href'));
      const loc = path && Files.readable(path);
      if (loc)
        Peergos.readUrl(Loc.url(loc)).then(bytes => {
          link.replaceWith(Object.assign(page.createElement('style'), {textContent: TextCodec.decode(bytes).text}));
        }).catch(() => {});
    }
    page.addEventListener('click', e => {
      const a = e.target.closest && e.target.closest('a[href]');
      if (!a)
        return;
      e.preventDefault();
      const href = a.getAttribute('href');
      if (href.startsWith('#')) {
        const target = page.getElementById(href.slice(1)) || page.getElementsByName(href.slice(1))[0];
        if (target)
          target.scrollIntoView();
        return;
      }
      follow(doc, href);
    });
  }

  /* ---------- inside the formatted editor: pictures, formulas, sub- and superscript ---------- */

  function editorPlugin(doc, ctx) {
    const {Plugin, TextSelection} = ctx.pmState;
    const {Decoration, DecorationSet} = ctx.pmView;
    const st = doc.md;
    const inCode = (node, parent) => node.marks.some(m => m.type.name === 'code') || (parent && parent.type.name === 'codeBlock');

    function tokens(pmDoc) {
      const out = [];
      pmDoc.descendants((node, pos, parent) => {
        if (!node.isText || inCode(node, parent))
          return;
        for (const m of node.text.matchAll(MATH_TOKEN))
          out.push({from: pos + m.index, to: pos + m.index + m[0].length, text: m[0], i: Number(m[2])});
      });
      return out;
    }

    function decorations(pmState) {
      const decos = [];
      for (const t of tokens(pmState.doc)) {
        const item = st.math[t.i];
        if (!item)
          continue;
        decos.push(Decoration.widget(t.from, () => mathWidget(item), {side: 1, ignoreSelection: true,
                                                                      key: 'm' + t.i + (window.katex ? 'k' : '')}));
        decos.push(Decoration.inline(t.from, t.to, {class: 'pee-hidden'}));
      }
      const sel = pmState.selection;
      pmState.doc.descendants((node, pos, parent) => {
        if (!node.isText || inCode(node, parent))
          return;
        for (const m of node.text.matchAll(SUB_SUP)) {
          const from = pos + m.index, to = from + m[0].length;
          const near = sel.from <= to && sel.to >= from;     // the ~ or ^ shown while the caret is at it
          decos.push(Decoration.inline(from, from + 1, {class: near ? 'pee-mark' : 'pee-hidden'}));
          decos.push(Decoration.inline(from + 1, to - 1, {class: m[1] !== undefined ? 'pee-sub' : 'pee-sup'}));
          decos.push(Decoration.inline(to - 1, to, {class: near ? 'pee-mark' : 'pee-hidden'}));
        }
      });
      return DecorationSet.create(pmState.doc, decos);
    }

    const plugin = new Plugin({
      props: {decorations},
      // a formula is one piece: the caret does not go into it, and deleting part of it deletes all of it
      appendTransaction(trs, oldState, newState) {
        const tr = newState.tr;
        let changed = false;
        if (trs.some(t => t.docChanged)) {
          for (const t of tokens(oldState.doc)) {
            let from = t.from, to = t.to;
            for (const x of trs) {
              from = x.mapping.map(from, 1);
              to = x.mapping.map(to, -1);
            }
            if (to > from && newState.doc.textBetween(from, to) !== t.text) {
              tr.delete(tr.mapping.map(from), tr.mapping.map(to));
              changed = true;
            }
          }
        }
        const sel = tr.selection;
        if (sel.empty) {
          const inside = tokens(tr.doc).find(t => sel.head > t.from && sel.head < t.to);
          if (inside) {
            const forward = oldState.selection.head <= inside.from;
            tr.setSelection(TextSelection.create(tr.doc, forward ? inside.to : inside.from));
            changed = true;
          }
        }
        return changed ? tr : null;
      },
    });
    return {
      wysiwygPlugins: [() => plugin],
      // pictures read from the granted folders; the file's own address stays in the text
      wysiwygNodeViews: {
        image: node => {
          const img = el('img', {alt: node.attrs.altText || ''});
          showPicture(doc, node.attrs.imageUrl || '', img);
          return {dom: img, ignoreMutation: () => true};
        },
      },
    };
  }

  function mathWidget(item) {
    const span = el('span', {className: 'pee-math-widget' + (item.display ? ' display' : ''), title: 'Formula: edit it in Source'});
    span.contentEditable = 'false';
    if (window.katex)
      katex.render(item.tex, span, {displayMode: item.display, throwOnError: false});
    else
      span.textContent = item.raw;
    return span;
  }

  /* ---------- math, sub- and superscript in the read-only view ---------- */

  // Math is cut out of the text before it is formatted (the formatter would take _ and * in it for emphasis) and
  // put back as KaTeX. Code is left alone.
  function extractMath(text) {
    const math = [];
    const code = [];
    const keep = s => { code.push(s); return '\u0000' + (code.length - 1) + '\u0000'; };
    const put = (raw, tex, display) => { math.push({raw, tex, display}); return 'PEEMATH' + (display ? 'D' : 'I') + (math.length - 1) + 'X'; };
    let t = text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, keep)
                .replace(/(`+)[^`\n][\s\S]*?\1/g, keep);
    t = t.replace(/\$\$([\s\S]+?)\$\$/g, (m, tex) => put(m, tex, true))
         .replace(/\\\[([\s\S]+?)\\\]/g, (m, tex) => put(m, tex, true))
         .replace(/\\\(([\s\S]+?)\\\)/g, (m, tex) => put(m, tex, false))
         .replace(/(^|[^\\$])(\$(?=\S)([^$\n]*?[^\s\\])\$)(?!\d)/g, (m, before, raw, tex) => before + put(raw, tex, false));
    t = t.replace(/\u0000(\d+)\u0000/g, (m, i) => code[Number(i)]);
    return {md: t, math};
  }

  function textNodes(root) {
    const found = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: n => n.parentElement.closest('code, pre, .katex, .pee-math') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT});
    for (let n = walker.nextNode(); n; n = walker.nextNode())
      found.push(n);
    return found;
  }

  function showMath(root, math) {
    if (!math.length)
      return;
    const spans = [];
    for (const n of textNodes(root).filter(x => x.nodeValue.includes('PEEMATH'))) {
      const frag = document.createDocumentFragment();
      for (const p of n.nodeValue.split(/(PEEMATH[DI]\d+X)/)) {
        const m = /^PEEMATH([DI])(\d+)X$/.exec(p);
        if (!m) {
          frag.append(p);
          continue;
        }
        const item = math[Number(m[2])];
        const span = el('span', {className: 'pee-math' + (item.display ? ' display' : ''), textContent: item.raw});
        spans.push([span, item]);
        frag.append(span);
      }
      n.replaceWith(frag);
    }
    loadKatex().then(() => {
      for (const [span, item] of spans)
        katex.render(item.tex, span, {displayMode: item.display, throwOnError: false});
    }).catch(() => {});   // the math stays as text
  }

  function showSubSup(root) {
    for (const n of textNodes(root)) {
      const v = n.nodeValue;
      if (!v.includes('~') && !v.includes('^'))
        continue;
      const frag = document.createDocumentFragment();
      let at = 0, any = false;
      for (const m of v.matchAll(SUB_SUP)) {
        frag.append(v.slice(at, m.index), el(m[1] !== undefined ? 'sub' : 'sup', {textContent: m[1] !== undefined ? m[1] : m[2]}));
        at = m.index + m[0].length;
        any = true;
      }
      if (any) {
        frag.append(v.slice(at));
        n.replaceWith(frag);
      }
    }
  }

  /* ---------- pictures and links ---------- */

  // The file's folder as a full path (/user/...), or null for a new text.
  function folderOf(doc) {
    const loc = doc.lasting || doc.loc;
    if (loc.kind === 'grant') {
      const root = Files.grantPath(loc.grantId);
      if (!root)
        return null;
      return root + (loc.rel.includes('/') ? '/' + loc.rel.substring(0, loc.rel.lastIndexOf('/')) : '');
    }
    return loc.kind === 'new' ? null : loc.path.substring(0, loc.path.lastIndexOf('/'));
  }

  // A link or picture address of the file as a full path in Peergos, or null for other web sites and the like.
  function pathOf(doc, ref) {
    if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(ref))
      return null;
    let r = ref.replace(/[?#].*$/, '');
    try {
      r = decodeURIComponent(r);
    } catch (e) {
      // as it is
    }
    if (!r)
      return null;
    const folder = folderOf(doc);
    if (!r.startsWith('/') && folder === null)
      return null;
    const out = [];
    for (const part of (r.startsWith('/') ? r : folder + '/' + r).split('/')) {
      if (part === '..')
        out.pop();
      else if (part && part !== '.')
        out.push(part);
    }
    return '/' + out.join('/');
  }

  // The address of a file as written into the Markdown file: relative to its folder when it can be.
  function addressFor(doc, path) {
    const folder = folderOf(doc);
    if (!folder)
      return encodeURI(path);
    const from = folder.split('/').filter(Boolean), to = path.split('/').filter(Boolean);
    let same = 0;
    while (same < from.length && same < to.length - 1 && from[same] === to[same])
      same++;
    if (same < 1)
      return encodeURI(path);
    return encodeURI([...Array(from.length - same).fill('..'), ...to.slice(same)].join('/'));
  }

  const PICTURE_TYPES = {png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
                         svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif'};
  const isPicture = path => !!PICTURE_TYPES[path.substring(path.lastIndexOf('.') + 1).toLowerCase()];

  function showPicture(doc, src, img) {
    const st = doc.md;
    img.removeAttribute('src');
    if (/^data:image\//i.test(src)) {
      img.src = src;
      return;
    }
    if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(src)) {
      img.title = 'Pictures from other web sites cannot be shown inside Peergos';
      return;
    }
    const path = pathOf(doc, src);
    const loc = path && Files.readable(path);
    if (!loc) {
      img.title = 'The editor can show pictures only from folders you let it use (File → Open… → Add folders…)';
      return;
    }
    if (st.urls.has(path)) {
      img.src = st.urls.get(path);
      return;
    }
    Peergos.readUrl(Loc.url(loc)).then(bytes => {
      const ext = path.substring(path.lastIndexOf('.') + 1).toLowerCase();
      const url = URL.createObjectURL(new Blob([bytes], {type: PICTURE_TYPES[ext] || 'application/octet-stream'}));
      st.urls.set(path, url);
      img.src = url;
    }).catch(() => {
      img.title = 'Picture not found: ' + path;
    });
  }

  // Links: other web sites in a new tab, files in granted folders in the editor.
  function follow(doc, href) {
    if (!href || href.startsWith('#'))
      return;
    if (/^https?:\/\//i.test(href)) {
      window.open(href, '_blank', 'noopener');
      return;
    }
    const path = pathOf(doc, href);
    const loc = path && (Files.inGrant(path) || Files.readable(path));
    if (!loc) {
      toast(path ? '"' + path + '" is outside the folders you let the editor use (File → Open… → Add folders…).'
                 : 'This kind of link cannot be opened from here.', 'error');
      return;
    }
    openLoc(loc);
  }

  function wireBox(doc) {
    const st = doc.md;
    // a click follows a link in the read-only view; while editing formatted, Ctrl+click does
    st.box.addEventListener('click', e => {
      const a = e.target.closest('a');
      if (!a || (st.mode === 'edit' && !(e.ctrlKey || e.metaKey)))
        return;
      e.preventDefault();
      follow(doc, a.getAttribute('href') || '');
    });
    // Undo and Redo of the editor, also while editing formatted (not the formatted editor's own)
    st.box.addEventListener('keydown', e => {
      if (st.mode !== 'edit' || !(e.ctrlKey || e.metaKey) || e.altKey)
        return;
      const k = e.key.toLowerCase();
      if (k === 'z' || k === 'y') {
        e.preventDefault();
        e.stopPropagation();
        flush(doc);
        if (k === 'y' || e.shiftKey) redo(); else undo();
      }
    }, true);
  }

  /* ---------- the formatting buttons ---------- */

  const COMMANDS = {bold: 'bold', italic: 'italic', strike: 'strike', code: 'code', codeblock: 'codeBlock',
                    ul: 'bulletList', ol: 'orderedList', task: 'taskList', quote: 'blockQuote', hr: 'hr'};

  // A picture from the granted folders (or any file through Peergos' picker); its address relative to the file.
  async function pickPicture(doc) {
    let path = null;
    if (Files.supported()) {
      const chosen = Files.show('open', '', doc.lasting || doc.loc);
      $('fdTitle').textContent = 'Insert a picture';
      $('fdOk').textContent = 'Insert';
      const loc = await chosen;
      if (!loc)
        return null;
      if (loc.picker) {
        const answer = await Peergos.pickFile().catch(() => []);
        path = answer.length ? answer[0] : null;
      } else {
        path = Files.grantPath(loc.grantId) + '/' + loc.rel;
      }
    } else {
      const answer = await Peergos.pickFile().catch(() => []);
      path = answer.length ? answer[0] : null;
    }
    if (!path)
      return null;
    if (!isPicture(path))
      toast('"' + path.substring(path.lastIndexOf('/') + 1) + '" does not look like a picture; it is linked as one anyway.');
    else if (!Files.readable(path))
      toast('The picture is outside the folders you let the editor use, so the editor cannot show it (Peergos can).');
    const name = path.substring(path.lastIndexOf('/') + 1);
    return {url: addressFor(doc, path), alt: name.replace(/\.[^.]*$/, '')};
  }

  async function tool(doc, name) {
    const st = doc.md;
    if (st.view === 'formatted' && st.mode === 'edit') {
      const ed = st.editor;
      if (COMMANDS[name]) {
        ed.exec(COMMANDS[name]);
      } else if (/^h[1-3]$/.test(name)) {
        ed.exec('heading', {level: Number(name[1])});
      } else if (name === 'table') {
        ed.exec('addTable', {rowCount: 3, columnCount: 2});
      } else if (name === 'link') {
        const text = ed.getSelectedText();
        const url = await askText('Link address:', 'https://', 'Add link');
        if (url && url.trim())
          ed.exec('addLink', {linkUrl: url.trim(), linkText: text || url.trim()});
      } else if (name === 'image') {
        const pic = await pickPicture(doc);
        if (pic)
          ed.exec('addImage', {imageUrl: pic.url, altText: pic.alt});
      }
      ed.focus();
      return;
    }
    await sourceTool(doc, name);
  }

  // The same buttons on the Markdown text: they write the syntax around the selection or before its lines.
  async function sourceTool(doc, name) {
    const area = doc.area;
    const v = area.value, s = area.selectionStart, e = area.selectionEnd, sel = v.slice(s, e);
    const lineStart = v.lastIndexOf('\n', s - 1) + 1;
    let lineEnd = v.indexOf('\n', e > s ? e - 1 : e);
    if (lineEnd < 0)
      lineEnd = v.length;
    const lines = v.slice(lineStart, lineEnd).split('\n');
    const put = (start, end, text, selStart, selEnd) => {
      area.focus();
      area.setRangeText(text, start, end);
      area.setSelectionRange(selStart, selEnd);
      area.dispatchEvent(new Event('input'));
    };
    const wrap = (mark, placeholder) => {
      const t = sel || placeholder;
      put(s, e, mark + t + mark, s + mark.length, s + mark.length + t.length);
    };
    const prefix = fn => {
      const text = lines.map(fn).join('\n');
      put(lineStart, lineEnd, text, lineStart, lineStart + text.length);
    };
    const block = text => {
      const before = lineStart > 0 && v[lineStart - 1] === '\n' && (lineStart < 2 || v[lineStart - 2] !== '\n') ? '\n' : '';
      put(lineEnd, lineEnd, before + '\n' + text, lineEnd + before.length + 1, lineEnd + before.length + 1 + text.length);
    };
    switch (name) {
      case 'bold': return wrap('**', 'bold');
      case 'italic': return wrap('*', 'italic');
      case 'strike': return wrap('~~', 'struck out');
      case 'code': return wrap('`', 'code');
      case 'h1': case 'h2': case 'h3':
        return prefix(l => '#'.repeat(Number(name[1])) + ' ' + l.replace(/^#{1,6}\s*/, ''));
      case 'ul': return prefix(l => '- ' + l);
      case 'ol': return prefix((l, i) => (i + 1) + '. ' + l);
      case 'task': return prefix(l => '- [ ] ' + l);
      case 'quote': return prefix(l => '> ' + l);
      case 'codeblock': {
        const text = '```\n' + lines.join('\n') + '\n```';
        return put(lineStart, lineEnd, text, lineStart + 4, lineStart + 4 + lines.join('\n').length);
      }
      case 'hr': return block('---\n');
      case 'table': return block('| Column 1 | Column 2 |\n| --- | --- |\n|  |  |\n');
      case 'link': {
        const url = await askText('Link address:', 'https://', 'Add link');
        if (url && url.trim())
          put(s, e, '[' + (sel || url.trim()) + '](' + url.trim() + ')', s + 1, s + 1 + (sel || url.trim()).length);
        return;
      }
      case 'image': {
        const pic = await pickPicture(doc);
        if (pic)
          put(s, e, '![' + (sel || pic.alt) + '](' + pic.url + ')', s + 2, s + 2 + (sel || pic.alt).length);
        return;
      }
    }
  }

  /* ---------- wiring ---------- */

  // Ctrl+B and Ctrl+I in the Markdown text (Source), as in the formatted view
  function sourceKey(doc, e) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || !usable(doc) || isHtml(doc) || !canEdit(doc) ||
        state(doc).view !== 'source')
      return;
    const k = e.key.toLowerCase();
    if (k === 'b' || k === 'i') {
      e.preventDefault();
      sourceTool(doc, k === 'b' ? 'bold' : 'italic');
    }
  }

  // Options → Spell check, also in the formatted editor
  function spellcheck() {
    for (const d of docs) {
      const pm = d.md && d.md.editorEl && d.md.editorEl.querySelector('.toastui-editor-ww-container .ProseMirror');
      if (pm)
        pm.setAttribute('spellcheck', String(App.settings.spellcheck));
    }
  }

  function setView(doc, view) {
    flush(doc);
    const st = state(doc);
    if (view === 'source')
      st.mode = null;      // nothing more comes from the formatted editor until it is shown again
    st.view = view;
    App.changed(doc);
    LineNumbers.refresh();
  }

  function wire() {
    $('mdModeBtn').onclick = () => {
      if (usable(active))
        setView(active, state(active).view === 'source' ? 'formatted' : 'source');
    };
    for (const b of $('mdTools').querySelectorAll('button[data-md]')) {
      b.addEventListener('mousedown', e => e.preventDefault());   // keep the selection in the text
      b.onclick = () => usable(active) && tool(active, b.dataset.md);
    }
  }

  function drop(doc) {
    const st = doc.md;
    if (!st)
      return;
    clearTimeout(st.timer);
    for (const url of st.urls.values())
      URL.revokeObjectURL(url);
    if (st.editor)
      st.editor.destroy();
    if (st.viewer)
      st.viewer.destroy();
    st.box.remove();
    doc.md = null;
  }

  return {isMd, isHtml, formatted, sourceKey, spellcheck, showSource: doc => setView(doc, 'source'), layout, bar, flush, drop, wire, extractMath, pathOf, addressFor};
})();
