import * as chai from 'chai';
import * as chaiAsPromised from 'chai-as-promised';

import {
  parse,
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLString,
  GraphQLInt,
  GraphQLBoolean,
} from 'graphql';

import { SubscriptionManager } from 'graphql-subscriptions';
import { RedisPubSub } from '../redis-pubsub';

chai.use(chaiAsPromised);
const expect = chai.expect;
const assert = chai.assert;

describe('SubscriptionManager', function () {

  const schema = new GraphQLSchema({
    query: new GraphQLObjectType({
      name: 'Query',
      fields: {
        testString: {
          type: GraphQLString,
          resolve: function (_, args) {
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
          resolve: function (root) {
            return root;
          },
        },
        testFilter: {
          type: GraphQLString,
          resolve: function (root, { filterBoolean }) {
            return filterBoolean ? 'goodFilter' : 'badFilter';
          },
          args: {
            filterBoolean: { type: GraphQLBoolean },
          },
        },
        testFilterMulti: {
          type: GraphQLString,
          resolve: function (root, { filterBoolean }) {
            return filterBoolean ? 'goodFilter' : 'badFilter';
          },
          args: {
            filterBoolean: { type: GraphQLBoolean },
            a: { type: GraphQLString },
            b: { type: GraphQLInt },
          },
        },
        testChannelOptions: {
          type: GraphQLString,
          resolve: function (root) {
            return root;
          },
          args: {
            repoName: { type: GraphQLString },
          },
        },
      },
    }),
  });

  const subManager = new SubscriptionManager({
    schema,
    setupFunctions: {
      'testFilter': (options, { filterBoolean }) => {
        return {
          'Filter1': { filter: (root) => root.filterBoolean === filterBoolean },
        };
      },
      'testFilterMulti': (options) => {
        return {
          'Trigger1': { filter: () => true },
          'Trigger2': { filter: () => true },
        };
      },
    },
    pubsub: new RedisPubSub(),
  });

  it('throws an error if query is not valid', function () {
    const query = 'query a{ testInt }';
    const callback = () => null;
    return expect(subManager.subscribe({ query, operationName: 'a', callback }))
      .to.eventually.be.rejectedWith('Subscription query has validation errors');
  });

  it('rejects subscriptions with more than one root field', function () {
    const query = 'subscription X{ a: testSubscription, b: testSubscription }';
    const callback = () => null;
    return expect(subManager.subscribe({ query, operationName: 'X', callback }))
      .to.eventually.be.rejectedWith('Subscription query has validation errors');
  });

  it('can subscribe with a valid query and gets a subId back', function () {
    const query = 'subscription X{ testSubscription }';
    const callback = () => null;
    subManager.subscribe({ query, operationName: 'X', callback }).then(subId => {
      expect(subId).to.be.a('number');
      subManager.unsubscribe(subId);
    });
  });

  it('can subscribe with a valid query and get the root value', function (done) {
    const query = 'subscription X{ testSubscription }';
    const callback = function (err, payload) {
      try {
        expect(payload.data.testSubscription).to.equals('good');
      } catch (e) {
        done(e);
        return;
      }
      done();
    };

    subManager.subscribe({ query, operationName: 'X', callback }).then(subId => {
      subManager.publish('testSubscription', 'good');
      setTimeout(() => {
        subManager.unsubscribe(subId);
      }, 2);
    });
  });

  it('can use filter functions properly', function (done) {
    const query = `subscription Filter1($filterBoolean: Boolean){
       testFilter(filterBoolean: $filterBoolean)
      }`;
    const callback = function (err, payload) {
      try {
        expect(payload.data.testFilter).to.equals('goodFilter');
      } catch (e) {
        done(e);
        return;
      }
      done();
    };
    subManager.subscribe({
      query,
      operationName: 'Filter1',
      variables: { filterBoolean: true },
      callback,
    }).then(subId => {
      subManager.publish('Filter1', { filterBoolean: false });
      subManager.publish('Filter1', { filterBoolean: true });
      setTimeout(() => {
        subManager.unsubscribe(subId);
      }, 4);
    });
  });

  it('can subscribe to more than one trigger', function (done) {
    // I also used this for testing arg parsing (with console.log)
    // args a and b can safely be removed.
    // TODO: write real tests for argument parsing
    let triggerCount = 0;
    const query = `subscription multiTrigger($filterBoolean: Boolean, $uga: String){
       testFilterMulti(filterBoolean: $filterBoolean, a: $uga, b: 66)
      }`;
    const callback = function (err, payload) {
      try {
        expect(payload.data.testFilterMulti).to.equals('goodFilter');
        triggerCount++;
      } catch (e) {
        done(e);
        return;
      }
      if (triggerCount === 2) {
        done();
      }
    };
    subManager.subscribe({
      query,
      operationName: 'multiTrigger',
      variables: { filterBoolean: true, uga: 'UGA' },
      callback,
    }).then(subId => {
      subManager.publish('NotATrigger', { filterBoolean: false });
      subManager.publish('Trigger1', { filterBoolean: true });
      subManager.publish('Trigger2', { filterBoolean: true });
      setTimeout(() => {
        subManager.unsubscribe(subId);
      }, 6);
    });
  });

  it('can unsubscribe', function (done) {
    const query = 'subscription X{ testSubscription }';
    const callback = (err, payload) => {
      try {
        assert(false);
      } catch (e) {
        done(e);
        return;
      }
      done();
    };
    subManager.subscribe({ query, operationName: 'X', callback }).then(subId => {
      subManager.unsubscribe(subId);
      subManager.publish('testSubscription', 'bad');
      setTimeout(done, 30);
    });
  });

  it('throws an error when trying to unsubscribe from unknown id', function () {
    expect(() => subManager.unsubscribe(123))
      .to.throw('undefined');
  });

  it('calls the error callback if there is an execution error', function (done) {
    const query = `subscription X($uga: Boolean!){
      testSubscription  @skip(if: $uga)
    }`;
    const callback = function (err, payload) {
      try {
        // tslint:disable-next-line:no-unused-expression
        expect(payload).to.exist;
        // tslint:disable-next-line:no-unused-expression
        expect(payload.errors).to.exist;
        expect(payload.errors.length).to.equal(1);
        expect(payload.errors[0].message).to.equal('Variable "$uga" of required type "Boolean!" was not provided.');
      } catch (e) {
        done(e);
        return;
      }
      done();
    };

    subManager.subscribe({ query, operationName: 'X', callback }).then(subId => {
      subManager.publish('testSubscription', 'good');
      setTimeout(() => {
        subManager.unsubscribe(subId);
      }, 8);
    });
  });

  it('can use transform function to convert the trigger name given into more explicit channel name', function (done) {
    const triggerTransform = (trigger, { path }) => [trigger, ...path].join('.');
    const pubsub = new RedisPubSub({
      triggerTransform,
    });

    const subManager2 = new SubscriptionManager({
      schema,
      setupFunctions: {
        testChannelOptions: (options, { repoName }) => ({
          comments: {
            channelOptions: { path: [repoName] },
          },
        }),
      },
      pubsub,
    });

    const callback = (err, payload) => {
      try {
        expect(payload.data.testChannelOptions).to.equals('test');
        done();
      } catch (e) {
        done(e);
      }
    };

    const query = `
      subscription X($repoName: String!) {
        testChannelOptions(repoName: $repoName)
      }
    `;

    const variables = { repoName: 'graphql-redis-subscriptions' };

    subManager2.subscribe({ query, operationName: 'X', variables, callback }).then(subId => {
      pubsub.publish('comments.graphql-redis-subscriptions', 'test');

      setTimeout(() => pubsub.unsubscribe(subId), 4);
    });

  });
});


// From https://github.com/apollographql/graphql-subscriptions/blob/master/src/test/asyncIteratorSubscription.ts
import { isAsyncIterable } from 'iterall';
import { mock } from 'simple-mock';
import { withFilter } from '../with-filter';
import { subscribe } from 'graphql/subscription';
const FIRST_EVENT = 'FIRST_EVENT';

function buildSchema(iterator) {
  return new GraphQLSchema({
    query: new GraphQLObjectType({
      name: 'Query',
      fields: {
        testString: {
          type: GraphQLString,
          resolve: function (_, args) {
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
          subscribe: withFilter(
            () => iterator,
            () => true,
          ),
          resolve: root => {
            return 'FIRST_EVENT';
          },
        },
      },
    }),
  });
}

describe('PubSubAsyncIterator', function () {

  const query = parse(`
    subscription S1 {
      testSubscription
    }
  `);

  const pubsub = new RedisPubSub();
  const origIterator = pubsub.asyncIterator(FIRST_EVENT);
  const returnSpy = mock(origIterator, 'return');
  const schema = buildSchema(origIterator);
  const results = subscribe(schema, query);

  it('should allow subscriptions', () => {
    const payload1 = results.next();

    // tslint:disable-next-line:no-unused-expression
    expect(isAsyncIterable(results)).to.be.true;

    const r = payload1.then(res => {
      expect(res.value.data.testSubscription).to.equal('FIRST_EVENT');
    });

    pubsub.publish(FIRST_EVENT, {});

    return r;
  });

  it('should clear event handlers', () => {
    const end = results.return();

    const r = end.then(res => {
      expect(returnSpy.callCount).to.be.gte(1);
    });

    pubsub.publish(FIRST_EVENT, {});

    return r;
  });
});
