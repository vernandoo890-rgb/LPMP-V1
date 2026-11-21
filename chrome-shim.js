// Shim: emulasi API ekstensi Chrome agar kode asli berjalan di WebView Android.
(function () {
  if (window.chrome && chrome.storage && chrome.storage.local && chrome.runtime && chrome.runtime.id) return;
  const mk = (ns) => {
    const k = (key) => 'cs:' + ns + ':' + key;
    const all = () => { const o = {}; const s = ns === 'session' ? sessionStorage : localStorage;
      for (let i = 0; i < s.length; i++) { const n = s.key(i); if (n.startsWith('cs:' + ns + ':')) { try { o[n.slice(('cs:' + ns + ':').length)] = JSON.parse(s.getItem(n)); } catch (e) {} } } return o; };
    const st = () => ns === 'session' ? sessionStorage : localStorage;
    return {
      async get(keys) {
        const a = all(); if (keys == null) return a;
        if (typeof keys === 'string') keys = [keys];
        const out = {};
        if (Array.isArray(keys)) keys.forEach(x => { if (x in a) out[x] = a[x]; });
        else Object.keys(keys).forEach(x => { out[x] = x in a ? a[x] : keys[x]; });
        return out;
      },
      async set(obj) { Object.keys(obj).forEach(x => st().setItem(k(x), JSON.stringify(obj[x]))); },
      async remove(keys) { [].concat(keys).forEach(x => st().removeItem(k(x))); },
      async clear() { Object.keys(all()).forEach(x => st().removeItem(k(x))); }
    };
  };
  const go = (url) => { location.href = url; };
  window.chrome = {
    storage: { local: mk('local'), session: mk('session'), onChanged: { addListener() {} } },
    runtime: {
      id: 'android', getURL: (p) => new URL(p, location.href).href,
      getContexts: async () => [], onMessage: { addListener() {} }, sendMessage: async () => {}
    },
    tabs: { create: async (o) => go(o.url), update: async () => {}, query: async () => [] },
    windows: {
      getLastFocused: async () => { throw new Error('no window'); },
      create: async (o) => go(o.url), update: async () => {}, get: async () => ({}),
      onRemoved: { addListener() {} }, onBoundsChanged: { addListener() {} }
    },
    action: { onClicked: { addListener() {} } }
  };
  // Navigasi: menu bawah dipasang oleh mobile.js.
  // Unduhan (ekspor Excel / cadangan JSON): kirim ke Android untuk disimpan di folder Download.
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download && this.href.startsWith('blob:') && window.AndroidBridge) {
      const name = this.download;
      fetch(this.href).then(r => r.blob()).then(b => {
        const fr = new FileReader();
        fr.onload = () => { const d = String(fr.result); window.AndroidBridge.saveFile(name, d.slice(d.indexOf(',') + 1), b.type || 'application/octet-stream'); };
        fr.readAsDataURL(b);
      });
      return;
    }
    return origClick.call(this);
  };
})();
