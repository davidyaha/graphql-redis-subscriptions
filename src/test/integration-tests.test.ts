import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLString,
  GraphQLInt,
  GraphQLBoolean,
} from 'graphql';

import {SubscriptionManager} from 'graphql-subscriptions';
import {RedisPubSub} from '../redis-pubsub';

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
          repoName: {type: GraphQLString},
        },
      },
    },
  }),
});

describe('SubscriptionManager', function() {
  const subManager = new SubscriptionManager({
    schema,
    setupFunctions: {
      'testFilter': (options, { filterBoolean }) => {
        return {
          'Filter1': {filter: (root) => root.filterBoolean === filterBoolean},
        };
      },
      'testFilterMulti': (options) => {
        return {
          'Trigger1': {filter: () => true},
          'Trigger2': {filter: () => true},
        };
      },
    },
    pubsub: new RedisPubSub(),
  });

  it('throws an error if query is not valid', function() {
    const query = 'query a{ testInt }';
    const callback = () => null;
    return expect(subManager.subscribe({ query, operationName: 'a', callback }))
      .rejects.toEqual(new Error('Subscription query has validation errors'));
  });

  it('rejects subscriptions with more than one root field', function() {
    const query = 'subscription X{ a: testSubscription, b: testSubscription }';
    const callback = () => null;
    return expect(subManager.subscribe({ query, operationName: 'X', callback }))
      .rejects.toEqual(new Error('Subscription query has validation errors'));
  });

  it('can subscribe with a valid query and gets a subId back', function() {
    const query = 'subscription X{ testSubscription }';
    const callback = () => null;
    return subManager.subscribe({ query, operationName: 'X', callback }).then(subId => {
      expect(typeof subId).toBe('number');
      subManager.unsubscribe(subId);
    });
  });

  it('can subscribe with a valid query and get the root value', function(done) {
    const query = 'subscription X{ testSubscription }';
    const callback = function(err, payload){
      expect(payload.data.testSubscription).toBe('good');
      done();
    };

    subManager.subscribe({ query, operationName: 'X', callback }).then(subId => {
      subManager.publish('testSubscription', 'good');
      setTimeout(() => {
        subManager.unsubscribe(subId);
      }, 2);
    });
  });

  it('can use filter functions properly', function(done) {
    const query = `subscription Filter1($filterBoolean: Boolean){
       testFilter(filterBoolean: $filterBoolean)
      }`;
    const callback = function(err, payload){
      expect(payload.data.testFilter).toBe('goodFilter');
      done();
    };
    subManager.subscribe({
      query,
      operationName: 'Filter1',
      variables: { filterBoolean: true},
      callback,
    }).then(subId => {
      subManager.publish('Filter1', {filterBoolean: false });
      subManager.publish('Filter1', {filterBoolean: true });
      setTimeout(() => {
        subManager.unsubscribe(subId);
      }, 4);
    });
  });

  it('can subscribe to more than one trigger', function(done) {
    // I also used this for testing arg parsing (with console.log)
    // args a and b can safely be removed.
    // TODO: write real tests for argument parsing
    let triggerCount = 0;
    const query = `subscription multiTrigger($filterBoolean: Boolean, $uga: String){
       testFilterMulti(filterBoolean: $filterBoolean, a: $uga, b: 66)
      }`;
    const callback = function(err, payload){
      expect(payload.data.testFilterMulti).toBe('goodFilter');
      triggerCount++;
      if (triggerCount === 2) {
        done();
      }
    };
    subManager.subscribe({
      query,
      operationName: 'multiTrigger',
      variables: { filterBoolean: true, uga: 'UGA'},
      callback,
    }).then(subId => {
      subManager.publish('NotATrigger', {filterBoolean: false});
      subManager.publish('Trigger1', {filterBoolean: true });
      subManager.publish('Trigger2', {filterBoolean: true });
      setTimeout(() => {
        subManager.unsubscribe(subId);
      }, 6);
    });
  });

  it('can unsubscribe', function(done) {
    const query = 'subscription X{ testSubscription }';
    const callback = (err, payload) => {
      assert(false);
      done();
    };
    subManager.subscribe({ query, operationName: 'X', callback }).then(subId => {
      subManager.unsubscribe(subId);
      subManager.publish('testSubscription', 'bad');
      setTimeout(done, 1000);
    });
  });

  it('throws an error when trying to unsubscribe from unknown id', function () {
    expect(() => subManager.unsubscribe(123)).toThrowError('undefined');
  });

  it('calls the error callback if there is an execution error', function(done) {
    const query = `subscription X($uga: Boolean!){
      testSubscription  @skip(if: $uga)
    }`;
    const callback = function(err, payload){
      expect(payload).toBeUndefined();
      expect(err.message).toBe('Variable "$uga" of required type "Boolean!" was not provided.');
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
    const triggerTransform = (trigger, {path}) => [trigger, ...path].join('.');
    const pubsub = new RedisPubSub({
      triggerTransform,
    });

    const subManager2 = new SubscriptionManager({
      schema,
      setupFunctions: {
        testChannelOptions: (options, {repoName}) => ({
          comments: {
            channelOptions: {path: [repoName]},
          },
        }),
      },
      pubsub,
    });

    const callback = (err, payload) => {
      expect(payload.data.testChannelOptions).toBe('test');
      done();
    };

    const query = `
      subscription X($repoName: String!) {
        testChannelOptions(repoName: $repoName)
      }
    `;

    const variables = {repoName: 'graphql-redis-subscriptions'};

    subManager2.subscribe({query, operationName: 'X', variables, callback}).then(subId => {
      pubsub.publish('comments.graphql-redis-subscriptions', 'test');

      setTimeout(() => pubsub.unsubscribe(subId), 4);
    });

  });
});
