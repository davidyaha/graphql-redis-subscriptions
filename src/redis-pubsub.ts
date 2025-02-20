import {Cluster, Redis, RedisOptions} from 'ioredis';
import {PubSubEngine} from 'graphql-subscriptions';
import {PubSubAsyncIterator} from './pubsub-async-iterator';

type RedisClient = Redis | Cluster;
type OnMessage<T> = (message: T) => void;
type DeserializerContext = { channel: string, pattern?: string };

export interface PubSubRedisOptions {
  connection?: RedisOptions | string;
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
    this.subsPendingRefsMap = new Map<string, { refs: number[], pending: Promise<number> }>();
    this.currentSubscriptionId = 0;
  }

  public async publish<T>(trigger: string, payload: T): Promise<void> {
    if(this.serializer) {
      await this.redisPublisher.publish(trigger, this.serializer(payload));
    } else if (payload instanceof Buffer){
      await this.redisPublisher.publish(trigger, payload);
    } else {
      await this.redisPublisher.publish(trigger, JSON.stringify(payload));
    }
  }

  public subscribe<T = any>(
    trigger: string,
    onMessage: OnMessage<T>,
    options: unknown = {},
  ): Promise<number> {

    const triggerName: string = this.triggerTransform(trigger, options);
    const id = this.currentSubscriptionId++;
    const patternSubscription: boolean = !!options['pattern'];
    this.subscriptionMap[id] = [triggerName, onMessage, patternSubscription];

    if (!this.subsRefsMap.has(triggerName)) {
      this.subsRefsMap.set(triggerName, new Set());
    }

    const refs = this.subsRefsMap.get(triggerName);

    const pendingRefs = this.subsPendingRefsMap.get(triggerName)
    if (pendingRefs != null) {
      // A pending remote subscribe call is currently in flight, piggyback on it
      pendingRefs.refs.push(id)
      return pendingRefs.pending.then(() => id)
    } else if (refs.size > 0) {
      // Already actively subscribed to redis
      refs.add(id);
      return Promise.resolve(id);
    } else {
      // New subscription.
      // Keep a pending state until the remote subscribe call is completed
      const pending = new Deferred()
      const subsPendingRefsMap = this.subsPendingRefsMap
      subsPendingRefsMap.set(triggerName, { refs: [], pending });

      const sub = new Promise<number>((resolve, reject) => {
        const subscribeFn = patternSubscription ? this.redisSubscriber.psubscribe : this.redisSubscriber.subscribe;

        subscribeFn.call(this.redisSubscriber, triggerName, err => {
          if (err) {
            subsPendingRefsMap.delete(triggerName)
            reject(err);
          } else {
            // Add ids of subscribe calls initiated when waiting for the remote call response
            const pendingRefs = subsPendingRefsMap.get(triggerName)
            pendingRefs.refs.forEach((id) => refs.add(id))
            subsPendingRefsMap.delete(triggerName)

            refs.add(id);
            resolve(id);
          }
        });
      });
      // Ensure waiting subscribe will complete
      sub.then(pending.resolve).catch(pending.reject)
      return sub;
    }
  }

  public unsubscribe(subId: number): void {
    const [triggerName = null,, patternSubscription] = this.subscriptionMap[subId] || [];
    const refs = this.subsRefsMap.get(triggerName);

    if (!refs) throw new Error(`There is no subscription of id "${subId}"`);

    if (refs.size === 1) {
      // unsubscribe from specific channel and pattern match
      if (patternSubscription) {
        this.redisSubscriber.punsubscribe(triggerName);
      } else {
        this.redisSubscriber.unsubscribe(triggerName);
      }

      this.subsRefsMap.delete(triggerName);
    } else {
      refs.delete(subId);
    }
    delete this.subscriptionMap[subId];
  }

  public asyncIterator<T>(triggers: string | string[], options?: unknown) {
    return new PubSubAsyncIterator<T>(this, triggers, options);
  }

  public asyncIterableIterator<T>(triggers: string | string[], options?: unknown) {
    return new PubSubAsyncIterator<T>(this, triggers, options);
  }

  public getSubscriber(): RedisClient {
    return this.redisSubscriber;
  }

  public getPublisher(): RedisClient {
    return this.redisPublisher;
  }

  public close(): Promise<'OK'[]> {
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

  private readonly subscriptionMap: { [subId: number]: [string, OnMessage<unknown>, patternSubscription: boolean] };
  private readonly subsRefsMap: Map<string, Set<number>>;
  private readonly subsPendingRefsMap: Map<string, { refs: number[], pending: Promise<number> }>;
  private currentSubscriptionId: number;

  private onMessage(pattern: string, channel: string | Buffer, message: string | Buffer) {
    if(typeof channel === 'object') channel = channel.toString('utf8');

    const subscribers = this.subsRefsMap.get(pattern || channel);

    // Don't work for nothing..
    if (!subscribers?.size) return;

    let parsedMessage;
    try {
      if(this.deserializer){
        parsedMessage = this.deserializer(Buffer.from(message), { pattern, channel })
      } else if(typeof message === 'string'){
        parsedMessage = JSON.parse(message, this.reviver);
      } else {
        parsedMessage = message;
      }
    } catch (e) {
      parsedMessage = message;
    }

    subscribers.forEach(subId => {
      const [, listener] = this.subscriptionMap[subId];
      listener(parsedMessage);
    });
  }
}

// Unexported deferrable promise used to complete waiting subscribe calls
function Deferred() {
  const p = this.promise = new Promise((resolve, reject) => {
    this.resolve = resolve;
    this.reject = reject;
  });
  this.then = p.then.bind(p);
  this.catch = p.catch.bind(p);
  if (p.finally) {
    this.finally = p.finally.bind(p);
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
export type Deserializer = (source: string | Buffer, context: DeserializerContext) => any;
