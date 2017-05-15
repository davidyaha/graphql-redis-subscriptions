// -------------- Mocking Redis Client ------------------

const mockSubscribe = jest.fn((channel, cb) => cb && cb(null, channel));
const mockUnsubscribe = jest.fn((channel, cb) => cb && cb(channel));

jest.mock('redis', () => {
  let listener;
  return {
    createClient: () => ({
      publish: (channel, message) => listener && listener(channel, message),
      subscribe: mockSubscribe,
      unsubscribe: mockUnsubscribe,
      on: (event, cb) => {
        if (event === 'message') {
          listener = cb;
        }
      },
    }),
  };
});

// -------------- Mocking Redis Client ------------------

import {RedisPubSub} from '../redis-pubsub';

describe('RedisPubSub', function () {

  const pubSub = new RedisPubSub();

  it('can subscribe to specific redis channel and called when a message is published on it', function () {
    const onMessageSpy = jest.fn();
    return pubSub.subscribe('Posts', onMessageSpy).then(subId => {
      expect(typeof subId).toBe('number');
      pubSub.publish('Posts', 'test');
      expect(onMessageSpy).toHaveBeenCalledWith('test');

      pubSub.unsubscribe(subId);
    });
  });

  it('can unsubscribe from specific redis channel', function () {
    return pubSub.subscribe('Posts', () => null).then(subId => {
      pubSub.unsubscribe(subId);
      expect(mockUnsubscribe).toHaveBeenCalledWith('Posts');
    });
  });

  it('cleans up correctly the memory when unsubscribing', function () {
    return Promise.all([
      pubSub.subscribe('Posts', () => null),
      pubSub.subscribe('Posts', () => null),
    ])
    .then(([subId, secondSubId]) => {
        // This assertion is done against a private member, if you change the internals, you may want to change that
        expect((pubSub as any).subscriptionMap[subId]).not.toBeUndefined();
        pubSub.unsubscribe(subId);
        // This assertion is done against a private member, if you change the internals, you may want to change that
        expect((pubSub as any).subscriptionMap[subId]).toBeUndefined();
        expect(() => pubSub.unsubscribe(subId)).toThrow(`There is no subscription of id "${subId}"`);
        pubSub.unsubscribe(secondSubId);
    });
  });

  it('will not unsubscribe from the redis channel if there is another subscriber on it\'s subscriber list', function () {
    const onMessageSpy = jest.fn();
    const shouldNotBeCalledSpy = jest.fn();
    const subscriptionPromises = [
      pubSub.subscribe('Posts', onMessageSpy),
      pubSub.subscribe('Posts', onMessageSpy),
    ];

    return Promise.all(subscriptionPromises).then(subIds => {
      expect(subIds).toHaveLength(2);

      pubSub.unsubscribe(subIds[0]);
      expect(mockUnsubscribe).not.toHaveBeenCalled();

      pubSub.publish('Posts', 'test');
      expect(onMessageSpy).toHaveBeenCalledWith('test');
      expect(shouldNotBeCalledSpy).not.toHaveBeenCalled();

      pubSub.unsubscribe(subIds[1]);
      expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
    });
  });

  it('will subscribe to redis channel only once', function () {
    const onMessage = () => null;
    const subscriptionPromises = [
      pubSub.subscribe('Posts', onMessage),
      pubSub.subscribe('Posts', onMessage),
    ];

    return Promise.all(subscriptionPromises).then(subIds => {
      expect(subIds).toHaveLength(2);
      expect(mockSubscribe).toHaveBeenCalledTimes(1);

      pubSub.unsubscribe(subIds[0]);
      pubSub.unsubscribe(subIds[1]);
    });
  });

  it('can have multiple subscribers and all will be called when a message is published to this channel', function () {
    const onMessageSpy = jest.fn();
    const subscriptionPromises = [
      pubSub.subscribe('Posts', onMessageSpy as Function),
      pubSub.subscribe('Posts', onMessageSpy as Function),
    ];

    return Promise.all(subscriptionPromises).then(subIds => {
      expect(subIds).toHaveLength(2);

      pubSub.publish('Posts', 'test');

      expect(onMessageSpy).toHaveBeenCalledTimes(2);
      onMessageSpy.mock.calls.forEach(callArgs => {
        expect(callArgs).toContain('test');
      });

      pubSub.unsubscribe(subIds[0]);
      pubSub.unsubscribe(subIds[1]);
    });
  });

  it('can publish objects as well', function () {
    const onMessageSpy = jest.fn();
    return pubSub.subscribe('Posts', onMessageSpy).then(subId => {
      const message = {comment : 'This is amazing'};
      pubSub.publish('Posts', message);

      expect(onMessageSpy).toHaveBeenCalledWith(message);

      pubSub.unsubscribe(subId);
    });
  });

  it('throws if you try to unsubscribe with an unknown id', function () {
    return expect(() => pubSub.unsubscribe(123))
      .toThrow('There is no subscription of id "123"');
  });

  it('can use transform function to convert the trigger name given into more explicit channel name', function () {
    const triggerTransform = (trigger, {repoName}) => `${trigger}.${repoName}`;
    const pubsub = new RedisPubSub({
      triggerTransform,
    });

    const onMessageSpy = jest.fn();

    return pubsub.subscribe('comments', onMessageSpy, {repoName: 'graphql-redis-subscriptions'})
      .then(subId => {
        pubsub.publish('comments.graphql-redis-subscriptions', 'test');

        expect(onMessageSpy).toHaveBeenCalledWith('test');

        pubsub.unsubscribe(subId);
      });

  });

  // TODO pattern subs

  // Reset spy count
  afterEach(() => {
    mockSubscribe.mockClear();
    mockUnsubscribe.mockClear();
  });

  // Restore redis client
  afterAll(() => {
    jest.resetModules();
  });

});
