import { OnMessage, PubSubRedisBaseOptions, RedisPubSubBase } from "./redis-pubsub-base";

interface RedisStreamSubscribeOptions {
  /** ID of the last message received on the specified stream. */
  lastMessageId?: string;
}

interface PubSubRedisStreamAdditionalOptions {
  blockTimeout?: number;
}

export type PubSubRedisStreamOptions = PubSubRedisStreamAdditionalOptions & PubSubRedisBaseOptions;

type SubscriberDetails = [streamName: string, lastMessageId: string, onMessage: OnMessage<unknown>];

/** Return value from the XREAD command. */
type XReadResponse = [streamName: string, messages: [messageId: string, messageData: string[]][]][];

/**
 * 1 if client was unblocked successfully, 0 if not.
 * Defined here because IORedis typings for the `client` function are incomplete.
 */
type ClientUnblockResult = 1 | 0;

/**
 * Messages returned from a streams client have two pieces of data -
 * the data itself, and the id of the message. This can be used
 * by the consumer to retrieve previous messages after a disconnect.
 */
export type StreamsMessage<T> = { id: string; data: T };

const DEFAULT_BLOCK_TIMEOUT = 5000;

/**
* Redis PubSub implementation that uses redis streams (xread/xadd) as the
* communication method. As with many things, this provides better consistency
* (clients can disconnect and still receive missed messages), at the tradeoff of slightly
* worse performance.
*/
export class RedisStreamPubSub extends RedisPubSubBase {
  
  constructor(options: PubSubRedisStreamOptions = {}) {
    super(options);

    this.blockTimeout = options.blockTimeout || DEFAULT_BLOCK_TIMEOUT;

    this.streamsMap = {};
    this.subscriptionMap = {};
  }

  // Run the event loop. 
  private async runEventLoop(): Promise<void> {
    while (this.hasSubscribers() && !this.closed) {

      await this.waitAndProcessMessages();
    }

    delete this.eventLoop;
  }
  
  // Begins the event loop which blocks on the XREAD command,
  // or returns a reference to the promise for the currently
  // running event loop if it's currently running.
  private startEventLoop(): Promise<void> {
    if (this.eventLoop) {
      return this.eventLoop;
    }
    else {
      this.eventLoop = this.runEventLoop().catch(error => {
        console.error('Error in event loop:');
        console.error(error);
      });
      return this.eventLoop;
    }
  }
  
  private async waitAndProcessMessages(): Promise<void> {
    // Determine which streams and last messages we need to provide to the XREAD command.
    // This data structure becomes the source of truth as to which streams and last message ids
    // we're interested in on this iteration of the event loop, meaning subscribers can
    // be added or removed at will without introducing race conditions.
    const streamsAndOrderedLastMessageIds: [string, string[]][] = Object.entries(this.streamsMap)
      .map(([streamName, lastMessageIds]) => [streamName, Object.keys(lastMessageIds).sort(sortLastMessageIds)]);
    
    const streamAndLastMessageIdPairs = streamsAndOrderedLastMessageIds
      .flatMap(([streamName, lastMessageIds]) => lastMessageIds.map(lastMessageId => [streamName, lastMessageId]));
    
    const streams = streamAndLastMessageIdPairs.map(pair => pair[0]);
    const lastMessageIds = streamAndLastMessageIdPairs.map(pair => pair[1]);

    // Before we block, record the subscriber client id so we can unblock when new data comes in.
    this.subscriberClientId = await this.redisSubscriber.client('ID');

    // Just make sure by the time we're about to block, we still want to (in case we've shut down or run out of subscribers
    // in between the while loop check and now).
    if (!this.closed && this.hasSubscribers()) {
      const messages: XReadResponse = await this.redisSubscriber.xread('COUNT', 1, 'BLOCK', this.blockTimeout, 'STREAMS', ...streams, ...lastMessageIds);
      if (messages) {
        this.processMessages(messages, streamsAndOrderedLastMessageIds);
      }
    }

    return;
  }

  private processMessages(messages: XReadResponse, streamsAndOrderedLastMessageIds: [streamName: string, lastMessageIds: string[]][]) {
    // Group incoming messages by the stream they were requested on.
    const messagesByStream: {[streamName: string]: [messageId: string, messageData: string[]][][]} = messages.reduce((current, [streamName, messages]) => {
      current[streamName] ??= [];
      current[streamName].push(messages);
      return current;
    }, {});
    
    // Provide the received messages back to their individual handlers.
    const lastMessagesLookupMap = Object.fromEntries(streamsAndOrderedLastMessageIds);
    Object.entries(messagesByStream).forEach(([streamName, messageGroupsForStream]) => {
      const updateMap: Record<string, string> = {};
      messageGroupsForStream.forEach((messages, index) => {
        // If there are n instances of the same stream requested, and fewer than
        // n returned, any missing have no updates. Since we're sorting the lastMessageIds,
        // the ones at the end of the list will always be the ones with no updates,
        // so we can just happily skip those with no problem.
        const lastMessageId = lastMessagesLookupMap[streamName][index];
        messages.forEach(([messageId, [, message]]) => this.onMessage(streamName, lastMessageId, messageId, message));
        const [ newLastMessageId ] = messages.at(-1);
        updateMap[lastMessageId] = newLastMessageId;
      });
      
      // After processing all new messages for each stream, update the last message each subscriber has read
      this.updateSubscriberLastMessages(streamName, updateMap);
    });
  }

  /**
   * 
   * @param streamName The stream we're listening on
   * @param updateMap Keys are previously last seen message ids, values are newly last seen message ids
   */
  private updateSubscriberLastMessages(streamName: string, updateMap: Record<string, string>) {
    Object.keys(updateMap).sort(sortLastMessageIds).forEach((oldLastMessageId) => {
      const newLastMessageId = updateMap[oldLastMessageId];
      const subscribers = this.streamsMap[streamName]?.[oldLastMessageId];

      if (!subscribers) {
        return;
      }

      if (this.streamsMap[streamName][newLastMessageId]) {
        this.streamsMap[streamName][newLastMessageId] = this.streamsMap[streamName][newLastMessageId].concat(subscribers);
      }
      else {
        this.streamsMap[streamName][newLastMessageId] = subscribers;
      }

      delete this.streamsMap[streamName][oldLastMessageId];
      
      subscribers.forEach(subId => {
        this.subscriptionMap[subId][1] = newLastMessageId;
      });
    });
  }
  
  private onMessage(streamName: string, lastMessageId: string, messageId: string, messageData: string) {
    const subscribers = this.streamsMap[streamName]?.[lastMessageId];
    
    // Don't work for nothing..
    if (!subscribers || !subscribers.length) return;
    
    let parsedMessage;
    try {
      parsedMessage = this.deserializer
      ? this.deserializer(messageData, { channel: streamName })
      : JSON.parse(messageData, this.reviver);
    } catch (e) {
      parsedMessage = messageData;
    }
    
    for (const subId of subscribers) {
      const [, , listener] = this.subscriptionMap[subId];
      listener({id: messageId, data: parsedMessage});
    }
  }
  
  private hasSubscribers(): boolean {
    return Object.keys(this.subscriptionMap).length > 0;
  }
  
  public async publish<T>(trigger: string, payload: T): Promise<void> {
    await this.redisPublisher.xadd(trigger, '*', 'message', this.serializer ? this.serializer(payload) : JSON.stringify(payload));
    return;
  }

  public async subscribe<T>(streamName: string, onMessage: OnMessage<T>, options: RedisStreamSubscribeOptions = {}): Promise<number> {
    const id = this.currentSubscriptionId++;
    
    // If the last message received is specified with this subscription request, use that.
    // If there is already a last message id for this stream, group this new subscription with that one.
    // Otherwise this is a new subscription for this stream and we should start from now with the current timestamp.
    this.streamsMap[streamName] ||= {};
    const lastMessageId = options.lastMessageId 
      || Object.keys(this.streamsMap[streamName]).sort(sortLastMessageIds).at(-1)
      || `${new Date().getTime()}-0`;
    
    const subscriberDetails: SubscriberDetails = [streamName, lastMessageId, onMessage];
    this.subscriptionMap[id] = subscriberDetails;
    
    const requiresNewCommand = !(this.streamsMap[streamName][lastMessageId]);
    
    this.streamsMap[streamName][lastMessageId] ||= [];
    this.streamsMap[streamName][lastMessageId].push(id);
    
    if (requiresNewCommand && this.subscriberClientId) {
      this.unblockClient(this.subscriberClientId);
    }
    
    // Finally, kick off the XREAD event loop if it hasn't been started yet.
    if (!this.eventLoop) {
      this.startEventLoop();
    }
    
    return Promise.resolve(id);
  }
  
  private async unblockClient(clientId: number): Promise<ClientUnblockResult> {
    return this.redisPublisher.client('UNBLOCK', clientId, 'TIMEOUT') as Promise<ClientUnblockResult>;
  }
  
  public unsubscribe(subId: number): void {
    const subscriptionDetails = this.subscriptionMap[subId];

    if (!subscriptionDetails) throw new Error(`There is no subscription of id "${subId}"`);
    const [ streamName, lastMessageId ] = subscriptionDetails;

    const listenerIndex = this.streamsMap[streamName][lastMessageId].indexOf(subId);
    this.streamsMap[streamName][lastMessageId].splice(listenerIndex, 1);

    if (this.streamsMap[streamName][lastMessageId].length === 0) {
      delete this.streamsMap[streamName][lastMessageId];
      if (Object.keys(this.streamsMap[streamName]).length === 0) {
        delete this.streamsMap[streamName];
      }

      // Flush the event loop since we've changed the subscription set.
      // This isn't strictly necessary, but it helps us clean up
      // more consistently.
      this.unblockClient(this.subscriberClientId);
    }

    delete this.subscriptionMap[subId];
  }

  public async close(): Promise<'OK'[]> {
    this.closed = true;

    let unblockPromise: Promise<unknown>;
    if (this.subscriberClientId) {
      unblockPromise = this.unblockClient(this.subscriberClientId);
    }
    else {
      unblockPromise = Promise.resolve();
    }

    return unblockPromise.then(() => Promise.all([
      this.redisPublisher.quit(),
      this.redisSubscriber.quit(),
    ]));
  }

  private blockTimeout: number;
  private closed = false;
  private eventLoop: Promise<void>;
  private streamsMap: {
    [streamName: string]: {
      [lastMessageId: string]: number[], // subscription ids registered to that streamName and lastMessageId
    }
  };
  private subscriptionMap: {
    [subId: number]: SubscriberDetails,
  }
  // Used to unblock the subscriber client when the set of subscriptions changes
  private subscriberClientId: number;
}

/**
 * Sorts the Stream message ids.
 * Redis Stream message ids are of the format [timestamp]-[sequence],
 * so we can't do a simple numeric or alphabetic sort.
 **/
function sortLastMessageIds(a: string, b: string) {
  if (a === b) {
    return 0;
  }
  else {
    const aSplit = a.split('-').map(num => parseInt(num));
    const bSplit = b.split('-').map(num => parseInt(num));
    
    if (aSplit[0] === bSplit[0]) {
      return aSplit[1] - bSplit[1];
    }
    else {
      return aSplit[0] - bSplit[0];
    }
  }
}