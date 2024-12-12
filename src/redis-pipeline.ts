import { ChainableCommander } from "ioredis";
import type { RedisClient, Serializer } from "./redis-pubsub";

export interface RedisPubSubPipelineOptions {
  publisher: RedisClient;
  serializer: Serializer;
}

/**
 * Create a pipelined publisher that will send all the pub/sub messages in a single batch
 */
export class RedisPubSubPipeline {
  private pipeline: ChainableCommander;
  private publisher: RedisClient;
  private serializer: Serializer;

  constructor(options: RedisPubSubPipelineOptions) {
    this.publisher = options.publisher;
    this.serializer = options.serializer;

    // Start pipeline
    this.pipeline = this.publisher.pipeline();
  }

  /**
   * Publish to the redis pipeline
   */
  public publish<T>(trigger: string, payload: T): this {
    this.pipeline.publish(trigger, this.serializer(payload));
    return this;
  }

  /**
   * Execute the entire pipeline
   */
  public async exec() {
    return this.pipeline.exec();
  }
}
