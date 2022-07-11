# graphql-redis-subscriptions

[![Build Status](https://travis-ci.org/davidyaha/graphql-redis-subscriptions.svg?branch=master)](https://travis-ci.org/davidyaha/graphql-redis-subscriptions)

This package implements the PubSubEngine Interface from the [graphql-subscriptions](https://github.com/apollographql/graphql-subscriptions) package and also the new AsyncIterator interface. 
It allows you to connect your subscriptions manager to a Redis Pub Sub mechanism to support 
multiple subscription manager instances.

## Installation
At first, install the `graphql-redis-subscriptions` package: 
```
npm install graphql-redis-subscriptions
```

As the [graphql-subscriptions](https://github.com/apollographql/graphql-subscriptions) package is declared as a peer dependency, you might receive warning about an unmet peer dependency if it's not installed already by one of your other packages. In that case you also need to install it too:
```
npm install graphql-subscriptions
```
   
## Using as AsyncIterator

Define your GraphQL schema with a `Subscription` type:

```graphql
schema {
  query: Query
  mutation: Mutation
  subscription: Subscription
}

type Subscription {
    somethingChanged: Result
}

type Result {
    id: String
}
```

Now, let's create a simple `RedisPubSub` instance:

```javascript
import { RedisPubSub } from 'graphql-redis-subscriptions';
const pubsub = new RedisPubSub();
```

Now, implement your Subscriptions type resolver, using the `pubsub.asyncIterator` to map the event you need:

```javascript
const SOMETHING_CHANGED_TOPIC = 'something_changed';

export const resolvers = {
  Subscription: {
    somethingChanged: {
      subscribe: () => pubsub.asyncIterator(SOMETHING_CHANGED_TOPIC),
    },
  },
}
```

> Subscriptions resolvers are not a function, but an object with `subscribe` method, that returns `AsyncIterable`.

Calling the method `asyncIterator` of the `RedisPubSub` instance will send redis a `SUBSCRIBE` message to the topic provided and will return an `AsyncIterator` binded to the RedisPubSub instance and listens to any event published on that topic.
Now, the GraphQL engine knows that `somethingChanged` is a subscription, and every time we will use `pubsub.publish` over this topic, the `RedisPubSub` will `PUBLISH` the event over redis to all other subscribed instances and those in their turn will emit the event to GraphQL using the `next` callback given by the GraphQL engine.

```js
pubsub.publish(SOMETHING_CHANGED_TOPIC, { somethingChanged: { id: "123" }});
```

## Dynamically create a topic based on subscription args passed on the query

```javascript
export const resolvers = {
  Subscription: {
    somethingChanged: {
      subscribe: (_, args) => pubsub.asyncIterator(`${SOMETHING_CHANGED_TOPIC}.${args.relevantId}`),
    },
  },
}
```

## Using a pattern on subscription

```javascript
export const resolvers = {
  Subscription: {
    somethingChanged: {
      subscribe: (_, args) => pubsub.asyncIterator(`${SOMETHING_CHANGED_TOPIC}.${args.relevantId}.*`, { pattern: true })
    },
  },
}
```

## Using both arguments and payload to filter events

```javascript
import { withFilter } from 'graphql-subscriptions';

export const resolvers = {
  Subscription: {
    somethingChanged: {
      subscribe: withFilter(
        (_, args) => pubsub.asyncIterator(`${SOMETHING_CHANGED_TOPIC}.${args.relevantId}`),
        (payload, variables) => payload.somethingChanged.id === variables.relevantId,
      ),
    },
  },
}
```

## Configuring RedisPubSub

`RedisPubSub` constructor can be passed a configuration object to enable some advanced features. 

```ts
export interface PubSubRedisOptions {
  connection?: RedisOptions | string;
  triggerTransform?: TriggerTransform;
  connectionListener?: (err?: Error) => void;
  publisher?: RedisClient;
  subscriber?: RedisClient;
  reviver?: Reviver;
  serializer?: Serializer;
  deserializer?: Deserializer;
  messageEventName?: string;
  pmessageEventName?: string;
}
```

| option | type | default | description |
| ------ | ---- | ------- | ----------- |
| `connection` | [`object \| string`](https://github.com/luin/ioredis#connect-to-redis) | `undefined` | the connection option is passed as is to the `ioredis` constructor to create redis subscriber and publisher instances. for greater controll, use `publisher` and `subscriber` options. |
| `triggerTransform` | `function` | (trigger) => trigger | [deprecated](#using-trigger-transform-deprecated) |
| `connectionListener` | `function` | `undefined` | pass in connection listener to log errors or make sure connection to redis instance was created successfully. |
| `publisher` | `function` | `undefined` | must be passed along side `subscriber`. see [#creating-a-redis-client](#creating-a-redis-client) |
| `subscriber` | `function` | `undefined` | must be passed along side `publisher`. see [#creating-a-redis-client](#creating-a-redis-client) |
| `reviver` | `function` | `undefined` | see [#using-a-custom-reviver](#using-a-custom-reviver) |
| `serializer` | `function` | `undefined` | see [#using-a-custom-serializerdeserializer](#using-a-custom-serializerdeserializer) |
| `deserializer` | `function` | `undefined` | see [#using-a-custom-serializerdeserializer](#using-a-custom-serializerdeserializer) |
| `messageEventName` | `string` | `undefined` | see [#receiving-messages-as-buffers](#receiving-messages-as-buffers) |
| `pmessageEventName` | `string` | `undefined` | see [#receiving-messages-as-buffers](#receiving-messages-as-buffers) |

## Creating a Redis Client

The basic usage is great for development and you will be able to connect to a Redis server running on your system seamlessly. For production usage, it is recommended to pass a redis client (like ioredis) to the RedisPubSub constructor. This way you can control all the options of your redis connection, for example the connection retry strategy.

```javascript
import { RedisPubSub } from 'graphql-redis-subscriptions';
import * as Redis from 'ioredis';

const options = {
  host: REDIS_DOMAIN_NAME,
  port: PORT_NUMBER,
  retryStrategy: times => {
    // reconnect after
    return Math.min(times * 50, 2000);
  }
};

const pubsub = new RedisPubSub({
  ...,
  publisher: new Redis(options),
  subscriber: new Redis(options)
});
```

### Receiving messages as Buffers

Some Redis use cases require receiving binary-safe data back from redis (in a Buffer). To accomplish this, override the event names for receiving messages and pmessages.  Different redis clients use different names, for example:

| library | message event | message event (Buffer) | pmessage event | pmessage event (Buffer) |
| ------- | ------------- | ---------------------- | -------------- | ----------------------- |
| ioredis | `message` | `messageBuffer` | `pmessage` | `pmessageBuffer` |
| node-redis | `message` | `message_buffer` | `pmessage` | `pmessage_buffer` |

```javascript
import { RedisPubSub } from 'graphql-redis-subscriptions';
import * as Redis from 'ioredis';

const pubsub = new RedisPubSub({
  ...,
  // Tells RedisPubSub to register callbacks on the messageBuffer and pmessageBuffer EventEmitters
  messageEventName: 'messageBuffer',
  pmessageEventName: 'pmessageBuffer',
});
```


**Also works with your Redis Cluster**

```javascript
import { RedisPubSub } from 'graphql-redis-subscriptions';
import { Cluster } from 'ioredis';

const cluster = new Cluster(REDIS_NODES); // like: [{host: 'ipOrHost', port: 1234}, ...]
const pubsub = new RedisPubSub({
  ...,
  publisher: cluster,
  subscriber: cluster
});
```


You can learn more on the `ioredis` package [here](https://github.com/luin/ioredis).

## Using a custom serializer/deserializer

By default, Javascript objects are (de)serialized using the `JSON.stringify` and `JSON.parse` methods.
You may pass your own serializer and/or deserializer function(s) as part of the options.

The `deserializer` will be called with an extra context object containing `pattern` (if available) and `channel` properties, allowing you to access this information when subscribing to a pattern.

```javascript
import { RedisPubSub } from 'graphql-redis-subscriptions';
import { someSerializer, someDeserializer } from 'some-serializer-library';

const serialize = (source) => {
  return someSerializer(source);
};

const deserialize = (sourceOrBuffer, { channel, pattern }) => {
  return someDeserializer(sourceOrBuffer, channel, pattern);
};

const pubSub = new RedisPubSub({ ..., serializer: serialize, deserializer: deserialize });
```

## Using a custom reviver

By default, Javascript objects are serialized using the `JSON.stringify` and `JSON.parse` methods.
This means that not all objects - such as Date or Regexp objects - will deserialize correctly without a custom reviver, that work out of the box with the default in-memory implementation.
For handling such objects, you may pass your own reviver function to `JSON.parse`, for example to handle Date objects the following reviver can be used:

```javascript
import { RedisPubSub } from 'graphql-redis-subscriptions';

const dateReviver = (key, value) => {
  const isISO8601Z = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}(?:\.\d*)?)Z$/;
  if (typeof value === 'string' && isISO8601Z.test(value)) {
    const tempDateNumber = Date.parse(value);
    if (!isNaN(tempDateNumber)) {
      return new Date(tempDateNumber);
    }
  }
  return value;
};

const pubSub = new RedisPubSub({ ..., reviver: dateReviver });

pubSub.publish('Test', {
  validTime: new Date(),
  invalidTime: '2018-13-01T12:00:00Z'
});
pubSub.subscribe('Test', message => {
  message.validTime; // Javascript Date
  message.invalidTime; // string
});
```

## Old Usage (Deprecated)

```javascript
import { RedisPubSub } from 'graphql-redis-subscriptions';
const pubsub = new RedisPubSub();
const subscriptionManager = new SubscriptionManager({
  schema,
  pubsub,
  setupFunctions: {},
});
```

## Using Trigger Transform (Deprecated)

Recently, graphql-subscriptions package added a way to pass in options to each call of subscribe.
Those options are constructed via the setupFunctions object you provide the Subscription Manager constructor.
The reason for graphql-subscriptions to add that feature is to allow pub sub engines a way to reduce their subscription set using the best method of said engine.
For example, Meteor's live query could use Mongo selector with arguments passed from the subscription like the subscribed entity id.
For Redis, this could be a bit more simplified, but much more generic.
The standard for Redis subscriptions is to use dot notations to make the subscription more specific.
This is only the standard but I would like to present an example of creating a specific subscription using the channel options feature.

First I create a simple and generic trigger transform 
```javascript
const triggerTransform = (trigger, {path}) => [trigger, ...path].join('.');
```

Then I pass it to the `RedisPubSub` constructor.
```javascript
const pubsub = new RedisPubSub({
  triggerTransform,
});
```
Lastly, I provide a setupFunction for `commentsAdded` subscription field.
It specifies one trigger called `comments.added` and it is called with the channelOptions object that holds `repoName` path fragment.
```javascript
const subscriptionManager = new SubscriptionManager({
  schema,
  setupFunctions: {
    commentsAdded: (options, {repoName}) => ({
      'comments.added': {
        channelOptions: {path: [repoName]},
      },
    }),
  },
  pubsub,
});
```

When I call `subscribe` like this:
```javascript
const query = `
  subscription X($repoName: String!) {
    commentsAdded(repoName: $repoName)
  }
`;
const variables = {repoName: 'graphql-redis-subscriptions'};
subscriptionManager.subscribe({query, operationName: 'X', variables, callback});
```

The subscription string that Redis will receive will be `comments.added.graphql-redis-subscriptions`.
This subscription string is much more specific and means the the filtering required for this type of subscription is not needed anymore.
This is one step towards lifting the load off of the GraphQL API server regarding subscriptions.

## Tests

### Spin a Redis in docker server and cluster
Please refer to https://github.com/Grokzen/docker-redis-cluster documentation to start a cluster
```shell script
$ docker run --rm -p 6379:6379 redis:alpine
$ export REDIS_CLUSTER_IP=0.0.0.0; docker run -e "IP=0.0.0.0" --rm -p 7006:7000 -p 7001:7001 -p 7002:7002 -p 7003:7003 -p 7004:7004 -p 7005:7005 grokzen/redis-cluster
```

### Test
```shell script
npm run test
```
