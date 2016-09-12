# graphql-redis-subscriptions

This package implements the PusSubEngine Interface from the graphql-subscriptions package. 
It allows you to connect your subscriptions manger to a redis Pub Sub mechanism to support 
multiple subscription manager instances.
   
   
## Basic Usage

```javascript
import { RedisPubSub } from 'graphql-redis-subscriptions';
const pubsub = new RedisPubSub();
const subscriptionManager = new SubscriptionManager({
  schema,
  pubsub,
  setupFunctions: {},
});
```

## Passing redis options object

The basic usage is great for development and you will be able to connect to a redis server running on your system seamlessly.
But for any production usage you should probably pass in a redis options object
 
```javascript
import { RedisPubSub } from 'graphql-redis-subscriptions';

const pubsub = new RedisPubSub({
  connection: {
    host: REDIS_DOMAIN_NAME,
    port: PORT_NUMBER,
    retry_strategy: options => {
      // reconnect after
      return Math.max(options.attempt * 100, 3000);
    }
  }
});
```

You can learn more on the redis options object [here](https://github.com/NodeRedis/node_redis#options-object-properties).

