import { OnMessage, PubSubRedisBaseOptions, RedisPubSubBase } from "./redis-pubsub-base";

interface PubSubRedisSubscribeOptions {
  messageEventName?: string;
  pmessageEventName?: string;
}

export type PubSubRedisOptions = PubSubRedisBaseOptions & PubSubRedisSubscribeOptions;

/**
 * Redis PubSub implementation that uses `subscribe` or `psubscribe` redis commands
 * as the communication method.
 */
export class RedisPubSub extends RedisPubSubBase {
  constructor(options: PubSubRedisOptions = {}) {
    super(options);

    const {
      messageEventName = 'message',
      pmessageEventName = 'pmessage',
    } = options;

    // handle messages received via psubscribe and subscribe
    this.redisSubscriber.on(pmessageEventName, this.onMessage.bind(this));
    // partially applied function passes undefined for pattern arg since 'message' event won't provide it:
    this.redisSubscriber.on(messageEventName, this.onMessage.bind(this, undefined));

    this.subscriptionMap = {};
    this.subsRefsMap = new Map<string, Set<number>>();
  }

  public async publish<T>(trigger: string, payload: T): Promise<void> {
    await this.redisPublisher.publish(trigger, this.serializer ? this.serializer(payload) : JSON.stringify(payload));
  }

  public subscribe<T = any>(
    trigger: string,
    onMessage: OnMessage<T>,
    options: unknown = {},
  ): Promise<number> {

    const triggerName: string = this.triggerTransform(trigger, options);
    const id = this.currentSubscriptionId++;
    this.subscriptionMap[id] = [triggerName, onMessage];

    if (!this.subsRefsMap.has(triggerName)) {
      this.subsRefsMap.set(triggerName, new Set());
    }

    const refs = this.subsRefsMap.get(triggerName);
    if (refs.size > 0) {
      refs.add(id);
      return Promise.resolve(id);
    } else {
      return new Promise<number>((resolve, reject) => {
        const subscribeFn = options['pattern'] ? this.redisSubscriber.psubscribe : this.redisSubscriber.subscribe;

        subscribeFn.call(this.redisSubscriber, triggerName, err => {
          if (err) {
            reject(err);
          } else {
            refs.add(id);
            resolve(id);
          }
        });
      });
    }
  }

  public unsubscribe(subId: number): void {
    const [triggerName = null] = this.subscriptionMap[subId] || [];
    const refs = this.subsRefsMap.get(triggerName);

    if (!refs) throw new Error(`There is no subscription of id "${subId}"`);

    if (refs.size === 1) {
      // unsubscribe from specific channel and pattern match
      this.redisSubscriber.unsubscribe(triggerName);
      this.redisSubscriber.punsubscribe(triggerName);

      this.subsRefsMap.delete(triggerName);
    } else {
      refs.delete(subId);
    }
    delete this.subscriptionMap[subId];
  }
  private readonly subscriptionMap: { [subId: number]: [string, OnMessage<unknown>] };
  private readonly subsRefsMap: Map<string, Set<number>>;

  private onMessage(pattern: string, channel: string, message: string) {
    const subscribers = this.subsRefsMap.get(pattern || channel);

    // Don't work for nothing..
    if (!subscribers?.size) return;

    let parsedMessage;
    try {
      parsedMessage = this.deserializer
        ? this.deserializer(message, { pattern, channel })
        : JSON.parse(message, this.reviver);
    } catch (e) {
      parsedMessage = message;
    }

    subscribers.forEach(subId => {
      const [, listener] = this.subscriptionMap[subId];
      listener(parsedMessage);
    });
  }
}