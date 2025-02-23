"use strict";

class AbortError extends Error {			// Node has its own version of this
	constructor() {
		super("Request to the LLM was aborted.");
		this.name = "AbortError";

		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, AbortError);
		}
	}
}

class RequestError extends Error {
	constructor(statusCode = 0, responseText = null) {
		const msg = responseText ?
			`HTTP ${statusCode}. Response: ${responseText}` :
			`HTTP ${statusCode}.`;

		super(msg);
		this.name = "RequestError";			// Sets the error name for stack traces
		this.statusCode = statusCode;
		this.responseText = responseText;

		// This ensures proper stack trace in V8 engines
		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, RequestError);
		}
	}
}

class TooManyErrors extends Error {
	constructor() {
		super("Too many errors occurred");
		this.name = "TooManyErrors";

		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, TooManyErrors);
		}
	}
}

module.exports = {
	AbortError,
	RequestError,
	TooManyErrors,
};
