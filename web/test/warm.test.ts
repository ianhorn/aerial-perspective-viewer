import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { warmUp } from '../src/warm.ts';

/** A fake fetch that records the addresses asked for. */
function fake(answer: () => Promise<Response>) {
  const asked: string[] = [];
  const impl = (async (url: unknown) => { asked.push(String(url)); return answer(); }) as typeof fetch;
  return { impl, asked };
}

describe('warmUp', () => {
  it('does nothing when there is no address', async () => {
    const { impl, asked } = fake(async () => new Response('{}'));
    assert.equal(await warmUp(undefined, impl), false);
    assert.equal(await warmUp('', impl), false);
    assert.deepEqual(asked, []);
  });

  it('sends one request to /healthz, whether or not the address ends in a slash', async () => {
    const one = fake(async () => new Response('{"database_online":true}'));
    assert.equal(await warmUp('https://tiler.example.test/', one.impl), true);
    const two = fake(async () => new Response('{}'));
    assert.equal(await warmUp('https://tiler.example.test', two.impl), true);
    assert.deepEqual(one.asked, ['https://tiler.example.test/healthz']);
    assert.deepEqual(two.asked, ['https://tiler.example.test/healthz']);
  });

  it('says false for an error answer, and does not throw when the network fails', async () => {
    assert.equal(await warmUp('https://tiler.example.test', fake(async () => new Response('', { status: 502 })).impl), false);
    assert.equal(await warmUp('https://tiler.example.test', fake(async () => { throw new TypeError('network down'); }).impl), false);
  });
});
