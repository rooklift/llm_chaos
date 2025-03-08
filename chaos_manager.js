"use strict";

const manager = Object.create(null);

// Explanation of the resolvers:
// The objects in "resolvers" are like locks, resolving the promise unlocks the lock.
// Note that the lock still stays in place once it is is unlocked.
// It is finally removed by calling release().

manager.resolvers = [];
manager.next_id = 1;
manager.max_lock_time = 18000;					// This can be overridden by config.json
manager.lock_buffer_time = 1000;				// This can be overridden by config.json

manager.request = function(owner) {				// owner is just a string used purely for debugging.
	let id = this.next_id++;
	if (this.max_lock_time === 0) {
		return Promise.resolve(id);				// Simple path, creates no objects, when .release(id) is called it will have no effect.
	}
	let promise = new Promise((resolve) => {	// Note the code here is run instantly upon creation, it's not like some .then() thing.
		this.resolvers.push({
			owner: owner,
			id: id,
			do_resolve: () => {
				this.setup_autorelease(id);
				resolve(id);
			}
		});
	});
	if (this.resolvers.length === 1) {			// The new promise is the only one, so we can resolve it.
		this.resolvers[0].do_resolve();
	}
	return promise;
};

manager.set_max_lock_time = function(n) {
	this.max_lock_time = n;
};

manager.set_lock_buffer_time = function(n) {
	this.lock_buffer_time = n;
};

manager.setup_autorelease = function(id) {
	setTimeout(() => {
		this.release(id);
	}, this.max_lock_time);
};

manager.release = function(id) {

	let was_in_zeroth_index = this.resolvers[0]?.id === id;

	this.resolvers = this.resolvers.filter(o => o.id !== id);

	if (!was_in_zeroth_index) {		// Clearing any other position has no other effect.
		return;
	}

	// If we're here, we discarded the zeroth lock.
	// We can now resolve another promise (i.e. unlock the next lock).
	// But wait a bit, so the new bot MIGHT receive the last message.

	let active_id = this.resolvers[0]?.id;

	if (active_id) {
		setTimeout(() => {
			if (this.resolvers[0]?.id === active_id) {
				this.resolvers[0].do_resolve();
			}
		}, this.lock_buffer_time);
	}
};

manager.status = function() {
	return `[${this.resolvers.map(o => `${o.owner} (ID: ${o.id})`).join(", ")}]`;
};

module.exports = manager;
