"use strict";

const manager = Object.create(null);


manager.resolvers = [];


manager.request = function() {
	let promise = new Promise((resolve) => {
		this.resolvers.push(resolve);			// This happens instantly upon getting here in the code, it's not delayed in any way.
	});
	if (this.resolvers.length === 1) {			// The new promise is the only one, so we can resolve it.
		this.resolvers[0]();
	}
	return promise;
};


manager.release = function() {
	this.resolvers.shift();
	setTimeout(() => {
		if (this.resolvers.length > 0) {		// We can now resolve another promise. But wait a bit, so the new bot MIGHT receive the last message.
			this.resolvers[0]();
		}
	}, 1000);

};


module.exports = manager;
