import * as chai from 'chai';
import * as chaiAsPromised from 'chai-as-promised';
import { spy, restore, stub } from 'simple-mock';
import { RedisPubSub } from '../redis-pubsub';
import * as IORedis from 'ioredis';

chai.use(chaiAsPromised);
const expect = chai.expect;

// -------------- Mocking Redis Client ------------------

let listener;

const publishSpy = spy((channel, message) => listener && listener(channel, message));
const subscribeSpy = spy((channel, cb) => cb && cb(null, channel));
const unsubscribeSpy = spy((channel, cb) => cb && cb(channel));
const psubscribeSpy = spy((channel, cb) => cb && cb(null, channel));
const punsubscribeSpy = spy((channel, cb) => cb && cb(channel));

const quitSpy = spy(cb => cb);
const mockRedisClient = {
  publish: publishSpy,
  subscribe: subscribeSpy,
  unsubscribe: unsubscribeSpy,
  psubscribe: psubscribeSpy,
  punsubscribe: punsubscribeSpy,
  on: (event, cb) => {
    if (event === 'message') {
      listener = cb;
    }
  },
  quit: quitSpy,
};
const mockOptions = {
  publisher: (mockRedisClient as any),
  subscriber: (mockRedisClient as any),
};



// -------------- Mocking Redis Client ------------------

describe('RedisPubSub', () => {

  it('should create default ioredis clients if none were provided', done => {
    const pubSub = new RedisPubSub();
    expect(pubSub.getSubscriber()).to.be.an.instanceOf(IORedis);
    expect(pubSub.getPublisher()).to.be.an.instanceOf(IORedis);
    pubSub.close();
    done();
  });

  it('should verify close calls pub and sub quit methods', done => {
    const pubSub = new RedisPubSub(mockOptions);

    pubSub.close()
      .then(() => {
        expect(quitSpy.callCount).to.equal(2);
        done();
      })
      .catch(done);
  });

  it('can subscribe to specific redis channel and called when a message is published on it', done => {
    const pubSub = new RedisPubSub(mockOptions);
    pubSub.subscribe('Posts', message => {
      try {
        expect(message).to.equals('test');
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

  it('can subscribe to a redis channel pattern and called when a message is published on it', done => {
    const pubSub = new RedisPubSub(mockOptions);

    pubSub.subscribe('Posts*', message => {
      try {
        expect(psubscribeSpy.callCount).to.equal(1);
        expect(message).to.equals('test');
        done();
      } catch (e) {
        done(e);
      }
    }, { pattern: true }).then(async subId => {
      expect(subId).to.be.a('number');
      await pubSub.publish('Posts*', 'test');
      pubSub.unsubscribe(subId);
    });
  });

  it('can unsubscribe from specific redis channel', done => {
    const pubSub = new RedisPubSub(mockOptions);
    pubSub.subscribe('Posts', () => null).then(subId => {
      pubSub.unsubscribe(subId);

      try {

        expect(unsubscribeSpy.callCount).to.equals(1);
        expect(unsubscribeSpy.lastCall.args).to.have.members(['Posts']);

        expect(punsubscribeSpy.callCount).to.equals(1);
        expect(punsubscribeSpy.lastCall.args).to.have.members(['Posts']);

        done();

      } catch (e) {
        done(e);
      }
    });
  });

  it('cleans up correctly the memory when unsubscribing', done => {
    const pubSub = new RedisPubSub(mockOptions);
    Promise.all([
      pubSub.subscribe('Posts', () => null),
      pubSub.subscribe('Posts', () => null),
    ])
      .then(([subId, secondSubId]) => {
        try {
          // This assertion is done against a private member, if you change the internals, you may want to change that
          expect((pubSub as any).subscriptionMap[subId]).not.to.be.an('undefined');
          pubSub.unsubscribe(subId);
          // This assertion is done against a private member, if you change the internals, you may want to change that
          expect((pubSub as any).subscriptionMap[subId]).to.be.an('undefined');
          expect(() => pubSub.unsubscribe(subId)).to.throw(`There is no subscription of id "${subId}"`);
          pubSub.unsubscribe(secondSubId);
          done();

        } catch (e) {
          done(e);
        }
      });
  });

  it('concurrent subscribe, unsubscribe first sub before second sub complete', done => {
    const promises = {
      firstSub: null as Promise<number>,
      secondSub: null as Promise<number>,
    }

    let firstCb, secondCb
    const redisSubCallback = (channel, cb) => {
      process.nextTick(() => {
        if (!firstCb) {
          firstCb = () => cb(null, channel)
          // Handling first call, init second sub
          promises.secondSub = pubSub.subscribe('Posts', () => null)
          // Continue first sub callback
          firstCb()
        } else {
          secondCb = () => cb(null, channel)
        }
      })
    }
    const subscribeStub = stub().callFn(redisSubCallback);
    const mockRedisClientWithSubStub = {...mockRedisClient, ...{subscribe: subscribeStub}};
    const mockOptionsWithSubStub = {...mockOptions, ...{subscriber: (mockRedisClientWithSubStub as any)}}
    const pubSub = new RedisPubSub(mockOptionsWithSubStub);

    // First leg of the test, init first sub and immediately unsubscribe. The second sub is triggered in the redis cb
    // before the first promise sub complete
    promises.firstSub = pubSub.subscribe('Posts', () => null)
      .then(subId => {
        // This assertion is done against a private member, if you change the internals, you may want to change that
        expect((pubSub as any).subscriptionMap[subId]).not.to.be.an('undefined');
        pubSub.unsubscribe(subId);

        // Continue second sub callback
        promises.firstSub.then(() => secondCb())
        return subId;
      });

    // Second leg of the test, here we have unsubscribed from the first sub. We try unsubbing from the second sub
    // as soon it is ready
    promises.firstSub
      .then((subId) => {
        // This assertion is done against a private member, if you change the internals, you may want to change that
        expect((pubSub as any).subscriptionMap[subId]).to.be.an('undefined');
        expect(() => pubSub.unsubscribe(subId)).to.throw(`There is no subscription of id "${subId}"`);

        return promises.secondSub.then(secondSubId => {
          pubSub.unsubscribe(secondSubId);
        })
      .then(done)
      .catch(done)
    });
  });

  it('will not unsubscribe from the redis channel if there is another subscriber on it\'s subscriber list', done => {
    const pubSub = new RedisPubSub(mockOptions);
    const subscriptionPromises = [
      pubSub.subscribe('Posts', () => {
        done('Not supposed to be triggered');
      }),
      pubSub.subscribe('Posts', (msg) => {
        try {
          expect(msg).to.equals('test');
          done();
        } catch (e) {
          done(e);
        }
      }),
    ];

    Promise.all(subscriptionPromises).then(async subIds => {
      try {
        expect(subIds.length).to.equals(2);

        pubSub.unsubscribe(subIds[0]);
        expect(unsubscribeSpy.callCount).to.equals(0);

        await pubSub.publish('Posts', 'test');
        pubSub.unsubscribe(subIds[1]);
        expect(unsubscribeSpy.callCount).to.equals(1);
      } catch (e) {
        done(e);
      }
    });
  });

  it('will subscribe to redis channel only once', done => {
    const pubSub = new RedisPubSub(mockOptions);
    const onMessage = () => null;
    const subscriptionPromises = [
      pubSub.subscribe('Posts', onMessage),
      pubSub.subscribe('Posts', onMessage),
    ];

    Promise.all(subscriptionPromises).then(subIds => {
      try {
        expect(subIds.length).to.equals(2);
        expect(subscribeSpy.callCount).to.equals(1);

        pubSub.unsubscribe(subIds[0]);
        pubSub.unsubscribe(subIds[1]);
        done();
      } catch (e) {
        done(e);
      }
    });
  });

  it('can have multiple subscribers and all will be called when a message is published to this channel', done => {
    const pubSub = new RedisPubSub(mockOptions);
    const onMessageSpy = spy(() => null);
    const subscriptionPromises = [
      pubSub.subscribe('Posts', onMessageSpy),
      pubSub.subscribe('Posts', onMessageSpy),
    ];

    Promise.all(subscriptionPromises).then(async subIds => {
      try {
        expect(subIds.length).to.equals(2);

        await pubSub.publish('Posts', 'test');

        expect(onMessageSpy.callCount).to.equals(2);
        onMessageSpy.calls.forEach(call => {
          expect(call.args).to.have.members(['test']);
        });

        pubSub.unsubscribe(subIds[0]);
        pubSub.unsubscribe(subIds[1]);
        done();
      } catch (e) {
        done(e);
      }
    });
  });

  it('can publish objects as well', done => {
    const pubSub = new RedisPubSub(mockOptions);
    pubSub.subscribe('Posts', message => {
      try {
        expect(message).to.have.property('comment', 'This is amazing');
        done();
      } catch (e) {
        done(e);
      }
    }).then(async subId => {
      try {
        await pubSub.publish('Posts', { comment: 'This is amazing' });
        pubSub.unsubscribe(subId);
      } catch (e) {
        done(e);
      }
    });
  });

  it('can accept custom reviver option (eg. for Javascript Dates)', done => {
    const dateReviver = (key, value) => {
      const isISO8601Z = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}(?:\.\d*)?)Z$/;
      if (typeof value === 'string' && isISO8601Z.test(value)) {
        const tempDateNumber = Date.parse(value);
        if (!isNaN(tempDateNumber)) {
          return new Date(tempDateNumber);
        }
      }
      return value;
    };

    const pubSub = new RedisPubSub({...mockOptions, reviver: dateReviver});
    const validTime = new Date();
    const invalidTime = '2018-13-01T12:00:00Z';
    pubSub.subscribe('Times', message => {
      try {
        expect(message).to.have.property('invalidTime', invalidTime);
        expect(message).to.have.property('validTime');
        expect(message.validTime.getTime()).to.equals(validTime.getTime());
        done();
      } catch (e) {
        done(e);
      }
    }).then(async subId => {
      try {
        await pubSub.publish('Times', { validTime, invalidTime });
        pubSub.unsubscribe(subId);
      } catch (e) {
        done(e);
      }
    });
  });

  it('refuses custom reviver with a deserializer', done => {
    const reviver = stub();
    const deserializer = stub();

    try {
      expect(() => new RedisPubSub({...mockOptions, reviver, deserializer}))
          .to.throw("Reviver and deserializer can't be used together");
      done();
    } catch (e) {
      done(e);
    }
  });

  it('allows to use a custom serializer', done => {
    const serializer = stub();
    const serializedPayload = `{ "hello": "custom" }`;
    serializer.returnWith(serializedPayload);

    const pubSub = new RedisPubSub({...mockOptions, serializer });

    try {
      pubSub.subscribe('TOPIC', message => {
        try {
          expect(message).to.eql({hello: 'custom'});
          done();
        } catch (e) {
          done(e);
        }
      }).then(() => {
        pubSub.publish('TOPIC', {hello: 'world'});
      });
    } catch (e) {
      done(e);
    }
  });

  it('custom serializer can throw an error', done => {
    const serializer = stub();
    serializer.throwWith(new Error('Custom serialization error'));

    const pubSub = new RedisPubSub({...mockOptions, serializer });

    try {
      pubSub.publish('TOPIC', {hello: 'world'}).then(() => {
        done(new Error('Expected error to be thrown upon publish'));
     }, err => {
        expect(err.message).to.eql('Custom serialization error');
        done();
      });
    } catch (e) {
      done(e);
    }
  });

  it('allows to use a custom deserializer', done => {
    const deserializer = stub();
    const deserializedPayload = { hello: 'custom' };
    deserializer.returnWith(deserializedPayload);

    const pubSub = new RedisPubSub({...mockOptions, deserializer });

    try {
      pubSub.subscribe('TOPIC', message => {
        try {
          expect(message).to.eql({hello: 'custom'});
          done();
        } catch (e) {
          done(e);
        }
      }).then(() => {
        pubSub.publish('TOPIC', {hello: 'world'});
      });
    } catch (e) {
      done(e);
    }
  });

  it('unparsed payload is returned if custom deserializer throws an error', done => {
    const deserializer = stub();
    deserializer.throwWith(new Error('Custom deserialization error'));

    const pubSub = new RedisPubSub({...mockOptions, deserializer });

    try {
      pubSub.subscribe('TOPIC', message => {
        try {
          expect(message).to.be.a('string');
          expect(message).to.eql('{"hello":"world"}');
          done();
        } catch (e) {
          done(e);
        }
      }).then(() => {
        pubSub.publish('TOPIC', {hello: 'world'});
      });
    } catch (e) {
      done(e);
    }
  });

  it('throws if you try to unsubscribe with an unknown id', () => {
    const pubSub = new RedisPubSub(mockOptions);
    return expect(() => pubSub.unsubscribe(123))
      .to.throw('There is no subscription of id "123"');
  });

  it('can use transform function to convert the trigger name given into more explicit channel name', done => {
    const triggerTransform = (trigger, { repoName }) => `${trigger}.${repoName}`;
    const pubSub = new RedisPubSub({
      triggerTransform,
      publisher: (mockRedisClient as any),
      subscriber: (mockRedisClient as any),
    });

    const validateMessage = message => {
      try {
        expect(message).to.equals('test');
        done();
      } catch (e) {
        done(e);
      }
    };

    pubSub.subscribe('comments', validateMessage, { repoName: 'graphql-redis-subscriptions' }).then(async subId => {
      await pubSub.publish('comments.graphql-redis-subscriptions', 'test');
      pubSub.unsubscribe(subId);
    });

  });

  // TODO pattern subs

  afterEach('Reset spy count', () => {
    publishSpy.reset();
    subscribeSpy.reset();
    unsubscribeSpy.reset();
    psubscribeSpy.reset();
    punsubscribeSpy.reset();
  });

  after('Restore redis client', () => {
    restore();
  });

});

describe('PubSubAsyncIterator', () => {

  it('should expose valid asyncItrator for a specific event', () => {
    const pubSub = new RedisPubSub(mockOptions);
    const eventName = 'test';
    const iterator = pubSub.asyncIterator(eventName);
    // tslint:disable-next-line:no-unused-expression
		expect(iterator).to.exist;
		// tslint:disable-next-line:no-unused-expression
		expect(iterator[Symbol.asyncIterator]).not.to.be.undefined;
  });

  it('should trigger event on asyncIterator when published', done => {
    const pubSub = new RedisPubSub(mockOptions);
    const eventName = 'test';
    const iterator = pubSub.asyncIterator(eventName);

    iterator.next().then(result => {
      // tslint:disable-next-line:no-unused-expression
      expect(result).to.exist;
      // tslint:disable-next-line:no-unused-expression
      expect(result.value).to.exist;
      // tslint:disable-next-line:no-unused-expression
      expect(result.done).to.exist;
      done();
    });

    pubSub.publish(eventName, { test: true });
  });

  it('should not trigger event on asyncIterator when publishing other event', async () => {
    const pubSub = new RedisPubSub(mockOptions);
    const eventName = 'test2';
    const iterator = pubSub.asyncIterator('test');
    const triggerSpy = spy(() => undefined);

    iterator.next().then(triggerSpy);
    await pubSub.publish(eventName, { test: true });
    expect(triggerSpy.callCount).to.equal(0);
  });

  it('register to multiple events', done => {
    const pubSub = new RedisPubSub(mockOptions);
    const eventName = 'test2';
    const iterator = pubSub.asyncIterator(['test', 'test2']);
    const triggerSpy = spy(() => undefined);

    iterator.next().then(() => {
      triggerSpy();
      expect(triggerSpy.callCount).to.be.gte(1);
      done();
    });
    pubSub.publish(eventName, { test: true });
  });

  it('should not trigger event on asyncIterator already returned', done => {
    const pubSub = new RedisPubSub(mockOptions);
    const eventName = 'test';
    const iterator = pubSub.asyncIterator<any>(eventName);

    iterator.next().then(result => {
      // tslint:disable-next-line:no-unused-expression
      expect(result).to.exist;
      // tslint:disable-next-line:no-unused-expression
      expect(result.value).to.exist;
      expect(result.value.test).to.equal('word');
      // tslint:disable-next-line:no-unused-expression
      expect(result.done).to.be.false;
    });

    pubSub.publish(eventName, { test: 'word' }).then(() => {
      iterator.next().then(result => {
        // tslint:disable-next-line:no-unused-expression
        expect(result).to.exist;
        // tslint:disable-next-line:no-unused-expression
        expect(result.value).not.to.exist;
        // tslint:disable-next-line:no-unused-expression
        expect(result.done).to.be.true;
        done();
      });

      iterator.return();
      pubSub.publish(eventName, { test: true });
    });
  });

});
