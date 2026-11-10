/* Kitaplığım — book information lookup (Google Books, then Open Library). */
const Lookup = (() => {
  const GB = "https://www.googleapis.com/books/v1/volumes";

  function cleanIsbn(s) { return String(s || "").replace(/[^0-9Xx]/g, "").toUpperCase(); }

  function isValidIsbn(s) {
    s = cleanIsbn(s);
    if (s.length === 13 && /^\d{13}$/.test(s)) {
      let sum = 0; for (let i = 0; i < 12; i++) sum += +s[i] * (i % 2 ? 3 : 1);
      return (10 - (sum % 10)) % 10 === +s[12];
    }
    if (s.length === 10 && /^\d{9}[\dX]$/.test(s)) {
      let sum = 0; for (let i = 0; i < 10; i++) sum += (s[i] === "X" ? 10 : +s[i]) * (10 - i);
      return sum % 11 === 0;
    }
    return false;
  }

  function httpsThumb(u) {
    if (!u) return "";
    return u.replace(/^http:/, "https:").replace("&edge=curl", "");
  }

  async function getJson(url, ms = 9000) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  }

  function fromGoogle(item) {
    const v = item.volumeInfo || {};
    const ids = v.industryIdentifiers || [];
    const isbn = (ids.find(i => i.type === "ISBN_13") || ids.find(i => i.type === "ISBN_10") || {}).identifier || "";
    return {
      title: [v.title, v.subtitle].filter(Boolean).join(": "),
      author: (v.authors || []).join(", "),
      publisher: v.publisher || "",
      year: (v.publishedDate || "").slice(0, 4),
      pages: v.pageCount ? String(v.pageCount) : "",
      isbn: cleanIsbn(isbn),
      coverUrl: httpsThumb((v.imageLinks || {}).thumbnail || (v.imageLinks || {}).smallThumbnail || ""),
      source: "Google Books"
    };
  }

  async function byIsbnGoogle(isbn) {
    const j = await getJson(`${GB}?q=isbn:${isbn}&maxResults=1`);
    return j.items && j.items.length ? fromGoogle(j.items[0]) : null;
  }

  async function byIsbnOpenLibrary(isbn) {
    const j = await getJson(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
    const d = j["ISBN:" + isbn];
    if (!d) return null;
    return {
      title: [d.title, d.subtitle].filter(Boolean).join(": "),
      author: (d.authors || []).map(a => a.name).join(", "),
      publisher: (d.publishers || []).map(p => p.name).join(", "),
      year: ((d.publish_date || "").match(/\d{4}/) || [""])[0],
      pages: d.number_of_pages ? String(d.number_of_pages) : "",
      isbn,
      coverUrl: (d.cover && (d.cover.medium || d.cover.large)) || "",
      source: "Open Library"
    };
  }

  /* On the NAS the lookup runs on the server with its own Google key (the keyless quota is often used up). */
  let useNas = false;
  let lastErrors = [];
  async function byIsbnNas(isbn) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await fetch(`api/isbn?isbn=${isbn}`, { credentials: "same-origin", cache: "no-store", signal: ctl.signal });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json(); lastErrors = j.fehler || [];
      return j.info || null;
    } finally { clearTimeout(t); }
  }

  /* Look up one ISBN. Resolves a partial book or null. Rejects only when offline/unreachable. */
  async function byIsbn(raw) {
    const isbn = cleanIsbn(raw);
    if (!isbn) return null;
    lastErrors = [];
    if (useNas) {
      try { const n = await byIsbnNas(isbn); if (n) return n; } catch {}
    }
    let g = null, o = null, failures = 0;
    try { g = await byIsbnGoogle(isbn); } catch { failures++; }
    if (!g || !g.coverUrl || !g.author) {
      try { o = await byIsbnOpenLibrary(isbn); } catch { failures++; }
    }
    if (!g && !o) { if (failures === 2) throw new Error("unreachable"); return null; }
    const out = { ...(o || {}), ...Object.fromEntries(Object.entries(g || {}).filter(([, v]) => v)) };
    for (const k of ["author", "publisher", "year", "pages", "coverUrl"]) if (!out[k] && o && o[k]) out[k] = o[k];
    out.isbn = isbn;
    return out;
  }

  /* Search by title/author; used to find a cover or fill details. */
  async function search(title, author, max = 8) {
    let q = `intitle:${title}`;
    if (author) q += ` inauthor:${author.split(",")[0]}`;
    const j = await getJson(`${GB}?q=${encodeURIComponent(q)}&maxResults=${max}&printType=books`);
    return (j.items || []).map(fromGoogle);
  }

  return { byIsbn, search, cleanIsbn, isValidIsbn, setNas: v => { useNas = !!v; }, errors: () => lastErrors };
})();
