import * as chai from 'chai';
import * as chaiAsPromised from 'chai-as-promised';
import { RedisStreamPubSub, StreamsMessage } from '../redis-stream-pubsub';
const expect = chai.expect;
chai.use(chaiAsPromised);

const redisHost = process.env.TEST_REDIS_HOST || 'localhost';

let pubSub: RedisStreamPubSub;
describe('redis stream pubsub', () => {
  beforeEach(() => {
    pubSub = new RedisStreamPubSub({
      connection: {
        host: redisHost,
        port: 6379,
      }
    });
  });

  afterEach(async () => {
    return await pubSub.close();
  });

  it('should subscribe on a channel and receive messages on that channel', () => {
    const testStream = 'teststream';
    const expectedMessage = { foo: 'bar' };

    const subscribePromise = new Promise((res, rej) => {
      pubSub.subscribe<StreamsMessage<any>>(testStream, message => res(message.data));
    });
    
    setTimeout(() => {
      pubSub.publish(testStream, expectedMessage);
    }, 5);

    return subscribePromise.then(message => {
      expect(message).to.deep.equal(expectedMessage);
    });
  });

  it('should subscribe on multiple channels', () => {
    const testStream1 = 'teststream1';
    const testStream2 = 'teststream2';
    const expectedMessage1 = { foo: 'bar' };
    const expectedMessage2 = { bar: 'baz' };

    const subscribePromise1 = new Promise((res, rej) => {
      pubSub.subscribe<StreamsMessage<any>>(testStream1, message => res(message.data));
    });

    const subscribePromise2 = new Promise((res, rej) => {
      pubSub.subscribe<StreamsMessage<any>>(testStream2, message => res(message.data));
    });

    setTimeout(() => {
      pubSub.publish(testStream1, expectedMessage1);
      pubSub.publish(testStream2, expectedMessage2);
    }, 5);

    return Promise.all([
      subscribePromise1, 
      subscribePromise2
    ]).then(([message1, message2]) => {
      expect(message1).to.deep.equal(expectedMessage1);
      expect(message2).to.deep.equal(expectedMessage2);
    });
  });

  it('should receive multiple messages in order on a single stream', () => {
    const testStream = 'teststream';
    const totalMessages = 3;

    const messagesReceived: any[] = [];
    const subscribePromise: Promise<any[]> = new Promise((res, rej) => {
      pubSub.subscribe<StreamsMessage<any>>(testStream, message => {
        messagesReceived.push(message.data);
        if (messagesReceived.length === totalMessages) {
          res(messagesReceived);
        }
      });
    });

    for (let i = 0; i < totalMessages; i++ ) {
      setTimeout(() => pubSub.publish(testStream, { messageNumber: i }), i * 100 + 5);
    }

    return subscribePromise.then(messages => {
      expect(messages).to.have.length(totalMessages);
      for (let i = 0; i < totalMessages; i++) {
        expect(messages[i]).to.include({ messageNumber: i });
      }
    });
  });

  it('should receive multiple messages in order on multiple streams', () => {
    const testStream1 = 'teststream1';
    const testStream2 = 'teststream2';
    const totalMessages = 3;

    const messagesReceived1: any[] = [];
    const subscribePromise1: Promise<any[]> = new Promise((res, rej) => {
      pubSub.subscribe<StreamsMessage<any>>(testStream1, message => {
        messagesReceived1.push(message.data);
        if (messagesReceived1.length === totalMessages) {
          res(messagesReceived1);
        }
      });
    });

    const messagesReceived2: any[] = [];
    const subscribePromise2: Promise<any[]> = new Promise((res, rej) => {
      pubSub.subscribe<StreamsMessage<any>>(testStream2, message => {
        messagesReceived2.push(message.data);
        if (messagesReceived2.length === totalMessages) {
          res(messagesReceived2);
        }
      });
    });

    for (let i = 0; i < totalMessages; i++ ) {
      setTimeout(() => pubSub.publish(testStream1, { messageNumber: i, stream: testStream1 }), i * 100 + 5);
      setTimeout(() => pubSub.publish(testStream2, { messageNumber: i, stream: testStream2 }), i * 100 + 5);
    }

    return Promise.all([subscribePromise1, subscribePromise2]).then(([messages1, messages2]) => {
      expect(messages1).to.have.length(totalMessages);
      for (let i = 0; i < totalMessages; i++) {
        expect(messages1[i]).to.include({ messageNumber: i });
        expect(messages1[i]).to.include({ stream: testStream1 });
      }

      expect(messages2).to.have.length(totalMessages);
      for (let i = 0; i < totalMessages; i++) {
        expect(messages2[i]).to.include({ messageNumber: i });
        expect(messages2[i]).to.include({ stream: testStream2 });
      }
    });
  });

  it('should fan out messages to multiple subscribers on the same stream', () => {
    const testStream = 'teststream';
    const expectedMessage = { foo: 'bar' };

    const subscribePromise1 = new Promise((res, rej) => {
      pubSub.subscribe<StreamsMessage<any>>(testStream, message => res(message.data));
    });

    const subscribePromise2 = new Promise((res, rej) => {
      pubSub.subscribe<StreamsMessage<any>>(testStream, message => res(message.data));
    });

    setTimeout(() => {
      pubSub.publish(testStream, expectedMessage);
    }, 5);

    return Promise.all([subscribePromise1, subscribePromise2]).then(([message1, message2]) => {
      expect(message1).to.deep.equal(message2);
      expect(message1).to.deep.equal(expectedMessage);
    });
  });

  it('should allow a subscriber to specify a message id with which to start listening', async () => {
    const testStream = 'teststreamblah';

    // Push a message and record its id.
    let initialMessageId;
    const subscriber1Messages: any[] = [];
    const initialSubscriberPromise = new Promise<void>((res, rej) => {
      pubSub.subscribe<StreamsMessage<any>>(testStream, message => {
        if (!initialMessageId) {
          initialMessageId = message.id;
          res();
        }

        subscriber1Messages.push(message.data);
      });
    });

    setTimeout(() => {
      pubSub.publish(testStream, { messageNumber: 0 });
      pubSub.publish(testStream, { messageNumber: 1 });
    }, 5);

    await initialSubscriberPromise;

    // Start subscriber 2 listening starting with the initial message id; it should receive
    // the initial message in addition.
    const subscriber2Messages: any[] = [];
    const nextSubscriberPromise = new Promise((res, rej) => {
      pubSub.subscribe<StreamsMessage<any>>(testStream, message => {
        subscriber2Messages.push(message.data);
        if (subscriber2Messages.length === 2) {
          res(subscriber2Messages);
        }
      }, { lastMessageId: initialMessageId });
    });

    setTimeout(() => {
      pubSub.publish(testStream, { messageNumber: 2 });
    }, 5);

    // The originally listening stream and the one that joined in
    // late should have the same set of messages now
    return nextSubscriberPromise.then(() => {
      // Subscriber 1 should have all three messages,
      // subscriber 2 should have the second two.
      expect(subscriber1Messages).to.have.length(3);
      for (let i = 0; i < 3; i++) {
        expect(subscriber1Messages[i]).to.include({ messageNumber: i });
      }

      expect(subscriber2Messages).to.have.length(2);
      for (let i = 0; i < 2; i++) {
        expect(subscriber2Messages[i]).to.include({ messageNumber: i + 1 });
      }
    });
  });

  it('should allow subscribers to unsubscribe', async () => {
    const testStream = 'teststream';
    const message1 = { messageNumber: 1 };
    const message2 = { messageNumber: 2 };

    const subscriberMessages: any[] = [];
    let subId;
    const subscribePromise = new Promise(async (res, rej) => {
      subId = await pubSub.subscribe<StreamsMessage<any>>(testStream, message => {
        subscriberMessages.push(message.data);
        if (subscriberMessages.length === 1) {
          res(message.data);
        }
      });

    });
    
    setTimeout(() => {
      pubSub.publish(testStream, message1);
    }, 5);

    await subscribePromise;

    pubSub.unsubscribe(subId);

    await pubSub.publish(testStream, message2);

    return new Promise((res, rej) => {
      setTimeout(() => {
        expect(subscriberMessages).to.have.length(1);

        expect((pubSub as any).eventLoop).to.be.undefined;
        res();
      }, 5);
    });
  });
});

describe('redis stream pubsub with asyncIterator', () => {
  beforeEach(() => {
    pubSub = new RedisStreamPubSub({
      connection: {
        host: redisHost,
        port: 6379,
      }
    });
  });

  afterEach(async () => {
    return await pubSub.close();
  });

  it('should return an async iterator that fetches values for the stream', async () => {
    const streamName = 'teststream';
    type TestStreamData = StreamsMessage<{messageNumber: number}>;

    const asyncIterator = pubSub.asyncIterator<TestStreamData>(streamName);
    
    // Publish messages every 100ms
    for (let i = 0; i < 3; i++) {
      setTimeout(() => {
        pubSub.publish(streamName, { messageNumber: i });
      }, 100 * i);
    }

    const messages: IteratorResult<TestStreamData, undefined>[] = [ await asyncIterator.next(), await asyncIterator.next(), await asyncIterator.next() ];

    expect(messages).to.have.length(3);
    for (let i = 0; i < 3; i++ ) {
      expect(messages[i].value?.data).to.include({ messageNumber: i });
    }
  });

  it('should support multiple async iterators at once', async () => {
    const stream1Name = 'teststream1';
    const stream2Name = 'teststream2';
    type TestStreamData = StreamsMessage<{messageNumber: number, stream: number}>;

    const asyncIterator1 = pubSub.asyncIterator<TestStreamData>(stream1Name);
    const asyncIterator2 = pubSub.asyncIterator<TestStreamData>(stream1Name);
    const asyncIterator3 = pubSub.asyncIterator<TestStreamData>(stream2Name);
    
    const messages1: TestStreamData[] = [];
    const messages2: TestStreamData[] = [];
    const messages3: TestStreamData[] = [];
    const doneReceivingPromise = new Promise<void>((res, rej) => {
      const resolveIfDone = () => {
        if (messages1.length === 3 && messages2.length === 3 && messages3.length ===3) {
          res();
        }
      }

      for (let i = 0; i < 3; i++) {
        asyncIterator1.next().then(item => { messages1.push(item.value); resolveIfDone() });
        asyncIterator2.next().then(item => { messages2.push(item.value); resolveIfDone() });
        asyncIterator3.next().then(item => { messages3.push(item.value); resolveIfDone() });
      }
    });

    // Publish messages every 100ms
    for (let i = 0; i < 3; i++) {
      setTimeout(() => {
        pubSub.publish(stream1Name, { messageNumber: i, stream: 1 });
        pubSub.publish(stream2Name, { messageNumber: i, stream: 2 });
      }, 100 * i);
    }

    await doneReceivingPromise;

    expect(messages1).to.have.length(3);
    expect(messages2).to.have.length(3);
    expect(messages3).to.have.length(3);
  });

  it('should close a subscription when return is called on an async iterator', async () => {
    const streamName = 'teststream';
    type TestStreamData = StreamsMessage<{messageNumber: number}>;

    const asyncIterator = pubSub.asyncIterator<TestStreamData>(streamName);
    
    // Publish messages every 100ms
    for (let i = 0; i < 3; i++) {
      setTimeout(() => {
        pubSub.publish(streamName, { messageNumber: i });
      }, 100 * i);
    }
    
    const messages: IteratorResult<TestStreamData, undefined>[] = [ await asyncIterator.next(), await asyncIterator.next(), await asyncIterator.next() ];

    expect(messages).to.have.length(3);
    asyncIterator.return!();

    // Subsequent next calls should return the return value;
    const next = await asyncIterator.next();
    expect(next).to.include({ value: undefined, done: true });

    return expect((pubSub as any).eventLoop).to.eventually.be.undefined;
  });
});