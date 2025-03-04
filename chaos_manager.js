"use strict";

const manager = Object.create(null);

// Explanation of the resolvers:
// The objects in "resolvers" are like locks, resolving the promise unlocks the lock.
// Note that the lock still stays in place once it is is unlocked.
// It is finally removed by calling release().

manager.resolvers = [];
manager.next_id = 1;
manager.max_lock_time = 18000;					// This will be overridden by config.json probably.

manager.request = function(owner) {				// owner is just a string used purely for debugging.
	let id = this.next_id++;
	if (this.max_lock_time === 0) {
		return Promise.resolve(id);				// Simple path, creates no objects, when .release(id) is called it will have no effect.
	}
	let promise = new Promise((resolve) => {	// Note the code here is run instantly upon creation, it's not like some .then() thing.
		this.resolvers.push({ owner: owner, id: id, do_resolve: () => {
			this.setup_autorelease(id);
			resolve(id);
		}});
	});
	if (this.resolvers.length === 1) {			// The new promise is the only one, so we can resolve it.
		this.resolvers[0].do_resolve();
	}
	return promise;
};

manager.set_max_lock_time = function(n) {
	this.max_lock_time = n;
};

manager.setup_autorelease = function(id) {
	setTimeout(() => {
		this.release(id);
	}, this.max_lock_time);
};

manager.release = function(id) {

	if (this.resolvers[0]?.id !== id) {
		return;
	}

	this.resolvers.shift();

	// We can now resolve another promise (i.e. unlock the next lock).
	// But wait a bit, so the new bot MIGHT receive the last message.

	let active_id = this.resolvers[0]?.id;

	if (active_id) {
		setTimeout(() => {
			if (this.resolvers[0]?.id !== active_id) {
				return;
			}
			this.resolvers[0].do_resolve();
		}, 1000);
	}
};

manager.status = function() {
	return `${this.resolvers.map(o => `${o.owner} (ID: ${o.id})`).join(", ")}`;
};

module.exports = manager;