import * as chai from 'chai';
import * as chaiAsPromised from 'chai-as-promised';
import { spy, restore } from 'simple-mock';
import { RedisPubSub } from '../redis-pubsub';
import { withFilter } from '../with-filter';

chai.use(chaiAsPromised);
const expect = chai.expect;

// -------------- withFilter ------------------

describe('withFilter', () => {

  // A minimal async iterator that yields the given values in order.
  const makeIterator = (values: any[]) => {
    let i = 0;
    return {
      next: () => Promise.resolve(
        i < values.length
          ? { value: values[i++], done: false }
          : { value: undefined, done: true },
      ),
      return: () => Promise.resolve({ value: undefined, done: true }),
      throw: (error: any) => Promise.reject(error),
      [Symbol.asyncIterator]() { return this; },
    } as any;
  };

  it('passes through values that match the filter', async () => {
    const resolver = withFilter(() => makeIterator([1, 2, 3]), value => value === 1);
    const iterator = resolver(null, null, null, null);
    const result = await iterator.next();
    expect(result.value).to.equal(1);
  });

  it('skips values that do not match and resolves the next matching value', async () => {
    const resolver = withFilter(() => makeIterator([1, 2, 3]), value => value === 3);
    const iterator = resolver(null, null, null, null);
    const result = await iterator.next();
    expect(result.value).to.equal(3);
  });

  it('treats a filter that rejects as non-matching', async () => {
    const resolver = withFilter(
      () => makeIterator([1, 2]),
      ((value: any) => (value === 1 ? Promise.reject(new Error('boom')) : true)) as any,
    );
    const iterator = resolver(null, null, null, null);
    const result = await iterator.next();
    expect(result.value).to.equal(2);
  });

  it('delegates return() and throw() to the underlying iterator', async () => {
    const returnSpy = spy(() => Promise.resolve({ value: undefined, done: true }));
    const throwSpy = spy((error: any) => Promise.reject(error));
    const resolver = withFilter(
      () => ({
        next: () => Promise.resolve({ value: 1, done: false }),
        return: returnSpy,
        throw: throwSpy,
        [Symbol.asyncIterator]() { return this; },
      }) as any,
      () => true,
    );
    const iterator = resolver(null, null, null, null);

    await iterator.return();
    expect(returnSpy.callCount).to.equal(1);

    await expect(iterator.throw(new Error('x'))).to.be.rejectedWith('x');
    expect(throwSpy.callCount).to.equal(1);
  });

});

// -------------- node-redis client support ------------------

// node-redis exposes a different API than ioredis: camelCase method names that
// return Promises, and message listeners passed directly to subscribe()/pSubscribe()
// rather than emitted as generic 'message'/'pmessage' events. The absence of a
// lower-case `psubscribe` is what RedisPubSub uses to detect a node-redis client.
const makeNodeRedisMock = () => {
  const listeners: { [channel: string]: (message: string, channel?: string) => void } = {};
  return {
    subscribe: spy((channel: string, listener: any) => {
      listeners[channel] = listener;
      return Promise.resolve();
    }),
    pSubscribe: spy((channel: string, listener: any) => {
      listeners[channel] = listener;
      return Promise.resolve();
    }),
    unsubscribe: spy((_channel: string) => Promise.resolve()),
    pUnsubscribe: spy((_channel: string) => Promise.resolve()),
    publish: spy((channel: string, message: string) => {
      const listener = listeners[channel];
      if (listener) listener(message, channel);
      return Promise.resolve(1);
    }),
    close: spy(() => Promise.resolve()),
  };
};

describe('RedisPubSub with a node-redis client', () => {

  it('subscribes to a channel and receives published messages', done => {
    const client = makeNodeRedisMock();
    const pubSub = new RedisPubSub({ publisher: client as any, subscriber: client as any });
    pubSub.subscribe('Posts', message => {
      try {
        expect(message).to.equal('test');
        expect(client.subscribe.callCount).to.equal(1);
        done();
      } catch (e) {
        done(e);
      }
    }).then(async subId => {
      expect(subId).to.be.a('number');
      await pubSub.publish('Posts', 'test');
      pubSub.unsubscribe(subId);
    });
  });

  it('subscribes to a channel pattern via pSubscribe', done => {
    const client = makeNodeRedisMock();
    const pubSub = new RedisPubSub({ publisher: client as any, subscriber: client as any });
    pubSub.subscribe('Posts*', message => {
      try {
        expect(message).to.equal('test');
        expect(client.pSubscribe.callCount).to.equal(1);
        done();
      } catch (e) {
        done(e);
      }
    }, { pattern: true }).then(async subId => {
      await pubSub.publish('Posts*', 'test');
      pubSub.unsubscribe(subId);
    });
  });

  it('unsubscribes via node-redis unsubscribe and pUnsubscribe', done => {
    const client = makeNodeRedisMock();
    const pubSub = new RedisPubSub({ publisher: client as any, subscriber: client as any });
    pubSub.subscribe('Posts', () => null).then(subId => {
      pubSub.unsubscribe(subId);
      try {
        expect(client.unsubscribe.callCount).to.equal(1);
        expect(client.pUnsubscribe.callCount).to.equal(1);
        done();
      } catch (e) {
        done(e);
      }
    });
  });

  it('propagates a node-redis subscribe rejection', () => {
    const client = makeNodeRedisMock();
    client.subscribe = spy(() => Promise.reject(new Error('node-redis subscribe failed'))) as any;
    const pubSub = new RedisPubSub({ publisher: client as any, subscriber: client as any });
    return expect(pubSub.subscribe('Posts', () => null))
      .to.be.rejectedWith('node-redis subscribe failed');
  });

  it('close() closes both node-redis clients and resolves OK', async () => {
    const client = makeNodeRedisMock();
    const pubSub = new RedisPubSub({ publisher: client as any, subscriber: client as any });
    const result = await pubSub.close();
    expect(result).to.eql(['OK', 'OK']);
    expect(client.close.callCount).to.equal(2);
  });

  afterEach(() => restore());

});

// -------------- ioredis subscribe error path ------------------

describe('RedisPubSub subscribe error handling', () => {

  it('rejects when the ioredis subscribe call returns an error', () => {
    const errorClient = {
      publish: spy(() => undefined),
      subscribe: spy((_channel: string, cb: any) => cb(new Error('subscribe failed'))),
      unsubscribe: spy(() => undefined),
      psubscribe: spy((_channel: string, cb: any) => cb(new Error('psubscribe failed'))),
      punsubscribe: spy(() => undefined),
      on: () => undefined,
      quit: spy(() => undefined),
    };
    const pubSub = new RedisPubSub({ publisher: errorClient as any, subscriber: errorClient as any });
    return expect(pubSub.subscribe('Posts', () => null))
      .to.be.rejectedWith('subscribe failed');
  });

  afterEach(() => restore());

});

// -------------- PubSubAsyncIterator branches ------------------

describe('PubSubAsyncIterator extra branches', () => {

  const mockRedisClient = {
    publish: spy((channel, message) => (mockRedisClient as any).listener
      && (mockRedisClient as any).listener(channel, message)),
    subscribe: spy((channel, cb) => cb && cb(null, channel)),
    unsubscribe: spy(() => undefined),
    psubscribe: spy((channel, cb) => cb && cb(null, channel)),
    punsubscribe: spy(() => undefined),
    on: (event, cb) => {
      if (event === 'message') (mockRedisClient as any).listener = cb;
    },
    quit: spy(() => undefined),
  };
  const mockOptions = { publisher: mockRedisClient as any, subscriber: mockRedisClient as any };

  it('asyncIterator returns an async-iterable iterator', () => {
    const pubSub = new RedisPubSub(mockOptions);
    const iterator = pubSub.asyncIterator('test');
    expect(iterator[Symbol.asyncIterator]).to.be.a('function');
    expect(iterator[Symbol.asyncIterator]()).to.equal(iterator);
  });

  it('throw() rejects and stops the iterator', () => {
    const pubSub = new RedisPubSub(mockOptions);
    const iterator = pubSub.asyncIterableIterator('test');
    return expect(iterator.throw(new Error('boom'))).to.be.rejectedWith('boom');
  });

  it('buffers events that arrive before next() is called', async () => {
    const pubSub = new RedisPubSub(mockOptions);
    const iterator = pubSub.asyncIterableIterator<{ n: number }>('test');

    // Prime the subscription and consume the first event.
    const first = iterator.next();
    await pubSub.publish('test', { n: 1 });
    const firstResult = await first;
    expect(firstResult.value).to.eql({ n: 1 });

    // With no pending next(), this event is buffered in the push queue...
    await pubSub.publish('test', { n: 2 });
    // ...and the following next() pulls it straight from the buffer.
    const secondResult = await iterator.next();
    expect(secondResult.value).to.eql({ n: 2 });

    await iterator.return();
  });

  afterEach(() => restore());

});
