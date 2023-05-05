export type FilterFn = (rootValue?: any, args?: any, context?: any, info?: any) => boolean;

/**
 * Wraps an async-iterator and filters incoming events based on the provided filter function.
 * Note: Due to promise chaining this function can use a large amount of memory when a high percentage of messages are filtered
 * If using the PubSubAsyncIterator, use the filterFn property directly
 */
export const withFilter = (asyncIteratorFn: () => AsyncIterableIterator<any>, filterFn: FilterFn) => {
  return (rootValue: any, args: any, context: any, info: any): AsyncIterator<any> => {
    const asyncIterator = asyncIteratorFn();

    const getNextPromise = () => {
      return asyncIterator
        .next()
        .then(payload => Promise.all([
          payload,
          Promise.resolve(filterFn(payload.value, args, context, info)).catch(() => false),
        ]))
        .then(([payload, filterResult]) => {
          if (filterResult === true) {
            return payload;
          }

          // Skip the current value and wait for the next one
          return getNextPromise();
        });
    };

    return {
      next() {
        return getNextPromise();
      },
      return() {
        return asyncIterator.return();
      },
      throw(error) {
        return asyncIterator.throw(error);
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    } as any;
  };
};
