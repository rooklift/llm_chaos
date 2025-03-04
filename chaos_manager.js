"use strict";

const manager = Object.create(null);

manager.resolvers = [];

manager.request = function(owner) {				// owner is just a string used purely for debugging.
	let promise = new Promise((resolve) => {
		this.resolvers.push({owner, resolve});	// This happens instantly upon getting here in the code, it's not delayed in any way.
	});
	if (this.resolvers.length === 1) {			// The new promise is the only one, so we can resolve it.
		this.resolvers[0].resolve();
	}
	return promise;
};

manager.release = function() {
	this.resolvers.shift();
	setTimeout(() => {
		if (this.resolvers.length > 0) {		// We can now resolve another promise. But wait a bit, so the new bot MIGHT receive the last message.
			this.resolvers[0].resolve();
		}
	}, 1000);

};

manager.status = function() {
	return `${this.resolvers.map(o => o.owner).join(", ")}`;
};

module.exports = manager;
