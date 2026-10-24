(() => {
  'use strict';
  const API = '/webcast/room/web/enter/';
  const XPATH = '//*[@id="chatroom"]/div/div[1]/div[1]/div[4]';
  const utf8 = new TextDecoder();
  let count = null, source = '等待数据', scheduled = false;
  const stats = { wsFrames: 0, roomStats: 0, roomUserSeq: 0 };
  window.__DouyinViewerStatus = {
    get: () => ({ count, source, ...stats })
  };

  // 页面原位置替换人数，尽量保留页面样式
  function render() {
    if (count === null) return;
    const el = document.evaluate(XPATH, document, null,
      XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    if (!el) return;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const regex = /\d[\d,.]*(?:万|亿)?\+?/;
    let node;
    while ((node = walker.nextNode())) {
      if (regex.test(node.textContent)) {
        const next = node.textContent.replace(regex, String(count));
        if (next !== node.textContent) node.textContent = next;
        return;
      }
    }
    let span = el.querySelector('[data-douyin-count]');
    if (!span) {
      span = document.createElement('span');
      span.dataset.douyinCount = 'true';
      el.appendChild(span);
    }
    if (span.textContent !== String(count)) span.textContent = String(count);
  }
  function scheduleRender() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; render(); });
  }
  function setCount(value, via) {
    if (value == null || value === '') return;
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0) return;
    if (via === '进房快照' && source === 'WebSocket') return;
    if (count !== n || source !== via) console.log(`获取到了：${n}（${via}）`);
    count = n;
    source = via;
    scheduleRender();
  }
  const observe = () => {
    if (!document.documentElement) return;
    new MutationObserver(scheduleRender).observe(document.documentElement,
      { childList: true, subtree: true, characterData: true });
    scheduleRender();
  };
  if (document.documentElement) observe();
  else document.addEventListener('DOMContentLoaded', observe, { once: true });

  // HTTP 进房接口：仅作初始值，不重复请求签名 URL
  function findFirstValue(obj) {
    if (!obj || typeof obj !== 'object') return;
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'display_value') return value;
      const result = findFirstValue(value);
      if (result !== undefined) return result;
    }
  }
  const acceptEntry = obj => setCount(findFirstValue(obj), '进房快照');
  const nativeFetch = window.fetch;
  window.fetch = function (...args) {
    const p = nativeFetch.apply(this, args);
    p.then(r => {
      if (r.url?.includes(API)) r.clone().json().then(acceptEntry).catch(() => {});
    }).catch(() => {});
    return p;
  };
  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (...args) {
    this.addEventListener('load', () => {
      if (!this.responseURL?.includes(API)) return;
      try { acceptEntry(this.responseType === 'json' ? this.response : JSON.parse(this.responseText)); }
      catch {}
    });
    return nativeOpen.apply(this, args);
  };

  // 最小 Protobuf 解码器：varint + 长度字段
  function varint(bytes, offset) {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      if (offset >= bytes.length) throw Error('invalid protobuf');
      const b = bytes[offset++];
      value |= BigInt(b & 127) << BigInt(i * 7);
      if (!(b & 128)) return [value, offset];
    }
    throw Error('invalid varint');
  }
  function fields(bytes) {
    const out = [];
    for (let p = 0; p < bytes.length;) {
      const [tag, start] = varint(bytes, p);
      const id = Number(tag >> 3n), type = Number(tag & 7n);
      if (!id) throw Error('invalid field');
      p = start;
      let val;
      if (type === 0) [val, p] = varint(bytes, p);
      else if (type === 2) {
        const [len, q] = varint(bytes, p);
        if (len > BigInt(bytes.length - q)) throw Error('invalid length');
        p = q + Number(len);
        val = bytes.subarray(q, p);
      } else if (type === 1 || type === 5) {
        const size = type === 1 ? 8 : 4;
        if (p + size > bytes.length) throw Error('invalid fixed field');
        val = bytes.subarray(p, p + size);
        p += size;
      } else throw Error('unsupported wire type');
      out.push({ id, type, val });
      if (out.length > 10000) throw Error('oversized protobuf');
    }
    return out;
  }
  const field = (f, id, type) => f.find(x => x.id === id && x.type === type)?.val;
  const toString = b => b ? utf8.decode(b) : '';
  async function gunzip(bytes, hint = '') {
    if (hint !== 'gzip' && !(bytes[0] === 31 && bytes[1] === 139)) return bytes;
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  function readResponse(bytes) {
    for (const entry of fields(bytes).filter(f => f.id === 1 && f.type === 2)) {
      const m = fields(entry.val);
      const method = toString(field(m, 1, 2));
      const payload = field(m, 2, 2);
      if (!payload) continue;
      if (method === 'WebcastRoomStatsMessage') {
        stats.roomStats++;
        const f = fields(payload);
        if (field(f, 10, 0) === 1n && field(f, 8, 0) !== 1n) {
          setCount(field(f, 5, 0), 'WebSocket');
        }
      } else if (method === 'WebcastRoomUserSeqMessage') {
        stats.roomUserSeq++;
        setCount(field(fields(payload), 3, 0), 'WebSocket');
      }
    }
  }
  async function readWS(data) {
    if (typeof data === 'string') return;
    let bytes;
    if (data instanceof Blob) bytes = new Uint8Array(await data.arrayBuffer());
    else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else return;
    if (!bytes.length || bytes.length > 12 * 1024 * 1024) return;
    const packet = fields(await gunzip(bytes));
    const payload = field(packet, 8, 2); // PushFrame.payload
    if (payload) readResponse(await gunzip(payload, toString(field(packet, 6, 2))));
    else readResponse(await gunzip(bytes)); // 直接发送 Response 的兼容情况
  }
  const NativeWS = window.WebSocket;
  window.WebSocket = new Proxy(NativeWS, {
    construct(Target, args, NewTarget) {
      const ws = Reflect.construct(Target, args, NewTarget);
      if (!String(args[0]).includes('webcast')) return ws;
      let queue = Promise.resolve();
      ws.addEventListener('message', event => {
        stats.wsFrames++;
        queue = queue.then(() => readWS(event.data)).catch(() => {});
      });
      return ws;
    }
  });
})();
