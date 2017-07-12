import * as chai from 'chai';
import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLString,
  GraphQLFloat,
  GraphQLInt,
  GraphQLID,
} from 'graphql';

import { SubscriptionManager, PubSub } from 'graphql-subscriptions';
import { RedisPubSub } from '../redis-pubsub';

const expect = chai.expect;

const User = new GraphQLObjectType({
  name: 'User',
  fields: {
    login: {
      type: GraphQLString,
    },
    avatar_url: {
      type: GraphQLString,
    },
    html_url: {
      type: GraphQLString,
    },
    name: {
      type: GraphQLString,
    },
    last_visit: {
      type: GraphQLFloat,
    },
  },
});

const Comment = new GraphQLObjectType({
  name: 'Comment',
  fields: {
    id: {
      type: GraphQLID,
    },
    content: {
      type: GraphQLString,
    },
    repoName: {
      type: GraphQLString,
    },
    createdAt: {
      type: GraphQLFloat,
    },
    attachedImage: {
      type: GraphQLString,
    },
    likes: {
      type: GraphQLInt,
    },
    postedBy: {
      type: User,
    },
  },
});

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
      testSubscription2: {
        type: GraphQLString,
        resolve: function (root) {
          return root;
        },
      },
      commentAdded: {
        type: Comment,
        resolve: function (root) {
          return root;
        },
      },
    },
  }),
  types: [Comment, User],
});

describe('Benchmark EE PubSub', function () {
  const subManager = new SubscriptionManager({
    schema,
    setupFunctions: {},
    pubsub: new PubSub(),
  });

  describe('multiple subscribers to channel', function () {

    const numberOfSubscribers = 30000;
    const subsPromises = [];
    let publishesCounter = 0;
    let subIds = [];

    before(`Subscribe to ${numberOfSubscribers}`, function (done) {
      this.timeout(10000);
      publishesCounter = 0;
      const query = 'subscription X{ testSubscription }';
      const callback = () => publishesCounter++;

      for (let i = 0; i < numberOfSubscribers; i++) {
        const promise = subManager.subscribe({ query, operationName: 'X', callback });
        subsPromises.push(promise);
      }

      Promise.all(subsPromises).then(ids => {
        subIds = ids;
        done();
      }).catch(done);
    });

    after('Unsubscribe', function (done) {
      this.timeout(10000);
      subIds.forEach((subId, index) => {
        expect(subId).to.be.a('number');
        subManager.unsubscribe(subId);

        if (index >= subIds.length - 1) {
          done();
        }
      });
    });

    it(`should be able to publish to ${numberOfSubscribers} subscribers under a second`, function (done) {

      this.slow(1000);

      // Publish to all subscribers
      subManager.publish('testSubscription', 'small event');
      setTimeout(() => {
        try {
          expect(publishesCounter).to.equals(numberOfSubscribers);
          done();
        } catch (e) {
          done(e);
        }
      }, 10);

    });
  });

  describe('multiple events to channel', function () {
    this.timeout(10000);
    const smallEventsPerSec = 30000;
    const mediumEventsPerSec = 30000;
    const largeEventsPerSec = 30000;
    const mutationsPerSec = 30000;
    const smallQueriesPerSec = 19700;
    const mediumQueryPerSec = 16600;
    const fullQueryPerSec = 14600;

    it(`should be able to publish ${smallEventsPerSec} small events under a second`, function (done) {
      const query = 'subscription X{ testSubscription2 }';
      const payload = 'small event';
      testEventsPerSecond.call(this, smallEventsPerSec, payload, subManager, query, done);
    });

    const mediumEventSize = 5000;
    let mediumMessage = '';
    for (let i = 0; i < mediumEventSize; i++) {
      mediumMessage += 'e';
    }

    it(`should be able to publish ${mediumEventsPerSec} medium events under a second`, function (done) {
      const query = 'subscription X{ testSubscription2 }';
      testEventsPerSecond.call(this, mediumEventsPerSec, mediumMessage, subManager, query, done);
    });

    const largeEventSize = 50000;
    let largeMessage = '';
    for (let i = 0; i < largeEventSize; i++) {
      largeMessage += 'e';
    }

    it(`should be able to publish ${largeEventsPerSec} large events under a second`, function (done) {
      const query = 'subscription X{ testSubscription2 }';
      testEventsPerSecond.call(this, largeEventsPerSec, largeMessage, subManager, query, done);
    });

    let mutationResult = {
      content: 'Very good example',
      repoName: 'graphql-redis-subscriptions',
      attachedImage: 'https://avatars1.githubusercontent.com/u/2580920?v=3&s=466',
      likes: 5,
      postedBy: {
        login: 'davidyaha',
        avatar_url: 'https://avatars1.githubusercontent.com/u/2580920?v=3&s=466',
        html_url: 'https://twitter.com/davidyahalomi',
        name: 'David Yahalomi',
        last_visit: Date.now(),
      },
    };

    it(`should be able to publish ${mutationsPerSec} empty query mutation results under a second`, function (done) {
      const query = `subscription X{
        commentAdded {
          id
        }
      }`;
      testMutationsPerSecond.call(this, mutationsPerSec, mutationResult, subManager, query, done);
    });

    it(`should be able to publish ${smallQueriesPerSec} small query mutation results under a second`, function (done) {
      const query = `subscription X{
        commentAdded {
          id
          createdAt
          postedBy {
            login
          }
        }
      }`;
      testMutationsPerSecond.call(this, smallQueriesPerSec, mutationResult, subManager, query, done);
    });

    it(`should be able to publish ${mediumQueryPerSec} medium query mutation results under a second`, function (done) {
      const query = `subscription X{
        commentAdded {
          id
          createdAt
          content
          repoName
          postedBy {
            login
            avatar_url
            html_url
          }
        }
      }`;
      testMutationsPerSecond.call(this, mediumQueryPerSec, mutationResult, subManager, query, done);
    });

    it(`should be able to publish ${fullQueryPerSec} full query mutation results under a second`, function (done) {
      const query = `subscription X{
        commentAdded {
          id
          createdAt
          content
          repoName
          attachedImage
          likes
          postedBy {
            login
            avatar_url
            html_url
            name
            last_visit
          }
        }
      }`;
      testMutationsPerSecond.call(this, fullQueryPerSec, mutationResult, subManager, query, done);
    });
  });
});

describe('Benchmark Redis PubSub', function () {
  const subManager = new SubscriptionManager({
    schema,
    setupFunctions: {},
    pubsub: new RedisPubSub(),
  });

  describe('multiple subscribers to channel', function () {

    const numberOfSubscribers = 30000;
    const subsPromises = [];
    let publishesCounter = 0;
    let subIds = [];

    before(`Subscribe to ${numberOfSubscribers}`, function (done) {
      this.timeout(10000);
      publishesCounter = 0;
      const query = 'subscription X{ testSubscription }';
      const callback = () => publishesCounter++;

      for (let i = 0; i < numberOfSubscribers; i++) {
        const promise = subManager.subscribe({ query, operationName: 'X', callback });
        subsPromises.push(promise);
      }

      Promise.all(subsPromises).then(ids => {
        subIds = ids;
        done();
      }).catch(done);
    });

    after('Unsubscribe', function (done) {
      this.timeout(10000);
      subIds.forEach((subId, index) => {
        expect(subId).to.be.a('number');
        subManager.unsubscribe(subId);

        if (index >= subIds.length - 1) {
          done();
        }
      });
    });

    it(`should be able to publish to ${numberOfSubscribers} subscribers under a second`, function (done) {

      this.slow(1000);

      // Publish to all subscribers
      subManager.publish('testSubscription', 'small event');
      setTimeout(() => {
        try {
          expect(publishesCounter).to.equals(numberOfSubscribers);
          done();
        } catch (e) {
          done(e);
        }
      }, 10);

    });
  });

  describe('multiple events to channel', function () {
    this.timeout(10000);
    const smallEventsPerSec = 14000;
    const mediumEventsPerSec = 5000;
    const largeEventsPerSec = 340;
    const mutationsPerSec = 10500;
    const smallQueriesPerSec = 9500;
    const mediumQueryPerSec = 8700;
    const fullQueryPerSec = 7700;

    it(`should be able to publish ${smallEventsPerSec} small events under a second`, function (done) {
      const query = 'subscription X{ testSubscription2 }';
      const payload = 'small event';
      testEventsPerSecond.call(this, smallEventsPerSec, payload, subManager, query, done);
    });

    const mediumEventSize = 5000;
    let mediumMessage = '';
    for (let i = 0; i < mediumEventSize; i++) {
      mediumMessage += 'e';
    }

    it(`should be able to publish ${mediumEventsPerSec} medium events under a second`, function (done) {
      const query = 'subscription X{ testSubscription2 }';
      testEventsPerSecond.call(this, mediumEventsPerSec, mediumMessage, subManager, query, done);
    });

    const largeEventSize = 50000;
    let largeMessage = '';
    for (let i = 0; i < largeEventSize; i++) {
      largeMessage += 'e';
    }

    it(`should be able to publish ${largeEventsPerSec} large events under a second`, function (done) {
      const query = 'subscription X{ testSubscription2 }';
      testEventsPerSecond.call(this, largeEventsPerSec, largeMessage, subManager, query, done);
    });

    let mutationResult = {
      content: 'Very good example',
      repoName: 'graphql-redis-subscriptions',
      attachedImage: 'https://avatars1.githubusercontent.com/u/2580920?v=3&s=466',
      likes: 5,
      postedBy: {
        login: 'davidyaha',
        avatar_url: 'https://avatars1.githubusercontent.com/u/2580920?v=3&s=466',
        html_url: 'https://twitter.com/davidyahalomi',
        name: 'David Yahalomi',
        last_visit: Date.now(),
      },
    };

    it(`should be able to publish ${mutationsPerSec} empty query mutation results under a second`, function (done) {
      const query = `subscription X{
        commentAdded {
          id
        }
      }`;
      testMutationsPerSecond.call(this, mutationsPerSec, mutationResult, subManager, query, done);
    });

    it(`should be able to publish ${smallQueriesPerSec} small query mutation results under a second`, function (done) {
      const query = `subscription X{
        commentAdded {
          id
          createdAt
          postedBy {
            login
          }
        }
      }`;
      testMutationsPerSecond.call(this, smallQueriesPerSec, mutationResult, subManager, query, done);
    });

    it(`should be able to publish ${mediumQueryPerSec} medium query mutation results under a second`, function (done) {
      const query = `subscription X{
        commentAdded {
          id
          createdAt
          content
          repoName
          postedBy {
            login
            avatar_url
            html_url
          }
        }
      }`;
      testMutationsPerSecond.call(this, mediumQueryPerSec, mutationResult, subManager, query, done);
    });

    it(`should be able to publish ${fullQueryPerSec} full query mutation results under a second`, function (done) {
      const query = `subscription X{
        commentAdded {
          id
          createdAt
          content
          repoName
          attachedImage
          likes
          postedBy {
            login
            avatar_url
            html_url
            name
            last_visit
          }
        }
      }`;
      testMutationsPerSecond.call(this, fullQueryPerSec, mutationResult, subManager, query, done);
    });
  });
});

function testEventsPerSecond(eventsPerSec: number, eventPayload: any, subManager: SubscriptionManager, query: string, done) {
  this.slow(1500);
  let start;

  let publishesCounter = 0;
  let subId;

  const callback = () => {
    if (++publishesCounter === eventsPerSec) {
      try {
        expect(Date.now() - start).to.below(1000);
        subManager.unsubscribe(subId);
        done();
      } catch (e) {
        done(e);
      }
    }
  };

  subManager.subscribe({ query, operationName: 'X', callback }).then(id => {
    subId = id;
    start = Date.now();
    for (let i = 0; i < eventsPerSec; i++) {
      subManager.publish('testSubscription2', eventPayload);
    }
  }).catch(done);
}

function testMutationsPerSecond(mutationsPerSec: number, mutationPayload: any, subManager: SubscriptionManager, query: string, done) {
  this.slow(1500);
  let start;

  let publishesCounter = 0;
  let subId;
  const callback = (err, event) => {
    if (err) {
      done(err);
    }

    if (++publishesCounter === mutationsPerSec) {
      try {
        expect(Date.now() - start).to.below(1000);

        const commentId = event.data.commentAdded.id;
        expect(commentId).to.equals(String(mutationsPerSec));

        subManager.unsubscribe(subId);

        done();
      } catch (e) {
        done(e);
      }
    }
  };

  subManager.subscribe({ query, operationName: 'X', callback }).then(id => {
    subId = id;
    start = Date.now();
    for (let i = 0; i < mutationsPerSec; i++) {
      mutationPayload['id'] = i + 1;
      mutationPayload['createdAt'] = Date.now();

      subManager.publish('commentAdded', mutationPayload);
    }
  }).catch(done);
}
