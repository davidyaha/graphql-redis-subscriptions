import { PubSubEngine } from 'graphql-subscriptions';

/**
 * A class for digesting PubSubEngine events via the new AsyncIterator interface.
 * This implementation is a generic version of the one located at
 * https://github.com/apollographql/graphql-subscriptions/blob/master/src/event-emitter-to-async-iterator.ts
 * @class
 *
 * @constructor
 *
 * @property pullQueue @type {Function[]}
 * A queue of resolve functions waiting for an incoming event which has not yet arrived.
 * This queue expands as next() calls are made without PubSubEngine events occurring in between.
 *
 * @property pushQueue @type {any[]}
 * A queue of PubSubEngine events waiting for next() calls to be made.
 * This queue expands as PubSubEngine events arrice without next() calls occurring in between.
 *
 * @property eventsArray @type {string[]}
 * An array of PubSubEngine event names which this PubSubAsyncIterator should watch.
 *
 * @property allSubscribed @type {Promise<number[]>}
 * A promise of a list of all subscription ids to the passed PubSubEngine.
 *
 * @property listening @type {boolean}
 * Whether or not the PubSubAsynIterator is in listening mode (responding to incoming PubSubEngine events and next() calls).
 * Listening begins as true and turns to false once the return method is called.
 *
 * @property pubsub @type {PubSubEngine}
 * The PubSubEngine whose events will be observed.
 */
export class PubSubAsyncIterator<T> implements AsyncIterator<T> {

  constructor(pubsub: PubSubEngine, eventNames: string | string[], options?: unknown) {
    this.pubsub = pubsub;
    this.options = options;
    this.pullQueue = [];
    this.pushQueue = [];
    this.listening = true;
    this.eventsArray = typeof eventNames === 'string' ? [eventNames] : eventNames;
  }

  public async next() {
    await this.subscribeAll();
    return this.listening ? this.pullValue() : this.return();
  }

  public async return(): Promise<{ value: unknown, done: true }> {
    await this.emptyQueue();
    return { value: undefined, done: true };
  }

  public async throw(error): Promise<never> {
    await this.emptyQueue();
    return Promise.reject(error);
  }

  public [Symbol.asyncIterator]() {
    return this;
  }

  private pullQueue: Array<(data: { value: unknown, done: boolean }) => void>;
  private pushQueue: any[];
  private eventsArray: string[];
  private subscriptionIds: Promise<number[]> | undefined;
  private listening: boolean;
  private pubsub: PubSubEngine;
  private options: unknown;

  private async pushValue(event) {
    await this.subscribeAll();
    if (this.pullQueue.length !== 0) {
      this.pullQueue.shift()({ value: event, done: false });
    } else {
      this.pushQueue.push(event);
    }
  }

  private pullValue(): Promise<IteratorResult<any>> {
    return new Promise(resolve => {
      if (this.pushQueue.length !== 0) {
        resolve({ value: this.pushQueue.shift(), done: false });
      } else {
        this.pullQueue.push(resolve);
      }
    });
  }

  private async emptyQueue() {
    if (this.listening) {
      this.listening = false;
      if (this.subscriptionIds) this.unsubscribeAll(await this.subscriptionIds);
      this.pullQueue.forEach(resolve => resolve({ value: undefined, done: true }));
      this.pullQueue.length = 0;
      this.pushQueue.length = 0;
    }
  }

  private subscribeAll() {
    if (!this.subscriptionIds) {
      this.subscriptionIds = Promise.all(this.eventsArray.map(
        eventName => this.pubsub.subscribe(eventName, this.pushValue.bind(this), this.options),
      ));
    }
    return this.subscriptionIds;
  }

  private unsubscribeAll(subscriptionIds: number[]) {
    for (const subscriptionId of subscriptionIds) {
      this.pubsub.unsubscribe(subscriptionId);
    }
  }

}
