// バックエンド呼び出しの共通ラッパ。
//
// 従来 fetch の結果を .json() に直結していた箇所は、サーバが 4xx/5xx を返すと
// FastAPI の {"detail": "..."} を JSON パースしようとして例外になり、呼び出し側の
// await が黙って死んでいた（＝ユーザーには何も起きていないように見えた）。
// ここを通せば失敗は必ず ApiError になり、呼び出し側で捕まえて表示できる。

export class ApiError extends Error {
  constructor(detail, status) {
    super(detail);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function jsonFetch(url, opts) {
  let resp;
  try {
    resp = await fetch(url, opts);
  } catch (e) {
    // ネットワーク層の失敗（サーバ停止など）。status は無い。
    throw new ApiError(`サーバに接続できません（${url}）`, 0);
  }
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new ApiError(err.detail || resp.statusText || `HTTP ${resp.status}`, resp.status);
  }
  return resp.json();
}

export const getJSON = (url) => jsonFetch(url);

export const postJSON = (url, body) =>
  jsonFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** 失敗を alert で伝えて undefined を返す。「失敗しても続行してよい」読み取り系向け。 */
export async function tryJSON(url, opts) {
  try {
    return await jsonFetch(url, opts);
  } catch (e) {
    alert("⚠️ " + e.message);
    return undefined;
  }
}
