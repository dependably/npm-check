import request from 'supertest';

export async function smoke(server: unknown): Promise<number> {
  const res = await request(server as never).get('/');
  return res.status;
}
