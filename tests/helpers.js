'use strict';

function memoryCache(initial = {}) {
  const values = new Map(Object.entries(initial));
  const writes = [];
  const deletes = [];
  return {
    values,
    writes,
    deletes,
    async get(key) {
      return values.get(key) ?? null;
    },
    async put(key, value, options) {
      values.set(key, value);
      writes.push({ key, value, options });
    },
    async delete(key) {
      values.delete(key);
      deletes.push(key);
    },
  };
}

function request(path, init = {}) {
  const {
    baseUrl = 'http://article.test',
    clientIp = '192.0.2.10',
    ...requestInit
  } = init;
  const headers = new Headers(requestInit.headers);
  if (!headers.has('origin')) headers.set('origin', new URL(baseUrl).origin);
  if (!headers.has('cf-connecting-ip')) headers.set('cf-connecting-ip', clientIp);
  if (requestInit.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return new Request(new URL(path, baseUrl), { ...requestInit, headers });
}

function responseCookie(response, name) {
  const header = response.headers.get('set-cookie') || '';
  const cookie = header.split(';')[0];
  if (name && !cookie.startsWith(`${name}=`)) {
    throw new Error(`Expected ${name} cookie, received ${header || '<none>'}`);
  }
  return cookie;
}

module.exports = { memoryCache, request, responseCookie };
