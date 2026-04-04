import { rateLimit } from '../src/middleware/rateLimit';

describe('rateLimit', () => {
  function mockReqRes() {
    const req: any = { ip: '127.0.0.' + Math.random(), socket: { remoteAddress: '127.0.0.1' } };
    const res: any = {
      statusCode: 200,
      headers: {} as Record<string, string>,
      status(code: number) { this.statusCode = code; return this; },
      json(data: any) { this.body = data; return this; },
      setHeader(k: string, v: string) { this.headers[k] = v; },
    };
    return { req, res };
  }

  it('allows requests under limit', () => {
    const limiter = rateLimit({ windowMs: 60000, max: 5, keyPrefix: 'test-allow' });
    const { req, res } = mockReqRes();
    let called = false;
    limiter(req, res, () => { called = true; });
    expect(called).toBe(true);
  });

  it('blocks requests over limit', () => {
    const prefix = 'test-block-' + Date.now();
    const limiter = rateLimit({ windowMs: 60000, max: 2, keyPrefix: prefix });
    const { req, res } = mockReqRes();

    limiter(req, res, () => {}); // 1
    limiter(req, res, () => {}); // 2
    limiter(req, res, () => {}); // 3 -> should block

    expect(res.statusCode).toBe(429);
  });
});
