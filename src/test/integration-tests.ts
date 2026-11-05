import * as chai from 'chai';
import * as chaiAsPromised from 'chai-as-promised';
import { mock } from 'simple-mock';
import { parse, GraphQLSchema, GraphQLObjectType, GraphQLString, GraphQLFieldResolver } from 'graphql';
import { subscribe } from 'graphql/subscription';

import { RedisPubSub } from '../redis-pubsub';
import { withFilter } from '../with-filter';
import { Cluster, Redis } from 'ioredis';
import { createClient, createCluster, RedisClientType, RedisClusterType } from 'redis';

chai.use(chaiAsPromised);
const expect = chai.expect;

const FIRST_EVENT = 'FIRST_EVENT';
const SECOND_EVENT = 'SECOND_EVENT';

function buildSchema(iterator, patternIterator) {
  return new GraphQLSchema({
    query: new GraphQLObjectType({
      name: 'Query',
      fields: {
        testString: {
          type: GraphQLString,
          resolve: function(_, args) {
            return 'works';
          },
        },
      },
    }),
    subscription: new GraphQLObjectType({
      name: 'Subscription',
      fields: {
        testSubscription: {
          type: GraphQLString,
          subscribe: withFilter(() => iterator, () => true) as GraphQLFieldResolver<any, any, any>,
          resolve: root => {
            return 'FIRST_EVENT';
          },
        },

        testPatternSubscription: {
          type: GraphQLString,
          subscribe: withFilter(() => patternIterator, () => true) as GraphQLFieldResolver<any, any, any>,
          resolve: root => {
            return 'SECOND_EVENT';
          },
        },
      },
    }),
  });
}

describe('PubSubAsyncIterator', function() {
  const query = parse(`
    subscription S1 {
      testSubscription
    }
  `);

  const patternQuery = parse(`
    subscription S1 {
      testPatternSubscription
    }
  `);

  const pubsub = new RedisPubSub();
  const origIterator = pubsub.asyncIterableIterator(FIRST_EVENT);
  const origPatternIterator = pubsub.asyncIterableIterator('SECOND*', { pattern: true });
  const returnSpy = mock(origIterator, 'return');
  const schema = buildSchema(origIterator, origPatternIterator);

  before(async () => {
    // Wait for the subscriber connection to finish ioredis's readyCheck before any
    // SUBSCRIBE is issued, otherwise the first subscribe can race the readyCheck's
    // INFO command and fail with "Connection in subscriber mode".
    await (pubsub.getSubscriber() as Redis).ping();
    // Warm the redis connection so that tests would pass
    await pubsub.publish('WARM_UP', {});
  });

  after(() => {
    pubsub.close();
  });

  it('should allow subscriptions', () =>
    subscribe({ schema, document: query})
      .then(ai => {
        // tslint:disable-next-line:no-unused-expression
				expect(ai[Symbol.asyncIterator]).not.to.be.undefined;

        const r = (ai as AsyncIterator<any>).next();
        setTimeout(() => pubsub.publish(FIRST_EVENT, {}), 50);

        return r;
      })
      .then(res => {
        expect(res.value.data.testSubscription).to.equal('FIRST_EVENT');
      }));

  it('should allow pattern subscriptions', () =>
    subscribe({ schema, document: patternQuery })
      .then(ai => {
				// tslint:disable-next-line:no-unused-expression
				expect(ai[Symbol.asyncIterator]).not.to.be.undefined;

        const r = (ai as AsyncIterator<any>).next();
        setTimeout(() => pubsub.publish(SECOND_EVENT, {}), 50);

        return r;
      })
      .then(res => {
        expect(res.value.data.testPatternSubscription).to.equal('SECOND_EVENT');
      }));

  it('should clear event handlers', () =>
    subscribe({ schema, document: query})
      .then(ai => {
				// tslint:disable-next-line:no-unused-expression
				expect(ai[Symbol.asyncIterator]).not.to.be.undefined;

        pubsub.publish(FIRST_EVENT, {});

        return (ai as AsyncIterator<any>).return();
      })
      .then(res => {
        expect(returnSpy.callCount).to.be.gte(1);
      }));
});

describe('Subscribe to buffer', () => {
  it('can publish buffers as well' , done => {
    // when using messageBuffer, with redis instance the channel name is not a string but a buffer
    const pubSub = new RedisPubSub({ messageEventName: 'messageBuffer'});
    const payload = 'This is amazing';

    pubSub.subscribe('Posts', message => {
      try {
        expect(message).to.be.instanceOf(Buffer);
        expect(message.toString('utf-8')).to.be.equal(payload);
        done();
      } catch (e) {
        done(e);
      }
    }).then(async subId => {
      try {
        await pubSub.publish('Posts', Buffer.from(payload, 'utf-8'));
      } catch (e) {
        done(e);
      }
    });
  });
})

describe('PubSubCluster', () => {
    const nodes = [7006, 7001, 7002, 7003, 7004, 7005].map(port => ({ host: '127.0.0.1', port }));
    const cluster = new Cluster(nodes);
    const eventKey = 'clusterEvtKey';
    const pubsub = new RedisPubSub({
        publisher: cluster,
        subscriber: cluster,
    });

    before(async () => {
        await cluster.set('toto', 'aaa');
        setTimeout(() => {
            pubsub.publish(eventKey, { fired: true, from: 'cluster' });
        }, 500);
    });

    it('Cluster should work',  async () => {
        expect(await cluster.get('toto')).to.eq('aaa');
    });

    it('Cluster subscribe',   () => {
        pubsub.subscribe<{fire: boolean, from: string}>(eventKey, (data) => {
            expect(data).to.contains({ fired: true, from: 'cluster' });
        });
    }).timeout(2000);
});

describe('PubSubAsyncIterator with node-redis client', function() {
  const NODE_REDIS_FIRST_EVENT = 'NODE_REDIS_FIRST_EVENT';
  const NODE_REDIS_SECOND_EVENT = 'NODE_REDIS_SECOND_EVENT';

  const query = parse(`
    subscription S1 {
      testSubscription
    }
  `);

  const patternQuery = parse(`
    subscription S1 {
      testPatternSubscription
    }
  `);

  const publisher: RedisClientType = createClient({ socket: { port: 6379 } });
  const subscriber: RedisClientType = createClient({ socket: { port: 6379 } });
  let pubsub: RedisPubSub;
  let schema: GraphQLSchema;

  before(async () => {
    await Promise.all([publisher.connect(), subscriber.connect()]);

    pubsub = new RedisPubSub({ publisher, subscriber });
    const origIterator = pubsub.asyncIterableIterator(NODE_REDIS_FIRST_EVENT);
    const origPatternIterator = pubsub.asyncIterableIterator('NODE_REDIS_SECOND*', { pattern: true });
    schema = buildSchema(origIterator, origPatternIterator);
  });

  after(() => pubsub.close());

  it('should allow subscriptions', () =>
    subscribe({ schema, document: query })
      .then(ai => {
        const r = (ai as AsyncIterator<any>).next();
        setTimeout(() => pubsub.publish(NODE_REDIS_FIRST_EVENT, {}), 50);

        return r;
      })
      .then(res => {
        expect(res.value.data.testSubscription).to.equal('FIRST_EVENT');
      }));

  it('should allow pattern subscriptions', () =>
    subscribe({ schema, document: patternQuery })
      .then(ai => {
        const r = (ai as AsyncIterator<any>).next();
        setTimeout(() => pubsub.publish(NODE_REDIS_SECOND_EVENT, {}), 50);

        return r;
      })
      .then(res => {
        expect(res.value.data.testPatternSubscription).to.equal('SECOND_EVENT');
      }));
});

describe('PubSubCluster with node-redis', () => {
  const rootNodes = [7001, 7002, 7003, 7004, 7005, 7006].map(port => ({ url: `redis://127.0.0.1:${port}` }));
  const cluster: RedisClusterType = createCluster({ rootNodes });
  const eventKey = 'clusterEvtKeyNodeRedis';
  let pubsub: RedisPubSub;

  before(async () => {
    await cluster.connect();
    pubsub = new RedisPubSub({
      publisher: cluster,
      subscriber: cluster,
    });

    await cluster.set('toto', 'aaa');
    setTimeout(() => {
      pubsub.publish(eventKey, { fired: true, from: 'cluster' });
    }, 500);
  });

  after(() => pubsub.close());

  it('Cluster should work', async () => {
    expect(await cluster.get('toto')).to.eq('aaa');
  });

  it('Cluster subscribe', () => {
    pubsub.subscribe<{ fire: boolean, from: string }>(eventKey, (data) => {
      expect(data).to.contains({ fired: true, from: 'cluster' });
    });
  }).timeout(2000);
});
