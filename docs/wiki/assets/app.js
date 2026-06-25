"use strict";

/* ============================================================================
 * Project Working-Notes Wiki — vanilla JS, no framework, no build, no deps.
 *   - tiny dependency-free Markdown renderer (md())
 *   - hash-based routing for content pages
 *   - notes thread bound to the current topic (GET/POST /api/notes)
 * ========================================================================== */

const DEFAULT_SLUG = "home";
const AUTHOR = "you";

/* ---------------------------------------------------------------------------
 * HTML escaping — used everywhere text or code becomes HTML, to avoid injection.
 * ------------------------------------------------------------------------- */
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ===========================================================================
 * Minimal Markdown renderer.
 * Supports: headings, paragraphs, bold/italic, inline code, fenced code,
 * unordered + ordered lists, links, blockquotes, horizontal rules, and
 * GFM pipe tables. All text and code is HTML-escaped before insertion.
 * ========================================================================= */

/* Inline-level: code spans first (so their contents aren't further processed),
 * then bold/italic/links over the escaped remainder. */
function renderInline(text) {
  // Split out inline code spans so we don't format inside them.
  const parts = [];
  let last = 0;
  const codeRe = /`([^`]+)`/g;
  let m;
  while ((m = codeRe.exec(text)) !== null) {
    parts.push({ code: false, value: text.slice(last, m.index) });
    parts.push({ code: true, value: m[1] });
    last = m.index + m[0].length;
  }
  parts.push({ code: false, value: text.slice(last) });

  return parts
    .map((p) => {
      if (p.code) return "<code>" + esc(p.value) + "</code>";
      return formatText(p.value);
    })
    .join("");
}

/* Format non-code text: escape, then apply links / bold / italic on the
 * escaped string (our markers — *, _, [], () — survive escaping). */
function formatText(raw) {
  let s = esc(raw);

  // Links: [text](url)  — url is attribute-escaped already via esc().
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (full, label, url) => {
    const safeUrl = sanitizeUrl(url);
    return '<a href="' + safeUrl + '">' + label + "</a>";
  });

  // Bold: **text** or __text__
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");

  // Italic: *text* or _text_
  s = s.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_])_([^_\s][^_]*?)_/g, "$1<em>$2</em>");

  return s;
}

/* Only allow benign URL schemes / relative / hash links. */
function sanitizeUrl(url) {
  const u = url.trim();
  if (/^javascript:/i.test(u) || /^data:/i.test(u) || /^vbscript:/i.test(u)) {
    return "#";
  }
  return esc(u);
}

function isTableSep(line) {
  // | --- | :--: | --- |  (separator row)
  return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(line);
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function renderTable(headerLine, rows) {
  const headers = splitRow(headerLine);
  let html = "<table><thead><tr>";
  headers.forEach((h) => (html += "<th>" + renderInline(h) + "</th>"));
  html += "</tr></thead><tbody>";
  rows.forEach((r) => {
    const cells = splitRow(r);
    html += "<tr>";
    for (let i = 0; i < headers.length; i++) {
      html += "<td>" + renderInline(cells[i] || "") + "</td>";
    }
    html += "</tr>";
  });
  html += "</tbody></table>";
  return html;
}

function md(src) {
  const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
  let html = "";
  let i = 0;

  // Buffers for grouped block elements.
  let para = [];
  const flushPara = () => {
    if (para.length) {
      html += "<p>" + renderInline(para.join(" ")) + "</p>";
      para = [];
    }
  };

  while (i < lines.length) {
    let line = lines[i];

    // Fenced code block: ``` ... ```
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      flushPara();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      html += "<pre><code>" + esc(buf.join("\n")) + "</code></pre>";
      continue;
    }

    // Blank line ends a paragraph.
    if (/^\s*$/.test(line)) {
      flushPara();
      i++;
      continue;
    }

    // Horizontal rule.
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara();
      html += "<hr>";
      i++;
      continue;
    }

    // Heading.
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushPara();
      const level = heading[1].length;
      html += "<h" + level + ">" + renderInline(heading[2].trim()) + "</h" + level + ">";
      i++;
      continue;
    }

    // Table: a header line immediately followed by a separator row.
    if (line.indexOf("|") !== -1 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushPara();
      const headerLine = line;
      i += 2; // header + separator
      const rows = [];
      while (i < lines.length && lines[i].indexOf("|") !== -1 && !/^\s*$/.test(lines[i])) {
        rows.push(lines[i]);
        i++;
      }
      html += renderTable(headerLine, rows);
      continue;
    }

    // Blockquote (consecutive > lines).
    if (/^\s*>/.test(line)) {
      flushPara();
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      html += "<blockquote>" + md(buf.join("\n")) + "</blockquote>";
      continue;
    }

    // Unordered list.
    if (/^\s*[-*+]\s+/.test(line)) {
      flushPara();
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i++;
      }
      html += "<ul>" + items.map((it) => "<li>" + renderInline(it) + "</li>").join("") + "</ul>";
      continue;
    }

    // Ordered list.
    if (/^\s*\d+[.)]\s+/.test(line)) {
      flushPara();
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
        i++;
      }
      html += "<ol>" + items.map((it) => "<li>" + renderInline(it) + "</li>").join("") + "</ol>";
      continue;
    }

    // Otherwise: paragraph text.
    para.push(line.trim());
    i++;
  }
  flushPara();
  return html;
}

/* ===========================================================================
 * State + DOM refs
 * ========================================================================= */
const state = {
  nav: [],
  slug: DEFAULT_SLUG,
  replyTo: null, // {id} when replying to a question
};

const el = {
  nav: document.getElementById("nav"),
  content: document.getElementById("content"),
  notesTopic: document.getElementById("notes-topic"),
  notesStatus: document.getElementById("notes-status"),
  notesThread: document.getElementById("notes-thread"),
  form: document.getElementById("note-form"),
  type: document.getElementById("note-type"),
  text: document.getElementById("note-text"),
  submit: document.getElementById("note-submit"),
  error: document.getElementById("note-error"),
  replyBanner: document.getElementById("note-reply-banner"),
  replyCancel: document.getElementById("note-reply-cancel"),
};

/* ===========================================================================
 * Nav
 * ========================================================================= */
async function loadNav() {
  try {
    const res = await fetch("nav.json", { cache: "no-store" });
    state.nav = await res.json();
  } catch (e) {
    state.nav = [];
    el.nav.innerHTML = '<div class="nav-loading">Could not load nav.json.</div>';
    return;
  }
  renderNav();
}

function renderNav() {
  const groups = [];
  const byGroup = {};
  state.nav.forEach((item) => {
    if (!byGroup[item.group]) {
      byGroup[item.group] = [];
      groups.push(item.group);
    }
    byGroup[item.group].push(item);
  });

  let html = "";
  groups.forEach((g) => {
    html += '<div class="nav-group"><div class="nav-group-title">' + esc(g) + "</div>";
    byGroup[g].forEach((item) => {
      const active = item.slug === state.slug ? " active" : "";
      html +=
        '<a class="nav-item' + active + '" href="#/' + esc(item.slug) + '">' +
        esc(item.title) + "</a>";
    });
    html += "</div>";
  });
  el.nav.innerHTML = html;
}

function titleForSlug(slug) {
  const found = state.nav.find((n) => n.slug === slug);
  return found ? found.title : slug;
}

function slugIsKnown(slug) {
  return state.nav.some((n) => n.slug === slug);
}

/* ===========================================================================
 * Content routing
 * ========================================================================= */
function currentSlugFromHash() {
  const h = location.hash.replace(/^#\/?/, "").trim();
  return h || DEFAULT_SLUG;
}

async function loadContent(slug) {
  try {
    const res = await fetch("content/" + encodeURIComponent(slug) + ".md", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const text = await res.text();
    el.content.innerHTML = md(text);
  } catch (e) {
    el.content.innerHTML =
      "<h1>Page not found</h1><p>Could not load <code>content/" +
      esc(slug) + ".md</code>.</p>";
  }
}

async function route() {
  let slug = currentSlugFromHash();
  if (state.nav.length && !slugIsKnown(slug)) {
    slug = DEFAULT_SLUG;
  }
  state.slug = slug;
  renderNav();
  clearReply();
  await Promise.all([loadContent(slug), loadNotes(slug)]);
}

/* ===========================================================================
 * Notes
 * ========================================================================= */
function authorChipClass(author) {
  if (author === "you") return "you";
  if (author === "claude") return "claude";
  return "other";
}

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString();
}

function renderNotes(notes) {
  if (!notes.length) {
    el.notesThread.innerHTML =
      '<div class="notes-empty">No notes yet for this topic. Add one below.</div>';
    return;
  }

  // Index answers by parentId so a question can know if it's answered.
  const childAnswers = {};
  notes.forEach((n) => {
    if (n.type === "answer" && n.parentId) {
      (childAnswers[n.parentId] = childAnswers[n.parentId] || []).push(n);
    }
  });

  let html = "";
  notes.forEach((n) => {
    const isAnswered =
      n.type === "question" && childAnswers[n.id] && childAnswers[n.id].length > 0;
    const isReply = !!n.parentId;

    html += '<div class="note type-' + esc(n.type) + (isReply ? " is-reply" : "") + '">';
    html += '<div class="note-meta">';
    html += '<span class="note-typetag">' + esc(n.type) + "</span>";
    html +=
      '<span class="chip ' + authorChipClass(n.author) + '">' + esc(n.author) + "</span>";
    if (n.type === "question" && !isAnswered) {
      html += '<span class="badge-unanswered">unanswered</span>';
    }
    html += '<span class="note-time">' + esc(fmtTime(n.createdAt)) + "</span>";
    html += "</div>";

    html += '<div class="note-body">' + md(n.text || "") + "</div>";

    if (n.type === "question") {
      html += '<button class="note-reply-btn" data-reply="' + esc(n.id) + '">Reply</button>';
    }
    html += "</div>";
  });
  el.notesThread.innerHTML = html;

  el.notesThread.querySelectorAll("[data-reply]").forEach((btn) => {
    btn.addEventListener("click", () => setReply(btn.getAttribute("data-reply")));
  });
}

async function loadNotes(slug) {
  el.notesTopic.textContent = slug;
  el.notesStatus.textContent = "";
  el.notesStatus.classList.remove("error");
  try {
    const res = await fetch("api/notes?topic=" + encodeURIComponent(slug), { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const notes = await res.json();
    renderNotes(notes);
  } catch (e) {
    el.notesThread.innerHTML = "";
    el.notesStatus.textContent =
      "Notes API unreachable — start the server with `python tools/wiki-serve.py` to read/add notes.";
    el.notesStatus.classList.add("error");
  }
}

/* ---- reply handling ---- */
function setReply(id) {
  state.replyTo = id;
  el.replyBanner.hidden = false;
  el.type.value = "question"; // visual; answers are posted with type=answer
  el.type.disabled = true;
  el.text.focus();
}
function clearReply() {
  state.replyTo = null;
  el.replyBanner.hidden = true;
  el.type.disabled = false;
}

/* ---- submit ---- */
async function submitNote(ev) {
  ev.preventDefault();
  const text = el.text.value.trim();
  el.error.hidden = true;
  if (!text) {
    showFormError("Please enter some text.");
    return;
  }

  const replying = !!state.replyTo;
  const body = {
    topic: state.slug,
    type: replying ? "answer" : el.type.value,
    author: AUTHOR,
    text: text,
    parentId: replying ? state.replyTo : null,
  };

  el.submit.disabled = true;
  try {
    const res = await fetch("api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = "HTTP " + res.status;
      try {
        const j = await res.json();
        if (j && j.error) msg = j.error;
      } catch (_) {}
      throw new Error(msg);
    }
    el.text.value = "";
    clearReply();
    await loadNotes(state.slug);
  } catch (e) {
    showFormError("Could not save: " + e.message);
  } finally {
    el.submit.disabled = false;
  }
}

function showFormError(msg) {
  el.error.textContent = msg;
  el.error.hidden = false;
}

/* ===========================================================================
 * Boot
 * ========================================================================= */
function init() {
  el.form.addEventListener("submit", submitNote);
  el.replyCancel.addEventListener("click", clearReply);
  window.addEventListener("hashchange", route);

  loadNav().then(route);
}

init();
