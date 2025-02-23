"use strict";

const fs = require("fs");
const configs = require("./configs");
const { RequestError, TooManyErrors } = require("./exceptions");
const utils = require("./utils");

function new_client(cfg) {

	let client = Object.create(client_prototype);
	client.config = Object.assign({}, cfg);				// Making client.config a shallow copy of cfg.

	for (let key of configs.Required) {
		if (!Object.hasOwn(client.config, key)) {
			throw new Error(`Missing required config key: ${key}`);
		}
	}

	for (let [key, value] of Object.entries(configs.Defaults)) {
		if (!Object.hasOwn(client.config, key)) {
			client.config[key] = value;
		}
	}

	let api_key = "unset";								// Closure technique to keep api_key secret.
	client.get_api_key = () => api_key;
	client.set_api_key = (s) => {
		api_key = s;
	};

	client.errors = 0;
	client.delay = client.config.min_delay;				// In seconds. Will need to be multiplied by 1000.
	client.next_permitted_send = 0;						// Based on performance.now(), using milliseconds.

	client.standard_system_prompt_replacements();

	client.last_send = "null";							// For debugging only. Stored as JSON.
	client.last_receive = "null";						// Likewise.

	return client;
}

const client_prototype = {

	set_api_key_from_file: function(filepath) {
		let key = fs.readFileSync(filepath, "utf8");
		this.set_api_key(key.trim());
	},

	set_system_prompt: function(s) {
		this.config.system_prompt = s;
		this.standard_system_prompt_replacements();
	},

	set_system_prompt_from_file: function(filepath) {
		let s = fs.readFileSync(filepath, "utf8");
		this.set_system_prompt(s.trim());
	},

	standard_system_prompt_replacements: function() {
		let now = new Date();
		let date_str = now.toLocaleDateString("en-US", {weekday: "long", month: "long", day: "numeric", year: "numeric"});
		this.replace_in_system_prompt("{{currentDateTime}}", date_str, true);
		this.replace_in_system_prompt("{{name}}", this.config.name, true);
		this.replace_in_system_prompt("{{version}}", this.config.version, true);
		this.replace_in_system_prompt("{{company}}", this.config.company, true);
		this.replace_in_system_prompt("{{nameVersion}}", this.config.name + (this.config.version ? " " + this.config.version : ""), true);
	},

	replace_in_system_prompt: function(search, replace, allow_non_extant = false) {
		if (!allow_non_extant && !this.config.system_prompt.includes(search)) {
			throw new Error("replace_in_system_prompt: search string not present");
		}
		this.config.system_prompt = this.config.system_prompt.replaceAll(search, replace);
	},

	set_max_tokens: function(n) {
		this.config.max_tokens = n;
	},

	set_temperature: function(n) {
		this.config.temperature = n;
	},

	set_max_errors: function(n) {
		this.config.max_errors = n;
	},

	set_reasoning_effort: function(s) {
		this.config.reasoning_effort = s;
	},

	set_show_reasoning: function(foo) {
		this.config.show_reasoning = Boolean(foo);
	},

	register_success: function() {
		this.delay = utils.clamp(
			this.config.min_delay,
			this.delay / 2,
			this.config.max_delay
		);
	},

	register_failure: function() {
		this.delay = utils.clamp(
			this.config.min_delay,
			this.delay * 2,
			this.config.max_delay
		);
		this.next_permitted_send = performance.now() + (this.delay * 1000);
		this.errors += 1;
	},

	send_message: function(message, abortcontroller = null) {
		return this.send_conversation([message], false, abortcontroller);
	},

	is_anthropic: function() {
		return this.config.url.toUpperCase().includes("ANTHROPIC");
	},

	is_google: function() {
		return this.config.url.toUpperCase().includes("GOOGLE");
	},

	is_openrouter: function() {
		return this.config.url.toUpperCase().includes("OPENROUTER");
	},

	handle_429: function(response) {
		let retry_header = response.headers.get("retry-after");		// .get() works in a case-insensitive way
		if (retry_header) {
			let retry_float = parseFloat(retry_header);
			if (!Number.isNaN(retry_float)) {
				this.next_permitted_send = performance.now() + (retry_float * 1000);
			}
		}
	},

	anthropic_request: function(formatted_conversation) {
		let headers = {
			"x-api-key": this.get_api_key(),
			"anthropic-version": this.config.anthropic_version,
			"content-type": "application/json",
		};

		let data = {
			model: this.config.model,
			messages: formatted_conversation,
			[this.config.max_tokens_key]: this.config.max_tokens,
		};

		if (this.config.system_prompt) {
			data.system = this.config.system_prompt;
		}

		if (this.config.temperature >= 0) {
			data.temperature = this.config.temperature;
		}

		return [headers, data];
	},

	openai_request: function(formatted_conversation) {
		let headers = {
			"authorization": `Bearer ${this.get_api_key()}`,
			"content-type": "application/json",
		};

		let data = {
			model: this.config.model,
			messages: formatted_conversation,
			[this.config.max_tokens_key]: this.config.max_tokens,
		};

		if (this.config.system_prompt) {				// For OpenAI, System prompt is first message.
			data.messages.unshift({
				role: this.config.sp_role,
				content: this.config.system_prompt
			});
			if (this.config.sp_role === "user") {		// If it's a "user" message, add a simple reply to keep [user, assistant] pattern.
				data.messages.splice(1, 0, {
					role: "assistant",
					content: "OK, I understood these instructions and I am ready to proceed!"
				});
			}
		}

		if (this.config.temperature >= 0) {
			data.temperature = this.config.temperature;
		}

		if (this.config.reasoning_effort) {
			data.reasoning_effort = this.config.reasoning_effort;
		}

		return [headers, data];
	},

	google_request: function(formatted_conversation) {
		let headers = {
			"x-goog-api-key": this.get_api_key(),
			"content-type": "application/json",
		};

		let data = {
			contents: formatted_conversation,
			generationConfig: {
				[this.config.max_tokens_key]: this.config.max_tokens,
			}
		};

		if (this.config.system_prompt) {
			data.system_instruction = {
				parts: [{ text: this.config.system_prompt }]
			};
		}

		if (this.config.temperature >= 0) {
			data.generationConfig.temperature = this.config.temperature;
		}

		return [headers, data];
	},

	prepare_request: function(conversation, raw) {  	// raw flag means conversation is preformatted.
		let headers, data;
		if (this.is_anthropic()) {
			[headers, data] = this.anthropic_request(raw ? conversation : utils.format_message_array_openai(conversation));
		} else if (this.is_google()) {
			[headers, data] = this.google_request(raw ? conversation : utils.format_message_array_google(conversation));
		} else {
			[headers, data] = this.openai_request(raw ? conversation : utils.format_message_array_openai(conversation));
		}
		if (this.is_openrouter()) {  					// Fix this one thing if it's OpenRouter.
			data["include_reasoning"] = true;
		}
		return [headers, data];
	},

	send_conversation: function(conversation, raw = false, abortcontroller = null) {
		if (this.errors > this.config.max_errors) {
			return Promise.reject(new TooManyErrors());
		}

		if (!Array.isArray(conversation)) {
			return Promise.reject(new Error("send_conversation: conversation must be an array"));
		}

		if (!raw && conversation.length % 2 !== 1) {
			console.warn("[Warning: even number of conversation entries]");
		}

		if (this.config.system_prompt.includes("{{") &&
			this.config.system_prompt.includes("}}")) {
			console.error("[Warning: probable {{placeholder}} text in system prompt]");
		}

		let delay_promise;
		let t = performance.now();

		if (t < this.next_permitted_send) {
			delay_promise = new Promise(resolve => setTimeout(resolve, this.next_permitted_send - t));
		} else {
			delay_promise = Promise.resolve();
		}

		return delay_promise.then(() => {
			let [headers, data] = this.prepare_request(conversation, raw);
			let stringified_data = JSON.stringify(data);
			this.last_send = stringified_data;
			return fetch(this.config.url, {
				method: "POST",
				headers: headers,
				body: stringified_data,
				signal: abortcontroller?.signal,
			});
		}).catch(error => {
			this.register_failure();
			throw error;
		}).then(response => {
			if (response.status !== 200) {
				this.register_failure();				// BEFORE the following, as both set .next_permitted_send, but the next one must prevail.
				if (response.status === 429) {
					this.handle_429(response);
				}
				return response.text().then(text => {
					throw new RequestError(response.status, text);
				});
			} else {
				return response.json().then(data => {
					this.last_receive = JSON.stringify(data);
					if (this.is_anthropic()) {
						return utils.parse_200_response_anthropic(data);
					} else if (this.is_google()) {
						return utils.parse_200_response_google(data);
					} else if (this.is_openrouter()) {
						return utils.parse_200_response_openrouter(data, this.config.show_reasoning);
					} else {
						return utils.parse_200_response_openai(data);
					}
				}).then(result => {						// result is a string.
					this.register_success();
					return result;						// Thus the overall promise resolves to a string.
				}).catch(error => {
					this.register_failure();
					throw error;
				});
			}
		});
	},
}

module.exports = new_client;
