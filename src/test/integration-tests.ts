import * as chai from 'chai';
import * as chaiAsPromised from 'chai-as-promised';
import { mock } from 'simple-mock';
import { parse, GraphQLSchema, GraphQLObjectType, GraphQLString, GraphQLFieldResolver } from 'graphql';
import { isAsyncIterable } from 'iterall';
import { subscribe } from 'graphql/subscription';

import { RedisPubSub } from '../redis-pubsub';
import { withFilter } from '../with-filter';
import { Cluster } from 'ioredis';

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
  const origIterator = pubsub.asyncIterator(FIRST_EVENT);
  const origPatternIterator = pubsub.asyncIterator('SECOND*', { pattern: true });
  const returnSpy = mock(origIterator, 'return');
  const schema = buildSchema(origIterator, origPatternIterator);

  before(() => {
    // Warm the redis connection so that tests would pass
    pubsub.publish('WARM_UP', {});
  });

  after(() => {
    pubsub.close();
  });

  it('should allow subscriptions', () =>
    subscribe(schema, query)
      .then(ai => {
        // tslint:disable-next-line:no-unused-expression
        expect(isAsyncIterable(ai)).to.be.true;

        const r = (ai as AsyncIterator<any>).next();
        setTimeout(() => pubsub.publish(FIRST_EVENT, {}), 50);

        return r;
      })
      .then(res => {
        expect(res.value.data.testSubscription).to.equal('FIRST_EVENT');
      }));

  it('should allow pattern subscriptions', () =>
    subscribe(schema, patternQuery)
      .then(ai => {
        // tslint:disable-next-line:no-unused-expression
        expect(isAsyncIterable(ai)).to.be.true;

        const r = (ai as AsyncIterator<any>).next();
        setTimeout(() => pubsub.publish(SECOND_EVENT, {}), 50);

        return r;
      })
      .then(res => {
        expect(res.value.data.testPatternSubscription).to.equal('SECOND_EVENT');
      }));

  it('should clear event handlers', () =>
    subscribe(schema, query)
      .then(ai => {
        // tslint:disable-next-line:no-unused-expression
        expect(isAsyncIterable(ai)).to.be.true;

        pubsub.publish(FIRST_EVENT, {});

        return (ai as AsyncIterator<any>).return();
      })
      .then(res => {
        expect(returnSpy.callCount).to.be.gte(1);
      }));
});


describe('PubSubCluster', () => {
    const nodes = [7000, 7001, 7002, 7003, 7004, 7005].map(port => ({ host: '127.0.0.1', port }));
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
