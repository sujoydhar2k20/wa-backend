'use strict';

/**
 * Tiny counting semaphore: at most `max` tasks run at once, the rest wait in FIFO order.
 * Used to bound ffmpeg processes, sharp transforms and Meta uploads in this Node process.
 */
class Semaphore {
  constructor(max, name = 'semaphore') {
    this.max = Math.max(1, max | 0);
    this.name = name;
    this.active = 0;
    this.queue = [];
  }

  get waiting() {
    return this.queue.length;
  }

  acquire() {
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  release() {
    const next = this.queue.shift();
    if (next) next(); // hand the slot over directly
    else this.active = Math.max(0, this.active - 1);
  }

  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

module.exports = { Semaphore };
