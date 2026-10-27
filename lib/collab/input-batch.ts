/** New durable room input superseded this run; leave its requests pending and catch up. */
export class InputsChangedError extends Error {
  constructor() {
    super('New room messages arrived; catching up with every open request.')
    this.name = 'InputsChangedError'
  }
}

/** Cleanup was not confirmed; never start a replacement automatically beside uncertain work. */
export class SessionCleanupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionCleanupError'
  }
}
