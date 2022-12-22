import { Cluster, Redis, RedisOptions } from 'ioredis';
import { PubSubEngine } from 'graphql-subscriptions';
import {PubSubAsyncIterator} from './pubsub-async-iterator';

type DeserializerContext = { channel: string, pattern?: string };

export type RedisClient = Redis | Cluster;
export type OnMessage<T> = (message: T) => void;

export interface PubSubRedisBaseOptions {
  connection?: RedisOptions | string;
  triggerTransform?: TriggerTransform;
  connectionListener?: (err: Error) => void;
  publisher?: RedisClient;
  subscriber?: RedisClient;
  reviver?: Reviver;
  serializer?: Serializer;
  deserializer?: Deserializer;
}

export abstract class RedisPubSubBase implements PubSubEngine {

  constructor(options: PubSubRedisBaseOptions = {}) {
    const {
      triggerTransform,
      connection,
      connectionListener,
      subscriber,
      publisher,
      reviver,
      serializer,
      deserializer,
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

    this.currentSubscriptionId = 0;
  }

  public abstract publish<T>(trigger: string, payload: T): Promise<void>;

  public abstract subscribe<T = any>(
    trigger: string,
    onMessage: OnMessage<T>,
    options: unknown,
  ): Promise<number>;

  public abstract unsubscribe(subId: number): void;

  public asyncIterator<T>(triggers: string | string[], options?: unknown): AsyncIterator<T> {
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

  protected readonly serializer?: Serializer;
  protected readonly deserializer?: Deserializer;
  protected readonly triggerTransform: TriggerTransform;
  protected readonly redisSubscriber: RedisClient;
  protected readonly redisPublisher: RedisClient;
  protected readonly reviver: Reviver;

  protected currentSubscriptionId: number;
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
