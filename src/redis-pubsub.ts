import {Cluster, Ok, Redis, RedisOptions} from 'ioredis';

import {PubSubAsyncIterator} from './pubsub-async-iterator';
import {PubSubEngine} from 'graphql-subscriptions';

type RedisClient = Redis | Cluster;
type OnMessage<T> = (message: T) => void;

export interface PubSubRedisOptions {
  connection?: RedisOptions;
  triggerTransform?: TriggerTransform;
  connectionListener?: (err: Error) => void;
  publisher?: RedisClient;
  subscriber?: RedisClient;
  reviver?: Reviver;
  serializer?: Serializer;
  deserializer?: Deserializer;
  messageEventName?: string;
  pmessageEventName?: string;
}

export class RedisPubSub implements PubSubEngine {

  constructor(options: PubSubRedisOptions = {}) {
    const {
      triggerTransform,
      connection,
      connectionListener,
      subscriber,
      publisher,
      reviver,
      serializer,
      deserializer,
      messageEventName = 'message',
      pmessageEventName = 'pmessage',
    } = options;

    this.triggerTransform = triggerTransform || (trigger => trigger as string);

    if (reviver && deserializer) {
      throw new Error("Reviver and deserializer can't be used together");
    }

    this.reviver = reviver;
    this.serializer = serializer;
    this.deserializer = deserializer;

    if (subscriber && publisher) {
      this.redisPublisher = publisher;
      this.redisSubscriber = subscriber;
    } else {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const IORedis = require('ioredis');
        this.redisPublisher = new IORedis(connection);
        this.redisSubscriber = new IORedis(connection);

        if (connectionListener) {
          this.redisPublisher
              .on('connect', connectionListener)
              .on('error', connectionListener);
          this.redisSubscriber
              .on('connect', connectionListener)
              .on('error', connectionListener);
        } else {
          this.redisPublisher.on('error', console.error);
          this.redisSubscriber.on('error', console.error);
        }
      } catch (error) {
        console.error(
          `No publisher or subscriber instances were provided and the package 'ioredis' wasn't found. Couldn't create Redis clients.`,
        );
      }
    }

    // handle messages received via psubscribe and subscribe
    this.redisSubscriber.on(pmessageEventName, this.onMessage.bind(this));
    // partially applied function passes undefined for pattern arg since 'message' event won't provide it:
    this.redisSubscriber.on(messageEventName, this.onMessage.bind(this, undefined));

    this.subscriptionMap = {};
    this.subsRefsMap = new Map<string, Set<number>>();
    this.currentSubscriptionId = 0;
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

    const refs = this.subsRefsMap.get(triggerName);
    if (refs?.size > 0) {
      refs.add(id)
      return Promise.resolve(id);
    } else {
      return new Promise<number>((resolve, reject) => {
        const subscribeFn = options['pattern'] ? this.redisSubscriber.psubscribe : this.redisSubscriber.subscribe;

        subscribeFn.call(this.redisSubscriber, triggerName, err => {
          if (err) {
            reject(err);
          } else {
            refs.add(id)
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
      refs.delete(subId)
    }
    delete this.subscriptionMap[subId];
  }

  public asyncIterator<T>(triggers: string | string[], options?: unknown): AsyncIterator<T> {
    return new PubSubAsyncIterator<T>(this, triggers, options);
  }

  public getSubscriber(): RedisClient {
    return this.redisSubscriber;
  }

  public getPublisher(): RedisClient {
    return this.redisPublisher;
  }

  public close(): Promise<Ok[]> {
    return Promise.all([
      this.redisPublisher.quit(),
      this.redisSubscriber.quit(),
    ]);
  }

  private readonly serializer?: Serializer;
  private readonly deserializer?: Deserializer;
  private readonly triggerTransform: TriggerTransform;
  private readonly redisSubscriber: RedisClient;
  private readonly redisPublisher: RedisClient;
  private readonly reviver: Reviver;

  private readonly subscriptionMap: { [subId: number]: [string, OnMessage<unknown>] };
  private readonly subsRefsMap: Map<string, Set<number>>;
  private currentSubscriptionId: number;

  private onMessage(pattern: string, channel: string, message: string) {
    const subscribers = this.subsRefsMap.get(pattern || channel);

    // Don't work for nothing..
    if (!subscribers?.size) return;

    let parsedMessage;
    try {
      parsedMessage = this.deserializer ? this.deserializer(message) : JSON.parse(message, this.reviver);
    } catch (e) {
      parsedMessage = message;
    }

    for (const subId in subscribers) {
      const [, listener] = this.subscriptionMap[subId];
      listener(parsedMessage);
    }
  }
}

export type Path = Array<string | number>;
export type Trigger = string | Path;
export type TriggerTransform = (
  trigger: Trigger,
  channelOptions?: unknown,
) => string;
export type Reviver = (key: any, value: any) => any;
export type Serializer = (source: any) => string;
export type Deserializer = (source: string | Buffer) => any;
