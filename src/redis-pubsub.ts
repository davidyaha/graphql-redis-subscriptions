import {Cluster, Redis, RedisOptions} from 'ioredis';
import type {RedisClientType, RedisClusterType} from 'redis';
import {PubSubEngine} from 'graphql-subscriptions';
import {PubSubAsyncIterator} from './pubsub-async-iterator';

type IORedisClient = Redis | Cluster;
type NodeRedisClient = RedisClientType | RedisClusterType;
type RedisClient = IORedisClient | NodeRedisClient;
type OnMessage<T> = (message: T) => void;
type DeserializerContext = { channel: string, pattern?: string };

// ioredis and node-redis expose incompatible pub/sub APIs: ioredis uses lower-case
// method names with error-first callbacks and emits generic 'message'/'pmessage'
// events, while node-redis uses camelCase method names that return a Promise and
// take the message listener as an argument to subscribe()/pSubscribe() directly.
function isIORedisClient(client: RedisClient): client is IORedisClient {
  return typeof (client as IORedisClient).psubscribe === 'function';
}

// ioredis' quit() resolves 'OK'; node-redis' close() resolves void, so normalize it.
async function closeClient(client: RedisClient): Promise<'OK'> {
  if (isIORedisClient(client)) {
    return client.quit();
  }
  await client.close();
  return 'OK';
}

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

    // ioredis delivers messages via generic events; node-redis has no equivalent
    // and instead delivers them to the listener passed to subscribe()/pSubscribe(),
    // which is wired up per-trigger in subscribe() below.
    if (isIORedisClient(this.redisSubscriber)) {
      // handle messages received via psubscribe and subscribe
      this.redisSubscriber.on(pmessageEventName, this.onMessage.bind(this));
      // partially applied function passes undefined for pattern arg since 'message' event won't provide it:
      this.redisSubscriber.on(messageEventName, this.onMessage.bind(this, undefined));
    }

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
    this.subscriptionMap[id] = [triggerName, onMessage];

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

      // Add ids of subscribe calls initiated when waiting for the remote call response
      const resolveSubscription = (): number => {
        const pendingRefs = subsPendingRefsMap.get(triggerName)
        pendingRefs.refs.forEach((refId) => refs.add(refId))
        subsPendingRefsMap.delete(triggerName)

        refs.add(id);
        return id;
      };

      const isPattern = Boolean(options['pattern']);
      let sub: Promise<number>;

      if (isIORedisClient(this.redisSubscriber)) {
        const subscribeFn = isPattern ? this.redisSubscriber.psubscribe : this.redisSubscriber.subscribe;
        sub = new Promise<number>((resolve, reject) => {
          subscribeFn.call(this.redisSubscriber, triggerName, err => {
            if (err) {
              subsPendingRefsMap.delete(triggerName)
              reject(err);
            } else {
              // Resolve synchronously within the callback (rather than via a .then()
              // continuation) so refs.add(id) happens before subscribe() returns -
              // some clients invoke this callback synchronously, and callers may
              // publish right after calling subscribe() in the same tick.
              resolve(resolveSubscription());
            }
          });
        });
      } else {
        // node-redis has no generic 'message'/'pmessage' events: the listener passed
        // here is what actually receives messages for this trigger, and subscribe()/
        // pSubscribe() resolve their own Promise once the subscription is confirmed.
        const subscribeFn = isPattern ? this.redisSubscriber.pSubscribe : this.redisSubscriber.subscribe;
        const listener = isPattern
          ? (message: string, channel: string) => this.onMessage(triggerName, channel, message)
          : (message: string) => this.onMessage(undefined, triggerName, message);
        sub = subscribeFn.call(this.redisSubscriber, triggerName, listener)
          .then(resolveSubscription, (err: Error) => {
            subsPendingRefsMap.delete(triggerName)
            throw err;
          });
      }

      // Ensure waiting subscribe will complete
      sub.then(pending.resolve).catch(pending.reject)
      return sub;
    }
  }

  public unsubscribe(subId: number): void {
    const [triggerName = null] = this.subscriptionMap[subId] || [];
    const refs = this.subsRefsMap.get(triggerName);

    if (!refs) throw new Error(`There is no subscription of id "${subId}"`);

    if (refs.size === 1) {
      // unsubscribe from specific channel and pattern match
      if (isIORedisClient(this.redisSubscriber)) {
        this.redisSubscriber.unsubscribe(triggerName);
        this.redisSubscriber.punsubscribe(triggerName);
      } else {
        // node-redis's unsubscribe()/pUnsubscribe() return real Promises; catch to
        // avoid unhandled rejections since this call is intentionally fire-and-forget.
        this.redisSubscriber.unsubscribe(triggerName).catch(() => undefined);
        this.redisSubscriber.pUnsubscribe(triggerName).catch(() => undefined);
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
      closeClient(this.redisPublisher),
      closeClient(this.redisSubscriber),
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
