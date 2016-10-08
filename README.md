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

## Using Trigger Transform

Recently, graphql-subscriptions package added a way to pass in options to each call of subscribe.
Those options are constructed via the setupFunctions object you provide the Subscription Manager constructor.
The reason for graphql-subscriptions to add that feature is to allow pub sub engines a way to reduce their subscription set using the best method of said engine.
For example, meteor's live query could use mongo selector with arguments passed from the subscription like the subscribed entity id.
For redis, this could be a bit more simplified, but much more generic.
The standard for redis subscriptions is to use dot notations to make the subscription more specific.
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
    comments.added(repoName: $repoName)
  }
`;
const variables = {repoName: 'graphql-redis-subscriptions'};
subscriptionManager.subscribe({query, operationName: 'X', variables, callback});
```

The subscription string that Redis will receive will be `comments.added.graphql-redis-subscriptions`.
This subscription string is much more specific and means the the filtering required for this type of subscription is not needed anymore.
This is one step towards lifting the load off of the graphql api server regarding subscriptions.

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

