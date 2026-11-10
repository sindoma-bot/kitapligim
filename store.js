/* Kitaplığım — local storage on the device (IndexedDB).
   Stores: books {id,...}, shelves {id,name,order}, photos {id -> Blob}. */
const Store = (() => {
  const DB_NAME = "kitapligim", VERSION = 1;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("books")) db.createObjectStore("books", { keyPath: "id" });
        if (!db.objectStoreNames.contains("shelves")) db.createObjectStore("shelves", { keyPath: "id" });
        if (!db.objectStoreNames.contains("photos")) db.createObjectStore("photos");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let result;
      Promise.resolve(fn(s)).then(r => { result = r; });
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error("aborted"));
    });
  }
  const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  return {
    newId,
    all: store => tx(store, "readonly", s => reqP(s.getAll())),
    put: (store, obj) => tx(store, "readwrite", s => { s.put(obj); }),
    putMany: (store, list) => tx(store, "readwrite", s => { for (const o of list) s.put(o); }),
    del: (store, id) => tx(store, "readwrite", s => { s.delete(id); }),
    delMany: (store, ids) => tx(store, "readwrite", s => { for (const id of ids) s.delete(id); }),
    clear: store => tx(store, "readwrite", s => { s.clear(); }),
    getPhoto: id => tx("photos", "readonly", s => reqP(s.get(id))),
    putPhoto: (id, blob) => tx("photos", "readwrite", s => { s.put(blob, id); }),
    delPhoto: id => tx("photos", "readwrite", s => { s.delete(id); }),
    allPhotoKeys: () => tx("photos", "readonly", s => reqP(s.getAllKeys())),
    async persist() {
      try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch {}
      return false;
    }
  };
})();
