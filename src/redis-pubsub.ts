import { PubSubEngine } from 'graphql-subscriptions/dist/pubsub-engine';
import { createClient, RedisClient, ClientOpts as RedisOptions } from 'redis';
import { PubSubAsyncIterator } from './pubsub-async-iterator';

export interface PubSubRedisOptions {
  connection?: RedisOptions;
  triggerTransform?: TriggerTransform;
  connectionListener?: (err: Error) => void;
}

export class RedisPubSub implements PubSubEngine {

  constructor(options: PubSubRedisOptions = {}) {
    this.triggerTransform = options.triggerTransform || (trigger => trigger as string);

    this.redisPublisher = createClient(options.connection);
    this.redisSubscriber = createClient(options.connection);

    // TODO support for pattern based message
    this.redisSubscriber.on('message', this.onMessage.bind(this));

    if (options.connectionListener) {
      this.redisPublisher.on('connect', options.connectionListener);
      this.redisPublisher.on('error', options.connectionListener);
      this.redisSubscriber.on('connect', options.connectionListener);
      this.redisSubscriber.on('error', options.connectionListener);
    } else {
      this.redisPublisher.on('error', console.error);
      this.redisSubscriber.on('error', console.error);
    }

    this.subscriptionMap = {};
    this.subsRefsMap = {};
    this.currentSubscriptionId = 0;
  }

  public publish(trigger: string, payload: any): boolean {
    // TODO PR graphql-subscriptions to use promises as return value
    return this.redisPublisher.publish(trigger, JSON.stringify(payload));
  }

  public subscribe(trigger: string, onMessage: Function, options?: Object): Promise<number> {
    const triggerName: string = this.triggerTransform(trigger, options);
    const id = this.currentSubscriptionId++;
    this.subscriptionMap[id] = [triggerName, onMessage];

    let refs = this.subsRefsMap[triggerName];
    if (refs && refs.length > 0) {
      const newRefs = [...refs, id];
      this.subsRefsMap[triggerName] = newRefs;
      return Promise.resolve(id);

    } else {
      return new Promise<number>((resolve, reject) => {
        // TODO Support for pattern subs
        this.redisSubscriber.subscribe(triggerName, err => {
          if (err) {
            reject(err);
          } else {
            this.subsRefsMap[triggerName] = [...(this.subsRefsMap[triggerName] || []), id];
            resolve(id);
          }
        });
      });
    }
  }

  public unsubscribe(subId: number) {
    const [triggerName = null] = this.subscriptionMap[subId] || [];
    const refs = this.subsRefsMap[triggerName];

    if (!refs) throw new Error(`There is no subscription of id "${subId}"`);

    let newRefs;
    if (refs.length === 1) {
      this.redisSubscriber.unsubscribe(triggerName);
      newRefs = [];

    } else {
      const index = refs.indexOf(subId);
      if (index !== -1) {
        newRefs = [...refs.slice(0, index), ...refs.slice(index + 1)];
      }
    }

    this.subsRefsMap[triggerName] = newRefs;
    delete this.subscriptionMap[subId];
  }

  public asyncIterator<T>(triggers: string | string[]): AsyncIterator<T> {
    return new PubSubAsyncIterator<T>(this, triggers);
  }

  private onMessage(channel: string, message: string) {
    const subscribers = this.subsRefsMap[channel];

    // Don't work for nothing..
    if (!subscribers || !subscribers.length) return;

    let parsedMessage;
    try {
      parsedMessage = JSON.parse(message);
    } catch (e) {
      parsedMessage = message;
    }

    for (const subId of subscribers) {
      const listener = this.subscriptionMap[subId][1];
      listener(parsedMessage);
    }
  }

  private triggerTransform: TriggerTransform;
  private redisSubscriber: RedisClient;
  private redisPublisher: RedisClient;

  private subscriptionMap: { [subId: number]: [string, Function] };
  private subsRefsMap: { [trigger: string]: Array<number> };
  private currentSubscriptionId: number;
}

export type Path = Array<string | number>;
export type Trigger = string | Path;
export type TriggerTransform = (trigger: Trigger, channelOptions?: Object) => string;
