/**
 * A turn dispatch is recorded on the very object the receiver handed to bolt.
 * Bolt passes `ReceiverEvent.body` through to a listener by reference, so the
 * receiver reads back what its own request did without needing a lookup key:
 * it is still on the stack, awaiting `processEvent`, when the listener writes.
 */
interface DispatchNote {
  readonly addressed: boolean;
  readonly at: number;
}

const notes = new WeakMap<object, DispatchNote>();

export const noteDispatch = (body: unknown, addressed: boolean): void => {
  if (typeof body === "object" && body !== null) {
    notes.set(body, { addressed, at: performance.now() });
  }
};

export const readDispatch = (body: object): DispatchNote | undefined =>
  notes.get(body);
