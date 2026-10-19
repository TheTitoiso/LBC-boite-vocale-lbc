export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: RequestInit['body'];
}

type Responder = (request: RecordedRequest) => Response | Promise<Response>;

/** Faux `fetch` : chaque appel consomme la réponse suivante de la liste et est enregistré. */
export function fetchMock(...responders: Responder[]) {
  const requests: RecordedRequest[] = [];
  const queue = [...responders];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const request: RecordedRequest = {
      method: init.method ?? 'GET',
      url: new URL(input instanceof Request ? input.url : String(input)),
      headers: new Headers(init.headers),
      body: init.body,
    };
    requests.push(request);
    const responder = queue.shift();
    if (!responder) throw new Error(`Appel inattendu : ${request.method} ${request.url}`);
    return responder(request);
  }) as typeof fetch;
  return { fetch: fetchImpl, requests, remaining: () => queue.length };
}

export const json = (body: unknown, status = 200) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export const text = (body: string, status: number) => () => new Response(body, { status });

export const networkError = () => () => {
  throw new TypeError('fetch failed');
};
